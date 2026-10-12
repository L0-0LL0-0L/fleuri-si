// Pollen Access v2 policy: pure and browser-safe. The server enforces it; the page only explains it.
// Eligibility = any positive ACTIVE Pollen Staking position (pending unstake excluded), proved by a live
// mainnet read of a ready deployment, owned by the wallet the workspace linked with a verified signature.
// Only dedicated extra actions are metered: free manual cycles and free trials are never counted or capped.

export const ACCESS_POLICY_VERSION = "pollen-access-2";
export type AccessAction = "owner_cycle" | "deep_trial" | "research_report";

/** Extra units per linked WALLET per UTC day (shared by every workspace linked to that wallet). */
export const ACCESS_POLICY: Record<AccessAction, { extra: number; label: string; unit: string; detail: string; leaseSecs: number }> = {
  owner_cycle: { extra: 50, leaseSecs: 120, label: "Bonus cycles", unit: "cycles", detail: "A bonus cycle runs an agent right away, even inside the free 5-second cooldown. Free Run a cycle stays unlimited. Virtual vSOL only." },
  deep_trial: { extra: 3, leaseSecs: 300, label: "Deep Greenhouse trials", unit: "trials", detail: "Trials beyond the free limits: up to 10 repetitions and 120 cycles, within a fixed compute budget. Free trials stay unmetered." },
  research_report: { extra: 3, leaseSecs: 120, label: "Research credits", unit: "reports", detail: "Each credit saves one Botanist research report for a token mint, private to your workspace. Credits are not USDC or cash; the paid Botanist report is unchanged." },
};
export const MAX_INFLIGHT = 2;
export const ELIGIBILITY_TTL_SEC = 120;
/** Staking readiness checks that must pass: custody/program proof plus the correct, authority-free FLEURI mint. */
export const REQUIRED_CHECKS = ["cluster", "rpc", "configured", "program", "code", "pool", "vaults", "mint", "mintAuth", "freezeAuth"] as const;

/** Fixed, server-authored labels: raw staking/RPC details are never shown to users. */
export const CHECK_LABEL: Record<(typeof REQUIRED_CHECKS)[number], string> = {
  cluster: "mainnet network", rpc: "fresh chain read", configured: "staking program configured", program: "program deployed",
  code: "program code hash", pool: "staking pool", vaults: "vault custody", mint: "FLEURI mint", mintAuth: "mint authority revoked", freezeAuth: "freeze authority revoked",
};
export type Readiness = { id: string; label: string; ok: boolean; detail: string };
export interface EligibilityInput {
  wallet: { address: string; verified: boolean } | null;
  cluster: string | null;
  checks: Readiness[] | null;
  poolAddress: string | null;
  derivedPosition: string | null;
  position: { address: string; owner: string; pool: string; active: string; pendingAmount: string } | null;
  errors?: string[];
}
export interface Eligibility { eligible: boolean; blockers: string[]; activeStake: string | null }

export function evaluateEligibility(i: EligibilityInput): Eligibility {
  const b: string[] = [];
  if (!i.wallet) return { eligible: false, blockers: ["Link a wallet to this workspace with a signed message (Me → wallet)."], activeStake: null };
  if (!i.wallet.verified) return { eligible: false, blockers: ["The linked wallet is not verified by signature."], activeStake: null };
  if (i.cluster !== "mainnet-beta") b.push(`Server network is ${["devnet", "testnet", "localnet"].includes(i.cluster ?? "") ? i.cluster : "not mainnet or unknown"}; only mainnet stake counts.`);
  if (!Array.isArray(i.checks)) b.push("Pollen Staking readiness could not be read.");
  else for (const id of REQUIRED_CHECKS) {
    const c = i.checks.find((x) => x.id === id);
    if (!c) b.push(`Staking check "${id}" is missing.`);
    else if (c.ok !== true) b.push(`Staking check not passed: ${CHECK_LABEL[id]}.`);
  }
  let active: bigint | null = null;
  if (!b.length) {
    const p = i.position;
    if (!p) b.push("No Pollen Staking position for the linked wallet.");
    else {
      if (!i.derivedPosition || p.address !== i.derivedPosition) b.push("Position is not the canonical PDA for this wallet.");
      if (p.owner !== i.wallet.address) b.push("Position belongs to a different wallet.");
      if (!i.poolAddress || p.pool !== i.poolAddress) b.push("Position belongs to a different pool.");
      try { active = /^\d{1,20}$/.test(p.active) ? BigInt(p.active) : null; } catch { active = null; }
      let pending = 0n; try { pending = /^\d{1,20}$/.test(p.pendingAmount) ? BigInt(p.pendingAmount) : 0n; } catch { pending = 0n; }
      if (active === null) b.push("Position stake could not be read.");
      else if (active <= 0n) b.push(pending > 0n ? "Only pending-unstake FLEURI; pending stake doesn't count." : "Active stake is zero.");
    }
  }
  return { eligible: b.length === 0, blockers: b, activeStake: active !== null ? active.toString() : null };
}

export type ActionState = "available" | "locked" | "exhausted" | "unavailable";
/** used = extra units the linked wallet used today. */
export function actionState(a: AccessAction, used: number, eligible: boolean, ready = true): { state: ActionState; left: number } {
  if (!ready) return { state: "unavailable", left: 0 };
  if (!eligible) return { state: "locked", left: 0 };
  const left = Math.max(0, ACCESS_POLICY[a].extra - used);
  return left > 0 ? { state: "available", left } : { state: "exhausted", left: 0 };
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const nextResetUtc = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

/** Server-side error kinds raised by the access SQL, mapped to safe messages. */
export type AccessErrorKind = "locked" | "exhausted" | "busy" | "inflight" | "conflict" | "stale" | "other";
export function accessError(msg: string): { kind: AccessErrorKind; message: string } {
  if (/access_locked/.test(msg)) return { kind: "locked", message: "Pollen Access isn't active for this workspace. See /access." };
  if (/access_exhausted/.test(msg)) return { kind: "exhausted", message: "Today's Pollen Access allowance for your wallet is used up. It resets at 00:00 UTC." };
  if (/access_busy/.test(msg)) return { kind: "busy", message: "Two Pollen Access actions are already running for your wallet. Wait for them to finish." };
  if (/access_inflight/.test(msg)) return { kind: "inflight", message: "That request is already running. Try again in a moment." };
  if (/access_conflict/.test(msg)) return { kind: "conflict", message: "This request id was already used with different input." };
  if (/access_stale/.test(msg)) return { kind: "stale", message: "This attempt expired and was handed over. Try again." };
  return { kind: "other", message: "Access could not be checked right now. Try again." };
}
