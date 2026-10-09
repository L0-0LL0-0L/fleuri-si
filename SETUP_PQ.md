# Fleuri PQ launchpad — setup, flows and limits

The launchpad prepares **real** Meteora Dynamic Bonding Curve (DBC) transactions on the Solana
network named in the readiness panel, and binds every launch to an independent post-quantum
(ML-DSA-65, FIPS 204) passport that anyone can verify. It is **provenance**, not quantum-safe
custody: wallet funds and Solana signatures remain ordinary Ed25519.

## Server-only settings

All of these are read inside server code (`src/lib/solana.server.ts`), never in `VITE_` variables.

| Setting | Status today | What it does |
| --- | --- | --- |
| `SOLANA_CLUSTER` | `mainnet-beta` | Must be `devnet` or `mainnet-beta`. Selects the expected genesis hash and the explorer links. |
| `SOLANA_RPC_URL` | configured | Read at request time and verified against the cluster genesis. A mainnet URL under `devnet` (or the reverse) fails readiness instead of silently launching on the wrong network. |
| `METEORA_DBC_CONFIG` | **not set — launch blocked** (create one at `/launch-config`) | Address of a DBC pool config: SOL quote, DAMM v2 migration, immutable metadata, fixed supply, revoked mint/freeze authorities, LP shares totalling 100%. Its full snapshot is hashed and signed into every passport. |
| `PINATA_JWT` | **not set — launch blocked** | Pins the signed passport and token image so the metadata URI committed on chain is immutable. |
| `FLEURI_ORIGIN` | `https://fleuri.si` | The origin written into registration challenges and passports. Set this to the real public domain before any launch. |
| `METEORA_DAMM_V2_CONFIG`, `IPFS_GATEWAY` | optional | Graduation config override; read gateway (default `https://gateway.pinata.cloud/ipfs/`). |

Current readiness: cluster, RPC genesis and the DBC program all pass on mainnet-beta; the pool
config and pinning checks fail, so launch review stays disabled. That is a truthful block, not a
placeholder.

## Creating the pool config (`/launch-config`)

Connect Phantom or Solflare, choose decimals, supply, trading fee and creator share, graduation
threshold, DAMM v2 fee preset, LP split (100%, at least 10% locked) and both recipient addresses.
"Use my wallet" only fills a field you can see. The server builds the SDK `createConfig`
transaction (SOL quote, SPL, immutable, fixed supply, DAMM v2, no vesting or creation fee) and
simulates it to show your balance and cost. A fresh config key is generated in the browser and
co-signs; your wallet signs and pays. Confirmation re-reads the account and rejects any term that
differs from what you reviewed. Then save the shown address as `METEORA_DBC_CONFIG` through the
secure settings form and recheck readiness.

## Flows

1. **Key** (`/identity`) — ML-DSA-65 pair generated from browser CSPRNG entropy. The secret key is
   encrypted with PBKDF2-SHA256 (600,000 iterations, fresh 16-byte salt) into AES-256-GCM
   (fresh 12-byte IV), with the file header bound as authenticated additional data. Only the
   encrypted file touches `localStorage`; the decrypted key lives in memory and is wiped on lock,
   tab close, or 15 minutes idle. Download the backup and keep its password: a lost password
   cannot be reset, and an anchored identity whose key is gone can never sign another passport.
2. **Registration** — the server issues a single-use, 5-minute challenge naming the site origin,
   cluster + genesis, your workspace account, your wallet and the key hash. Your wallet (Ed25519)
   and the PQ key (ML-DSA-65) sign the same canonical statement. The registration stays unanchored
   until a confirmed SPL Memo transaction commits its hash.
3. **Launch** (`/launchpad`) — the server builds the unsigned DBC create transaction, derives the
   pool/mint/config addresses, and stores the exact message hash bound to owner, wallet, mint,
   nonce, passport hash and metadata URI. You sign that exact message in Phantom or Solflare.
   Retries reuse the stored signed bytes, so a network error never re-signs a different
   transaction. A transaction that confirms with an error is terminal: it leaves the pending
   queue and never publishes a passport.
4. **Graduation** — if the signed config carries a positive locked-vesting allocation, the first
   Migrate prepares an SDK `createLocker` vesting escrow and only counts as done once the pool
   reports progress 2 (`LockedVesting`); a second explicit action then creates the DAMM v2 pool.
   Only a real derived DAMM v2 pool is shown as live. Fixed graduation fees come from the fee
   preset (0–5 = 25/30/100/200/400/600 bps); option 6 uses its own custom fee.
5. **Verify** (`/verify`, `/passport/$hash`) — public, no login. Reports pass / fail / pending /
   unavailable separately, re-checks the anchored identity, the signed terms, the confirmed
   transaction, mint authorities and the pinned metadata. Missing RPC or anchor data is never
   shown as "verified".

## Data

`pq_challenges` and `pq_identities` (private, owner-scoped), `chain_preparations`, `launch_nonces`,
`launches` and `passports`. Writes go through service-role-only atomic RPCs —
`register_pq_identity`, `create_launch_preparation`, `claim_chain_submission`,
`record_launch_confirmation` — so challenges and nonces are single-use and confirmations are
idempotent. Private keys are never sent to the server or stored.

## Checks

```sh
bunx vitest run      # domain, crypto, submission and config regressions
bunx tsgo --noEmit   # types
bun run build        # production Worker build
```
