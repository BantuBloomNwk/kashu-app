//! A small savings vault. Each user has their own vault that holds dollars and one asset.
//!
//! The user sets a rule (a weekly amount, round-ups, and how much of each week goes into the
//! asset). Once a week anyone may press the button that carries the rule out. The person pressing
//! it chooses nothing: not the asset, not the amount, not the venue, not where the result lands.
//! Only the owner can take money out, and only to a token account the owner controls.
//!
//! Beta limits live in the program itself: 50 dollars per user and 5,000 in total. The admin can
//! pause deposits and buys and can lower the caps, but cannot raise them past those numbers and
//! has no instruction that moves a user's money. Withdrawals work while paused.
//!
//! A user can enrol a hash-based one-time key (wots.rs). From then on the owner's ordinary
//! signature can no longer take money out: only a fresh one-time signature can, and it names the
//! exact amount and the exact account the money goes to.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use solana_sha256_hasher::hashv;

pub mod agent;
pub mod error;
pub mod lending;
pub mod oracle;
pub mod prize;
pub mod state;
pub mod swap;
pub mod wots;

pub use error::*;
pub use state::*;
use prize::{PotLink, Pot, PrizeConfig, LINK_SEED, POT_SEED, POT_USDC_SEED, PRIZE_SEED};
use agent::{AgentPolicy, Chore, AGENT_AUTH_SEED, AGENT_SEED, MAX_CHORES, MAX_PAYEES};

declare_id!("3jYUfoa788SJpFbbPS7vFxTNkWCRN1c4gx3rcgmH9GxH");

// The program's on-chain security.txt: who to tell about a vulnerability and where the code is. Values come from
// SECURITY_TXT.env at build time (scripts set them), so every build says the same, checked, thing.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Kashu vault",
    project_url: env!("KASHU_SITE"),
    contacts: env!("KASHU_CONTACT"),
    policy: env!("KASHU_POLICY"),
    preferred_languages: "en",
    source_code: env!("KASHU_SOURCE"),
    auditors: env!("KASHU_AUDITORS")
}

/// Hard beta limits, in dollar base units (6 decimals). Raising these takes a program upgrade.
pub const HARD_PER_USER_CAP: u64 = 50_000_000;
pub const HARD_TOTAL_CAP: u64 = 5_000_000_000;
pub const USDC_DECIMALS: u8 = 6;
/// The saving week. Devnet builds use 10 minutes so a whole cycle can be watched live; mainnet is 7 days.
#[cfg(not(feature = "devnet"))]
pub const WEEK: i64 = 7 * 24 * 60 * 60;
#[cfg(feature = "devnet")]
pub const WEEK: i64 = 10 * 60;
pub const BPS: u64 = 10_000;
pub const RATE_SCALE: u128 = 1_000_000_000;
/// The smallest deposit that counts as this week's save in a room: a dollar (ten cents on devnet, where test
/// amounts are small). Smaller deposits are still saved, they just don't light the saver's window.
#[cfg(not(feature = "devnet"))]
pub const MIN_SAVE: u64 = 1_000_000;
#[cfg(feature = "devnet")]
pub const MIN_SAVE: u64 = 100_000;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const CASH_SEED: &[u8] = b"cash";
pub const HOLD_SEED: &[u8] = b"hold";
pub const SWAP_AUTH_SEED: &[u8] = b"swap_auth";
pub const MAX_PQ_HEIGHT: u8 = 16;
pub const VENUE_SEED: &[u8] = b"venue";
pub const WINNINGS_SEED: &[u8] = b"winnings";
/// Hard limits on the venue's bounds; loosening them takes a program upgrade.
pub const MAX_SLIPPAGE_BPS: u16 = 300;
/// Pyth refreshes its sponsored feeds every few seconds on mainnet but only every half hour or so on
/// devnet, so devnet builds allow an older price. Mainnet keeps five minutes.
#[cfg(not(feature = "devnet"))]
pub const MAX_PRICE_AGE_SECS: u32 = 300;
#[cfg(feature = "devnet")]
pub const MAX_PRICE_AGE_SECS: u32 = 3 * 60 * 60;
pub const MAX_CONF_BPS: u16 = 200;

#[program]
pub mod vault {
    use super::*;

    /// One time, by the program's upgrade authority, so nobody can set it up ahead of us.
    pub fn initialize(
        ctx: Context<Initialize>,
        per_user_cap: u64,
        total_cap: u64,
        floor_rate: u64,
    ) -> Result<()> {
        require!(
            per_user_cap <= HARD_PER_USER_CAP && total_cap <= HARD_TOTAL_CAP,
            VaultError::CapTooHigh
        );
        require!(floor_rate > 0, VaultError::BadFloor);
        require!(
            ctx.accounts.usdc_mint.decimals == USDC_DECIMALS,
            VaultError::BadDecimals
        );
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.pending_admin = Pubkey::default();
        c.usdc_mint = ctx.accounts.usdc_mint.key();
        c.asset_mint = ctx.accounts.asset_mint.key();
        c.swap_program = ctx.accounts.swap_program.key();
        c.per_user_cap = per_user_cap;
        c.total_cap = total_cap;
        c.total_principal = 0;
        c.floor_rate = floor_rate;
        c.paused = false;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }

    pub fn set_caps(ctx: Context<AdminOnly>, per_user_cap: u64, total_cap: u64) -> Result<()> {
        require!(
            per_user_cap <= HARD_PER_USER_CAP && total_cap <= HARD_TOTAL_CAP,
            VaultError::CapTooHigh
        );
        let c = &mut ctx.accounts.config;
        c.per_user_cap = per_user_cap;
        c.total_cap = total_cap;
        Ok(())
    }

    pub fn set_floor_rate(ctx: Context<AdminOnly>, floor_rate: u64) -> Result<()> {
        require!(floor_rate > 0, VaultError::BadFloor);
        ctx.accounts.config.floor_rate = floor_rate;
        Ok(())
    }

