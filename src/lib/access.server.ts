// Server-only Pollen Access enforcement. Eligibility comes from a live, cached staking read; metering goes
// through service-role-only SQL (access_reserve / access_finish), so no client value can grant a benefit.
import { ACCESS_POLICY, ELIGIBILITY_TTL_SEC, MAX_INFLIGHT, accessError, evaluateEligibility, type AccessAction, type Eligibility } from "@/pq/access";

export type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };
export class AccessError extends Error { constructor(public kind: "locked" | "exhausted" | "busy" | "other", message: string, public blockers: string[] = []) { super(message); } }
export type LiveEligibility = Eligibility & { wallet: string | null; slot: number | null; cluster: string | null; checkedAt: string; cached: boolean };

export interface AccessDeps {
  db: Db;
  /** Live staking read (staking.server readState) for a wallet. */
  readStaking: (wallet: string) => Promise<any>;
  /** Canonical position PDA for a wallet, or null if the program isn't configured. */
  derivePosition: (programId: string, wallet: string) => string;
  now?: () => number;
}

export async function defaultDeps(): Promise<AccessDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { readState } = await import("./staking.server");
  const { derive } = await import("@/pq/staking");
  return { db: supabaseAdmin as any, readStaking: readState, derivePosition: (p, w) => derive(p).position(w).toBase58() };
}

const timeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("Staking read timed out.")), ms))]);

/** Server-verified eligibility for one owner. Cached briefly per (owner, wallet); `fresh` skips the cache. */
export async function eligibility(deps: AccessDeps, ownerId: string, fresh = false): Promise<LiveEligibility> {
  const now = (deps.now ?? Date.now)();
  const o = await deps.db.from("owners").select("wallet_address,wallet_verified").eq("id", ownerId).maybeSingle();
  if (o.error) throw new Error("Workspace could not be read.");
  const wallet = o.data?.wallet_address ? { address: o.data.wallet_address as string, verified: !!o.data.wallet_verified } : null;
  const base = { wallet: wallet?.address ?? null, slot: null, cluster: null, checkedAt: new Date(now).toISOString(), cached: false };
  if (!wallet || !wallet.verified) return { ...evaluateEligibility({ wallet, cluster: null, checks: null, poolAddress: null, derivedPosition: null, position: null }), ...base };
  if (!fresh) {
    const c = await deps.db.from("access_eligibility").select("*").eq("owner_id", ownerId).maybeSingle();
    if (!c.error && c.data && c.data.wallet === wallet.address && now - Date.parse(c.data.checked_at) < ELIGIBILITY_TTL_SEC * 1000)
      return { eligible: !!c.data.eligible, blockers: c.data.blockers ?? [], activeStake: c.data.active_stake, wallet: wallet.address, slot: c.data.slot, cluster: c.data.cluster, checkedAt: c.data.checked_at, cached: true };
  }
  let s: any = null;
  try { s = await timeout(deps.readStaking(wallet.address), 15_000); } catch { s = null; }
  let derived: string | null = null;
  try { derived = s?.programId ? deps.derivePosition(s.programId, wallet.address) : null; } catch { derived = null; }
  const ev = evaluateEligibility({
    wallet, cluster: s?.cluster ?? null, checks: s?.checks ?? null, poolAddress: s?.pool?.address ?? null, derivedPosition: derived,
    position: s?.position ? { address: s.position.address, owner: s.position.owner, pool: s.position.pool, active: String(s.position.active), pendingAmount: String(s.position.pendingAmount ?? "0") } : null,
  });
  if (!s) ev.blockers.unshift("The staking read failed; benefits stay locked until a fresh read succeeds.");
  const out: LiveEligibility = { ...ev, eligible: !!s && ev.eligible, ...base, slot: s?.slot ?? null, cluster: s?.cluster ?? null };
  await deps.db.rpc("access_set_eligibility", { _owner: ownerId, _wallet: wallet.address, _eligible: out.eligible, _active: out.activeStake, _slot: out.slot, _cluster: out.cluster, _blockers: out.blockers });
  return out;
}

export type Reservation = { id: string; status: "reserved" | "consumed" | "refunded"; tier: "base" | "extra"; replay: boolean };

/**
 * Reserve one unit. Tries the free allowance first without any chain read; only when that is used up does it
 * prove eligibility live (fresh, uncached) before reserving an extra unit.
 */
export async function reserve(deps: AccessDeps, ownerId: string, action: AccessAction, key: string): Promise<Reservation> {
  const p = ACCESS_POLICY[action];
  const call = (eligible: boolean, evidence: unknown) => deps.db.rpc("access_reserve", { _owner: ownerId, _action: action, _key: key, _base: p.base, _extra: p.extra, _eligible: eligible, _evidence: evidence, _max_inflight: MAX_INFLIGHT });
  let r = await call(false, null);
  if (r.error && /access_locked/.test(r.error.message)) {
    const el = await eligibility(deps, ownerId, true);
    if (!el.eligible) throw new AccessError("locked", accessError(r.error.message).message, el.blockers);
    r = await call(true, { wallet: el.wallet, slot: el.slot, cluster: el.cluster, activeStake: el.activeStake, checkedAt: el.checkedAt });
  }
  if (r.error) { const e = accessError(r.error.message); throw new AccessError(e.kind, e.message); }
  return r.data as Reservation;
}

export async function finish(deps: AccessDeps, ownerId: string, id: string, ok: boolean) {
  const r = await deps.db.rpc("access_finish", { _owner: ownerId, _id: id, _ok: ok });
  if (r.error) throw new Error("Access usage could not be recorded.");
  return r.data;
}

/**
 * Run one metered action: reserve → run → consume (ok) or refund (failure/throw). A replay of an already
 * consumed key never runs the action again; a duplicate still in flight is refused.
 */
export async function metered<T>(deps: AccessDeps, ownerId: string, action: AccessAction, key: string, run: () => Promise<{ ok: boolean; value: T }>, onReplay?: () => Promise<T>): Promise<T> {
  const r = await reserve(deps, ownerId, action, key);
  if (r.replay) {
    if (r.status === "consumed" && onReplay) return onReplay();
    throw new AccessError("busy", r.status === "consumed" ? "That action already ran." : "That action is already in progress.");
  }
  let res: { ok: boolean; value: T };
  try { res = await run(); } catch (e) { await finish(deps, ownerId, r.id, false).catch(() => {}); throw e; }
  await finish(deps, ownerId, r.id, res.ok);
  return res.value;
}

/** Today's usage per action and tier, read with the service role after authentication. */
export async function usage(db: Db, ownerId: string, day: string) {
  const r = await db.from("access_reservations").select("action,tier,status").eq("owner_id", ownerId).eq("day", day).in("status", ["reserved", "consumed"]);
  if (r.error) throw new Error("Usage could not be read.");
  const u: Record<AccessAction, { base: number; extra: number }> = { owner_cycle: { base: 0, extra: 0 }, deep_trial: { base: 0, extra: 0 }, research_report: { base: 0, extra: 0 } };
  for (const x of r.data as { action: AccessAction; tier: "base" | "extra" }[]) if (u[x.action]) u[x.action][x.tier]++;
  return u;
}

/** Stable request key for an owner cycle: one per agent per 5 s bucket, matching cycle_runs uniqueness. */
export async function cycleKey(agentId: string, bucket: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cycle|${agentId}|${bucket}`)));
  return "cycle:" + [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
