// The weekly buy through Jupiter's real aggregator: a live USDC -> SOL route (one Orca Whirlpool leg) and
// every account it touches, copied from mainnet with the live Pyth SOL/USD price (scripts/jupiter-fixtures.mjs),
// run in memory against the mainnet build of the vault. Nothing here touches a network.
import { readFileSync } from 'fs';
import { address, AccountRole } from '@solana/kit';
import { makeWorld, USDC } from './lib/world.mjs';
import { WEEK, depositIx, initializeIx, openVaultIx, setRuleIx, setVenueIx, thisWeekSpend, vaultAddresses, weeklyBuyIx } from '../client/vault.mjs';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`); ok ? pass++ : fail++; };
const went = (label, r, extra = '') => check(label, r.ok, r.ok ? extra : r.logs.slice(-2500));
const refused = (label, r, why) => check(label, !r.ok && r.logs.includes(why), r.ok ? 'it went through' : (r.logs.includes(why) ? '' : `wanted ${why}, got:\n${r.logs.slice(-1200)}`));

const route = JSON.parse(readFileSync(new URL('./fixtures/jupiter-route.json', import.meta.url)));
const fx = JSON.parse(readFileSync(new URL('./fixtures/jupiter-accounts.json', import.meta.url)));
const USDC_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), WSOL = address('So11111111111111111111111111111111111111112');
const JUP = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), WHIRL = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const pyth = Buffer.from(fx.accounts[fx.pythSolUsd].data, 'base64');
const feedId = new Uint8Array(pyth.subarray(41, 73));
const publishTime = pyth.readBigInt64LE(41 + 32 + 8 + 8 + 4);
const big = { version: 1, loadedLimit: 32 * 1024 * 1024, units: 1_200_000 };

/** A chain with mainnet's USDC, wSOL, the route's accounts, Jupiter, Orca and Pyth's SOL price; the venue is Jupiter. */
async function world(weekly) {
  const w = await makeWorld({ usdcMint: USDC_MINT, assetMint: WSOL });
  for (const [addr, a] of Object.entries(fx.accounts)) {
    const data = new Uint8Array(Buffer.from(a.data, 'base64'));
    w.svm.setAccount({ address: address(addr), data, executable: false, programAddress: address(a.owner), space: BigInt(data.length), lamports: BigInt(a.lamports) });
  }
  w.svm.addProgramFromFile(JUP, fixture('jupiter_v6.so'));
  w.svm.addProgramFromFile(WHIRL, fixture('orca_whirlpool.so'));
  w.setTime(publishTime - WEEK); // a week before the price was published
  const ok = (r, what) => { if (!r.ok) throw new Error(`${what} failed\n${r.logs}`); };
  ok(await w.send(w.admin, [await initializeIx({ admin: w.admin, usdcMint: USDC_MINT, assetMint: WSOL, perUserCap: USDC(50), totalCap: USDC(5000), floorRate: 1n })]), 'initialize');
  ok(await w.send(w.admin, [await setVenueIx({ admin: w.admin, swapProgram: JUP, priceFeed: address(fx.pythSolUsd), feedId, maxAgeSecs: 120, maxConfBps: 100, slippageBps: 100 })]), 'set_venue');
  const ada = await w.person();
  const adaUsdc = await w.tokenAccount(USDC_MINT, ada.address, USDC(20));
  ok(await w.send(ada, [await openVaultIx({ payer: ada, owner: ada, usdcMint: USDC_MINT, assetMint: WSOL })]), 'open_vault');
  ok(await w.send(ada, [await depositIx({ owner: ada, from: adaUsdc, usdcMint: USDC_MINT, amount: USDC(10) })]), 'deposit');
  ok(await w.send(ada, [await setRuleIx(ada, { weeklyAmount: USDC(weekly), roundupUnit: 0n, assetBps: 10000 })]), 'set_rule');
  // the buy is due: the clock just past both the price and the pool's own last update (Orca refuses time going back)
  const pool = Buffer.from(fx.accounts[route.quote.routePlan[0].swapInfo.ammKey].data, 'base64');
  const poolTs = pool.readBigUInt64LE(261);
  w.setTime((poolTs > publishTime ? poolTs : publishTime) + 1n);
  const va = await vaultAddresses(ada.address);
  // the swap authority's own USDC and SOL accounts (anyone may create them)
  va.swapIn = await w.ataAccount(USDC_MINT, va.swapAuthority);
  va.swapOut = await w.ataAccount(WSOL, va.swapAuthority);
  return { w, ada, va };
}

/**
 * Jupiter's instruction for the route. Asked for a user, Jupiter routes from that user's USDC account into
 * their SOL account; the weekly job asks with the vault's swap authority as the user, so the route comes
 * back already pointing at the swap authority's own accounts. Here the route was fetched for a placeholder
 * user, so its three accounts are mapped to the swap authority's.
 */
function jupiterRoute(va, { destination } = {}) {
  const map = { [fx.user]: va.swapAuthority, [fx.userAtas[0]]: va.swapIn, [fx.userAtas[1]]: destination ?? va.swapOut };
  const ix = route.swap.swapInstruction;
  return {
    data: Buffer.from(ix.data, 'base64'),
    accounts: ix.accounts.map((a) => ({ address: address(map[a.pubkey] ?? a.pubkey), role: a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY })),
  };
}
const buyIx = async (w, cranker, ada, va, opts) => weeklyBuyIx({ cranker, owner: ada.address, usdcMint: USDC_MINT, assetMint: WSOL, priceUpdate: address(fx.pythSolUsd), swapProgram: JUP, route: jupiterRoute(va, opts) });

const price = Number(pyth.readBigInt64LE(41 + 32)) * 10 ** pyth.readInt32LE(41 + 32 + 16);
console.log(`\nThe weekly buy through Jupiter (route quoted ${route.quote.inAmount} USDC units -> ${route.quote.outAmount} lamports; Pyth SOL $${price.toFixed(2)})`);
{
  const { w, ada, va } = await world(5);
  const cranker = await w.person();
  check('the rule spends exactly what the route carries: 5 dollars', thisWeekSpend(await w.vault(ada.address)) === USDC(5));
  const r = await w.send(cranker, [await buyIx(w, cranker, ada, va)], big);
  went('a stranger presses the button with Jupiter\'s own route, and it goes through', r, `${r.units} compute units, ${w.lastSize} byte transaction`);
  const got = w.balance(va.hold);
  const quoted = BigInt(route.quote.outAmount);
  check('exactly 5 dollars left the cash', w.balance(va.cash) === USDC(5));
  check('the SOL landed in the vault\'s own holding account, near Jupiter\'s quote', got > (quoted * 97n) / 100n && got < (quoted * 103n) / 100n, `got ${got}, quoted ${quoted}`);
  check('and above the oracle-priced minimum (Pyth less 1%)', Number(got) / 1e9 >= (5 / price) * 0.99);
  check('the spending right is gone afterwards', w.token(va.cash).delegate.__option === 'None');
  check('and nothing stayed behind with the swap authority', w.balance(va.swapIn) === 0n && w.balance(va.swapOut) === 0n);
}
{
  const { w, ada, va } = await world(4);
  const c = await w.person();
  const r = await w.send(c, [await buyIx(w, c, ada, va)], big);
  // the swap authority holds exactly this week's 4 dollars; Jupiter (InsufficientFunds, 0x1788) or the token
  // program refuses to move 5
  check('a route for more than the rule allows is stopped (the swap authority holds only this week\'s 4 dollars)', !r.ok && (r.logs.includes('0x1788') || r.logs.includes('insufficient funds')), r.ok ? 'it went through' : '');
  check('and nothing moved', w.balance(va.cash) === USDC(10) && w.balance(va.hold) === 0n);
}
{
  const { w, ada, va } = await world(5);
  const c = await w.person();
  const thief = await w.tokenAccount(WSOL, c.address);
  const r = await w.send(c, [await buyIx(w, c, ada, va, { destination: thief })], big);
  check('a route that pays the SOL to someone else is stopped', !r.ok && (r.logs.includes('SwapPaidTooLittle') || r.logs.includes('0x1789')), r.ok ? 'it went through' : '');
  check('and nothing moved', w.balance(va.cash) === USDC(10) && w.balance(thief) === 0n);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
