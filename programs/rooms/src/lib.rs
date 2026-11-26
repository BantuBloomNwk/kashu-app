//! Kashu rooms. Friends save together in a room; the room keeps their streaks and draw tickets and
//! runs on a MagicBlock Ephemeral Rollup during the week (zero fees, instant taps), then settles on
//! Solana.
//!
//! Rules this program keeps on purpose:
//! - It never moves money. Savings live in each member's own vault (the `vault` program). A room only
//!   READS a member's vault to see that this week's save happened.
//! - A member's balance is never stored here. Friends see streaks and tickets, never amounts.
//! - Taps on the rollup may be signed by a session key the member named, so the wallet is not asked
//!   for every tap. A session can only check in and cheer; it can never touch money.
//!
//! Built for MagicBlock Solana Blitz v10 (started 20 Nov 2026).

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::{
    self as mbvrf,
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, EphemeralPermission, Member as PermMember, ACCOUNT_SIGNATURES_FLAG, TX_BALANCES_FLAG,
    TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::consts::{DELEGATION_PROGRAM_ID, EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use vault::state::UserVault;

declare_id!("8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q");

// The program's on-chain security.txt: who to tell about a vulnerability and where the code is. Values come from
// SECURITY_TXT.env at build time (scripts set them), so every build says the same, checked, thing.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Kashu rooms",
    project_url: env!("KASHU_SITE"),
    contacts: env!("KASHU_CONTACT"),
    policy: env!("KASHU_POLICY"),
    preferred_languages: "en",
    source_code: env!("KASHU_SOURCE"),
    auditors: env!("KASHU_AUDITORS")
}

pub const ROOM_SEED: &[u8] = b"room";
pub const MEMBER_SEED: &[u8] = b"member";
pub const RESULT_SEED: &[u8] = b"result";
pub const VIEWER_SEED: &[u8] = b"viewer";
/// A private room's readers: one key per member plus whoever they let count their saves (the permission
/// account is sized for 13).
pub const MAX_READERS: usize = 13;
pub const MAX_MEMBERS: u8 = 12;
#[cfg(not(feature = "devnet"))]
pub const WEEK_SECS: i64 = 7 * 24 * 3600;
#[cfg(feature = "devnet")]
pub const WEEK_SECS: i64 = 10 * 60;
/// How long a member's session (the key allowed to count their saves) may last. It can only check them in
/// for saves their vault really made, never move money, so a season-long session (Kashu's keeper, renewed
/// rarely) costs nothing in safety; on a private room it can't be renewed from a passkey wallet each week.
pub const MAX_SESSION_SECS: i64 = 120 * 24 * 3600;
/// A longer streak earns more chances in the draw, up to this many tickets in one week.
pub const MAX_TICKETS: u16 = 4;
pub const NAME_LEN: usize = 24;
pub const TAG_SEED: &[u8] = b"tag";
pub const TAG_OF_SEED: &[u8] = b"tag_of";
pub const POCKET_SEED: &[u8] = b"pocket";
pub const AVATAR_SEED: &[u8] = b"avatar";
/// A Kashutag: 3 to 15 of a-z, 0-9 and _, starting with a letter, stored zero-padded.
pub const TAG_LEN: usize = 15;
/// Names a saver could be fooled by, never handed out.
const RESERVED_TAGS: [&[u8]; 12] = [b"kashu", b"admin", b"support", b"help", b"official", b"team", b"keeper", b"sponsor", b"security", b"mod", b"staff", b"jupiter"];

/// Checks a Kashutag's bytes. Exactly one spelling of each name is accepted, so two people can never hold
/// names that look the same.
pub fn valid_tag(t: &[u8; TAG_LEN]) -> Result<()> {
    let len = t.iter().position(|&b| b == 0).unwrap_or(TAG_LEN);
    require!((3..=TAG_LEN).contains(&len), RoomError::BadTag);
    require!(t[len..].iter().all(|&b| b == 0), RoomError::BadTag);
    require!(t[0].is_ascii_lowercase(), RoomError::BadTag);
    require!(t[..len].iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'), RoomError::BadTag);
    require!(!RESERVED_TAGS.iter().any(|r| *r == &t[..len]), RoomError::ReservedTag);
    Ok(())
}
/// What a room member may see on the private rollup: the room's and each member's records, their
/// transactions' logs, balances, messages and signatures. Nobody outside the room sees any of it.
pub const VIEW_FLAGS: u8 = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG;

/// Lamports a room or member record carries so it can pay for its own permission on the private
/// rollup (ephemeral rent, about 16k lamports for a full room).
pub const fn permission_rent() -> u64 {
    ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(MAX_MEMBERS as usize) as u32)
}

pub const DRAW_NONE: u8 = 0;
pub const DRAW_ASKED: u8 = 1;
pub const DRAW_DRAWN: u8 = 2;
pub const DRAW_SETTLED: u8 = 3;

#[ephemeral]
#[program]
pub mod rooms {
    use super::*;

    /// Anyone opens a room for their friends. The first week starts now.
    pub fn create_room(ctx: Context<CreateRoom>, room_id: u64, name: [u8; NAME_LEN]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.room;
        r.creator = ctx.accounts.creator.key();
        r.room_id = room_id;
        r.name = name;
        r.week = 1;
        r.week_starts_at = now;
        r.members = 0;
        r.tickets = 0;
        r.savers = 0;
        r.bump = ctx.bumps.room;
        r.roster = [Pubkey::default(); MAX_MEMBERS as usize];
        emit!(RoomOpened { room: r.key(), creator: r.creator, room_id });
        fund(&ctx.accounts.creator, &ctx.accounts.room.to_account_info(), &ctx.accounts.system_program)?;
        Ok(())
    }

    /// A friend joins, naming a session key for quick taps. Joining happens on Solana, while the
    /// room is not on the rollup (before the week's first tap, or between weeks).
    pub fn join_room(ctx: Context<JoinRoom>, session: Pubkey, session_expires: i64, viewer: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(session_expires > now && session_expires - now <= MAX_SESSION_SECS, RoomError::BadSession);
        let r = &mut ctx.accounts.room;
        require!(r.members < MAX_MEMBERS, RoomError::RoomFull);
        let seat = r.members as usize;
        r.roster[seat] = ctx.accounts.owner.key();
        r.members += 1;
        let m = &mut ctx.accounts.member;
        m.room = r.key();
        m.owner = ctx.accounts.owner.key();
        m.vault = ctx.accounts.user_vault.key();
        m.session = session;
        m.session_expires = session_expires;
        m.streak = 0;
        m.last_saved_week = 0;
        m.ticket_week = 0;
        m.tickets = 0;
        m.last_buys_done = ctx.accounts.user_vault.buys_done;
        m.cheers = 0;
        m.bump = ctx.bumps.member;
        m.viewer = viewer;
        emit!(Joined { room: r.key(), owner: m.owner });
        fund(&ctx.accounts.owner, &ctx.accounts.member.to_account_info(), &ctx.accounts.system_program)?;
        Ok(())
    }

    /// Joining a room that is already on the private rollup: the member record is made here on Solana (the
    /// rollup can't create lasting accounts), without touching the room. Kashu's keeper then sends the
    /// record to the rollup and `admit` gives it a seat there.
    pub fn request_join(ctx: Context<RequestJoin>, session: Pubkey, session_expires: i64, viewer: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(session_expires > now && session_expires - now <= MAX_SESSION_SECS, RoomError::BadSession);
        delegated_room(&ctx.accounts.room, &ctx.accounts.delegation_record)?;
        let m = &mut ctx.accounts.member;
        m.room = ctx.accounts.room.key();
        m.owner = ctx.accounts.owner.key();
        m.vault = ctx.accounts.user_vault.key();
        m.session = session;
        m.session_expires = session_expires;
        m.last_buys_done = ctx.accounts.user_vault.buys_done;
        m.bump = ctx.bumps.member;
        m.viewer = viewer;
        emit!(JoinAsked { room: m.room, owner: m.owner });
        fund(&ctx.accounts.owner, &ctx.accounts.member.to_account_info(), &ctx.accounts.system_program)?;
        Ok(())
    }

    /// On the rollup, anyone seats a member whose record names this room and who isn't seated yet.
    pub fn admit(ctx: Context<Admit>) -> Result<()> {
        let r = &mut ctx.accounts.room;
        let owner = ctx.accounts.member.owner;
        require!(r.members < MAX_MEMBERS, RoomError::RoomFull);
        require!(!r.roster.iter().take(r.members as usize).any(|k| *k == owner), RoomError::AlreadySeated);
        let seat = r.members as usize;
        r.roster[seat] = owner;
        r.members += 1;
        emit!(Joined { room: r.key(), owner });
        Ok(())
    }

    /// Anyone opens a room's draw-result record: the only part of a private room that ever goes back to
    /// Solana, so the prize can be paid without making the room itself public.
    pub fn open_result(ctx: Context<OpenResult>) -> Result<()> {
        let d = &mut ctx.accounts.result;
        d.room = ctx.accounts.room.key();
        d.week = 0;
        d.winner = Pubkey::default();
        d.bump = ctx.bumps.result;
        Ok(())
    }

    /// Send a room's draw-result record to the rollup with the room.
    pub fn delegate_result(ctx: Context<DelegateResult>, room: Pubkey) -> Result<()> {
        ctx.accounts.delegate_result(
            &ctx.accounts.payer,
            &[RESULT_SEED, room.as_ref()],
            DelegateConfig { validator: ctx.accounts.validator.as_ref().map(|v| v.key()), ..Default::default() },
        )?;
        Ok(())
    }

    /// On the rollup: write this week's draw result back to Solana (the result only; the room stays private).
    /// It comes back undelegated: MagicBlock refuses a plain commit once an account has been committed 10 times, which
    /// a room reaches after 10 weeks. The keeper delegates it again before the next draw, so each week starts fresh.
    pub fn commit_result(ctx: Context<CommitResult>) -> Result<()> {
        ctx.accounts.result.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.result.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// "Add this phone": a member asks, on Solana, for a new viewer key (a new phone, or a browser that lost its
    /// key). Their record may be on the rollup, where a passkey wallet can't sign, so the request lives here and
    /// `apply_viewer` copies it across. Asking again replaces the earlier request.
    pub fn request_viewer(ctx: Context<RequestViewer>, room: Pubkey, viewer: Pubkey) -> Result<()> {
        require!(viewer != Pubkey::default(), RoomError::BadViewer);
        let q = &mut ctx.accounts.request;
        q.room = room;
        q.owner = ctx.accounts.owner.key();
        q.viewer = viewer;
        q.bump = ctx.bumps.request;
        emit!(ViewerAsked { room, owner: q.owner, viewer });
        Ok(())
    }

    /// Anyone (on the rollup, Kashu's keeper) gives a member the viewer key they asked for on Solana. Run
    /// `share_room` afterwards so the new key can read.
    pub fn apply_viewer(ctx: Context<ApplyViewer>) -> Result<()> {
        let q = &ctx.accounts.request;
        let m = &mut ctx.accounts.member;
        require_keys_eq!(q.owner, m.owner, RoomError::WrongRoom);
        require_keys_eq!(q.room, m.room, RoomError::WrongRoom);
        m.viewer = q.viewer;
        Ok(())
    }

    /// Brings a member record from before viewer keys up to date: it grows by one key (left empty, so the
    /// member's own key stands in until they add a phone). Anyone may run it and pays the extra rent; the record
    /// must be this program's, a member record, and the old size.
    pub fn upgrade_member(ctx: Context<UpgradeMember>) -> Result<()> {
        let m = &ctx.accounts.member;
        require_keys_eq!(*m.owner, crate::ID, RoomError::WrongRoom);
        let old = 8 + Member::INIT_SPACE - 32;
        {
            let d = m.try_borrow_data()?;
            require!(d.len() == old && d[..8] == *Member::DISCRIMINATOR, RoomError::NotAnOldRecord);
        }
        let new = 8 + Member::INIT_SPACE;
        let more = Rent::get()?.minimum_balance(new).saturating_sub(m.lamports());
        if more > 0 {
            anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.payer.to_account_info(), to: m.to_account_info() }), more)?;
        }
        m.resize(new)?;
        Ok(())
    }

    /// Send the room to the rollup for the week.
    /// A saver claims their Kashutag, the name friends send to. One per wallet; the name points at the wallet,
    /// and the wallet's own record names its tag, so either can be found from the other.
    pub fn claim_tag(ctx: Context<ClaimTag>, name: [u8; TAG_LEN]) -> Result<()> {
        valid_tag(&name)?;
        let t = &mut ctx.accounts.tag;
        t.owner = ctx.accounts.owner.key();
        t.name = name;
        t.bump = ctx.bumps.tag;
        let o = &mut ctx.accounts.tag_of;
        o.name = name;
        o.bump = ctx.bumps.tag_of;
        emit!(TagClaimed { owner: t.owner, name });
        Ok(())
    }

    /// A saver swaps their Kashutag for another free one. The old name is let go and its rent pays for the new
    /// one. There is no way to give a tag up for its rent, so nobody can farm the rent Kashu sponsors.
    pub fn change_tag(ctx: Context<ChangeTag>, name: [u8; TAG_LEN]) -> Result<()> {
        valid_tag(&name)?;
        let old = ctx.accounts.old_tag.to_account_info();
        let new = ctx.accounts.new_tag.to_account_info();
        // empty and the system program's (a few lamports sent to the address to block the name change nothing)
        require!(new.data_is_empty() && *new.owner == anchor_lang::solana_program::system_program::ID, RoomError::TagTaken);
        // the new record is made empty and ours first, then the old record's rent moves across (same size), so
        // nobody pays and nobody is refunded
        let seeds: &[&[u8]] = &[TAG_SEED, name.as_ref(), &[ctx.bumps.new_tag]];
        let space = (8 + Tag::INIT_SPACE) as u64;
        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::allocate(new.key, space), &[new.clone()], &[seeds])?;
        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::assign(new.key, &crate::ID), &[new.clone()], &[seeds])?;
        let lamports = old.lamports();
        **old.try_borrow_mut_lamports()? = 0;
        **new.try_borrow_mut_lamports()? = new.lamports().checked_add(lamports).ok_or(RoomError::Overflow)?;
        let tag = Tag { owner: ctx.accounts.owner.key(), name, bump: ctx.bumps.new_tag };
        {
            let mut d = new.try_borrow_mut_data()?;
            d[..8].copy_from_slice(Tag::DISCRIMINATOR);
            tag.serialize(&mut &mut d[8..])?;
        }
        // the old name is let go: its record is emptied and handed back to the system program
        old.assign(&anchor_lang::solana_program::system_program::ID);
        old.resize(0)?;
        ctx.accounts.tag_of.name = name;
        emit!(TagClaimed { owner: tag.owner, name });
        Ok(())
    }

    /// A saver names their private pocket: the key that holds their balance on MagicBlock's private payments rollup, so
    /// friends paying their Kashutag can pay it privately. Set again to change it (the record stays, so its rent can't be
    /// farmed).
    pub fn set_pocket(ctx: Context<SetPocket>, pocket: Pubkey) -> Result<()> {
        require!(pocket != Pubkey::default(), RoomError::BadPocket);
        let p = &mut ctx.accounts.pocket_of;
        p.pocket = pocket;
        p.bump = ctx.bumps.pocket_of;
        Ok(())
    }

    /// A saver's profile photo: the SHA-256 of the image Kashu's relay serves (all zeros clears it). Only the wallet can
    /// set it, so a photo follows the saver to every device and nobody else can change it.
    pub fn set_avatar(ctx: Context<SetAvatar>, hash: [u8; 32]) -> Result<()> {
        let a = &mut ctx.accounts.avatar_of;
        a.hash = hash;
        a.bump = ctx.bumps.avatar_of;
        Ok(())
    }

    pub fn delegate_room(ctx: Context<DelegateRoom>, creator: Pubkey, room_id: u64) -> Result<()> {
        ctx.accounts.delegate_room(
            &ctx.accounts.payer,
            &[ROOM_SEED, creator.as_ref(), &room_id.to_le_bytes()],
            DelegateConfig { validator: ctx.accounts.validator.as_ref().map(|v| v.key()), ..Default::default() },
        )?;
        Ok(())
    }

    /// Send a member's record to the rollup next to the room.
    pub fn delegate_member(ctx: Context<DelegateMember>, room: Pubkey, owner: Pubkey) -> Result<()> {
        ctx.accounts.delegate_member(
            &ctx.accounts.payer,
            &[MEMBER_SEED, room.as_ref(), owner.as_ref()],
            DelegateConfig { validator: ctx.accounts.validator.as_ref().map(|v| v.key()), ..Default::default() },
        )?;
        Ok(())
    }

    /// The member (or their session key) checks in after this week's save landed in their vault.
    /// The vault is read, never written: a check-in counts only if the vault made a new weekly save
    /// since the last one counted. A streak grows by one for each week in a row, and so do the
    /// member's chances in this week's draw, up to MAX_TICKETS.
    pub fn check_in(ctx: Context<CheckIn>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.member;
        let r = &mut ctx.accounts.room;
        authorised(m, ctx.accounts.signer.key(), now)?;
        require!(now < r.week_starts_at + WEEK_SECS, RoomError::WeekOver);
        require!(m.last_saved_week != r.week, RoomError::AlreadyCounted);
        let v = &ctx.accounts.user_vault;
        require!(v.buys_done > m.last_buys_done, RoomError::NoNewSave);
        m.last_buys_done = v.buys_done;
        m.streak = if m.last_saved_week + 1 == r.week { m.streak.saturating_add(1) } else { 1 };
        m.last_saved_week = r.week;
        m.ticket_week = r.week;
        m.tickets = m.streak.min(MAX_TICKETS);
        // this member's tickets are numbers [ticket_start, ticket_start + tickets) in this week's draw
        m.ticket_start = r.tickets;
        r.tickets = r.tickets.checked_add(m.tickets as u32).ok_or(RoomError::Overflow)?;
        r.savers = r.savers.saturating_add(1);
        emit!(CheckedIn { room: r.key(), owner: m.owner, week: r.week, streak: m.streak, tickets: m.tickets });
        Ok(())
    }

    /// A friendly tap for another member: a cheer. Free on the rollup, rate-limited to one per
    /// member per week per friend by the client; the program only counts them.
    pub fn cheer(ctx: Context<Cheer>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        authorised(&ctx.accounts.from, ctx.accounts.signer.key(), now)?;
        require!(ctx.accounts.from.key() != ctx.accounts.to.key(), RoomError::SelfCheer);
        let to = &mut ctx.accounts.to;
        to.cheers = to.cheers.saturating_add(1);
        Ok(())
    }

    /// The owner swaps or ends their session key (also works on the rollup while delegated).
    pub fn set_session(ctx: Context<SetSession>, session: Pubkey, session_expires: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(session_expires <= now || session_expires - now <= MAX_SESSION_SECS, RoomError::BadSession);
        let m = &mut ctx.accounts.member;
        m.session = session;
        m.session_expires = session_expires;
        Ok(())
    }

    /// After the week is over, anyone rolls the room to the next week (the draw for the finished
    /// week happens first, in the draw step). Streaks carry; tickets start again.
    pub fn next_week(ctx: Context<NextWeek>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.room;
        require!(now >= r.week_starts_at + WEEK_SECS, RoomError::WeekNotOver);
        // a week with tickets has its draw settled before the room moves on
        require!(r.tickets == 0 || (r.draw_week == r.week && r.draw_state == DRAW_SETTLED), RoomError::DrawNotSettled);
        // normally one week on; a room left behind (the keeper was down) jumps to the week running now, so saves
        // can be counted again straight away. Nobody saved in the weeks skipped, so streaks restart as they should.
        let behind = (now - r.week_starts_at) / WEEK_SECS;
        r.week = r.week.checked_add(u32::try_from(behind).map_err(|_| RoomError::Overflow)?).ok_or(RoomError::Overflow)?;
        r.week_starts_at = r.week_starts_at.checked_add(behind.checked_mul(WEEK_SECS).ok_or(RoomError::Overflow)?).ok_or(RoomError::Overflow)?;
        r.tickets = 0;
        r.savers = 0;
        r.draw_state = DRAW_NONE;
        emit!(WeekStarted { room: r.key(), week: r.week });
        Ok(())
    }


    /// After the week is over, anyone asks MagicBlock's VRF for this week's draw. The oracle answers
    /// with `callback_draw`; nobody, including us, can pick or predict the number.
    pub fn request_draw(ctx: Context<RequestDraw>, client_seed: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (room_key, week, tickets) = {
            let r = &mut ctx.accounts.room;
            require!(now >= r.week_starts_at + WEEK_SECS, RoomError::WeekNotOver);
            require!(r.tickets > 0, RoomError::NoTickets);
            require!(!(r.draw_week == r.week && r.draw_state != DRAW_NONE), RoomError::DrawAlreadyAsked);
            r.draw_week = r.week;
            r.draw_state = DRAW_ASKED;
            (r.key(), r.week, r.tickets)
        };
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: crate::ID,
            callback_discriminator: instruction::CallbackDraw::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![SerializableAccountMeta { pubkey: room_key, is_signer: false, is_writable: true }]),
            callback_args: None,
        });
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        emit!(DrawAsked { room: room_key, week, tickets });
        Ok(())
    }

    /// The VRF oracle's answer (identity checked by #[vrf_callback]): the winning ticket number.
    pub fn callback_draw(ctx: Context<CallbackDraw>, randomness: [u8; 32]) -> Result<()> {
        let r = &mut ctx.accounts.room;
        require!(r.draw_state == DRAW_ASKED && r.tickets > 0, RoomError::NoDrawAsked);
        r.winning_ticket = (mbvrf::rnd::random_u64(&randomness) % r.tickets as u64) as u32;
        r.draw_state = DRAW_DRAWN;
        emit!(Drawn { room: r.key(), week: r.draw_week, ticket: r.winning_ticket, tickets: r.tickets });
        Ok(())
    }

    /// Anyone settles the draw by passing the member whose tickets hold the winning number. No
    /// signature is needed: the member's own ticket range is the proof, so a winner who is away
    /// cannot hold up the room.
    pub fn settle_draw(ctx: Context<SettleDraw>) -> Result<()> {
        let r = &mut ctx.accounts.room;
        let m = &ctx.accounts.member;
        require!(r.draw_state == DRAW_DRAWN, RoomError::NotDrawn);
        require!(m.ticket_week == r.draw_week, RoomError::NotThisWeek);
        let end = m.ticket_start.checked_add(m.tickets as u32).ok_or(RoomError::Overflow)?;
        require!(m.ticket_start <= r.winning_ticket && r.winning_ticket < end, RoomError::NotTheWinner);
        r.winner = m.owner;
        r.draw_state = DRAW_SETTLED;
        let d = &mut ctx.accounts.result;
        d.week = r.draw_week;
        d.winner = m.owner;
        emit!(WinnerDrawn { room: r.key(), week: r.draw_week, winner: m.owner });
        Ok(())
    }

    /// On the private rollup: make the room's record, and each member record passed in pairs
    /// (member, its permission) as remaining accounts, readable by the room's members only. Anyone
    /// may run it; the member list comes from the room's own roster, so the caller chooses nothing.
    /// Run again after someone joins to let them in.
    pub fn share_room<'info>(ctx: Context<'info, ShareRoom<'info>>) -> Result<()> {
        let room = &ctx.accounts.room;
        let now = Clock::get()?.unix_timestamp;
        // every seated member's record comes in, so the readers are exactly this room's: each member's viewer
        // key (or their own key when they have none), and whoever they let count their saves while that lasts
        require!(ctx.remaining_accounts.len() % 2 == 0, RoomError::PairsExpected);
        require!(ctx.remaining_accounts.len() / 2 == room.members as usize, RoomError::PairsExpected);
        let mut readers: Vec<Pubkey> = Vec::with_capacity(MAX_READERS);
        let add = |k: Pubkey, list: &mut Vec<Pubkey>| -> Result<()> {
            if k != Pubkey::default() && !list.contains(&k) { require!(list.len() < MAX_READERS, RoomError::TooManyReaders); list.push(k); }
            Ok(())
        };
        for pair in ctx.remaining_accounts.chunks(2) {
            let m = checked_member_record(&pair[0], &room.key())?;
            require!(room.roster.iter().take(room.members as usize).any(|k| *k == m.owner), RoomError::WrongRoom);
            add(if m.viewer != Pubkey::default() { m.viewer } else { m.owner }, &mut readers)?;
            if m.session_expires > now { add(m.session, &mut readers)?; }
        }
        let members: Vec<PermMember> = readers.iter().map(|k| PermMember { flags: VIEW_FLAGS, pubkey: *k }).collect();
        let (id_bytes, room_bump) = (room.room_id.to_le_bytes(), [room.bump]);
        let room_seeds: &[&[u8]] = &[ROOM_SEED, room.creator.as_ref(), &id_bytes, &room_bump];
        let p = Perm {
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic: ctx.accounts.magic_program.to_account_info(),
            program: ctx.accounts.permission_program.to_account_info(),
        };
        p.set(&room.to_account_info(), &ctx.accounts.room_permission.to_account_info(), room_seeds, &members)?;
        let room_key = room.key();
        for pair in ctx.remaining_accounts.chunks(2) {
            let (member_ai, perm_ai) = (&pair[0], &pair[1]);
            let owner = checked_member(member_ai, &room.key())?;
            require_keys_eq!(*perm_ai.key, EphemeralPermission::find_pda(member_ai.key).0, RoomError::BadPermission);
            let (_, bump) = Pubkey::find_program_address(&[MEMBER_SEED, room_key.as_ref(), owner.as_ref()], &crate::ID);
            let bump_bytes = [bump];
            let seeds: &[&[u8]] = &[MEMBER_SEED, room_key.as_ref(), owner.as_ref(), &bump_bytes];
            p.set(member_ai, perm_ai, seeds, &members)?;
        }
        emit!(RoomShared { room: room.key(), members: room.members });
        Ok(())
    }

    /// Commit the room's week back to Solana and take it off the rollup.
    pub fn settle_room(ctx: Context<SettleRoom>) -> Result<()> {
        // its private-rollup permission is closed first (only if it has one)
        if ctx.accounts.room_permission.owner == &PERMISSION_PROGRAM_ID && !ctx.accounts.room_permission.data_is_empty() {
            let r = &ctx.accounts.room;
            let seeds: &[&[u8]] = &[ROOM_SEED, r.creator.as_ref(), &r.room_id.to_le_bytes(), &[r.bump]];
            Perm { vault: ctx.accounts.ephemeral_vault.to_account_info(), magic: ctx.accounts.magic_program.to_account_info(), program: ctx.accounts.permission_program.to_account_info() }
                .close(&r.to_account_info(), &ctx.accounts.room_permission.to_account_info(), seeds)?;
        }
        let r = &ctx.accounts.room;
        emit!(RoomSettled { room: r.key(), week: r.week, tickets: r.tickets, savers: r.savers });
        ctx.accounts.room.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.room.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// The member takes their record back to Solana.
    pub fn settle_member(ctx: Context<SettleMember>) -> Result<()> {
        if ctx.accounts.member_permission.owner == &PERMISSION_PROGRAM_ID && !ctx.accounts.member_permission.data_is_empty() {
            let m = &ctx.accounts.member;
            let seeds: &[&[u8]] = &[MEMBER_SEED, m.room.as_ref(), m.owner.as_ref(), &[m.bump]];
            Perm { vault: ctx.accounts.ephemeral_vault.to_account_info(), magic: ctx.accounts.magic_program.to_account_info(), program: ctx.accounts.permission_program.to_account_info() }
                .close(&m.to_account_info(), &ctx.accounts.member_permission.to_account_info(), seeds)?;
        }
        MagicIntentBundleBuilder::new(
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.member.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

/// Move a record's permission rent into it from the payer (enough for a full room).
fn fund<'info>(from: &Signer<'info>, to: &AccountInfo<'info>, system_program: &Program<'info, System>) -> Result<()> {
    anchor_lang::system_program::transfer(
        CpiContext::new(system_program.key(), anchor_lang::system_program::Transfer { from: from.to_account_info(), to: to.clone() }),
        permission_rent(),
    )
}

/// The whole member record, checked the same way as `checked_member`.
fn checked_member_record(ai: &AccountInfo, room: &Pubkey) -> Result<Member> {
    checked_member(ai, room)?;
    let data = ai.try_borrow_data()?;
    Ok(Member::try_deserialize(&mut &data[..])?)
}

/// A room of this program that is on the rollup: on Solana it is held by MagicBlock's delegation program,
/// and its delegation record names this program as the real owner.
fn delegated_room(room: &AccountInfo, record: &AccountInfo) -> Result<()> {
    require_keys_eq!(*room.owner, DELEGATION_PROGRAM_ID, RoomError::WrongRoom);
    let (expected, _) = Pubkey::find_program_address(&[b"delegation", room.key.as_ref()], &DELEGATION_PROGRAM_ID);
    require_keys_eq!(*record.key, expected, RoomError::WrongRoom);
    require_keys_eq!(*record.owner, DELEGATION_PROGRAM_ID, RoomError::WrongRoom);
    let d = record.try_borrow_data()?;
    require!(d.len() >= 72 && d[40..72] == crate::ID.to_bytes(), RoomError::WrongRoom);
    let r = room.try_borrow_data()?;
    require!(r.len() >= 8 && r[..8] == *Room::DISCRIMINATOR, RoomError::WrongRoom);
    Ok(())
}

/// A member record of this room: owned by this program, the right kind, in this room.
fn checked_member(ai: &AccountInfo, room: &Pubkey) -> Result<Pubkey> {
    require_keys_eq!(*ai.owner, crate::ID, RoomError::WrongRoom);
    let data = ai.try_borrow_data()?;
    let m = Member::try_deserialize(&mut &data[..])?;
    require_keys_eq!(m.room, *room, RoomError::WrongRoom);
    require_keys_eq!(*ai.key, Pubkey::find_program_address(&[MEMBER_SEED, room.as_ref(), m.owner.as_ref()], &crate::ID).0, RoomError::WrongRoom);
    Ok(m.owner)
}

/// The permission program's accounts, and create-or-update / close for one record. The record (a
/// program PDA) signs for itself and pays its own ephemeral rent.
struct Perm<'info> { vault: AccountInfo<'info>, magic: AccountInfo<'info>, program: AccountInfo<'info> }
impl<'info> Perm<'info> {
    fn set(&self, record: &AccountInfo<'info>, perm: &AccountInfo<'info>, seeds: &[&[u8]], members: &[PermMember]) -> Result<()> {
        let args = EphemeralMembersArgs { is_private: true, members: members.to_vec() };
        if perm.owner == &PERMISSION_PROGRAM_ID && !perm.data_is_empty() {
            UpdateEphemeralPermissionCpi {
                permissioned_account: record.clone(), permission: perm.clone(), payer: record.clone(), authority: record.clone(),
                vault: self.vault.clone(), magic_program: self.magic.clone(), permission_program: self.program.clone(),
                authority_is_signer: false, args,
            }.invoke_signed(&[seeds])?;
        } else {
            CreateEphemeralPermissionCpi {
                permissioned_account: record.clone(), permission: perm.clone(), payer: record.clone(),
                vault: self.vault.clone(), magic_program: self.magic.clone(), permission_program: self.program.clone(), args,
            }.invoke_signed(&[seeds])?;
        }
        Ok(())
    }
    fn close(&self, record: &AccountInfo<'info>, perm: &AccountInfo<'info>, seeds: &[&[u8]]) -> Result<()> {
        CloseEphemeralPermissionCpi {
            permissioned_account: record.clone(), permission: perm.clone(), payer: record.clone(), authority: record.clone(),
            vault: self.vault.clone(), magic_program: self.magic.clone(), permission_program: self.program.clone(),
            authority_is_signer: false,
        }.invoke_signed(&[seeds])?;
        Ok(())
    }
}

fn authorised(m: &Member, signer: Pubkey, now: i64) -> Result<()> {
    require!(signer == m.owner || (signer == m.session && now < m.session_expires), RoomError::NotYourSeat);
    Ok(())
}

#[derive(Accounts)]
#[instruction(name: [u8; TAG_LEN])]
pub struct ClaimTag<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Tag::INIT_SPACE, seeds = [TAG_SEED, name.as_ref()], bump)]
    pub tag: Account<'info, Tag>,
    #[account(init, payer = owner, space = 8 + TagOf::INIT_SPACE, seeds = [TAG_OF_SEED, owner.key().as_ref()], bump)]
    pub tag_of: Account<'info, TagOf>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(name: [u8; TAG_LEN])]
