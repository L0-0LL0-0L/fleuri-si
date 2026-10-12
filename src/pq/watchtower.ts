// Graduation Watchtower: pure, browser-safe assessment of a Meteora DBC pool's graduation into
// DAMM v2. Inputs are already-decoded account facts (decoded server-side with the installed SDK
// IDL coders); every quantity is an exact integer string. Nothing here reads the network.
//
// Rule: a status is only "verified" when the account facts prove it. Missing or contradictory
// evidence yields pending / unknown / unavailable with a reason — never "ready" or "locked".

export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const DFS_PROGRAM = "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGqPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
/** DBC MigrationFeeOption 0–5 are fixed DAMM v2 fee presets; 6 is Customizable (fee comes from the config). */
export const FIXED_FEE_BPS = [25, 30, 100, 200, 400, 600] as const;
/** DBC migration_damm_v2 Anchor discriminator (installed SDK IDL; checked by tests). */
export const MIGRATION_DAMM_V2_IX = [156, 169, 230, 103, 53, 228, 80, 64] as const;

export type Status = "verified" | "pending" | "unknown" | "unavailable" | "failed" | "unsupported";
export interface Check { id: string; label: string; status: Status; detail: string }

export interface PoolFacts {
  address: string; config: string; creator: string; baseMint: string; baseVault: string; quoteVault: string;
  quoteReserve: string; baseReserve: string; isMigrated: number; migrationProgress: number; finishCurveTimestamp: string;
  partnerQuoteFee: string; creatorQuoteFee: string; partnerBaseFee: string; creatorBaseFee: string;
  /** Re-derived from the SDK seeds; null when the server couldn't derive. */
  derivedAddress: string | null; derivedBaseVault: string | null; derivedQuoteVault: string | null;
}
export interface LiquidityVesting { isInitialized: number; vestingPercentage: number; bpsPerPeriod: number; numberOfPeriods: number; frequency: number; cliffDurationFromMigrationTime: number }
export interface ConfigFacts {
  address: string; owner: string; quoteMint: string; feeClaimer: string; leftoverReceiver: string;
  collectFeeMode: number; migrationOption: number; migrationFeeOption: number; tokenType: number; quoteTokenFlag: number; tokenDecimal: number;
  partnerLiquidityPercentage: number; partnerPermanentLockedLiquidityPercentage: number;
  creatorLiquidityPercentage: number; creatorPermanentLockedLiquidityPercentage: number;
  partnerVesting: LiquidityVesting; creatorVesting: LiquidityVesting;
  migrationQuoteThreshold: string; migratedPoolFeeBps: number; migratedCollectFeeMode: number; migratedDynamicFee: number; migratedCompoundingFeeBps: number;
  lockedVesting: { amountPerPeriod: string; numberOfPeriod: string; cliffUnlockAmount: string };
  creatorTradingFeePercentage: number;
}
export interface MintFacts {
  address: string; owner: string | null; decimals: number | null; supply: string | null;
  /** Decoded from the current SPL mint layout; null when the account is missing or too short. */
  initialized?: boolean | null; mintAuthority?: string | null; freezeAuthority?: string | null;
}
export interface DammPoolFacts {
  address: string; owner: string; tokenAMint: string; tokenBMint: string; liquidity: string; permanentLockLiquidity: string;
  collectFeeMode: number; poolStatus: number; activationType: number; creator: string; dynamicFeeInitialized: number;
  protocolFeePercent: number; referralFeePercent: number; compoundingFeeBps: number; baseFeeBytesHex: string; totalPositions: string;
}
export interface InnerVestingFacts { cliffPoint: string; periodFrequency: string; cliffUnlockLiquidity: string; liquidityPerPeriod: string; totalReleasedLiquidity: string; numberOfPeriod: number }
export interface PositionFacts {
  address: string; owner: string; pool: string; nftMint: string; derivedAddress: string | null;
  unlockedLiquidity: string; vestedLiquidity: string; permanentLockedLiquidity: string; feeAPending: string; feeBPending: string;
  innerVesting: InnerVestingFacts;
  /** The NFT holder: token account at the program's derived NFT-account PDA. */
  nft: { account: string; derivedAccount: string | null; tokenProgram: string | null; mint: string | null; holder: string | null; amount: string | null; mintOwner: string | null; mintSupply: string | null; mintDecimals: number | null;
    /** SPL token-account state byte (1 = initialized, 2 = frozen); null = unreadable. */ state?: number | null; mintInitialized?: boolean | null } | null;
  /** Confirmed context slot of the batch that read this position and its NFT accounts. */
  slot?: number | null;
}
export interface VaultFacts {
  address: string; mint: string; tokenVault: string; recipients: string[]; pdaIssues: string[];
  /** Layout/type/mint/token-vault problems found by the server; any entry means the vault is not a verified routing target. */
  issues?: string[]; feeVaultType?: number; slot?: number | null;
}
/** A vault counts for routing only when its layout, type, mint, token vault and recipients all check out. */
export const vaultProblems = (v: VaultFacts) => [...(v.issues ?? []), ...v.pdaIssues, ...(v.recipients.length ? [] : ["The vault has no recipients."])];
export interface Discovery { method: "program_accounts" | "migration_tx"; status: "found" | "not_found" | "truncated" | "unavailable"; signature: string | null; pagesRead: number; detail: string; positions: string[]; budget?: { maxRequests: number; maxMs: number; requests: number } }

