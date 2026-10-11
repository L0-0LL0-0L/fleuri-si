//! Pollen Staking: stake a fixed SPL mint, earn wrapped SOL that was actually collected.
//!
//! Security properties (see docs/launchpad/pollen-staking.md):
//! * Only the program's upgrade authority can initialize a pool (no first-initializer hijack).
//! * Stake mint, reward mint (wSOL), fee source, release duration and cooldown are fixed at
//!   initialization. There is no admin instruction that moves principal or user rewards.
//! * Exits (request/cancel/withdraw) never call an external program.
//! * Fee harvest is a single whitelisted CPI to Meteora Dynamic Fee Sharing `claim_fee`, signed
//!   by the pool PDA, crediting only the measured reward-vault increase.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod math;
use math::{Ledger, MathError, PositionState};

// Placeholder for local builds and tests only. NOT a deployed program. Run `anchor keys sync`
// with your own deploy keypair before any deployment.
declare_id!("59vLvCAQFHcZg3eYC4ehKQQKeWysUPTS1iQANPzJHQmk");

pub const DFS_PROGRAM_ID: Pubkey = pubkey!("dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh");
pub const DFS_FEE_VAULT_AUTHORITY: Pubkey = pubkey!("EYqHRdtepv1KKUkPAYMBYpSfiGfNd8sa55ZtswodTfBS");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// dynamic_fee_sharing 0.1.2 (SDK 1.1.0) `claim_fee(index: u8)` discriminator.
pub const DFS_CLAIM_FEE_IX: [u8; 8] = [169, 32, 79, 137, 136, 232, 70, 137];
/// dynamic_fee_sharing `FeeVault` account discriminator.
pub const DFS_FEE_VAULT_DISC: [u8; 8] = [192, 178, 69, 232, 58, 149, 157, 132];
pub const FEE_VAULT_LEN: usize = 8 + 240 + 5 * 80;
pub const MIN_TERM: i64 = 3_600;
pub const MAX_TERM: i64 = 365 * 86_400;

pub const POOL_SEED: &[u8] = b"pool";
pub const PRINCIPAL_SEED: &[u8] = b"principal";
pub const REWARD_SEED: &[u8] = b"reward";
pub const POSITION_SEED: &[u8] = b"position";