pub struct ChangeTag<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [TAG_OF_SEED, owner.key().as_ref()], bump = tag_of.bump)]
    pub tag_of: Account<'info, TagOf>,
    #[account(mut, seeds = [TAG_SEED, tag_of.name.as_ref()], bump = old_tag.bump,
        constraint = old_tag.owner == owner.key() @ RoomError::NotYourTag)]
    pub old_tag: Account<'info, Tag>,
    /// CHECK: the empty address of the new name (seeds checked here, emptiness in the handler); made into a Tag there
    #[account(mut, seeds = [TAG_SEED, name.as_ref()], bump)]
    pub new_tag: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAvatar<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init_if_needed, payer = owner, space = 8 + AvatarOf::INIT_SPACE, seeds = [AVATAR_SEED, owner.key().as_ref()], bump)]
    pub avatar_of: Account<'info, AvatarOf>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPocket<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init_if_needed, payer = owner, space = 8 + PocketOf::INIT_SPACE, seeds = [POCKET_SEED, owner.key().as_ref()], bump)]
    pub pocket_of: Account<'info, PocketOf>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct CreateRoom<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(init, payer = creator, space = 8 + Room::INIT_SPACE,
        seeds = [ROOM_SEED, creator.key().as_ref(), &room_id.to_le_bytes()], bump)]
    pub room: Account<'info, Room>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinRoom<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room.creator.as_ref(), &room.room_id.to_le_bytes()], bump = room.bump)]
    pub room: Account<'info, Room>,
    /// The member's own savings vault; only read. Anchor checks it belongs to the vault program.
    #[account(constraint = user_vault.owner == owner.key() @ RoomError::NotYourVault)]
    pub user_vault: Account<'info, UserVault>,
    #[account(init, payer = owner, space = 8 + Member::INIT_SPACE,
        seeds = [MEMBER_SEED, room.key().as_ref(), owner.key().as_ref()], bump)]
    pub member: Account<'info, Member>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(creator: Pubkey, room_id: u64)]
