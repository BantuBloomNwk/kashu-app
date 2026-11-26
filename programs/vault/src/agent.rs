//! Kashu's agent: chores a saver sets, run for them on schedule, inside limits this program enforces.
//!
//! The saver signs a policy (with their passkey): which key is the agent, a weekly cap, up to four people they may
//! pay, and up to four chores (save, save privately, pay someone). They approve their dollars for this program's
//! "agent authority" account, never for the agent itself, so the allowance can only be spent through `agent_run`.
//! `agent_run` does exactly one chore from the policy, with the amount written there, at most once a week each,
//! and only to the saver's own vault, the private pocket their wallet named, or a payee they listed. The agent
//! can't take money out of the vault, change the pocket, add a backup key or touch anything else: a stolen agent
//! key could at worst move a saver's money into their own savings, or to people they chose, within their cap.

use anchor_lang::prelude::*;

pub const AGENT_SEED: &[u8] = b"agent";
pub const AGENT_AUTH_SEED: &[u8] = b"agent_auth";
pub const MAX_PAYEES: usize = 4;
pub const MAX_CHORES: usize = 4;
/// What Kashu charges each time a chore runs (one cent), to cover the network fees it pays for the agent.
pub const AGENT_FEE: u64 = 10_000;

pub const CHORE_NONE: u8 = 0;
pub const CHORE_SAVE: u8 = 1;
pub const CHORE_SAVE_PRIVATE: u8 = 2;
pub const CHORE_PAY: u8 = 3;
/// A reminder: run by the keeper as a notification, never on chain.
pub const CHORE_REMIND: u8 = 4;

/// How often a chore may run, and the window the weekly cap counts over.
#[cfg(not(feature = "devnet"))]
pub const CHORE_GAP: i64 = 6 * 24 * 3600;
#[cfg(feature = "devnet")]
pub const CHORE_GAP: i64 = 9 * 60;
#[cfg(not(feature = "devnet"))]
pub const CAP_WINDOW: i64 = 7 * 24 * 3600;
#[cfg(feature = "devnet")]
pub const CAP_WINDOW: i64 = 10 * 60;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Chore {
    pub kind: u8,
    pub amount: u64,
    /// When the keeper runs it (the program only enforces "at most once a week").
    pub weekday: u8,
    pub hour: u8,
    /// For CHORE_PAY: which payee.
    pub payee: u8,
    pub last_run: i64,
}

#[account]
#[derive(InitSpace)]
pub struct AgentPolicy {
    pub user_vault: Pubkey,
    /// The key allowed to run chores (Pubkey::default() = no agent).
    pub agent: Pubkey,
    pub weekly_cap: u64,
    pub window_start: i64,
    pub spent: u64,
    pub payees: [Pubkey; MAX_PAYEES],
    pub chores: [Chore; MAX_CHORES],
    pub bump: u8,
}

impl AgentPolicy {
    /// Counts `amount` against the weekly cap, starting a new window when the last one is over.
    pub fn charge(&mut self, amount: u64, now: i64) -> Result<()> {
        if now >= self.window_start + CAP_WINDOW {
            self.window_start = now;
            self.spent = 0;
        }
        let spent = self.spent.checked_add(amount).ok_or(crate::VaultError::Math)?;
        require!(spent <= self.weekly_cap, crate::VaultError::AgentCap);
        self.spent = spent;
        Ok(())
    }
}