    /// Admin handover takes two steps so a typo cannot hand the switch to nobody.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.new_admin.key();
        c.pending_admin = Pubkey::default();
        Ok(())
    }

    pub fn open_vault(ctx: Context<OpenVault>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.user_vault;
        v.owner = ctx.accounts.owner.key();
        v.cash_tracked = 0;
        v.asset_basis = 0;
        v.weekly_amount = 0;
        v.roundup_unit = 0;
        v.pending_roundup = 0;
        v.asset_bps = 0;
        v.next_buy_at = now.checked_add(WEEK).ok_or(VaultError::Math)?;
        v.buys_done = 0;
        v.bump = ctx.bumps.user_vault;
        v.cash_bump = ctx.bumps.cash;
        v.hold_bump = ctx.bumps.hold;
        v.swap_auth_bump = ctx.bumps.swap_authority;
        v.pq_seed = [0u8; 32];
        v.pq_root = [0u8; 32];
        v.pq_height = 0;
        v.pq_next_leaf = 0;
        Ok(())
    }

    /// The owner's rule. Only ever the owner's own choice from the fixed menu; the program
    /// suggests nothing.
    pub fn set_rule(
        ctx: Context<OwnerOnly>,
        weekly_amount: u64,
        roundup_unit: u64,
        asset_bps: u16,
    ) -> Result<()> {
        require!(asset_bps as u64 <= BPS, VaultError::BadMix);
        require!(
            weekly_amount <= HARD_PER_USER_CAP && roundup_unit <= HARD_PER_USER_CAP,
            VaultError::BadRule
        );
        let v = &mut ctx.accounts.user_vault;
        v.weekly_amount = weekly_amount;
        v.roundup_unit = roundup_unit;
        v.asset_bps = asset_bps;
        emit!(RuleSet {
            owner: v.owner,
            weekly_amount,
            roundup_unit,
            asset_bps
        });
        Ok(())
    }

    /// Notes a spend so its round-up joins this week's budget. It moves no money. The change is
    /// taken from dollars already in the vault when the weekly buy runs.
    pub fn note_spend(ctx: Context<OwnerOnly>, spend_amount: u64) -> Result<()> {
        let v = &mut ctx.accounts.user_vault;
        require!(spend_amount > 0, VaultError::ZeroAmount);
        if v.roundup_unit == 0 {
            return Ok(());
        }
        let over = spend_amount % v.roundup_unit;
        let change = if over == 0 { 0 } else { v.roundup_unit - over };
        v.pending_roundup = v
            .pending_roundup
            .checked_add(change)
            .ok_or(VaultError::Math)?
            .min(HARD_PER_USER_CAP);
        Ok(())
    }

    /// A private save: the saver's dollars go from their wallet straight to their own private pocket (MagicBlock's
    /// private payments rollup), the one their wallet named in the rooms program. The vault never holds them and they
    /// earn no interest; the vault only counts the save, so the room sees that they saved while what they hold stays
    /// private.
    pub fn save_private(ctx: Context<SavePrivate>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(!ctx.accounts.config.paused, VaultError::Paused);
        let pocket = prize::read_pocket(&ctx.accounts.pocket_of, &ctx.accounts.owner.key())?;
        require_keys_eq!(ctx.accounts.to.owner, pocket, VaultError::NotYourPocket);
        let v = &mut ctx.accounts.user_vault;
        if amount >= MIN_SAVE {
            v.buys_done = v.buys_done.checked_add(1).ok_or(VaultError::Math)?;
        }
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            USDC_DECIMALS,
        )?;
        emit!(SavedPrivately { owner: v.owner, amount });
        Ok(())
    }

    /// The saver sets (or clears) their agent: its key, a weekly cap, who it may pay, and its chores. Every chore's
    /// clock starts again, so a new policy can't inherit an old one's runs. Clearing: agent = Pubkey::default().
    pub fn set_agent(ctx: Context<SetAgent>, agent: Pubkey, weekly_cap: u64, payees: [Pubkey; MAX_PAYEES], chores: [Chore; MAX_CHORES]) -> Result<()> {
        for c in chores.iter() {
            require!(c.kind <= agent::CHORE_REMIND && c.weekday < 7 && c.hour < 24, VaultError::BadChore);
            if c.kind == agent::CHORE_PAY { require!((c.payee as usize) < MAX_PAYEES && payees[c.payee as usize] != Pubkey::default(), VaultError::BadChore); }
            if c.kind != agent::CHORE_NONE && c.kind != agent::CHORE_REMIND { require!(c.amount > 0 && c.amount <= weekly_cap, VaultError::BadChore); }
        }
        let p = &mut ctx.accounts.policy;
        p.user_vault = ctx.accounts.user_vault.key();
        p.agent = agent;
        p.weekly_cap = weekly_cap;
        p.window_start = 0;
        p.spent = 0;
        p.payees = payees;
        p.chores = chores.map(|c| Chore { last_run: 0, ..c });
        p.bump = ctx.bumps.policy;
        emit!(AgentSet { owner: ctx.accounts.owner.key(), agent, weekly_cap });
        Ok(())
    }

    /// The agent runs one of the saver's chores: the amount and where it goes are the policy's, not the agent's.
    /// Dollars come from the saver's own account through the allowance they gave this program's agent authority.
    pub fn agent_run(ctx: Context<AgentRun>, chore: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.config.paused, VaultError::Paused);
        let vault_key = ctx.accounts.user_vault.key();
        let p = &mut ctx.accounts.policy;
        require!(p.agent != Pubkey::default() && ctx.accounts.agent.key() == p.agent, VaultError::NotTheAgent);
        let i = chore as usize;
        require!(i < MAX_CHORES, VaultError::BadChore);
        let c = p.chores[i];
        require!(c.kind != agent::CHORE_NONE && c.kind != agent::CHORE_REMIND, VaultError::BadChore);
        require!(c.last_run == 0 || now >= c.last_run + agent::CHORE_GAP, VaultError::ChoreTooSoon);
        p.charge(c.amount, now)?;
        p.chores[i].last_run = now;
        let v = &mut ctx.accounts.user_vault;
        let owner = v.owner;
        let to = &ctx.accounts.to;
        match c.kind {
            agent::CHORE_SAVE => {
                // into the saver's own vault, counted like any deposit (and under the same caps)
                require_keys_eq!(to.key(), ctx.accounts.cash.key(), VaultError::AgentDestination);
                let cfg = &mut ctx.accounts.config;
                let mine = v.cash_tracked.checked_add(v.asset_basis).and_then(|x| x.checked_add(v.lent_principal)).and_then(|x| x.checked_add(c.amount)).ok_or(VaultError::Math)?;
                require!(mine <= cfg.per_user_cap, VaultError::UserCap);
                let all = cfg.total_principal.checked_add(c.amount).ok_or(VaultError::Math)?;
                require!(all <= cfg.total_cap, VaultError::TotalCap);
                v.cash_tracked = v.cash_tracked.checked_add(c.amount).ok_or(VaultError::Math)?;
                cfg.total_principal = all;
            }
            agent::CHORE_SAVE_PRIVATE => {
                let pocket = prize::read_pocket(&ctx.accounts.pocket_of, &owner)?;
                require_keys_eq!(to.owner, pocket, VaultError::AgentDestination);
            }
            _ => {
                let payee = p.payees[c.payee as usize];
                require_keys_eq!(to.owner, payee, VaultError::AgentDestination);
            }
        }
        if c.kind != agent::CHORE_PAY && c.amount >= MIN_SAVE {
            v.buys_done = v.buys_done.checked_add(1).ok_or(VaultError::Math)?;
        }
        let bump = [ctx.bumps.agent_auth];
        let seeds: &[&[u8]] = &[AGENT_AUTH_SEED, vault_key.as_ref(), &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.agent_auth.to_account_info(),
                },
                &[seeds],
            ),
            c.amount,
            USDC_DECIMALS,
        )?;
        // Kashu's fee for the run (one cent), from the same allowance, to an account Kashu's admin owns
        require_keys_eq!(ctx.accounts.treasury.owner, ctx.accounts.config.admin, VaultError::WrongTreasury);
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.agent_auth.to_account_info(),
                },
                &[seeds],
            ),
            agent::AGENT_FEE,
            USDC_DECIMALS,
        )?;
        emit!(AgentRan { owner, chore, kind: c.kind, amount: c.amount });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let c = &mut ctx.accounts.config;
        let v = &mut ctx.accounts.user_vault;
        require!(!c.paused, VaultError::Paused);

        let mine = v
            .cash_tracked
            .checked_add(v.asset_basis)
            .and_then(|x| x.checked_add(v.lent_principal))
            .and_then(|x| x.checked_add(amount))
            .ok_or(VaultError::Math)?;
        require!(mine <= c.per_user_cap, VaultError::UserCap);
        let all = c
            .total_principal
            .checked_add(amount)
            .ok_or(VaultError::Math)?;
        require!(all <= c.total_cap, VaultError::TotalCap);

        v.cash_tracked = v.cash_tracked.checked_add(amount).ok_or(VaultError::Math)?;
        c.total_principal = all;
        // a real save counts in the room (the rooms program reads this counter at check-in), whether the
        // saver keeps it in dollars or buys SOL with it; dust doesn't
        if amount >= MIN_SAVE {
            v.buys_done = v.buys_done.checked_add(1).ok_or(VaultError::Math)?;
        }

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.cash.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            USDC_DECIMALS,
        )?;
        emit!(Deposited {
            owner: v.owner,
            amount
        });
        Ok(())
    }

    /// The admin names the weekly buy's venue and price feed, once, inside the hard limits.
    pub fn set_venue(ctx: Context<SetVenue>, price_feed: Pubkey, feed_id: [u8; 32], max_age_secs: u32, max_conf_bps: u16, slippage_bps: u16) -> Result<()> {
        require!(max_age_secs > 0 && max_age_secs <= MAX_PRICE_AGE_SECS, VaultError::BadVenueBounds);
        require!(max_conf_bps > 0 && max_conf_bps <= MAX_CONF_BPS, VaultError::BadVenueBounds);
        require!(slippage_bps <= MAX_SLIPPAGE_BPS, VaultError::BadVenueBounds);
        let v = &mut ctx.accounts.venue;
        v.swap_program = ctx.accounts.swap_program.key();
        v.price_feed = price_feed;
        v.feed_id = feed_id;
        v.max_age_secs = max_age_secs;
        v.max_conf_bps = max_conf_bps;
        v.slippage_bps = slippage_bps;
        v.bump = ctx.bumps.venue;
        emit!(VenueSet { swap_program: v.swap_program, price_feed, slippage_bps });
        Ok(())
    }

    /// When a buy is due and some of the savings it needs are lent, anyone may bring back exactly the
    /// shortfall from Jupiter Lend into the vault's cash. The amount comes from the owner's rule.
    pub fn prepare_buy(ctx: Context<PrepareBuy>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.config.paused, VaultError::Paused);
        let a = &ctx.accounts;
        require!(now >= a.user_vault.next_buy_at, VaultError::NotDue);
        let spend = this_week_spend(&a.user_vault)?;
        let need = spend.saturating_sub(a.user_vault.cash_tracked).min(a.user_vault.lent_principal);
        require!(need > 0, VaultError::NothingToBuy);
        let usdc = a.usdc_mint.key();
        let venue = venue!(a);
        venue.check(&usdc)?;
        let vault_key = a.user_vault.key();
        require_keys_eq!(a.shares.key(), share_account(&vault_key, &lending::market(&usdc).1), VaultError::WrongShareAccount);
        require_keys_eq!(a.staging.key(), share_account(&vault_key, &usdc), VaultError::WrongShareAccount);
        let (owner, bump) = (a.user_vault.owner, a.user_vault.bump);
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
        let burned = lending::withdraw(&venue, &a.claim_account.to_account_info(), &a.user_vault.to_account_info(), &a.cash.to_account_info(),
            &a.staging.to_account_info(), &a.shares.to_account_info(), &a.usdc_mint.to_account_info(), seeds, need)?;
        let v = &mut ctx.accounts.user_vault;
        v.lent_principal -= need;
        v.cash_tracked = v.cash_tracked.checked_add(need).ok_or(VaultError::Math)?;
        emit!(Unlent { owner, amount: need, interest: 0, shares: burned });
        Ok(())
    }

    /// Anyone may call this once the week is up. Everything that matters is read from the owner's rule,
    /// the venue settings and the oracle; the caller brings only the route, which is treated as hostile.
    pub fn weekly_buy<'info>(ctx: Context<'info, WeeklyBuy<'info>>, route_data: Vec<u8>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        require!(!c.paused, VaultError::Paused);

        let owner = ctx.accounts.user_vault.owner;
        require!(
            now >= ctx.accounts.user_vault.next_buy_at,
            VaultError::NotDue
        );

        // This week's spend, straight from the rule. Savings may be lent; the part this buy needs must
        // be back in cash first (prepare_buy).
        let (spend, min_out) = {
            let v = &ctx.accounts.user_vault;
            let spend = this_week_spend(v)?;
            require!(spend <= v.cash_tracked && spend <= ctx.accounts.cash.amount, VaultError::SavingsStillLent);
            (spend, buy_min_out(&ctx.accounts, spend, now)?)
        };

        // Book the change before any outside program runs.
        {
            let v = &mut ctx.accounts.user_vault;
            v.cash_tracked = v.cash_tracked.checked_sub(spend).ok_or(VaultError::Math)?;
            v.asset_basis = v.asset_basis.checked_add(spend).ok_or(VaultError::Math)?;
            v.pending_roundup = 0;
            v.next_buy_at = now.checked_add(WEEK).ok_or(VaultError::Math)?;
            v.buys_done = v.buys_done.checked_add(1).ok_or(VaultError::Math)?;
        }

        let got = swap_for_vault(ctx.accounts, ctx.remaining_accounts, route_data, spend, min_out)?;

        emit!(Bought {
            owner,
            spent: spend,
            received: got,
            next_buy_at: ctx.accounts.user_vault.next_buy_at,
        });
        Ok(())
    }

    /// Dollars back to the owner. Works while paused. Refused once a hash-based key is enrolled.
    /// The owner puts some of their tracked dollars to work on Jupiter Lend. The money stays in the
    /// vault: the vault deposits from its own cash and holds the lending shares itself.
    pub fn lend(ctx: Context<Lend>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(!ctx.accounts.config.paused, VaultError::Paused);
        let a = &ctx.accounts;
        require!(amount <= a.user_vault.cash_tracked, VaultError::Insufficient);
        let usdc = a.usdc_mint.key();
        let venue = venue!(a);
        venue.check(&usdc)?;
        let vault_key = a.user_vault.key();
        require_keys_eq!(a.shares.key(), share_account(&vault_key, &lending::market(&usdc).1), VaultError::WrongShareAccount);
        let (owner, bump) = (a.user_vault.owner, a.user_vault.bump);
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
        require_keys_eq!(a.staging.key(), share_account(&vault_key, &usdc), VaultError::WrongShareAccount);
        let shares = lending::deposit(&venue, &a.user_vault.to_account_info(), &a.cash.to_account_info(), &a.staging.to_account_info(), &a.shares.to_account_info(),
            &a.usdc_mint.to_account_info(), seeds, amount)?;
        let v = &mut ctx.accounts.user_vault;
        v.cash_tracked -= amount;
        v.lent_principal = v.lent_principal.checked_add(amount).ok_or(VaultError::Math)?;
        emit!(Lent { owner, amount, shares });
        Ok(())
    }

    /// The owner brings dollars back from Jupiter Lend into the vault's cash (works while paused,
    /// like every way out). Whatever comes back above what was put in is the owner's interest.
    pub fn unlend(ctx: Context<Unlend>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let a = &ctx.accounts;
        let usdc = a.usdc_mint.key();
        let venue = venue!(a);
        venue.check(&usdc)?;
        let vault_key = a.user_vault.key();
        require_keys_eq!(a.shares.key(), share_account(&vault_key, &lending::market(&usdc).1), VaultError::WrongShareAccount);
        let (owner, bump) = (a.user_vault.owner, a.user_vault.bump);
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
        require_keys_eq!(a.staging.key(), share_account(&vault_key, &usdc), VaultError::WrongShareAccount);
        // Asking for everything still lent: Jupiter rounds each withdrawal's share burn up, so after a partial
        // withdrawal with no interest yet the shares can be worth a unit less than the principal, and asking for
        // the principal fails. So "all" hands back every share and takes what Jupiter says they are worth now.
        let all = amount >= a.user_vault.lent_principal;
        let (take, burned) = if all {
            (lending::redeem_all(&venue, &a.claim_account.to_account_info(), &a.user_vault.to_account_info(), &a.cash.to_account_info(),
                &a.staging.to_account_info(), &a.shares.to_account_info(), &a.usdc_mint.to_account_info(), seeds)?, 0)
        } else {
            (amount, lending::withdraw(&venue, &a.claim_account.to_account_info(), &a.user_vault.to_account_info(), &a.cash.to_account_info(),
                &a.staging.to_account_info(), &a.shares.to_account_info(), &a.usdc_mint.to_account_info(), seeds, amount)?)
        };
        let v = &mut ctx.accounts.user_vault;
        let principal = if all { v.lent_principal } else { take.min(v.lent_principal) };
        let interest = take.saturating_sub(principal);
        let rounding = principal.saturating_sub(take);
        v.lent_principal -= principal;
        v.cash_tracked = v.cash_tracked.checked_add(take).ok_or(VaultError::Math)?;
        let c = &mut ctx.accounts.config;
        c.total_principal = c.total_principal.saturating_add(interest).saturating_sub(rounding);
        emit!(Unlent { owner, amount: take, interest, shares: burned });
        Ok(())
    }

    pub fn withdraw_cash(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.user_vault.pq_enrolled(),
            VaultError::PqRequired
        );
        release(
            &mut ctx.accounts.config,
            &mut ctx.accounts.user_vault,
            &ctx.accounts.cash,
            &ctx.accounts.usdc_mint,
            ctx.accounts.owner_usdc.to_account_info(),
            ctx.accounts.token_program.key(),
            amount,
        )
    }

    /// The asset back to the owner. Works while paused. Refused once a hash-based key is enrolled.
    pub fn withdraw_asset(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.user_vault.pq_enrolled(),
            VaultError::PqRequired
        );
        release(
            &mut ctx.accounts.config,
            &mut ctx.accounts.user_vault,
            &ctx.accounts.hold,
            &ctx.accounts.asset_mint,
            ctx.accounts.owner_asset.to_account_info(),
            ctx.accounts.token_program.key(),
            amount,
        )
    }

    /// Puts a hash-based key on the vault. One way: it can be replaced later, never removed.
    pub fn enroll_pq(
        ctx: Context<OwnerOnly>,
        seed: [u8; 32],
        root: [u8; 32],
        height: u8,
    ) -> Result<()> {
        let v = &mut ctx.accounts.user_vault;
        require!(!v.pq_enrolled(), VaultError::PqAlreadyEnrolled);
        require!(
            root != [0u8; 32] && (1..=MAX_PQ_HEIGHT).contains(&height),
            VaultError::BadPqKey
        );
        v.pq_seed = seed;
        v.pq_root = root;
        v.pq_height = height;
        v.pq_next_leaf = 0;
        emit!(PqKeySet {
            owner: v.owner,
            root,
            height
        });
        Ok(())
    }

    /// Withdraws under a one-time hash-based signature. Anyone may deliver it; the signature
    /// itself names the token, the amount and the account that receives it. Works while paused.
    pub fn withdraw_pq(
        ctx: Context<WithdrawPq>,
        is_cash: bool,
        amount: u64,
        leaf: u32,
        sig: Vec<[u8; 32]>,
        path: Vec<[u8; 32]>,
    ) -> Result<()> {
        let vault_key = ctx.accounts.user_vault.key();
        let dest = ctx.accounts.destination.key();
        require!(
            dest != ctx.accounts.cash.key() && dest != ctx.accounts.hold.key(),
            VaultError::SwapAccountClash
        );
        let mint_key = if is_cash {
            ctx.accounts.usdc_mint.key()
        } else {
            ctx.accounts.asset_mint.key()
        };
        require!(
            ctx.accounts.destination.mint == mint_key,
            VaultError::WrongMint
        );

        let msg = hashv(&[
            b"sv-withdraw",
            crate::ID.as_ref(),
            vault_key.as_ref(),
            &leaf.to_le_bytes(),
            mint_key.as_ref(),
            &amount.to_le_bytes(),
            dest.as_ref(),
        ])
        .to_bytes();
        check_pq(&mut ctx.accounts.user_vault, &msg, leaf, &sig, &path)?;

        let (from, mint) = if is_cash {
            (&ctx.accounts.cash, &ctx.accounts.usdc_mint)
        } else {
            (&ctx.accounts.hold, &ctx.accounts.asset_mint)
        };
        release(
            &mut ctx.accounts.config,
            &mut ctx.accounts.user_vault,
            from,
            mint,
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.token_program.key(),
            amount,
        )
    }

    /// Replaces the hash-based key with a new one, signed by the current one. Use it before the
    /// one-time keys run out.
    pub fn rotate_pq(
        ctx: Context<RotatePq>,
        new_seed: [u8; 32],
        new_root: [u8; 32],
        new_height: u8,
        leaf: u32,
        sig: Vec<[u8; 32]>,
        path: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(
            new_root != [0u8; 32] && (1..=MAX_PQ_HEIGHT).contains(&new_height),
            VaultError::BadPqKey
        );
        let vault_key = ctx.accounts.user_vault.key();
        let msg = hashv(&[
            b"sv-rotate",
            crate::ID.as_ref(),
            vault_key.as_ref(),
            &leaf.to_le_bytes(),
            &new_seed,
            &new_root,
            &[new_height],
        ])
        .to_bytes();
        let v = &mut ctx.accounts.user_vault;
        check_pq(v, &msg, leaf, &sig, &path)?;
        v.pq_seed = new_seed;
        v.pq_root = new_root;
        v.pq_height = new_height;
        v.pq_next_leaf = 0;
        emit!(PqKeySet {
            owner: v.owner,
            root: new_root,
            height: new_height
        });
        Ok(())
    }
    // ---- the Friday prize (see prize.rs) ----

    /// Once, by the admin: Kashu's cut of harvested interest, at most 10%.
    pub fn init_prize(ctx: Context<InitPrize>, cut_bps: u16) -> Result<()> {
        require!(cut_bps <= prize::MAX_CUT_BPS, VaultError::CutTooHigh);
        let p = &mut ctx.accounts.prize_config;
        p.cut_bps = cut_bps;
        p.bump = ctx.bumps.prize_config;
        emit!(PrizeCutSet { cut_bps });
        Ok(())
    }

    /// The admin moves the cut, never past 10% (to zero once Jupiter's referral fee pays it instead).
    pub fn set_prize_cut(ctx: Context<SetPrizeCut>, cut_bps: u16) -> Result<()> {
        require!(cut_bps <= prize::MAX_CUT_BPS, VaultError::CutTooHigh);
        ctx.accounts.prize_config.cut_bps = cut_bps;
        emit!(PrizeCutSet { cut_bps });
        Ok(())
    }

    /// Anyone opens the pot of a real room (one created by the rooms program).
    pub fn open_pot(ctx: Context<OpenPot>) -> Result<()> {
        prize::read_room(&ctx.accounts.room.to_account_info(), &ctx.accounts.delegation_record.to_account_info())?;
        let p = &mut ctx.accounts.pot;
        p.room = ctx.accounts.room.key();
        p.paid_through = 0;
        p.bump = ctx.bumps.pot;
        p.usdc_bump = ctx.bumps.pot_usdc;
        emit!(PotOpened { room: p.room });
        Ok(())
    }

    /// The owner lets their savings' interest feed a room's pot. Without a link the interest is theirs.
    pub fn link_pot(ctx: Context<LinkPot>) -> Result<()> {
        let l = &mut ctx.accounts.link;
        l.room = ctx.accounts.pot.room;
        l.bump = ctx.bumps.link;
        emit!(PotLinked { owner: ctx.accounts.owner.key(), room: l.room });
        Ok(())
    }

    /// The owner stops feeding the pot (Keep mode); the link's rent comes back to them.
    pub fn unlink_pot(ctx: Context<UnlinkPot>) -> Result<()> {
        emit!(PotUnlinked { owner: ctx.accounts.owner.key(), room: ctx.accounts.link.room });
        Ok(())
    }

    /// Anyone harvests a linked vault: only what its lending shares are worth above the saver's
    /// principal comes out of Jupiter Lend; Kashu's cut goes to the treasury, the rest to the pot.
    /// Afterwards the shares must still cover every dollar the saver put in.
    pub fn harvest<'info>(ctx: Context<'info, Harvest<'info>>) -> Result<()> {
        require!(!ctx.accounts.config.paused, VaultError::Paused);
        let a = &ctx.accounts;
        require_keys_eq!(a.link.room, a.pot.room, VaultError::WrongPot);
        require_keys_eq!(a.treasury.owner, a.config.admin, VaultError::WrongTreasury);
        let usdc = a.usdc_mint.key();
        let venue = venue!(a);
        venue.check(&usdc)?;
        let vault_key = a.user_vault.key();
        require_keys_eq!(a.shares.key(), share_account(&vault_key, &lending::market(&usdc).1), VaultError::WrongShareAccount);
        require_keys_eq!(a.staging.key(), share_account(&vault_key, &usdc), VaultError::WrongShareAccount);
        let principal = a.user_vault.lent_principal;
        let value = prize::shares_value(&a.shares.to_account_info(), &a.lending.to_account_info())?;
        let interest = value.saturating_sub(principal).saturating_sub(prize::HARVEST_MARGIN);
        require!(interest >= prize::MIN_HARVEST, VaultError::NothingToHarvest);
        let (owner, bump) = (a.user_vault.owner, a.user_vault.bump);
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
        let cash0 = a.cash.amount;
        lending::withdraw(&venue, &a.claim_account.to_account_info(), &a.user_vault.to_account_info(), &a.cash.to_account_info(),
            &a.staging.to_account_info(), &a.shares.to_account_info(), &a.usdc_mint.to_account_info(), seeds, interest)?;
        // the savings are untouched: what is still lent covers every dollar the saver put in
        let after = prize::shares_value(&a.shares.to_account_info(), &a.lending.to_account_info())?;
        require!(after >= principal, VaultError::HarvestTouchedSavings);
        let cut = (interest as u128 * a.prize_config.cut_bps as u128 / BPS as u128) as u64;
        let to_pot = interest - cut;
        let pay = |to: AccountInfo<'info>, amount: u64| -> Result<()> {
            if amount == 0 { return Ok(()); }
            token::transfer_checked(CpiContext::new_with_signer(a.token_program.key(), TransferChecked {
                from: a.cash.to_account_info(), mint: a.usdc_mint.to_account_info(), to, authority: a.user_vault.to_account_info(),
            }, &[seeds]), amount, USDC_DECIMALS)
        };
        pay(a.treasury.to_account_info(), cut)?;
        pay(a.pot_usdc.to_account_info(), to_pot)?;
        let mut cash = a.cash.clone();
        cash.reload()?;
        // the cash ends where it started: interest passed through, savings stayed
        require!(cash.amount == cash0, VaultError::VenueMisbehaved);
        let room = a.pot.room;
        let p = &mut ctx.accounts.pot;
        p.harvested = p.harvested.saturating_add(interest);
        p.cut_taken = p.cut_taken.saturating_add(cut);
        emit!(Harvested { owner, room, interest, cut, to_pot });
        Ok(())
    }

    /// Anyone pays a settled draw: the whole pot goes to the winner's vault as their own savings.
    /// Each week's draw pays once, and never an older week after a newer one.
    pub fn pay_prize(ctx: Context<PayPrize>) -> Result<()> {
        let a = &ctx.accounts;
        // the rooms program's draw result for this pot's room; a private room stays on the rollup and only
        // this small record comes back to Solana
        let (week, winner) = prize::read_result(&a.draw_result.to_account_info(), &a.delegation_record.to_account_info(), &a.pot.room)?;
        require!(week > 0, VaultError::DrawNotSettled);
        require!(week >= a.pot.paid_through, VaultError::PrizeAlreadyPaid);
        require_keys_eq!(a.winner_vault.owner, winner, VaultError::NotTheWinner);
        let room = prize::RoomView { draw_week: week, draw_state: prize::DRAW_SETTLED, winner };
        let amount = a.pot_usdc.amount;
        if amount > 0 {
            let room_key = a.pot.room;
            let seeds: &[&[u8]] = &[POT_SEED, room_key.as_ref(), &[a.pot.bump]];
            token::transfer_checked(CpiContext::new_with_signer(a.token_program.key(), TransferChecked {
                from: a.pot_usdc.to_account_info(), mint: a.usdc_mint.to_account_info(), to: a.winner_cash.to_account_info(), authority: a.pot.to_account_info(),
            }, &[seeds]), amount, USDC_DECIMALS)?;
        }
        let v = &mut ctx.accounts.winner_vault;
        v.cash_tracked = v.cash_tracked.checked_add(amount).ok_or(VaultError::Math)?;
        let w = &mut ctx.accounts.winnings;
        if w.vault == Pubkey::default() { w.vault = v.key(); w.bump = ctx.bumps.winnings; }
        w.total_won = w.total_won.checked_add(amount).ok_or(VaultError::Math)?;
        w.left = w.left.checked_add(amount).ok_or(VaultError::Math)?;
        if amount > 0 { w.prizes = w.prizes.saturating_add(1); }
        let c = &mut ctx.accounts.config;
        c.total_principal = c.total_principal.saturating_add(amount);
        let p = &mut ctx.accounts.pot;
        p.paid_through = room.draw_week.checked_add(1).ok_or(VaultError::Math)?;
        p.paid_out = p.paid_out.saturating_add(amount);
        emit!(PrizePaid { room: p.room, week: room.draw_week, winner: room.winner, amount });
        Ok(())
    }

    /// The owner chooses how many dollars of their prize winnings become SOL each week. Zero stops it.
    /// It only ever spends winnings: a saver's own savings are never part of it.
    pub fn set_dca(ctx: Context<SetDca>, weekly: u64) -> Result<()> {
        let w = &mut ctx.accounts.winnings;
        if w.vault == Pubkey::default() { w.vault = ctx.accounts.user_vault.key(); w.bump = ctx.bumps.winnings; }
        w.weekly = weekly;
        emit!(DcaSet { owner: ctx.accounts.user_vault.owner, weekly });
        Ok(())
    }

    /// Anyone may call this once the owner's winnings week is up. It buys the asset with at most the
    /// owner's weekly amount, never more than the winnings left, and only from dollars already in cash.
    /// The route is hostile and judged exactly as in weekly_buy.
    pub fn dca_buy<'info>(ctx: Context<'info, DcaBuy<'info>>, route_data: Vec<u8>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.buy.config.paused, VaultError::Paused);
        let w = &ctx.accounts.winnings;
        require!(now >= w.next_at, VaultError::NotDue);
        let v = &ctx.accounts.buy.user_vault;
        let spend = w.weekly.min(w.left).min(v.cash_tracked).min(ctx.accounts.buy.cash.amount);
        require!(spend > 0, VaultError::NothingToBuy);
        let min_out = buy_min_out(&ctx.accounts.buy, spend, now)?;
        // Book the change before any outside program runs.
        {
            let v = &mut ctx.accounts.buy.user_vault;
            v.cash_tracked = v.cash_tracked.checked_sub(spend).ok_or(VaultError::Math)?;
            v.asset_basis = v.asset_basis.checked_add(spend).ok_or(VaultError::Math)?;
            let w = &mut ctx.accounts.winnings;
            w.left -= spend;
            w.next_at = now.checked_add(WEEK).ok_or(VaultError::Math)?;
        }
        let owner = ctx.accounts.buy.user_vault.owner;
        let got = swap_for_vault(&mut ctx.accounts.buy, ctx.remaining_accounts, route_data, spend, min_out)?;
        emit!(DcaBought { owner, spent: spend, received: got, left: ctx.accounts.winnings.left });
        Ok(())
    }
}

