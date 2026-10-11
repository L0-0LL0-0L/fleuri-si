//! Real program tests: compiled pollen_staking.so + Meteora DFS mainnet bytecode in LiteSVM.
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use pollen_staking as ps;
use solana_sdk::{
    account::Account, bpf_loader_upgradeable::{self, UpgradeableLoaderState}, clock::Clock,
    instruction::{AccountMeta, Instruction}, program_option::COption, program_pack::Pack,
    pubkey::Pubkey, signature::Keypair, signer::Signer, system_program, transaction::Transaction,
};
use anchor_lang::AccountDeserialize;
use spl_token::state::{Account as TokAcc, AccountState, Mint};

const DAY: i64 = 86_400;
const WSOL: Pubkey = ps::WSOL_MINT;

fn so(env: &str, default: &str) -> Vec<u8> {
    let p = std::env::var(env).unwrap_or_else(|_| format!("{}/{}", env!("CARGO_MANIFEST_DIR"), default));
    std::fs::read(&p).unwrap_or_else(|_| panic!("missing {p}; see README 'Program tests'"))
}

fn deploy(svm: &mut LiteSVM, id: Pubkey, elf: &[u8], authority: Option<Pubkey>) {
    let (pd, _) = Pubkey::find_program_address(&[id.as_ref()], &bpf_loader_upgradeable::id());
    let mut data = bincode::serialize(&UpgradeableLoaderState::ProgramData { slot: 0, upgrade_authority_address: authority }).unwrap();
    data.resize(UpgradeableLoaderState::size_of_programdata_metadata(), 0);
    data.extend_from_slice(elf);
    svm.set_account(pd, Account { lamports: svm.minimum_balance_for_rent_exemption(data.len()), data, owner: bpf_loader_upgradeable::id(), executable: false, rent_epoch: 0 }).unwrap();
    let pdata = bincode::serialize(&UpgradeableLoaderState::Program { programdata_address: pd }).unwrap();
    svm.set_account(id, Account { lamports: svm.minimum_balance_for_rent_exemption(pdata.len()), data: pdata, owner: bpf_loader_upgradeable::id(), executable: true, rent_epoch: 0 }).unwrap();
}

fn put_mint(svm: &mut LiteSVM, key: Pubkey, auth: Option<Pubkey>, freeze: Option<Pubkey>, decimals: u8) {
    let mut d = vec![0u8; Mint::LEN];
    Mint { mint_authority: auth.into(), supply: 1_000_000_000_000, decimals, is_initialized: true, freeze_authority: freeze.into() }.pack_into_slice(&mut d);
    svm.set_account(key, Account { lamports: svm.minimum_balance_for_rent_exemption(d.len()), data: d, owner: spl_token::id(), executable: false, rent_epoch: 0 }).unwrap();
}

fn put_tok(svm: &mut LiteSVM, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
    let key = Pubkey::new_unique();
    let rent = svm.minimum_balance_for_rent_exemption(TokAcc::LEN);
    let native = mint == WSOL;
    let mut d = vec![0u8; TokAcc::LEN];
    TokAcc { mint, owner, amount, delegate: COption::None, state: AccountState::Initialized, is_native: if native { COption::Some(rent) } else { COption::None }, delegated_amount: 0, close_authority: COption::None }.pack_into_slice(&mut d);
    svm.set_account(key, Account { lamports: rent + if native { amount } else { 0 }, data: d, owner: spl_token::id(), executable: false, rent_epoch: 0 }).unwrap();
    key
}

fn bal(svm: &LiteSVM, k: Pubkey) -> u64 { TokAcc::unpack(&svm.get_account(&k).unwrap().data).unwrap().amount }
fn now(svm: &mut LiteSVM, t: i64) { let mut c: Clock = svm.get_sysvar(); c.unix_timestamp = t; svm.set_sysvar(&c); svm.expire_blockhash(); }