#[program]
pub mod pollen_staking {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, release_duration: i64, cooldown: i64, recipient_index: u8) -> Result<()> {
        require!((MIN_TERM..=MAX_TERM).contains(&release_duration) && (MIN_TERM..=MAX_TERM).contains(&cooldown), E::BadTerms);
        let pool_key = ctx.accounts.pool.key();
        check_fee_vault(&ctx.accounts.fee_vault, &ctx.accounts.fee_token_vault.key(), &pool_key, recipient_index)?;
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.pool;
        p.initializer = ctx.accounts.authority.key();
        p.stake_mint = ctx.accounts.stake_mint.key();
        p.reward_mint = WSOL_MINT;
        p.principal_vault = ctx.accounts.principal_vault.key();
        p.reward_vault = ctx.accounts.reward_vault.key();
        p.fee_vault = ctx.accounts.fee_vault.key();
        p.fee_token_vault = ctx.accounts.fee_token_vault.key();
        p.recipient_index = recipient_index;
        p.bump = ctx.bumps.pool;
        p.ledger = Ledger::new(release_duration, cooldown, now);
        emit!(PoolInitialized { pool: pool_key, stake_mint: p.stake_mint, fee_vault: p.fee_vault, release_duration, cooldown });
        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, E::ZeroAmount);
        require!(ctx.accounts.owner_token.amount >= amount, E::InsufficientBalance);
        let now = Clock::get()?.unix_timestamp;
        let pos = &mut ctx.accounts.position;
        if pos.owner == Pubkey::default() { pos.pool = ctx.accounts.pool.key(); pos.owner = ctx.accounts.owner.key(); pos.bump = ctx.bumps.position; pos.state.checkpoint = ctx.accounts.pool.ledger.acc_per_share; }
        math::stake(&mut ctx.accounts.pool.ledger, &mut pos.state, amount, now).map_err(err)?;
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.owner_token.to_account_info(), to: ctx.accounts.principal_vault.to_account_info(), authority: ctx.accounts.owner.to_account_info() }), amount)?;
        emit!(Staked { pool: ctx.accounts.pool.key(), owner: pos.owner, amount, active: pos.state.active });
        Ok(())
    }

    pub fn request_unstake(ctx: Context<OwnerPosition>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pos = &mut ctx.accounts.position;
        let unlock_ts = math::request_unstake(&mut ctx.accounts.pool.ledger, &mut pos.state, amount, now).map_err(err)?;
        emit!(UnstakeRequested { pool: pos.pool, owner: pos.owner, amount, unlock_ts });
        Ok(())
    }

    pub fn cancel_unstake(ctx: Context<OwnerPosition>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pos = &mut ctx.accounts.position;
        let amount = math::cancel_unstake(&mut ctx.accounts.pool.ledger, &mut pos.state, now).map_err(err)?;
        emit!(UnstakeCancelled { pool: pos.pool, owner: pos.owner, amount });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let amount = math::withdraw(&mut ctx.accounts.position.state, now).map_err(err)?;
        let pool = &ctx.accounts.pool;
        let seeds: &[&[u8]] = &[POOL_SEED, pool.stake_mint.as_ref(), &[pool.bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.principal_vault.to_account_info(), to: ctx.accounts.owner_token.to_account_info(), authority: pool.to_account_info() }, &[seeds]), amount)?;
        emit!(Withdrawn { pool: pool.key(), owner: ctx.accounts.owner.key(), amount });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let amount = math::claim(&mut ctx.accounts.pool.ledger, &mut ctx.accounts.position.state, now).map_err(err)?;
        let pool = &ctx.accounts.pool;
        let seeds: &[&[u8]] = &[POOL_SEED, pool.stake_mint.as_ref(), &[pool.bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.reward_vault.to_account_info(), to: ctx.accounts.owner_reward.to_account_info(), authority: pool.to_account_info() }, &[seeds]), amount)?;
        emit!(Claimed { pool: pool.key(), owner: ctx.accounts.owner.key(), amount });
        Ok(())
    }

    /// Permissionless. Claims this pool's share from the one configured DFS vault.
    pub fn harvest_fees(ctx: Context<Harvest>) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let (stake_mint, bump, idx) = (ctx.accounts.pool.stake_mint, ctx.accounts.pool.bump, ctx.accounts.pool.recipient_index);
        check_fee_vault(&ctx.accounts.fee_vault, &ctx.accounts.fee_token_vault.key(), &pool_key, idx)?;
        let before = ctx.accounts.reward_vault.amount;
        let a = &ctx.accounts;
        let ix = Instruction {
            program_id: DFS_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(a.fee_vault.key(), false),
                AccountMeta::new_readonly(DFS_FEE_VAULT_AUTHORITY, false),
                AccountMeta::new(a.fee_token_vault.key(), false),
                AccountMeta::new_readonly(WSOL_MINT, false),
                AccountMeta::new(a.reward_vault.key(), false),
                AccountMeta::new_readonly(pool_key, true),
                AccountMeta::new_readonly(token::ID, false),
                AccountMeta::new_readonly(a.dfs_event_authority.key(), false),
                AccountMeta::new_readonly(DFS_PROGRAM_ID, false),
            ],
            data: [DFS_CLAIM_FEE_IX.as_slice(), &[idx]].concat(),
        };
        let seeds: &[&[u8]] = &[POOL_SEED, stake_mint.as_ref(), &[bump]];
        invoke_signed(&ix, &[a.fee_vault.to_account_info(), a.dfs_fee_vault_authority.to_account_info(), a.fee_token_vault.to_account_info(), a.reward_mint.to_account_info(), a.reward_vault.to_account_info(), a.pool.to_account_info(), a.token_program.to_account_info(), a.dfs_event_authority.to_account_info(), a.dfs_program.to_account_info()], &[seeds])?;
        ctx.accounts.reward_vault.reload()?;
        let got = ctx.accounts.reward_vault.amount.checked_sub(before).ok_or(E::Overflow)?;
        require!(got > 0, E::NothingToHarvest);
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.pool.ledger.fund(got, true, now).map_err(err)?;
        emit!(FeesHarvested { pool: pool_key, fee_vault: ctx.accounts.fee_vault.key(), amount: got });
        Ok(())
    }

    /// Treasury funding: tracked separately and never labelled as verified Meteora fees.
    pub fn fund_treasury(ctx: Context<FundTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, E::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.pool.ledger.fund(amount, false, now).map_err(err)?;
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.funder_token.to_account_info(), to: ctx.accounts.reward_vault.to_account_info(), authority: ctx.accounts.funder.to_account_info() }), amount)?;
        emit!(TreasuryFunded { pool: ctx.accounts.pool.key(), funder: ctx.accounts.funder.key(), amount });
        Ok(())
    }

    /// Permissionless. Re-streams rewards released while nobody was staked.
    pub fn release_unallocated(ctx: Context<Poke>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let amount = ctx.accounts.pool.ledger.release_unallocated(now).map_err(err)?;
        emit!(UnallocatedReleased { pool: ctx.accounts.pool.key(), amount });
        Ok(())
    }
}