/// The least a buy of `spend` dollars must return: the oracle price less the venue's slippage, and never
/// less than the admin floor (which can only make it stricter).
fn buy_min_out(a: &WeeklyBuy, spend: u64, now: i64) -> Result<u64> {
    let vn = &a.venue;
    let p = oracle::read(&a.price_update, &vn.feed_id, now, vn.max_age_secs, vn.max_conf_bps)?;
    let by_oracle = oracle::min_out(spend, &p, USDC_DECIMALS, a.asset_mint.decimals, vn.slippage_bps)?;
    let by_floor = u64::try_from((spend as u128).checked_mul(a.config.floor_rate as u128).ok_or(VaultError::Math)? / RATE_SCALE)
        .map_err(|_| VaultError::Math)?;
    let min_out = by_oracle.max(by_floor);
    require!(min_out > 0, VaultError::NothingToBuy);
    Ok(min_out)
}

/// Moves `spend` dollars from the vault's cash through the hostile route and back into the vault's own
/// holding account, then judges the whole round trip by balances. The caller has already booked it.
fn swap_for_vault<'info>(a: &mut WeeklyBuy<'info>, remaining: &[AccountInfo<'info>], route_data: Vec<u8>, spend: u64, min_out: u64) -> Result<u64> {
    let vault_key = a.user_vault.key();
    let (owner, vault_bump, swap_auth_bump) = (a.user_vault.owner, a.user_vault.bump, a.user_vault.swap_auth_bump);
        let cash_before = a.cash.amount;
        let hold_before = a.hold.amount;
        let asset_decimals = a.asset_mint.decimals;

        // The swap authority gets this week's spend in its own dollar account (a vault-program address
        // that only this vault can sign for). The route swaps from there into its own asset account.
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[vault_bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.cash.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.swap_in.to_account_info(),
                    authority: a.user_vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            spend,
            USDC_DECIMALS,
        )?;

        let swap_auth_seeds: &[&[u8]] = &[SWAP_AUTH_SEED, vault_key.as_ref(), &[swap_auth_bump]];
        swap::run_route(
            &a.swap_program.to_account_info(),
            &a.swap_authority.to_account_info(),
            &[vault_key, a.cash.key(), a.hold.key()],
            remaining,
            route_data,
            swap_auth_seeds,
        )?;

        // Everything the swap produced goes to the vault's own holding account, and any dollars the
        // route did not spend go back to cash; the balances below then judge the whole round trip.
        for (from, to, mint, decimals) in [
            (&a.swap_out, a.hold.to_account_info(), a.asset_mint.to_account_info(), asset_decimals),
            (&a.swap_in, a.cash.to_account_info(), a.usdc_mint.to_account_info(), USDC_DECIMALS),
        ] {
            let left = token_amount(from)?;
            if left > 0 {
                token::transfer_checked(
                    CpiContext::new_with_signer(
                        a.token_program.key(),
                        TransferChecked { from: from.to_account_info(), mint, to, authority: a.swap_authority.to_account_info() },
                        &[swap_auth_seeds],
                    ),
                    left,
                    decimals,
                )?;
            }
        }

        a.cash.reload()?;
        a.hold.reload()?;
        let took = cash_before
            .checked_sub(a.cash.amount)
            .ok_or(VaultError::SwapTookWrongAmount)?;
        require!(took == spend, VaultError::SwapTookWrongAmount);
        let got = a
            .hold
            .amount
            .checked_sub(hold_before)
            .ok_or(VaultError::SwapPaidTooLittle)?;
        require!(got >= min_out, VaultError::SwapPaidTooLittle);
        require!(
            a.cash.owner == vault_key
                && a.hold.owner == vault_key
                && a.cash.delegate.is_none()
                && a.hold.delegate.is_none(),
            VaultError::SwapTookWrongAmount
        );
    Ok(got)
}

