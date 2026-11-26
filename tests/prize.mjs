// The Friday prize: interest (never savings) feeds each room's pot, sponsors top it up, and the pot pays
// the draw's winner into their vault. Against Jupiter Lend's real devnet program and market, the real
// rooms program, and the devnet build of the vault, all in memory. Nothing here touches a network.
import { readFileSync } from 'fs';
import { address, none, AccountRole, getAddressEncoder } from '@solana/kit';
import { getTokenEncoder } from '@solana-program/token';
import { makeWorld, USDC } from './lib/world.mjs';
import {
  DELEGATION_PROGRAM, LEND, ROOMS_PROGRAM, TOKEN_PROGRAM, delegationRecordPda, depositIx, harvestIx, initPrizeIx, lendIx, linkPotIx, openPotIx,
  openVaultIx, payPrizeIx, potPda, potUsdcPda, readPot, setPrizeCutIx, shareAccount, tokenExchangePrice, unlendIx, unlinkPotIx, vaultAddresses, savePrivateIx, setDcaIx, dcaBuyIx, readWinnings, winningsPda, WEEK, CHORE, setAgentIx, agentRunIx, approveAgentIx, readPolicy, agentPolicyPda,
} from '../client/vault.mjs';
import { createRoomIx, openResultIx, readRoom, readResult, resultPda, roomPda, setPocketIx } from '../client/rooms.mjs';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`); ok ? pass++ : fail++; };
const went = (label, r) => check(label, r.ok, r.ok ? '' : r.logs.slice(-1500));
const refused = (label, r, why) => check(label, !r.ok && r.logs.includes(why), r.ok ? 'it went through' : (r.logs.includes(why) ? '' : `wanted ${why}, got:\n${r.logs.slice(-800)}`));
const big = { version: 1, loadedLimit: 4 * 1024 * 1024, units: 1_000_000 };

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

const emptyToken = (addr, mint, owner) => {
  const d = new Uint8Array(getTokenEncoder().encode({ mint, owner, amount: 0n, delegate: none(), state: 1, isNative: none(), delegatedAmount: 0n, closeAuthority: none() }));
  w.svm.setAccount({ address: addr, data: d, executable: false, programAddress: TOKEN_PROGRAM, space: BigInt(d.length), lamports: w.svm.minimumBalanceForRentExemption(BigInt(d.length)) });
};
/** A saver with a vault, `saved` dollars in it and `lent` of them on Jupiter Lend. */
async function saver(saved, lent) {
  const p = await w.person();
  const usdc = await w.tokenAccount(m.mint, p.address, USDC(saved));
  const ok = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.logs.slice(-600)}`); };
  ok(await w.send(p, [await openVaultIx({ payer: p, owner: p, usdcMint: m.mint, assetMint: w.assetMint })]), 'open');
  ok(await w.send(p, [await depositIx({ owner: p, from: usdc, usdcMint: m.mint, amount: USDC(saved) })]), 'deposit');
  const va = await vaultAddresses(p.address);
  emptyToken(await shareAccount(va.userVault, m.fTokenMint), m.fTokenMint, va.userVault);
  emptyToken(await shareAccount(va.userVault, m.mint), m.mint, va.userVault);
  if (lent) ok(await w.send(p, [await lendIx({ owner: p, usdcMint: m.mint, market: m, amount: USDC(lent) })], big), 'lend');
  return { p, va, usdc };
}
const lendingPrice = () => tokenExchangePrice(w.svm.getAccount(m.lending).data);
const sharesValue = async (va) => (w.balance(await shareAccount(va.userVault, m.fTokenMint)) * lendingPrice()) / 1_000_000_000_000n;
const pot = async (room) => readPot(w.svm.getAccount(await potPda(room)).data);
/** The draw's outcome as the rooms program leaves it in the room's draw-result record after settle_draw
 * (VRF can't run offline). Prize payouts read only this record, never the room. */
const settle = async (room, { week, winner }) => {
  const at = await resultPda(room);
  const acc = w.svm.getAccount(at);
  const d = Buffer.from(acc.data);
  d.writeUInt32LE(week, 40); d.set(require58(winner), 44);
  w.svm.setAccount({ ...acc, address: at, data: new Uint8Array(d) });
};
const require58 = (a) => new Uint8Array(getAddressEncoder().encode(a));
const harvest = async (cranker, s, room, treasury) => w.send(cranker, [await harvestIx({ cranker, owner: s.p.address, room, treasury, usdcMint: m.mint, market: m })], big);
const pay = async (cranker, room, winner) => w.send(cranker, [await payPrizeIx({ cranker, room, winner, usdcMint: m.mint })]);

