# Real token pages

Every recorded fleuri launch has a page at `/t/<mint>`. These are **real Solana tokens**, not the garden's virtual coins at `/c/<symbol>`.

## $FLEURI

The fleuri token is **$FLEURI**. Its contract (mint) address is:

```
25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri
```

Token page: [`/t/25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri`](https://fleuri.si/t/25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri)

In the app the same address sits behind the **CA** button in the top bar of every page: press it and the address appears in a panel with its live status, where it can be copied in one click or selected as a whole, beside the reminder to verify the address and launch independently on Meteora before sending anything.

{% hint style="info" %}
Status as at 11 October 2026: **$FLEURI is live on Solana mainnet** — the mint exists (nearly the full supply minted, mint authority revoked) and trades on a Meteora bonding curve. It was launched **directly on Meteora**, not recorded through fleuri's launchpad, so it has no fleuri launch record or passport; the app still reads its live price, raised SOL, holders and pool from chain. Always copy the address above rather than trusting a name: on Solana the address is the only reliable identifier.
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