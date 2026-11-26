// Win-notification subscriptions on devnet: a member's subscription is accepted only when signed by their phone key
// (checked by the keeper against the room's record). Delivery itself needs a real phone; this checks the gate.
import { readFileSync } from 'fs'; import { homedir } from 'os'; import crypto from 'crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58'; import * as V from '../client/vault.mjs'; import * as R from '../client/rooms.mjs';
const RELAY = 'https://kashu-relay.161-97-74-212.sslip.io', KEEPER = 'BCwrbGuQ7mySKNRyX5zNMdAgJ58qG8c6YJN7vpjgaSDt';
const conn = new Connection(`https://devnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`, 'confirmed');
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const web3 = (k) => new TransactionInstruction({ programId: new PublicKey(k.programAddress), data: Buffer.from(k.data), keys: k.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role % 2 === 1 })) });
const send = async (ixs) => sendAndConfirmTransaction(conn, new Transaction().add(...(await Promise.all(ixs)).map(web3)), [owner]);
const viewer = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); return { privateKey, raw: publicKey.export({ format: 'der', type: 'spki' }).subarray(12) }; };
const me = owner.publicKey.toBase58(), va = await V.vaultAddresses(me), phone = viewer(), wrong = viewer();
const roomId = BigInt(Date.now()), room = await R.roomPda(me, roomId);
await send([R.createRoomIx({ creator: { address: me }, roomId, name: 'Push test' })]);
await send([R.joinRoomIx({ owner: { address: me }, room, userVault: va.userVault, session: KEEPER, sessionExpires: Math.floor(Date.now() / 1000) + 30 * 86400, viewer: bs58.encode(phone.raw) })]);
const sub = (tag) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/kashu-test-${tag}-${Date.now()}`, keys: { p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
const post = async (s, key) => (await fetch(`${RELAY}/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, owner: me, sub: s, sig: bs58.encode(crypto.sign(null, Buffer.from(`kashu-push:${room}:${s.endpoint}`), key)) }) })).status;
const evil = { ...sub('evil'), endpoint: 'https://169.254.169.254/latest/meta-data' };
console.log('a subscription pointing anywhere but a push service:', await post(evil, phone.privateKey));
console.log('one signed by the wrong key:', await post(sub('wrong'), wrong.privateKey));
console.log('one signed by the member\'s phone:', await post(sub('right'), phone.privateKey));
console.log('room', room);
