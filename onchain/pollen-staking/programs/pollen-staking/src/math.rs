//! Pure, integer-only reward accounting. No floating point, every op checked.
//!
//! * Rewards come only from tracked funding (`fund`): verified Meteora fee harvests or
//!   separately labelled treasury funding. Direct token donations never enter the ledger.
//! * Each funding restarts a linear stream of (unreleased remainder + new amount) over the fixed
//!   `duration`. Released amounts are cumulative integer vests, not rounded per-second rates.
//! * Released rewards are distributed with a Q64 accumulator. The undistributed numerator
//!   (`carry`) and per-position fractions (`frac`) are kept, so rounding dust is never lost.
//! * When nobody is staked, released rewards go to `unallocated` and can be re-streamed later
//!   (`release_unallocated`) once stake exists.
use anchor_lang::prelude::*;

pub const Q: u32 = 64;
const MASK: u128 = u64::MAX as u128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError { Overflow, Zero, Insufficient, PendingExists, NoPending, Cooling, NoStake, Nothing }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq, InitSpace)]
pub struct Ledger {
    pub duration: i64,
    pub cooldown: i64,
    pub total_active: u64,
    pub acc_per_share: u128,
    pub carry: u128,
    pub stream_amount: u64,
    pub stream_start: i64,
    pub stream_released: u64,
    pub unallocated: u64,
    pub last_update: i64,
    pub verified_fees_total: u64,
    pub treasury_total: u64,
    pub distributed_total: u64,
    pub claimed_total: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq, InitSpace)]
pub struct PositionState {
    pub active: u64,
    pub checkpoint: u128,
    pub frac: u128,
    pub owed: u64,
    pub pending_amount: u64,
    pub unlock_ts: i64,
    pub claimed_total: u64,
}

fn add(a: u64, b: u64) -> std::result::Result<u64, MathError> { a.checked_add(b).ok_or(MathError::Overflow) }
fn sub(a: u64, b: u64) -> std::result::Result<u64, MathError> { a.checked_sub(b).ok_or(MathError::Insufficient) }

impl Ledger {
    pub fn new(duration: i64, cooldown: i64, now: i64) -> Self { Ledger { duration, cooldown, stream_start: now, last_update: now, ..Default::default() } }

    /// Cumulative vested amount of the current stream at `now`.
    pub fn vested(&self, now: i64) -> u64 {
        let el = (now - self.stream_start).clamp(0, self.duration) as u128;
        ((self.stream_amount as u128 * el) / self.duration as u128) as u64
    }

    pub fn update(&mut self, now: i64) -> std::result::Result<(), MathError> {
        let v = self.vested(now);
        let delta = v.checked_sub(self.stream_released).ok_or(MathError::Overflow)?;
        self.stream_released = v;
        if delta > 0 {
            if self.total_active == 0 {
                self.unallocated = add(self.unallocated, delta)?;
            } else {
                let num = ((delta as u128) << Q).checked_add(self.carry).ok_or(MathError::Overflow)?;
                let t = self.total_active as u128;
                self.acc_per_share = self.acc_per_share.checked_add(num / t).ok_or(MathError::Overflow)?;
                self.carry = num % t;
                self.distributed_total = add(self.distributed_total, delta)?;
            }
        }
        if now > self.last_update { self.last_update = now; }
        Ok(())
    }

    fn restream(&mut self, extra: u64, now: i64) -> std::result::Result<(), MathError> {
        let remaining = sub(self.stream_amount, self.stream_released)?;
        self.stream_amount = add(remaining, extra)?;
        self.stream_start = now;
        self.stream_released = 0;
        Ok(())
    }

    /// Adds actually received funds. `verified` = measured Meteora fee harvest; else treasury.
    pub fn fund(&mut self, amount: u64, verified: bool, now: i64) -> std::result::Result<(), MathError> {
        if amount == 0 { return Err(MathError::Zero); }
        self.update(now)?;
        if verified { self.verified_fees_total = add(self.verified_fees_total, amount)?; } else { self.treasury_total = add(self.treasury_total, amount)?; }
        self.restream(amount, now)
    }

    /// Re-streams rewards released while nobody was staked. Permissionless; needs active stake.
    pub fn release_unallocated(&mut self, now: i64) -> std::result::Result<u64, MathError> {
        self.update(now)?;
        if self.total_active == 0 { return Err(MathError::NoStake); }
        let u = self.unallocated;
        if u == 0 { return Err(MathError::Nothing); }
        self.unallocated = 0;
        self.restream(u, now)?;
        Ok(u)
    }