console.log('\nThe prize settings');
const treasury = await w.tokenAccount(m.mint, w.admin.address);
refused('Kashu\'s cut can never be set above 10%', await w.send(w.admin, [await initPrizeIx(w.admin, 1001)]), 'CutTooHigh');
const stranger = await w.person();
refused('only the admin sets it up', await w.send(stranger, [await initPrizeIx(stranger, 1000)]), 'ConstraintHasOne');
went('the admin sets the cut at 10%', await w.send(w.admin, [await initPrizeIx(w.admin, 1000)]));
refused('and cannot raise it past 10% later', await w.send(w.admin, [await setPrizeCutIx(w.admin, 2000)]), 'CutTooHigh');

console.log('\nA room\'s pot');
const host = await w.person();
went('a friend makes a room with the rooms program', await w.send(host, [await createRoomIx({ creator: host, roomId: 1n, name: 'Payday crew' })]));
const room = await roomPda(host.address, 1n);
check('the vault reads the room where the rooms program put it', readRoom(w.svm.getAccount(room).data).name === 'Payday crew');
went('anyone opens the room\'s pot', await w.send(stranger, [await openPotIx({ payer: stranger, room, usdcMint: m.mint })]));
const fake = await w.tokenAccount(m.mint, stranger.address);
refused('a pot can only be opened for a real room', await w.send(stranger, [await openPotIx({ payer: stranger, room: fake, usdcMint: m.mint })]), 'NotARoom');
went('anyone opens the room\'s draw-result record', await w.send(stranger, [await openResultIx({ payer: stranger, room })]));
const potUsdc = await potUsdcPda(room);
check('the pot starts empty', w.balance(potUsdc) === 0n);

console.log('\nInterest feeds the pot, savings stay put');
const ada = await saver(30, 30), bob = await saver(20, 20), carol = await saver(20, 20);
went('Ada lets her interest feed the room\'s pot', await w.send(ada.p, [await linkPotIx({ owner: ada.p, room })]));
went('so does Bob', await w.send(bob.p, [await linkPotIx({ owner: bob.p, room })]));
refused('a harvest needs at least a cent of interest', await harvest(stranger, ada, room, treasury), 'NothingToHarvest');
const price0 = lendingPrice();
// Jupiter Lend's devnet market pays almost nothing (its share price rises about 0.013% a year), so a
// month earns well under the one-cent harvest minimum; on mainnet USDC earns several percent. Four
// years of devnet interest stand in for a few weeks of mainnet interest.
w.setTime(w.now() + 4n * 365n * 86400n);
// any move on the market records the new share price; here a newcomer lends a dollar
const dan = await saver(1, 1);
const price1 = lendingPrice();
check('later, Jupiter Lend\'s share price has risen', price1 > price0, `${price0} -> ${price1}`);
const adaValue = await sharesValue(ada.va);
const adaInterest = adaValue - USDC(30) - 2n;
const t0 = w.balance(treasury);
const h = await harvest(stranger, ada, room, treasury);
went(`a stranger harvests Ada's interest (${Number(adaInterest) / 1e6} dollars)`, h);
const cut = (adaInterest * 1000n) / 10000n;
check('10% went to Kashu\'s treasury', w.balance(treasury) - t0 === cut, `cut ${w.balance(treasury) - t0}, wanted ${cut}`);
check('90% went to the room\'s pot', w.balance(potUsdc) === adaInterest - cut, `pot ${w.balance(potUsdc)}`);
let v = await w.vault(ada.p.address);
check('Ada\'s savings are untouched: 30 still lent, nothing taken from her cash', v.lentPrincipal === USDC(30) && v.cashTracked === 0n && w.balance(ada.va.cash) === 0n);
check('and her shares still cover all 30 dollars', (await sharesValue(ada.va)) >= USDC(30), `worth ${await sharesValue(ada.va)}`);
refused('harvesting again right away finds nothing', await harvest(stranger, ada, room, treasury), 'NothingToHarvest');
went('Bob\'s interest goes in too', await harvest(stranger, bob, room, treasury));
refused('Carol never joined the pot, so her interest stays hers (Keep mode)', await harvest(stranger, carol, room, treasury), 'AccountNotInitialized');
const notAdmin = await w.tokenAccount(m.mint, stranger.address);
const carolLinked = await w.send(carol.p, [await linkPotIx({ owner: carol.p, room })]);
went('Carol changes her mind and joins', carolLinked);
refused('the cut can only go to the admin\'s own account', await harvest(stranger, carol, room, notAdmin), 'WrongTreasury');
const p1 = await pot(room);
check('the pot keeps count: harvested and cut', p1.harvested > 0n && p1.cutTaken > 0n && p1.cutTaken * 10n <= p1.harvested + 10n, JSON.stringify({ harvested: String(p1.harvested), cut: String(p1.cutTaken) }));

