//! Savings earn interest on Jupiter Lend (Earn). The vault itself is the depositor: it signs for its
//! own cash account, and the lending shares (jlUSDC) land in the vault's own share account, so the
//! money never leaves the owner's vault. Only the owner can move dollars in or out of lending, and
//! moving them never sends anything outside the vault.
//!
//! Jupiter Lend checks its own accounts. We pin what is ours to pin: the lending program, the
//! market's derived addresses for our dollar token, our cash account, and our share account. Then we
//! measure balances before and after, so a call that moved the wrong amount is refused whatever the
//! venue claims.
//!
//! Jupiter Lend only accepts associated token accounts, so the vault stages each move through its
//! own associated USDC account: cash -> staging -> lending on the way in, and lending -> staging ->
//! cash on the way out. Staging belongs to the vault too, and ends each move where it started.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, TokenAccount, TransferChecked};

use crate::USDC_DECIMALS;

use crate::VaultError;

/// Jupiter Lend program ids (Earn and Liquidity). Devnet builds use `--features devnet`.
#[cfg(feature = "devnet")]
pub const LEND_PROGRAM: Pubkey = pubkey!("7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3");
#[cfg(feature = "devnet")]
pub const LIQUIDITY_PROGRAM: Pubkey = pubkey!("5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL");
#[cfg(not(feature = "devnet"))]
pub const LEND_PROGRAM: Pubkey = pubkey!("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
#[cfg(not(feature = "devnet"))]
pub const LIQUIDITY_PROGRAM: Pubkey = pubkey!("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");

/// Anchor discriminators: sha256("global:deposit")[..8] and sha256("global:withdraw")[..8].
const DEPOSIT_IX: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const WITHDRAW_IX: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
/// sha256("global:redeem")[..8]: hand back a number of shares and receive what they are worth right now.
const REDEEM_IX: [u8; 8] = [184, 12, 86, 149, 70, 196, 97, 225];

/// The market's addresses that follow from the dollar token alone.
pub fn market(usdc_mint: &Pubkey) -> (Pubkey, Pubkey, Pubkey) {
    let (admin, _) = Pubkey::find_program_address(&[b"lending_admin"], &LEND_PROGRAM);
    let (f_mint, _) = Pubkey::find_program_address(&[b"f_token_mint", usdc_mint.as_ref()], &LEND_PROGRAM);
    let (lending, _) = Pubkey::find_program_address(&[b"lending", usdc_mint.as_ref(), f_mint.as_ref()], &LEND_PROGRAM);
    (admin, f_mint, lending)
}

/// The venue's own accounts, in the order its instructions take them. Everything here except the
/// pinned addresses is checked by Jupiter Lend itself.
pub struct Venue<'a, 'info> {
    pub lending_admin: &'a AccountInfo<'info>,
    pub lending: &'a AccountInfo<'info>,
    pub f_token_mint: &'a AccountInfo<'info>,
    pub supply_reserves: &'a AccountInfo<'info>,
    pub supply_position: &'a AccountInfo<'info>,
    pub rate_model: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
    pub liquidity: &'a AccountInfo<'info>,
    pub liquidity_program: &'a AccountInfo<'info>,
    pub rewards_rate_model: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub lend_program: &'a AccountInfo<'info>,
}

impl<'a, 'info> Venue<'a, 'info> {
    pub fn check(&self, usdc_mint: &Pubkey) -> Result<()> {
        let (admin, f_mint, lending) = market(usdc_mint);
        require_keys_eq!(*self.lend_program.key, LEND_PROGRAM, VaultError::WrongVenue);
        require_keys_eq!(*self.liquidity_program.key, LIQUIDITY_PROGRAM, VaultError::WrongVenue);
        require_keys_eq!(*self.lending_admin.key, admin, VaultError::WrongVenue);
        require_keys_eq!(*self.f_token_mint.key, f_mint, VaultError::WrongVenue);
        require_keys_eq!(*self.lending.key, lending, VaultError::WrongVenue);
        Ok(())
    }
}

fn amount_of(ai: &AccountInfo) -> Result<u64> {
    let data = ai.try_borrow_data()?;
    Ok(TokenAccount::try_deserialize(&mut &data[..])?.amount)
}

fn move_usdc<'info>(v: &Venue<'_, 'info>, from: &AccountInfo<'info>, to: &AccountInfo<'info>, mint: &AccountInfo<'info>,
    authority: &AccountInfo<'info>, seeds: &[&[u8]], amount: u64) -> Result<()> {
    token::transfer_checked(
        CpiContext::new_with_signer(v.token_program.key(), TransferChecked { from: from.clone(), mint: mint.clone(), to: to.clone(), authority: authority.clone() }, &[seeds]),
        amount, USDC_DECIMALS,
    )
}

