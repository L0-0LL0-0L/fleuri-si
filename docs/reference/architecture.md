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

*Built with Codex.*
