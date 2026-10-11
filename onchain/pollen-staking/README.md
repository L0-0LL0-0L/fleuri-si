# Pollen Staking program

An Anchor 0.32.1 program. You stake one fixed SPL mint ($FLEURI) and earn wrapped SOL. The wSOL is collected from one fixed Meteora Dynamic Fee Sharing (DFS) vault.

**Status:** the source is implemented, and the unit tests and SBF program tests pass. **It is not deployed.** The `declare_id!` in `programs/pollen-staking/src/lib.rs` is a local placeholder. No secret key for it is stored anywhere.

## Layout

```text
programs/pollen-staking/src/lib.rs   instructions, accounts, CPI whitelist
programs/pollen-staking/src/math.rs  pure integer accounting + unit tests
idl/pollen_staking.json              generated IDL (client ABI)
fixtures/layout.json                 Rust-written layout fixture read by src/pq/staking.test.ts
tests-integration/                   LiteSVM tests: compiled .so + Meteora DFS mainnet bytecode
```

## PDAs (deterministic)

| Account | Seeds |
| --- | --- |
| Pool | `["pool", stake_mint]` |
| Principal vault (FLEURI) | `["principal", pool]` |
| Reward vault (wSOL) | `["reward", pool]` |
| Position | `["position", pool, owner]` |

## Build

Toolchain: Solana CLI 2.3.x (platform-tools Rust 1.84). `.cargo/config.toml` turns on MSRV-aware resolution, so `Cargo.lock` picks crates that compile with that toolchain.

```sh
cargo test -p pollen-staking --lib                                   # accounting unit tests (host)
cargo build-sbf --manifest-path programs/pollen-staking/Cargo.toml   # -> target/deploy/pollen_staking.so
# Regenerate the IDL:
cargo test -p pollen-staking --features idl-build __anchor_private_print_idl -- --show-output --quiet
# then: python3 scripts/idl.py check <output>   (or `build` to rewrite idl/pollen_staking.json)
# `anchor build` with Anchor CLI 0.32.1 also works; Anchor.toml is included.
# Regenerate the TS layout fixture after a layout change:
WRITE_FIXTURES=1 cargo test -p pollen-staking --lib layout_fixture
```

## Program tests

```sh
mkdir -p tests-integration/fixtures
solana program dump -u mainnet-beta dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh tests-integration/fixtures/dfs.so
cd tests-integration && PS_SO=../target/deploy/pollen_staking.so cargo test
```

The tests cover:

* upgrade-authority-only initialization and re-initialization rejection
* rejection of a freeze-authority mint, a mint-authority mint and the wrong DFS recipient
* a real DFS `claim_fee` harvest that credits only the measured increase, while a direct donation is not counted
* late joiners, exact proportional claims and double-claim rejection
* cooldown, cancelling an unstake, the single pending lot and a wrong-signer withdrawal
* a wrong DFS program and a removed DFS program: exits still work
* resending identical signed bytes
* the fee vault is created with the real `initialize_fee_vault_pda` (SDK 1.1.0) ABI; a keypair vault and tampered type/flag/bump/base bytes are rejected
* repeated 1-lamport treasury top-ups and `release_unallocated` calls cannot move the release deadline; a zero-delta harvest changes nothing
* reward/principal vault custody: delegate, close authority, frozen state and swapped vaults are rejected (harvest checks before and after the DFS call)

## Deploy (manual only, never automatic)

1. `solana-keygen new -o target/deploy/pollen_staking-keypair.json`, then `anchor keys sync` (Anchor CLI 0.32.1, uses Anchor.toml) **or** `python3 scripts/sync-program-id.py $(solana-keygen pubkey target/deploy/pollen_staking-keypair.json)`. Either replaces the placeholder in `declare_id!`, Anchor.toml and the IDL. Rebuild, run `scripts/idl.py build`, rerun all tests.
2. Run a verifiable build (`solana-verify build`) and record the ELF SHA-256 with `bun scripts/staking-elf-hash.ts <so>` (SHA-256 after trimming all trailing zero bytes — the same normalization the server applies to ProgramData).
3. Deploy to devnet first: `solana program deploy target/deploy/pollen_staking.so --program-id target/deploy/pollen_staking-keypair.json`.
4. Create a DFS wSOL vault that has the **pool PDA** (derived from the new program ID and the mint) as a recipient.
5. Call `initialize_pool(604800, 604800, recipient_index)` signed by the upgrade authority.
6. Configure these server settings. They are public and read-only: `POLLEN_STAKING_PROGRAM_ID`, `POLLEN_STAKING_PROGRAM_SHA256` and `POLLEN_STAKING_FEE_VAULT`.

Store the keypair files only on the deployer's machine. They are git-ignored.
