# Architecture

```text
 Browser                         Server                         Outside
 ───────                         ──────                         ───────
 UI (React)  ── typed commands ─► domain rules ─► cloud database (row-level security)
 PQ key (memory + backup)        scheduler ──► agent cycles
 Wallet (Phantom/Solflare) ◄──── unsigned tx ◄── Meteora DBC SDK ──► Solana mainnet RPC
                                 pinning ─────────────────────────► IPFS (Pinata)
```

* **Frontend** — TanStack Start (React 19), Tailwind CSS v4.
* **Domain logic** — pure, tested rule functions that validate before mutating anything.
* **Database** — PostgreSQL with row-level security: public read for the ecosystem, owner-scoped control.
* **Scheduler** — a cron job calls an authenticated endpoint to run agent cycles.
* **Chain** — Meteora Dynamic Bonding Curve SDK (program `dbcij3LWUppWqq96dh6gJWwBifmcgFLSB5D4DuSMaqN`), DAMM v2 graduation, SPL Memo for identity anchoring.
* **Post-quantum** — ML-DSA-65 (FIPS 204) in the browser.
* **Storage** — immutable IPFS pinning via Pinata for passports and token images.

The garden talks to a `ChainAdapter` seam that is virtual today; the launchpad is a separate, real on-chain path.

## On-chain pages are separate from garden loading

`/identity`, `/launchpad`, `/launch-config`, `/verify`, `/passport/<hash>`, `/t/<mint>`, `/pollen` and `/botanist` render even if the Garden store fails to load. They have their own chain, wallet and service checks. Their top bar reads **On-chain · real assets**; the sidebar workspace still labels its **Garden virtual balance** as vSOL, not real SOL.

## Shared proofs and portable evidence

Public verification, launch confirmation and portable evidence verification reuse a strict DBC create-instruction validator. It checks the decoded terms, canonical accounts and required signatures; current creator changes are observed separately from original authorship. Living observations are append-only; the original signed passport remains immutable. The standalone browser/CLI verifier reads caller-selected RPC and IPFS sources without querying fleuri's database.

## Pollen and Botanist

Pollen uses Meteora Dynamic Fee Sharing vaults and the program's Q64 `feePerShare` checkpoints for claimable balances, with simulation and wallet approval before transactions.

Botanist separates payment orchestration (`src/lib/botanist-flow.ts`) from report generation (`src/lib/botanist-report.ts`). Durable jobs freeze payment terms and settlement candidates. x402 V2 exact settlement uses a per-job idempotency key; delivery checks the accepted message hash and canonical USDC credit. Generic header retries and UI resume both require a private capability checked against its stored hash. Public memos never authorize retrieval, and the raw capability never goes to the facilitator.

*Built with Codex.*
