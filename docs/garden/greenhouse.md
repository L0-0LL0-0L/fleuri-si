# Greenhouse Trials

Greenhouse Trials are controlled stress tests of garden agents. Every result is a **vSOL sandbox stress model**. It is not Meteora mainnet execution, not a forecast, not a safety rating and not an approval.

## What a trial does

1. You pick 1–4 agents, a seed, 1–5 repetitions, 5–60 cycles and any of four scenarios.
2. The server freezes one sanitized copy of the public garden market. That copy holds coin reserves only: no owners, wallets, ledgers or balances. It also freezes each agent's policy (archetype, risk, strategy, persona) along with a SHA-256 policy hash.
3. Each agent gets exactly 10 vSOL, no holdings and **its own copy** of that frozen market. The order you pick agents in, and which other agents are in the trial, cannot change any agent's result.
4. Agents act through the garden's actual scheduled rules engine (`runCycle` and the same bonding curve). That engine decides from **archetype and risk only**. Strategy and persona text are recorded but not evaluated. No AI is called and no credits are spent.
5. A buy-and-hold baseline runs under the same market, fees and shocks. It splits 10 vSOL equally across the 3 deepest coins at the first cycle without an injected fault, then holds.

## Scenarios

| Scenario | External tape |
| --- | --- |
| Control | none |
| Liquidity shock | 15%/cycle: 20–50% of one coin's reserves are withdrawn. The price stays the same and the market gets shallower. |
| Sell pressure | 30%/cycle: an outside seller removes 3–10% of one coin's vSOL reserve. |
| Execution failures | 35%/cycle: any buy/sell/launch is rejected and fully rolled back. |

Shocks come from a separate random stream seeded only by seed, scenario and repetition. Every participant meets the same shocks.

## Metrics

- **Net liquidation value (NLV)**: cash plus the vSOL you would get by selling each position into its current curve, after the 1% fee and price impact.
- **Return**: (final NLV − 10) / 10. **Max drawdown**: the largest fall from a running NLV peak.
- **Attempts**: only buy, sell and launch decisions. **Success rate** = successes / attempts, or *unavailable* when there were 0 attempts.
- **vs baseline**: the agent's return minus the baseline return, paired per repetition. Scorecards show mean, min, max, standard deviation and n.

## Saving, replay and sharing

- Trials are saved to your workspace and private by default. **Publish report** makes a sanitized read-only page at `/greenhouse/r/<id>`. **Make private** hides it again.
- Retrying or reloading re-uses the same request ID, so you get the original frozen run back. A trial stuck "running" is retried at most 3 times, then marked failed. Limits are 30 trials per hour and 2 running at once.
- **Download evidence bundle** exports the inputs, outputs and hashes. **Replay & verify** (or "Verify a bundle file") re-runs the frozen inputs on a synthetic clock and compares exact hashes. Edited results, configs or inputs are flagged. Bundles from older engine versions show as *unsupported*.
- Checksums detect edits. They are not signatures, and nothing is anchored on chain.

## Launch proposal evidence

New proposals record the drafting agent, its policy hash and the mode (rules/AI). Older drafts show *unknown*. On the launchpad you can attach your own completed trial if it includes that agent. The attachment is private to you. Each item shows:

- whether the policy matches the draft, differs from it, or is unknown;
- whether the agent is unchanged or *stale* (edited since the trial);
- the engine version and the sample size.

Loading a draft freezes the evidence for that review. Evidence is advisory only. It never starts a launch, changes a passport or skips your PQ signature and wallet approval.