pub struct DelegateRoom<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the room PDA, checked by its seeds.
    #[account(mut, del, seeds = [ROOM_SEED, creator.as_ref(), &room_id.to_le_bytes()], bump)]
    pub room: UncheckedAccount<'info>,
    /// CHECK: optional validator to delegate to; MagicBlock's TEE validator makes the room private.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(room: Pubkey, owner: Pubkey)]
pub struct DelegateMember<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the member PDA, checked by its seeds.
    #[account(mut, del, seeds = [MEMBER_SEED, room.as_ref(), owner.as_ref()], bump)]
    pub member: UncheckedAccount<'info>,
    /// CHECK: optional validator to delegate to; MagicBlock's TEE validator makes the record private.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct CheckIn<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room.creator.as_ref(), &room.room_id.to_le_bytes()], bump = room.bump)]
    pub room: Account<'info, Room>,
    #[account(mut, seeds = [MEMBER_SEED, room.key().as_ref(), member.owner.as_ref()], bump = member.bump,
        constraint = member.room == room.key() @ RoomError::WrongRoom)]
    pub member: Account<'info, Member>,
    #[account(address = member.vault @ RoomError::NotYourVault)]
    pub user_vault: Account<'info, UserVault>,
}

#[derive(Accounts)]
pub struct Cheer<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [MEMBER_SEED, from.room.as_ref(), from.owner.as_ref()], bump = from.bump)]
    pub from: Account<'info, Member>,
    #[account(mut, seeds = [MEMBER_SEED, to.room.as_ref(), to.owner.as_ref()], bump = to.bump,
        constraint = to.room == from.room @ RoomError::WrongRoom)]
    pub to: Account<'info, Member>,
}