console.log('\nA sponsor tops the pot up');
const sponsor = await w.person();
const sponsorUsdc = await w.tokenAccount(m.mint, sponsor.address, USDC(2));
const potBefore = w.balance(potUsdc);
const topUp = { programAddress: TOKEN_PROGRAM, accounts: [{ address: sponsorUsdc, role: AccountRole.WRITABLE }, { address: potUsdc, role: AccountRole.WRITABLE }, { address: sponsor.address, role: AccountRole.READONLY_SIGNER, signer: sponsor }],
  data: new Uint8Array([3, ...new Uint8Array(new BigUint64Array([USDC(2)]).buffer)]) };
went('a sponsor sends 2 dollars straight to the pot', await w.send(sponsor, [topUp]));
check('the pot holds the interest plus the sponsor\'s 2 dollars', w.balance(potUsdc) === potBefore + USDC(2));

console.log('\nFriday: the winner is paid');
refused('nothing is paid before the draw is settled', await pay(stranger, room, ada.p.address), 'DrawNotSettled');
await settle(room, { week: 1, winner: ada.p.address });
check('the draw result names Ada as week 1\'s winner', readResult(w.svm.getAccount(await resultPda(room)).data).winner === ada.p.address);
refused('the prize cannot go to someone else\'s vault', await pay(stranger, room, bob.p.address), 'NotTheWinner');
const prize = w.balance(potUsdc);
const principal0 = (await w.config()).totalPrincipal;
went('a stranger pays the prize', await pay(stranger, room, ada.p.address));
v = await w.vault(ada.p.address);
check('the whole pot is in Ada\'s vault, as her own savings', w.balance(ada.va.cash) === prize && v.cashTracked === prize, `prize ${prize}`);
check('the pot is empty and week 1 is marked paid', w.balance(potUsdc) === 0n && (await pot(room)).paidThrough === 2 && (await pot(room)).paidOut === prize);
check('the program counts the prize as money it manages', (await w.config()).totalPrincipal === principal0 + prize);
refused('week 1 cannot be paid twice', await pay(stranger, room, ada.p.address), 'PrizeAlreadyPaid');

console.log('\nTurning winnings into SOL, a little each week, never touching savings');
const winnings = async (owner) => readWinnings(w.svm.getAccount(await winningsPda((await vaultAddresses(owner)).userVault)).data);
let wn = await winnings(ada.p.address);
check('Ada\'s winnings record counts the prize', wn.totalWon === prize && wn.left === prize && wn.prizes === 1, JSON.stringify({ won: String(wn.totalWon), left: String(wn.left) }));
const dcaBuy = async (cranker, owner) => {
  w.setPrice(); await w.swapAccounts(owner);
  const x = await winnings(owner), v = await w.vault(owner);
  const spend = [x.weekly, x.left, v.cashTracked].reduce((a, b) => (a < b ? a : b));
  return w.send(cranker, [await dcaBuyIx({ cranker, owner, usdcMint: w.usdcMint, assetMint: w.assetMint, priceUpdate: w.priceFeed, amountIn: spend })]);
};
refused('with no weekly amount chosen, nothing is bought', await dcaBuy(stranger, ada.p.address), 'NothingToBuy');
const theirs = await setDcaIx({ owner: stranger, weekly: USDC(1) });
theirs.accounts[1] = { ...theirs.accounts[1], address: ada.va.userVault };
theirs.accounts[2] = { ...theirs.accounts[2], address: await winningsPda(ada.va.userVault) };
check('a stranger cannot choose Ada\'s weekly amount', !(await w.send(stranger, [theirs])).ok);
went('Ada chooses 1 dollar a week', await w.send(ada.p, [await setDcaIx({ owner: ada.p, weekly: USDC(1) })]));
const hold0 = w.balance(ada.va.hold), lent0 = (await w.vault(ada.p.address)).lentPrincipal;
went('a stranger runs this week\'s winnings buy', await dcaBuy(stranger, ada.p.address));
v = await w.vault(ada.p.address); wn = await winnings(ada.p.address);
check('1 dollar of winnings became SOL at the honest price', v.cashTracked === prize - USDC(1) && w.balance(ada.va.hold) - hold0 >= 4_900_000n, `got ${w.balance(ada.va.hold) - hold0}`);
check('winnings left went down by 1, the total won did not', wn.left === prize - USDC(1) && wn.totalWon === prize);
check('her lent savings were not touched', v.lentPrincipal === lent0);
refused('a second buy the same week is refused', await dcaBuy(stranger, ada.p.address), 'NotDue');
w.setTime(w.now() + WEEK);
went('Ada asks for 100 a week', await w.send(ada.p, [await setDcaIx({ owner: ada.p, weekly: USDC(100) })]));
went('next week\'s buy runs', await dcaBuy(stranger, ada.p.address));
v = await w.vault(ada.p.address); wn = await winnings(ada.p.address);
check('it spent only what was left of her winnings, not 100', wn.left === 0n && v.cashTracked === 0n && v.lentPrincipal === lent0, JSON.stringify({ left: String(wn.left), cash: String(v.cashTracked) }));
w.setTime(w.now() + WEEK);
refused('with no winnings left, nothing more is bought', await dcaBuy(stranger, ada.p.address), 'NothingToBuy');

