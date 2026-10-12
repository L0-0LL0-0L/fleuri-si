// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmmIdl } from "@meteora-ag/cp-amm-sdk";
import { vaultProblems, DAMM_V2_PROGRAM, DBC_PROGRAM, MIGRATION_DAMM_V2_IX, SOL_MINT, TOKEN_2022_PROGRAM, assessPosition, innerVestingReleasable, progressBps, poolChecks, routing, stage, summarize, type WatchInput } from "./watchtower";

const lv = { isInitialized: 0, vestingPercentage: 0, bpsPerPeriod: 0, numberOfPeriods: 0, frequency: 0, cliffDurationFromMigrationTime: 0 };
const iv = { cliffPoint: "0", periodFrequency: "0", cliffUnlockLiquidity: "0", liquidityPerPeriod: "0", totalReleasedLiquidity: "0", numberOfPeriod: 0 };
function base(): WatchInput {
  return {
    cluster: "mainnet-beta", genesisHash: "g", fetchedAt: "", slots: { pool: 1, config: 1, damm: 2, positions: 3 }, nowUnix: 1000,
    pool: { address: "P", config: "C", creator: "CR", baseMint: "B", baseVault: "BV", quoteVault: "QV", quoteReserve: "50", baseReserve: "0", isMigrated: 0, migrationProgress: 0, finishCurveTimestamp: "0", partnerQuoteFee: "0", creatorQuoteFee: "0", partnerBaseFee: "0", creatorBaseFee: "0", derivedAddress: "P", derivedBaseVault: "BV", derivedQuoteVault: "QV" },
    config: { address: "C", owner: DBC_PROGRAM, quoteMint: SOL_MINT, feeClaimer: "FC", leftoverReceiver: "L", collectFeeMode: 0, migrationOption: 1, migrationFeeOption: 2, tokenType: 0, quoteTokenFlag: 0, tokenDecimal: 6,
      partnerLiquidityPercentage: 50, partnerPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50, partnerVesting: lv, creatorVesting: lv,
      migrationQuoteThreshold: "100", migratedPoolFeeBps: 0, migratedCollectFeeMode: 0, migratedDynamicFee: 0, migratedCompoundingFeeBps: 0, lockedVesting: { amountPerPeriod: "0", numberOfPeriod: "0", cliffUnlockAmount: "0" }, creatorTradingFeePercentage: 0 },
    baseMint: { address: "B", owner: "TokenkegQfeZyiNwAJbNbGqPFXCWuBvf9Ss623VQ5DA", decimals: 6, supply: "1" }, quoteMint: null,
    damm: { derived: "D", derivationNote: "", account: "not_read", facts: null }, discovery: null, positions: [], positionErrors: [], vaults: [],
  };
}
const dammOk = (i: WatchInput, over: any = {}) => { i.pool.isMigrated = 1; i.pool.migrationProgress = 3; i.damm = { derived: "D", derivationNote: "", account: "ok", facts: { address: "D", owner: DAMM_V2_PROGRAM, tokenAMint: "B", tokenBMint: SOL_MINT, liquidity: "10", permanentLockLiquidity: "0", collectFeeMode: 1, poolStatus: 0, activationType: 1, creator: "x", dynamicFeeInitialized: 0, protocolFeePercent: 20, referralFeePercent: 20, compoundingFeeBps: 0, baseFeeBytesHex: "", totalPositions: "1", ...over } }; };
const pos = (over: any = {}) => ({ address: "POS", owner: DAMM_V2_PROGRAM, pool: "D", nftMint: "N", derivedAddress: "POS", unlockedLiquidity: "0", vestedLiquidity: "0", permanentLockedLiquidity: "10", feeAPending: "0", feeBPending: "0", innerVesting: iv,
  nft: { account: "NA", derivedAccount: "NA", tokenProgram: TOKEN_2022_PROGRAM, mint: "N", holder: "VAULT", amount: "1", mintOwner: TOKEN_2022_PROGRAM, mintSupply: "1", mintDecimals: 0, state: 1, mintInitialized: true }, slot: 3, ...over });

