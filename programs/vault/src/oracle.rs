//! The asset's price, from Pyth (a pull-oracle price update account, owned by Pyth's receiver program).
//! The weekly buy's minimum is set by this price, not by anyone's say-so: the crank chooses the route
//! but never the price, and an admin cannot loosen the bounds past the hard limits in `set_venue`.
//!
//! Checked on every read: the account belongs to Pyth's receiver, it is a fully verified update for the
//! one feed the venue names, it is fresh, its confidence band is narrow, and the price is positive.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::VaultError;

/// Pyth Solana Receiver (same id on mainnet and devnet).
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

pub struct Price {
    pub price: u64,
    pub expo: i32,
    pub publish_time: i64,
}

/// Reads and checks a PriceUpdateV2 account:
/// discriminator (8) | write_authority (32) | verification_level (1, or 2 for Partial) |
/// feed_id (32) | price i64 | conf u64 | exponent i32 | publish_time i64 | ...
pub fn read(ai: &AccountInfo, feed_id: &[u8; 32], now: i64, max_age: u32, max_conf_bps: u16) -> Result<Price> {
    require_keys_eq!(*ai.owner, PYTH_RECEIVER, VaultError::BadPrice);
    let d = ai.try_borrow_data()?;
    let disc = hashv(&[b"account:PriceUpdateV2"]).to_bytes();
    require!(d.len() >= 8 + 32 + 1 && d[..8] == disc[..8], VaultError::BadPrice);
    // only a fully verified update counts (variant 1); a partial one (variant 0) carries one more byte
    require!(d[40] == 1, VaultError::BadPrice);
    let o = 41;
    require!(d.len() >= o + 32 + 8 + 8 + 4 + 8, VaultError::BadPrice);
    require!(&d[o..o + 32] == feed_id, VaultError::BadPrice);
    let i64_at = |p: usize| i64::from_le_bytes(d[p..p + 8].try_into().unwrap());
    let price = i64_at(o + 32);
    let conf = u64::from_le_bytes(d[o + 40..o + 48].try_into().unwrap());
    let expo = i32::from_le_bytes(d[o + 48..o + 52].try_into().unwrap());
    let publish_time = i64_at(o + 52);
    require!(price > 0, VaultError::BadPrice);
    require!(publish_time <= now && now - publish_time <= max_age as i64, VaultError::StalePrice);
    // conf / price <= max_conf_bps / 10_000
    require!((conf as u128) * 10_000 <= (price as u128) * max_conf_bps as u128, VaultError::UnsurePrice);
    Ok(Price { price: price as u64, expo, publish_time })
}

/// Least asset base units a buy of `spend` dollar base units must return, at the oracle price less
/// `slippage_bps`. price is dollars per whole asset, times 10^expo.
pub fn min_out(spend: u64, p: &Price, usdc_decimals: u8, asset_decimals: u8, slippage_bps: u16) -> Result<u64> {
    // out = spend / 10^usdc_dec / (price * 10^expo) * 10^asset_dec
    //     = spend * 10^(asset_dec - usdc_dec - expo) / price
    let shift = asset_decimals as i32 - usdc_decimals as i32 - p.expo;
    let mut num = (spend as u128).checked_mul(10_000 - slippage_bps as u128).ok_or(VaultError::Math)?;
    let mut den = (p.price as u128).checked_mul(10_000).ok_or(VaultError::Math)?;
    if shift >= 0 { num = num.checked_mul(10u128.checked_pow(shift as u32).ok_or(VaultError::Math)?).ok_or(VaultError::Math)?; }
    else { den = den.checked_mul(10u128.checked_pow((-shift) as u32).ok_or(VaultError::Math)?).ok_or(VaultError::Math)?; }
    u64::try_from(num / den).map_err(|_| error!(VaultError::Math))
}
