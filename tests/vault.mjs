// Proves the things the README promises: the caps hold, only the owner can take money out and
// only to themselves, and the person pressing the weekly button can change nothing about it.
//
//   npm run build && npm test

import {
  STUB_SWAP_PROGRAM, TOKEN_PROGRAM, WEEK, acceptAdminIx, depositIx, initPoolIx, initializeIx, mixPercent, noteSpendIx,
  openVaultIx, poolAddresses, proposeAdminIx, setCapsIx, setFloorRateIx, setPausedIx, setRuleIx, vaultAddresses,
  setVenueIx, thisWeekSpend, weeklyBuyIx, withdrawAssetIx, withdrawCashIx, enrollPqIx, rotateMessage, rotatePqIx, withdrawMessage, withdrawPqIx,
} from '../client/vault.mjs';
import { keyTree } from '../client/wots.mjs';
import { USDC, makeWorld } from './lib/world.mjs';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`); ok ? pass++ : fail++; };
const section = (s) => console.log(`\n${s}`);
/** The transaction must fail, and for the reason we expect. */
const refused = (label, r, why) => check(label, !r.ok && r.logs.includes(why), r.ok ? 'it went through' : (r.logs.includes(why) ? '' : `wanted ${why}, got:\n${r.logs}`));
const went = (label, r, extra = '') => check(label, r.ok, r.ok ? extra : r.logs);

/** A user with a wallet holding dollars, an empty asset account and an open vault. */
async function user(w, dollars = 200) {
  const s = await w.person();
  const u = { signer: s, address: s.address, usdc: await w.tokenAccount(w.usdcMint, s.address, USDC(dollars)), asset: await w.tokenAccount(w.assetMint, s.address), ...(await vaultAddresses(s.address)) };
  const r = await w.send(s, [await openVaultIx({ payer: s, owner: s, usdcMint: w.usdcMint, assetMint: w.assetMint })]);
  if (!r.ok) throw new Error('open_vault failed\n' + r.logs);
  return u;
}
const dep = async (w, u, n) => w.send(u.signer, [await depositIx({ owner: u.signer, from: u.usdc, usdcMint: w.usdcMint, amount: USDC(n) })]);
/** The weekly button: a fresh price, and a route for exactly the rule's spend (the way the weekly job builds it). */
const buy = async (w, cranker, u, overrides = {}) => {
  w.setPrice();
  await w.swapAccounts(u.address);
  const amountIn = (await w.vault(u.address).catch(() => null)) ? thisWeekSpend(await w.vault(u.address)) : 0n;
  return w.send(cranker, [await weeklyBuyIx({ cranker, owner: u.address, usdcMint: w.usdcMint, assetMint: w.assetMint, priceUpdate: w.priceFeed, amountIn, overrides })]);
};
const wd = (u, w, amount, extra = {}) => ({ owner: u.signer, ownerUsdc: u.usdc, ownerAsset: u.asset, usdcMint: w.usdcMint, assetMint: w.assetMint, amount, ...extra });

// ---------------------------------------------------------------------------------------------
section('Setting up');
{
  const w = await makeWorld();
  const stranger = await w.person();
  refused('a stranger cannot set the program up', await w.send(stranger, [await initializeIx({ admin: stranger, usdcMint: w.usdcMint, assetMint: w.assetMint, perUserCap: USDC(50), totalCap: USDC(5000), floorRate: 1n })]), 'NotUpgradeAuthority');
  refused('caps above 50 per user are refused at setup', await w.send(w.admin, [await initializeIx({ admin: w.admin, usdcMint: w.usdcMint, assetMint: w.assetMint, perUserCap: USDC(50) + 1n, totalCap: USDC(5000), floorRate: 1n })]), 'CapTooHigh');
  refused('caps above 5,000 in total are refused at setup', await w.send(w.admin, [await initializeIx({ admin: w.admin, usdcMint: w.usdcMint, assetMint: w.assetMint, perUserCap: USDC(50), totalCap: USDC(5000) + 1n, floorRate: 1n })]), 'CapTooHigh');
  const badMint = await w.mint(9);
  refused('a dollar token without 6 decimals is refused', await w.send(w.admin, [await initializeIx({ admin: w.admin, usdcMint: badMint, assetMint: w.assetMint, perUserCap: USDC(50), totalCap: USDC(5000), floorRate: 1n })]), 'BadDecimals');
  await w.boot();
  refused('it cannot be set up twice', await w.send(w.admin, [await initializeIx({ admin: w.admin, usdcMint: w.usdcMint, assetMint: w.assetMint, perUserCap: USDC(1), totalCap: USDC(1), floorRate: 1n })]), 'already in use');
}

// ---------------------------------------------------------------------------------------------
const w = await makeWorld();
await w.boot();
const alice = await user(w), bob = await user(w), mallory = await user(w);
const cranker = await w.person();

section('Caps');
{
  went('alice deposits 30', await dep(w, alice, 30));
  refused('21 more would pass 50, refused', await dep(w, alice, 21), 'UserCap');
  went('20 more lands exactly on 50', await dep(w, alice, 20));
  refused('one cent more is refused', await dep(w, alice, 0.01), 'UserCap');
  check('each deposit of a dollar or more counts as a save in her room', (await w.vault(alice.address)).buysDone === 2);
  check('her vault holds 50 and the program counts 50', w.balance(alice.cash) === USDC(50) && (await w.config()).totalPrincipal === USDC(50));

  refused('the admin cannot raise the per-user cap past 50', await w.send(w.admin, [await setCapsIx(w.admin, USDC(51), USDC(5000))]), 'CapTooHigh');
  refused('the admin cannot raise the total cap past 5,000', await w.send(w.admin, [await setCapsIx(w.admin, USDC(50), USDC(5001))]), 'CapTooHigh');
  refused('a stranger cannot change caps', await w.send(mallory.signer, [await setCapsIx(mallory.signer, USDC(1), USDC(1))]), 'NotAdmin');

  went('admin lowers the total cap to 60', await w.send(w.admin, [await setCapsIx(w.admin, USDC(50), USDC(60))]));
  refused('bob depositing 11 would pass the total, refused', await dep(w, bob, 11), 'TotalCap');
  went('bob depositing 10 fits', await dep(w, bob, 10));
  went('admin restores the total cap', await w.send(w.admin, [await setCapsIx(w.admin, USDC(50), USDC(5000))]));

  // Tokens can always be sent to any token account. They must not become managed money.
  w.gift(alice.cash, USDC(500));
  const v = await w.vault(alice.address);
  check('500 sent straight to her cash account is not counted', v.cashTracked === USDC(50) && w.balance(alice.cash) === USDC(550));
}

section('Rules');
{
  went('alice sets: 10 a week, round up to the dollar, 60% into the asset', await w.send(alice.signer, [await setRuleIx(alice.signer, { weeklyAmount: USDC(10), roundupUnit: USDC(1), assetBps: 6000 })]));
  await w.send(alice.signer, [await noteSpendIx(alice.signer, USDC(3.4))]);
  await w.send(alice.signer, [await noteSpendIx(alice.signer, USDC(7))]);
  check('a 3.40 spend adds 0.60 of change, a 7.00 spend adds none', (await w.vault(alice.address)).pendingRoundup === USDC(0.6));
  refused('a mix over 100% is refused', await w.send(alice.signer, [await setRuleIx(alice.signer, { weeklyAmount: USDC(10), roundupUnit: 0n, assetBps: 10001 })]), 'BadMix');
  // Mallory signs, but points the instruction at alice's vault.
  const ix = await setRuleIx(mallory.signer, { weeklyAmount: 0n, roundupUnit: 0n, assetBps: 10000 });
  ix.accounts[1] = { ...ix.accounts[1], address: alice.userVault };
  refused('mallory cannot set alice\'s rule', await w.send(mallory.signer, [ix]), 'ConstraintSeeds');
}

section('The weekly button');
{
  refused('pressing it early is refused', await buy(w, cranker, alice), 'NotDue');
  w.setTime(w.now() + WEEK);

  const other = await w.mint(9);
  const otherPool = await poolAddresses(w.usdcMint, other);
  await w.send(w.admin, [await initPoolIx({ payer: w.admin, usdcMint: w.usdcMint, assetMint: other, rate: 5_000_000_000n })]);
  w.gift(otherPool.poolAsset, 1_000_000_000_000n);
  const malloryOther = await w.tokenAccount(other, mallory.address);

  refused('cannot send the buy to someone else\'s account', await buy(w, mallory.signer, alice, { hold: mallory.asset }), 'ConstraintSeeds');
  refused('cannot send the buy to another user\'s vault', await buy(w, mallory.signer, alice, { hold: mallory.hold }), 'ConstraintSeeds');
  refused('cannot spend another user\'s dollars', await buy(w, mallory.signer, alice, { cash: bob.cash }), 'ConstraintSeeds');
  refused('cannot buy a token that is not on the menu', await buy(w, mallory.signer, alice, { assetMint: other, ...otherPool }), 'ConstraintTokenMint');
  refused('nor buy it into an account made for it', await buy(w, mallory.signer, alice, { assetMint: other, hold: malloryOther, ...otherPool }), 'ConstraintSeeds');
  refused('cannot route through another program', await buy(w, mallory.signer, alice, { swapProgram: TOKEN_PROGRAM }), 'ConstraintAddress');
  refused('cannot pass the vault\'s own record into the route', await buy(w, mallory.signer, alice, { pool: alice.userVault }), 'SwapAccountClash');
  refused('a route may not touch the vault\'s cash', await buy(w, mallory.signer, alice, { poolUsdc: alice.cash }), 'SwapAccountClash');
  refused('nor its holding account', await buy(w, mallory.signer, alice, { routeDestination: alice.hold }), 'SwapAccountClash');
  refused('a price account that is not a genuine Pyth update is refused', await buy(w, mallory.signer, alice, { priceUpdate: mallory.asset }), 'BadPrice');
  refused('cannot use a pool for a different pair', await buy(w, mallory.signer, alice, otherPool), 'Constraint');
  // her two deposits (30 and 20) are her two saves so far; a refused buy adds none
  check('none of those moved a cent', w.balance(alice.cash) === USDC(550) && w.balance(alice.hold) === 0n && (await w.vault(alice.address)).buysDone === 2);

  const poolBefore = w.balance(w.pool.poolUsdc);
  const r = await buy(w, cranker, alice);
  went('a stranger presses it when due and it goes through', r, `${r.units} compute units`);
  const v = await w.vault(alice.address);
  // Budget is 10 + 0.60 of round-ups. 60% of that is 6.36 dollars, at 0.005 of the asset per dollar.
  check('it spent exactly 6.36, the rule and nothing else', USDC(550) - w.balance(alice.cash) === USDC(6.36) && w.balance(w.pool.poolUsdc) - poolBefore === USDC(6.36));
  check('the asset landed in her own holding account', w.balance(alice.hold) === 31_800_000n);
  check('books match: 43.64 in dollars, 6.36 at work, round-ups cleared', v.cashTracked === USDC(43.64) && v.assetBasis === USDC(6.36) && v.pendingRoundup === 0n && v.buysDone === 3);
  check('the lent spending right is gone afterwards', w.token(alice.cash).delegate.__option === 'None' && w.token(alice.cash).delegatedAmount === 0n);
  check('caps still count the same 60 in total', (await w.config()).totalPrincipal === USDC(60));
  refused('pressing it again the same week is refused', await buy(w, cranker, alice), 'NotDue');
  refused('bob has no rule, so there is nothing to buy', await buy(w, cranker, bob), 'NothingToBuy');
  const m = mixPercent({ cashAmount: v.cashTracked, assetAmount: w.balance(alice.hold), rate: w.rate });
  check('what friends may see is the mix in percent only', m.dollars === 87 && m.asset === 13, `${m.dollars}% dollars, ${m.asset}% asset`);
}

section('Pause');
{
  refused('a stranger cannot pause', await w.send(mallory.signer, [await setPausedIx(mallory.signer, true)]), 'NotAdmin');
  went('admin pauses', await w.send(w.admin, [await setPausedIx(w.admin, true)]));
  refused('deposits stop', await dep(w, bob, 1), 'Paused');
  w.setTime(w.now() + WEEK);
  refused('weekly buys stop', await buy(w, cranker, alice), 'Paused');
  went('withdrawals still work while paused', await w.send(bob.signer, [await withdrawCashIx(wd(bob, w, USDC(1)))]));
  went('admin unpauses', await w.send(w.admin, [await setPausedIx(w.admin, false)]));
}

section('Withdrawals');
{
  // Mallory signs and names her own token accounts, but points at alice's vault.
  refused('mallory cannot withdraw alice\'s dollars', await w.send(mallory.signer, [await withdrawCashIx(wd(mallory, w, USDC(1), { vaultOf: alice.address }))]), 'ConstraintSeeds');
  refused('mallory cannot withdraw alice\'s asset', await w.send(mallory.signer, [await withdrawAssetIx(wd(mallory, w, 1n, { vaultOf: alice.address }))]), 'ConstraintSeeds');
  // Alice signs (say she was tricked), but the destination belongs to mallory.
  refused('even alice cannot send dollars to an account she does not own', await w.send(alice.signer, [await withdrawCashIx(wd(alice, w, USDC(1), { ownerUsdc: mallory.usdc }))]), 'ConstraintTokenOwner');
  refused('nor the asset', await w.send(alice.signer, [await withdrawAssetIx(wd(alice, w, 1n, { ownerAsset: mallory.asset }))]), 'ConstraintTokenOwner');
  refused('the admin has no way in either', await w.send(w.admin, [await withdrawCashIx({ owner: w.admin, ownerUsdc: mallory.usdc, ownerAsset: mallory.asset, usdcMint: w.usdcMint, assetMint: w.assetMint, amount: 1n, vaultOf: alice.address })]), 'ConstraintSeeds');
  refused('cannot withdraw more than is there', await w.send(alice.signer, [await withdrawCashIx(wd(alice, w, USDC(1000)))]), 'Insufficient');

  const before = w.balance(alice.usdc);
  went('alice takes back the 500 that was sent to her vault directly', await w.send(alice.signer, [await withdrawCashIx(wd(alice, w, USDC(500)))]));
  check('her tracked dollars did not change', (await w.vault(alice.address)).cashTracked === USDC(43.64) && w.balance(alice.usdc) - before === USDC(500));
  went('alice withdraws 10 dollars', await w.send(alice.signer, [await withdrawCashIx(wd(alice, w, USDC(10)))]));
  check('tracked dollars and the total both drop by 10', (await w.vault(alice.address)).cashTracked === USDC(33.64) && (await w.config()).totalPrincipal === USDC(49));
  went('alice withdraws half the asset', await w.send(alice.signer, [await withdrawAssetIx(wd(alice, w, 15_900_000n))]));
  check('half the cost comes off her books', (await w.vault(alice.address)).assetBasis === USDC(3.18) && w.balance(alice.asset) === 15_900_000n);
  went('alice withdraws the rest', await w.send(alice.signer, [await withdrawAssetIx(wd(alice, w, 15_900_000n))]));
  check('nothing left at work, and the room under her cap is back', (await w.vault(alice.address)).assetBasis === 0n && (await w.config()).totalPrincipal === USDC(42.64));
  went('so she can deposit again up to 50', await dep(w, alice, 16.36));
  refused('and not a cent past it', await dep(w, alice, 0.01), 'UserCap');
}

section('Admin handover');
{
  went('admin names a new admin', await w.send(w.admin, [await proposeAdminIx(w.admin, bob.address)]));
  refused('someone else cannot accept', await w.send(mallory.signer, [await acceptAdminIx(mallory.signer)]), 'NotPendingAdmin');
  went('the named one accepts', await w.send(bob.signer, [await acceptAdminIx(bob.signer)]));
  refused('the old admin is out', await w.send(w.admin, [await setPausedIx(w.admin, true)]), 'NotAdmin');
}

// ---------------------------------------------------------------------------------------------
section('A hostile venue');
async function hostile(opts) {
  const h = await makeWorld();
  await h.boot(opts);
  const u = await user(h);
  await dep(h, u, 50);
  await h.send(u.signer, [await setRuleIx(u.signer, { weeklyAmount: USDC(10), roundupUnit: 0n, assetBps: 10000 })]);
  h.setTime(h.now() + WEEK);
  return { h, u, c: await h.person() };
}
{
  const { h, u, c } = await hostile({ mode: 1 });
  refused('a venue that tries to take one unit more is stopped', await buy(h, c, u), 'insufficient funds');
  check('and nothing moved', h.balance(u.cash) === USDC(50) && h.balance(u.hold) === 0n && (await h.vault(u.address)).buysDone === 1);
}
{
  const { h, u, c } = await hostile({ mode: 2 });
  refused('a venue that pays less than the floor is stopped', await buy(h, c, u), 'SwapPaidTooLittle');
  check('and nothing moved', h.balance(u.cash) === USDC(50) && h.balance(u.hold) === 0n);
}
{
  const { h, u, c } = await hostile({ rate: 4_000_000_000n });
  refused('an honest venue priced under the oracle is refused', await buy(h, c, u), 'SwapPaidTooLittle');
  refused('a stranger cannot lower the floor to let it through', await h.send(c, [await setFloorRateIx(c, 1n)]), 'NotAdmin');
}

// ---------------------------------------------------------------------------------------------
section('The price and the venue');
{
  const { h, u, c } = await hostile({});
  h.priceOpts = { age: 121 };
  refused('a price older than two minutes is refused', await buy(h, c, u), 'StalePrice');
  h.priceOpts = { conf: 500_000_000n };
  refused('a price with a wide confidence band (2.5%) is refused', await buy(h, c, u), 'UnsurePrice');
  h.priceOpts = { feedId: new Uint8Array(32).fill(9) };
  refused('a price for another feed is refused', await buy(h, c, u), 'BadPrice');
  h.priceOpts = { price: 16_000_000_000n };
  refused('if the asset gets cheaper, the venue must pay more of it: at $160 the $200 venue is refused', await buy(h, c, u), 'SwapPaidTooLittle');
  h.priceOpts = {};
  went('a fresh, narrow price for the right feed goes through', await buy(h, c, u));
  check('it bought 10 dollars of the asset at the oracle price', h.balance(u.hold) === 50_000_000n);
  refused('the venue is set once: setting it again is refused', await h.send(h.admin, [await setVenueIx({ admin: h.admin, swapProgram: TOKEN_PROGRAM, priceFeed: h.priceFeed, feedId: h.feedId })]), 'already in use');
}
{
  const h = await makeWorld();
  await h.send(h.admin, [await initializeIx({ admin: h.admin, usdcMint: h.usdcMint, assetMint: h.assetMint, perUserCap: USDC(50), totalCap: USDC(5000), floorRate: 1n })]);
  const s = await h.person();
  refused('only the admin names the venue', await h.send(s, [await setVenueIx({ admin: s, swapProgram: STUB_SWAP_PROGRAM, priceFeed: s.address, feedId: new Uint8Array(32) })]), 'NotAdmin');
  refused('slippage past 3% is refused', await h.send(h.admin, [await setVenueIx({ admin: h.admin, swapProgram: STUB_SWAP_PROGRAM, priceFeed: s.address, feedId: new Uint8Array(32), slippageBps: 301 })]), 'BadVenueBounds');
  refused('a price allowed to be over 5 minutes old is refused', await h.send(h.admin, [await setVenueIx({ admin: h.admin, swapProgram: STUB_SWAP_PROGRAM, priceFeed: s.address, feedId: new Uint8Array(32), maxAgeSecs: 301 })]), 'BadVenueBounds');
}

// ---------------------------------------------------------------------------------------------
section('The hash-based withdrawal key');
{
  const h = await makeWorld();
  await h.boot();
  const u = await user(h), thief = await user(h), relayer = await h.person();
  await dep(h, u, 50);
  await h.send(u.signer, [await setRuleIx(u.signer, { weeklyAmount: USDC(10), roundupUnit: 0n, assetBps: 5000 })]);
  h.setTime(h.now() + WEEK);
  await buy(h, relayer, u);

  const HEIGHT = 4;
  const tree = keyTree(HEIGHT);
  // A fresh address the owner's everyday key has nothing to do with.
  const safe = await h.person();
  const safeUsdc = await h.tokenAccount(h.usdcMint, safe.address), safeAsset = await h.tokenAccount(h.assetMint, safe.address);
  const signed = (leaf, { isCash = true, amount, destination, by = tree }) => {
    const { sig, path } = by.sign(leaf, withdrawMessage({ userVault: u.userVault, leaf, mint: isCash ? h.usdcMint : h.assetMint, amount, destination }));
    return { relayer, owner: u.address, destination, usdcMint: h.usdcMint, assetMint: h.assetMint, isCash, amount, leaf, sig, path };
  };
  const v1 = { version: 1 };

  refused('before a key is enrolled the hash-based path is closed', await h.send(relayer, [await withdrawPqIx(signed(0, { amount: USDC(1), destination: safeUsdc }))], v1), 'PqNotEnrolled');
  refused('a stranger cannot enrol a key on her vault', await (async () => { const ix = await enrollPqIx(thief.signer, { seed: tree.seed, root: tree.root, height: HEIGHT }); ix.accounts[1] = { ...ix.accounts[1], address: u.userVault }; return h.send(thief.signer, [ix]); })(), 'ConstraintSeeds');
  went('the owner enrols a tree of 16 one-time keys', await h.send(u.signer, [await enrollPqIx(u.signer, { seed: tree.seed, root: tree.root, height: HEIGHT })]));
  refused('it cannot be enrolled over', await h.send(u.signer, [await enrollPqIx(u.signer, { seed: tree.seed, root: keyTree(1).root, height: 1 })]), 'PqAlreadyEnrolled');

  // From here on, pretend the owner's everyday key is fully in the thief's hands.
  refused('the everyday key alone can no longer withdraw dollars', await h.send(u.signer, [await withdrawCashIx(wd(u, h, USDC(1)))]), 'PqRequired');
  refused('nor the asset', await h.send(u.signer, [await withdrawAssetIx(wd(u, h, 1n))]), 'PqRequired');

  const good = signed(0, { amount: USDC(5), destination: safeUsdc });
  refused('a signed withdrawal cannot be pointed at another account', await h.send(thief.signer, [await withdrawPqIx({ ...good, relayer: thief.signer, destination: thief.usdc })], v1), 'BadPqSignature');
  refused('nor have its amount changed', await h.send(thief.signer, [await withdrawPqIx({ ...good, relayer: thief.signer, amount: USDC(45) })], v1), 'BadPqSignature');
  refused('nor be turned into a withdrawal of the asset', await h.send(thief.signer, [await withdrawPqIx({ ...good, relayer: thief.signer, isCash: false, destination: safeAsset })], v1), 'BadPqSignature');
  refused('a signature from somebody else\'s tree fails', await h.send(relayer, [await withdrawPqIx(signed(0, { amount: USDC(5), destination: thief.usdc, by: keyTree(HEIGHT) }))], v1), 'BadPqSignature');

  const r = await h.send(relayer, [await withdrawPqIx(good)], v1);
  went('the real one goes through, delivered by a stranger', r, `${r.units} compute units, ${h.lastSize} bytes`);
  check('5 dollars reached the named account and the books followed', h.balance(safeUsdc) === USDC(5) && (await h.vault(u.address)).cashTracked === USDC(40) && (await h.config()).totalPrincipal === USDC(45));
  refused('the same signature cannot be used twice', await h.send(thief.signer, [await withdrawPqIx({ ...good, relayer: thief.signer })], v1), 'PqLeafUsed');
  refused('a used key number cannot sign something new', await h.send(relayer, [await withdrawPqIx(signed(0, { amount: USDC(1), destination: safeUsdc }))], v1), 'PqLeafUsed');
  went('key numbers may be skipped: number 3 withdraws all of the asset', await h.send(relayer, [await withdrawPqIx(signed(3, { isCash: false, amount: h.balance(u.hold), destination: safeAsset }))], v1));
  check('the asset arrived and number 4 is next', h.balance(safeAsset) === 25_000_000n && (await h.vault(u.address)).pqNextLeaf === 4 && (await h.vault(u.address)).assetBasis === 0n);
  refused('a key number past the end of the tree is refused', await h.send(relayer, [await withdrawPqIx({ ...signed(5, { amount: USDC(1), destination: safeUsdc }), leaf: 16 })], v1), 'PqLeafUsed');

  const next = keyTree(HEIGHT);
  const rot = (leaf, by, t = next) => ({ relayer, owner: u.address, newSeed: t.seed, newRoot: t.root, newHeight: HEIGHT, leaf, ...by.sign(leaf, rotateMessage({ userVault: u.userVault, leaf, newSeed: t.seed, newRoot: t.root, newHeight: HEIGHT })) });
  const thiefTree = keyTree(HEIGHT);
  refused('the thief cannot swap in a key of their own', await h.send(thief.signer, [await rotatePqIx({ ...rot(4, thiefTree, thiefTree), relayer: thief.signer })], v1), 'BadPqSignature');
  went('the owner moves to a fresh tree, signed by the old one', await h.send(relayer, [await rotatePqIx(rot(4, tree))], v1));
  refused('the old tree is dead', await h.send(relayer, [await withdrawPqIx(signed(5, { amount: USDC(1), destination: safeUsdc }))], v1), 'BadPqSignature');
  went('the new tree works from number 0', await h.send(relayer, [await withdrawPqIx(signed(0, { amount: USDC(1), destination: safeUsdc, by: next }))], v1));
  went('deposits and the weekly rule still run on the everyday key', await dep(h, u, 5));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
