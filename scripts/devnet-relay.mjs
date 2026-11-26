// The relay against devnet: one honest passkey transaction it should sponsor, and the attacks it must refuse.
//   node scripts/devnet-relay.mjs   (the deployed devnet relay; RELAY=http://127.0.0.1:8830 for a local one)
// Needs the stand-in passkey from scripts/devnet-passkey.mjs (~/.kashu-devnet-passkey.json) and its funded vault.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import {
  address, appendTransactionMessageInstructions, compileTransaction, createSolanaRpc, createTransactionMessage, getBase64EncodedWireTransaction,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, generateKeyPairSigner, AccountRole, getAddressEncoder, getProgramDerivedAddress,
} from '@solana/kit';
import { getSigningFnForSecp256r1PrivateKey, Actions, createSecp256r1AuthorityInfo } from '@swig-wallet/lib';
import { fetchSwig, findSwigPda, getSignInstructions, getSwigWalletAddress, getCreateSwigInstruction } from '@swig-wallet/kit';
import { review, oneSigning, PROGRAMS } from '@readback/review';
import { KASHU_DECODERS } from '../client/review.mjs';
import * as V from '../client/vault.mjs';

const RELAY = process.env.RELAY || 'https://kashu-relay.161-97-74-212.sslip.io';
const rpc = createSolanaRpc(`${RELAY}/rpc`);
const sponsor = address((await (await fetch(`${RELAY}/health`)).json()).sponsor);
const me = JSON.parse(readFileSync(`${homedir()}/.kashu-devnet-passkey.json`, 'utf8'));
const signingFn = getSigningFnForSecp256r1PrivateKey(Uint8Array.from(Buffer.from(me.d, 'base64url')));
const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`); ok ? pass++ : fail++; };

const swig = await fetchSwig(rpc, await findSwigPda(Uint8Array.from(Buffer.from(me.id, 'base64'))));
const wallet = await getSwigWalletAddress(swig);
const enc = getAddressEncoder();
const ataOf = async (owner, mint) => (await getProgramDerivedAddress({ programAddress: address(V.ATA_PROGRAM), seeds: [owner, V.TOKEN_PROGRAM, mint].map((x) => enc.encode(x)) }))[0];
const walletUsdc = await ataOf(wallet, USDC);
const strip = (ix) => ({ ...ix, accounts: ix.accounts.map(({ signer, ...a }) => a) });

/** Builds a transaction with the relay's sponsor as fee payer, unsigned, as the app will. */
async function unsigned(ixs, feePayer = sponsor) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(feePayer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ixs, m));
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}
const post = async (tx) => { const r = await fetch(`${RELAY}/sponsor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx }) }); return { status: r.status, ...(await r.json()) }; };
const passkeySign = async (inner) => {
  const r = await review(inner, { allow: [V.VAULT_PROGRAM, V.ROOMS_PROGRAM, PROGRAMS.TOKEN, PROGRAMS.ATA, PROGRAMS.SYSTEM], programs: KASHU_DECODERS });
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  return { review: r, ixs: await getSignInstructions(swig, 0, inner, false, { signingFn: oneSigning(signingFn, r.seal, inner), payer: sponsor, currentSlot: slot }) };
};

console.log('\nAn honest save, paid for by the sponsor');
const save = [strip(await V.depositIx({ owner: { address: wallet }, from: walletUsdc, usdcMint: USDC, amount: 100_000n }))];
const s = await passkeySign(save);
console.log(`  the review the person saw: "${s.review.lines.map((l) => l.text).join(' / ')}"`);
const ok = await post(await unsigned(s.ixs));
check('the relay sponsors it and it lands', ok.status === 200 && typeof ok.signature === 'string', JSON.stringify(ok).slice(0, 300));
if (ok.signature) console.log(`  https://explorer.solana.com/tx/${ok.signature}?cluster=devnet`);