    /// Tokens the reward vault must hold for all current and future obligations.
    pub fn liabilities_upper_bound(&self) -> u64 {
        (self.verified_fees_total as u128 + self.treasury_total as u128 - self.claimed_total as u128) as u64
    }
}

impl PositionState {
    pub fn settle(&mut self, acc: u128) -> std::result::Result<(), MathError> {
        let d = acc.checked_sub(self.checkpoint).ok_or(MathError::Overflow)?;
        let num = (self.active as u128).checked_mul(d).ok_or(MathError::Overflow)?.checked_add(self.frac).ok_or(MathError::Overflow)?;
        let whole = u64::try_from(num >> Q).map_err(|_| MathError::Overflow)?;
        self.owed = add(self.owed, whole)?;
        self.frac = num & MASK;
        self.checkpoint = acc;
        Ok(())
    }
    /// Exact claimable at `now` without mutating (for clients / view).
    pub fn preview(&self, l: &Ledger, now: i64) -> std::result::Result<u64, MathError> {
        let (mut l2, mut p2) = (*l, *self);
        l2.update(now)?; p2.settle(l2.acc_per_share)?; Ok(p2.owed)
    }
}

pub fn stake(l: &mut Ledger, p: &mut PositionState, amount: u64, now: i64) -> std::result::Result<(), MathError> {
    if amount == 0 { return Err(MathError::Zero); }
    l.update(now)?; p.settle(l.acc_per_share)?;
    p.active = add(p.active, amount)?; l.total_active = add(l.total_active, amount)?;
    Ok(())
}

/// Stops earning immediately. Only one pending lot, so an existing cooldown is never extended.
pub fn request_unstake(l: &mut Ledger, p: &mut PositionState, amount: u64, now: i64) -> std::result::Result<i64, MathError> {
    if amount == 0 { return Err(MathError::Zero); }
    if p.pending_amount > 0 { return Err(MathError::PendingExists); }
    if amount > p.active { return Err(MathError::Insufficient); }
    l.update(now)?; p.settle(l.acc_per_share)?;
    p.active -= amount; l.total_active = sub(l.total_active, amount)?;
    p.pending_amount = amount;
    p.unlock_ts = now.checked_add(l.cooldown).ok_or(MathError::Overflow)?;
    Ok(p.unlock_ts)
}

pub fn cancel_unstake(l: &mut Ledger, p: &mut PositionState, now: i64) -> std::result::Result<u64, MathError> {
    let a = p.pending_amount;
    if a == 0 { return Err(MathError::NoPending); }
    l.update(now)?; p.settle(l.acc_per_share)?;
    p.active = add(p.active, a)?; l.total_active = add(l.total_active, a)?;
    p.pending_amount = 0; p.unlock_ts = 0;
    Ok(a)
}

/// Pure ledger step; never depends on fee collection or any external program.
pub fn withdraw(p: &mut PositionState, now: i64) -> std::result::Result<u64, MathError> {
    let a = p.pending_amount;
    if a == 0 { return Err(MathError::NoPending); }
    if now < p.unlock_ts { return Err(MathError::Cooling); }
    p.pending_amount = 0; p.unlock_ts = 0;
    Ok(a)
}