describe("watchtower lifecycle", () => {
  it("matches installed IDL selectors", () => {
    expect((DynamicBondingCurveIdl as any).instructions.find((x: any) => x.name === "migration_damm_v2").discriminator).toEqual([...MIGRATION_DAMM_V2_IX]);
    expect((CpAmmIdl as any).accounts.find((x: any) => x.name === "Position").discriminator).toEqual([170, 188, 143, 228, 122, 64, 247, 208]);
  });
  it("walks curve → complete → locker → ready → migrated, with exact progress", () => {
    const i = base(); expect(stage(i).stage).toBe("curve_active"); expect(progressBps(i)).toBe(5000);
    i.pool.quoteReserve = "100"; expect(stage(i).stage).toBe("curve_complete");
    i.config!.lockedVesting.cliffUnlockAmount = "1"; expect(stage(i).stage).toBe("locker_pending");
    i.pool.migrationProgress = 2; expect(stage(i).stage).toBe("ready_to_create");
    i.pool.isMigrated = 1; expect(stage(i).stage).toBe("migrated_unverified");
  });
  it("never verifies a migrated pool from the flag, a wrong owner or wrong mints", () => {
    const i = base(); dammOk(i); expect(stage(i).stage).toBe("damm_v2_verified");
    dammOk(i, { owner: "X" }); expect(stage(i).stage).toBe("migrated_unverified");
    dammOk(i, { tokenAMint: "OTHER" }); expect(stage(i).stage).toBe("migrated_unverified");
    i.damm.account = "missing"; expect(stage(i).stage).toBe("migrated_unverified");
  });
  it("flags DAMM v1 targets, non-canonical pools and Token-2022 base mints", () => {
    const i = base(); i.config!.migrationOption = 0; expect(stage(i).stage).toBe("unsupported");
    i.pool.derivedAddress = "OTHER"; i.baseMint!.owner = TOKEN_2022_PROGRAM;
    const c = Object.fromEntries(summarize(i).checks.map((x) => [x.id, x.status]));
    expect(c.canonical).toBe("failed"); expect(c.baseMint).toBe("unsupported"); expect(c.target).toBe("unsupported");
  });
  it("keeps a customizable fee option pending until the pool verifies", () => {
    const i = base(); i.config!.migrationFeeOption = 6;
    expect(summarize(i).checks.find((c) => c.id === "feeOption")!.status).toBe("pending");
    dammOk(i); expect(summarize(i).checks.find((c) => c.id === "feeOption")!.status).toBe("verified");
  });
});

describe("watchtower positions and routing", () => {
  it("verifies NFT ownership and permanent locks only from consistent accounts", () => {
    const i = base(); dammOk(i);
    expect(assessPosition(i, pos())).toMatchObject({ status: "verified", lockBadge: "permanent", holder: "VAULT" });
    for (const bad of [{ pool: "OTHER" }, { owner: "X" }, { derivedAddress: "Z" }, { nft: { ...pos().nft, amount: "0" } }, { nft: { ...pos().nft, mint: "M2" } }, { nft: { ...pos().nft, tokenProgram: "X" } }, { nft: null }]) {
      const v = assessPosition(i, pos(bad)); expect(v.status).toBe("failed"); expect(v.lockBadge).toBeNull(); expect(v.holder).toBeNull();
    }
  });
  it("computes vesting releasable with exact integers and flags unscanned vesting", () => {
    const v = { cliffPoint: "100", periodFrequency: "10", cliffUnlockLiquidity: "5", liquidityPerPeriod: "340282366920938463463374607431768211455", totalReleasedLiquidity: "5", numberOfPeriod: 2 };
    expect(innerVestingReleasable(v, 99n).releasable).toBe("0");
    expect(innerVestingReleasable(v, 125n).releasable).toBe((340282366920938463463374607431768211455n * 2n).toString());
    expect(innerVestingReleasable(v, null).releasable).toBeNull();
    const i = base(); dammOk(i);
    expect(assessPosition(i, pos({ vestedLiquidity: "7", permanentLockedLiquidity: "0" })).separateVestingUnknown).toBe(true);
  });
  it("reports routing per source, never from config intent alone", () => {
    const i = base(); dammOk(i);
    const p = assessPosition(i, pos());
    expect(routing(i, [p]).every((r) => r.status !== "verified")).toBe(true); // no verified vault
    i.vaults = [{ address: "VAULT", mint: SOL_MINT, tokenVault: "T", recipients: ["R1", "R2"], pdaIssues: [] }];
    const r = routing(i, [assessPosition(i, pos())]);
    expect(r.find((x) => x.source.startsWith("DAMM"))!.status).toBe("verified");
    expect(r.find((x) => x.source === "DBC partner trading fee")!.status).toBe("pending");
    i.damm.facts!.collectFeeMode = 0;
    expect(routing(i, [assessPosition(i, pos())]).find((x) => x.source.startsWith("DAMM"))!.status).toBe("pending");
    expect(routing(i, []).find((x) => x.source.startsWith("DAMM"))!.status).toBe("unknown");
  });
});