console.log('\nWhat the relay must refuse');
const thief = (await generateKeyPairSigner()).address;
const drain = { programAddress: address(PROGRAMS.SYSTEM), accounts: [{ address: sponsor, role: AccountRole.WRITABLE_SIGNER }, { address: thief, role: AccountRole.WRITABLE }], data: Uint8Array.from([2, 0, 0, 0, ...new Uint8Array(new BigUint64Array([50_000_000n]).buffer)]) };
let r = await post(await unsigned([...(await passkeySign(save)).ixs, drain]));
check('a sponsored save with a transfer out of the sponsor tacked on', r.status >= 400 && /not sponsored at the top level|more than we sponsor/.test(r.error), r.error);
// the same, small enough to pass for rent: the simulation shows the "wallet" kept it, so it is refused
const nibble = { ...drain, data: Uint8Array.from([2, 0, 0, 0, ...new Uint8Array(new BigUint64Array([5_000_000n]).buffer)]) };
r = await post(await unsigned([...(await passkeySign(save)).ixs, nibble]));
// (today Swig itself refuses the extra top-level instruction first; the relay's rent rule is the second line)
check('a small transfer out of the sponsor dressed up as rent', r.status >= 400 && /not all spent|not sponsored|would fail/.test(r.error), r.error);
r = await post(await unsigned([drain]));
check('a plain transfer out of the sponsor', r.status >= 400, r.error);
const inner = [{ ...drain, accounts: [{ address: sponsor, role: AccountRole.WRITABLE }, { address: thief, role: AccountRole.WRITABLE }] }];
r = await post(await unsigned((await passkeySign(inner)).ixs)).catch((e) => ({ status: 0, error: e.message }));
check('a passkey-signed transaction that tries to spend the sponsor\'s SOL inside Swig', r.status >= 400, r.error);
r = await post(await unsigned((await passkeySign(save)).ixs, thief));
check('someone else as fee payer', r.status >= 400 && /fee payer/.test(r.error), r.error);
const newKey = (await generateKeyPairSigner()).address;
const fresh = await getCreateSwigInstruction({ payer: sponsor, id: crypto.getRandomValues(new Uint8Array(32)), actions: Actions.set().all().get(), authorityInfo: createSecp256r1AuthorityInfo(new Uint8Array([2, ...new Uint8Array(32).fill(4)])) });
const closeIx = { ...fresh, data: Uint8Array.from([15, 0, ...fresh.data.slice(2)]) };
r = await post(await unsigned([closeIx]));
check('closing a smart wallet (its rent would go to the caller)', r.status >= 400 && /not sponsored/.test(r.error), r.error);
const tokenClose = [{ programAddress: address(V.TOKEN_PROGRAM), accounts: [{ address: walletUsdc, role: AccountRole.WRITABLE }, { address: thief, role: AccountRole.WRITABLE }, { address: wallet, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array([9]) }];
r = await post(await unsigned((await passkeySign(tokenClose)).ixs));
check('closing a token account inside Swig (rent recovery)', r.status >= 400, r.error);

console.log('\nThe read-and-send door');
const call = async (body) => { const x = await fetch(`${RELAY}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: x.status, ...(await x.json()) }; };
r = await call({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [V.VAULT_PROGRAM] });
check('scanning whole programs is not available', r.status === 403);
r = await call([{ jsonrpc: '2.0', id: 1, method: 'getSlot' }, { jsonrpc: '2.0', id: 2, method: 'getSlot' }]);
check('batches are refused', r.status === 400);
r = await call({ jsonrpc: '2.0', id: 1, method: 'getSlot' });
check('a normal read works', r.status === 200 && typeof r.result === 'number');
const ws = await fetch(`${RELAY}/rpc`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } }).then((x) => x.status).catch(() => 'closed');
check('websockets are refused', ws === 400 || ws === 'closed' || ws === 404, String(ws));
r = await fetch(`${RELAY}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(20_000) }).then((x) => x.status).catch(() => 'closed');
check('oversized bodies are refused', r === 413 || r === 'closed', String(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