export interface WatchInput {
  cluster: string; genesisHash: string; fetchedAt: string;
  slots: { pool: number | null; config: number | null; damm: number | null; positions: number | null };
  nowUnix: number | null;
  pool: PoolFacts; config: ConfigFacts | null; baseMint: MintFacts | null; quoteMint: MintFacts | null;
  damm: { derived: string | null; derivationNote: string; account: "missing" | "wrong_owner" | "undecodable" | "ok" | "not_read"; facts: DammPoolFacts | null };
  discovery: Discovery | null; positions: PositionFacts[]; positionErrors: { address: string; reason: string }[];
  vaults: VaultFacts[];
}

const B = (s: string | null | undefined) => (s == null ? 0n : BigInt(s));

// ---- lifecycle ----
export type Stage = "curve_active" | "curve_complete" | "locker_pending" | "ready_to_create" | "migrated_unverified" | "damm_v2_verified" | "unsupported";
export const STAGE_TEXT: Record<Stage, string> = {
  curve_active: "Trading on the bonding curve",
  curve_complete: "Curve complete — waiting for migration",
  locker_pending: "Curve complete — locker step pending",
  ready_to_create: "Locker done — DAMM v2 pool not created yet",
  migrated_unverified: "Marked migrated — DAMM v2 pool not verified",
  damm_v2_verified: "Graduated — DAMM v2 pool verified",
  unsupported: "Not tracked: unsupported migration target",
};

export function needsLocker(c: ConfigFacts) {
  const v = c.lockedVesting;
  return B(v.cliffUnlockAmount) + B(v.amountPerPeriod) * B(v.numberOfPeriod) > 0n;
}

/** DAMM v2 account matches the pool: right owner, decoded, and mints are this launch's base/quote. */
export function dammVerified(i: WatchInput): { ok: boolean; reason: string } {
  const d = i.damm;
  if (!d.derived) return { ok: false, reason: d.derivationNote || "No DAMM v2 address could be derived." };
  if (d.account === "not_read") return { ok: false, reason: "The DAMM v2 account was not read." };
  if (d.account === "missing") return { ok: false, reason: "No account exists at the derived DAMM v2 address." };
  if (d.account === "wrong_owner") return { ok: false, reason: "The account at the derived address is not owned by DAMM v2." };
  if (d.account === "undecodable" || !d.facts) return { ok: false, reason: "The account at the derived address does not decode as a DAMM v2 pool." };
  if (d.facts.owner !== DAMM_V2_PROGRAM) return { ok: false, reason: "The account at the derived address is not owned by DAMM v2." };
  if (d.facts.address !== d.derived) return { ok: false, reason: "The decoded DAMM v2 account is not the one at the derived address." };
  if (!i.config) return { ok: false, reason: "The DBC config could not be read, so the mints can't be checked." };
  const c = i.config, p = i.pool;
  if (c.address !== p.config || c.owner !== DBC_PROGRAM) return { ok: false, reason: "The read config is not this pool's DBC-owned config." };
  if (p.derivedAddress == null || p.derivedAddress !== p.address) return { ok: false, reason: "The DBC pool is not the canonical address for its config and mints." };
  if (p.derivedBaseVault == null || p.derivedBaseVault !== p.baseVault || p.derivedQuoteVault !== p.quoteVault) return { ok: false, reason: "The DBC pool's token vaults don't match their derived addresses." };
  if (d.facts.tokenAMint !== i.pool.baseMint || d.facts.tokenBMint !== i.config.quoteMint) return { ok: false, reason: "The DAMM v2 pool's mints differ from this launch's base/quote mints." };
  return { ok: true, reason: "Derived address holds a DAMM v2 pool with this launch's base and quote mints." };
}

