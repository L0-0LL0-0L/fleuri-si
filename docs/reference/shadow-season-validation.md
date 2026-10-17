# Shadow Season v1 validation

Checked 2026-10-17. Nothing published, deployed, signed or transferred.

## Delivered

- `src/domain/shadow.ts`: bounded deterministic integer inventory engine, same-inventory hold control, all-token benchmark, cost decomposition, rule-based autopsy and strict offline verifier.
- `src/lib/shadow.server.ts` and `shadow.functions.ts`: authenticated ownership/version checks, durable request identity and frozen evaluation.
- `src/pq/sql/0026_shadow_season.sql`, `0027_shadow_review_guards.sql`, `0028_shadow_history_ceiling.sql`: applied private persistence, service-only coordination, seed confidentiality, append-only history, leases and history ceilings. Source SQL matches the applied migration files byte-for-byte.
- `/shadow-season` and `/shadow-season/$id`: drafts, review/commit, evaluation, autopsy, annotations, explicit sharing, export and local replay; navigation, My agents and Graft context links.
- `docs/garden/shadow-season.md`: assumptions and trust limitations.

## Evidence

- Full regression suite: **64 files, 550 tests passed**, maximum two workers.
- Shadow domain/SQL coverage: exact no-op and trade accounting, conservation, missing marks, supported bounds, version changes, owner and column permissions, private/share RLS, concurrent retries, expired lease fencing, UTC six-season quota, immutable results, adversarial bundles and repeated no-op history protection.
- Latest automatic preview type/build signal: **build OK**, 2026-10-17 12:32:39 UTC. No manual build was run.
- Authenticated browser journey used an app-created disposable zero-funded workspace agent, not an unrelated existing account: save/edit → commit → evaluate → autopsy → append annotation → export → local replay PASS → public read-only share → revoke → signed-out denial.
- Completed test season: `82b3fa74-f451-474d-98a0-20b19f25f81d`; evaluation finished and sharing revoked. Immutable evidence was not deleted.
- Desktop 1280×1800 and mobile 375×812 checked; no horizontal page overflow or page errors. Reduced-motion comparison animation computed as `none`.
- QA screenshots, replay JSON and logs are temporary sandbox artifacts under `/tmp/browser/shadow/` and `/tmp/browser/shadow-final/`.

## Explicit limits

This release supports hold and fixed-range inventory rebalancing over server-held synthetic hourly marks. It does not simulate liquidity provision, real DLMM execution, earned fees, AI performance or forward market observations. Graft references are owner notes, not verified authority or provenance. Hashes prove replay consistency, not historical authenticity. No scheduler, real-money operations, model narrative or staking changes were added. Production publication and production-domain QA were deliberately not performed.