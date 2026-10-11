# Pollen Staking

Stake $FLEURI and earn a share of the **wrapped SOL that was actually collected**. The wSOL comes from one fixed [Pollen](pollen.md) fee-sharing vault. There are no new FLEURI emissions and no fixed APY. If no fees arrive, nothing is paid.

{% hint style="warning" %}
**Status: not deployed.** The program source, client and tests are done. No Pollen Staking program is deployed, so the **Stake** button on `/staking` stays blocked.
{% endhint %}

## What exists today

| Part | State |
| --- | --- |
| Program source (`onchain/pollen-staking`, Anchor 0.32.1) | Implemented |
| Accounting unit tests (Rust) | Passing (12) |
| Program tests: compiled program and Meteora's real fee-sharing program, run in a local Solana VM | Passing (6) |
| App client, decoders and readiness checks, cross-checked against the Rust layout and the IDL | Passing (24) |
| `/staking` page, transaction prepare/sign/recover flow | Implemented; blocked until deployed |
| Deployed program on mainnet or devnet | **None** |
| Fee routing from the existing $FLEURI pool | **Not available.** That pool uses a Meteora config fleuri does not control, and configs are immutable. |

## How rewards work

* **Rewards are fees only.** Rewards come only from wSOL the program actually received. Two sources count:
  * a permissionless **harvest**. The pool claims its share from the one configured fee-sharing vault, and only the measured balance increase is counted.
  * **Treasury funding**, which is labelled separately and never shown as Meteora fees.

  Tokens sent straight to the reward vault are not counted.
* **Release over seven days.** Each new batch of rewards, plus whatever is still unreleased, is released evenly over a fixed period. The proposed default is 7 days. Rewards that have already accrued are never changed by a refill.
* **Exact shares.** Accounting is integer fixed-point. Rounding remainders are kept per position and per pool, so nothing is lost or over-paid. A late joiner earns nothing from before they joined.
* **No stakers.** Rewards released while nobody is staked are set aside as *unallocated*. Anyone can re-release them once stake exists (`release_unallocated`).

## Staking and unstaking

* **Stake** moves FLEURI into the pool's principal vault.
* **Request unstake** stops earning at once and starts the cooldown (proposed default 7 days). You can have only one pending withdrawal at a time, so an existing cooldown is never silently extended.
* **Cancel** puts the pending amount back into active stake.
* **Withdraw** works after the cooldown and needs your wallet signature.
* Unstaking and withdrawing never call Meteora, so a fee-collection problem cannot trap your exit.
* No admin instruction can move staked principal or accrued rewards.

## Safety checks

* Only the program's upgrade authority can initialize a pool, and only once.
* At initialization:
  * the stake mint must have **no mint authority and no freeze authority**.
  * the reward mint must be wSOL.
  * the fee vault must be a Meteora DFS wSOL vault that names the pool as a recipient.
* The terms are fixed after initialization.
* The program code itself is upgradeable until its authority is revoked. The page shows this.

## Deposit readiness on `/staking`

Every check below must pass before deposits open:

1. The server is on mainnet, with a matching genesis hash.
2. The RPC is fresh.
3. A program ID is configured and is not the placeholder.
4. The program is executable.
5. Its bytecode matches the verified build hash.
6. The upgrade authority is readable.
7. The mint is the correct FLEURI mint.
8. The mint and freeze authorities are revoked.
9. The pool exists.
10. The principal and reward vaults are separate and canonical.
11. The fee source is verified.

Unstake, cancel, withdraw and claim don't need the mint or fee-source checks.

## Public configuration

These are server settings. They are public, read-only identifiers, never keys.

| Setting | Meaning |
| --- | --- |
| `POLLEN_STAKING_PROGRAM_ID` | The deployed program |
| `POLLEN_STAKING_PROGRAM_SHA256` | SHA-256 of the verified build's ELF |
| `POLLEN_STAKING_FEE_VAULT` | The one Meteora DFS wSOL vault |

## Devnet / localnet acceptance

1. Build and run the program tests. The steps are in `onchain/pollen-staking/README.md`.
2. Deploy to devnet with your own keypair, after `anchor keys sync`.
3. Create a devnet stake mint with **both authorities revoked**, and a DFS wSOL vault whose recipient is the derived pool PDA.
4. Initialize the pool with the upgrade-authority wallet.
5. Set the three settings. Point the server at devnet (`SOLANA_CLUSTER=devnet`). The page will still say "wrong network", because deposits open only on mainnet. Drive the actions through the program tests or the CLI.
6. Fund the DFS vault, then harvest. Confirm that the reward vault rose by exactly the pool's share.
7. Stake from two wallets at different times. Check that the claims match the expected split. Then request unstake, wait for the cooldown, and withdraw.

## Real blockers before mainnet

* No deployed program, verified build hash or upgrade-authority policy.
* No mainnet DFS vault naming the pool PDA, and no trading pool whose immutable config routes fees into that vault.