#[derive(Accounts)]
pub struct SetSession<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [MEMBER_SEED, member.room.as_ref(), owner.key().as_ref()], bump = member.bump)]
    pub member: Account<'info, Member>,
}

#[derive(Accounts)]
pub struct NextWeek<'info> {
    pub anyone: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room.creator.as_ref(), &room.room_id.to_le_bytes()], bump = room.bump)]
    pub room: Account<'info, Room>,
}


#[vrf]
#[derive(Accounts)]
pub struct RequestDraw<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room.creator.as_ref(), &room.room_id.to_le_bytes()], bump = room.bump)]
    pub room: Account<'info, Room>,
    /// CHECK: MagicBlock's production VRF oracle queue, on Solana or on the rollup. The SDK's test queues
    /// are for local development only and are refused: the draw pays out real money.
    #[account(mut, constraint =
        oracle_queue.key() == mbvrf::consts::DEFAULT_QUEUE ||
        oracle_queue.key() == mbvrf::consts::DEFAULT_EPHEMERAL_QUEUE @ RoomError::BadQueue)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackDraw<'info> {
    #[account(mut)]
    pub room: Account<'info, Room>,
}

#[derive(Accounts)]
#[instruction(room: Pubkey)]
pub struct RequestViewer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init_if_needed, payer = owner, space = 8 + ViewerRequest::INIT_SPACE, seeds = [VIEWER_SEED, room.as_ref(), owner.key().as_ref()], bump)]
    pub request: Account<'info, ViewerRequest>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyViewer<'info> {
    #[account(seeds = [VIEWER_SEED, request.room.as_ref(), request.owner.as_ref()], bump = request.bump)]
    pub request: Account<'info, ViewerRequest>,
    #[account(mut, seeds = [MEMBER_SEED, member.room.as_ref(), member.owner.as_ref()], bump = member.bump)]
    pub member: Account<'info, Member>,
}