/// Checks a one-time signature against the vault's enrolled root and uses the key number up.
/// Key numbers may be skipped but never reused, so a signer who is unsure whether an earlier
/// signature was seen can always move on to a fresh one.
fn check_pq(
    v: &mut UserVault,
    msg: &[u8; 32],
    leaf: u32,
    sig: &[[u8; 32]],
    path: &[[u8; 32]],
) -> Result<()> {
    require!(v.pq_enrolled(), VaultError::PqNotEnrolled);
    require!(
        leaf >= v.pq_next_leaf && (leaf as u64) < (1u64 << v.pq_height),
        VaultError::PqLeafUsed
    );
    require!(
        sig.len() == wots::LEN && path.len() == v.pq_height as usize,
        VaultError::BadPqSignature
    );
    let root = wots::root_from_signature(&v.pq_seed, msg, leaf, sig, path);
    require!(root == v.pq_root, VaultError::BadPqSignature);
    v.pq_next_leaf = leaf.checked_add(1).ok_or(VaultError::Math)?;
    Ok(())
}

/// Sends tokens out of one of the vault's two accounts and keeps the books in step, so the caps
/// follow the money. The caller has already decided that this withdrawal is allowed.
/// This week's spend from the owner's rule: the weekly amount plus round-ups, capped by the owner's
/// own tracked savings (in cash or lent), times the share that goes into the asset.
fn this_week_spend(v: &UserVault) -> Result<u64> {
    let budget = v.weekly_amount.checked_add(v.pending_roundup).ok_or(VaultError::Math)?
        .min(v.cash_tracked.checked_add(v.lent_principal).ok_or(VaultError::Math)?);
    let spend = u64::try_from((budget as u128).checked_mul(v.asset_bps as u128).ok_or(VaultError::Math)? / BPS as u128)
        .map_err(|_| VaultError::Math)?;
    require!(spend > 0, VaultError::NothingToBuy);
    Ok(spend)
}