export function stage(i: WatchInput): { stage: Stage; reason: string } {
  const c = i.config;
  if (c && c.migrationOption !== 1) return { stage: "unsupported", reason: `Migration option ${c.migrationOption} is not DAMM v2 (1); DAMM v1 graduations are not tracked.` };
  const dv = dammVerified(i);
  if (i.pool.isMigrated === 1 || i.pool.migrationProgress >= 3) return dv.ok ? { stage: "damm_v2_verified", reason: dv.reason } : { stage: "migrated_unverified", reason: dv.reason };
  if (i.pool.migrationProgress === 2) return { stage: "ready_to_create", reason: "migrationProgress is LockedVesting (2): the DAMM v2 pool can be created." };
  const complete = i.pool.migrationProgress === 1 || (!!c && B(c.migrationQuoteThreshold) > 0n && B(i.pool.quoteReserve) >= B(c.migrationQuoteThreshold));
  if (!complete) return { stage: "curve_active", reason: "migrationProgress is PreBondingCurve (0) and the quote reserve is below the threshold." };
  if (!c) return { stage: "curve_complete", reason: "Curve is complete; the config could not be read, so the locker requirement is unknown." };
  return needsLocker(c) ? { stage: "locker_pending", reason: "Base-token locked vesting is configured, so a locker transaction must confirm first." } : { stage: "curve_complete", reason: "Curve is complete and no locker is required." };
}

/** Exact progress: reserve/threshold in basis points, floored; null when unknown. */
export function progressBps(i: WatchInput): number | null {
  const t = i.config ? B(i.config.migrationQuoteThreshold) : 0n;
  if (t <= 0n) return null;
  const r = B(i.pool.quoteReserve) * 10000n / t;
  return Number(r > 10000n ? 10000n : r);
}

