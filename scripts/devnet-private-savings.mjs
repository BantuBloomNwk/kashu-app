// Private savings end to end on devnet: a saver with a private pocket joins a room that Kashu's keeper makes private;
// the saver saves through the vault's save_private (wallet -> their own pocket, counted by the vault), the pocket
// deposits into its private balance, and the keeper counts the save. The room shows the saver saved; the balance
// is readable by the pocket alone.
// Needs: a saved pocket key (POCKET_KEY, a keypair file) whose wallet is POCKET_OWNER's keypair (the admin here).
import { readFileSync, existsSync, writeFileSync } from 'fs'; import { homedir } from 'os'; import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import * as V from '../client/vault.mjs'; import * as R from '../client/rooms.mjs';
const KEEPER = 'BCwrbGuQ7mySKNRyX5zNMdAgJ58qG8c6YJN7vpjgaSDt', TEE = 'https://devnet-tee-as.magicblock.app', API = 'https://payments.magicblock.app';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', WSOL = 'So11111111111111111111111111111111111111112', DELEGATION = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
const rpcUrl = `https://devnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`;
const conn = new Connection(rpcUrl, 'confirmed');
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const pocket = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.POCKET_KEY))));
const web3 = (k) => new TransactionInstruction({ programId: new PublicKey(k.programAddress), data: Buffer.from(k.data), keys: k.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role % 2 === 1 })) });
const send = async (ixs, signers) => sendAndConfirmTransaction(conn, new Transaction().add(...(await Promise.all(ixs)).map(web3)), signers);
const pkcs8 = (seed) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
const viewer = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); return { privateKey, raw: publicKey.export({ format: 'der', type: 'spki' }).subarray(12) }; };
let pass = 0, fail = 0; const check = (l, ok, x = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${x ? '   ' + x : ''}`); ok ? pass++ : fail++; };
const teeToken = async (pub, sign) => { const c = await (await fetch(`${TEE}/auth/challenge?pubkey=${pub}`)).json(); return (await (await fetch(`${TEE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubkey: pub, challenge: c.challenge, signature: bs58.encode(sign(Buffer.from(c.challenge))) }) })).json()).token; };
const teeRead = async (tok, a) => { const j = await (await fetch(`${TEE}?token=${tok}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [a, { encoding: 'base64' }] }) })).json(); return j.result?.value ? Buffer.from(j.result.value.data[0], 'base64') : null; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const me = owner.publicKey.toBase58();

// the saver: their vault (once), a room, and a phone key that may read it
const va = await V.vaultAddresses(me);
if (!(await conn.getAccountInfo(new PublicKey(va.userVault)))) await send([V.openVaultIx({ payer: { address: me }, owner: { address: me }, usdcMint: USDC, assetMint: WSOL })], [owner]);
check('the saver\'s wallet names this pocket', R.readPocketOf((await conn.getAccountInfo(new PublicKey(await R.pocketOfPda(me)))).data) === pocket.publicKey.toBase58());
const phone = viewer();
const roomId = BigInt(Date.now());
const room = await R.roomPda(me, roomId);
await send([R.createRoomIx({ creator: { address: me }, roomId, name: 'Quiet savers' })], [owner]);
await send([R.joinRoomIx({ owner: { address: me }, room, userVault: va.userVault, session: KEEPER, sessionExpires: Math.floor(Date.now() / 1000) + 30 * 86400, viewer: bs58.encode(phone.raw) })], [owner]);
console.log('room', room);
let priv = false;
for (let i = 0; i < 80 && !priv; i++) { priv = (await conn.getAccountInfo(new PublicKey(room)))?.owner.toBase58() === DELEGATION; if (!priv) await wait(5000); }
check('the keeper made the room private', priv);
const asPhone = async () => teeToken(bs58.encode(phone.raw), (m) => crypto.sign(null, m, phone.privateKey));
for (let i = 0; i < 30 && !(await teeRead(await asPhone(), room)); i++) await wait(4000);

// the private save: wallet -> pocket through the vault (counted), then into the pocket's private balance (gasless)
const usdcAta = (o) => execFileSync('spl-token', ['address', '--token', USDC, '--owner', o, '--verbose', '-u', rpcUrl], { encoding: 'utf8' }).match(/Associated token address: (\w+)/)[1];
const pocketAta = usdcAta(pocket.publicKey.toBase58());
if (!(await conn.getAccountInfo(new PublicKey(pocketAta)))) execFileSync('spl-token', ['create-account', USDC, '--owner', pocket.publicKey.toBase58(), '--fee-payer', `${homedir()}/.config/solana/id.json`, '-u', rpcUrl], { stdio: 'pipe' });
const before = V.readUserVault((await conn.getAccountInfo(new PublicKey(va.userVault))).data).buysDone;
const sp = await send([V.savePrivateIx({ owner: { address: me }, from: usdcAta(me), to: pocketAta, usdcMint: USDC, amount: 700_000n })], [owner]);
check('the private save went through the vault, which counted it', V.readUserVault((await conn.getAccountInfo(new PublicKey(va.userVault))).data).buysDone === before + 1, sp.slice(0, 16));
const dep = await (await fetch(`${API}/v1/spl/deposit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: pocket.publicKey.toBase58(), amount: 500_000, cluster: 'devnet-private', initIfMissing: true, initVaultIfMissing: true, initAtasIfMissing: true, idempotent: true, private: true, gasless: true }) })).json();
if (dep.error) throw new Error(JSON.stringify(dep.error));
const tx = VersionedTransaction.deserialize(Buffer.from(dep.transactionBase64, 'base64')); tx.sign([pocket]);
const depSig = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(depSig, 'confirmed');
console.log('deposit into the private balance', depSig.slice(0, 16));

// the keeper counts it in the private room
let counted = false, m = null;
for (let i = 0; i < 40 && !counted; i++) { await wait(6000); const t = await asPhone(); const rb = await teeRead(t, room), mb = await teeRead(t, await R.memberPda(room, me)); if (rb && mb) { m = R.readMember(mb); counted = m.lastSavedWeek === R.readRoom(rb).week; } }
check('the keeper counted the save: the saver\'s window is lit in the private room', counted, m ? `streak ${m.streak}` : '');
const stranger = viewer();
check('a stranger signed in to the rollup sees neither the room nor the pocket', !(await teeRead(await teeToken(bs58.encode(stranger.raw), (x) => crypto.sign(null, x, stranger.privateKey)), room)) && !(await teeRead(await teeToken(bs58.encode(stranger.raw), (x) => crypto.sign(null, x, stranger.privateKey)), pocketAta)));
const pocketKey = pkcs8(pocket.secretKey.subarray(0, 32));
const ch = await (await fetch(`${API}/v1/spl/challenge?pubkey=${pocket.publicKey.toBase58()}&cluster=devnet-private`)).json();
const lg = await (await fetch(`${API}/v1/spl/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubkey: pocket.publicKey.toBase58(), challenge: ch.challenge, signature: bs58.encode(crypto.sign(null, Buffer.from(ch.challenge), pocketKey)), cluster: 'devnet-private' }) })).json();
const pb = await (await fetch(`${API}/v1/spl/private-balance?address=${pocket.publicKey.toBase58()}&mint=${USDC}&cluster=devnet-private`, { headers: { authorization: `Bearer ${lg.token}` } })).json();
check('the pocket itself reads its private balance', Number(pb.balance) >= 500_000, `balance ${pb.balance}`);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
