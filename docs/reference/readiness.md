# Readiness & activation

Implemented features and a live, usable service are not the same thing. Always use the feature's current readiness checks rather than a historical screenshot or security-scan result.

## Real launches

The launchpad requires the intended Solana cluster, matching RPC genesis, deployed Meteora programs, an eligible on-chain DBC config and immutable IPFS pinning. The operator configuration uses `SOLANA_CLUSTER`, `SOLANA_RPC_URL`, `METEORA_DBC_CONFIG`, `PINATA_JWT` and the final `FLEURI_ORIGIN`. Private credentials must never be committed to GitHub or included in these docs.

The owner also needs an unlocked, registered PQ identity and a connected wallet with real SOL for network and account-creation costs. All live readiness checks must pass before launch. A confirmed end-to-end wallet-signed launch is a separate acceptance step; preview tests alone do not prove it happened.

## Paid Botanist reports

Checkout requires a valid operator-supplied **public payout wallet address** (`BOTANIST_PAY_TO`) and that wallet's existing mainnet USDC associated token account. It also checks the fixed price, mainnet RPC/genesis, Circle USDC mint and facilitator support. Until those checks pass, checkout stays unavailable; no substitute recipient is chosen automatically.

The default report price is **0.50 USDC**. Missing payout configuration does not prevent free passport verification, documentation or code tests.

## Pollen Staking

The [staking interface](../launchpad/pollen-staking.md) is implemented, but **no staking program is deployed and no verified fee routing is configured**. Deposits stay blocked until the independently reviewed deployment and configuration pass live checks: actual mainnet cluster/genesis, fresh RPC, executable non-placeholder program, matching configured code hash, correct initialized FLEURI mint with revoked mint/freeze authorities, initialized pool, full principal/reward custody checks and the exact Pollen PDA recipient index.

The badge shows the latest read's actual cluster, not an assumed network. Portfolio reads share one confirmed slot and chain clock; stale snapshots or failed reads disable actions. Refresh and foreground polling update accrued rewards. Exits and reward claims use their own readiness checks and do not depend on optional fee-source or mint-authority deposit checks.

A matching configured code hash is not proof of an independently reproducible build. The existing $FLEURI pool's immutable partner fee claimer does not name this Pollen vault; a separately reviewed, owner-approved creator-fee option is unimplemented. See [deployment blockers and acceptance steps](../launchpad/pollen-staking.md#real-blockers-before-mainnet).

## Pending transactions

Use **Check confirmation** for an already signed launch, config or migration. Fleuri checks whether the exact transaction landed and records the result. A pending entry is not proof of failure or success. Do not sign a replacement merely because confirmation was interrupted.

Staking recovery also appears directly on `/staking` for the signed-in owner. It checks confirmation or resends the exact saved signed bytes, without building a replacement.

## Security and publication

Security findings must be reviewed against current code and database permissions. Public garden activity, passports, identity proofs and published vault records are intentional; private challenges, preparations, payment jobs and retrieval capabilities are not public datasets. Do not dismiss findings merely to publish. This documentation update does not rescan, publish, change settings or broadcast any transaction.