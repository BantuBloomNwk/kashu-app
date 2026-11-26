// Earning interest at the real mainnet rate: Jupiter Lend's mainnet USDC market and programs, copied into memory
// (scripts/juplend-mainnet-fixtures.mjs), with the mainnet builds of the vault and rooms programs. A saver lends 50
// dollars, a week passes, and the interest is harvested into the room's prize, paid to the winner, and taken home.
// Nothing here touches a network.
import { readFileSync, existsSync } from 'fs';
import { address, none, getAddressEncoder } from '@solana/kit';
import { getTokenEncoder } from '@solana-program/token';
import { makeWorld, USDC } from './lib/world.mjs';
import {
  LEND, TOKEN_PROGRAM, depositIx, harvestIx, initPrizeIx, lendIx, linkPotIx, openPotIx, openVaultIx, payPrizeIx, potUsdcPda,
  shareAccount, tokenExchangePrice, unlendIx, vaultAddresses, withdrawCashIx,
} from '../client/vault.mjs';
import { createRoomIx, joinRoomIx, openResultIx, resultPda, roomPda } from '../client/rooms.mjs';

const fixture = (n) => new URL(`./fixtures/${n}`, import.meta.url).pathname;
if (!existsSync(fixture('juplend_lending_mainnet.so'))) { console.log('run scripts/juplend-mainnet-fixtures.mjs first'); process.exit(1); }
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`); ok ? pass++ : fail++; };
const went = (label, r) => check(label, r.ok, r.ok ? '' : r.logs.slice(-1500));
const big = { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 };
const $ = (n) => `$${(Number(n) / 1e6).toFixed(6)}`;

const fx = JSON.parse(readFileSync(fixture('juplend-mainnet.json')));
const m = Object.fromEntries(Object.entries(fx.market).map(([k, v]) => [k, k === 'cluster' ? v : address(v)]));
const w = await makeWorld({ vaultSo: new URL('../target/deploy/vault.so', import.meta.url).pathname, usdcMint: m.mint });
for (const [a, acc] of Object.entries(fx.accounts)) {
  const data = new Uint8Array(Buffer.from(acc.data, 'base64'));
  w.svm.setAccount({ address: address(a), data, executable: false, programAddress: address(acc.owner), space: BigInt(data.length), lamports: BigInt(acc.lamports) });
}
w.svm.addProgramFromFile(LEND.mainnet.program, fixture('juplend_lending_mainnet.so'));
w.svm.addProgramFromFile(LEND.mainnet.liquidity, fixture('juplend_liquidity_mainnet.so'));
// the clock starts just after the market last moved (Jupiter refuses time going backwards)
const lending = () => Buffer.from(w.svm.getAccount(m.lending).data);
w.setTime(lending().readBigUInt64LE(123) + 60n);
await w.boot();
const emptyToken = (addr, mint, owner) => {
  const d = new Uint8Array(getTokenEncoder().encode({ mint, owner, amount: 0n, delegate: none(), state: 1, isNative: none(), delegatedAmount: 0n, closeAuthority: none() }));
  w.svm.setAccount({ address: addr, data: d, executable: false, programAddress: TOKEN_PROGRAM, space: BigInt(d.length), lamports: w.svm.minimumBalanceForRentExemption(BigInt(d.length)) });
};
async function saver(amount) {
  const p = await w.person();
  const usdc = await w.tokenAccount(m.mint, p.address, USDC(amount));
  await w.send(p, [await openVaultIx({ payer: p, owner: p, usdcMint: m.mint, assetMint: w.assetMint })]);
  await w.send(p, [await depositIx({ owner: p, from: usdc, usdcMint: m.mint, amount: USDC(amount) })]);
  const va = await vaultAddresses(p.address);
  emptyToken(await shareAccount(va.userVault, m.fTokenMint), m.fTokenMint, va.userVault);
  emptyToken(await shareAccount(va.userVault, m.mint), m.mint, va.userVault);
  return { p, va, usdc };
}

console.log(`\nJupiter Lend's mainnet USDC market, copied at slot ${fx.copiedAtSlot}`);
const treasury = await w.tokenAccount(m.mint, w.admin.address);
went('Kashu\'s cut set at 10%', await w.send(w.admin, [await initPrizeIx(w.admin, 1000)]));
const ada = await saver(50);
went('Ada saves 50 dollars and puts them to work on Jupiter Lend (mainnet market)', await w.send(ada.p, [await lendIx({ owner: ada.p, usdcMint: m.mint, market: m, amount: USDC(50) })], big));
went('Ada starts a room', await w.send(ada.p, [await createRoomIx({ creator: ada.p, roomId: 1n, name: 'Payday crew' })]));
const room = await roomPda(ada.p.address, 1n);
const keeper = await w.person();
went('the keeper opens its prize pot and draw result', await w.send(keeper, [await openPotIx({ payer: keeper, room, usdcMint: m.mint }), await openResultIx({ payer: keeper, room })]));
went('Ada joins and lets her interest feed the prize', await w.send(ada.p, [await joinRoomIx({ owner: ada.p, room, userVault: ada.va.userVault, session: keeper.address, sessionExpires: Number(w.now()) + 86400 * 30 }), await linkPotIx({ owner: ada.p, room })]));

