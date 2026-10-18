<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Domain logic lives in `src/domain/` as mutate-a-draft functions that throw `DomainError` before mutating; the server runs them (src/lib/garden.server.ts) and the UI only sends typed commands via `GardenStore.cmd` — keeps validation/ownership in one testable place.
- Cloud is the source of truth: all writes go through the service-role-only `garden_commit` RPC with optimistic versioning, and `cycle_runs(agent_id,bucket)` uniqueness stops duplicate cycles; clients read via public/owner-scoped RLS — keeps funds atomic and owner-checked.
- Scheduled cycles hit `/api/public/garden/tick`, authenticated by a server-only secret header (the browser key is not enough) — the browser key is public.
- Garden agent balances and trading remain virtual through `ChainAdapter`. The separate PQ launchpad uses real Meteora DBC SDK transactions, gated by cluster/genesis, config and pinning readiness; no Fleuri custody program is required for provenance. Never label a pending signature or migration flag as a verified launch or DAMM v2 pool.
- PQ private keys stay in browser memory and encrypted backups. Owner writes go through authenticated server functions and service-role-only atomic RPCs. Persist signed transaction bytes before broadcast; retries must keep the exact message and signature. Public verification must re-check dual registration signatures, Memo anchoring, all signed config terms, confirmed transaction, mint authorities and immutable pinned metadata.
- All colors/fonts come from tokens and `@utility` classes in `src/styles.css`; flower motion is CSS keyed to a wall-clock `--fl-delay` so every tile sways in phase.

- Meteora DBC configs are created through `/launch-config` as an owner-reviewed, wallet-signed `chain_preparations` kind `config`; the config key is browser-generated and confirmation compares the on-chain account to the reviewed draft — no custodial wallet or silent recipient.
- The client build must never stub Node builtins: rolldown's native resolver externalizes `node:buffer` before `resolve.alias` applies, so `vite.config.ts` pins `buffer`/`node:buffer` to the real feross `buffer` package with a build-only pre `resolveId` hook (dev pre-bundles `buffer` via optimizeDeps, because the raw CommonJS file has no ESM export) — without it safe-buffer/bs58/Solana SDK crash on hydration in production. The same hook pins buffer's CommonJS-only deps `base64-js` and `ieee754` (otherwise the Worker throws `No such module` and breaks identity registration) and pins `bigint-buffer` to its `dist/browser.js` build, because rolldown misses its `browser` field mapping and the Node entry crashes the browser bundle with `__filename is not defined` when signing.
- Browser code must not import `@solana/spl-token`, because `spl-token-metadata` touches a global `Buffer` at import and breaks hydration. Use the tested minimal helpers in `src/pq/botanist.ts`.
- Greenhouse Trials run pure `src/domain/greenhouse.ts` over the shared `runCycle` with one frozen market per participant and a seed-only shock tape. Runs use service-role fenced `greenhouse_*_lease` RPCs (per-owner serialized, lease holder computes, failed is terminal); `ghStart` restores stored inputs before reading the live garden; exports keep original checksums; result changes bump `ENGINE_VERSION`; browser state is owner-fenced — keeps runs reproducible and workspaces isolated.

- Blind Bloom (`src/domain/bloom.ts`, `src/lib/bloom.server.ts`, SQL 0020): sealed v1 manifests change only engine-used settings; seed is generated and committed in SQL; secrets stay out of column grants until `bloom_claim_eval` reveals them after the `bloom_now()` deadline; evaluation is lease-fenced over stored frozen inputs; bundles are built from public columns only — keeps rounds replayable and pre-deadline strategies confidential.
- Botanist (x402) payment rules live in `src/lib/AGENTS.md`; Pollen, staking, receipts, observatory, watchtower and access rules live in `src/pq/AGENTS.md`. Subdirectories have their own `AGENTS.md` to read before changing files there.
- Graft research steward (`src/domain/graft.ts`, `src/lib/graft.server.ts`, SQL 0022/0023/0025): mandates freeze a draft + full agent version (DB digest and server code version); writes are service-role `graft_*_v2` RPCs that recheck owner, status, expiry, version and evidence freshness under mandate-then-job locks; reports/incidents/events are append-only and incidents store replayable gate snapshots; purchases are proposals only; draft/proposal retries match a stored request-body hash; evidence age is the oldest observation fetchedAt; supporting Bloom/receipt evidence is policy-only, attachable only to drafts and bound into the approval proof — keeps authority bounded, read-only and auditable.

- Shadow v1 stays unchanged. Forward Watch uses rational replay, finalized account evidence and fenced capture with decisions saved before the next read; browser/CLI share one verifier, public reads use sharing RLS — prevents lookahead/private disclosure; hashes prove consistency only.
