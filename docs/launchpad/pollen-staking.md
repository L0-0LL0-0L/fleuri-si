# Pollen Staking

Stake $FLEURI and earn a share of the **wrapped SOL the pool actually received** from one fixed [Pollen](pollen.md) fee-sharing vault. These are **Pollen-funded rewards**. There are no new FLEURI emissions and no fixed APY. If nothing arrives, nothing is paid.

{% hint style="warning" %}
**Status: not deployed.** The program source, client and tests are done. No Pollen Staking program is deployed, so the **Stake** button on `/staking` stays blocked.
{% endhint %}

{% hint style="info" %}
**Where the wSOL comes from.** A Pollen (Meteora Dynamic Fee Sharing) vault accepts trading-fee routing *and* manual funding by anyone. A received claim proves the wSOL came **from the Pollen vault**. It does **not** prove that it came from DBC or DAMM trading fees. Trading origin stays unverified unless each route's funding is proven separately. Treasury top-ups are tracked as a third, separate total.
{% endhint %}

## What exists today

| Part | State |
| --- | --- |
| Program source (`onchain/pollen-staking`, Anchor 0.32.1) | Implemented |
| Accounting unit tests (Rust, host) | Passing (14) |
| Program tests: compiled SBF program and Meteora's real fee-sharing bytecode, run in LiteSVM | Passing (11) |
| App decoders, account checks, readiness, confirmation, recovery and page tests (TypeScript) | Passing (56) |
| `/staking` page, transaction prepare/sign/recover flow | Implemented; blocked until deployed |
| Deployed program on mainnet or devnet | **None** |
| Fee routing from the existing $FLEURI pool | **Not available.** That pool uses a Meteora config fleuri does not control, and configs are immutable. |

## How rewards work

* **Funded rewards only.** Rewards come only from wSOL the program actually received:
  * a permissionless **harvest** from the one configured Pollen vault. Only the measured balance increase of the reward vault counts (`dfs_funded_total`). A harvest that receives nothing fails and changes nothing, including timing.
  * **Treasury top-ups** (`treasury_total`), labelled separately.

  Tokens sent straight to the reward vault are not counted.
* **Release window that can't be delayed.** The first funding opens a 7-day window (the proposed default, fixed at initialization). Funds added while a window is open join it and release by **the same deadline**. A fresh 7-day window starts only after the old one has ended. So repeated 1-lamport top-ups can't push anyone's rewards later. Released amounts are cumulative integer vests, and rewards that already accrued never change.
* **Exact shares.** Accounting is integer Q64 fixed-point. Rounding remainders are kept per position and per pool, so nothing is lost or over-paid. A late joiner earns nothing from before they joined.
* **No stakers.** Rewards released while nobody is staked are set aside as *unallocated*. When stake goes from zero to positive (a first **stake** or a **cancel unstake**), the program automatically puts them back into the release window, following the same deadline rule. The new staker earns only what is released after they joined. No separate step is needed. `release_unallocated` remains as a permissionless fallback.

## Staking and unstaking

* **Stake** moves FLEURI into the pool's principal vault.
* **Request unstake** stops earning at once and starts the cooldown (proposed default 7 days). You can have only one pending withdrawal at a time, so an existing cooldown is never silently extended.
* **Cancel** puts the pending amount back into active stake.
* **Withdraw** works after the cooldown and needs your wallet signature.
* **Collect Pollen rewards** on the page prepares the permissionless harvest. It is enabled only when the program and fee source pass and the pool has a positive claimable balance in the Pollen vault. You review and sign it in your own wallet.
* Every prepared action is saved to your workspace. After a reload or an uncertain submission, *Pending transactions* on `/staking` resends the exact same signed bytes and never builds a new transaction.
* Unstaking and withdrawing never call Meteora, so a fee-collection problem cannot trap your exit.
* No admin instruction can move staked principal or accrued rewards.

## Safety checks in the program