fn token_amount(ai: &AccountInfo) -> Result<u64> {
    let data = ai.try_borrow_data()?;
    Ok(TokenAccount::try_deserialize(&mut &data[..])?.amount)
}

/// The vault's lending share account: its associated token account for the share mint.
pub fn share_account(vault: &Pubkey, share_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[vault.as_ref(), anchor_spl::token::ID.as_ref(), share_mint.as_ref()], &ASSOCIATED_TOKEN_PROGRAM).0
}
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// The venue's accounts out of a Lend or Unlend context.
macro_rules! venue {
    ($a:expr) => {
        lending::Venue {
            lending_admin: $a.lending_admin.as_ref(), lending: $a.lending.as_ref(), f_token_mint: $a.f_token_mint.as_ref(),
            supply_reserves: $a.supply_reserves.as_ref(), supply_position: $a.supply_position.as_ref(),
            rate_model: $a.rate_model.as_ref(), vault: $a.lend_vault.as_ref(), liquidity: $a.liquidity.as_ref(),
            liquidity_program: $a.liquidity_program.as_ref(), rewards_rate_model: $a.rewards_rate_model.as_ref(),
            token_program: $a.token_program.as_ref(), associated_token_program: $a.associated_token_program.as_ref(),
            system_program: $a.system_program.as_ref(), lend_program: $a.lend_program.as_ref(),
        }
    };
}
use venue;

