//! A stand-in for a real swap venue. Tests and devnet only. Never deploy this to mainnet.
//!
//! It swaps the dollar token for one asset at a fixed rate out of a pool that the test funds. The
//! vault program talks to it through the same shape it will use for Jupiter: one signer that may
//! move the input, a source account, a destination account, an amount in and a minimum out.
//!
//! `mode` lets a test make the pool misbehave on purpose, so we can prove the vault's own checks
//! hold even when the venue is hostile:
//!   0 = honest
//!   1 = tries to take one unit more than it was told to
//!   2 = pays out one unit less than the minimum and ignores the minimum

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("2GHiWi58tM1BMVHU52ey88ncEzQq2q6AHNnbujcvrUTF");

pub const RATE_SCALE: u128 = 1_000_000_000;

#[program]
pub mod stub_swap {
    use super::*;

    pub fn init_pool(ctx: Context<InitPool>, rate: u64, mode: u8) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.usdc_mint = ctx.accounts.usdc_mint.key();
        pool.asset_mint = ctx.accounts.asset_mint.key();
        pool.rate = rate;
        pool.mode = mode;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_out: u64) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let mut take = amount_in;
        let mut out = u64::try_from(
            (amount_in as u128)
                .checked_mul(pool.rate as u128)
                .ok_or(StubError::Math)?
                / RATE_SCALE,
        )
        .map_err(|_| StubError::Math)?;

        match pool.mode {
            1 => take = take.checked_add(1).ok_or(StubError::Math)?,
            2 => out = min_out.saturating_sub(1),
            _ => require!(out >= min_out, StubError::Slippage),
        }

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.pool_usdc.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            take,
            ctx.accounts.usdc_mint.decimals,
        )?;

        let usdc_key = pool.usdc_mint;
        let asset_key = pool.asset_mint;
        let seeds: &[&[u8]] = &[b"pool", usdc_key.as_ref(), asset_key.as_ref(), &[pool.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.pool_asset.to_account_info(),
                    mint: ctx.accounts.asset_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            out,
            ctx.accounts.asset_mint.decimals,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    pub asset_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", usdc_mint.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = payer,
        seeds = [b"pool_usdc", pool.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool,
    )]
    pub pool_usdc: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        seeds = [b"pool_asset", pool.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = pool,
    )]
    pub pool_asset: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Account order is the swap interface the vault program calls. Keep it in step with
/// programs/vault/src/swap.rs.
#[derive(Accounts)]
pub struct Swap<'info> {
    pub authority: Signer<'info>,
    #[account(mut, token::mint = usdc_mint)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut, token::mint = asset_mint)]
    pub destination: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"pool", usdc_mint.key().as_ref(), asset_mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"pool_usdc", pool.key().as_ref()], bump)]
    pub pool_usdc: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"pool_asset", pool.key().as_ref()], bump)]
    pub pool_asset: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    pub asset_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub usdc_mint: Pubkey,
    pub asset_mint: Pubkey,
    /// Asset base units paid per dollar base unit, times RATE_SCALE.
    pub rate: u64,
    pub mode: u8,
    pub bump: u8,
}

#[error_code]
pub enum StubError {
    #[msg("math overflow")]
    Math,
    #[msg("output below the minimum")]
    Slippage,
}
