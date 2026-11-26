// What a saver sees before Face ID: Kashu's real instructions, built by the client, read back through the
// signing review (@readback/review). No network.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { address, generateKeyPairSigner } from '@solana/kit';
import { review, oneSigning, PROGRAMS } from '@readback/review';
import { KASHU_DECODERS, DISC } from '../client/review.mjs';
import * as V from '../client/vault.mjs';
import { createRoomIx, joinRoomIx, roomPda } from '../client/rooms.mjs';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`); ok ? pass++ : fail++; };
const fx = JSON.parse(readFileSync(new URL('./fixtures/juplend-devnet.json', import.meta.url)));
const market = Object.fromEntries(Object.entries(fx.market).map(([k, v]) => [k, k === 'cluster' ? v : address(v)]));
const USDC = market.mint, WSOL = address('So11111111111111111111111111111111111111112');
const allow = [V.VAULT_PROGRAM, V.ROOMS_PROGRAM, PROGRAMS.TOKEN, PROGRAMS.ATA, PROGRAMS.SYSTEM, PROGRAMS.COMPUTE];
const me = await generateKeyPairSigner(), stranger = await generateKeyPairSigner();
const va = await V.vaultAddresses(me.address);
const myUsdc = (await generateKeyPairSigner()).address, theirUsdc = (await generateKeyPairSigner()).address, myAsset = (await generateKeyPairSigner()).address;
const opts = { allow, programs: KASHU_DECODERS, mine: [myUsdc, myAsset], names: { [myUsdc]: 'your wallet' } };
const read = async (ixs) => review(ixs, opts);

console.log('\nThe instruction table');
const bad = Object.entries(DISC).filter(([n, h]) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8).toString('hex') !== h);
check(`all ${Object.keys(DISC).length} precomputed instruction tags match their names`, bad.length === 0, bad.map(([n]) => n).join(', '));

console.log('\nEveryday actions read plainly');
let r = await read([await V.openVaultIx({ payer: me, owner: me, usdcMint: USDC, assetMint: WSOL }), await V.depositIx({ owner: me, from: myUsdc, usdcMint: USDC, amount: 5_000_000n })]);
check('opening a vault and saving 5 dollars', !r.blocked && r.lines.map((l) => l.text).join(' / ') === 'Open your savings vault (only you can take money out of it) / Save 5 USDC into your vault', r.lines.map((l) => l.text).join(' / '));
r = await read([await V.setRuleIx(me, { weeklyAmount: 10_000_000n, roundupUnit: 0n, assetBps: 2500 })]);
check('a weekly plan says whether payments round up', r.lines[0].text === 'Set your plan: 10 USDC a week, 25% of it into SOL, no round-ups', r.lines[0].text);
r = await read([await V.setRuleIx(me, { weeklyAmount: 10_000_000n, roundupUnit: 1_000_000n, assetBps: 0 })]);
check('and turning round-ups on says so', r.lines[0].text === 'Set your plan: 10 USDC a week, 0% of it into SOL, payments rounded up to the next 1 USDC with the change saved', r.lines[0].text);
r = await read([await V.lendIx({ owner: me, usdcMint: USDC, market, amount: 20_000_000n })]);
check('lending says the money stays in the vault', /20 USDC of your savings to work on Jupiter Lend\. It stays in your vault/.test(r.lines[0].text), r.lines[0].text);
const room = await roomPda(me.address, 1n);
r = await read([await V.linkPotIx({ owner: me, room })]);
check('joining the prize names Kashu\'s 10% and says savings never go in', /Kashu keeps 10% of it\)\. Your savings never go in/.test(r.lines[0].text), r.lines[0].text);
r = await read([await createRoomIx({ creator: me, roomId: 7n, name: 'Payday crew' }), await joinRoomIx({ owner: me, room, userVault: va.userVault, session: me.address, sessionExpires: Date.UTC(2026, 11, 1) / 1000 })]);
check('starting and joining a room by name', r.lines[0].text === 'Start the room "Payday crew"' && /Join this room, and let .* count your saves in it until .* \(it can't move money\)/.test(r.lines[1].text), r.lines.map((l) => l.text).join(' / '));

console.log('\nTaking money out');
const out = (to) => V.withdrawCashIx({ owner: me, ownerUsdc: to, ownerAsset: myAsset, usdcMint: USDC, assetMint: WSOL, amount: 3_000_000n });
r = await read([await out(myUsdc)]);
check('to your own wallet reads calmly', r.lines[0].tone === 'info' && r.lines[0].text === 'Take 3 USDC out of your vault to your wallet', r.lines[0].text);
r = await read([await out(theirUsdc)]);
check('to anyone else is danger', r.lines[0].tone === 'danger', r.lines[0].text);

console.log('\nWhat a saver must never sign');
r = await read([await V.setPausedIx(stranger, true)]);
check('an admin action is flagged: Kashu never asks a saver to sign one', r.lines[0].tone === 'danger' && /never asks a saver/.test(r.lines[0].text), r.lines[0].text);
r = await read([await V.depositIx({ owner: me, from: myUsdc, usdcMint: USDC, amount: 1n }), { programAddress: (await generateKeyPairSigner()).address, accounts: [], data: new Uint8Array([9]) }]);
check('a deposit with a stranger\'s program tacked on is blocked', r.blocked && r.lines[0].tone === 'danger');

console.log('\nThe passkey signs only what was reviewed');
const ixs = [await V.depositIx({ owner: me, from: myUsdc, usdcMint: USDC, amount: 5_000_000n })];
r = await read(ixs);
let asked = 0;
const passkey = async () => { asked++; return { signature: new Uint8Array(64) }; };
const signer = oneSigning(passkey, r.seal, ixs);
ixs[0] = await V.depositIx({ owner: me, from: theirUsdc, usdcMint: USDC, amount: 5_000_000n });
const e = await signer(new Uint8Array(32)).catch((x) => x);
check('swapping the instruction after approval stops the passkey prompt', e instanceof Error && asked === 0, String(e?.message));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