// ---- validation checks ----
export function poolChecks(i: WatchInput): Check[] {
  const p = i.pool, c = i.config, out: Check[] = [];
  const add = (id: string, label: string, status: Status, detail: string) => out.push({ id, label, status, detail });
  add("pool", "DBC pool account", "verified", "Owned by Meteora DBC and decoded as VirtualPool.");
  add("canonical", "Canonical pool address", p.derivedAddress == null ? "unknown" : p.derivedAddress === p.address ? "verified" : "failed",
    p.derivedAddress == null ? "Could not re-derive the pool address." : p.derivedAddress === p.address ? "Re-derived from quote mint, base mint and config." : "This address is not the canonical PDA for its config and mints.");
  add("vaults", "Pool token vaults", p.derivedBaseVault === p.baseVault && p.derivedQuoteVault === p.quoteVault ? "verified" : p.derivedBaseVault == null ? "unknown" : "failed",
    p.derivedBaseVault === p.baseVault && p.derivedQuoteVault === p.quoteVault ? "Base and quote vaults match their derived addresses." : "Vault addresses could not be confirmed.");
  if (!c) add("config", "DBC config", "unavailable", "The pool's config account could not be read or decoded.");
  else {
    add("config", "DBC config", c.address === p.config && c.owner === DBC_PROGRAM ? "verified" : "failed", c.address === p.config ? "The pool's own config, owned by DBC and decoded as PoolConfig." : "Config address differs from the pool's.");
    add("target", "Migration target", c.migrationOption === 1 ? "verified" : "unsupported", c.migrationOption === 1 ? "DAMM v2." : `Option ${c.migrationOption} (DAMM v1) is not tracked.`);
    const live = dammVerified(i).ok;
    add("feeOption", "Migration fee option", c.migrationFeeOption <= 5 ? "verified" : c.migrationFeeOption === 6 ? (live ? "verified" : "pending") : "unsupported",
      c.migrationFeeOption <= 5 ? `Fixed preset ${c.migrationFeeOption}: ${FIXED_FEE_BPS[c.migrationFeeOption]} bps.` : c.migrationFeeOption === 6 ? `Customizable: configured ${c.migratedPoolFeeBps} bps (config intent). ${live ? "The live DAMM v2 fee fields are shown from the verified pool." : "No live pool fee until the DAMM v2 pool verifies."}` : `Unknown option ${c.migrationFeeOption}.`);
    const quoteOk = c.quoteMint === SOL_MINT;
    add("quote", "Quote mint", quoteOk ? "verified" : "unsupported", quoteOk ? "Wrapped SOL." : `Quote mint ${c.quoteMint} is not SOL; amounts are shown in raw base units.`);
  }
  const bm = i.baseMint;
  if (!bm || !bm.owner) add("baseMint", "Base mint", "unavailable", "The base mint account could not be read.");
  else if (bm.address !== p.baseMint) add("baseMint", "Base mint", "failed", "The read mint differs from the pool's base mint.");
  else if (bm.owner === TOKEN_PROGRAM && bm.initialized === false) add("baseMint", "Base mint", "failed", "The base mint account is not initialized.")
  else if (bm.owner === TOKEN_PROGRAM && bm.initialized == null) add("baseMint", "Base mint", "unavailable", "The base mint data could not be decoded.")
  else add("baseMint", "Base mint", bm.owner === TOKEN_PROGRAM ? "verified" : bm.owner === TOKEN_2022_PROGRAM ? "unsupported" : "failed",
    bm.owner === TOKEN_PROGRAM ? `SPL Token, ${bm.decimals} decimals; mint authority ${bm.mintAuthority ? "set" : "revoked"}, freeze authority ${bm.freezeAuthority ? "set" : "revoked"} (current read).` : bm.owner === TOKEN_2022_PROGRAM ? "Token-2022 mint: extensions are not inspected here." : "Not owned by a token program.");
  return out;
}

// ---- liquidity ----
export interface Bucket { side: "partner" | "creator"; owner: string; unlockedPct: number; permanentPct: number; vestingPct: number }
/** Configured (intended) split from the DBC config — not observed ownership. */
export function configuredBuckets(c: ConfigFacts, creator: string): Bucket[] {
  const v = (x: LiquidityVesting) => (x.isInitialized ? x.vestingPercentage : 0);
  return [
    { side: "partner", owner: c.feeClaimer, unlockedPct: c.partnerLiquidityPercentage, permanentPct: c.partnerPermanentLockedLiquidityPercentage, vestingPct: v(c.partnerVesting) },
    { side: "creator", owner: creator, unlockedPct: c.creatorLiquidityPercentage, permanentPct: c.creatorPermanentLockedLiquidityPercentage, vestingPct: v(c.creatorVesting) },
  ];
}

/** Liquidity releasable from a position's inner vesting at `now` (slot or unix time per activationType). */
export function innerVestingReleasable(v: InnerVestingFacts, now: bigint | null): { releasable: string | null; remaining: string } {
  const total = B(v.cliffUnlockLiquidity) + B(v.liquidityPerPeriod) * BigInt(v.numberOfPeriod);
  const remaining = total - B(v.totalReleasedLiquidity);
  if (total === 0n) return { releasable: "0", remaining: "0" };
  if (now == null) return { releasable: null, remaining: (remaining < 0n ? 0n : remaining).toString() };
  let unlocked = 0n;
  const cliff = B(v.cliffPoint), freq = B(v.periodFrequency);
  if (now >= cliff) {
    unlocked = B(v.cliffUnlockLiquidity);
    if (freq > 0n) { let periods = (now - cliff) / freq; if (periods > BigInt(v.numberOfPeriod)) periods = BigInt(v.numberOfPeriod); unlocked += periods * B(v.liquidityPerPeriod); }
  }
  const rel = unlocked - B(v.totalReleasedLiquidity);
  return { releasable: (rel < 0n ? 0n : rel).toString(), remaining: (remaining < 0n ? 0n : remaining).toString() };
}