fn release<'info>(
    c: &mut Account<'info, Config>,
    v: &mut Account<'info, UserVault>,
    from: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: AccountInfo<'info>,
    token_program: Pubkey,
    amount: u64,
) -> Result<()> {
    // u64::MAX means "everything in this account": after lending comes back the exact amount isn't known
    // until the transaction runs (interest, or a unit of Jupiter's rounding), and the saver wants all of it
    let amount = if amount == u64::MAX { from.amount } else { amount };
    require!(amount > 0, VaultError::ZeroAmount);
    let held = from.amount;
    require!(held >= amount, VaultError::Insufficient);

    let released = if mint.key() == c.usdc_mint {
        // Tracked dollars can never be more than what is really there.
        let new_tracked = v.cash_tracked.min(held - amount);
        let released = v.cash_tracked - new_tracked;
        v.cash_tracked = new_tracked;
        released
    } else {
        // Free up the matching share of what was spent on the asset.
        let released = if amount == held {
            v.asset_basis
        } else {
            u64::try_from(
                (v.asset_basis as u128)
                    .checked_mul(amount as u128)
                    .ok_or(VaultError::Math)?
                    / held as u128,
            )
            .map_err(|_| VaultError::Math)?
        };
        v.asset_basis = v
            .asset_basis
            .checked_sub(released)
            .ok_or(VaultError::Math)?;
        released
    };
    c.total_principal = c.total_principal.saturating_sub(released);

    let seeds: &[&[u8]] = &[VAULT_SEED, v.owner.as_ref(), &[v.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to,
                authority: v.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )?;
    emit!(Withdrawn {
        owner: v.owner,
        mint: mint.key(),
        amount
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(constraint = asset_mint.key() != usdc_mint.key())]
    pub asset_mint: Account<'info, Mint>,
    /// CHECK: only its address is stored, and it must be a program.
    #[account(executable)]
    pub swap_program: UncheckedAccount<'info>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ VaultError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::Vault>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ VaultError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ VaultError::NotAdmin,
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_admin == new_admin.key() @ VaultError::NotPendingAdmin,
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct OpenVault<'info> {
    /// Pays the rent. Kept apart from the owner so a sponsor can cover it for new users.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + UserVault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub user_vault: Account<'info, UserVault>,
    #[account(
        init,
        payer = payer,
        seeds = [CASH_SEED, user_vault.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = user_vault,
    )]
    pub cash: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        seeds = [HOLD_SEED, user_vault.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = user_vault,
    )]
    pub hold: Account<'info, TokenAccount>,
    /// CHECK: an address with no data. It is only ever lent the right to move one week's spend.
    #[account(seeds = [SWAP_AUTH_SEED, user_vault.key().as_ref()], bump)]
    pub swap_authority: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(address = config.asset_mint)]
    pub asset_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = user_vault.bump,
        has_one = owner,
    )]
    pub user_vault: Account<'info, UserVault>,
}


