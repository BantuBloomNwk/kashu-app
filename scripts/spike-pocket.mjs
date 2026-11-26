// Spike: a private pocket on MagicBlock's private payments (devnet). A fresh on-curve key holding test USDC and no SOL:
// gasless deposit into a private balance, sign in, read it, send privately inside the rollup, then out to a smart wallet.
import { readFileSync } from 'fs'; import { homedir } from 'os';
import { Connection, Keypair, PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js';
import bs58 from 'bs58'; import crypto from 'crypto'; import { execFileSync } from 'child_process';
const edSign = (msg, kp) => crypto.sign(null, Buffer.from(msg), crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' }));
const API = 'https://payments.magicblock.app', USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const conn = new Connection(`https://devnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`, 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const SMART = process.argv[2] || '6h7Y5xfcq2QZkbx4doJcqjRpaAwLvVRL3tAayjmqHqVV';
const post = async (path, body, token) => { const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok || j.error) throw new Error(`${path}: ${JSON.stringify(j.error ?? j).slice(0, 300)}`); return j; };
const get = async (path, token) => { const r = await fetch(API + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }); return r.json(); };
async function signSend(built, kp, token, cluster = 'devnet') {
  const raw = Buffer.from(built.transactionBase64, 'base64');
  let b64;
  try { const tx = VersionedTransaction.deserialize(raw); tx.sign([kp]); b64 = Buffer.from(tx.serialize()).toString('base64'); }
  catch { const tx = Transaction.from(raw); tx.partialSign(kp); b64 = tx.serialize({ requireAllSignatures: false }).toString('base64'); }
  if (built.sendTo === 'base') {
    try { const sig = await conn.sendRawTransaction(Buffer.from(b64, 'base64'), { preflightCommitment: 'confirmed' }); await conn.confirmTransaction(sig, 'confirmed'); return sig; }
    catch (e) { throw new Error(`base send: ${e.message.slice(0, 200)} ${(e.logs || []).slice(-6).join(' | ')}`); }
  }
  if (built.sendTo === 'ephemeral') {
    const inner = String(token).split('.').slice(1).join('.') || token;
    const url = `https://devnet-tee-as.magicblock.app?token=${encodeURIComponent(inner)}`;
    const rr = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64', skipPreflight: false }] }) })).json();
    if (rr.error) throw new Error(`tee send: ${JSON.stringify(rr.error).slice(0, 400)}`);
    for (let i = 0; i < 20; i++) { const st = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[rr.result]] }) })).json(); const v = st.result?.value?.[0]; if (v?.err) throw new Error('tee tx failed ' + JSON.stringify(v.err)); if (v?.confirmationStatus) return rr.result + ' (' + v.confirmationStatus + ')'; await new Promise((r) => setTimeout(r, 1000)); }
    return rr.result + ' (unconfirmed)';
  }
  const r = await post('/v1/transaction/send', { transactionBase64: b64, sendTo: built.sendTo, ...(built.sendRpcEndpoint ? { sendRpcEndpoint: built.sendRpcEndpoint } : {}), cluster, confirm: true, recentBlockhash: built.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, token);
  if (r.confirmed === false) console.log('   (not confirmed yet)');
  return r.signature ?? JSON.stringify(r).slice(0, 120);
}
const login = async (kp) => {
  const c = await get(`/v1/spl/challenge?pubkey=${kp.publicKey.toBase58()}&cluster=devnet-private`);
  const sig = bs58.encode(edSign(c.challenge, kp));
  const l = await post('/v1/spl/login', { pubkey: kp.publicKey.toBase58(), challenge: c.challenge, signature: sig, cluster: 'devnet-private' });
  return l.token;
};
const pocket = Keypair.generate(), friend = Keypair.generate();
(await import('fs')).writeFileSync(`${process.env.SPIKE_KEYS || '/tmp'}/pocket-${pocket.publicKey.toBase58()}.json`, JSON.stringify([...pocket.secretKey]), { mode: 0o600 });
console.log('pocket', pocket.publicKey.toBase58(), 'friend', friend.publicKey.toBase58());
execFileSync('spl-token', ['transfer', USDC.toBase58(), process.env.FUND || '2', pocket.publicKey.toBase58(), '--fund-recipient', '--allow-unfunded-recipient', '-u', conn.rpcEndpoint], { stdio: 'pipe' });
console.log('1. pocket funded with 2 test USDC, 0 SOL');
const dep = await post('/v1/spl/deposit', { owner: pocket.publicKey.toBase58(), amount: Number(process.env.DEPOSIT || 1_000_000), cluster: 'devnet-private', initIfMissing: true, initVaultIfMissing: true, initAtasIfMissing: true, idempotent: true, private: true, gasless: true });
console.log('2. gasless deposit', await signSend(dep, pocket), 'fees', JSON.stringify(dep.fees));
const tok = await login(pocket);
console.log('3. signed in to the private rollup');
for (let i = 0; i < 20; i++) { const b = await get(`/v1/spl/private-balance?address=${pocket.publicKey.toBase58()}&mint=${USDC.toBase58()}&cluster=devnet-private`, tok); if (Number(b.balance ?? b.amount ?? 0) > 0) { console.log('   private balance', JSON.stringify(b).slice(0, 160)); break; } if (i === 19) console.log('   private balance still', JSON.stringify(b).slice(0, 200)); await new Promise((r) => setTimeout(r, 3000)); }
const SKIP = !!process.env.SKIP_SENDS;
const t1 = SKIP ? null : await post('/v1/spl/transfer', { from: pocket.publicKey.toBase58(), to: friend.publicKey.toBase58(), mint: USDC.toBase58(), amount: 300_000, visibility: 'private', fromBalance: 'ephemeral', toBalance: 'ephemeral', cluster: 'devnet-private', initIfMissing: true, exactOut: true }, tok);
if (!SKIP) console.log('   builder keys', Object.keys(t1).join(','), t1.sendRpcEndpoint ? 'rpc ' + String(t1.sendRpcEndpoint).replace(/token=[^&]+/, 'token=<hidden>') : '');
if (!SKIP) console.log('4. private send inside the rollup: sendTo', t1.sendTo, 'fees', JSON.stringify(t1.fees), 'signers', t1.requiredSigners?.join(','));
if (!SKIP) console.log('   ', await signSend(t1, pocket, tok, 'devnet-private'));
const t2 = SKIP ? null : await post('/v1/spl/transfer', { from: pocket.publicKey.toBase58(), to: SMART, mint: USDC.toBase58(), amount: 500_000, visibility: 'private', fromBalance: 'ephemeral', toBalance: 'base', cluster: 'devnet-private', initIfMissing: true, initAtasIfMissing: true, exactOut: true }, tok);
if (!SKIP) console.log('5. private send out to a smart wallet on Solana: sendTo', t2.sendTo, 'fees', JSON.stringify(t2.fees));
if (!SKIP) console.log('   ', await signSend(t2, pocket, tok, 'devnet-private'));

