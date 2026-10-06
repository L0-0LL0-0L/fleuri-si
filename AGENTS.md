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
- Domain logic lives in `src/domain/` as mutate-a-draft functions that throw `DomainError` before mutating; UI calls them only via `GardenStore.act` — keeps validation/ownership in one testable place.
- Persistence goes through the `GardenRepository` interface (`src/services/repository.ts`); the local adapter is a browser-only fallback and a cloud adapter must replace it, not wrap UI code — keeps the cloud swap isolated.
- Real-money paths go through `ChainAdapter` (`src/services/chain.ts`) and stay sandbox-only until genuine Fleuri program/mint config exists — prevents fake on-chain claims.
- All colors/fonts come from tokens and `@utility` classes in `src/styles.css`; flower motion is CSS keyed to a wall-clock `--fl-delay` so every tile sways in phase.