/// A member's request, made on Solana, for a new viewer key on their private room's record.
#[account]
#[derive(InitSpace)]
pub struct ViewerRequest {
    pub room: Pubkey,
    pub owner: Pubkey,
    pub viewer: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct UpgradeMember<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: an old member record of this program, checked in the handler (owner, kind, size).
    #[account(mut)]
    pub member: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestJoin<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: a room of this program held on the rollup, checked by `delegated_room`.
    pub room: UncheckedAccount<'info>,
    /// CHECK: the room's delegation record, checked by `delegated_room`.
    pub delegation_record: UncheckedAccount<'info>,
    #[account(constraint = user_vault.owner == owner.key() @ RoomError::NotYourVault)]
    pub user_vault: Account<'info, UserVault>,
    #[account(init, payer = owner, space = 8 + Member::INIT_SPACE,
        seeds = [MEMBER_SEED, room.key().as_ref(), owner.key().as_ref()], bump)]
    pub member: Account<'info, Member>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Admit<'info> {
    #[account(mut, seeds = [ROOM_SEED, room.creator.as_ref(), &room.room_id.to_le_bytes()], bump = room.bump)]
    pub room: Account<'info, Room>,
    #[account(seeds = [MEMBER_SEED, room.key().as_ref(), member.owner.as_ref()], bump = member.bump,
        constraint = member.room == room.key() @ RoomError::WrongRoom)]
    pub member: Account<'info, Member>,
}

