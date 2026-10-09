// Reviewable Meteora DBC config draft. Pure: strict schema, SDK parameter builder and
// confirmed-config comparison. Only drafts that satisfy the launchpad eligibility policy
// (SOL quote, SPL, immutable, fixed equal supply, DAMM v2, LP 100% claimable/locked, no vesting)
// can be expressed, so a confirmed config always passes readDbcConfig's policy too.
import { z } from "zod";
import {
  ActivationType, BaseFeeMode, CollectFeeMode, MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenType,
  buildCurve,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { isSolanaAddress } from "./registration";

export const FEE_PRESET_BPS = [25, 30, 100, 200, 400, 600] as const;
const addr = z.string().refine(isSolanaAddress, "Invalid Solana address");
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const ConfigDraft = z
  .object({
    decimals: int(6, 9),
    totalSupply: int(1_000_000, 1_000_000_000_000),
    percentageSupplyOnMigration: int(1, 50),
    migrationThresholdSol: z.number().finite().min(1).max(10_000),
    baseFeeBps: int(25, 1000),
    creatorTradingFeePercent: int(0, 100),
    migrationFeeOption: int(0, 5),
    lp: z
      .object({ partnerClaimable: int(0, 100), partnerLocked: int(0, 100), creatorClaimable: int(0, 100), creatorLocked: int(0, 100) })
      .strict(),
    feeClaimer: addr,
    leftoverReceiver: addr,
  })
  .strict()
  .superRefine((d, ctx) => {
    const { partnerClaimable, partnerLocked, creatorClaimable, creatorLocked } = d.lp;
    if (partnerClaimable + partnerLocked + creatorClaimable + creatorLocked !== 100) ctx.addIssue({ code: "custom", path: ["lp"], message: "LP shares must total exactly 100%." });
    if (partnerLocked + creatorLocked < 10) ctx.addIssue({ code: "custom", path: ["lp"], message: "Meteora requires at least 10% of LP to be permanently locked." });
  });
export type ConfigDraftT = z.infer<typeof ConfigDraft>;

export function parseDraft(v: unknown): ConfigDraftT {
  const r = ConfigDraft.safeParse(v);
  if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".") || "draft"}: ${i.message}`).join("; "));
  return r.data;
}

/** Exact SDK ConfigParameters for the draft (built by the pinned Meteora SDK). */
export function buildConfigParams(d: ConfigDraftT) {
  return buildCurve({
    token: { tokenType: TokenType.SPL, tokenBaseDecimal: d.decimals, tokenQuoteDecimal: 9, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: d.totalSupply, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: d.baseFeeBps, endingFeeBps: d.baseFeeBps, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: d.creatorTradingFeePercent, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: d.migrationFeeOption as MigrationFeeOption, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: {
      partnerLiquidityPercentage: d.lp.partnerClaimable, partnerPermanentLockedLiquidityPercentage: d.lp.partnerLocked,
      creatorLiquidityPercentage: d.lp.creatorClaimable, creatorPermanentLockedLiquidityPercentage: d.lp.creatorLocked,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot,
    percentageSupplyOnMigration: d.percentageSupplyOnMigration,
    migrationQuoteThreshold: d.migrationThresholdSol,
  } as Parameters<typeof buildCurve>[0]);
}

/** Readable, exact terms the owner reviews and that the confirmed account must match. */
export function expectedTerms(d: ConfigDraftT, params: { migrationQuoteThreshold: { toString(): string } }) {
  return {
    decimals: d.decimals,
    totalSupply: (BigInt(d.totalSupply) * 10n ** BigInt(d.decimals)).toString(),
    baseFeeBps: d.baseFeeBps,
    creatorTradingFeePercent: d.creatorTradingFeePercent,
    partnerTradingFeePercent: 100 - d.creatorTradingFeePercent,
    migrationFeeOption: d.migrationFeeOption,
    migratedPoolFeeBps: FEE_PRESET_BPS[d.migrationFeeOption],
    quoteThresholdLamports: params.migrationQuoteThreshold.toString(),
    lp: { creatorLiquidityPercent: d.lp.creatorClaimable, creatorPermanentLockedPercent: d.lp.creatorLocked, partnerLiquidityPercent: d.lp.partnerClaimable, partnerPermanentLockedPercent: d.lp.partnerLocked },
    feeClaimer: d.feeClaimer,
    leftoverReceiver: d.leftoverReceiver,
  };
}
export type ExpectedTerms = ReturnType<typeof expectedTerms>;

interface ChainTerms {
  decimals: number; totalSupply: string;
  fees: { baseFeeBps: number; creatorTradingFeePercent: number; feeClaimer: string };
  lp: ExpectedTerms["lp"];
  migration: { quoteThresholdLamports: string; migrationFeeOption: number; migratedPoolFeeBps: number };
  authority: { leftoverReceiver: string };
}
/** Lists every reviewed term that differs on chain. Empty means the account matches. */
export function compareConfig(chain: ChainTerms, e: ExpectedTerms): string[] {
  const out: string[] = [];
  const eq = (label: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${label}: on chain ${JSON.stringify(a)}, reviewed ${JSON.stringify(b)}`); };
  eq("decimals", chain.decimals, e.decimals);
  eq("total supply", chain.totalSupply, e.totalSupply);
  eq("base fee bps", chain.fees.baseFeeBps, e.baseFeeBps);
  eq("creator fee share", chain.fees.creatorTradingFeePercent, e.creatorTradingFeePercent);
  eq("fee claimer", chain.fees.feeClaimer, e.feeClaimer);
  eq("leftover receiver", chain.authority.leftoverReceiver, e.leftoverReceiver);
  eq("graduation threshold", chain.migration.quoteThresholdLamports, e.quoteThresholdLamports);
  eq("DAMM v2 fee option", chain.migration.migrationFeeOption, e.migrationFeeOption);
  eq("DAMM v2 fee bps", chain.migration.migratedPoolFeeBps, e.migratedPoolFeeBps);
  eq("LP shares", chain.lp, e.lp);
  return out;
}
