# Forward Watch validation

## Additional root review, 2026-10-18

- Per-RPC deadlines: 10 seconds including response body; total capture: 40 seconds from the reservation timestamp, below the 45-second evidence bound and 60-second lease. Abort/sanitized failures are tested, including stalled bodies and sequential calls.
- Applied migration 0032 blocks enabling sharing, annotations and edits at 240 events, retaining completion/end/revocation headroom. A legacy already-full 256-event history permits Make private without appending another event; history remains bounded, and public RLS access is revoked. New histories retain revocation events normally.
- Strict replay derives terminal status from events/counts/schedule; rejects duplicate terminal events, premature expiry, capture before initial committed event, lease/spacing violations and rehashed inconsistent failure/status history.
- New mainnet owner browser journey: commit, second capture after a legitimate wait, autopsy, browser/CLI replay PASS, signed-out read-only share, mobile reduced-motion/no overflow, revocation denial and ended-private evidence preserved. Slots 458508736 → 458509045. Screenshots/evidence/logs: `/tmp/browser/forward-root-review/`; no page errors.
- Full regression run at 16:56:52 UTC: 67 files, 601 tests passed, max two workers. Final retry-spacing test was added afterward and is included in the closing regression run. Automatic preview build was OK at 16:54:27 UTC. No publication, funds or signing.

Checked 2026-10-18; resumed baseline `d54c2b50ef6929ca083e95bc26d530eb081843dc`, validation checkpoint `c14c5decb972c3df2fb96b1e2689746e5c275e52` before final documentation/timing-label edits. No publication, deployment, signing or transfers.

## Delivered and checks

- Separate rational atomic engine, frozen prefix decisions, hold/all-token controls, partial autopsy, strict source/history replay. Private hub/notebook, authenticated review/commit/manual captures, append-only notes, read-only sharing/revocation, browser and CLI verifier.
- Applied migrations 0029/0030/0031: private RLS/service-only coordination, bytewise canonical hashing, frozen-prefix checks, retry fencing and server-derived completion. Source 0030/0031 matches applied bytes; 0029 differs only by final newline. Public reads use sharing RLS, not privileged reads. Shadow v1 unchanged.
- Full suite: **66 files / 591 tests passed**, maximum two workers; 16:47:57 UTC, 117.86 seconds. Coverage includes exact math, custody/lifecycle, no-lookahead, conservation/costs, rehashed-history attacks, ownership/privacy/grants, quotas/races/retries/leases and spacing.
- Automatic preview signal **build OK** at 16:50:00 UTC; no manual project build/typecheck run.
- Mainnet browser commit and second capture after legitimate 62-second wait: slots **458504708 → 458505022**; fetch times **16:40:43.885Z → 16:41:52.211Z**; decisions **16:40:44.106Z → 16:41:52.348Z**. First decision precedes next request. Immediate capture correctly failed minimum spacing.
- FLEURI DAMM pool `5FPETPV195D3EiDZTBWa2JcYUShgWbUpaautLudFgMZ6`, decimals 6/9 against wSOL. Mark `6451996972198764874074413132411761 / 85070591730234615865843651857942052864` quote atomic/token atomic.
- Downloaded ended evidence passed browser and CLI replay; signed-out sharing and revoked private denial passed. QA watches ended privately with evidence retained.
- Desktop 1280×1800/mobile 375×812, no horizontal overflow/page errors; reduced-motion chart animation `none`.
- Evidence: `/tmp/forward/final-full-suite.log`, `/tmp/forward/review-browser.log`; `/tmp/browser/forward/final-second.png`, `final-public-desktop.png`, `final-owner-mobile.png`, `final-verifier.png`, `ended-evidence.json`. Session files are private, never deliverables.

## Formulas and gaps

DBC SDK 1.5.13/cp-amm SDK 1.5.1 IDLs: Q64 u128 sqrtPrice at offsets 280/456. A-as-token mark = sqrtPrice²/2^128 quote atomic/token atomic; B-as-token inverts it. Whole-unit scaling is 10^(tokenDecimals−quoteDecimals). No reserve-based marks. Active unmigrated DBC and enabled noncompounding SPL Token DAMM only.

Proposals use the already observed prefix/decision mark; hypothetical balances/costs are valued at the next observation. The terminal proposal stays pending. No actual fills, LP fees, AI performance or scheduler claims.

RPC/server time remains trusted; hashes do not prove historical authenticity/finality/chain execution. DAMM Pool retains no config key: original config-bound creation PDA/transaction provenance is not independently proved, while program ownership/discriminator/pair/vault PDAs/custody/lifecycle are checked. Live DBC browser capture was not tested because FLEURI migrated; DBC paths have fixture tests. QA used an app-created disposable zero-funded owner workspace, not a preexisting named owner. The two-observation watch ended partial; no completed long-duration score is claimed.
