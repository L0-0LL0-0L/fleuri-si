# Botanist field report

A paid, one-time check of any Solana token mint. It costs **0.50 USDC**, paid over the x402 v2 "exact" scheme on Solana mainnet. Verifying a passport stays free.

## What the report includes

* The slot and time it was observed
* Mint and freeze authorities, supply, decimals and token program
* Metadata name, symbol, URI, update authority and whether it can still be changed
* The token program's upgrade authority
* The 10 largest token accounts and their combined share. These are accounts, not people.
* For fleuri launches: the signed creator compared with the current pool creator, the DBC config fee claimer compared with the signed promise, the recorded lifecycle stage and the DBC program's upgrade authority
* A list of anything that couldn't be checked, including LP lock state, which is never claimed

This is not an audit, a safety rating or financial advice.

## How payment works

1. Ask for a quote. The quote fixes the price, the payout address, the facilitator's fee payer and a job memo for 10 minutes. These terms can't be changed afterwards.
2. Your wallet signs one USDC TransferChecked with that memo. The facilitator, PayAI by default, pays the network fee.
3. Fleuri checks the transaction itself before saving the signed bytes. It checks the instruction layout, mint, amount, recipient USDC account, signer, compute fee cap and memo. One payment can only belong to one job.
4. The facilitator settles the payment. Fleuri then reads the confirmed transaction and checks that the payout account received exactly the price. Only after that does it build and save the report.
5. If something goes wrong partway, **Open / resume** reuses the same signed payment, so you are never charged twice.

The receipt lists the network, asset, amount, recipient, payer, transaction, slot and a digest of the report. It proves the payment and identifies which report was delivered. It does not certify the token.
