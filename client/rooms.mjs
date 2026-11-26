// Instruction builders and account readers for the rooms program, written by hand against
// programs/rooms/src/lib.rs (same style as client/vault.mjs).

import { AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { B, sha256, disc as tag } from './bytes.mjs';

export const ROOMS_PROGRAM = address('8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

const enc = getAddressEncoder();
const dec = getAddressDecoder();
const text = (s) => new TextEncoder().encode(s);
const disc = tag;
const u64 = (n) => { const b = B.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = B.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const data = (name, ...parts) => new Uint8Array(B.concat([disc(name), ...parts]));
const pda = async (programAddress, seeds) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];
const addrOf = (s) => (typeof s === 'string' ? s : s.address);
const ro = (a) => ({ address: addrOf(a), role: AccountRole.READONLY });
const rw = (a) => ({ address: addrOf(a), role: AccountRole.WRITABLE });
const roSigner = (s) => ({ address: s.address, role: AccountRole.READONLY_SIGNER, signer: s });
const rwSigner = (s) => ({ address: s.address, role: AccountRole.WRITABLE_SIGNER, signer: s });
const ix = (accounts, d) => ({ programAddress: ROOMS_PROGRAM, accounts, data: d });

export const roomPda = (creator, roomId) => pda(ROOMS_PROGRAM, [text('room'), enc.encode(creator), u64(roomId)]);
export const memberPda = (room, owner) => pda(ROOMS_PROGRAM, [text('member'), enc.encode(room), enc.encode(owner)]);
/** Lamports each room and member record carries for its private-rollup permission (a full room of 12). */
export const PERMISSION_RENT = BigInt((35 + 13 * 33 + 60) * 32);
export const nameBytes = (s) => { const b = B.alloc(24); B.from(s, 'utf8').copy(b, 0, 0, 24); return b; };

export async function createRoomIx({ creator, roomId, name }) {
  return ix([rwSigner(creator), rw(await roomPda(creator.address, roomId)), ro(SYSTEM_PROGRAM)], data('create_room', u64(roomId), nameBytes(name)));
}
const ZERO = '11111111111111111111111111111111';
/** `viewer`: a key on the member's phone that may read the room on the private rollup (optional). */
export async function joinRoomIx({ owner, room, userVault, session, sessionExpires, viewer = ZERO }) {
  return ix([rwSigner(owner), rw(room), ro(userVault), rw(await memberPda(room, owner.address)), ro(SYSTEM_PROGRAM)],
    data('join_room', B.from(enc.encode(session)), i64(sessionExpires), B.from(enc.encode(viewer))));
}
export const resultPda = (room) => pda(ROOMS_PROGRAM, [text('result'), enc.encode(room)]);
const DELEGATION = address('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
export const delegationRecordOf = (account) => pda(DELEGATION, [text('delegation'), enc.encode(account)]);
/** Joining a room that is on the private rollup: the member record is made on Solana, the seat comes later (admit). */
export async function requestJoinIx({ owner, room, userVault, session, sessionExpires, viewer = ZERO }) {
  return ix([rwSigner(owner), ro(room), ro(await delegationRecordOf(room)), ro(userVault), rw(await memberPda(room, owner.address)), ro(SYSTEM_PROGRAM)],
    data('request_join', B.from(enc.encode(session)), i64(sessionExpires), B.from(enc.encode(viewer))));
}
export async function admitIx({ room, owner }) {
  return ix([rw(room), ro(await memberPda(room, owner))], data('admit'));
}
export async function openResultIx({ payer, room }) {
  return ix([rwSigner(payer), ro(room), rw(await resultPda(room)), ro(SYSTEM_PROGRAM)], data('open_result'));
}
export function readResult(bytes) {
  const b = B.from(bytes);
  return { room: dec.decode(b.subarray(8, 40)), week: b.readUInt32LE(40), winner: dec.decode(b.subarray(44, 76)) };
}
export async function checkInIx({ signer, room, owner, userVault }) {
  return ix([roSigner(signer), rw(room), rw(await memberPda(room, owner)), ro(userVault)], data('check_in'));
}
export async function cheerIx({ signer, room, from, to }) {
  return ix([roSigner(signer), ro(await memberPda(room, from)), rw(await memberPda(room, to))], data('cheer'));
}
export async function setSessionIx({ owner, room, session, sessionExpires }) {
  return ix([roSigner(owner), rw(await memberPda(room, owner.address))], data('set_session', B.from(enc.encode(session)), i64(sessionExpires)));
}
export const nextWeekIx = ({ anyone, room }) => ix([roSigner(anyone), rw(room)], data('next_week'));

export function readRoom(bytes) {
  const b = B.from(bytes); let o = 8;
  const creator = dec.decode(b.subarray(o, o + 32)); o += 32;
  const roomId = b.readBigUInt64LE(o); o += 8;
  const name = b.subarray(o, o + 24).toString('utf8').replace(/\0+$/, ''); o += 24;
  const week = b.readUInt32LE(o); o += 4;
  const weekStartsAt = b.readBigInt64LE(o); o += 8;
  const members = b[o]; o += 1;
  const tickets = b.readUInt32LE(o); o += 4;
  const savers = b.readUInt16LE(o); o += 2;
  o += 1; // bump
  const drawWeek = b.readUInt32LE(o); o += 4;
  const drawState = b[o]; o += 1;
  const winningTicket = b.readUInt32LE(o); o += 4;
  const winner = dec.decode(b.subarray(o, o + 32)); o += 32;
  const roster = []; for (let i = 0; i < 12; i++, o += 32) roster.push(dec.decode(b.subarray(o, o + 32)));
  return { creator, roomId, name, week, weekStartsAt, members, tickets, savers, drawWeek, drawState, winningTicket, winner, roster: roster.slice(0, members) };
}
export function readMember(bytes) {
  const b = B.from(bytes); let o = 8 + 32 * 4;
  const sessionExpires = b.readBigInt64LE(o); o += 8;
  const streak = b.readUInt16LE(o); o += 2;
  const lastSavedWeek = b.readUInt32LE(o); o += 4;
  const ticketWeek = b.readUInt32LE(o); o += 4;
  const tickets = b.readUInt16LE(o); o += 2;
  const ticketStart = b.readUInt32LE(o); o += 4;
  const lastBuysDone = b.readUInt32LE(o); o += 4;
  const cheers = b.readUInt32LE(o); o += 4;
  o += 1; // bump
  const viewer = b.length >= o + 32 ? dec.decode(b.subarray(o, o + 32)) : null;
  return { sessionExpires, streak, lastSavedWeek, ticketWeek, tickets, ticketStart, lastBuysDone, cheers, viewer };
}

export const VRF_DEFAULT_QUEUE = address('Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh');
export const VRF_EPHEMERAL_QUEUE = address('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
export const VRF_PROGRAM = address('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const SLOT_HASHES = address('SysvarS1otHashes111111111111111111111111111');
export const identityPda = () => pda(ROOMS_PROGRAM, [text('identity')]);
/** Ask the VRF oracle for this week's draw. Accounts follow #[vrf]: payer, room, queue, then the
 * injected program identity, VRF program, slot hashes and system program. */
export async function requestDrawIx({ payer, room, queue = VRF_DEFAULT_QUEUE, seed = 7 }) {
  return ix([rwSigner(payer), rw(room), rw(queue), ro(await identityPda()), ro(VRF_PROGRAM), ro(SLOT_HASHES), ro(SYSTEM_PROGRAM)],
    data('request_draw', B.from([seed])));
}
export async function settleDrawIx({ room, owner }) {
  return ix([rw(room), ro(await memberPda(room, owner)), rw(await resultPda(room))], data('settle_draw'));
}
/** Room byte offsets of the draw fields (tests use them to stand in for the oracle's answer). */
export const ROOM_DRAW_OFFSET = 8 + 32 + 8 + 24 + 4 + 8 + 1 + 4 + 2 + 1;

// ---- the private rollup (MagicBlock TEE): sending records there, sharing the room, committing the draw result ----
export const MB = {
  delegation: address('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'), magic: address('Magic11111111111111111111111111111111111111'),
  context: address('MagicContext1111111111111111111111111111111'), permission: address('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1'),
  vault: address('MagicVau1t999999999999999999999999999999999'), tee: address('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo'),
};
export const permissionPda = (account) => pda(MB.permission, [text('permission:'), enc.encode(account)]);
const delegateAccounts = async (payer, record) => [rwSigner(payer), rw(await pda(ROOMS_PROGRAM, [text('buffer'), enc.encode(record)])),
  rw(await pda(MB.delegation, [text('delegation'), enc.encode(record)])), rw(await pda(MB.delegation, [text('delegation-metadata'), enc.encode(record)])),
  rw(record), ro(MB.tee), ro(ROOMS_PROGRAM), ro(MB.delegation), ro(SYSTEM_PROGRAM)];
/** Send a room, its draw result, or a member record to the TEE rollup. */
export async function delegateRoomIx({ payer, room, creator, roomId }) {
  return ix(await delegateAccounts(payer, room), data('delegate_room', B.from(enc.encode(creator)), u64(roomId)));
}
export async function delegateResultIx({ payer, room }) {
  return ix(await delegateAccounts(payer, await resultPda(room)), data('delegate_result', B.from(enc.encode(room))));
}
export async function delegateMemberIx({ payer, room, owner }) {
  return ix(await delegateAccounts(payer, await memberPda(room, owner)), data('delegate_member', B.from(enc.encode(room)), B.from(enc.encode(owner))));
}
/** On the rollup: make the room and every member record readable by exactly the room's readers. */
export async function shareRoomIx({ payer, room, owners }) {
  const pairs = [];
  for (const o of owners) { const m = await memberPda(room, o); pairs.push(rw(m), rw(await permissionPda(m))); }
  return ix([roSigner(payer), rw(room), rw(await permissionPda(room)), rw(MB.vault), ro(MB.permission), ro(MB.magic), ...pairs], data('share_room'));
}
/** On the rollup: write the draw result (only) back to Solana. */
export async function commitResultIx({ payer, room }) {
  return ix([rwSigner(payer), rw(await resultPda(room)), ro(MB.magic), rw(MB.context)], data('commit_result'));
}

// ---- "add this phone": a new viewer key, asked for on Solana, applied on the rollup ----
export const viewerRequestPda = (room, owner) => pda(ROOMS_PROGRAM, [text('viewer'), enc.encode(room), enc.encode(owner)]);
export async function requestViewerIx({ owner, room, viewer }) {
  return ix([rwSigner(owner), rw(await viewerRequestPda(room, owner.address)), ro(SYSTEM_PROGRAM)], data('request_viewer', B.from(enc.encode(room)), B.from(enc.encode(viewer))));
}
export async function applyViewerIx({ room, owner }) {
  return ix([ro(await viewerRequestPda(room, owner)), rw(await memberPda(room, owner))], data('apply_viewer'));
}
export function readViewerRequest(bytes) {
  const b = B.from(bytes);
  return { room: dec.decode(b.subarray(8, 40)), owner: dec.decode(b.subarray(40, 72)), viewer: dec.decode(b.subarray(72, 104)) };
}
/** Grows a member record from before viewer keys to the current size (anyone, paying the extra rent). */
export const upgradeMemberIx = ({ payer, member }) => ix([rwSigner(payer), rw(member), ro(SYSTEM_PROGRAM)], data('upgrade_member'));

// ---- Kashutags: $name -> wallet, and wallet -> its one tag ----
export const TAG_LEN = 15;
const RESERVED_TAGS = ['kashu', 'admin', 'support', 'help', 'official', 'team', 'keeper', 'sponsor', 'security', 'mod', 'staff', 'jupiter'];
/** The one accepted spelling of a tag ("$Ada" and "ada" both mean "ada"), or null with the reason. */
export function normalTag(input) {
  const t = String(input).trim().replace(/^\$/, '').toLowerCase();
  if (t.length < 3 || t.length > TAG_LEN) return { tag: null, why: 'A Kashutag is 3 to 15 characters' };
  if (!/^[a-z][a-z0-9_]*$/.test(t)) return { tag: null, why: 'Use letters, numbers or _, starting with a letter' };
  if (RESERVED_TAGS.includes(t)) return { tag: null, why: 'That one is kept for Kashu' };
  return { tag: t, why: null };
}
export const tagBytes = (t) => { const b = B.alloc(TAG_LEN); B.from(t, 'utf8').copy(b, 0, 0, TAG_LEN); return b; };
const tagText = (b) => new TextDecoder().decode(b).replace(/\0+$/, '');
export const tagPda = (t) => pda(ROOMS_PROGRAM, [text('tag'), tagBytes(t)]);
export const tagOfPda = (owner) => pda(ROOMS_PROGRAM, [text('tag_of'), enc.encode(owner)]);
export async function claimTagIx({ owner, tag: t }) {
  return ix([rwSigner(owner), rw(await tagPda(t)), rw(await tagOfPda(owner.address)), ro(SYSTEM_PROGRAM)], data('claim_tag', tagBytes(t)));
}
export async function changeTagIx({ owner, from, to }) {
  return ix([rwSigner(owner), rw(await tagOfPda(owner.address)), rw(await tagPda(from)), rw(await tagPda(to)), ro(SYSTEM_PROGRAM)], data('change_tag', tagBytes(to)));
}
/** A Tag record: who the name points at. */
export const readTag = (bytes) => { const b = B.from(bytes); return { owner: dec.decode(b.subarray(8, 40)), tag: tagText(b.subarray(40, 40 + TAG_LEN)) }; };
/** A TagOf record: the wallet's tag. */
export const readTagOf = (bytes) => tagText(B.from(bytes).subarray(8, 8 + TAG_LEN));

// ---- private pockets: the key holding a saver's private balance on MagicBlock's private payments rollup ----
export const pocketOfPda = (owner) => pda(ROOMS_PROGRAM, [text('pocket'), enc.encode(owner)]);
export async function setPocketIx({ owner, pocket }) {
  return ix([rwSigner(owner), rw(await pocketOfPda(owner.address)), ro(SYSTEM_PROGRAM)], data('set_pocket', B.from(enc.encode(pocket))));
}
export const readPocketOf = (bytes) => dec.decode(B.from(bytes).subarray(8, 40));


// ---- profile photos: the wallet names the SHA-256 of its image; Kashu's relay serves the image by that hash ----
export const avatarOfPda = (owner) => pda(ROOMS_PROGRAM, [text('avatar'), enc.encode(owner)]);
export async function setAvatarIx({ owner, hash }) {
  return ix([rwSigner(owner), rw(await avatarOfPda(owner.address)), ro(SYSTEM_PROGRAM)], data('set_avatar', B.from(hash)));
}
/** The image's hash in hex, or null when none is set. */
export const readAvatarOf = (bytes) => { const h = B.from(bytes).subarray(8, 40); return h.every((x) => x === 0) ? null : Array.from(h, (x) => x.toString(16).padStart(2, '0')).join(''); };
