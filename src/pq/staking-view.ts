// Pure view rules for /staking: freshness, action gating and the pre-signing review.
import { blockers, type ReadyCheck } from "./staking";
import { formatUnits } from "./pollen";

/** A snapshot older than this, or any failed read, is stale. */
export const STALE_AFTER_MS = 120_000;
export const POLL_MS = 45_000;

export type Snapshot = { fetchedAt: number; wallet: string | null; checks: ReadyCheck[]; depositsEnabled: boolean; position?: any; pool?: any; feeSource?: any; balances?: any; [k: string]: any };

export function freshness(st: Snapshot | null, now: number, readError: string) {
  if (!st) return { stale: true, reason: readError || "No chain read yet." };
  const age = Math.max(0, Math.round((now - st.fetchedAt) / 1000));
  if (readError) return { stale: true, reason: `Latest read failed (${readError}). Showing data from ${age}s ago.` };
  const rpc = st.checks.find((c) => c.id === "rpc");
  if (!rpc?.ok) return { stale: true, reason: rpc?.detail ?? "RPC freshness unknown." };
  if (now - st.fetchedAt > STALE_AFTER_MS) return { stale: true, reason: `Last chain read was ${age}s ago.` };
  return { stale: false, reason: `Read from chain ${age}s ago.` };
}

/** Checks as displayed: the RPC check reflects local snapshot age and read failures, never a frozen green. */
export function displayChecks(st: Snapshot, now: number, readError: string): ReadyCheck[] {
  const f = freshness(st, now, readError);
  return st.checks.map((c) => (c.id === "rpc" ? { ...c, ok: c.ok && !f.stale, detail: f.reason } : c));
}

/** Owned position data only counts when it was read for the connected wallet. */
export const ownPosition = (st: Snapshot | null, wallet: string | null) => (st && wallet && st.wallet === wallet ? st.position ?? null : null);

export function gates(st: Snapshot | null, wallet: string | null, now: number, readError: string) {
  const f = freshness(st, now, readError);
  if (!st || !wallet || f.stale) return { stake: false, exits: false, claim: false, harvest: false, stale: f.stale };
  const checks = displayChecks(st, now, readError);
  const pos = ownPosition(st, wallet);
  const exits = blockers("withdraw", checks).length === 0;
  return {
    stale: false,
    stake: blockers("stake", checks).length === 0 && st.depositsEnabled,
    exits,
    claim: exits && !!pos && pos.claimable != null && BigInt(pos.claimable) > 0n,
    harvest: blockers("harvest", checks).length === 0 && !!st.feeSource && BigInt(st.feeSource.unclaimedForPool ?? 0) > 0n,
  };
}

const days = (s: string) => `${(Number(s) / 86_400).toLocaleString(undefined, { maximumFractionDigits: 2 })} days`;
const LABEL: Record<string, string> = { stake: "Stake FLEURI", request_unstake: "Request unstake", cancel_unstake: "Cancel pending unstake", withdraw: "Withdraw matured FLEURI", claim: "Claim wSOL rewards", harvest: "Collect Pollen rewards (permissionless harvest)" };

/** Lines shown in the in-page review before the wallet is asked to sign. */
export function reviewLines(p: { cluster: string; cost: any; review: any }): [string, string][] {
  const r = p.review; const out: [string, string][] = [["Action", LABEL[r.action] ?? r.action], ["Network", p.cluster]];
  if (r.amount && (r.action === "stake" || r.action === "request_unstake")) out.push(["Amount", `${formatUnits(r.amount, 6)} FLEURI`]);
  if (r.cooldownSeconds) out.push(["Cooldown", `${days(r.cooldownSeconds)} — stops earning immediately`]);
  if (r.unlockAtChainTime) out.push([r.action === "withdraw" ? "Unlocked at" : "Unlocks at", `${new Date(Number(r.unlockAtChainTime) * 1000).toUTCString()} (chain time)`]);
  if (r.pendingAmount) out.push(["Pending amount", `${formatUnits(r.pendingAmount, 6)} FLEURI`]);
  if (r.expectedClaim) out.push(["Claim (at last read)", `${formatUnits(r.expectedClaim, 9)} wSOL — the program pays the exact amount at execution`]);
  if (r.harvestable) out.push(["Pollen claimable for pool", `${formatUnits(r.harvestable, 9)} wSOL — only the measured increase is credited`]);
  if (r.createsTokenAccount) out.push(["Token account", "Creates your missing token account (rent included below)"]);
  out.push(["Network fee", `${formatUnits(String(p.cost?.networkFeeLamports ?? 0), 9)} SOL`]);
  out.push(["Simulated SOL change", `${formatUnits(String(p.cost?.simulatedChangeLamports ?? 0), 9)} SOL (fee + any rent)`]);
  out.push(["Program", r.programId]);
  return out;
}