console.log('\nA private room: only its draw result comes back to Solana');
// on Solana a delegated room is held by MagicBlock's delegation program, with its last committed state
const resultAt = await resultPda(room);
const record = await delegationRecordPda(resultAt);
const asDelegated = (ownerProgram) => {
  const acc = w.svm.getAccount(resultAt);
  w.svm.setAccount({ ...acc, address: resultAt, programAddress: DELEGATION_PROGRAM });
  const d = new Uint8Array(96); d.set(require58(host.address), 8); d.set(require58(ownerProgram), 40);
  w.svm.setAccount({ address: record, data: d, executable: false, programAddress: DELEGATION_PROGRAM, space: 96n, lamports: w.svm.minimumBalanceForRentExemption(96n) });
};
w.svm.setAccount({ address: DELEGATION_PROGRAM, data: new Uint8Array(0), executable: false, programAddress: address('11111111111111111111111111111111'), space: 0n, lamports: 1n });
asDelegated(ROOMS_PROGRAM);
await settle(room, { week: 2, winner: bob.p.address });
const sponsor2 = await w.tokenAccount(m.mint, sponsor.address, USDC(1));
const topUp2 = { ...topUp, accounts: [{ address: sponsor2, role: AccountRole.WRITABLE }, topUp.accounts[1], topUp.accounts[2]], data: new Uint8Array([3, ...new Uint8Array(new BigUint64Array([USDC(1)]).buffer)]) };
went('the next week a sponsor adds a dollar', await w.send(sponsor, [topUp2]));
const bobCash = w.balance(bob.va.cash);
went('week 2 is paid from the draw result the private rollup committed, while the room stays private', await pay(stranger, room, bob.p.address));
check('Bob got the dollar', w.balance(bob.va.cash) - bobCash === USDC(1));
asDelegated(DELEGATION_PROGRAM);
await settle(room, { week: 3, winner: bob.p.address });
refused('a delegated result whose record names another program is not trusted', await pay(stranger, room, bob.p.address), 'NotARoom');

console.log('\nSavers can always leave');
went('Ada stops feeding the pot', await w.send(ada.p, [await unlinkPotIx({ owner: ada.p })]));
w.setTime(w.now() + 30n * 86400n);
await saver(1, 1);
refused('and her interest can no longer be harvested', await harvest(stranger, ada, room, treasury), 'AccountNotInitialized');
went('Ada takes all 30 dollars of savings back from Jupiter Lend', await w.send(ada.p, [await unlendIx({ owner: ada.p, usdcMint: m.mint, market: m, amount: USDC(30) })], big));
v = await w.vault(ada.p.address);
check('her 30 dollars are all in her cash (her prize became SOL above), plus the interest she kept after leaving the pot', w.balance(ada.va.cash) > USDC(30) && v.lentPrincipal === 0n, `cash ${w.balance(ada.va.cash)}`);

