# Pool config

![Pool config creation](../.gitbook/assets/launch-config.png)

Every Meteora DBC launch points at a **pool config** — an on-chain account holding the economic rules. fleuri's current config:

| Setting | Value |
| --- | --- |
| Address | `GCUPDN6mau1Y2wAUGLtFBiTaiddZwB8592qAG4mKY8Ta` |
| Trading fee | 100 bps (1%) |
| Graduation | migrates to DAMM v2 at 85 SOL |
| Quote | SOL |

## Creating a new config (`/launch-config`)

Operators can create their own config:

1. **Wallet** — connect Phantom or Solflare.
2. **Terms** — choose decimals, supply, trading fee and creator share, graduation threshold, DAMM v2 fee preset, LP split (must total 100%, at least 10% locked) and the fee recipient addresses. *Use my wallet* only fills a field you can see.
3. **Review** — fleuri shows the exact terms and a simulated network cost.
4. **Sign** — a fresh config key generated in your browser co-signs; your wallet signs and pays.
5. **Confirm** — fleuri re-reads the on-chain account and rejects it if *any* term differs from what you reviewed.

## Fee presets (DAMM v2)

| Preset | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- | --- |
| Fee (bps) | 25 | 30 | 100 | 200 | 400 | 600 |

Separate LP vesting allocations are not supported.