/// Fresh blockhash per call so identical instructions reach the program (duplicate *bytes* are
/// covered by `duplicate_signed_bytes_are_rejected`).
fn send(svm: &mut LiteSVM, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&signers[0].pubkey()), signers, svm.latest_blockhash());
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
}

struct Env { svm: LiteSVM, admin: Keypair, stake_mint: Pubkey, pool: Pubkey, principal: Pubkey, reward: Pubkey, fee_vault: Pubkey, fee_token_vault: Pubkey, dfs_event: Pubkey }

fn dfs_pda(seeds: &[&[u8]]) -> Pubkey { Pubkey::find_program_address(seeds, &ps::DFS_PROGRAM_ID).0 }

/// SDK 1.1.0 `initialize_fee_vault_pda` discriminator.
const DFS_INIT_PDA: [u8; 8] = [250, 250, 156, 113, 88, 143, 60, 233];
/// SDK 1.1.0 `initialize_fee_vault` (keypair vault) discriminator; used only for negative tests.
const DFS_INIT_KEYPAIR: [u8; 8] = [185, 140, 228, 234, 79, 203, 252, 50];
fn params(recipients: &[(Pubkey, u32)]) -> Vec<u8> {
    let mut d = vec![0u8; 64]; // padding: [u64; 8]
    d.extend_from_slice(&(recipients.len() as u32).to_le_bytes());
    for (a, s) in recipients { d.extend_from_slice(a.as_ref()); d.extend_from_slice(&s.to_le_bytes()); }
    d
}

/// Creates a real DFS **PDA** fee vault (`initialize_fee_vault_pda`): seeds ["fee_vault", base, WSOL],
/// token vault ["token_vault", fee_vault]. This is the routing source shape Pollen requires.
fn create_fee_vault(svm: &mut LiteSVM, payer: &Keypair, recipients: &[(Pubkey, u32)]) -> (Pubkey, Pubkey) {
    let base = Keypair::new();
    let fv = dfs_pda(&[b"fee_vault", base.pubkey().as_ref(), WSOL.as_ref()]);
    let tv = dfs_pda(&[b"token_vault", fv.as_ref()]);
    let ix = Instruction { program_id: ps::DFS_PROGRAM_ID, data: [DFS_INIT_PDA.as_slice(), &params(recipients)].concat(), accounts: vec![
        AccountMeta::new(fv, false), AccountMeta::new_readonly(ps::DFS_FEE_VAULT_AUTHORITY, false), AccountMeta::new(tv, false),
        AccountMeta::new_readonly(WSOL, false), AccountMeta::new_readonly(payer.pubkey(), false), AccountMeta::new_readonly(base.pubkey(), true),
        AccountMeta::new(payer.pubkey(), true), AccountMeta::new_readonly(spl_token::id(), false), AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(dfs_pda(&[b"__event_authority"]), false), AccountMeta::new_readonly(ps::DFS_PROGRAM_ID, false)] };
    send(svm, ix, &[payer, &base]).expect("dfs init pda");
    let d = svm.get_account(&fv).unwrap().data;
    assert_eq!((d[104], d[105]), (0, 1), "SPL token flag, PDA vault type");
    (fv, tv)
}

/// Legacy keypair vault: must be rejected by Pollen Staking.
fn create_keypair_fee_vault(svm: &mut LiteSVM, payer: &Keypair, recipients: &[(Pubkey, u32)]) -> (Pubkey, Pubkey) {
    let fv = Keypair::new();
    let tv = dfs_pda(&[b"token_vault", fv.pubkey().as_ref()]);
    let ix = Instruction { program_id: ps::DFS_PROGRAM_ID, data: [DFS_INIT_KEYPAIR.as_slice(), &params(recipients)].concat(), accounts: vec![
        AccountMeta::new(fv.pubkey(), true), AccountMeta::new_readonly(ps::DFS_FEE_VAULT_AUTHORITY, false), AccountMeta::new(tv, false),
        AccountMeta::new_readonly(WSOL, false), AccountMeta::new_readonly(payer.pubkey(), false), AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new_readonly(spl_token::id(), false), AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(dfs_pda(&[b"__event_authority"]), false), AccountMeta::new_readonly(ps::DFS_PROGRAM_ID, false)] };
    send(svm, ix, &[payer, &fv]).expect("dfs init keypair");
    (fv.pubkey(), tv)
}

