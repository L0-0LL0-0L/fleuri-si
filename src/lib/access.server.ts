// Server-only Pollen Access enforcement (v2). Eligibility comes from a live staking read; every extra action is a
// lease-fenced reservation in service-role-only SQL with an immutable input hash, a shared wallet+UTC-day budget and
// effect-bound completion. No client value, cache or browser storage can grant a benefit.
import { ACCESS_POLICY, ELIGIBILITY_TTL_SEC, MAX_INFLIGHT, accessError, evaluateEligibility, type AccessAction, type AccessErrorKind, type Eligibility } from "@/pq/access";

export type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };
export class AccessError extends Error { constructor(public kind: AccessErrorKind, message: string, public blockers: string[] = []) { super(message); } }
export type LiveEligibility = Eligibility & { wallet: string | null; slot: number | null; cluster: string | null; checkedAt: string; cached: boolean };

export interface AccessDeps {
  db: Db;
  /** Live staking read (staking.server readState) for a wallet. */
  readStaking: (wallet: string) => Promise<any>;
  /** Canonical position PDA for a wallet. */
  derivePosition: (programId: string, wallet: string) => string;
  now?: () => number;
}

export async function defaultDeps(): Promise<AccessDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { readState } = await import("./staking.server");
  const { derive } = await import("@/pq/staking");
  return { db: supabaseAdmin as any, readStaking: readState, derivePosition: (p, w) => derive(p).position(w).toBase58() };
}

const timeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
const SAFE_CLUSTERS = new Set(["mainnet-beta", "devnet", "testnet", "localnet"]);