describe("watchtower strict evidence", () => {
  it("never verifies an NFT with unknown, frozen or uninitialized token state", () => {
    const i = base(); dammOk(i);
    for (const st of [null, undefined, 0, 2]) {
      const v = assessPosition(i, pos({ nft: { ...pos().nft, state: st } }));
      expect(v.status).toBe("failed"); expect(v.holder).toBeNull(); expect(v.lockBadge).toBeNull();
    }
    expect(assessPosition(i, pos({ nft: { ...pos().nft, mintInitialized: null } })).status).toBe("failed");
    expect(assessPosition(i, pos()).slot).toBe(3);
  });
  it("only says all permanently locked when no unlocked or vesting liquidity exists", () => {
    const i = base(); dammOk(i);
    expect(assessPosition(i, pos()).allPermanent).toBe(true);
    for (const o of [{ unlockedLiquidity: "1" }, { vestedLiquidity: "1" }, { innerVesting: { ...iv, cliffUnlockLiquidity: "4" } }]) {
      const v = assessPosition(i, pos(o)); expect(v.allPermanent).toBe(false); expect(v.lockBadge).toBe("mixed");
    }
  });
  it("does not route into a vault with layout, mint or recipient problems", () => {
    const i = base(); dammOk(i);
    const good = { address: "VAULT", mint: SOL_MINT, tokenVault: "T", recipients: ["R1", "R2"], pdaIssues: [], issues: [] };
    i.vaults = [good];
    expect(routing(i, [assessPosition(i, pos())]).find((x) => x.source.startsWith("DAMM"))!.status).toBe("verified");
    for (const bad of [{ ...good, issues: ["The vault's token account holds a different mint."] }, { ...good, recipients: [] }, { ...good, pdaIssues: ["non-PDA"] }]) {
      i.vaults = [bad]; expect(vaultProblems(bad).length).toBeGreaterThan(0);
      const p = assessPosition(i, pos()); expect(p.holderRole).toBe("other");
      expect(routing(i, [p]).find((x) => x.source.startsWith("DAMM"))!.status).toBe("pending");
    }
  });
  it("fails or withholds the base-mint check on uninitialized or undecodable mints", () => {
    const i = base(); i.baseMint = { ...i.baseMint!, initialized: false };
    expect(poolChecks(i).find((c) => c.id === "baseMint")!.status).toBe("failed");
    i.baseMint = { ...i.baseMint!, initialized: null };
    expect(poolChecks(i).find((c) => c.id === "baseMint")!.status).toBe("unavailable");
  });
});

describe("review regressions", () => {
  it("never graduates with a mismatched DAMM address, foreign config, non-canonical PDA or vaults", () => {
    const cases: ((i: WatchInput) => void)[] = [
      (i) => { i.damm.facts!.address = "OTHER"; },
      (i) => { i.config!.address = "C2"; },
      (i) => { i.config!.owner = "X"; },
      (i) => { i.pool.derivedAddress = "OTHER"; },
      (i) => { i.pool.derivedAddress = null; },
      (i) => { i.pool.derivedQuoteVault = "OTHER"; },
    ];
    for (const f of cases) { const i = base(); dammOk(i); f(i); expect(stage(i).stage).toBe("migrated_unverified"); }
  });
  it("does not verify a position or lock badge when the DAMM v2 pool is unverified", () => {
    const i = base(); dammOk(i); i.damm.facts!.owner = "X";
    const v = assessPosition(i, pos()); expect(v.status).toBe("failed"); expect(v.lockBadge).toBeNull(); expect(v.allPermanent).toBe(false);
  });
  it("keeps creator routing pending when the pool collects fees in both tokens", () => {
    const i = base(); i.config!.creatorTradingFeePercentage = 50;
    i.vaults = [{ address: "CR", mint: SOL_MINT, tokenVault: "T", recipients: ["R1", "R2"], pdaIssues: [], issues: [] }];
    expect(routing(i, []).find((r) => r.source === "DBC creator trading fee")!.status).toBe("verified");
    i.config!.collectFeeMode = 1;
    const r = routing(i, []).find((r) => r.source === "DBC creator trading fee")!;
    expect(r.status).toBe("pending"); expect(r.detail.join(" ")).toMatch(/both tokens/);
  });
});