console.log('\nPrivate saves: from the wallet to the saver\'s own private pocket, counted by the vault, held by the pocket');
{
  const zed = await w.person();
  const zUsdc = await w.tokenAccount(m.mint, zed.address, USDC(20));
  await w.send(zed, [await openVaultIx({ payer: zed, owner: zed, usdcMint: m.mint, assetMint: w.assetMint })]);
  const zv = await vaultAddresses(zed.address);
  const pocket = (await w.person()).address, other = (await w.person()).address;
  const pocketUsdc = await w.tokenAccount(m.mint, pocket), otherUsdc = await w.tokenAccount(m.mint, other);
  refused('a wallet that named no pocket can\'t save privately', await w.send(zed, [await savePrivateIx({ owner: zed, from: zUsdc, to: pocketUsdc, usdcMint: m.mint, amount: USDC(1) })]), 'NotYourPocket');
  await w.send(zed, [await setPocketIx({ owner: zed, pocket })]);
  const before = (await w.vault(zed.address)).buysDone;
  went('Zed saves a dollar into his own pocket', await w.send(zed, [await savePrivateIx({ owner: zed, from: zUsdc, to: pocketUsdc, usdcMint: m.mint, amount: USDC(1) })]));
  const v = await w.vault(zed.address);
  check('it counts as a save for his room', v.buysDone === before + 1);
  check('and the pocket holds it; the vault holds none of it', w.balance(pocketUsdc) === USDC(1) && w.balance(zv.cash) === 0n && v.cashTracked === 0n);
  refused('it can\'t go to someone else\'s account', await w.send(zed, [await savePrivateIx({ owner: zed, from: zUsdc, to: otherUsdc, usdcMint: m.mint, amount: USDC(1) })]), 'NotYourPocket');
  await w.send(zed, [await setPocketIx({ owner: zed, pocket: other })]);
  refused('nor to a pocket he has since replaced', await w.send(zed, [await savePrivateIx({ owner: zed, from: zUsdc, to: pocketUsdc, usdcMint: m.mint, amount: USDC(1) })]), 'NotYourPocket');
  went('to the new one it goes', await w.send(zed, [await savePrivateIx({ owner: zed, from: zUsdc, to: otherUsdc, usdcMint: m.mint, amount: USDC(1) })]));
  const n = (await w.vault(zed.address)).buysDone;
  went('a few cents move too', await w.send(zed, [await savePrivateIx({ owner: zed, from: zUsdc, to: otherUsdc, usdcMint: m.mint, amount: 50_000n })]));
  check('but dust doesn\'t count as a save', (await w.vault(zed.address)).buysDone === n);
  const mal = await w.person();
  await w.tokenAccount(m.mint, mal.address, USDC(5));
  refused('nobody else can make his save', await w.send(mal, [{ ...(await savePrivateIx({ owner: zed, from: zUsdc, to: otherUsdc, usdcMint: m.mint, amount: USDC(1) })), accounts: (await savePrivateIx({ owner: zed, from: zUsdc, to: otherUsdc, usdcMint: m.mint, amount: USDC(1) })).accounts.map((a, i) => (i === 0 ? { address: mal.address, role: AccountRole.READONLY_SIGNER, signer: mal } : a)) }]), 'ConstraintSeeds');
}

