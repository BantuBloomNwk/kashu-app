//! The Friday prize, paid from interest, never from savings.
//!
//! Each room has a pot here, in the vault program, holding dollars. Savers who join a room's pot let
//! their savings' interest feed it: anyone may harvest a linked vault, which takes out of Jupiter Lend
//! only what the vault's lending shares are worth above what the saver put in, sends Kashu's cut to
//! the treasury and the rest to the room's pot. Sponsors top the pot up with a plain token transfer.
//! Once the rooms program has settled a week's draw, anyone pays the pot to the winner's vault.
//!
//! The rooms program runs on a MagicBlock rollup, so the room's record on Solana is either owned by
//! the rooms program (after it was settled back) or held by MagicBlock's delegation program with the
//! last committed state. Both are accepted, the second only with the delegation record that names the
//! rooms program as the record's real owner.

use anchor_lang::prelude::*;

use crate::VaultError;

/// The rooms program (the same address on devnet and in tests).
pub const ROOMS_PROGRAM: Pubkey = pubkey!("8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q");
/// MagicBlock's delegation program, which holds a delegated record on Solana.
pub const DELEGATION_PROGRAM: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
/// sha256("account:Room")[..8]
const ROOM_DISCRIMINATOR: [u8; 8] = [156, 199, 67, 27, 222, 23, 185, 94];
/// The room's draw is settled and names its winner.
pub const DRAW_SETTLED: u8 = 3;

pub const PRIZE_SEED: &[u8] = b"prize";
pub const POT_SEED: &[u8] = b"pot";
pub const POT_USDC_SEED: &[u8] = b"pot_usdc";
pub const LINK_SEED: &[u8] = b"link";
/// Kashu's cut of harvested interest can never be set above 10%.
pub const MAX_CUT_BPS: u16 = 1_000;
/// Harvests smaller than a cent are not worth the fee.
pub const MIN_HARVEST: u64 = 10_000;
/// Rounding room left with the saver on every harvest, so their savings are never short by a unit.
pub const HARVEST_MARGIN: u64 = 2;
/// Jupiter Lend's exchange prices are scaled by 1e12.
const EXCHANGE_PRECISION: u128 = 1_000_000_000_000;

