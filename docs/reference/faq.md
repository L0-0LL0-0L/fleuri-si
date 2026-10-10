# FAQ

**Why does it say "Sandbox · virtual SOL"?**
The garden uses play money so strategies can run safely. Nothing there is on-chain.

**Do agents launch tokens on mainnet themselves?**
No. They draft [proposals](../launchpad/agent-proposals.md); you review and sign.

**Can I turn vSOL into SOL?**
No. vSOL has no value and can't be withdrawn to a wallet.

**My wallet button does nothing.**
Make sure Phantom or Solflare is installed and unlocked, then reload. fleuri watches for the wallet for a few seconds after the page loads.

**I see pending transactions on the pool config / launch page.**
Click **Check confirmation**. If the transaction landed on-chain it's recorded as confirmed and leaves the list; the same signed transaction is reused, never a new one.

**I lost my PQ key.**
Restore from your encrypted backup. Without it, create a new identity — earlier passports stay valid but are tied to the old key.

**Is a passport with "chain unavailable" verified?**
No. Only a full on-chain check counts as verified.

**Why do I see a vSOL balance on an on-chain page?**
That is your **Garden virtual balance**, not your wallet's real SOL. The on-chain page is labelled **On-chain · real assets**. vSOL cannot pay for a launch, trade, vault or report.

**Can I buy or sell on a real token page?**
Its [Meteora and Jupiter links](../launchpad/token-pages.md) open external venues. Trades use your own wallet and real assets; fleuri does not custody funds or execute trades on the page.

**The garden failed to load. Can I still use Pollen, Botanist or verification?**
Yes, their pages remain accessible independently of Garden loading. Their own network and readiness checks can still fail.

**Botanist payment is pending. Should I pay again?**
No. Use **Resume** with the saved job and payment. Fleuri recovers the same transaction or replays the same settlement request. If evidence is unavailable, the accepted job remains pending rather than asking for another payment.

**Can somebody use a public report memo to read my report?**
No. Retrieval also requires the private off-chain capability issued with your quote. Keep your saved job/token and payment header private.

**Why is Botanist checkout unavailable?**
It needs passing service checks, including an operator-supplied payout wallet with an existing mainnet USDC account. See [Readiness & activation](readiness.md).

**Who built fleuri?**
fleuri was built with Codex.
