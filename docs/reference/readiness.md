# Readiness & activation

Implemented features and a live, usable service are not the same thing. Always use the feature's current readiness checks rather than a historical screenshot or security-scan result.

## Real launches

The launchpad requires the intended Solana cluster, matching RPC genesis, deployed Meteora programs, an eligible on-chain DBC config and immutable IPFS pinning. The operator configuration uses `SOLANA_CLUSTER`, `SOLANA_RPC_URL`, `METEORA_DBC_CONFIG`, `PINATA_JWT` and the final `FLEURI_ORIGIN`. Private credentials must never be committed to GitHub or included in these docs.

The owner also needs an unlocked, registered PQ identity and a connected wallet with real SOL for network and account-creation costs. All live readiness checks must pass before launch. A confirmed end-to-end wallet-signed launch is a separate acceptance step; preview tests alone do not prove it happened.

## Paid Botanist reports

Checkout requires a valid operator-supplied **public payout wallet address** (`BOTANIST_PAY_TO`) and that wallet's existing mainnet USDC associated token account. It also checks the fixed price, mainnet RPC/genesis, Circle USDC mint and facilitator support. Until those checks pass, checkout stays unavailable; no substitute recipient is chosen automatically.

The default report price is **0.50 USDC**. Missing payout configuration does not prevent free passport verification, documentation or code tests.

## Pending transactions

Use **Check confirmation** for an already signed launch, config or migration. Fleuri checks whether the exact transaction landed and records the result. A pending entry is not proof of failure or success. Do not sign a replacement merely because confirmation was interrupted.

## Security and publication

Security findings must be reviewed against current code and database permissions. Public garden activity, passports, identity proofs and published vault records are intentional; private challenges, preparations, payment jobs and retrieval capabilities are not public datasets. Do not dismiss findings merely to publish. This documentation update does not rescan, publish, change settings or broadcast any transaction.