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
- Real-money paths go through `ChainAdapter` (`src/services/chain.ts`) and stay sandbox-only until genuine Fleuri program/mint config exists — prevents fake on-chain claims.
- All colors/fonts come from tokens and `@utility` classes in `src/styles.css`; flower motion is CSS keyed to a wall-clock `--fl-delay` so every tile sways in phase.