console.log('\nA week at the real rate');
const p0 = tokenExchangePrice(w.svm.getAccount(m.lending).data);
w.setTime(w.now() + 7n * 86400n);
// any move on the market records the week's share price; here a newcomer lends a dollar
const bo = await saver(1);
went('a week later someone else lends a dollar (Jupiter records the new share price)', await w.send(bo.p, [await lendIx({ owner: bo.p, usdcMint: m.mint, market: m, amount: USDC(1) })], big));
const p1 = tokenExchangePrice(w.svm.getAccount(m.lending).data);
const weekly = Number(p1 - p0) / Number(p0);
console.log(`  share price ${p0} -> ${p1}: ${(weekly * 100).toFixed(4)}% this week, about ${(((1 + weekly) ** 52 - 1) * 100).toFixed(2)}% a year`);
check('the mainnet market paid interest over the week', p1 > p0);
const t0 = w.balance(treasury);
const h = await w.send(keeper, [await harvestIx({ cranker: keeper, owner: ada.p.address, room, treasury, usdcMint: m.mint, market: m })], big);
went('the keeper harvests Ada\'s week of interest into the prize', h);
const potUsdc = await potUsdcPda(room);
const toPot = w.balance(potUsdc), cut = w.balance(treasury) - t0;
console.log(`  Ada's week of interest on 50 dollars: ${$(toPot + cut)}; to the room's prize ${$(toPot)}, Kashu's 10% ${$(cut)}`);
check('real money reached the prize: more than a cent', toPot > 10_000n, $(toPot));
check('and Kashu took exactly a tenth of it', cut === (toPot + cut) / 10n, `${cut} of ${toPot + cut}`);
const v = await w.vault(ada.p.address);
check('Ada\'s 50 dollars are untouched', v.lentPrincipal === USDC(50));

console.log('\nFriday');
const at = await resultPda(room); const acc = w.svm.getAccount(at); const d = Buffer.from(acc.data);
// the draw's outcome as the rooms program writes it (VRF can't run offline)
d.writeUInt32LE(1, 40); d.set(new Uint8Array(getAddressEncoder().encode(ada.p.address)), 44);
w.svm.setAccount({ ...acc, address: at, data: new Uint8Array(d) });
went('the prize is paid to the week\'s winner (Ada)', await w.send(keeper, [await payPrizeIx({ cranker: keeper, room, winner: ada.p.address, usdcMint: m.mint })]));
check('it landed in her vault as her own savings', w.balance(ada.va.cash) === toPot, $(w.balance(ada.va.cash)));

console.log('\nTaking it all home');
const before = w.balance(ada.usdc);
went('Ada brings everything back from Jupiter Lend', await w.send(ada.p, [await unlendIx({ owner: ada.p, usdcMint: m.mint, market: m, amount: USDC(50) })], big));
const asset = await w.tokenAccount(w.assetMint, ada.p.address);
went('and takes everything out', await w.send(ada.p, [await withdrawCashIx({ owner: ada.p, ownerUsdc: ada.usdc, ownerAsset: asset, usdcMint: m.mint, assetMint: w.assetMint, amount: 18446744073709551615n })]));
const home = w.balance(ada.usdc) - before;
console.log(`  Ada took home ${$(home)}: her 50 dollars plus the prize`);
check('she took home her 50 dollars and the prize, with nothing lost', home >= USDC(50) + toPot - 2n, $(home));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
