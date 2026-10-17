# Shadow Season & Decision Autopsy

Private synthetic inventory research. No trading, liquidity provision, payments, staking changes or authority delegation.

## Before outcomes

Choose your own agent/version, virtual inventory, strategy, scenario, 8–96 hourly rounds, bounds, costs and expectations. Save/edit a draft, review its exact hash, then commit. The server timestamps commitment; subsequent edits are rejected. Changes to the current agent version are shown separately. Frozen evaluation never silently adopts a new policy.

The database generates a random seed at creation and publishes its commitment hash. The preimage/tape are not exposed before commitment and completed evaluation. The server knows the seed; this is not trustless randomness, chain timestamps or historical authenticity. All scenarios are explicitly synthetic. No prospective observation mode or scheduler is implemented.

## Modeled rules

- Six-decimal integer token/quote accounting; initial mark 1.000000.
- **Hold:** no actions. The control always starts with exactly the same inventory.
- **Range-triggered inventory rebalance:** fixed bounds relative to the initial mark. Outside the bounds, rebalance hourly toward 50% token value. Inside, hold. This is not a virtual LP or DLMM fill model.
- Trade fee and slippage are reviewed basis-point costs, summed on executed quote notional and rounded down. No volume, liquidity, execution uncertainty, MEV or earned fees are modeled.
- All-token benchmark converts initial inventory value at the initial mark without costs; it is distinct from hold.
- Maximum drawdown uses marked hourly equity. Time in range counts post-initial hourly marks, not intrahour continuous price paths.
- Versioned rising/falling/flat/mixed/breach shocks replay from the revealed seed. Missing marks produce incomplete, not successful, results.

Every synthetic hourly decision records action, amount, notional, costs, balances, equity and both controls. One frozen rationale/expectation applies to the rule's decisions. Synthetic indices are not market-trade timestamps.

## Autopsy

Expected excess and time in range compare against exact outcomes. Excess versus hold decomposes into inventory timing contribution minus quote costs plus an explicit atomic rounding residual. Range breach, inventory timing loss, cost drag and missed expectations appear only when their accounting evidence supports them. Attribution is not a causal market explanation or evidence of AI performance. Fees earned are always zero in this model.

## Storage, privacy and replay

Six new seasons per owner per UTC day; two concurrent evaluations with 60-second leases. Retries recover stored frozen inputs. Owner version/ownership checks and mutation ACLs are authoritative server/database boundaries. Full agent prompts are not exported; only digests. Completed notebooks may be explicitly shared read-only, then made private again. Owner notes become public when shared: never include secrets.

Append-only timestamped events preserve creation, draft edits, commitment, evaluation, completion, sharing and annotations. No deletion or result editing exists. Annotations never rewrite facts. Evidence references are unverified owner notes, not automatic Graft/evidence permission promotion.

Exports include frozen version/assumptions, commitment, revealed seed/tape, decision trace, benchmark/result/autopsy, event hash chain and content root. Strict local verification rejects duplicate keys, unknown fields/versions, nonfinite values, oversized resources and altered commitments/tape/accounting/history. Checks prove internal consistency only, not authenticity, trustworthy timestamps, signatures, chain execution or model attestation.