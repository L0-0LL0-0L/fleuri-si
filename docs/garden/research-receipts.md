# Research Receipts

A research receipt is **your signed statement** that a specific saved Greenhouse trial produced specific results. It is signed in your browser with your registered PQ identity (ML-DSA-65) under a dedicated receipt context, so it can never be confused with a passport or registration signature.

## What it covers
* Only completed trials you ran and saved yourself.
* The frozen inputs, every agent policy snapshot, decisions, outcomes and the trial's original checksums, plus an exact replay.
* Your identity: wallet and PQ key that dual-signed your registration. An on-chain identity anchor is not required; its status is shown.

## What it does not claim
A receipt is not AI training evidence, not a signature by any agent, not a safety or quality certification, and says nothing about real-chain performance. Garden trials use virtual balances only.

## Create
1. Open a finished trial and choose **Create research receipt** (or go to **Receipts → New**).
2. Pick a registered identity. The server freezes the draft — it cannot change afterwards.
3. Review the full record, tick the confirmation, and sign. Your key never leaves the browser, and the unlocked key must be the one the draft names.

## Unfinished drafts
**Receipts → Continue signing** reopens that exact server draft — same identity, same request and same hash — even on another device or after clearing browser data. Each draft has its own entry, so two drafts of one trial are never confused. If a signature was made but the save was interrupted, the same signature bytes are resent unchanged.

## Format versions
New receipts use `fleuri.research-receipt/v2`, which does not contain any private server identifier. Older `v1` receipts also contain a private request identifier inside the signed record. They still verify offline and are labelled "legacy"; the identifier cannot be removed without breaking the signature, and the publish review says so.

## Share and verify
* Receipts are **private by default**. Publishing shows the record, your wallet and the registration statement (which includes your account ID). You can make it private again.
* Anyone can verify a downloaded bundle on the Receipts page or offline: `bun scripts/verify-receipt.ts receipt.json [--rpc URL]`. A tampered file fails.
* The checker rejects files with duplicated fields (even if spelled with escapes), files over 2.6 MB, and checksum claims that don't match the bundled data. For a trial engine this version can't replay, signature and checksums are still checked and replay is shown as **unsupported** — an old trial is never re-run through a newer engine.

## Optional Memo anchor
You can anchor the receipt hash with a wallet-signed SPL Memo transaction. You review it first; the exact signed transaction is saved before broadcast so retries resend the same bytes. Until confirmed it is shown as pending, never as anchored.

Before your wallet opens, fleuri shows what is inside the exact transaction it prepared: the Memo text, the paying wallet, the network and the simulated cost. Signing stays off if the cost simulation fails, the balance is too low or the preparation has expired. If you switch account or wallet, or leave the page while the wallet is open, the request is cancelled and a late signature is never sent.

A status of **recorded: confirmed** is what fleuri saved. It is not verification on its own. Use **Check anchor on chain** with a network address you choose; only a passing re-read counts as verified.

## Proposal review
When a launch proposal cites a trial, only your own receipts that fully pass checking for that exact trial are frozen into your review. Each one shows its key, whether its policy matches, whether its engine can be replayed and any **recorded** anchor, which is clearly marked as not re-checked on chain. The same snapshot stays through passport signing and wallet approval; later edits don't change it. If receipts can't be loaded, the review says so rather than showing older ones.

### Cost and chain-status strictness

- **Anchor cost must be fully known.** The wallet button stays disabled unless the wallet balance, the simulated balance change and the network fee are all available whole, non-negative lamport amounts, and the balance covers the larger of the two costs. A missing fee or simulated post-balance is shown as "unavailable", never as zero.
- **Unknown transaction status is never a pass.** When re-reading an anchor, a transaction with missing status metadata, an unsupported version or out-of-range signer/instruction data is reported as unsupported, not confirmed.
- **Owner changes cancel in-flight work.** If you switch workspace while signing, publishing or preparing, late replies are ignored; a signature you already made stays saved on this device for that workspace so it can be resent unchanged.
