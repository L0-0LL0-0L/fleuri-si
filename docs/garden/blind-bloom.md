# Blind Bloom

Blind Bloom is a challenge arena that runs before any token bonds. It uses the same frozen, deterministic Greenhouse engine. Owners **seal** a strategy for one of their own agents before a hidden stress seed is revealed. After the deadline everyone can recompute the same results.

## How a round works

1. **Round opens.** The server freezes one public garden market and fixes the rules: scenarios, repetitions, cycles, forecast events, scoring rule and compute budget. The database's random generator creates a 64-hex seed. Only its SHA-256 commitment (`fleuri.bloom.seed.v1`) is published.
2. **Commit phase.** You choose one of your own agents and seal a v1 strategy manifest:
   - **Sealed settings:** archetype and risk. The rules engine really uses these to set its trade weights and position sizes; they are not decorative text.
   - **Forecasts:** integer percentages for each fixed event (beats buy & hold, beats its own base policy, ends in profit, drawdown over 15%).
   
   The server freezes your agent's current saved policy as the base and adds a random salt. It then publishes a domain-separated commitment over the round, agent, base policy hash, manifest and salt. Retries with the same request id return the same entry. A different body is refused, and so is a second entry for the same agent and policy version.
3. **Reveal.** When the deadline passes on server time, the first view of the round reveals the seed and every sealed preimage. One fenced worker then evaluates the round. Retries reuse the stored frozen inputs, never the live market. After three expired attempts the round is marked failed. Failures are published along with the seed and every commitment.
4. **Scores.** Each entry runs three ways on the same frozen market and hidden tape: with its sealed settings, with its unchanged base policy (same agent randomness), and against buy & hold. For every scenario we show the paired differences, wins out of n, drawdown, attempts, rejections and faults. Forecasts get a Brier score; always guessing 50% scores 0.25. Ranking is fixed: mean paired return vs buy & hold, then lower Brier score. Sample counts are always shown; no confidence intervals are claimed.

## Evidence bundles

Download a bundle from any round page. It contains only public columns. Before the deadline that means the commitments only; afterwards it also includes the revealed seed, preimages, outputs and checksums. Verify it in the browser or offline:

```
bun scripts/verify-bloom.ts blind-bloom-round-1.json
```

The verifier rejects:
- unsupported versions
- duplicate keys, non-finite numbers, truncated files and files over 3 MB
- unknown fields, duplicate entries and reordered entries

It recomputes the seed and submission commitments, the rules and market hashes, every scenario, comparison and score, and the content hash.

## Trust model and limits

- **Server-mediated prototype.** Fleuri's server generates the seed and stores sealed strategies so it can always reveal them. A dishonest operator could know the seed early. Commitments only show that nothing changed after they were published.
- **Not on chain.** Database timestamps are not blockchain timestamps. This is not trustless and not an attestation of how any model ran.
- **Sandbox only.** Results come from the virtual bonding-curve model with vSOL. It does not reproduce Meteora DBC or DLMM pools or real markets, and no profits are promised.
- **Free and bounded.** Entry is free and needs no staking: 3 entries per owner per round, 10 per day, and at most 16 entries per round.
- **Human review stays.** You can link a scored entry as evidence for a launch proposal, but only when the same agent drafted that proposal with the same policy version. Linking never approves anything.
- **No PQ signatures yet.** Optional ML-DSA signing of commitments is not wired into this version.
