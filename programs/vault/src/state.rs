use anchor_lang::prelude::*;

/// One per program. Holds the beta limits, the fixed menu and the pause switch.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Meant to be a Squads vault behind a time lock. Can pause, lower or restore caps inside the
    /// hard limits, and move the price floor. Cannot touch anybody's money.
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    /// The fixed menu: the dollar token and one asset. Set once, never changed.
    pub usdc_mint: Pubkey,
    pub asset_mint: Pubkey,
    /// The only program the weekly buy may call. Set once, never changed.
    pub swap_program: Pubkey,
    pub per_user_cap: u64,
    pub total_cap: u64,
    /// Dollars the program is managing right now across all users, in base units.
    pub total_principal: u64,
    /// Least asset base units a buy must return per dollar base unit, times RATE_SCALE.
    /// A stand-in for an oracle price bound.
    pub floor_rate: u64,
    pub paused: bool,
    pub bump: u8,
}

/// One per user. The token accounts that hold the money are owned by this account's address.
#[account]
#[derive(InitSpace)]
pub struct UserVault {
    pub owner: Pubkey,
    /// Dollars sitting in the cash account that came in through `deposit`. Tokens sent straight
    /// to the cash account are not counted, are never invested, and can only go back to the owner.
    pub cash_tracked: u64,
    /// Dollars spent so far on the asset still held. cash_tracked + asset_basis is what counts
    /// against the caps.
    pub asset_basis: u64,
    /// Rule: put this many dollars to work each week.
    pub weekly_amount: u64,
    /// Rule: round each noted spend up to the next multiple of this. Zero turns round-ups off.
    pub roundup_unit: u64,
    /// Round-up change collected since the last weekly buy.
    pub pending_roundup: u64,
    /// Share of each week's budget that buys the asset, in basis points. The rest stays in dollars.
    pub asset_bps: u16,
    pub next_buy_at: i64,
    /// Saves counted for the room: each deposit of at least MIN_SAVE, and each weekly buy.
    pub buys_done: u32,
    pub bump: u8,
    pub cash_bump: u8,
    pub hold_bump: u8,
    pub swap_auth_bump: u8,
    /// The hash-based withdrawal key. All zeros means none is enrolled and the owner's ordinary
    /// signature is what lets money out. Once a root is set, only a one-time hash-based
    /// signature can withdraw or replace the root.
    pub pq_seed: [u8; 32],
    pub pq_root: [u8; 32],
    /// The tree has 2^pq_height one-time keys.
    pub pq_height: u8,
    /// Lowest key number still unused. Each signature must use this number or a higher one.
    pub pq_next_leaf: u32,
    /// Dollars of the owner's own savings currently lent on Jupiter Lend, at what was put in.
    /// Anything the shares are worth above this is interest.
    pub lent_principal: u64,
}

/// A saver's prize winnings, kept apart from their savings: what they've won, what's left to turn into
/// the asset, and the weekly amount they chose. Its own account so existing vaults stay as they are.
#[account]
#[derive(InitSpace)]
pub struct Winnings {
    pub vault: Pubkey,
    pub total_won: u64,
    pub left: u64,
    pub weekly: u64,
    pub next_at: i64,
    pub prizes: u32,
    pub bump: u8,
}

/// Where and at what price the weekly buy may trade. Set once by the admin, inside hard limits.
#[account]
#[derive(InitSpace)]
pub struct Venue {
    /// The only program a weekly buy may call (Jupiter's aggregator on mainnet).
    pub swap_program: Pubkey,
    /// The usual Pyth price account for the asset in dollars (a hint for the weekly job; any genuine update
    /// for the feed is accepted), and the feed id every price update must carry.
    pub price_feed: Pubkey,
    pub feed_id: [u8; 32],
    /// How old the price may be, how wide its confidence band, and how far under it a buy may fill.
    pub max_age_secs: u32,
    pub max_conf_bps: u16,
    pub slippage_bps: u16,
    pub bump: u8,
}

impl UserVault {
    pub fn pq_enrolled(&self) -> bool {
        self.pq_root != [0u8; 32]
    }
}
