// The whole flow once, on a chain in memory: open a vault, deposit, set a rule, note a few
// spends, let a week pass, have a stranger press the weekly button, then look at the vault the
// way a friend would (percent only) and the way the owner would (amounts).
//
//   npm run build && npm run flow

import { WEEK, depositIx, enrollPqIx, mixPercent, noteSpendIx, openVaultIx, setRuleIx, thisWeekSpend, vaultAddresses, weeklyBuyIx, withdrawCashIx, withdrawMessage, withdrawPqIx } from '../client/vault.mjs';
import { keyTree } from '../client/wots.mjs';
import { USDC, makeWorld } from '../tests/lib/world.mjs';

const w = await makeWorld();
await w.boot();
const must = (r) => { if (!r.ok) throw new Error(r.logs); return r; };
const dollars = (n) => (Number(n) / 1e6).toFixed(2);

const ada = await w.person();
const wallet = await w.tokenAccount(w.usdcMint, ada.address, USDC(80));
const walletAsset = await w.tokenAccount(w.assetMint, ada.address);
const a = await vaultAddresses(ada.address);

must(await w.send(ada, [await openVaultIx({ payer: ada, owner: ada, usdcMint: w.usdcMint, assetMint: w.assetMint })]));
console.log('1. Ada opens a vault.');

must(await w.send(ada, [await depositIx({ owner: ada, from: wallet, usdcMint: w.usdcMint, amount: USDC(40) })]));
console.log('2. She puts in 40 dollars. (The beta stops her at 50.)');

must(await w.send(ada, [await setRuleIx(ada, { weeklyAmount: USDC(5), roundupUnit: USDC(1), assetBps: 5000 })]));
console.log('3. Her rule: 5 a week plus round-ups to the dollar, half kept in dollars, half into the asset.');

for (const spend of [3.4, 12.75, 0.99]) must(await w.send(ada, [await noteSpendIx(ada, USDC(spend))]));
console.log(`4. Three spends this week (3.40, 12.75, 0.99) leave ${dollars((await w.vault(ada.address)).pendingRoundup)} of round-up change.`);

w.setTime(w.now() + WEEK);
const stranger = await w.person();
w.setPrice(); await w.swapAccounts(ada.address);
const r = must(await w.send(stranger, [await weeklyBuyIx({ cranker: stranger, owner: ada.address, usdcMint: w.usdcMint, assetMint: w.assetMint, priceUpdate: w.priceFeed, amountIn: thisWeekSpend(await w.vault(ada.address)) })]));
console.log(`5. A week later a stranger presses the weekly button for her. (${r.units} compute units)`);

const v = await w.vault(ada.address);
const mix = mixPercent({ cashAmount: v.cashTracked, assetAmount: w.balance(a.hold), rate: w.rate });
console.log(`\n   What her squad sees:   ${mix.dollars}% dollars, ${mix.asset}% asset, 1 week kept`);
console.log(`   What only she sees:    ${dollars(v.cashTracked)} in dollars, ${dollars(v.assetBasis)} put into the asset`);
console.log('   (On this chain both are public today. Keeping the second line private is the PER step in the README.)');

must(await w.send(ada, [await withdrawCashIx({ owner: ada, ownerUsdc: wallet, ownerAsset: walletAsset, usdcMint: w.usdcMint, assetMint: w.assetMint, amount: USDC(10) })]));
console.log(`\n6. She takes 10 back out. Wallet: ${dollars(w.balance(wallet))} dollars.`);

// The stronger lock. After this her everyday key cannot take money out, even if it is stolen.
const tree = keyTree(6);
must(await w.send(ada, [await enrollPqIx(ada, { seed: tree.seed, root: tree.root, height: 6 })]));
console.log('\n7. She turns on the hash-based lock: 64 one-time keys, all from one 32-byte secret.');
const stolen = await w.send(ada, [await withdrawCashIx({ owner: ada, ownerUsdc: wallet, ownerAsset: walletAsset, usdcMint: w.usdcMint, assetMint: w.assetMint, amount: USDC(1) })]);
console.log(`8. Her everyday key tries to withdraw on its own: ${stolen.ok ? 'WENT THROUGH (bug)' : 'refused'}.`);
const leaf = 0, amount = USDC(7);
const { sig, path } = tree.sign(leaf, withdrawMessage({ userVault: a.userVault, leaf, mint: w.usdcMint, amount, destination: wallet }));
const p = must(await w.send(stranger, [await withdrawPqIx({ relayer: stranger, owner: ada.address, destination: wallet, usdcMint: w.usdcMint, assetMint: w.assetMint, isCash: true, amount, leaf, sig, path })], { version: 1 }));
console.log(`9. A one-time signature for "7 dollars to this exact account" is delivered by a stranger and goes through. (${p.units} compute units, ${w.lastSize} bytes)`);
console.log(`   Wallet: ${dollars(w.balance(wallet))} dollars.`);