#[derive(Accounts)]
pub struct OpenResult<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: any room of this program, on Solana or on the rollup; the result's seeds tie it to that address.
    pub room: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + DrawResult::INIT_SPACE, seeds = [RESULT_SEED, room.key().as_ref()], bump)]
    pub result: Account<'info, DrawResult>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(room: Pubkey)]
pub struct DelegateResult<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the result PDA, checked by its seeds.
    #[account(mut, del, seeds = [RESULT_SEED, room.as_ref()], bump)]
    pub result: UncheckedAccount<'info>,
    /// CHECK: optional validator to delegate to; MagicBlock's TEE validator keeps it beside the private room.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitResult<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RESULT_SEED, result.room.as_ref()], bump = result.bump)]
    pub result: Account<'info, DrawResult>,
}

/// A room's latest settled draw, the only part of a private room written back to Solana.
#[account]
#[derive(InitSpace)]
pub struct DrawResult {
    pub room: Pubkey,
    pub week: u32,
    pub winner: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct SettleDraw<'info> {
    #[account(mut, seeds = [ROOM_SEED, room.creator.as_ref(), &room.room_id.to_le_bytes()], bump = room.bump)]
    pub room: Account<'info, Room>,
    #[account(seeds = [MEMBER_SEED, room.key().as_ref(), member.owner.as_ref()], bump = member.bump,
        constraint = member.room == room.key() @ RoomError::WrongRoom)]
    pub member: Account<'info, Member>,
    #[account(mut, seeds = [RESULT_SEED, room.key().as_ref()], bump = result.bump)]
    pub result: Account<'info, DrawResult>,
}