* Only the program's upgrade authority can initialize a pool, and only once.
* At initialization the stake mint must have **no mint authority and no freeze authority**. The reward mint must be wSOL.
* The fee vault is checked byte for byte. It must be:
  * owned by Meteora DFS, with the FeeVault discriminator.
  * an SPL Token vault (`token_flag` = 0).
  * a **PDA vault** (`fee_vault_type` = 1). Keypair vaults are rejected.
  * the canonical PDA `["fee_vault", base, wSOL]` using its stored bump.
  * paired with the canonical token vault `["token_vault", fee_vault]`.
  * set up so that recipient `index` is exactly the pool PDA, with a share above zero and a total share above zero.
* Principal and reward vaults are checked in every instruction: canonical PDA address, SPL Token owner, initialized and not frozen, correct mint, pool authority, no delegate and no close authority.
* **Harvest custody.** The reward vault gets the full custody check before **and** right after the Meteora call, and its balance can never decrease. Any change aborts the whole transaction, which rolls back every effect of the call. The principal vault is never passed to an external program.
* The terms are fixed after initialization. The program code itself stays upgradeable until its authority is revoked, and the page shows this.

## Deposit readiness on `/staking`

Every check must pass before deposits open:

1. The server is on mainnet, with a matching genesis hash.
2. The RPC is fresh.
3. A program ID is configured and is not the placeholder.
4. The program is executable.
5. Its ELF hash matches the configured `POLLEN_STAKING_PROGRAM_SHA256`.
6. The upgrade authority is readable.
7. The mint is the correct FLEURI mint: SPL Token, exactly 82 bytes, initialized, 6 decimals.
8. The mint and freeze authorities are revoked.
9. The pool exists.
10. Both vaults pass the full custody check.
11. The Pollen fee source passes the same byte checks as the program, plus the Pollen PDA checks.

**Exits use only checks 1–5, 9 and 10.** Unstake, cancel, withdraw and claim never depend on the mint-authority or fee-source checks. The server and the page use the same rule.

## Program hash

`POLLEN_STAKING_PROGRAM_SHA256` is the SHA-256 of the ELF with **all trailing zero bytes removed**. The loader zero-pads ProgramData, so the server trims it the same way. To compute it for a local `.so`:

```
bun scripts/staking-elf-hash.ts target/deploy/pollen_staking.so
```

A match proves only that the on-chain code equals the configured hash. It is **not** proof of a reproducible build. For that, build with `solana-verify build` and compare independently. So far no reproducible build has been made. The local development build in this sandbox (platform-tools v1.48, placeholder program ID) hashed to `dd38abb6…5c1a7f`. That build is not deployable and must not be configured.

## Public configuration

These are server settings. They are public, read-only identifiers, never keys.

| Setting | Meaning |
| --- | --- |
| `POLLEN_STAKING_PROGRAM_ID` | The deployed program |
| `POLLEN_STAKING_PROGRAM_SHA256` | Expected ELF hash (normalization above) |
| `POLLEN_STAKING_FEE_VAULT` | The one Meteora DFS **PDA** wSOL vault |

## Devnet / localnet acceptance

1. Build and run the program tests. The steps are in `onchain/pollen-staking/README.md`.
2. Generate your own program keypair. Run `anchor keys sync`, or `python3 scripts/sync-program-id.py <program id>` from `onchain/pollen-staking`. Then rebuild with `solana-verify build` and regenerate the IDL with `scripts/idl.py build`.
3. Deploy to devnet. Record the hash with the script above.
4. Create a devnet stake mint with **both authorities revoked**.
5. Create a DFS vault with `initialize_fee_vault_pda` (SDK 1.1.0) for wSOL, naming the derived pool PDA as one recipient.
6. Initialize the pool with the upgrade-authority wallet, passing that recipient index.
7. Set the three settings. Point the server at devnet (`SOLANA_CLUSTER=devnet`). The page will still say "wrong network", because deposits open only on mainnet. Drive the actions through the program tests or the CLI.
8. Fund the DFS vault, then harvest. Confirm that the reward vault rose by exactly the pool's share, and that `dfs_funded_total` rose by the same amount.
9. Stake from two wallets at different times and check that the claims match the expected split. Then request unstake, wait for the cooldown and withdraw.

## Real blockers before mainnet

* No deployed program, reproducible build hash or upgrade-authority policy.
* No mainnet DFS PDA vault naming the pool PDA.
* No trading pool whose immutable config routes fees into that vault. Even once one exists, manual DFS funding remains possible, so trading origin needs separate proof.