fn dfs_fund(svm: &mut LiteSVM, e_fv: Pubkey, e_tv: Pubkey, funder: &Keypair, amount: u64) {
    let src = put_tok(svm, WSOL, funder.pubkey(), amount);
    let mut data = vec![243, 236, 235, 235, 101, 24, 186, 178]; data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction { program_id: ps::DFS_PROGRAM_ID, data, accounts: vec![
        AccountMeta::new(e_fv, false), AccountMeta::new(e_tv, false), AccountMeta::new_readonly(WSOL, false), AccountMeta::new(src, false),
        AccountMeta::new_readonly(funder.pubkey(), true), AccountMeta::new_readonly(spl_token::id(), false),
        AccountMeta::new_readonly(dfs_pda(&[b"__event_authority"]), false), AccountMeta::new_readonly(ps::DFS_PROGRAM_ID, false)] };
    send(svm, ix, &[funder]).expect("dfs fund");
}

fn init_ix(e: &Env, authority: Pubkey, stake_mint: Pubkey, idx: u8) -> Instruction {
    let (pool, _) = Pubkey::find_program_address(&[ps::POOL_SEED, stake_mint.as_ref()], &ps::ID);
    let (pd, _) = Pubkey::find_program_address(&[ps::ID.as_ref()], &bpf_loader_upgradeable::id());
    Instruction { program_id: ps::ID, data: ps::instruction::InitializePool { release_duration: 7 * DAY, cooldown: 7 * DAY, recipient_index: idx }.data(), accounts: ps::accounts::InitializePool {
        authority, program: ps::ID, program_data: pd, pool,
        stake_mint, reward_mint: WSOL,
        principal_vault: Pubkey::find_program_address(&[ps::PRINCIPAL_SEED, pool.as_ref()], &ps::ID).0,
        reward_vault: Pubkey::find_program_address(&[ps::REWARD_SEED, pool.as_ref()], &ps::ID).0,
        fee_vault: e.fee_vault, fee_token_vault: e.fee_token_vault, token_program: spl_token::id(), system_program: system_program::id() }.to_account_metas(None) }
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
    deploy(&mut svm, ps::ID, &so("PS_SO", "../target/deploy/pollen_staking.so"), Some(admin.pubkey()));
    deploy(&mut svm, ps::DFS_PROGRAM_ID, &so("DFS_SO", "fixtures/dfs.so"), None);
    put_mint(&mut svm, WSOL, None, None, 9);
    let stake_mint = Pubkey::new_unique();
    put_mint(&mut svm, stake_mint, None, None, 6);
    let (pool, _) = Pubkey::find_program_address(&[ps::POOL_SEED, stake_mint.as_ref()], &ps::ID);
    let (fee_vault, fee_token_vault) = create_fee_vault(&mut svm, &admin, &[(pool, 5_000), (Pubkey::new_unique(), 5_000)]);
    let principal = Pubkey::find_program_address(&[ps::PRINCIPAL_SEED, pool.as_ref()], &ps::ID).0;
    let reward = Pubkey::find_program_address(&[ps::REWARD_SEED, pool.as_ref()], &ps::ID).0;
    now(&mut svm, 1_000_000);
    Env { svm, admin, stake_mint, pool, principal, reward, fee_vault, fee_token_vault, dfs_event: dfs_pda(&[b"__event_authority"]) }
}

fn ready() -> Env { let mut e = setup(); let ix = init_ix(&e, e.admin.pubkey(), e.stake_mint, 0); let a = e.admin.insecure_clone(); send(&mut e.svm, ix, &[&a]).expect("init"); e }

