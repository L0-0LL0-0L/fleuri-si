# Launching a token

## Before you start

* All six readiness checks pass
* Phantom or Solflare connected, with mainnet SOL for fees
* A registered [PQ identity](pq-identity.md) unlocked in this browser

## Fill in the token

| Field | Rules |
| --- | --- |
| **Token name** | Up to 32 characters |
| **Ticker** | 1–10 uppercase letters or numbers |
| **Token image** | Upload PNG / JPEG / GIF / WebP up to 1 MB, or paste an immutable `ipfs://` CID |
| **Website** · optional | Must be an `https://` link |
| **Twitter / X** · optional | Must be an `https://x.com/…` or `https://twitter.com/…` link |

The image and metadata are pinned to IPFS so they can never be swapped later.

## Review and sign

1. **Review** — fleuri shows every exact term: name, ticker, links, supply, decimals, fee, graduation threshold, LP split, authorities and the pool config.
2. **Acknowledge** — tick the box confirming you understand it is a real mainnet launch.
3. **Sign the passport** with your PQ key.
4. **Approve the transaction** in your wallet.

Nothing is ever broadcast automatically — your wallet popup is the final say.

## After launch

* The launch is confirmed only when the transaction is confirmed on-chain — a pending signature is never shown as a verified launch.
* If your connection drops, the exact signed transaction is saved and can be **recovered safely** from the pending list, with the same signature (no double launches).
* Your passport gets a public page at `/passport/<hash>`.
* Your real token page is `/t/<mint>`, with live chain data, its passport and external Meteora/Jupiter trading links. It is separate from garden coins at `/c/<symbol>`; see [Real token pages](token-pages.md).

## Token policy

Every launch uses: SOL as the quote token, SPL Token standard, 6–9 decimals, fixed supply, immutable metadata, and **revoked mint and freeze authorities**. When the curve fills, the token **migrates to a Meteora DAMM v2 pool**. Only an actual DAMM v2 pool counts as live.
