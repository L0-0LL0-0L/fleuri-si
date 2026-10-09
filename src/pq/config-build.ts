// SDK-backed builder for a reviewed draft (server and tests only).
import {
  ActivationType, BaseFeeMode, CollectFeeMode, MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenType,
  buildCurve,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { ConfigDraftT } from "./config-draft";

/** Exact SDK ConfigParameters for the draft (built by the pinned Meteora SDK). */
export function buildConfigParams(d: ConfigDraftT) {
  return buildCurve({
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: d.decimals, tokenQuoteDecimal: 9, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: d.totalSupply, leftover: 0 },
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