fn user(e: &mut Env, amount: u64) -> (Keypair, Pubkey, Pubkey) {
    let k = Keypair::new(); e.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    let t = put_tok(&mut e.svm, e.stake_mint, k.pubkey(), amount); let r = put_tok(&mut e.svm, WSOL, k.pubkey(), 0);
    (k, t, r)
}
fn position(e: &Env, o: Pubkey) -> Pubkey { Pubkey::find_program_address(&[ps::POSITION_SEED, e.pool.as_ref(), o.as_ref()], &ps::ID).0 }
fn stake(e: &mut Env, k: &Keypair, t: Pubkey, amount: u64) -> Result<(), String> {
    let ix = Instruction { program_id: ps::ID, data: ps::instruction::Stake { amount }.data(), accounts: ps::accounts::Stake { owner: k.pubkey(), pool: e.pool, position: position(e, k.pubkey()), owner_token: t, principal_vault: e.principal, token_program: spl_token::id(), system_program: system_program::id() }.to_account_metas(None) };
    send(&mut e.svm, ix, &[k])
}
fn claim(e: &mut Env, k: &Keypair, r: Pubkey) -> Result<(), String> {
    let ix = Instruction { program_id: ps::ID, data: ps::instruction::Claim {}.data(), accounts: ps::accounts::Claim { owner: k.pubkey(), pool: e.pool, position: position(e, k.pubkey()), owner_reward: r, reward_vault: e.reward, token_program: spl_token::id() }.to_account_metas(None) };
    send(&mut e.svm, ix, &[k])
}
fn owner_ix(e: &mut Env, k: &Keypair, data: Vec<u8>) -> Result<(), String> {
    let ix = Instruction { program_id: ps::ID, data, accounts: ps::accounts::OwnerPosition { owner: k.pubkey(), pool: e.pool, position: position(e, k.pubkey()) }.to_account_metas(None) };
    send(&mut e.svm, ix, &[k])
}
fn withdraw(e: &mut Env, k: &Keypair, pos_owner: Pubkey, t: Pubkey) -> Result<(), String> {
    let ix = Instruction { program_id: ps::ID, data: ps::instruction::Withdraw {}.data(), accounts: ps::accounts::Withdraw { owner: k.pubkey(), pool: e.pool, position: position(e, pos_owner), owner_token: t, principal_vault: e.principal, token_program: spl_token::id() }.to_account_metas(None) };
    send(&mut e.svm, ix, &[k])
}
fn harvest_ix(e: &Env, caller: Pubkey, dfs: Pubkey) -> Instruction {
    Instruction { program_id: ps::ID, data: ps::instruction::HarvestFees {}.data(), accounts: ps::accounts::Harvest { caller, pool: e.pool, reward_vault: e.reward, reward_mint: WSOL, fee_vault: e.fee_vault, fee_token_vault: e.fee_token_vault, dfs_fee_vault_authority: ps::DFS_FEE_VAULT_AUTHORITY, dfs_event_authority: e.dfs_event, dfs_program: dfs, token_program: spl_token::id() }.to_account_metas(None) }
}
fn t0(e: &Env) -> i64 { e.svm.get_sysvar::<Clock>().unix_timestamp }

#[test]
fn only_upgrade_authority_initializes_once() {
    let mut e = setup();
    let imposter = Keypair::new(); e.svm.airdrop(&imposter.pubkey(), 10_000_000_000).unwrap();
    let ix = init_ix(&e, imposter.pubkey(), e.stake_mint, 0);
    assert!(send(&mut e.svm, ix, &[&imposter]).unwrap_err().contains("NotUpgradeAuthority"));
    let a = e.admin.insecure_clone();
    { let ix = init_ix(&e, a.pubkey(), e.stake_mint, 0); send(&mut e.svm, ix, &[&a]) }.unwrap();
    e.svm.expire_blockhash();
    assert!({ let ix = init_ix(&e, a.pubkey(), e.stake_mint, 0); send(&mut e.svm, ix, &[&a]) }.is_err(), "re-init rejected");
}