export interface PositionView {
  address: string; status: Status; problems: string[]; holder: string | null; holderRole: "partner" | "creator" | "dfs_vault" | "other" | null;
  unlocked: string; vested: string; permanent: string; vestingReleasableNow: string | null; vestingRemainingInner: string; separateVestingUnknown: boolean;
  lockBadge: "permanent" | "vesting" | "unlocked" | "mixed" | null; feeAPending: string; feeBPending: string;
  /** True only when every unit of this position's liquidity is permanently locked. */
  allPermanent: boolean; slot: number | null;
}
export function assessPosition(i: WatchInput, p: PositionFacts): PositionView {
  const problems: string[] = [];
  const damm = i.damm.facts;
  if (p.owner !== DAMM_V2_PROGRAM) problems.push("Position account is not owned by DAMM v2.");
  if (!dammVerified(i).ok) problems.push("The DAMM v2 pool is not verified, so its positions can't be.");
  else if (!damm || p.pool !== damm.address) problems.push("Position belongs to a different pool than the verified DAMM v2 pool.");
  if (p.derivedAddress !== p.address) problems.push("Position address is not derived from its NFT mint.");
  const n = p.nft;
  if (!n) problems.push("The position NFT account could not be read.");
  else {
    if (n.derivedAccount !== n.account) problems.push("NFT account is not the program-derived position NFT account.");
    if (n.tokenProgram !== TOKEN_2022_PROGRAM) problems.push("NFT account is not a Token-2022 account.");
    if (n.mint !== p.nftMint) problems.push("NFT account holds a different mint.");
    if (n.amount !== "1") problems.push("NFT account does not hold exactly one NFT.");
    if (n.mintOwner !== TOKEN_2022_PROGRAM || n.mintSupply !== "1" || n.mintDecimals !== 0) problems.push("NFT mint is not a single-supply, zero-decimal Token-2022 mint.");
    if (n.mintInitialized !== true) problems.push("NFT mint is not readable as an initialized mint.");
    if (n.state == null) problems.push("NFT token account state is unknown.");
    else if (n.state !== 1) problems.push(n.state === 2 ? "NFT token account is frozen." : "NFT token account is not initialized.");
    if (!n.holder) problems.push("NFT holder could not be read.");
  }
  const ok = problems.length === 0;
  const holder = ok ? n!.holder : null;
  const role = !holder ? null : i.vaults.some((v) => v.address === holder && !vaultProblems(v).length) ? "dfs_vault" : i.config && holder === i.config.feeClaimer ? "partner" : holder === i.pool.creator ? "creator" : "other";
  const now = damm?.activationType === 0 ? (i.slots.positions != null ? BigInt(i.slots.positions) : null) : i.nowUnix != null ? BigInt(i.nowUnix) : null;
  const iv = innerVestingReleasable(p.innerVesting, now);
  const vested = B(p.vestedLiquidity), perm = B(p.permanentLockedLiquidity), unl = B(p.unlockedLiquidity);
  const innerLeft = B(iv.remaining);
  const kinds = [perm > 0n && "permanent", (vested > 0n || innerLeft > 0n) && "vesting", unl > 0n && "unlocked"].filter(Boolean) as string[];
  return {
    address: p.address, status: ok ? "verified" : "failed", problems, holder, holderRole: role,
    unlocked: p.unlockedLiquidity, vested: p.vestedLiquidity, permanent: p.permanentLockedLiquidity,
    vestingReleasableNow: ok ? iv.releasable : null, vestingRemainingInner: iv.remaining,
    separateVestingUnknown: vested > B(iv.remaining),
    lockBadge: !ok ? null : kinds.length === 1 ? (kinds[0] as PositionView["lockBadge"]) : kinds.length ? "mixed" : null,
    feeAPending: p.feeAPending, feeBPending: p.feeBPending,
    allPermanent: ok && perm > 0n && unl === 0n && vested === 0n && innerLeft === 0n, slot: p.slot ?? null,
  };
}