#[derive(Accounts)]
pub struct ShareRoom<'info> {
    pub anyone: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room.creator.as_ref(), &room.room_id.to_le_bytes()], bump = room.bump)]
    pub room: Account<'info, Room>,
    /// CHECK: the room's permission PDA under the permission program.
    #[account(mut, address = EphemeralPermission::find_pda(&room.key()).0 @ RoomError::BadPermission)]
    pub room_permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's magic program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct SettleRoom<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ROOM_SEED, room.creator.as_ref(), &room.room_id.to_le_bytes()], bump = room.bump)]
    pub room: Account<'info, Room>,
    /// CHECK: the room's permission PDA (closed first if it exists).
    #[account(mut, address = EphemeralPermission::find_pda(&room.key()).0 @ RoomError::BadPermission)]
    pub room_permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct SettleMember<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [MEMBER_SEED, member.room.as_ref(), owner.key().as_ref()], bump = member.bump)]
    pub member: Account<'info, Member>,
    /// CHECK: the member's permission PDA (closed first if it exists).
    #[account(mut, address = EphemeralPermission::find_pda(&member.key()).0 @ RoomError::BadPermission)]
    pub member_permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

/// A Kashutag: the name, and the wallet it points at.
#[account]
#[derive(InitSpace)]
pub struct Tag {
    pub owner: Pubkey,
    pub name: [u8; TAG_LEN],
    pub bump: u8,
}