#[test]
fn rejects_freeze_authority_and_wrong_recipient() {
    let mut e = setup();
    let a = e.admin.insecure_clone();
    let frozen = Pubkey::new_unique(); put_mint(&mut e.svm, frozen, None, Some(a.pubkey()), 6);
    assert!({ let ix = init_ix(&e, a.pubkey(), frozen, 0); send(&mut e.svm, ix, &[&a]) }.unwrap_err().contains("FreezeAuthorityPresent"));
    let minty = Pubkey::new_unique(); put_mint(&mut e.svm, minty, Some(a.pubkey()), None, 6);
    assert!({ let ix = init_ix(&e, a.pubkey(), minty, 0); send(&mut e.svm, ix, &[&a]) }.unwrap_err().contains("MintAuthorityPresent"));
    // index 1 is someone else, not the pool PDA
    assert!({ let ix = init_ix(&e, a.pubkey(), e.stake_mint, 1); send(&mut e.svm, ix, &[&a]) }.unwrap_err().contains("BadRecipient"));
}

#[test]
fn harvest_rewards_late_joiner_and_double_claim() {
    let mut e = ready();
    let (alice, at, ar) = user(&mut e, 1_000);
    let (bob, bt, br) = user(&mut e, 1_000);
    stake(&mut e, &alice, at, 100).unwrap();
    let funder = e.admin.insecure_clone();
    let (fv, tv) = (e.fee_vault, e.fee_token_vault);
    dfs_fund(&mut e.svm, fv, tv, &funder, 2_000_000);
    // A direct donation to the reward vault is not tracked revenue.
    let donor = Keypair::new(); e.svm.airdrop(&donor.pubkey(), 1_000_000_000).unwrap();
    let don = put_tok(&mut e.svm, WSOL, donor.pubkey(), 777);
    let tix = spl_token::instruction::transfer(&spl_token::id(), &don, &e.reward, &donor.pubkey(), &[], 777).unwrap();
    send(&mut e.svm, tix, &[&donor]).unwrap();
    let caller = Keypair::new(); e.svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
    { let ix = harvest_ix(&e, caller.pubkey(), ps::DFS_PROGRAM_ID); send(&mut e.svm, ix, &[&caller]) }.unwrap();
    assert_eq!(bal(&e.svm, e.reward), 1_000_000 + 777, "pool PDA got its 50% share");
    let start = t0(&e);
    now(&mut e.svm, start + 7 * DAY / 2);
    stake(&mut e, &bob, bt, 100).unwrap();
    now(&mut e.svm, start + 7 * DAY);
    claim(&mut e, &alice, ar).unwrap();
    claim(&mut e, &bob, br).unwrap();
    assert_eq!(bal(&e.svm, ar), 750_000);
    assert_eq!(bal(&e.svm, br), 250_000);
    assert!(claim(&mut e, &alice, ar).unwrap_err().contains("NothingToClaim"), "double claim");
    assert_eq!(bal(&e.svm, e.reward), 777, "donation untouched and unallocated");
    // Nothing new in DFS: harvest fails instead of counting the donation.
    assert!({ let ix = harvest_ix(&e, caller.pubkey(), ps::DFS_PROGRAM_ID); send(&mut e.svm, ix, &[&caller]) }.is_err());
    // principal and reward vaults are separate
    assert_eq!(bal(&e.svm, e.principal), 200);
}