console.log('\nKashu\'s agent: chores a saver sets, run inside limits the vault enforces');
{
  const ann = await w.person(), agent = await w.person(), stranger = await w.person(), bo = (await w.person()).address;
  const aUsdc = await w.tokenAccount(m.mint, ann.address, USDC(20));
  await w.send(ann, [await openVaultIx({ payer: ann, owner: ann, usdcMint: m.mint, assetMint: w.assetMint })]);
  const av = await vaultAddresses(ann.address);
  const pocket = (await w.person()).address;
  const pocketUsdc = await w.tokenAccount(m.mint, pocket), boUsdc = await w.tokenAccount(m.mint, bo);
  await w.send(ann, [await setPocketIx({ owner: ann, pocket })]);
  const chores = [{ kind: CHORE.SAVE, amount: USDC(1), weekday: 5, hour: 18 }, { kind: CHORE.SAVE_PRIVATE, amount: USDC(1), weekday: 5, hour: 18 }, { kind: CHORE.PAY, amount: USDC(1), weekday: 1, hour: 9, payee: 0 }, { kind: CHORE.REMIND, weekday: 4, hour: 19 }];
  refused('a chore paying someone she didn\'t name is refused', await w.send(ann, [await setAgentIx({ owner: ann, agent: agent.address, weeklyCap: USDC(3), payees: [], chores: [chores[2]] })]), 'BadChore');
  refused('so is a chore bigger than the weekly cap', await w.send(ann, [await setAgentIx({ owner: ann, agent: agent.address, weeklyCap: USDC(1), payees: [bo], chores: [{ kind: CHORE.SAVE, amount: USDC(2) }] })]), 'BadChore');
  went('Ann sets her agent: save $1, save $1 privately, pay Bo $1, remind her; $3 a week at most', await w.send(ann, [await setAgentIx({ owner: ann, agent: agent.address, weeklyCap: USDC(3), payees: [bo], chores })]));
  const pol = readPolicy(w.svm.getAccount(await agentPolicyPda(ann.address)).data);
  check('the policy on chain says exactly that', pol.agent === agent.address && pol.weeklyCap === USDC(3) && pol.payees[0] === bo && pol.chores[2].kind === CHORE.PAY && pol.chores[2].amount === USDC(1));
  const kashu = await w.tokenAccount(m.mint, w.admin.address);
  const runIx = async (signer, chore, to, from = aUsdc, treasury = kashu) => w.send(signer, [await agentRunIx({ agent: signer, owner: ann.address, chore, from, to, usdcMint: m.mint, treasury })]);
  check('without her allowance the agent can\'t move anything', !(await runIx(agent, 0, av.cash)).ok);
  went('she approves the vault\'s agent authority (not the agent) for $10', await w.send(ann, [await approveAgentIx({ owner: ann, from: aUsdc, usdcMint: m.mint, amount: USDC(10) })]));
  const saves0 = (await w.vault(ann.address)).buysDone;
  const notKashu = await w.tokenAccount(m.mint, stranger.address);
  refused('the run\'s fee can only go to an account Kashu owns', await runIx(agent, 0, av.cash, aUsdc, notKashu), 'WrongTreasury');
  const fee0 = w.balance(kashu);
  went('the agent saves $1 into her vault', await runIx(agent, 0, av.cash));
  check('and Kashu took exactly one cent for the run', w.balance(kashu) - fee0 === 10_000n, `${w.balance(kashu) - fee0}`);
  const v1 = await w.vault(ann.address);
  check('her vault has it, and it counts as a save', w.balance(av.cash) === USDC(1) && v1.cashTracked === USDC(1) && v1.buysDone === saves0 + 1);
  refused('the same chore can\'t run twice in a week', await runIx(agent, 0, av.cash), 'ChoreTooSoon');
  refused('a stranger\'s key can\'t run her chores', await runIx(stranger, 1, pocketUsdc), 'NotTheAgent');
  refused('a private save can\'t go anywhere but her pocket', await runIx(agent, 1, boUsdc), 'AgentDestination');
  went('the agent saves $1 into her private pocket', await runIx(agent, 1, pocketUsdc));
  check('her pocket has it', w.balance(pocketUsdc) === USDC(1));
  refused('a payment can\'t go to anyone but the payee she named', await runIx(agent, 2, pocketUsdc), 'AgentDestination');
  refused('nor into her vault dressed up as a payment', await runIx(agent, 2, av.cash), 'AgentDestination');
  went('the agent pays Bo $1', await runIx(agent, 2, boUsdc));
  check('Bo has it', w.balance(boUsdc) === USDC(1));
  refused('a reminder never moves money on chain', await runIx(agent, 3, av.cash), 'BadChore');
  w.setTime(w.now() + 9n * 60n + 30n); // a chore's gap has passed, the cap's window hasn't
  refused('a week of chores later, but within the same cap window: over her $3', await runIx(agent, 0, av.cash), 'AgentCap');
  w.setTime(w.now() + 60n);
  went('in the next window it saves again', await runIx(agent, 0, av.cash));
  refused('someone else can\'t rewrite her policy', await w.send(stranger, [{ ...(await setAgentIx({ owner: ann, agent: stranger.address, weeklyCap: USDC(20), payees: [stranger.address], chores: [{ kind: CHORE.PAY, amount: USDC(20) }] })), accounts: (await setAgentIx({ owner: ann, agent: stranger.address, weeklyCap: USDC(20) })).accounts.map((x, i) => (i === 0 ? { address: stranger.address, role: AccountRole.WRITABLE_SIGNER, signer: stranger } : x)) }]), 'ConstraintSeeds');
  went('she turns the agent off', await w.send(ann, [await setAgentIx({ owner: ann })]));
  w.setTime(w.now() + 20n * 60n);
  refused('and it can do nothing more, allowance or not', await runIx(agent, 0, av.cash), 'NotTheAgent');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