/// A wallet's profile photo, by the SHA-256 of the image.
#[account]
#[derive(InitSpace)]
pub struct AvatarOf {
    pub hash: [u8; 32],
    pub bump: u8,
}

/// A wallet's private pocket key.
#[account]
#[derive(InitSpace)]
pub struct PocketOf {
    pub pocket: Pubkey,
    pub bump: u8,
}

/// The tag a wallet holds (one per wallet).
#[account]
#[derive(InitSpace)]
pub struct TagOf {
    pub name: [u8; TAG_LEN],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Room {
    pub creator: Pubkey,
    pub room_id: u64,
    pub name: [u8; NAME_LEN],
    pub week: u32,
    pub week_starts_at: i64,
    pub members: u8,
    /// Draw tickets earned this week, across all members.
    pub tickets: u32,
    /// Members who saved this week.
    pub savers: u16,
    pub bump: u8,
    /// The week whose draw is in progress or done, its state (DRAW_*), the winning ticket number and
    /// the winner once settled.
    pub draw_week: u32,
    pub draw_state: u8,
    pub winning_ticket: u32,
    pub winner: Pubkey,
    /// Who is in the room, in joining order; the private rollup lets exactly these keys read it.
    pub roster: [Pubkey; MAX_MEMBERS as usize],
}

#[account]
#[derive(InitSpace)]
pub struct Member {
    pub room: Pubkey,
    pub owner: Pubkey,
    /// The member's savings vault (vault program), read to confirm each week's save.
    pub vault: Pubkey,
    pub session: Pubkey,
    pub session_expires: i64,
    pub streak: u16,
    pub last_saved_week: u32,
    pub ticket_week: u32,
    pub tickets: u16,
    /// This member's first ticket number in this week's draw.
    pub ticket_start: u32,
    /// The vault's save counter at the last counted check-in.
    pub last_buys_done: u32,
    pub cheers: u32,
    pub bump: u8,
    /// A key on the member's own phone that may read the room on the private rollup. A passkey smart wallet
    /// can't sign the rollup's sign-in message, so this key does; it can read, never move money or act.
    pub viewer: Pubkey,
}

#[event]
pub struct ViewerAsked {
    pub room: Pubkey,
    pub owner: Pubkey,
    pub viewer: Pubkey,
}

#[event]
pub struct JoinAsked {
    pub room: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct TagClaimed { pub owner: Pubkey, pub name: [u8; TAG_LEN] }
#[event]
pub struct RoomOpened { pub room: Pubkey, pub creator: Pubkey, pub room_id: u64 }
#[event]
pub struct Joined { pub room: Pubkey, pub owner: Pubkey }
#[event]
pub struct CheckedIn { pub room: Pubkey, pub owner: Pubkey, pub week: u32, pub streak: u16, pub tickets: u16 }
#[event]
pub struct WeekStarted { pub room: Pubkey, pub week: u32 }
#[event]
pub struct DrawAsked { pub room: Pubkey, pub week: u32, pub tickets: u32 }
#[event]
pub struct Drawn { pub room: Pubkey, pub week: u32, pub ticket: u32, pub tickets: u32 }
#[event]
pub struct WinnerDrawn { pub room: Pubkey, pub week: u32, pub winner: Pubkey }
#[event]
pub struct RoomShared { pub room: Pubkey, pub members: u8 }
#[event]
pub struct RoomSettled { pub room: Pubkey, pub week: u32, pub tickets: u32, pub savers: u16 }

#[error_code]
pub enum RoomError {
    #[msg("Member records come in pairs: the record, then its permission")]
    PairsExpected,
    #[msg("That is not this record's permission account")]
    BadPermission,
    #[msg("A session lasts at most 120 days")]
    BadSession,
    #[msg("This room has 12 members already")]
    RoomFull,
    #[msg("This is not your vault")]
    NotYourVault,
    #[msg("This key is not the member or their live session")]
    NotYourSeat,
    #[msg("This week is over; roll to the next week")]
    WeekOver,
    #[msg("The week is not over yet")]
    WeekNotOver,
    #[msg("This week's save is already counted")]
    AlreadyCounted,
    #[msg("No new save in the vault since the last check-in")]
    NoNewSave,
    #[msg("That member is in a different room")]
    WrongRoom,
    #[msg("You can't cheer yourself")]
    SelfCheer,
    #[msg("Number too large")]
    Overflow,
    #[msg("Nobody saved this week, so there is no draw")]
    NoTickets,
    #[msg("This week's draw was already asked for")]
    DrawAlreadyAsked,
    #[msg("No draw is waiting for randomness")]
    NoDrawAsked,
    #[msg("The draw has not been made yet")]
    NotDrawn,
    #[msg("This member has no tickets in that week's draw")]
    NotThisWeek,
    #[msg("This member's tickets do not hold the winning number")]
    NotTheWinner,
    #[msg("Settle this week's draw before moving on")]
    DrawNotSettled,
    #[msg("Not a MagicBlock VRF queue")]
    BadQueue,
    #[msg("That isn't a member record from before viewer keys")]
    NotAnOldRecord,
    #[msg("A viewer key can't be empty")]
    BadViewer,
    #[msg("This member already has a seat")]
    AlreadySeated,
    #[msg("A private room can have at most 13 readers")]
    TooManyReaders,
    #[msg("A Kashutag is 3 to 15 letters, numbers or _, starting with a letter")]
    BadTag,
    #[msg("That Kashutag is kept for Kashu")]
    ReservedTag,
    #[msg("That isn't your Kashutag")]
    NotYourTag,
    #[msg("That Kashutag is taken")]
    TagTaken,
    #[msg("Not a pocket key")]
    BadPocket,
}