export async function sha256Hex(s: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Server-verified eligibility for one owner. The short cache is for the dashboard only; `fresh` always re-reads. */
export async function eligibility(deps: AccessDeps, ownerId: string, fresh = false): Promise<LiveEligibility> {
  const now = (deps.now ?? Date.now)();
  const o = await deps.db.from("owners").select("wallet_address,wallet_verified").eq("id", ownerId).maybeSingle();
  if (o.error) throw new AccessError("other", "Workspace could not be read.");
  const wallet = o.data?.wallet_address ? { address: o.data.wallet_address as string, verified: o.data.wallet_verified === true } : null;
  const base = { wallet: wallet?.address ?? null, slot: null, cluster: null, checkedAt: new Date(now).toISOString(), cached: false };
  if (!wallet || !wallet.verified) return { ...evaluateEligibility({ wallet, cluster: null, checks: null, poolAddress: null, derivedPosition: null, position: null }), ...base };
  if (!fresh) {
    const c = await deps.db.from("access_eligibility").select("*").eq("owner_id", ownerId).maybeSingle();
    if (!c.error && c.data && c.data.wallet === wallet.address && now - Date.parse(c.data.checked_at) < ELIGIBILITY_TTL_SEC * 1000)
      return { eligible: c.data.eligible === true, blockers: Array.isArray(c.data.blockers) ? c.data.blockers : [], activeStake: c.data.active_stake, wallet: wallet.address, slot: c.data.slot, cluster: c.data.cluster, checkedAt: c.data.checked_at, cached: true };
  }
  let s: any = null;
  try { s = await timeout(deps.readStaking(wallet.address), 15_000); } catch { s = null; } // raw RPC errors are never surfaced
  if (s && typeof s !== "object") s = null;
  let derived: string | null = null;
  try { derived = s?.programId ? deps.derivePosition(s.programId, wallet.address) : null; } catch { derived = null; }
  const pos = s?.position;
  const ev = evaluateEligibility({
    wallet, cluster: typeof s?.cluster === "string" ? s.cluster : null, checks: Array.isArray(s?.checks) ? s.checks : null, poolAddress: typeof s?.pool?.address === "string" ? s.pool.address : null, derivedPosition: derived,
    position: pos ? { address: String(pos.address), owner: String(pos.owner), pool: String(pos.pool), active: String(pos.active), pendingAmount: String(pos.pendingAmount ?? "0") } : null,
  });
  if (!s) ev.blockers.unshift("The staking read failed; benefits stay locked until a fresh read succeeds.");
  const slot = Number.isSafeInteger(s?.slot) && s.slot > 0 ? s.slot : null;
  const cluster = SAFE_CLUSTERS.has(s?.cluster) ? s.cluster : null;
  const out: LiveEligibility = { ...ev, eligible: !!s && ev.eligible && cluster === "mainnet-beta", ...base, slot, cluster };
  await deps.db.rpc("access_set_eligibility", { _owner: ownerId, _wallet: wallet.address, _eligible: out.eligible, _active: out.activeStake, _slot: out.slot, _cluster: out.cluster, _blockers: out.blockers });
  return out;
}

export type Acquired = { state: "acquired"; id: string; lease: string; generation: number } | { state: "done"; id: string; result: any };

/** Prove eligibility live, then acquire (or recover) the fenced reservation for one extra action. */
export async function acquire(deps: AccessDeps, ownerId: string, action: AccessAction, key: string, inputHash: string): Promise<Acquired> {
  const el = await eligibility(deps, ownerId, true);
  const r = await deps.db.rpc("access_acquire", {
    _owner: ownerId, _action: action, _key: key, _input_hash: inputHash, _wallet: el.eligible ? el.wallet : null, _eligible: el.eligible,
    _limit: ACCESS_POLICY[action].extra, _evidence: el.eligible ? { wallet: el.wallet, slot: el.slot, cluster: el.cluster, activeStake: el.activeStake, checkedAt: el.checkedAt } : null,
    _lease_secs: ACCESS_POLICY[action].leaseSecs, _max_inflight: MAX_INFLIGHT,
  });
  if (r.error) { const e = accessError(String(r.error.message ?? "")); throw new AccessError(e.kind, e.message, e.kind === "locked" ? el.blockers : []); }
  return r.data as Acquired;
}

export async function release(deps: AccessDeps, ownerId: string, id: string, lease: string) {
  const r = await deps.db.rpc("access_release", { _owner: ownerId, _id: id, _lease: lease });
  if (r.error) throw new AccessError("other", "Access usage could not be recorded.");
  return r.data as { status: string; applied: boolean };
}

/** Extra units the wallet used today (consumed + live leases), shared across every workspace linked to it. */
export async function usage(db: Db, wallet: string | null, day: string) {
  const u: Record<AccessAction, number> = { owner_cycle: 0, deep_trial: 0, research_report: 0 };
  if (!wallet) return u;
  const r = await db.from("access_reservations").select("action,status,lease_expires_at").eq("wallet", wallet).eq("day", day).in("status", ["reserved", "consumed"]);
  if (r.error) throw new AccessError("other", "Usage could not be read.");
  const now = Date.now();
  for (const x of r.data as { action: AccessAction; status: string; lease_expires_at: string | null }[])
    if (x.action in u && (x.status === "consumed" || (x.lease_expires_at && Date.parse(x.lease_expires_at) > now))) u[x.action]++;
  return u;
}

/** Bonus cycle: reserve → (AI) decide → garden effect + debit in one SQL transaction. `commit` gets the commit RPC. */
export async function bonusCycle(deps: AccessDeps, ownerId: string, req: { requestId: string; agentId: string; useAi: boolean },
  run: (commit: { fn: string; bucket: string; args: (p: unknown, result: unknown) => Record<string, unknown> }) => Promise<{ message: string }>) {
  const ih = await sha256Hex(`bonus|${req.agentId}|${req.useAi ? 1 : 0}`);
  const a = await acquire(deps, ownerId, "owner_cycle", `bonus:${req.requestId}`, ih);
  if (a.state === "done") return { message: String(a.result?.message ?? "That bonus cycle already ran."), replay: true };
  const commit = { fn: "access_commit_cycle", bucket: `access:${a.id}`, args: (p: unknown, result: unknown) => ({ _owner: ownerId, _id: a.id, _lease: a.lease, p, _result: result }) };
  try {
    return { ...(await run(commit)), replay: false };
  } catch (e) {
    // The commit is one transaction, so a failure means no garden effect; refund (a no-op if the lease moved on).
    await release(deps, ownerId, a.id, a.lease).catch(() => {});
    if (/access_stale/.test((e as Error)?.message ?? "")) throw new AccessError("stale", accessError("access_stale").message);
    throw e;
  }
}

/** Deep trial: reserve, start the fenced trial, then settle against the frozen run for this exact request. */
export type DeepClaim = { fn: string; extra: Record<string, unknown> };
export async function deepTrial<T>(deps: AccessDeps, ownerId: string, requestId: string, normalizedConfigJson: string, go: (claim: DeepClaim) => Promise<T>): Promise<T> {
  const a = await acquire(deps, ownerId, "deep_trial", requestId, await sha256Hex(`deep|${normalizedConfigJson}`));
  // Every deep claim goes through access_claim_deep_trial: with a current lease it creates the frozen run and binds the
  // credit in one transaction; for an already-bound credit (state done) it can only recover the existing run.
  const claim: DeepClaim = { fn: "access_claim_deep_trial", extra: { _id: a.id, _lease: a.state === "done" ? null : a.lease } };
  if (a.state === "done") return go(claim);
  try {
    return await go(claim);
  } catch (e) {
    if (/access_stale/.test((e as Error)?.message ?? "")) throw new AccessError("stale", accessError("access_stale").message);
    throw e;
  } finally {
    const s = await deps.db.rpc("access_settle_trial", { _owner: ownerId, _id: a.id, _lease: a.lease });
    if (s.error && !/access_stale/.test(String(s.error.message))) console.error("[access] trial settle failed");
  }
}

export const reportInputHash = (mint: string) => sha256Hex(`report|${mint}`);

/** Research credit: owner-private saved report; report + debit commit together, fenced by the lease. */
export async function redeemReport(deps: AccessDeps, owner: string, data: { requestId: string; mint: string }, build: (mint: string) => Promise<unknown>) {
  const { canonicalize, sha256Hex: sha, utf8 } = await import("@/pq/canonical");
  const a = await acquire(deps, owner, "research_report", `report:${data.requestId}`, await reportInputHash(data.mint));
  if (a.state === "done") return { id: String(a.result?.report_id), replay: true };
  let report: unknown;
  try { report = JSON.parse(JSON.stringify(await build(data.mint))); }
  catch { await release(deps, owner, a.id, a.lease).catch(() => {}); throw new AccessError("other", "The report could not be created; your credit was refunded."); }
  const s = await deps.db.rpc("access_store_report", { _owner: owner, _id: a.id, _lease: a.lease, _mint: data.mint, _report: report, _digest: sha(utf8(canonicalize(report))) });
  if (s.error) {
    await release(deps, owner, a.id, a.lease).catch(() => {});
    if (/access_stale/.test(String(s.error.message))) throw new AccessError("stale", accessError("access_stale").message);
    throw new AccessError("other", "The report could not be saved; your credit was refunded.");
  }
  return { id: String(s.data.id), replay: false };
}