#[test]
fn unstake_cooldown_cancel_withdraw_and_wrong_signer() {
    let mut e = ready();
    let (alice, at, _) = user(&mut e, 1_000);
    let (mallory, mt, _) = user(&mut e, 0);
    assert!(stake(&mut e, &alice, at, 0).unwrap_err().contains("ZeroAmount"));
    assert!(stake(&mut e, &alice, at, 5_000).unwrap_err().contains("InsufficientBalance"));
    stake(&mut e, &alice, at, 400).unwrap();
    owner_ix(&mut e, &alice, ps::instruction::RequestUnstake { amount: 150 }.data()).unwrap();
    assert!(owner_ix(&mut e, &alice, ps::instruction::RequestUnstake { amount: 1 }.data()).unwrap_err().contains("PendingExists"));
    owner_ix(&mut e, &alice, ps::instruction::CancelUnstake {}.data()).unwrap();
    owner_ix(&mut e, &alice, ps::instruction::RequestUnstake { amount: 150 }.data()).unwrap();
    assert!(withdraw(&mut e, &alice, alice.pubkey(), at).unwrap_err().contains("Cooling"));
    // Mallory cannot withdraw Alice's lot (position PDA is bound to the signer).
    let s = t0(&e); now(&mut e.svm, s + 7 * DAY);
    assert!(withdraw(&mut e, &mallory, alice.pubkey(), mt).is_err());
    withdraw(&mut e, &alice, alice.pubkey(), at).unwrap();
    assert_eq!(bal(&e.svm, at), 750);
    assert_eq!(bal(&e.svm, e.principal), 250);
    e.svm.expire_blockhash();
    assert!(withdraw(&mut e, &alice, alice.pubkey(), at).unwrap_err().contains("NoPending"));
}

#[test]
fn harvest_rejects_wrong_program_and_exits_do_not_need_dfs() {
    let mut e = ready();
    let (alice, at, _) = user(&mut e, 10);
    stake(&mut e, &alice, at, 10).unwrap();
    let c = e.admin.insecure_clone();
    let fake = Pubkey::new_unique();
    assert!({ let ix = harvest_ix(&e, c.pubkey(), fake); send(&mut e.svm, ix, &[&c]) }.is_err());
    // Break DFS entirely: exits still work.
    e.svm.set_account(ps::DFS_PROGRAM_ID, Account { lamports: 1, data: vec![], owner: system_program::id(), executable: false, rent_epoch: 0 }).unwrap();
    assert!({ let ix = harvest_ix(&e, c.pubkey(), ps::DFS_PROGRAM_ID); send(&mut e.svm, ix, &[&c]) }.is_err());
    owner_ix(&mut e, &alice, ps::instruction::RequestUnstake { amount: 10 }.data()).unwrap();
    let s = t0(&e); now(&mut e.svm, s + 7 * DAY);
    withdraw(&mut e, &alice, alice.pubkey(), at).unwrap();
    assert_eq!(bal(&e.svm, at), 10);
}

#[test]
fn duplicate_signed_bytes_are_rejected() {
    let mut e = ready();
    let (alice, at, _) = user(&mut e, 10);
    let ix = Instruction { program_id: ps::ID, data: ps::instruction::Stake { amount: 5 }.data(), accounts: ps::accounts::Stake { owner: alice.pubkey(), pool: e.pool, position: position(&e, alice.pubkey()), owner_token: at, principal_vault: e.principal, token_program: spl_token::id(), system_program: system_program::id() }.to_account_metas(None) };
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&alice.pubkey()), &[&alice], e.svm.latest_blockhash());
    e.svm.send_transaction(tx.clone()).unwrap();
    assert!(e.svm.send_transaction(tx).is_err(), "resending identical bytes cannot double-stake");
    assert_eq!(bal(&e.svm, e.principal), 5);
}

fn ledger(e: &Env) -> ps::math::Ledger { ps::Pool::try_deserialize(&mut e.svm.get_account(&e.pool).unwrap().data.as_slice()).unwrap().ledger }
fn fund_treasury(e: &mut Env, k: &Keypair, src: Pubkey, amount: u64) -> Result<(), String> {
    let ix = Instruction { program_id: ps::ID, data: ps::instruction::FundTreasury { amount }.data(), accounts: ps::accounts::FundTreasury { funder: k.pubkey(), pool: e.pool, funder_token: src, reward_vault: e.reward, token_program: spl_token::id() }.to_account_metas(None) };
    send(&mut e.svm, ix, &[k])
}
fn poke(e: &mut Env, k: &Keypair) -> Result<(), String> {
    let ix = Instruction { program_id: ps::ID, data: ps::instruction::ReleaseUnallocated {}.data(), accounts: ps::accounts::Poke { pool: e.pool }.to_account_metas(None) };
    send(&mut e.svm, ix, &[k])
}
fn edit(svm: &mut LiteSVM, k: Pubkey, f: impl FnOnce(&mut Vec<u8>)) { let mut a = svm.get_account(&k).unwrap(); f(&mut a.data); svm.set_account(k, a).unwrap(); }

