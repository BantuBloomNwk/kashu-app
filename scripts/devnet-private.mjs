// A private room on MagicBlock's TEE rollup, the whole week, live on devnet.
//   node scripts/devnet-private.mjs setup   room + draw result + pot; host joins with a viewer key; everything
//                                           goes to the TEE rollup; shared; a friend joins later (request_join on
//                                           Solana, admit on the rollup); both viewers can read, a stranger can't;
//                                           the host saves and the room counts it on the rollup.
//   node scripts/devnet-private.mjs draw    after the 10-minute week: the draw on the rollup (VRF), settled into the
//                                           draw result, only the result committed to Solana, and the prize paid
//                                           there from it; the room itself never leaves the rollup.
// Uses ~/.config/solana/id.json (host and payer) and ~/.helius-main; keeps its keys in ~/.kashu-devnet-private.json.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import nacl from 'tweetnacl';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getAuthToken, DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount, delegationMetadataPdaFromDelegatedAccount, permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import * as V from '../client/vault.mjs';
import * as R from '../client/rooms.mjs';
import { disc as tag } from '../client/bytes.mjs';

const phase = process.argv[2] || 'setup';
const key = readFileSync(`${homedir()}/.helius-main`, 'utf8').trim();
const base = new Connection(`https://devnet.helius-rpc.com/?api-key=${key}`, 'confirmed');
const TEE = 'https://devnet-tee-as.magicblock.app';
const TEE_VALIDATOR = new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo');
const ROOMS = new PublicKey(R.ROOMS_PROGRAM);
const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'), WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const host = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const stateFile = `${homedir()}/.kashu-devnet-private.json`;
const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const kp = (name) => { if (!st[name]) st[name] = Array.from(Keypair.generate().secretKey); return Keypair.fromSecretKey(Uint8Array.from(st[name])); };
const friend = kp('friend'), hostViewer = kp('hostViewer'), friendViewer = kp('friendViewer');
if (!st.roomId) st.roomId = String(Math.floor(Date.now() / 1000));
writeFileSync(stateFile, JSON.stringify(st), { mode: 0o600 });
const roomId = BigInt(st.roomId);
const log = (...a) => console.log(...a);
const ex = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const w3 = (ix) => new TransactionInstruction({ programId: new PublicKey(ix.programAddress), data: Buffer.from(ix.data),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })) });
const pk = (s) => ({ address: s.publicKey.toBase58() });
async function send(conn, ixs, label, signers = [host]) {
  const onBase = conn === base;
  for (let attempt = 1; ; attempt++) {
    try {
      const tx = new Transaction();
      if (onBase) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }));
      tx.add(...ixs);
      const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed', skipPreflight: !onBase, maxRetries: 5 });
      if (!onBase) { const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null); if (t?.meta?.err) throw Object.assign(new Error(`${label} failed on the rollup: ${JSON.stringify(t.meta.err)}`), { logs: t.meta.logMessages }); }
      log(`  ${label}: ${onBase ? ex(sig) : `${sig.slice(0, 20)}… (on the rollup)`}`); return sig;
    } catch (e) {
      if (e.logs) log(e.logs.slice(-8).join('\n'));
      if (attempt >= 4 || !/expired|block height|timed out|blockhash/i.test(e.message)) throw e;
      log(`  ${label}: dropped, trying again (${attempt})`);
    }
  }
}
const exists = async (conn, k) => !!(await conn.getAccountInfo(new PublicKey(k)));
const delegateIx = (name, record, args) => new TransactionInstruction({ programId: ROOMS, data: Buffer.concat([Buffer.from(tag(name)), ...args]), keys: [
  { pubkey: host.publicKey, isSigner: true, isWritable: true },
  { pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(record, ROOMS), isSigner: false, isWritable: true },
  { pubkey: delegationRecordPdaFromDelegatedAccount(record), isSigner: false, isWritable: true },
  { pubkey: delegationMetadataPdaFromDelegatedAccount(record), isSigner: false, isWritable: true },
  { pubkey: record, isSigner: false, isWritable: true },
  { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
  { pubkey: ROOMS, isSigner: false, isWritable: false },
  { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }] });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const teeAs = async (signer) => new Connection(`${TEE}?token=${(await getAuthToken(TEE, signer.publicKey, async (m) => nacl.sign.detached(m, signer.secretKey))).token}`, 'confirmed');
const shareIx = (room, members) => new TransactionInstruction({ programId: ROOMS, data: Buffer.from(tag('share_room')), keys: [
  { pubkey: host.publicKey, isSigner: true, isWritable: false },
  { pubkey: room, isSigner: false, isWritable: true },
  { pubkey: permissionPdaFromAccount(room), isSigner: false, isWritable: true },
  { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
  { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
  { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
  ...members.flatMap((m) => [{ pubkey: m, isSigner: false, isWritable: true }, { pubkey: permissionPdaFromAccount(m), isSigner: false, isWritable: true }])] });

const room = new PublicKey(await R.roomPda(host.publicKey.toBase58(), roomId));
const result = new PublicKey(await R.resultPda(room.toBase58()));
const hostMember = new PublicKey(await R.memberPda(room.toBase58(), host.publicKey.toBase58()));
const friendMember = new PublicKey(await R.memberPda(room.toBase58(), friend.publicKey.toBase58()));
const exp = () => Math.floor(Date.now() / 1000) + 7 * 86400;
log(`private room ${room.toBase58()} (id ${roomId})`);

if (phase === 'setup') {
  const hv = await V.vaultAddresses(host.publicKey.toBase58());
  // 1. the room on Solana, its draw result and pot, and the host with a viewer key; the host's session is the host
  if (!(await exists(base, room))) {
    await send(base, [w3(await R.createRoomIx({ creator: pk(host), roomId, name: 'Private crew' })), w3(await R.openResultIx({ payer: pk(host), room: room.toBase58() })),
      w3(await V.openPotIx({ payer: pk(host), room: room.toBase58(), usdcMint: USDC.toBase58() }))], 'room, its draw result and prize pot');
    await send(base, [w3(await R.joinRoomIx({ owner: pk(host), room: room.toBase58(), userVault: hv.userVault, session: host.publicKey.toBase58(), sessionExpires: exp(), viewer: hostViewer.publicKey.toBase58() }))], 'host joins with a viewer key from their phone');
  }
  // 2. to the TEE rollup: room, its result and the host's record
  if (!(await base.getAccountInfo(room)).owner.equals(DELEGATION_PROGRAM_ID)) {
    await send(base, [delegateIx('delegate_room', room, [host.publicKey.toBuffer(), u64(roomId)]), delegateIx('delegate_member', hostMember, [room.toBuffer(), host.publicKey.toBuffer()]),
      delegateIx('delegate_result', result, [room.toBuffer()])], 'room, draw result and host sent to the TEE rollup');
  }
  const tee = await teeAs(host);
  for (let i = 0; i < 40 && !(await tee.getAccountInfo(room)); i++) await new Promise((r) => setTimeout(r, 1000));
  await send(tee, [shareIx(room, [hostMember])], 'shared: readers are the host\'s viewer key and their session');
  // 3. a friend joins later: their record on Solana, their seat on the rollup
  if (!(await exists(base, friendMember))) {
    await send(base, [SystemProgram.transfer({ fromPubkey: host.publicKey, toPubkey: friend.publicKey, lamports: 30_000_000 })], 'friend gets SOL for fees');
    const fv = await V.vaultAddresses(friend.publicKey.toBase58());
    if (!(await exists(base, fv.userVault))) await send(base, [w3(await V.openVaultIx({ payer: pk(friend), owner: pk(friend), usdcMint: USDC.toBase58(), assetMint: WSOL.toBase58() }))], 'friend opens a vault', [host, friend]);
    await send(base, [w3(await R.requestJoinIx({ owner: pk(friend), room: room.toBase58(), userVault: fv.userVault, session: friend.publicKey.toBase58(), sessionExpires: exp(), viewer: friendViewer.publicKey.toBase58() }))], 'friend asks to join (record made on Solana, room untouched)', [host, friend]);
    await send(base, [delegateIx('delegate_member', friendMember, [room.toBuffer(), friend.publicKey.toBuffer()])], 'friend\'s record sent to the rollup');
  }
  for (let i = 0; i < 40 && !(await tee.getAccountInfo(friendMember)); i++) await new Promise((r) => setTimeout(r, 1000));
  const seated = R.readRoom((await tee.getAccountInfo(room)).data).roster.includes(friend.publicKey.toBase58());
  if (!seated) await send(tee, [w3(await R.admitIx({ room: room.toBase58(), owner: friend.publicKey.toBase58() }))], 'friend seated on the rollup');
  await send(tee, [shareIx(room, [hostMember, friendMember])], 'shared again: both viewer keys and sessions');
  // 4. who can read it
  await new Promise((r) => setTimeout(r, 2000));
  for (const [who, signer] of [['host\'s viewer key', hostViewer], ['friend\'s viewer key', friendViewer], ['a stranger', Keypair.generate()]]) {
    const a = await (await teeAs(signer)).getAccountInfo(room).catch(() => null);
    log(`  ${who} reads the room: ${a ? `yes, ${R.readRoom(a.data).members} members` : 'nothing (hidden)'}`);
  }
  log(`  on Solana the room is held by the delegation program: ${(await base.getAccountInfo(room)).owner.equals(DELEGATION_PROGRAM_ID)}`);
  // 5. the host saves 0.10 USDC (a save on devnet) and checks in on the rollup
  const hostUsdc = PublicKey.findProgramAddressSync([host.publicKey.toBuffer(), new PublicKey(V.TOKEN_PROGRAM).toBuffer(), USDC.toBuffer()], new PublicKey(V.ATA_PROGRAM))[0];
  await send(base, [w3(await V.depositIx({ owner: pk(host), from: hostUsdc.toBase58(), usdcMint: USDC.toBase58(), amount: 100_000n }))], 'host saves 0.10 USDC');
  await new Promise((r) => setTimeout(r, 3000));
  await send(tee, [w3(await R.checkInIx({ signer: pk(host), room: room.toBase58(), owner: host.publicKey.toBase58(), userVault: hv.userVault }))], 'the save counted on the rollup');
  const m = R.readMember((await tee.getAccountInfo(hostMember)).data);
  log(`  host: streak ${m.streak}, ${m.tickets} ticket(s); the week ends ${new Date((Number(R.readRoom((await tee.getAccountInfo(room)).data).weekStartsAt) + 600) * 1000).toISOString()}`);
  log('\nRun again with "draw" once the week is over.');
}

if (phase === 'draw') {
  const tee = await teeAs(host);
  let r = R.readRoom((await tee.getAccountInfo(room)).data);
  if (r.drawState === 0 || r.drawWeek !== r.week) {
    await send(tee, [w3(await R.requestDrawIx({ payer: pk(host), room: room.toBase58(), queue: R.VRF_EPHEMERAL_QUEUE }))], 'draw asked on the rollup (MagicBlock VRF)');
  }
  for (let i = 0; i < 60 && r.drawState < 2; i++) { await new Promise((res) => setTimeout(res, 2000)); r = R.readRoom((await tee.getAccountInfo(room)).data); }
  log(`  the oracle answered: ticket ${r.winningTicket} of ${r.tickets}`);
  if (r.drawState === 2) {
    for (const owner of r.roster) {
      const mm = R.readMember((await tee.getAccountInfo(new PublicKey(await R.memberPda(room.toBase58(), owner)))).data);
      if (mm.ticketWeek === r.week && mm.ticketStart <= r.winningTicket && r.winningTicket < mm.ticketStart + mm.tickets) {
        await send(tee, [w3(await R.settleDrawIx({ room: room.toBase58(), owner }))], `settled: ${owner.slice(0, 4)} wins, written into the draw result`); break;
      }
    }
  }
  const commit = new TransactionInstruction({ programId: ROOMS, data: Buffer.from(tag('commit_result')), keys: [
    { pubkey: host.publicKey, isSigner: true, isWritable: true }, { pubkey: result, isSigner: false, isWritable: true },
    { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true }] });
  await send(tee, [commit], 'only the draw result committed to Solana');
  let onBase = null;
  for (let i = 0; i < 60; i++) { onBase = R.readResult((await base.getAccountInfo(result)).data); if (onBase.week > 0) break; await new Promise((res) => setTimeout(res, 2000)); }
  log(`  on Solana the result reads: week ${onBase.week}, winner ${onBase.winner.slice(0, 4)}; the room is still held by the delegation program: ${(await base.getAccountInfo(room)).owner.equals(DELEGATION_PROGRAM_ID)}`);
  await send(base, [w3(await V.payPrizeIx({ cranker: pk(host), room: room.toBase58(), winner: onBase.winner, usdcMint: USDC.toBase58() }))], 'prize paid on Solana from the committed result');
  await send(tee, [w3(R.nextWeekIx({ anyone: pk(host), room: room.toBase58() }))], 'next week starts on the rollup');
}
