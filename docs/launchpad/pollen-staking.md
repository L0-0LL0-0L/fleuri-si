# Pollen Staking

{% hint style="info" %}
Open [Pollen Staking](https://fleuri.si/staking) from the app navigation or the Pollen page. The interface is implemented, but staking deposits are **not available yet**: no program has been deployed and no verified fee routing is configured.
{% endhint %}

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
| App decoders, account checks, coherent snapshots, readiness, confirmation, recovery and page tests (TypeScript) | Passing in the latest checks; see validation below |
| `/staking` page, transaction prepare/sign/recover flow | Implemented; blocked until deployed |
| Deployed program on mainnet or devnet | **None** |
| Fee routing from the existing $FLEURI pool | **No verified fee routing is configured.** The pool's immutable partner fee claimer does not name this Pollen vault, so the implemented partner route is unavailable. A creator-fee route would require the current creator's explicit approval to transfer creator authority plus quote-only requirements; it is unimplemented, needs separate review, and fleuri performs no authority transfer. |

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
* **Claim** collects your accrued wSOL rewards, not your staked FLEURI. It is enabled only for your connected wallet when a recent chain read shows a positive claimable amount and exit-readiness checks pass.
* **Collect Pollen rewards** on the page prepares the permissionless harvest. It is enabled only when the program and fee source pass and the pool has a positive claimable balance in the Pollen vault. You review and sign it in your own wallet.
* Every prepared action is saved to your workspace. After a reload or an uncertain submission, *Pending transactions* on `/staking` resends the exact same signed bytes and never builds a new transaction.
* Unstaking and withdrawing never call Meteora, so a fee-collection problem cannot trap your exit.
* No admin instruction can move staked principal or accrued rewards.

## Reading your portfolio

The page shows active FLEURI stake, pending withdrawals and their chain-time countdown, exact claimable wSOL, Pollen-funded totals, separately labelled treasury top-ups, claimed rewards and unallocated funds. These are real chain reads, never garden vSOL balances or seeded rewards.

* **Network badge:** shows the latest successful read's actual Solana cluster. Before the first successful read, it can say **network**; it does not assume mainnet.
* **As-of evidence:** the page shows the snapshot's slot and chain time. All portfolio amounts and the withdrawal preview use that same snapshot.
* **Refresh:** requests a new chain read. The page also refreshes every 45 seconds while the tab is visible, without overlapping reads.
* **Stale or failed reads:** a snapshot older than 120 seconds, or a failed latest read, blocks actions until a fresh successful read. Old data is labelled stale rather than shown as a permanently green check.
* **Wallet changes:** owned position data is cleared on disconnect or switch; late results for another wallet are ignored. A fresh read can enable Claim as rewards grow from zero to a positive amount.

Disconnected, wrong-network, unavailable-RPC, not-configured and not-deployed states do not imply an available deposit or a live reward balance. The page supports narrow mobile screens and reduced motion.

## Review, signing and recovery

Before your wallet is asked to sign, an in-page review shows the action and applicable amount, cooldown, chain-time unlock date, expected claim or Pollen harvest amount, program and network. It also shows the simulated SOL change, network fee and any token-account creation rent. Expected rewards are a recent-read estimate; the program determines the exact payout at execution.

Cancel closes the review without signing. Fleuri does not hold your wallet keys or sign automatically. A prepared transaction or pending signature is **not** a confirmed success.

Owner-specific **Pending transactions** appear directly on `/staking`, including after reload or uncertain submission. Signed bytes are saved before broadcast. Recovery checks confirmation or resends those **identical signed bytes**; it never silently builds a replacement transaction.

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
* No verified fee routing is configured. The existing $FLEURI pool's immutable partner fee claimer does not name this Pollen vault, so the implemented partner route is unavailable. A creator-fee route would need the current creator's explicit approval to transfer creator authority and satisfy quote-only requirements; it is unimplemented and needs separate review. No authority transfer is performed.
* Manual DFS funding remains possible even with a trading route, so trading origin needs separate proof.


## Coherent reads

The page reads pool, position, both vaults, the wallet's token accounts, the fee vault and the Clock sysvar in one `getMultipleAccountsInfoAndContext` call at `confirmed`, and shows that read's slot and Clock time. A position checkpoint ahead of the pool accumulator is treated as incoherent and re-read (up to 3 times), never displayed. The pool's harvestable amount is computed for the configured recipient index only (DFS allows duplicate addresses).

## Latest validation and limits

These are development checks, not evidence of deployment or live fee routing:

* **Rust accounting:** 14 tests passed in the last program run.
* **Compiled SBF / LiteSVM:** 11 tests passed against the compiled staking program and Meteora's real fee-sharing bytecode. Later snapshot and badge patches changed no Rust, so these were not rerun for those patches.
* **Full app suite after the snapshot correction:** 201 tests passed across 26 files with `bunx vitest run --maxWorkers=2`, including the encrypted-backup test in the same run.
* **Final network-badge correction:** 9 focused staking page tests passed; TypeScript checking and the production build passed.
* **Final browser checks:** desktop, 375px mobile and reduced motion passed with the network badge and as-of-slot line intact, no console errors and no sideways scrolling.

The CI workflow has not been run, and no independently reproducible program build has been completed. Nothing was deployed, published or broadcast during these implementation checks. Deposits remain gated pending deployment, reviewed configuration and verified fee routing.
