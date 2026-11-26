//! The one place the vault talks to a swap venue.
//!
//! The venue is the program named once in the Venue settings: Jupiter's aggregator on mainnet (a route
//! from Jupiter's swap API), a test venue on devnet and in tests. The route, both its instruction data
//! and its accounts, comes from whoever presses the weekly button, so it is treated as hostile:
//!
//!   * the only signature the venue gets is the swap authority's: a vault-program address that holds
//!     exactly this week's spend in its own dollar account and nothing else. The vault never signs for
//!     the route, and the route never touches the cash or holding accounts;
//!   * the vault's own record, cash and holding accounts may not appear among the route's accounts;
//!   * the vault measures its balances before and after and refuses the whole transaction if the venue
//!     took a different amount, or paid less than the oracle-priced minimum;
//!   * afterwards everything the swap produced is swept into the vault's holding account and unspent
//!     dollars back to cash, and both money accounts must come back owned by the vault with no delegate.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

use crate::VaultError;

pub fn run_route<'info>(
    swap_program: &AccountInfo<'info>,
    swap_authority: &AccountInfo<'info>,
    forbidden: &[Pubkey],
    route_accounts: &[AccountInfo<'info>],
    route_data: Vec<u8>,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut metas = Vec::with_capacity(route_accounts.len());
    for ai in route_accounts {
        require!(!forbidden.contains(ai.key), VaultError::SwapAccountClash);
        // the swap authority is the only account the vault signs for
        metas.push(AccountMeta { pubkey: *ai.key, is_signer: ai.key == swap_authority.key, is_writable: ai.is_writable });
    }
    let mut infos: Vec<AccountInfo<'info>> = route_accounts.to_vec();
    infos.push(swap_authority.clone());
    infos.push(swap_program.clone());
    invoke_signed(&Instruction { program_id: *swap_program.key, accounts: metas, data: route_data }, &infos, &[authority_seeds])?;
    Ok(())
}
