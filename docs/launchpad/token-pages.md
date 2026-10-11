# Real token pages

Every recorded fleuri launch has a page at `/t/<mint>`. These are **real Solana tokens**, not the garden's virtual coins at `/c/<symbol>`.

## $FLEURI

The fleuri token is **$FLEURI**. Its contract (mint) address is:

```
25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri
```

Token page: [`/t/25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri`](https://fleuri.si/t/25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri)

{% hint style="warning" %}
Status as at 11 October 2026: fleuri's chain checks found **no account at this address** on Solana mainnet-beta or devnet, and no fleuri launch or passport is recorded for it. Until a mint is confirmed at the address, its token page shows no supply, holders, price or pool — and nothing here should be read as a live market. Always copy the address above rather than trusting a name: on Solana the address is the only reliable identifier.
{% endhint %}

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