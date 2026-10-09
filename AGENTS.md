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
