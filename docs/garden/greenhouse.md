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

## Hardening (engine greenhouse-rules-2)

- **Exact NLV.** Net liquidation value now matches what the engine's full sell actually pays, including the creator's half of the sell fee when the participant created that coin. Frozen market coins have no participant creator, so they get no rebate. Example: with 100 vSOL cash, buying 10 vSOL of a 30 vSOL / 1.073b curve leaves NLV ≈ 99.9005 if you created the coin and ≈ 99.801 if someone else did. Results changed, so the engine is now `greenhouse-rules-2`. Reports made with `greenhouse-rules-1` still download exactly as stored, but this build shows them as **unsupported** and won't replay them.
- **Leases.** Only one worker can compute a trial at a time. Starting a trial takes a per-workspace lock, applies the 30-per-hour and 2-running limits atomically, and gives a private lease token to just one caller. Retrying while the lease is held returns *running* and does not recompute. An expired lease is renewed with a new token, up to 3 attempts; recovery also counts against the 2-running limit and is refused (attempts and old lease untouched) while two other trials are active. Saving a result or a failure needs the current token, so a stale worker can't overwrite a newer attempt. A failed trial stays failed. Re-saving an identical result is harmless, and a different result is refused.
- **Recovery.** A retry first looks up the stored request. It never reads live agents or the live market, so recovery still works after an agent is deleted. Reusing a request id with different settings is refused. Stored inputs keep their own engine version, and their checksum is checked before anything is recomputed.
- **Integrity.** A downloaded bundle carries the original saved input, output and content checksums, and replay checks all three. Any edit to stored data is flagged; checksums are never regenerated. Checksums detect changes. They are not signatures and don't prove who made a report.
- **Session privacy.** Unfinished trials are saved per workspace in the browser. Switching workspaces clears trials, history, evidence and frozen reviews on screen, and late replies meant for the previous workspace are ignored.
- **Frozen review.** "Use this draft" takes a snapshot of the evidence and its status at that moment, with a timestamp. The same snapshot appears while you review, sign with your PQ key and approve in your wallet. It stays advisory and is never part of the signed passport.