// cash-out: gasless withdraw back to the pocket's Solana account, then a gasless send to a smart wallet
const viaApi = async (built, kp, token, cluster) => {
  const raw = Buffer.from(built.transactionBase64, 'base64'); const tx = VersionedTransaction.deserialize(raw); tx.sign([kp]);
  const b64 = Buffer.from(tx.serialize()).toString('base64');
  return post('/v1/transaction/send', { transactionBase64: b64, sendTo: built.sendTo, cluster, confirm: true, recentBlockhash: built.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, token);
};
const baseBal = async (owner) => { try { const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: USDC }); return r.value.reduce((a, x) => a + x.account.data.parsed.info.tokenAmount.uiAmount, 0); } catch { return -1; } };
console.log('   pocket on Solana before', await baseBal(pocket.publicKey.toBase58()));
const w = await post('/v1/spl/withdraw', { owner: pocket.publicKey.toBase58(), mint: USDC.toBase58(), amount: 500_000, cluster: 'devnet-private', idempotent: true, gasless: true }, tok);
console.log('7. gasless withdraw: sendTo', w.sendTo, 'fees', JSON.stringify(w.fees));
console.log('   sent by us:', await signSend(w, pocket, tok));
for (let i = 0; i < 12; i++) { const b = await baseBal(pocket.publicKey.toBase58()); console.log(`   t+${i * 10}s pocket on Solana ${b}`); if (b >= 0.7) break; await new Promise((r) => setTimeout(r, 10_000)); }
const g = await post('/v1/spl/transfer', { from: pocket.publicKey.toBase58(), to: SMART, mint: USDC.toBase58(), amount: Number(process.env.OUT || 500_000), visibility: 'public', fromBalance: 'base', toBalance: 'base', cluster: 'devnet', initAtasIfMissing: true, gasless: true });
console.log('8. gasless send to the smart wallet: fees', JSON.stringify(g.fees));
console.log('   sent by us:', await signSend(g, pocket, null));
console.log('   smart wallet now', await baseBal(SMART));