// ---- fee routing readiness, per source ----
export interface Routing { source: string; status: Status; detail: string[] }
export function routing(i: WatchInput, positions: PositionView[]): Routing[] {
  const out: Routing[] = []; const c = i.config;
  const vaultBy = (a: string | null | undefined) => (a ? i.vaults.find((v) => v.address === a) : undefined);
  const bad = (v: VaultFacts | undefined) => (v ? vaultProblems(v) : []);
  if (!c) return [{ source: "DBC trading fees", status: "unavailable", detail: ["The DBC config could not be read."] }];
  // DBC partner trading fee: the config's fee claimer must be a verified DFS vault for the quote mint.
  const pv = vaultBy(c.feeClaimer); const pd: string[] = [];
  if (!pv) pd.push("The config's fee claimer is not a verified fee-sharing vault (configs are immutable).");
  else {
    if (pv.mint !== c.quoteMint) pd.push("The vault's token differs from the pool's quote token.");
    if (c.collectFeeMode !== 0) pd.push("The pool does not collect fees only in the quote token.");
    pd.push(...bad(pv));
  }
  const migrated = i.pool.isMigrated === 1;
  if (migrated) pd.push("Curve trading has ended; only already-accrued DBC fees remain claimable.");
  out.push({ source: "DBC partner trading fee", status: !pv || pd.length > (migrated ? 1 : 0) ? "pending" : "verified",
    detail: pd.length ? [...pd, ...(pv ? ["A vault recipient must still trigger each claim; that signer is not checked here."] : [])] : ["Fee claimer is this vault with matching quote mint; a vault recipient must trigger each claim."] });
  // DBC creator trading fee: claimable by pool.creator.
  const cv = vaultBy(i.pool.creator); const cd: string[] = [];
  if (!cv) cd.push("The pool creator is not a verified fee-sharing vault.");
  else {
    if (cv.mint !== c.quoteMint) cd.push("The vault's token differs from the pool's quote token.");
    if (c.collectFeeMode !== 0) cd.push("The pool collects trading fees in both tokens; claiming the creator fee into a quote-only vault also needs a base-token vault, so only part of it could be routed.");
    cd.push(...bad(cv));
  }
  if (c.creatorTradingFeePercentage === 0) cd.push("The config gives the creator no share of trading fees.");
  out.push({ source: "DBC creator trading fee", status: cd.length ? "pending" : "verified", detail: cd.length ? cd : ["Pool creator is this vault with matching quote mint."] });
  // DAMM v2 position fees: only from positions whose NFT a verified vault holds.
  const d = i.damm.facts;
  if (!dammVerified(i).ok || !d) out.push({ source: "DAMM v2 position fees", status: i.pool.isMigrated ? "unknown" : "pending", detail: [i.pool.isMigrated ? "The DAMM v2 pool is not verified." : "No DAMM v2 pool yet."] });
  else if (!positions.length) out.push({ source: "DAMM v2 position fees", status: "unknown", detail: ["No migration positions were verified, so ownership is unknown."] });
  else for (const p of positions) {
    const v = vaultBy(p.holder); const dd: string[] = [];
    if (p.status !== "verified") dd.push("Position or NFT ownership is not verified.");
    else if (!v) dd.push("The NFT holder is not a verified fee-sharing vault.");
    else {
      if (v.mint !== d.tokenBMint && v.mint !== d.tokenAMint) dd.push("The vault's token is neither pool token.");
      else if (d.collectFeeMode !== 1 || v.mint !== d.tokenBMint) dd.push("The pool collects fees in both tokens (or the vault holds the base token); only one side could be funded into this vault.");
      dd.push(...bad(v));
    }
    out.push({ source: `DAMM v2 position fees · ${p.address.slice(0, 6)}…`, status: dd.length ? "pending" : "verified", detail: dd.length ? dd : ["A verified vault holds this position NFT, fees are collected only in the vault's token."] });
  }
  return out;
}

export function summarize(i: WatchInput) {
  const st = stage(i);
  const positions = i.positions.map((p) => assessPosition(i, p));
  return {
    stage: st, progressBps: progressBps(i), checks: poolChecks(i), damm: dammVerified(i),
    configured: i.config ? configuredBuckets(i.config, i.pool.creator) : null, positions, routing: routing(i, positions),
    caveat: "Accounts were read in separate confirmed batches (slots shown); they are not one atomic snapshot.",
  };
}
