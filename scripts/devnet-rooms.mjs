// A private room on MagicBlock's TEE rollup, end to end on devnet:
//   set up the vault config once, open a vault, open a room and join it, hand the room and the
//   member record to the TEE validator, run share_room there, then prove who can read the room.
// Run from the repo root: node scripts/devnet-rooms.mjs   (uses ~/.config/solana/id.json, devnet SOL)
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getAuthToken, DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount, delegationMetadataPdaFromDelegatedAccount, permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import * as V from '../client/vault.mjs';
import * as R from '../client/rooms.mjs';

// Helius (key in ~/.helius-main, never printed) unless BASE_RPC says otherwise
const heliusKey = (() => { try { return readFileSync(`${homedir()}/.helius-main`, 'utf8').trim(); } catch { return ''; } })();
const BASE = process.env.BASE_RPC || (heliusKey ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}` : 'https://rpc.magicblock.app/devnet');
const TEE = 'https://devnet-tee-as.magicblock.app';
const TEE_VALIDATOR = new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo');
const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const ROOMS = new PublicKey(R.ROOMS_PROGRAM);

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const me = { address: payer.publicKey.toBase58() };
const base = new Connection(BASE, 'confirmed');
const disc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const ex = (sig, cluster = 'devnet') => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
const log = (...a) => console.log(...a);

/** A @solana/kit-style instruction from our client into a web3.js one. Roles: 0 ro, 1 w, 2 ro signer, 3 w signer. */
const w3 = (ix) => new TransactionInstruction({
  programId: new PublicKey(ix.programAddress), data: Buffer.from(ix.data),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })),
});
// devnet drops low-fee transactions when busy: base-layer sends carry a priority fee and retry
const send = async (conn, ixs, label) => {
  const onBase = conn === base;
  for (let attempt = 1; ; attempt++) {
    try {
      const tx = new Transaction();
      if (onBase) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }));
      tx.add(...ixs);
      const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed', skipPreflight: !onBase, maxRetries: 5 });
      log(`  ${label}: ${onBase ? ex(sig) : sig}`); return sig;
    } catch (e) {
      if (attempt >= 4 || !/expired|block height|timed out|blockhash/i.test(e.message)) throw e;
      log(`  ${label}: dropped, trying again (${attempt})`);
    }
  }
};
const exists = async (conn, k) => !!(await conn.getAccountInfo(new PublicKey(k)));

log(`wallet ${me.address}, ${(await base.getBalance(payer.publicKey)) / 1e9} SOL`);

// 1. the vault program's config (once) and this wallet's vault
if (!(await exists(base, await V.configPda()))) {
  // no swap venue on devnet: the weekly buy is not part of the devnet beta, so the System program stands in
  await send(base, [w3(await V.initializeIx({ admin: me, usdcMint: USDC.toBase58(), assetMint: WSOL.toBase58(), swapProgram: SystemProgram.programId.toBase58(), perUserCap: 50_000_000n, totalCap: 5_000_000_000n, floorRate: 1n }))], 'vault config set up');
} else log('  vault config already set up');
const va = await V.vaultAddresses(me.address);
if (!(await exists(base, va.userVault))) {
  await send(base, [w3(await V.openVaultIx({ payer: me, owner: me, usdcMint: USDC.toBase58(), assetMint: WSOL.toBase58() }))], 'vault opened');
} else log('  vault already open');

// 2. a fresh room, and this wallet joins it
// ROOM_ID=<id> picks up a room made by an earlier run
const roomId = BigInt(process.env.ROOM_ID || Math.floor(Date.now() / 1000));
const room = new PublicKey(await R.roomPda(me.address, roomId));
const member = new PublicKey(await R.memberPda(room.toBase58(), me.address));
if (!(await exists(base, room.toBase58()))) await send(base, [w3(await R.createRoomIx({ creator: me, roomId, name: 'Kashu devnet' }))], `room ${room.toBase58()} opened`);
else log(`  room ${room.toBase58()} already open`);
if (!(await exists(base, member.toBase58()))) await send(base, [w3(await R.joinRoomIx({ owner: me, room: room.toBase58(), userVault: va.userVault, session: me.address, sessionExpires: Math.floor(Date.now() / 1000) + 7 * 86400 }))], 'joined');
else log('  already a member');

// 3. hand the room and the member record to the TEE validator
const delegateIx = (name, record, args) => new TransactionInstruction({
  programId: ROOMS, data: Buffer.concat([disc(name), ...args]),
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(record, ROOMS), isSigner: false, isWritable: true },
    { pubkey: delegationRecordPdaFromDelegatedAccount(record), isSigner: false, isWritable: true },
    { pubkey: delegationMetadataPdaFromDelegatedAccount(record), isSigner: false, isWritable: true },
    { pubkey: record, isSigner: false, isWritable: true },
    { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
    { pubkey: ROOMS, isSigner: false, isWritable: false },
    { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
if (!(await base.getAccountInfo(room)).owner.equals(DELEGATION_PROGRAM_ID)) {
  await send(base, [delegateIx('delegate_room', room, [payer.publicKey.toBuffer(), u64(roomId)]), delegateIx('delegate_member', member, [room.toBuffer(), payer.publicKey.toBuffer()])], 'room and member sent to the TEE rollup');
} else log('  room already on the TEE rollup');

// 4. sign in to the TEE rollup (a member's token) and share the room there
const sign = async (msg) => nacl.sign.detached(msg, payer.secretKey);
const { token } = await getAuthToken(TEE, payer.publicKey, sign);
const tee = new Connection(`${TEE}?token=${token}`, 'confirmed');
for (let i = 0; i < 30 && !(await tee.getAccountInfo(room)); i++) await new Promise((r) => setTimeout(r, 1000));
const share = new TransactionInstruction({
  programId: ROOMS, data: disc('share_room'),
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: room, isSigner: false, isWritable: true },
    { pubkey: permissionPdaFromAccount(room), isSigner: false, isWritable: true },
    { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
    { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: member, isSigner: false, isWritable: true },
    { pubkey: permissionPdaFromAccount(member), isSigner: false, isWritable: true },
  ],
});
const shareSig = await send(tee, [share], 'share_room on the TEE rollup');
const st = await tee.getTransaction(shareSig, { maxSupportedTransactionVersion: 0 }).catch(() => null);
if (st?.meta?.err) { log('  share_room failed:', JSON.stringify(st.meta.err)); log(st.meta.logMessages?.slice(-12).join('\n')); process.exit(1); }

// 5. who can read the room now
await new Promise((r) => setTimeout(r, 2000));
const asMember = await tee.getAccountInfo(room);
log(`  a member reads the room on the TEE rollup: ${asMember ? `yes, ${asMember.data.length} bytes, ${R.readRoom(asMember.data).members} member(s)` : 'NO'}`);
const stranger = Keypair.generate();
const { token: t2 } = await getAuthToken(TEE, stranger.publicKey, async (m) => nacl.sign.detached(m, stranger.secretKey));
const asStranger = await new Connection(`${TEE}?token=${t2}`, 'confirmed').getAccountInfo(room).catch((e) => `refused (${e.message.slice(0, 80)})`);
log(`  a stranger signed in to the same rollup reads it: ${asStranger === null ? 'nothing (hidden)' : typeof asStranger === 'string' ? asStranger : `YES, ${asStranger.data.length} bytes (NOT private)`}`);
const onBase = await base.getAccountInfo(room);
log(`  on Solana the room now belongs to the delegation program: ${onBase?.owner.equals(DELEGATION_PROGRAM_ID)}`);
log(`\nroom ${room.toBase58()}  member ${member.toBase58()}`);