#[account]
#[derive(InitSpace)]
pub struct PrizeConfig {
    /// Kashu's share of harvested interest, in basis points (at most MAX_CUT_BPS).
    pub cut_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pot {
    pub room: Pubkey,
    /// Draws for weeks below this number are paid; the next payout must be for this week or later.
    pub paid_through: u32,
    pub harvested: u64,
    pub cut_taken: u64,
    pub paid_out: u64,
    pub bump: u8,
    pub usdc_bump: u8,
}

/// A saver's choice to feed a room's pot with their interest. No link, no harvest: in Keep mode the
/// interest stays with the saver.
#[account]
#[derive(InitSpace)]
pub struct PotLink {
    pub room: Pubkey,
    pub bump: u8,
}

pub struct RoomView {
    pub draw_week: u32,
    pub draw_state: u8,
    pub winner: Pubkey,
}

/// Reads a rooms-program Room from Solana, whether it is at home or delegated to the rollup.
pub fn read_room(room: &AccountInfo, delegation_record: &AccountInfo) -> Result<RoomView> {
    if *room.owner != ROOMS_PROGRAM {
        require_keys_eq!(*room.owner, DELEGATION_PROGRAM, VaultError::NotARoom);
        let (record, _) = Pubkey::find_program_address(&[b"delegation", room.key.as_ref()], &DELEGATION_PROGRAM);
        require_keys_eq!(*delegation_record.key, record, VaultError::NotARoom);
        require_keys_eq!(*delegation_record.owner, DELEGATION_PROGRAM, VaultError::NotARoom);
        let d = delegation_record.try_borrow_data()?;
        // [8-byte tag][authority][owner]...
        require!(d.len() >= 72 && d[40..72] == ROOMS_PROGRAM.to_bytes(), VaultError::NotARoom);
    }
    let d = room.try_borrow_data()?;
    // creator 32, room_id 8, name 24, week 4, week_starts_at 8, members 1, tickets 4, savers 2, bump 1,
    // draw_week 4, draw_state 1, winning_ticket 4, winner 32
    require!(d.len() >= 133 && d[..8] == ROOM_DISCRIMINATOR, VaultError::NotARoom);
    Ok(RoomView {
        draw_week: u32::from_le_bytes(d[92..96].try_into().unwrap()),
        draw_state: d[96],
        winner: Pubkey::new_from_array(d[101..133].try_into().unwrap()),
    })
}

/// sha256("account:DrawResult")[..8]
const RESULT_DISCRIMINATOR: [u8; 8] = [57, 182, 189, 16, 99, 232, 59, 243];

/// The rooms program's draw-result record for `room`: the week of the latest settled draw and its winner. On
/// Solana it is either at home (a room that isn't private) or held by the delegation program with the last
/// state the private rollup committed, the second only with a delegation record naming the rooms program.
pub fn read_result(result: &AccountInfo, delegation_record: &AccountInfo, room: &Pubkey) -> Result<(u32, Pubkey)> {
    let (expected, _) = Pubkey::find_program_address(&[b"result", room.as_ref()], &ROOMS_PROGRAM);
    require_keys_eq!(*result.key, expected, VaultError::NotARoom);
    if *result.owner != ROOMS_PROGRAM {
        require_keys_eq!(*result.owner, DELEGATION_PROGRAM, VaultError::NotARoom);
        let (record, _) = Pubkey::find_program_address(&[b"delegation", result.key.as_ref()], &DELEGATION_PROGRAM);
        require_keys_eq!(*delegation_record.key, record, VaultError::NotARoom);
        require_keys_eq!(*delegation_record.owner, DELEGATION_PROGRAM, VaultError::NotARoom);
        let d = delegation_record.try_borrow_data()?;
        require!(d.len() >= 72 && d[40..72] == ROOMS_PROGRAM.to_bytes(), VaultError::NotARoom);
    }
    let d = result.try_borrow_data()?;
    // room 32, week 4, winner 32, bump 1
    require!(d.len() >= 77 && d[..8] == RESULT_DISCRIMINATOR && d[8..40] == room.to_bytes(), VaultError::NotARoom);
    Ok((u32::from_le_bytes(d[40..44].try_into().unwrap()), Pubkey::new_from_array(d[44..76].try_into().unwrap())))
}

/// What the vault's lending shares are worth in dollars at Jupiter Lend's last recorded price. The
/// recorded price only rises, so this never overstates the interest.
pub fn shares_value(shares: &AccountInfo, lending: &AccountInfo) -> Result<u64> {
    let held = {
        let d = shares.try_borrow_data()?;
        anchor_spl::token::TokenAccount::try_deserialize(&mut &d[..])?.amount
    };
    let d = lending.try_borrow_data()?;
    // [8 tag][mint][f_token_mint][lending_id u16][decimals u8][rewards_rate_model][liquidity_exchange_price u64][token_exchange_price u64]
    require!(d.len() >= 123, VaultError::WrongVenue);
    let price = u64::from_le_bytes(d[115..123].try_into().unwrap()) as u128;
    let value = (held as u128).checked_mul(price).ok_or(VaultError::Math)? / EXCHANGE_PRECISION;
    u64::try_from(value).map_err(|_| error!(VaultError::Math))
}

/// sha256("account:PocketOf")[..8]
const POCKET_OF_DISCRIMINATOR: [u8; 8] = [63, 179, 36, 138, 35, 254, 179, 81];

/// The private pocket a wallet has named in the rooms program (["pocket", owner]): the key holding its private balance
/// on MagicBlock's private payments rollup.
pub fn read_pocket(pocket_of: &AccountInfo, owner: &Pubkey) -> Result<Pubkey> {
    let (expected, _) = Pubkey::find_program_address(&[b"pocket", owner.as_ref()], &ROOMS_PROGRAM);
    require_keys_eq!(*pocket_of.key, expected, VaultError::NotYourPocket);
    require_keys_eq!(*pocket_of.owner, ROOMS_PROGRAM, VaultError::NotYourPocket);
    let d = pocket_of.try_borrow_data()?;
    require!(d.len() >= 41 && d[..8] == POCKET_OF_DISCRIMINATOR, VaultError::NotYourPocket);
    Ok(Pubkey::new_from_array(d[8..40].try_into().unwrap()))
}
