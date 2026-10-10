# Botanist field report

A paid, one-time check of any Solana token mint. It costs **0.50 USDC**, paid over the x402 v2 "exact" scheme on Solana mainnet. Verifying a passport stays free.

## What the report includes

* The slot and time it was observed
* Mint and freeze authorities, supply, decimals and token program
* Metadata name, symbol, URI, update authority and whether it can still be changed
* Validated upgrade status for the token program and, where applicable, the DBC program: **Immutable — no upgrade authority**, **Upgradeable by** a linked authority, or **Unavailable**. Missing or malformed flags never count as immutable.
* The 10 largest token accounts and their combined share. These are accounts, not people.
* For fleuri launches: the signed creator compared with the current pool creator, the DBC config fee claimer compared with the signed promise, the recorded lifecycle stage and the DBC program's upgrade authority
* A list of anything that couldn't be checked, including LP lock state, which is never claimed

This is not an audit, a safety rating or financial advice.

## How payment works

1. Ask for a quote. It is valid for 10 minutes and fixes the price, payout address, facilitator and its fee payer, accepted payment requirement, resource and job memo. Those stored terms cannot change on retry.
2. Your wallet signs one USDC TransferChecked with that memo. The facilitator, PayAI by default, pays the network fee.
3. Your browser saves the exact signed payment before sending it. Fleuri checks the instruction layout, mint, amount, recipient USDC account, required payer signatures, compute fee cap and memo, then asks the facilitator to verify before durably binding the payment. One payment can only belong to one job.
4. The facilitator settles the payment. Fleuri saves its returned transaction signature before waiting for chain data. Delivery requires the confirmed transaction's message hash to match the accepted payment, and the exact USDC credit at the destination account's canonical position. Only then does it build and save the report.
5. If something goes wrong partway, **Open / resume** reuses the same signed payment, so you are never charged twice.

The receipt lists the network, asset, amount, recipient, payer, transaction, slot and a digest of the report. It proves the payment and identifies which report was delivered. It does not certify the token.

## Payment safety and resuming

- Your wallet signs one standard Solana (v0) transaction: the exact USDC amount to the service account, plus a memo that ties it to your job. Fleuri checks your signature and asks the payment facilitator to verify it before the payment is attached to the job.
- The signed payment is saved in your browser before it is sent. If the page or connection drops, **Resume** sends the exact same payment again. Your wallet is never asked to pay twice for the same job.
- A report is delivered only after the chain shows that this exact transaction credited the service account. A different transfer never unlocks a report.
- If the payment is refused before it is accepted, nothing is charged and you can sign again. If the accepted transaction fails on chain, the job closes, no report is delivered, and nothing is credited.
- The report covers authorities, metadata, the largest holder accounts, and protocol fees and graduation for fleuri launches. Anything that could not be read is marked unavailable. You can download the raw JSON and receipt.

## Private retrieval, including ordinary x402 clients

The quote issues a job ID and a random **off-chain retrieval token**. Treat that token and any saved payment header as private: someone with the capability can retrieve the report. Fleuri stores only the token's hash, not its plaintext.

* The site's **Resume** request supplies `jobId` and `token`.
* A generic x402 client can retry the original `POST /api/public/botanist/report` body `{ "mint": "…" }` with its signed `PAYMENT-SIGNATURE`. The quote includes `botanistJob` and `botanistCapability` in `accepted.extra`, which the client must preserve.
* The server validates the capability before returning any job or report, and cross-checks the inspected mint, resource and memo. Missing, malformed or incorrect capabilities cannot retrieve a paid report, even with a copied public memo.

**The memo is public on chain and is not authorization.** The retrieval token is not put on chain or sent to the facilitator. Keep the saved job, token and signed payment if you want to resume later; losing them can prevent recovery through the page.

## Lost settlement responses

Each job uses the same `Idempotency-Key` (its request hash) for every facilitator settlement attempt. Once payment is verified and bound, retries do not run payment verification again: they check the saved candidate signature, look for the exact confirmed chain message, or replay the identical settlement body and key using the frozen terms. A replay returns the same saved report and receipt rather than charging again.

PayAI documents a 24-hour idempotency retention window. Beyond that window, confirmed chain evidence can still resolve the job; if evidence is unavailable, it stays honestly pending. An accepted pending job must not be replaced with another payment just to get a report.

## Availability

Checkout stays disabled until the service has a valid public payout wallet and its existing mainnet USDC account, plus passing network, price and facilitator checks. See [Readiness & activation](../reference/readiness.md). Free passport verification does not require that payout address.