pub fn claim(l: &mut Ledger, p: &mut PositionState, now: i64) -> std::result::Result<u64, MathError> {
    l.update(now)?; p.settle(l.acc_per_share)?;
    let a = p.owed;
    if a == 0 { return Err(MathError::Nothing); }
    p.owed = 0;
    p.claimed_total = add(p.claimed_total, a)?;
    l.claimed_total = add(l.claimed_total, a)?;
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    const D: i64 = 7 * 86_400;
    fn l0() -> Ledger { Ledger::new(D, D, 0) }
    fn owed(l: &Ledger, p: &PositionState, t: i64) -> u64 { p.preview(l, t).unwrap() }

    #[test] fn proportional_and_conserved() {
        let mut l = l0(); let (mut a, mut b, mut c) = Default::default();
        stake(&mut l, &mut a, 1_000, 0).unwrap(); stake(&mut l, &mut b, 2_000, 0).unwrap(); stake(&mut l, &mut c, 7, 0).unwrap();
        l.fund(1_000_000_007, true, 0).unwrap();
        let (x, y, z) = (owed(&l, &a, D), owed(&l, &b, D), owed(&l, &c, D));
        assert!(x + y + z <= 1_000_000_007);
        assert!(1_000_000_007 - (x + y + z) <= 3, "dust bounded");
        assert!((y as i128 - 2 * x as i128).abs() <= 2);
    }
    #[test] fn late_joiner_gets_nothing_prior() {
        let mut l = l0(); let (mut a, mut b) = Default::default();
        stake(&mut l, &mut a, 100, 0).unwrap(); l.fund(700, true, 0).unwrap();
        stake(&mut l, &mut b, 100, D / 2).unwrap();
        assert_eq!(owed(&l, &b, D / 2), 0);
        assert_eq!(owed(&l, &a, D / 2), 350);
        assert_eq!(owed(&l, &a, D) + owed(&l, &b, D), 700);
        assert_eq!(owed(&l, &b, D), 175);
    }
    #[test] fn fractions_survive_stake_changes() {
        let mut l = l0(); let (mut a, mut b) = Default::default();
        stake(&mut l, &mut a, 3, 0).unwrap(); stake(&mut l, &mut b, 3, 0).unwrap();
        l.fund(1, true, 0).unwrap();
        // each earns 0.5 over the stream; repeated tiny stake changes must not erase fractions
        for t in 1..10 { stake(&mut l, &mut a, 0 + 1, t * 1000).ok(); request_unstake(&mut l, &mut a, 1, t * 1000 + 1).unwrap(); withdraw(&mut a, i64::MAX).unwrap(); }
        let s = owed(&l, &a, D * 2) + owed(&l, &b, D * 2);
        assert!(s <= 1); let mut l2 = l; let mut a2 = a; let mut b2 = b; l2.update(D * 2).unwrap(); a2.settle(l2.acc_per_share).unwrap(); b2.settle(l2.acc_per_share).unwrap();
        // total value conserved including fractions and carry
        let total_q = ((a2.owed as u128 + b2.owed as u128) << 64) + a2.frac + b2.frac + l2.carry;
        assert_eq!(total_q, 1u128 << 64);
    }
    #[test] fn zero_stake_funding_is_unallocated_then_released() {
        let mut l = l0(); let mut a = PositionState::default();
        l.fund(1_000, true, 0).unwrap(); l.update(D).unwrap();
        assert_eq!(l.unallocated, 1_000);
        assert_eq!(l.release_unallocated(D), Err(MathError::NoStake));
        stake(&mut l, &mut a, 5, D).unwrap();
        assert_eq!(l.release_unallocated(D).unwrap(), 1_000);
        assert_eq!(owed(&l, &a, 2 * D), 1_000);
    }
    #[test] fn staggered_release_and_refill_preserves_accrued() {
        let mut l = l0(); let mut a = PositionState::default();
        stake(&mut l, &mut a, 10, 0).unwrap();
        l.fund(700, true, 0).unwrap();
        assert_eq!(owed(&l, &a, D / 7), 100);
        l.fund(600, false, D / 7).unwrap(); // refill: remaining 600 + 600 restreamed
        assert_eq!(owed(&l, &a, D / 7), 100, "accrued preserved on refill");
        assert_eq!(owed(&l, &a, D / 7 + D / 2), 100 + 600);
        assert_eq!(owed(&l, &a, 10 * D), 1_300);
        assert_eq!((l.verified_fees_total, l.treasury_total), (700, 600));
    }
    #[test] fn unstake_stops_earning_and_cooldown() {
        let mut l = l0(); let (mut a, mut b) = Default::default();
        stake(&mut l, &mut a, 100, 0).unwrap(); stake(&mut l, &mut b, 100, 0).unwrap();
        l.fund(1_400, true, 0).unwrap();
        let u = request_unstake(&mut l, &mut a, 100, D / 2).unwrap();
        assert_eq!(u, D / 2 + D);
        assert_eq!(owed(&l, &a, D), 350, "no earnings after request");
        assert_eq!(owed(&l, &b, D), 1_050);
        assert_eq!(request_unstake(&mut l, &mut a, 0, D), Err(MathError::Zero));
        assert_eq!(withdraw(&mut a, u - 1), Err(MathError::Cooling));
        assert_eq!(withdraw(&mut a, u).unwrap(), 100);
        assert_eq!(withdraw(&mut a, u), Err(MathError::NoPending));
    }
    #[test] fn partial_unstake_single_lot_and_cancel() {
        let mut l = l0(); let mut a = PositionState::default();
        stake(&mut l, &mut a, 100, 0).unwrap();
        request_unstake(&mut l, &mut a, 40, 10).unwrap();
        assert_eq!(request_unstake(&mut l, &mut a, 10, 20), Err(MathError::PendingExists), "cooldown never silently extended");
        assert_eq!(request_unstake(&mut l, &mut a, 0, 20), Err(MathError::Zero));
        assert_eq!((a.active, l.total_active), (60, 60));
        assert_eq!(cancel_unstake(&mut l, &mut a, 30).unwrap(), 40);
        assert_eq!((a.active, l.total_active, a.pending_amount), (100, 100, 0));
        assert_eq!(cancel_unstake(&mut l, &mut a, 30), Err(MathError::NoPending));
        assert_eq!(request_unstake(&mut l, &mut a, 101, 40), Err(MathError::Insufficient));
    }
    #[test] fn double_claim_rejected() {
        let mut l = l0(); let mut a = PositionState::default();
        stake(&mut l, &mut a, 1, 0).unwrap(); l.fund(10, true, 0).unwrap();
        assert_eq!(claim(&mut l, &mut a, D).unwrap(), 10);
        assert_eq!(claim(&mut l, &mut a, D), Err(MathError::Nothing));
        assert_eq!(l.claimed_total, 10);
    }
    #[test] fn zero_and_overflow_checks() {
        let mut l = l0(); let mut a = PositionState::default();
        assert_eq!(stake(&mut l, &mut a, 0, 0), Err(MathError::Zero));
        assert_eq!(l.fund(0, true, 0), Err(MathError::Zero));
        stake(&mut l, &mut a, u64::MAX, 0).unwrap();
        let mut b = PositionState::default();
        assert_eq!(stake(&mut l, &mut b, 1, 0), Err(MathError::Overflow));
        l.fund(u64::MAX, true, 0).unwrap();
        assert_eq!(l.fund(1, true, 0), Err(MathError::Overflow));
    }
    #[test] fn many_users_conservation() {
        let mut l = l0(); let mut ps: Vec<PositionState> = vec![Default::default(); 25];
        for (i, p) in ps.iter_mut().enumerate() { stake(&mut l, p, (i as u64 + 1) * 13_337, i as i64 * 100).unwrap(); }
        l.fund(987_654_321, true, 5_000).unwrap(); l.fund(123_456_789, false, D / 3).unwrap();
        let mut paid = 0u64;
        for (i, p) in ps.iter_mut().enumerate() { if i % 3 == 0 { request_unstake(&mut l, p, p.active / 2, D).unwrap(); } }
        for p in ps.iter_mut() { paid += claim(&mut l, p, 3 * D).unwrap_or(0); }
        let funded = 987_654_321 + 123_456_789;
        assert!(paid <= funded && funded - paid <= 30, "paid {paid}");
        assert_eq!(l.claimed_total, paid);
    }

    /// Fixture shared with the TypeScript decoder (src/pq/staking.test.ts).
    #[test] fn layout_fixture() {
        let l = Ledger { duration: D, cooldown: D, total_active: 3, acc_per_share: 1u128 << 70, carry: 5, stream_amount: 9, stream_start: -1, stream_released: 2, unallocated: 4, last_update: 7, verified_fees_total: 11, treasury_total: 12, distributed_total: 13, claimed_total: 14 };
        let p = PositionState { active: 21, checkpoint: u128::MAX, frac: 22, owed: 23, pending_amount: 24, unlock_ts: 25, claimed_total: 26 };
        let hex = |b: Vec<u8>| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let s = format!("{{\"ledger\":\"{}\",\"position\":\"{}\"}}\n", hex(l.try_to_vec().unwrap()), hex(p.try_to_vec().unwrap()));
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/layout.json");
        if std::env::var("WRITE_FIXTURES").is_ok() { std::fs::write(path, &s).unwrap(); }
        assert_eq!(std::fs::read_to_string(path).unwrap(), s, "TS fixture out of date: run WRITE_FIXTURES=1 cargo test");
        assert_eq!(Ledger::INIT_SPACE, 12 * 8 + 2 * 16);
        assert_eq!(PositionState::INIT_SPACE, 5 * 8 + 2 * 16);
    }
}
