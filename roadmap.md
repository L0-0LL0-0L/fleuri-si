# Roadmap

- [x] Mainnet launchpad, pool config, Pinata, METEORA_DBC_CONFIG verified
- [x] Living passports: dated observations, append-only history, evidence bundle export
- [x] Standalone bundle verifier (browser direct RPC + CLI) with fixture tests
- [x] Pollen: Meteora DFS vault create/fund/claim/inspect/import, token-page association, DBC partner-fee routing eligibility
- [x] Pollen claimable from feePerShare checkpoint (Q64 rounding)
- [x] Botanist: x402 V2 endpoint, PayAI facilitator adapter, job state machine, recovery, receipts, report, wallet checkout page
- [x] Migration: deny anon/authenticated TRUNCATE/writes on new tables + tests
- [x] Tests, typecheck, build, browser smoke; docs/GitBook update
- [x] Refresh GitBook docs for capability-safe payments, strict proofs, report statuses and on-chain page isolation
- [x] Record the $FLEURI contract address in the GitBook docs (token pages, README, glossary) with its true on-chain status
- [x] CA button in the top bar of every page: press to reveal and copy the $FLEURI address, with its live status and the independent-verification warning
- [x] $FLEURI confirmed live on a Meteora bonding curve (mainnet) — token page, CA panel and docs state live figures and that it was not launched through fleuri's launchpad
- [x] Pollen Staking: Anchor program source, accounting + SBF program tests (with real DFS bytecode), IDL, client, /staking page, prepare/sign/recover flow, docs
- [ ] Pollen Staking deployment: deploy keypair, verified build hash, DFS vault naming the pool PDA, routed fee source — waits on owner
- [ ] BOTANIST_PAY_TO public payout address — waits on owner (asked at the end)
