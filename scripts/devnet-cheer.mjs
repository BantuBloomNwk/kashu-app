// Cheers end to end on devnet: two savers in a fresh room, each with a phone viewer key; one cheers the other through
// Kashu's live relay, and the keeper (after checking the signature against the room's record) adds it on chain.
// A cheer signed by the wrong key must be refused. Costs a little devnet SOL from the admin wallet.
import { readFileSync } from 'fs'; import { homedir } from 'os'; import crypto from 'crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import * as V from '../client/vault.mjs'; import * as R from '../client/rooms.mjs';
const RELAY = process.env.RELAY || 'https://kashu-relay.161-97-74-212.sslip.io';
const KEEPER = 'BCwrbGuQ7mySKNRyX5zNMdAgJ58qG8c6YJN7vpjgaSDt';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', WSOL = 'So11111111111111111111111111111111111111112';
const conn = new Connection(`https://devnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`, 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const web3 = (k) => new TransactionInstruction({ programId: new PublicKey(k.programAddress), data: Buffer.from(k.data),
  keys: k.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role % 2 === 1 })) });
const send = (ixs, signers) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs.map((i) => (i.programId ? i : web3(i)))), signers);
const who = (kp) => ({ address: kp.publicKey.toBase58() });
const viewer = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); return { privateKey, raw: publicKey.export({ format: 'der', type: 'spki' }).subarray(12) }; };
let pass = 0, fail = 0; const check = (l, ok, x = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${x ? '   ' + x : ''}`); ok ? pass++ : fail++; };

const a = Keypair.generate(), b = Keypair.generate(), va = viewer(), vb = viewer();
await send([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: a.publicKey, lamports: 60_000_000 }), SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: b.publicKey, lamports: 60_000_000 })], [admin]);
for (const p of [a, b]) await send([await V.openVaultIx({ payer: who(p), owner: who(p), usdcMint: USDC, assetMint: WSOL })], [p]);
const roomId = BigInt(Date.now());
const room = await R.roomPda(a.publicKey.toBase58(), roomId);
const expires = Math.floor(Date.now() / 1000) + 30 * 86400;
await send([await R.createRoomIx({ creator: who(a), roomId, name: 'Cheer test' })], [a]);
for (const [p, v] of [[a, va], [b, vb]]) {
  const vault = (await V.vaultAddresses(p.publicKey.toBase58())).userVault;
  await send([await R.joinRoomIx({ owner: who(p), room, userVault: vault, session: KEEPER, sessionExpires: expires, viewer: bs58.encode(v.raw) })], [p]);
}
const r = R.readRoom((await conn.getAccountInfo(new PublicKey(room))).data);
check('a room of two, both seated', r.members === 2, room);
const cheers = async () => R.readMember((await conn.getAccountInfo(new PublicKey(await R.memberPda(room, b.publicKey.toBase58())))).data).cheers;
const post = (signer) => fetch(`${RELAY}/cheer`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ room, from: a.publicKey.toBase58(), to: b.publicKey.toBase58(), week: r.week, sig: bs58.encode(crypto.sign(null, Buffer.from(`kashu-cheer:${room}:${b.publicKey.toBase58()}:${r.week}`), signer)) }) });
const before = await cheers();
check('a cheer signed by the wrong key is filed', (await post(vb.privateKey)).status === 202);
await new Promise((res) => setTimeout(res, 15_000));
check('but the keeper refuses it', (await cheers()) === before, `cheers ${await cheers()}`);
check('a cheer signed by the sender\'s own phone is filed', (await post(va.privateKey)).status === 202);
let n = before; for (let i = 0; i < 20 && n === before; i++) { await new Promise((res) => setTimeout(res, 3000)); n = await cheers(); }
check('and lands on chain: the friend has one more cheer', n === before + 1, `${before} -> ${n}`);

// ---- the same, once the room is private: the keeper moves it to MagicBlock's TEE rollup and shares it with the phones ----
const TEE = 'https://devnet-tee-as.magicblock.app';
const DELEGATION = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
let moved = false;
for (let i = 0; i < 60 && !moved; i++) { moved = (await conn.getAccountInfo(new PublicKey(room)))?.owner.toBase58() === DELEGATION; if (!moved) await new Promise((res) => setTimeout(res, 5000)); }
check('the keeper moved the room to the private rollup', moved);
const teeToken = async (v) => {
  const addr = bs58.encode(v.raw);
  const c = await (await fetch(`${TEE}/auth/challenge?pubkey=${addr}`)).json();
  const r = await (await fetch(`${TEE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubkey: addr, challenge: c.challenge, signature: bs58.encode(crypto.sign(null, Buffer.from(c.challenge), v.privateKey)) }) })).json();
  return r.token;
};
const teeRead = async (tok, a) => { const j = await (await fetch(`${TEE}?token=${tok}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [a, { encoding: 'base64' }] }) })).json(); return j.result?.value ? Buffer.from(j.result.value.data[0], 'base64') : null; };
// until the keeper sets the reader list, the room shows what was already public on Solana; after, only its members
const stranger = viewer();
let locked = false;
for (let i = 0; i < 40 && !locked; i++) { locked = !(await teeRead(await teeToken(stranger), room)); if (!locked) await new Promise((res) => setTimeout(res, 3000)); }
check('once shared, a stranger signed in to the rollup sees nothing', locked);
const tok = await teeToken(vb), roomOnTee = await teeRead(tok, room);
check('and the friend\'s phone can read it', !!roomOnTee);
const pr = R.readRoom(await teeRead(tok, room)); // read right before cheering: devnet weeks are ten minutes
// one cheer per friend per week, so this time B cheers A
const memberA = await R.memberPda(room, a.publicKey.toBase58());
const teeCheers = async () => R.readMember(await teeRead(tok, memberA)).cheers;
const pBefore = await teeCheers();
const postWeek = (signer, week) => fetch(`${RELAY}/cheer`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ room, from: b.publicKey.toBase58(), to: a.publicKey.toBase58(), week, sig: bs58.encode(crypto.sign(null, Buffer.from(`kashu-cheer:${room}:${a.publicKey.toBase58()}:${week}`), signer)) }) });
check('a wrongly signed cheer for the private room is filed', (await postWeek(va.privateKey, pr.week)).status === 202);
await new Promise((res) => setTimeout(res, 12_000));
check('and refused', (await teeCheers()) === pBefore);
check('a real cheer for the private room is filed', (await postWeek(vb.privateKey, pr.week)).status === 202);
let pn = pBefore; for (let i = 0; i < 20 && pn === pBefore; i++) { await new Promise((res) => setTimeout(res, 3000)); pn = await teeCheers(); }
check('and lands on the private rollup, readable only by the room', pn === pBefore + 1, `${pBefore} -> ${pn} (week ${pr.week})`);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