/// Put `amount` dollars from the vault's cash into lending. Returns the shares received.
#[allow(clippy::too_many_arguments)]
pub fn deposit<'info>(
    v: &Venue<'_, 'info>,
    vault_signer: &AccountInfo<'info>,
    cash: &AccountInfo<'info>,
    staging: &AccountInfo<'info>,
    shares: &AccountInfo<'info>,
    usdc_mint: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<u64> {
    let (cash0, staging0, shares0) = (amount_of(cash)?, amount_of(staging)?, amount_of(shares)?);
    move_usdc(v, cash, staging, usdc_mint, vault_signer, seeds, amount)?;
    let mut data = DEPOSIT_IX.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    let accounts = vec![
        AccountMeta::new(*vault_signer.key, true),
        AccountMeta::new(*staging.key, false),
        AccountMeta::new(*shares.key, false),
        AccountMeta::new_readonly(*usdc_mint.key, false),
        AccountMeta::new_readonly(*v.lending_admin.key, false),
        AccountMeta::new(*v.lending.key, false),
        AccountMeta::new(*v.f_token_mint.key, false),
        AccountMeta::new(*v.supply_reserves.key, false),
        AccountMeta::new(*v.supply_position.key, false),
        AccountMeta::new_readonly(*v.rate_model.key, false),
        AccountMeta::new(*v.vault.key, false),
        AccountMeta::new(*v.liquidity.key, false),
        AccountMeta::new(*v.liquidity_program.key, false),
        AccountMeta::new_readonly(*v.rewards_rate_model.key, false),
        AccountMeta::new_readonly(*v.token_program.key, false),
        AccountMeta::new_readonly(*v.associated_token_program.key, false),
        AccountMeta::new_readonly(*v.system_program.key, false),
    ];
    let infos = [
        vault_signer.clone(), staging.clone(), shares.clone(), usdc_mint.clone(), v.lending_admin.clone(), v.lending.clone(),
        v.f_token_mint.clone(), v.supply_reserves.clone(), v.supply_position.clone(), v.rate_model.clone(), v.vault.clone(),
        v.liquidity.clone(), v.liquidity_program.clone(), v.rewards_rate_model.clone(), v.token_program.clone(),
        v.associated_token_program.clone(), v.system_program.clone(), v.lend_program.clone(),
    ];
    invoke_signed(&Instruction { program_id: LEND_PROGRAM, accounts, data }, &infos, &[seeds])?;
    let (cash1, staging1, shares1) = (amount_of(cash)?, amount_of(staging)?, amount_of(shares)?);
    // exactly `amount` left the cash, staging is back where it was, and shares arrived in the vault
    require!(cash0.checked_sub(cash1) == Some(amount), VaultError::VenueMisbehaved);
    require!(staging1 == staging0, VaultError::VenueMisbehaved);
    let got = shares1.checked_sub(shares0).ok_or(VaultError::VenueMisbehaved)?;
    require!(got > 0, VaultError::VenueMisbehaved);
    Ok(got)
}

/// Take `amount` dollars back out of lending into the vault's cash. Returns the shares burned.
#[allow(clippy::too_many_arguments)]
pub fn withdraw<'info>(
    v: &Venue<'_, 'info>,
    claim_account: &AccountInfo<'info>,
    vault_signer: &AccountInfo<'info>,
    cash: &AccountInfo<'info>,
    staging: &AccountInfo<'info>,
    shares: &AccountInfo<'info>,
    usdc_mint: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<u64> {
    let (cash0, staging0, shares0) = (amount_of(cash)?, amount_of(staging)?, amount_of(shares)?);
    let mut data = WITHDRAW_IX.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    let accounts = vec![
        AccountMeta::new(*vault_signer.key, true),
        AccountMeta::new(*shares.key, false),
        AccountMeta::new(*staging.key, false),
        AccountMeta::new_readonly(*v.lending_admin.key, false),
        AccountMeta::new(*v.lending.key, false),
        AccountMeta::new_readonly(*usdc_mint.key, false),
        AccountMeta::new(*v.f_token_mint.key, false),
        AccountMeta::new(*v.supply_reserves.key, false),
        AccountMeta::new(*v.supply_position.key, false),
        AccountMeta::new_readonly(*v.rate_model.key, false),
        AccountMeta::new(*v.vault.key, false),
        AccountMeta::new(*claim_account.key, false),
        AccountMeta::new(*v.liquidity.key, false),
        AccountMeta::new(*v.liquidity_program.key, false),
        AccountMeta::new_readonly(*v.rewards_rate_model.key, false),
        AccountMeta::new_readonly(*v.token_program.key, false),
        AccountMeta::new_readonly(*v.associated_token_program.key, false),
        AccountMeta::new_readonly(*v.system_program.key, false),
    ];
    let infos = [
        vault_signer.clone(), shares.clone(), staging.clone(), v.lending_admin.clone(), v.lending.clone(), usdc_mint.clone(),
        v.f_token_mint.clone(), v.supply_reserves.clone(), v.supply_position.clone(), v.rate_model.clone(), v.vault.clone(),
        claim_account.clone(), v.liquidity.clone(), v.liquidity_program.clone(), v.rewards_rate_model.clone(),
        v.token_program.clone(), v.associated_token_program.clone(), v.system_program.clone(), v.lend_program.clone(),
    ];
    invoke_signed(&Instruction { program_id: LEND_PROGRAM, accounts, data }, &infos, &[seeds])?;
    move_usdc(v, staging, cash, usdc_mint, vault_signer, seeds, amount)?;
    let (cash1, staging1, shares1) = (amount_of(cash)?, amount_of(staging)?, amount_of(shares)?);
    // exactly `amount` came back to the cash, staging is back where it was, and shares were burned
    require!(cash1.checked_sub(cash0) == Some(amount), VaultError::VenueMisbehaved);
    require!(staging1 == staging0, VaultError::VenueMisbehaved);
    let burned = shares0.checked_sub(shares1).ok_or(VaultError::VenueMisbehaved)?;
    require!(burned > 0, VaultError::VenueMisbehaved);
    Ok(burned)
}

