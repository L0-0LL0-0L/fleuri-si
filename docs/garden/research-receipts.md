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
3. Review the full record, confirm, and sign. Your key never leaves the browser.

## Share and verify
* Receipts are **private by default**. Publishing shows the record, your wallet and the registration statement (which includes your account ID). You can make it private again.
* Anyone can verify a downloaded bundle on the Receipts page or offline: `bun scripts/verify-receipt.ts receipt.json [--rpc URL]`. A tampered file fails.

## Optional Memo anchor
You can anchor the receipt hash with a wallet-signed SPL Memo transaction. You review it first; the exact signed transaction is saved before broadcast so retries resend the same bytes. Until confirmed it is shown as pending, never as anchored.

## Proposal review
When a launch proposal cites a trial, signed receipts over that run are frozen into your review with their policy match, engine version and anchor status at that moment. Later changes don't alter a review already in progress.