#[test]
fn tiny_topups_cannot_delay_rewards_compiled() {
    let mut e = ready();
    let (alice, at, ar) = user(&mut e, 100);
    stake(&mut e, &alice, at, 100).unwrap();
    let griefer = Keypair::new(); e.svm.airdrop(&griefer.pubkey(), 10_000_000_000).unwrap();
    let src = put_tok(&mut e.svm, WSOL, griefer.pubkey(), 2_000_000);
    let start = t0(&e);
    fund_treasury(&mut e, &griefer, src, 1_000_000).unwrap();
    let deadline = ledger(&e).stream_end;
    assert_eq!(deadline, start + 7 * DAY);
    let mut n = 0u64;
    for h in 1..(7 * 24) { now(&mut e.svm, start + h * 3_600); fund_treasury(&mut e, &griefer, src, 1).unwrap(); let _ = poke(&mut e, &griefer); n += 1; }
    assert_eq!(ledger(&e).stream_end, deadline, "deadline never moves while the window is open");
    now(&mut e.svm, deadline);
    claim(&mut e, &alice, ar).unwrap();
    assert_eq!(bal(&e.svm, ar), 1_000_000 + n, "old tranche and top-ups fully released by the old deadline");
    // Window ended: a new funding opens a fresh immutable-length window.
    now(&mut e.svm, deadline + DAY);
    fund_treasury(&mut e, &griefer, src, 70).unwrap();
    assert_eq!(ledger(&e).stream_end, deadline + DAY + 7 * DAY);
}

#[test]
fn zero_delta_harvest_does_not_reset_timing() {
    let mut e = ready();
    let (alice, at, _) = user(&mut e, 10); stake(&mut e, &alice, at, 10).unwrap();
    let f = e.admin.insecure_clone(); let (fv, tv) = (e.fee_vault, e.fee_token_vault);
    dfs_fund(&mut e.svm, fv, tv, &f, 2_000);
    { let ix = harvest_ix(&e, f.pubkey(), ps::DFS_PROGRAM_ID); send(&mut e.svm, ix, &[&f]) }.unwrap();
    let before = ledger(&e); let s = t0(&e);
    now(&mut e.svm, s + DAY);
    let r = { let ix = harvest_ix(&e, f.pubkey(), ps::DFS_PROGRAM_ID); send(&mut e.svm, ix, &[&f]) };
    assert!(r.is_err(), "zero-delta harvest fails");
    let after = ledger(&e);
    assert_eq!((after.stream_start, after.stream_end, after.stream_amount), (before.stream_start, before.stream_end, before.stream_amount));
    assert_eq!(after.dfs_funded_total, 1_000);
}