/// Hand back every share the vault holds and receive their current value into the vault's cash (Jupiter prices it
/// fresh, so nothing is guessed). Returns the dollars received.
#[allow(clippy::too_many_arguments)]
pub fn redeem_all<'info>(
    v: &Venue<'_, 'info>,
    claim_account: &AccountInfo<'info>,
    vault_signer: &AccountInfo<'info>,
    cash: &AccountInfo<'info>,
    staging: &AccountInfo<'info>,
    shares: &AccountInfo<'info>,
    usdc_mint: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<u64> {
    let (cash0, staging0, shares0) = (amount_of(cash)?, amount_of(staging)?, amount_of(shares)?);
    require!(shares0 > 0, VaultError::ZeroAmount);
    let mut data = REDEEM_IX.to_vec();
    data.extend_from_slice(&shares0.to_le_bytes());
    let accounts = vec![
        AccountMeta::new(*vault_signer.key, true),
        AccountMeta::new(*shares.key, false),
        AccountMeta::new(*staging.key, false),
        AccountMeta::new_readonly(*v.lending_admin.key, false),
        AccountMeta::new(*v.lending.key, false),
        AccountMeta::new_readonly(*usdc_mint.key, false),
        AccountMeta::new(*v.f_token_mint.key, false),
        AccountMeta::new(*v.supply_reserves.key, false),
        AccountMeta::new(*v.supply_position.key, false),
        AccountMeta::new_readonly(*v.rate_model.key, false),
        AccountMeta::new(*v.vault.key, false),
        AccountMeta::new(*claim_account.key, false),
        AccountMeta::new(*v.liquidity.key, false),
        AccountMeta::new(*v.liquidity_program.key, false),
        AccountMeta::new_readonly(*v.rewards_rate_model.key, false),
        AccountMeta::new_readonly(*v.token_program.key, false),
        AccountMeta::new_readonly(*v.associated_token_program.key, false),
        AccountMeta::new_readonly(*v.system_program.key, false),
    ];
    let infos = [
        vault_signer.clone(), shares.clone(), staging.clone(), v.lending_admin.clone(), v.lending.clone(), usdc_mint.clone(),
        v.f_token_mint.clone(), v.supply_reserves.clone(), v.supply_position.clone(), v.rate_model.clone(), v.vault.clone(),
        claim_account.clone(), v.liquidity.clone(), v.liquidity_program.clone(), v.rewards_rate_model.clone(),
        v.token_program.clone(), v.associated_token_program.clone(), v.system_program.clone(), v.lend_program.clone(),
    ];
    invoke_signed(&Instruction { program_id: LEND_PROGRAM, accounts, data }, &infos, &[seeds])?;
    let got = amount_of(staging)?.checked_sub(staging0).ok_or(VaultError::VenueMisbehaved)?;
    require!(got > 0, VaultError::VenueMisbehaved);
    move_usdc(v, staging, cash, usdc_mint, vault_signer, seeds, got)?;
    // every share is gone, exactly what arrived went to cash, and staging is back where it was
    require!(amount_of(shares)? == 0, VaultError::VenueMisbehaved);
    require!(amount_of(cash)?.checked_sub(cash0) == Some(got), VaultError::VenueMisbehaved);
    require!(amount_of(staging)? == staging0, VaultError::VenueMisbehaved);
    Ok(got)
}
