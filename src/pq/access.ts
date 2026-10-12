// Pollen Access v1 policy: pure and browser-safe. The server enforces it; the page only explains it.
// Eligibility = any positive ACTIVE Pollen Staking position (pending unstake excluded), proved by a live
// mainnet read of a ready deployment, owned by the wallet the workspace linked with a verified signature.

export const ACCESS_POLICY_VERSION = "pollen-access-1";
export type AccessAction = "owner_cycle" | "deep_trial" | "research_report";

/** Daily units per owner, reset at 00:00 UTC. base = free for every workspace; extra = Pollen Access only. */
export const ACCESS_POLICY: Record<AccessAction, { base: number; extra: number; label: string; unit: string; detail: string }> = {
  owner_cycle: { base: 100, extra: 100, label: "Extra agent cycles", unit: "cycles", detail: "Owner-triggered sandbox cycles (Run cycle). Virtual vSOL only; scheduled cycles are not metered." },
  deep_trial: { base: 0, extra: 3, label: "Deep Greenhouse trials", unit: "trials", detail: "Trials above the free limits (up to 10 repetitions and 120 cycles, within a fixed compute budget). Free trials stay unmetered." },
  research_report: { base: 0, extra: 3, label: "Research credits", unit: "reports", detail: "Each credit creates one saved Botanist research report for a token mint, private to you. Credits are not USDC or cash; the paid x402 report is unchanged." },
};
export const MAX_INFLIGHT = 2;
export const ELIGIBILITY_TTL_SEC = 120;
/** Staking readiness checks that must pass: custody/program proof plus the correct, authority-free FLEURI mint. */
export const REQUIRED_CHECKS = ["cluster", "rpc", "configured", "program", "code", "pool", "vaults", "mint", "mintAuth", "freezeAuth"] as const;

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
  if (i.cluster !== "mainnet-beta") b.push(`Server network is ${i.cluster ?? "not configured"}; only mainnet stake counts.`);
  if (!i.checks) b.push("Pollen Staking readiness could not be read.");
  else for (const id of REQUIRED_CHECKS) {
    const c = i.checks.find((x) => x.id === id);
    if (!c) b.push(`Staking check "${id}" is missing.`);
    else if (!c.ok) b.push(`${c.label}: ${c.detail}`);
  }
  let active: bigint | null = null;
  if (!b.length) {
    const p = i.position;
    if (!p) b.push("No Pollen Staking position for the linked wallet.");
    else {
      if (!i.derivedPosition || p.address !== i.derivedPosition) b.push("Position is not the canonical PDA for this wallet.");
      if (p.owner !== i.wallet.address) b.push("Position belongs to a different wallet.");
      if (!i.poolAddress || p.pool !== i.poolAddress) b.push("Position belongs to a different pool.");
      try { active = BigInt(p.active); } catch { b.push("Position stake could not be read."); }
      if (active !== null && active <= 0n) b.push(BigInt(p.pendingAmount || "0") > 0n ? "Only pending-unstake FLEURI; pending stake doesn't count." : "Active stake is zero.");
    }
  }
  return { eligible: b.length === 0, blockers: b, activeStake: active !== null ? active.toString() : null };
}

export type ActionState = "available" | "locked" | "exhausted" | "unavailable";
/** base/extra = units used today. */
export function actionState(a: AccessAction, used: { base: number; extra: number }, eligible: boolean, ready = true): { state: ActionState; left: number } {
  const p = ACCESS_POLICY[a];
  if (!ready) return { state: "unavailable", left: 0 };
  const baseLeft = Math.max(0, p.base - used.base), extraLeft = eligible ? Math.max(0, p.extra - used.extra) : 0;
  if (baseLeft + extraLeft > 0) return { state: "available", left: baseLeft + extraLeft };
  return { state: eligible || p.extra === 0 ? "exhausted" : "locked", left: 0 };
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const nextResetUtc = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

/** Server-side error kinds raised by access_reserve, mapped to safe messages. */
export function accessError(msg: string): { kind: "locked" | "exhausted" | "busy" | "other"; message: string } {
  if (/access_locked/.test(msg)) return { kind: "locked", message: "Today's free allowance is used, and Pollen Access isn't active for this workspace. See /access." };
  if (/access_exhausted/.test(msg)) return { kind: "exhausted", message: "Today's Pollen Access allowance for this action is used up. It resets at 00:00 UTC." };
  if (/access_busy/.test(msg)) return { kind: "busy", message: "Two of these are already running. Wait for them to finish." };
  return { kind: "other", message: "Access could not be checked right now. Try again." };
}
