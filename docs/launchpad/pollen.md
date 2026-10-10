# Pollen fee-sharing vaults

Pollen vaults are real Meteora Dynamic Fee Sharing vaults on Solana. Each vault holds a single token, either USDC or wrapped SOL.

* **Recipients:** you choose 2–5 recipient wallets. Shares are entered as exact percentages with up to two decimals and must add up to 100%. The shares are fixed for good once the vault is created.
* **Funding:** **Fund** pays tokens in through the program. The program moves the smaller of the amount you entered and your balance, and the confirmation shows the amount the transaction actually moved. Tokens sent straight to the vault's token account are not counted.
* **Claiming:** a claim pays out exactly what the program owes. That is `floor(share × (feePerShare − your checkpoint) / 2^64)`. Any rounding remainder is shown separately as "not currently claimable". Recipients' fractional shares keep adding up, so some of it may become claimable after future funding. A claim of zero is blocked, and every transaction is simulated before you sign it.
* **Routing pool fees into a vault:** a launch's partner fees can be claimed into a vault only if:
  * the vault is a PDA vault derived from its base and mint,
  * the pool's immutable config names that vault as the fee claimer,
  * the pool collects fees in the vault's token,
  * and the person claiming is one of the vault's recipients.

  Existing pools can't be changed to meet these conditions afterwards. Linking a vault to a token page is not proof that fees are routed to it.