#[derive(Accounts)]
pub struct Lend<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump = user_vault.bump, has_one = owner)]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(mut, seeds = [CASH_SEED, user_vault.key().as_ref()], bump = user_vault.cash_bump)]
    pub cash: Box<Account<'info, TokenAccount>>,
    /// CHECK: the vault's own lending share account, checked in the handler.
    #[account(mut)]
    pub shares: UncheckedAccount<'info>,
    /// CHECK: the vault's own associated USDC account, used to stage moves; checked in the handler.
    #[account(mut)]
    pub staging: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: Jupiter Lend's admin PDA, pinned in the handler.
    pub lending_admin: UncheckedAccount<'info>,
    /// CHECK: the USDC market, pinned in the handler.
    #[account(mut)]
    pub lending: UncheckedAccount<'info>,
    /// CHECK: the market's share mint, pinned in the handler.
    #[account(mut)]
    pub f_token_mint: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub supply_reserves: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub supply_position: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    pub rate_model: UncheckedAccount<'info>,
    /// CHECK: Jupiter Lend's token vault, checked by Jupiter Lend.
    #[account(mut)]
    pub lend_vault: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub liquidity: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler. Jupiter Lend takes its liquidity program as writable.
    #[account(mut)]
    pub liquidity_program: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    pub rewards_rate_model: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler.
    pub lend_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: the associated token program.
    #[account(address = ASSOCIATED_TOKEN_PROGRAM)]
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PrepareBuy<'info> {
    /// Anyone. Pays the fee and decides nothing.
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, user_vault.owner.as_ref()], bump = user_vault.bump)]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(mut, seeds = [CASH_SEED, user_vault.key().as_ref()], bump = user_vault.cash_bump)]
    pub cash: Box<Account<'info, TokenAccount>>,
    /// CHECK: the vault's own lending share account, checked in the handler.
    #[account(mut)]
    pub shares: UncheckedAccount<'info>,
    /// CHECK: the vault's own associated USDC account, checked in the handler.
    #[account(mut)]
    pub staging: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: Jupiter Lend's claim account, checked by Jupiter Lend.
    #[account(mut)]
    pub claim_account: UncheckedAccount<'info>,
    /// CHECK: Jupiter Lend's admin PDA, pinned in the handler.
    pub lending_admin: UncheckedAccount<'info>,
    /// CHECK: the USDC market, pinned in the handler.
    #[account(mut)]
    pub lending: UncheckedAccount<'info>,
    /// CHECK: the market's share mint, pinned in the handler.
    #[account(mut)]
    pub f_token_mint: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub supply_reserves: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub supply_position: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    pub rate_model: UncheckedAccount<'info>,
    /// CHECK: Jupiter Lend's token vault, checked by Jupiter Lend.
    #[account(mut)]
    pub lend_vault: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub liquidity: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler. Jupiter Lend takes its liquidity program as writable.
    #[account(mut)]
    pub liquidity_program: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    pub rewards_rate_model: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler.
    pub lend_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: the associated token program.
    #[account(address = ASSOCIATED_TOKEN_PROGRAM)]
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unlend<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump = user_vault.bump, has_one = owner)]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(mut, seeds = [CASH_SEED, user_vault.key().as_ref()], bump = user_vault.cash_bump)]
    pub cash: Box<Account<'info, TokenAccount>>,
    /// CHECK: the vault's own lending share account, checked in the handler.
    #[account(mut)]
    pub shares: UncheckedAccount<'info>,
    /// CHECK: the vault's own associated USDC account, used to stage moves; checked in the handler.
    #[account(mut)]
    pub staging: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: Jupiter Lend's claim account, checked by Jupiter Lend.
    #[account(mut)]
    pub claim_account: UncheckedAccount<'info>,
    /// CHECK: Jupiter Lend's admin PDA, pinned in the handler.
    pub lending_admin: UncheckedAccount<'info>,
    /// CHECK: the USDC market, pinned in the handler.
    #[account(mut)]
    pub lending: UncheckedAccount<'info>,
    /// CHECK: the market's share mint, pinned in the handler.
    #[account(mut)]
    pub f_token_mint: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub supply_reserves: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub supply_position: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    pub rate_model: UncheckedAccount<'info>,
    /// CHECK: Jupiter Lend's token vault, checked by Jupiter Lend.
    #[account(mut)]
    pub lend_vault: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub liquidity: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler. Jupiter Lend takes its liquidity program as writable.
    #[account(mut)]
    pub liquidity_program: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    pub rewards_rate_model: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler.
    pub lend_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: the associated token program.
    #[account(address = ASSOCIATED_TOKEN_PROGRAM)]
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED, owner.key().as_ref()], bump = user_vault.bump, has_one = owner)]
    pub user_vault: Account<'info, UserVault>,
    #[account(init_if_needed, payer = owner, space = 8 + AgentPolicy::INIT_SPACE, seeds = [AGENT_SEED, user_vault.key().as_ref()], bump)]
    pub policy: Account<'info, AgentPolicy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AgentRun<'info> {
    pub agent: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, user_vault.owner.as_ref()], bump = user_vault.bump)]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(mut, seeds = [AGENT_SEED, user_vault.key().as_ref()], bump = policy.bump, constraint = policy.user_vault == user_vault.key() @ VaultError::NotTheAgent)]
    pub policy: Box<Account<'info, AgentPolicy>>,
    /// CHECK: the agent authority PDA: it holds no data, it only signs for the allowance the saver gave it.
    #[account(seeds = [AGENT_AUTH_SEED, user_vault.key().as_ref()], bump)]
    pub agent_auth: UncheckedAccount<'info>,
    /// The saver's own dollars (the allowance is checked by the token program).
    #[account(mut, token::mint = usdc_mint, token::authority = user_vault.owner)]
    pub from: Box<Account<'info, TokenAccount>>,
    /// Where the chore sends them: checked against the chore in the handler.
    #[account(mut, token::mint = usdc_mint)]
    pub to: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [CASH_SEED, user_vault.key().as_ref()], bump = user_vault.cash_bump)]
    pub cash: Box<Account<'info, TokenAccount>>,
    /// CHECK: the rooms program's ["pocket", owner] record (read only for a private save).
    pub pocket_of: UncheckedAccount<'info>,
    /// Kashu's treasury for the run's fee: a dollar account the admin owns (checked in the handler).
    #[account(mut, token::mint = usdc_mint)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SavePrivate<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump = user_vault.bump, has_one = owner)]
    pub user_vault: Account<'info, UserVault>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub from: Account<'info, TokenAccount>,
    /// The pocket's dollar account; who holds it is checked against `pocket_of` in the handler.
    #[account(mut, token::mint = usdc_mint)]
    pub to: Account<'info, TokenAccount>,
    /// CHECK: the rooms program's ["pocket", owner] record, read and checked by prize::read_pocket.
    pub pocket_of: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = user_vault.bump,
        has_one = owner,
    )]
    pub user_vault: Account<'info, UserVault>,
    #[account(
        mut,
        seeds = [CASH_SEED, user_vault.key().as_ref()],
        bump = user_vault.cash_bump,
    )]
    pub cash: Account<'info, TokenAccount>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub from: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WeeklyBuy<'info> {
    /// Anyone. Pays the fee and decides nothing.
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(
        mut,
        seeds = [CASH_SEED, user_vault.key().as_ref()],
        bump = user_vault.cash_bump,
        token::mint = usdc_mint,
        token::authority = user_vault,
    )]
    pub cash: Box<Account<'info, TokenAccount>>,
    /// The only place a buy can land: this user's own holding account for the menu asset.
    #[account(
        mut,
        seeds = [HOLD_SEED, user_vault.key().as_ref()],
        bump = user_vault.hold_bump,
        token::mint = asset_mint,
        token::authority = user_vault,
    )]
    pub hold: Box<Account<'info, TokenAccount>>,
    /// CHECK: the address lent this week's spend. Seeds checked here.
    #[account(
        seeds = [SWAP_AUTH_SEED, user_vault.key().as_ref()],
        bump = user_vault.swap_auth_bump,
    )]
    pub swap_authority: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = config.asset_mint)]
    pub asset_mint: Box<Account<'info, Mint>>,
    /// CHECK: the swap authority's own dollar account (its associated account); checked by address.
    #[account(mut, address = share_account(&swap_authority.key(), &usdc_mint.key()) @ VaultError::WrongShareAccount)]
    pub swap_in: UncheckedAccount<'info>,
    /// CHECK: the swap authority's own asset account (its associated account); checked by address.
    #[account(mut, address = share_account(&swap_authority.key(), &asset_mint.key()) @ VaultError::WrongShareAccount)]
    pub swap_out: UncheckedAccount<'info>,
    #[account(seeds = [VENUE_SEED], bump = venue.bump)]
    pub venue: Box<Account<'info, Venue>>,
    /// CHECK: must be the one venue named in the venue settings. The route's accounts follow as
    /// remaining accounts; the vault does not trust them: see swap.rs.
    #[account(address = venue.swap_program, executable)]
    pub swap_program: UncheckedAccount<'info>,
    /// CHECK: any Pyth price update for the venue's feed: owned by Pyth's receiver, fully verified, the
    /// right feed id, fresh and narrow (oracle.rs). Pyth's own guidance: the owner, verification level and
    /// feed id make an update genuine, not its address, so the weekly job may post a fresh one from Hermes
    /// in the same transaction.
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetVenue<'info> {
    #[account(mut, address = config.admin @ VaultError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + Venue::INIT_SPACE, seeds = [VENUE_SEED], bump)]
    pub venue: Box<Account<'info, Venue>>,
    /// CHECK: any executable program; Jupiter's aggregator on mainnet.
    #[account(executable)]
    pub swap_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// One set of accounts for both kinds of withdrawal. Both destinations must be token accounts the
/// owner controls, and the owner must sign.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = user_vault.bump,
        has_one = owner,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(
        mut,
        seeds = [CASH_SEED, user_vault.key().as_ref()],
        bump = user_vault.cash_bump,
    )]
    pub cash: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [HOLD_SEED, user_vault.key().as_ref()],
        bump = user_vault.hold_bump,
    )]
    pub hold: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = asset_mint, token::authority = owner)]
    pub owner_asset: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = config.asset_mint)]
    pub asset_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// A withdrawal carried by a hash-based signature. Nobody's ordinary signature matters here.
