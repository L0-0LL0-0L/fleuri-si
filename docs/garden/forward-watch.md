# Forward Watch

Private prospective read-only mainnet research; manual capture, hypothetical execution. No scheduler, transactions, earned LP fees, actual fills or model evaluation.

## Freeze before outcomes

Choose an owned agent, explicit DBC or DAMM v2 pool, orientation, actual-mint atomic starting inventory, hold/fixed-bound equal-value rule, modeled fee/slippage, expectations, cadence, windows, expiry and maximum observations. Saving verifies a source manifest but does not count that read as an outcome. Review the exact draft hash. Commitment reserves a database timestamp before fetching fresh initial evidence. Successful initial evidence is bound into the commitment. The initial rule holds; every subsequent deterministic prefix decision is persisted before the next capture may begin.

The configured RPC must be mainnet and have the correct genesis. No client-supplied RPC, price, time or tape is accepted. Pool/config/mints/vaults come from one finalized getMultipleAccounts context; ownership, discriminator, layout, mint initialization/decimals, vault PDAs and custody, activation and lifecycle are checked. DBC requires the canonical config-bound pool PDA and an active unfinished curve. DAMM v2 requires positive liquidity and enabled non-compounding state. SPL Token only, mint decimals 0–12; Token-2022/extensions and compounding pools fail closed.

## Exact marks and hypothetical actions

DBC VirtualPool sqrtPrice offset 280; DAMM v2 Pool offset 456, u128 little-endian Q64. A/base as token gives quote atomic per token atomic = sqrtPrice² / 2^128. B as token inverts that rational. Whole-unit price additionally scales by 10^(tokenDecimals − quoteDecimals). Reserves are never substituted for spot price. Installed reference IDLs: DBC SDK 1.5.13 and cp-amm SDK 1.5.1.

After a captured mark, the fixed-bound rule may hypothetically rebalance at that same decision mark to equal token/quote value. This is an accounting convention, not a claim of available execution. Fee plus slippage basis points are quote-notional costs rounded down. No liquidity, volume, MEV, fills or earned fees are modeled. The next observation cannot affect an earlier proposal. Hold uses identical initial inventory; cost-free all-token benchmark converts initial equity at the initial mark with integer rounding.

## Manual windows and evidence

Minimum 60-second spacing, 2–48 observations including initial, maximum seven-day expiry, 30–300-second source age, six drafts and 96 capture attempts per owner per UTC day, two simultaneous reads. Finalized slots and source block times must increase. Duplicate cached slots do not become new observations. Gaps and delayed windows remain visible; no interpolation or historical backfill. Migration, identity or mint-unit changes end the segment incomplete. End, expiry and failures preserve evidence; retries use fenced leases and durable request identity.

Autopsy compares observed hypothetical accounting, costs, inventory effects and residuals. Drawdown and in-range percentages are sampled, not continuous. Coverage counts requested on-time windows; partial prefixes are not completed scores. Current agent-version changes are shown without changing frozen rules. Notes append only and become public when explicitly shared.

## Replay and trust

Exports include raw bounded account bytes, source manifests, frozen settings and digests, proposals, observations, events and accounting. The strict new versioned verifier recomputes decoding, source/commitment/prefix/time/history hashes and hypothetical inventory. It rejects malformed, duplicate-key, unknown-version, oversized and inconsistent evidence. It does not prove RPC authenticity, historical timestamp truth, finality, chain execution or AI performance. Existing synthetic Shadow Season exports retain their original version and semantics.