fn err(e: MathError) -> Error {
    match e { MathError::Overflow => E::Overflow, MathError::Zero => E::ZeroAmount, MathError::Insufficient => E::InsufficientBalance, MathError::PendingExists => E::PendingExists, MathError::NoPending => E::NoPending, MathError::Cooling => E::Cooling, MathError::NoStake => E::NoStake, MathError::Nothing => E::NothingToClaim }.into()
}

/// Validates the DFS fee vault: owner program, discriminator, wSOL mint, token vault, and that
/// `users[index]` is exactly this pool PDA with a positive share.
pub fn check_fee_vault(fv: &UncheckedAccount, fee_token_vault: &Pubkey, pool: &Pubkey, index: u8) -> Result<()> {
    require_keys_eq!(*fv.owner, DFS_PROGRAM_ID, E::BadFeeVault);
    let d = fv.try_borrow_data()?;
    require!(d.len() >= FEE_VAULT_LEN && d[..8] == DFS_FEE_VAULT_DISC, E::BadFeeVault);
    let key = |o: usize| Pubkey::try_from(&d[o..o + 32]).unwrap();
    require_keys_eq!(key(40), WSOL_MINT, E::BadFeeVault);
    require_keys_eq!(key(72), *fee_token_vault, E::BadFeeVault);
    require!(index < 5, E::BadRecipient);
    let u = 248 + index as usize * 80;
    require_keys_eq!(key(u), *pool, E::BadRecipient);
    require!(u32::from_le_bytes(d[u + 32..u + 36].try_into().unwrap()) > 0, E::BadRecipient);
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub initializer: Pubkey,
    pub stake_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub principal_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub fee_vault: Pubkey,
    pub fee_token_vault: Pubkey,
    pub recipient_index: u8,
    pub bump: u8,
    pub ledger: Ledger,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub bump: u8,
    pub state: PositionState,
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ E::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::PollenStaking>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ E::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED, stake_mint.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    #[account(constraint = stake_mint.mint_authority.is_none() @ E::MintAuthorityPresent, constraint = stake_mint.freeze_authority.is_none() @ E::FreezeAuthorityPresent, constraint = stake_mint.key() != WSOL_MINT @ E::BadMint)]
    pub stake_mint: Account<'info, Mint>,
    #[account(address = WSOL_MINT @ E::BadMint)]
    pub reward_mint: Account<'info, Mint>,
    #[account(init, payer = authority, seeds = [PRINCIPAL_SEED, pool.key().as_ref()], bump, token::mint = stake_mint, token::authority = pool)]
    pub principal_vault: Account<'info, TokenAccount>,
    #[account(init, payer = authority, seeds = [REWARD_SEED, pool.key().as_ref()], bump, token::mint = reward_mint, token::authority = pool)]
    pub reward_vault: Account<'info, TokenAccount>,
    /// CHECK: validated byte-for-byte in `check_fee_vault`.
    pub fee_vault: UncheckedAccount<'info>,
    #[account(token::mint = reward_mint, token::authority = DFS_FEE_VAULT_AUTHORITY)]
    pub fee_token_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(init_if_needed, payer = owner, space = 8 + Position::INIT_SPACE, seeds = [POSITION_SEED, pool.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = pool.stake_mint, token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(mut, address = pool.principal_vault @ E::BadVault)]
    pub principal_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerPosition<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [POSITION_SEED, pool.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner @ E::WrongOwner, has_one = pool @ E::WrongOwner)]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [POOL_SEED, pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [POSITION_SEED, pool.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner @ E::WrongOwner, has_one = pool @ E::WrongOwner)]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = pool.stake_mint, token::authority = owner, constraint = owner_token.delegate.is_none() && owner_token.close_authority.is_none() @ E::DelegatedDestination)]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(mut, address = pool.principal_vault @ E::BadVault)]
    pub principal_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [POSITION_SEED, pool.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner @ E::WrongOwner, has_one = pool @ E::WrongOwner)]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = WSOL_MINT, token::authority = owner, constraint = owner_reward.delegate.is_none() && owner_reward.close_authority.is_none() @ E::DelegatedDestination)]
    pub owner_reward: Account<'info, TokenAccount>,
    #[account(mut, address = pool.reward_vault @ E::BadVault)]
    pub reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Harvest<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, address = pool.reward_vault @ E::BadVault)]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(address = WSOL_MINT @ E::BadMint)]
    pub reward_mint: Account<'info, Mint>,
    /// CHECK: must equal the fixed source and is re-validated in `check_fee_vault`.
    #[account(mut, address = pool.fee_vault @ E::BadFeeVault)]
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(mut, address = pool.fee_token_vault @ E::BadFeeVault)]
    pub fee_token_vault: UncheckedAccount<'info>,
    /// CHECK: fixed DFS constant.
    #[account(address = DFS_FEE_VAULT_AUTHORITY @ E::BadProgram)]
    pub dfs_fee_vault_authority: UncheckedAccount<'info>,
    /// CHECK: DFS Anchor event authority PDA.
    #[account(seeds = [b"__event_authority"], bump, seeds::program = DFS_PROGRAM_ID)]
    pub dfs_event_authority: UncheckedAccount<'info>,
    /// CHECK: whitelisted program id; must be executable.
    #[account(address = DFS_PROGRAM_ID @ E::BadProgram, constraint = dfs_program.executable @ E::BadProgram)]
    pub dfs_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FundTreasury<'info> {
    pub funder: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, token::mint = WSOL_MINT, token::authority = funder)]
    pub funder_token: Account<'info, TokenAccount>,
    #[account(mut, address = pool.reward_vault @ E::BadVault)]
    pub reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Poke<'info> {
    #[account(mut, seeds = [POOL_SEED, pool.stake_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

