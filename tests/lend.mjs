// Savings lent on Jupiter Lend, tested against Jupiter Lend's real programs and its devnet USDC market,
// copied into an in-memory chain (scripts/juplend-fixtures.mjs). Nothing here touches a network.
import { readFileSync } from 'fs';
import { address, none } from '@solana/kit';
import { getTokenEncoder } from '@solana-program/token';
import { makeWorld, USDC } from './lib/world.mjs';
import { LEND, TOKEN_PROGRAM, WEEK, depositIx, lendIx, openVaultIx, prepareBuyIx, setPausedIx, setRuleIx, shareAccount, thisWeekSpend, unlendIx, vaultAddresses, weeklyBuyIx, withdrawAssetIx, withdrawCashIx } from '../client/vault.mjs';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`); ok ? pass++ : fail++; };
const went = (label, r) => check(label, r.ok, r.ok ? '' : r.logs.slice(-1500));
const refused = (label, r, why) => check(label, !r.ok && r.logs.includes(why), r.ok ? 'it went through' : (r.logs.includes(why) ? '' : `wanted ${why}, got:\n${r.logs.slice(-800)}`));

const fx = JSON.parse(readFileSync(new URL('./fixtures/juplend-devnet.json', import.meta.url)));
const m = Object.fromEntries(Object.entries(fx.market).map(([k, v]) => [k, k === 'cluster' ? v : address(v)]));
const w = await makeWorld({ vaultSo: new URL('../target/deploy-devnet/vault.so', import.meta.url).pathname, usdcMint: m.mint });
for (const [addr, a] of Object.entries(fx.accounts)) {
  const data = new Uint8Array(Buffer.from(a.data, 'base64'));
  w.svm.setAccount({ address: address(addr), data, executable: false, programAddress: address(a.owner), space: BigInt(data.length), lamports: BigInt(a.lamports) });
}
w.svm.addProgramFromFile(LEND.devnet.program, new URL('./fixtures/juplend_lending.so', import.meta.url).pathname);
w.svm.addProgramFromFile(LEND.devnet.liquidity, new URL('./fixtures/juplend_liquidity.so', import.meta.url).pathname);
w.setTime(BigInt(Math.floor(Date.UTC(2026, 10, 23) / 1000)));
await w.boot();

console.log('\nSavings earn on Jupiter Lend (its real devnet program and market, in memory)');
const ada = await w.person();
const adaUsdc = await w.tokenAccount(m.mint, ada.address, USDC(40));
went('Ada opens her vault', await w.send(ada, [await openVaultIx({ payer: ada, owner: ada, usdcMint: m.mint, assetMint: w.assetMint })]));
went('and saves 30 dollars', await w.send(ada, [await depositIx({ owner: ada, from: adaUsdc, usdcMint: m.mint, amount: USDC(30) })]));
const va = await vaultAddresses(ada.address);
// the vault's own lending share account (its associated account for the share mint); anyone may create one
const shares = await shareAccount(va.userVault, m.fTokenMint);
const tok = new Uint8Array(getTokenEncoder().encode({ mint: m.fTokenMint, owner: va.userVault, amount: 0n, delegate: none(), state: 1, isNative: none(), delegatedAmount: 0n, closeAuthority: none() }));
w.svm.setAccount({ address: shares, data: tok, executable: false, programAddress: TOKEN_PROGRAM, space: BigInt(tok.length), lamports: w.svm.minimumBalanceForRentExemption(BigInt(tok.length)) });
// and its associated USDC account, which stages each move (Jupiter Lend takes associated accounts only)
const staging = await shareAccount(va.userVault, m.mint);
const tok2 = new Uint8Array(getTokenEncoder().encode({ mint: m.mint, owner: va.userVault, amount: 0n, delegate: none(), state: 1, isNative: none(), delegatedAmount: 0n, closeAuthority: none() }));
w.svm.setAccount({ address: staging, data: tok2, executable: false, programAddress: TOKEN_PROGRAM, space: BigInt(tok2.length), lamports: w.svm.minimumBalanceForRentExemption(BigInt(tok2.length)) });

const jupVault0 = w.balance(m.vault);
const args = (owner, amount, market = m) => ({ owner, usdcMint: m.mint, market, amount });
const lent = await w.send(ada, [await lendIx(args(ada, USDC(20)))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 });
went('Ada puts 20 dollars to work on Jupiter Lend', lent);
check('20 dollars left her cash', w.balance(va.cash) === USDC(10), `cash ${w.balance(va.cash)}`);
check('and arrived in Jupiter Lend\'s USDC vault', w.balance(m.vault) - jupVault0 === USDC(20));
check('her vault holds the lending shares itself', w.balance(shares) > 0n, `shares ${w.balance(shares)}`);
let v = await w.vault(ada.address);
check('staging is empty again', w.balance(staging) === 0n);
check('the vault records 20 lent and 10 in cash', v.lentPrincipal === USDC(20) && v.cashTracked === USDC(10), JSON.stringify({ lent: String(v.lentPrincipal), cash: String(v.cashTracked) }));

refused('she cannot lend more than her tracked dollars', await w.send(ada, [await lendIx(args(ada, USDC(11)))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }), 'Insufficient');
const fakeMarket = { ...m, lending: m.supplyPosition };
refused('a look-alike market is refused', await w.send(ada, [await lendIx(args(ada, USDC(1), fakeMarket))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }), 'WrongVenue');
const mallory = await w.person();
refused('Mallory cannot move Ada\'s savings', await w.send(mallory, [await lendIx(args(mallory, USDC(1)))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }), 'AccountNotInitialized');
refused('the caps count money in lending: 21 more would pass 50', await w.send(ada, [await depositIx({ owner: ada, from: adaUsdc, usdcMint: m.mint, amount: USDC(21) })]), 'UserCap');

w.setTime(w.now() + 30n * 86400n);
went('the admin pauses the vault', await w.send(w.admin, [await setPausedIx(w.admin, true)]));
refused('nothing new can be lent while paused', await w.send(ada, [await lendIx(args(ada, USDC(1)))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }), 'Paused');
const back = await w.send(ada, [await unlendIx(args(ada, USDC(20)))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 });
went('but Ada brings her 20 dollars back even while paused', back);
// bringing back everything hands back every share, so it comes with the interest a month earned
const earned = w.balance(va.cash) - USDC(30);
check('all 30 dollars are in her cash again, plus the month\'s interest', earned > 0n, `cash ${w.balance(va.cash)}`);
v = await w.vault(ada.address);
check('nothing is recorded as lent any more, and the interest counts as hers', v.lentPrincipal === 0n && v.cashTracked === USDC(30) + earned);
const adaAsset = await w.tokenAccount(w.assetMint, ada.address);
went('the admin lifts the pause', await w.send(w.admin, [await setPausedIx(w.admin, false)]));

console.log('\nThe weekly buy uses savings that are lent');
went('Ada\'s rule: 10 dollars a week, half into the asset', await w.send(ada, [await setRuleIx(ada, { weeklyAmount: USDC(10), roundupUnit: 0n, assetBps: 5000 })]));
went('she lends all 30', await w.send(ada, [await lendIx(args(ada, USDC(30)))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }));
w.setTime(w.now() + WEEK);
const crank = await w.person();
const buyNow = async () => { w.setPrice(); await w.swapAccounts(ada.address, m.mint); return w.send(crank, [await weeklyBuyIx({ cranker: crank, owner: ada.address, usdcMint: m.mint, assetMint: w.assetMint, priceUpdate: w.priceFeed, amountIn: thisWeekSpend(await w.vault(ada.address)) })]); };
refused('the buy waits while the 5 dollars it needs are lent', await buyNow(), 'SavingsStillLent');
went('a stranger brings back exactly the shortfall', await w.send(crank, [await prepareBuyIx({ cranker: crank, owner: ada.address, usdcMint: m.mint, market: m })], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }));
v = await w.vault(ada.address);
check('the shortfall came back: 5 in cash, the rest still lent', v.cashTracked === USDC(5) && v.lentPrincipal === USDC(25) + earned, JSON.stringify({ cash: String(v.cashTracked), lent: String(v.lentPrincipal) }));
refused('and nothing more can be pulled for it', await w.send(crank, [await prepareBuyIx({ cranker: crank, owner: ada.address, usdcMint: m.mint, market: m })], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }), 'NothingToBuy');
went('the weekly buy goes through', await buyNow());
check('5 dollars of the asset at the oracle price', w.balance(va.hold) === 25_000_000n, `hold ${w.balance(va.hold)}`);
went('Ada brings the rest back', await w.send(ada, [await unlendIx(args(ada, USDC(25)))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }));
went('and takes her asset home', await w.send(ada, [await withdrawAssetIx({ owner: ada, ownerUsdc: adaUsdc, ownerAsset: adaAsset, usdcMint: m.mint, assetMint: w.assetMint, amount: 25_000_000n })]));
went('and her dollars', await w.send(ada, [await withdrawCashIx({ owner: ada, ownerUsdc: adaUsdc, ownerAsset: adaAsset, usdcMint: m.mint, assetMint: w.assetMint, amount: USDC(25) })]));

console.log('\nBringing everything back after a partial withdrawal');
{
  const bo = await w.person();
  const boUsdc = await w.tokenAccount(m.mint, bo.address, USDC(40));
  await w.send(bo, [await openVaultIx({ payer: bo, owner: bo, usdcMint: m.mint, assetMint: w.assetMint })]);
  await w.send(bo, [await depositIx({ owner: bo, from: boUsdc, usdcMint: m.mint, amount: USDC(30) })]);
  const bva = await vaultAddresses(bo.address);
  for (const mint of [m.fTokenMint, m.mint]) {
    const t = new Uint8Array(getTokenEncoder().encode({ mint, owner: bva.userVault, amount: 0n, delegate: none(), state: 1, isNative: none(), delegatedAmount: 0n, closeAuthority: none() }));
    w.svm.setAccount({ address: await shareAccount(bva.userVault, mint), data: t, executable: false, programAddress: TOKEN_PROGRAM, space: BigInt(t.length), lamports: w.svm.minimumBalanceForRentExemption(BigInt(t.length)) });
  }
  went('Bo lends 30', await w.send(bo, [await lendIx(args(bo, USDC(30)))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }));
  // straight after lending, as the weekly buy's prepare_buy does: no interest yet to cover Jupiter's rounding
  went('brings back an odd amount, 7.123457', await w.send(bo, [await unlendIx(args(bo, 7_123_457n))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 }));
  const left = (await w.vault(bo.address)).lentPrincipal;
  const all = await w.send(bo, [await unlendIx(args(bo, left))], { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 });
  went(`then asks for everything still lent (${Number(left) / 1e6}) and gets it`, all);
  const bv = await w.vault(bo.address);
  check('nothing is recorded as lent afterwards', bv.lentPrincipal === 0n, `lent ${bv.lentPrincipal}`);
  check('and at most two units of rounding were left behind', bv.cashTracked >= USDC(30) - 2n, `cash ${bv.cashTracked}`);
  const boAsset = await w.tokenAccount(w.assetMint, bo.address);
  const before = w.balance(boUsdc);
  went('and takes every last unit out by asking for everything', await w.send(bo, [await withdrawCashIx({ owner: bo, ownerUsdc: boUsdc, ownerAsset: boAsset, usdcMint: m.mint, assetMint: w.assetMint, amount: 18446744073709551615n })]));
  check('the vault\'s cash is empty and it all reached Bo', w.balance(bva.cash) === 0n && w.balance(boUsdc) - before === bv.cashTracked && (await w.vault(bo.address)).cashTracked === 0n);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