#[test]
fn keypair_or_tampered_fee_vaults_are_rejected() {
    let mut e = setup();
    let a = e.admin.insecure_clone();
    // Legacy keypair vault naming the pool: rejected (not the PDA routing source).
    let (kfv, ktv) = create_keypair_fee_vault(&mut e.svm, &a, &[(e.pool, 5_000), (Pubkey::new_unique(), 5_000)]);
    let (good_fv, good_tv) = (e.fee_vault, e.fee_token_vault);
    e.fee_vault = kfv; e.fee_token_vault = ktv;
    assert!({ let ix = init_ix(&e, a.pubkey(), e.stake_mint, 0); send(&mut e.svm, ix, &[&a]) }.unwrap_err().contains("BadFeeVault"));
    e.fee_vault = good_fv; e.fee_token_vault = good_tv;
    let orig = e.svm.get_account(&good_fv).unwrap();
    for (off, val) in [(105usize, 0u8), (104, 1), (106, orig.data[106].wrapping_add(1))] {
        edit(&mut e.svm, good_fv, |d| d[off] = val);
        let r = { let ix = init_ix(&e, a.pubkey(), e.stake_mint, 0); send(&mut e.svm, ix, &[&a]) };
        assert!(r.unwrap_err().contains("BadFeeVault"), "byte {off} tamper must be rejected");
        e.svm.set_account(good_fv, orig.clone()).unwrap();
    }
    // Base pubkey changed -> PDA no longer canonical.
    edit(&mut e.svm, good_fv, |d| d[152] ^= 1);
    assert!({ let ix = init_ix(&e, a.pubkey(), e.stake_mint, 0); send(&mut e.svm, ix, &[&a]) }.unwrap_err().contains("BadFeeVault"));
    e.svm.set_account(good_fv, orig).unwrap();
    { let ix = init_ix(&e, a.pubkey(), e.stake_mint, 0); send(&mut e.svm, ix, &[&a]) }.unwrap();
}

#[test]
fn vault_custody_is_checked_everywhere() {
    let mut e = ready();
    let (alice, at, ar) = user(&mut e, 100);
    stake(&mut e, &alice, at, 50).unwrap();
    let f = e.admin.insecure_clone(); let (fv, tv) = (e.fee_vault, e.fee_token_vault);
    dfs_fund(&mut e.svm, fv, tv, &f, 2_000);
    // Reward vault with a delegate: harvest refuses before any CPI; claim refuses too.
    let orig = e.svm.get_account(&e.reward).unwrap();
    let reward = e.reward;
    edit(&mut e.svm, reward, |d| { let mut t = TokAcc::unpack(d).unwrap(); t.delegate = COption::Some(Pubkey::new_unique()); t.delegated_amount = 1; t.pack_into_slice(d); });
    assert!({ let ix = harvest_ix(&e, f.pubkey(), ps::DFS_PROGRAM_ID); send(&mut e.svm, ix, &[&f]) }.unwrap_err().contains("BadVault"));
    assert!(claim(&mut e, &alice, ar).is_err());
    // Close authority / frozen are rejected as well.
    e.svm.set_account(reward, orig.clone()).unwrap();
    edit(&mut e.svm, reward, |d| { let mut t = TokAcc::unpack(d).unwrap(); t.close_authority = COption::Some(Pubkey::new_unique()); t.pack_into_slice(d); });
    assert!({ let ix = harvest_ix(&e, f.pubkey(), ps::DFS_PROGRAM_ID); send(&mut e.svm, ix, &[&f]) }.unwrap_err().contains("BadVault"));
    e.svm.set_account(reward, orig).unwrap();
    { let ix = harvest_ix(&e, f.pubkey(), ps::DFS_PROGRAM_ID); send(&mut e.svm, ix, &[&f]) }.unwrap();
    // Principal vault with a delegate: stake and withdraw refuse.
    let principal = e.principal;
    let porig = e.svm.get_account(&principal).unwrap();
    edit(&mut e.svm, principal, |d| { let mut t = TokAcc::unpack(d).unwrap(); t.state = AccountState::Frozen; t.pack_into_slice(d); });
    assert!(stake(&mut e, &alice, at, 1).is_err());
    e.svm.set_account(principal, porig).unwrap();
    stake(&mut e, &alice, at, 1).unwrap();
    // A swapped vault (principal passed as reward) is rejected.
    let ix = Instruction { program_id: ps::ID, data: ps::instruction::Claim {}.data(), accounts: ps::accounts::Claim { owner: alice.pubkey(), pool: e.pool, position: position(&e, alice.pubkey()), owner_reward: ar, reward_vault: e.principal, token_program: spl_token::id() }.to_account_metas(None) };
    assert!(send(&mut e.svm, ix, &[&alice]).is_err());
}
