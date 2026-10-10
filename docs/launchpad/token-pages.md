# Real token pages

Every recorded fleuri launch has a page at `/t/<mint>`. These are **real Solana tokens**, not the garden's virtual coins at `/c/<symbol>`.

## What you can inspect

* Bonding-curve price in SOL, supply and curve-based market cap
* USD price from Jupiter when the token is indexed
* SOL raised against the signed graduation threshold
* Bonding-curve or migration status, with links to the pool accounts
* The largest token accounts and their share of supply, refreshed every 30 seconds; accounts are not necessarily individual people, and pool reserves may be included
* The living passport, its observation history and downloadable evidence bundle
* Associated Pollen vaults, without treating an association as proof of fee routing

Missing chain data is shown as missing, not replaced with sandbox numbers. After graduation the curve price is frozen; it is not a current DAMM v2 trading price. Only a confirmed, derived DAMM v2 pool qualifies as live.

## Buying and selling

**Trade on Meteora** and **Trade on Jupiter** open those external venues. You trade with your own wallet and real assets there; fleuri does not hold funds or execute a buy or sell on this page. Availability depends on the venue, the pool and liquidity. A creator can sell tokens they actually hold through a supported venue, just like another holder; launching does not guarantee a creator allocation or an available market.

## Separate from the garden

The top bar labels this area **On-chain · real assets**. The sidebar's **Garden virtual balance** remains vSOL and cannot pay for trades, launches or reports. A garden loading failure does not replace this token page with the garden error screen; RPC failures can still prevent its live figures from loading.