#[derive(Accounts)]
pub struct WithdrawPq<'info> {
    /// Anyone. Pays the fee and decides nothing.
    pub relayer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(
        mut,
        seeds = [CASH_SEED, user_vault.key().as_ref()],
        bump = user_vault.cash_bump,
    )]
    pub cash: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [HOLD_SEED, user_vault.key().as_ref()],
        bump = user_vault.hold_bump,
    )]
    pub hold: Box<Account<'info, TokenAccount>>,
    /// Whatever account the signature names. Its address is part of the signed message.
    #[account(mut)]
    pub destination: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = config.asset_mint)]
    pub asset_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RotatePq<'info> {
    /// Anyone. Pays the fee and decides nothing.
    pub relayer: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,
}

#[event]
pub struct VenueSet {
    pub swap_program: Pubkey,
    pub price_feed: Pubkey,
    pub slippage_bps: u16,
}

#[event]
pub struct Lent {
    pub owner: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct Unlent {
    pub owner: Pubkey,
    pub amount: u64,
    pub interest: u64,
    pub shares: u64,
}

#[event]
pub struct PqKeySet {
    pub owner: Pubkey,
    pub root: [u8; 32],
    pub height: u8,
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

#[event]
pub struct RuleSet {
    pub owner: Pubkey,
    pub weekly_amount: u64,
    pub roundup_unit: u64,
    pub asset_bps: u16,
}

#[event]
pub struct AgentSet {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub weekly_cap: u64,
}

#[event]
pub struct AgentRan {
    pub owner: Pubkey,
    pub chore: u8,
    pub kind: u8,
    pub amount: u64,
}

#[event]
pub struct SavedPrivately {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Bought {
    pub owner: Pubkey,
    pub spent: u64,
    pub received: u64,
    pub next_buy_at: i64,
}

#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

// ---- the Friday prize ----

#[derive(Accounts)]
pub struct InitPrize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + PrizeConfig::INIT_SPACE, seeds = [PRIZE_SEED], bump)]
    pub prize_config: Account<'info, PrizeConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrizeCut<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [PRIZE_SEED], bump = prize_config.bump)]
    pub prize_config: Account<'info, PrizeConfig>,
}

#[derive(Accounts)]
pub struct OpenPot<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: a rooms-program Room, read and checked by prize::read_room.
    pub room: UncheckedAccount<'info>,
    /// CHECK: the room's delegation record when it is on the rollup (checked by prize::read_room).
    pub delegation_record: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Pot::INIT_SPACE, seeds = [POT_SEED, room.key().as_ref()], bump)]
    pub pot: Box<Account<'info, Pot>>,
    #[account(init, payer = payer, seeds = [POT_USDC_SEED, room.key().as_ref()], bump, token::mint = usdc_mint, token::authority = pot)]
    pub pot_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LinkPot<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED, owner.key().as_ref()], bump = user_vault.bump, has_one = owner)]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(seeds = [POT_SEED, pot.room.as_ref()], bump = pot.bump)]
    pub pot: Box<Account<'info, Pot>>,
    #[account(init, payer = owner, space = 8 + PotLink::INIT_SPACE, seeds = [LINK_SEED, user_vault.key().as_ref()], bump)]
    pub link: Box<Account<'info, PotLink>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnlinkPot<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED, owner.key().as_ref()], bump = user_vault.bump, has_one = owner)]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(mut, close = owner, seeds = [LINK_SEED, user_vault.key().as_ref()], bump = link.bump)]
    pub link: Box<Account<'info, PotLink>>,
}

#[derive(Accounts)]
pub struct Harvest<'info> {
    /// Anyone. Pays the fee and decides nothing.
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [PRIZE_SEED], bump = prize_config.bump)]
    pub prize_config: Box<Account<'info, PrizeConfig>>,
    /// Jupiter Lend takes the depositor (the vault) as writable.
    #[account(mut, seeds = [VAULT_SEED, user_vault.owner.as_ref()], bump = user_vault.bump)]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(seeds = [LINK_SEED, user_vault.key().as_ref()], bump = link.bump)]
    pub link: Box<Account<'info, PotLink>>,
    #[account(mut, seeds = [POT_SEED, pot.room.as_ref()], bump = pot.bump)]
    pub pot: Box<Account<'info, Pot>>,
    #[account(mut, seeds = [POT_USDC_SEED, pot.room.as_ref()], bump = pot.usdc_bump)]
    pub pot_usdc: Box<Account<'info, TokenAccount>>,
    /// Kashu's treasury: any dollar account the admin owns.
    #[account(mut, token::mint = usdc_mint)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [CASH_SEED, user_vault.key().as_ref()], bump = user_vault.cash_bump)]
    pub cash: Box<Account<'info, TokenAccount>>,
    /// CHECK: the vault's own lending share account, checked in the handler.
    #[account(mut)]
    pub shares: UncheckedAccount<'info>,
    /// CHECK: the vault's own associated USDC account, checked in the handler.
    #[account(mut)]
    pub staging: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: Jupiter Lend's claim account, checked by Jupiter Lend.
    #[account(mut)]
    pub claim_account: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler.
    pub lending_admin: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler.
    #[account(mut)]
    pub lending: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler.
    #[account(mut)]
    pub f_token_mint: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub supply_reserves: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub supply_position: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    pub rate_model: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub lend_vault: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    #[account(mut)]
    pub liquidity: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler.
    #[account(mut)]
    pub liquidity_program: UncheckedAccount<'info>,
    /// CHECK: checked by Jupiter Lend.
    pub rewards_rate_model: UncheckedAccount<'info>,
    /// CHECK: pinned in the handler.
    pub lend_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: the associated token program.
    #[account(address = ASSOCIATED_TOKEN_PROGRAM)]
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayPrize<'info> {
    /// Anyone. Pays the fee (and, the first time, the winner's winnings record) and decides nothing.
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POT_SEED, pot.room.as_ref()], bump = pot.bump)]
    pub pot: Box<Account<'info, Pot>>,
    #[account(mut, seeds = [POT_USDC_SEED, pot.room.as_ref()], bump = pot.usdc_bump)]
    pub pot_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: the rooms program's draw-result record for the pot's room, read and checked by prize::read_result.
    pub draw_result: UncheckedAccount<'info>,
    /// CHECK: that record's delegation record when it is on the rollup (checked by prize::read_result).
    pub delegation_record: UncheckedAccount<'info>,
    #[account(mut, seeds = [VAULT_SEED, winner_vault.owner.as_ref()], bump = winner_vault.bump)]
    pub winner_vault: Box<Account<'info, UserVault>>,
    #[account(mut, seeds = [CASH_SEED, winner_vault.key().as_ref()], bump = winner_vault.cash_bump)]
    pub winner_cash: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    #[account(init_if_needed, payer = cranker, space = 8 + Winnings::INIT_SPACE, seeds = [WINNINGS_SEED, winner_vault.key().as_ref()], bump)]
    pub winnings: Box<Account<'info, Winnings>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetDca<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [VAULT_SEED, owner.key().as_ref()], bump = user_vault.bump, has_one = owner)]
    pub user_vault: Box<Account<'info, UserVault>>,
    #[account(init_if_needed, payer = owner, space = 8 + Winnings::INIT_SPACE, seeds = [WINNINGS_SEED, user_vault.key().as_ref()], bump)]
    pub winnings: Box<Account<'info, Winnings>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DcaBuy<'info> {
    pub buy: WeeklyBuy<'info>,
    #[account(mut, seeds = [WINNINGS_SEED, buy.user_vault.key().as_ref()], bump = winnings.bump)]
    pub winnings: Box<Account<'info, Winnings>>,
}

#[event]
pub struct DcaSet {
    pub owner: Pubkey,
    pub weekly: u64,
}

#[event]
pub struct DcaBought {
    pub owner: Pubkey,
    pub spent: u64,
    pub received: u64,
    pub left: u64,
}

#[event]
pub struct PrizeCutSet {
    pub cut_bps: u16,
}

#[event]
pub struct PotOpened {
    pub room: Pubkey,
}

#[event]
pub struct PotLinked {
    pub owner: Pubkey,
    pub room: Pubkey,
}

#[event]
pub struct PotUnlinked {
    pub owner: Pubkey,
    pub room: Pubkey,
}

#[event]
pub struct Harvested {
    pub owner: Pubkey,
    pub room: Pubkey,
    pub interest: u64,
    pub cut: u64,
    pub to_pot: u64,
}

#[event]
pub struct PrizePaid {
    pub room: Pubkey,
    pub week: u32,
    pub winner: Pubkey,
    pub amount: u64,
}