#[event] pub struct PoolInitialized { pub pool: Pubkey, pub stake_mint: Pubkey, pub fee_vault: Pubkey, pub release_duration: i64, pub cooldown: i64 }
#[event] pub struct Staked { pub pool: Pubkey, pub owner: Pubkey, pub amount: u64, pub active: u64 }
#[event] pub struct UnstakeRequested { pub pool: Pubkey, pub owner: Pubkey, pub amount: u64, pub unlock_ts: i64 }
#[event] pub struct UnstakeCancelled { pub pool: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event] pub struct Withdrawn { pub pool: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event] pub struct Claimed { pub pool: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event] pub struct FeesHarvested { pub pool: Pubkey, pub fee_vault: Pubkey, pub amount: u64 }
#[event] pub struct TreasuryFunded { pub pool: Pubkey, pub funder: Pubkey, pub amount: u64 }
#[event] pub struct UnallocatedReleased { pub pool: Pubkey, pub amount: u64 }

#[error_code]
pub enum E {
    #[msg("Signer is not the program upgrade authority")] NotUpgradeAuthority,
    #[msg("Stake mint still has a mint authority")] MintAuthorityPresent,
    #[msg("Stake mint still has a freeze authority")] FreezeAuthorityPresent,
    #[msg("Wrong mint")] BadMint,
    #[msg("Release duration and cooldown must be between 1 hour and 365 days")] BadTerms,
    #[msg("Fee vault is not the configured Dynamic Fee Sharing wSOL vault")] BadFeeVault,
    #[msg("Pool PDA is not the fee vault recipient at this index")] BadRecipient,
    #[msg("Wrong program")] BadProgram,
    #[msg("Wrong vault")] BadVault,
    #[msg("Wrong position owner")] WrongOwner,
    #[msg("Destination has a delegate or close authority")] DelegatedDestination,
    #[msg("Amount must be greater than zero")] ZeroAmount,
    #[msg("Insufficient balance")] InsufficientBalance,
    #[msg("A withdrawal is already pending")] PendingExists,
    #[msg("No pending withdrawal")] NoPending,
    #[msg("Cooldown has not ended")] Cooling,
    #[msg("No active stake")] NoStake,
    #[msg("Nothing to claim")] NothingToClaim,
    #[msg("Harvest received nothing")] NothingToHarvest,
    #[msg("Arithmetic overflow")] Overflow,
}
