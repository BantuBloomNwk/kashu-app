// The rooms program: a room only counts real saves, once a week; streaks grow week on week and so do
// draw tickets (up to 4); a session key can tap but a stranger cannot; nobody can roll the week early.
//
//   npm run build && node tests/rooms.mjs

import { address, getAddressEncoder } from '@solana/kit';
import { WEEK, depositIx, openVaultIx, setRuleIx, vaultAddresses, thisWeekSpend, weeklyBuyIx } from '../client/vault.mjs';
import { PERMISSION_RENT, ROOM_DRAW_OFFSET, openResultIx, readResult, resultPda, requestJoinIx, admitIx, delegationRecordOf, requestViewerIx, applyViewerIx, upgradeMemberIx, checkInIx, cheerIx, createRoomIx, joinRoomIx, memberPda, nextWeekIx, readMember, readRoom, requestDrawIx, roomPda, settleDrawIx, claimTagIx, changeTagIx, tagPda, tagOfPda, readTag, readTagOf, normalTag, tagBytes, setPocketIx, pocketOfPda, readPocketOf, setAvatarIx, avatarOfPda, readAvatarOf } from '../client/rooms.mjs';
import { USDC, makeWorld } from './lib/world.mjs';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '   ' + extra : ''}`); ok ? pass++ : fail++; };
const section = (s) => console.log(`\n${s}`);
const refused = (label, r, why) => check(label, !r.ok && r.logs.includes(why), r.ok ? 'it went through' : (r.logs.includes(why) ? '' : `wanted ${why}, got:\n${r.logs.slice(-600)}`));
const went = (label, r) => check(label, r.ok, r.ok ? '' : r.logs.slice(-800));

const w = await makeWorld();
await w.boot();
async function saver() {
  const s = await w.person();
  const usdc = await w.tokenAccount(w.usdcMint, s.address, USDC(100));
  await w.send(s, [await openVaultIx({ payer: s, owner: s, usdcMint: w.usdcMint, assetMint: w.assetMint })]);
  await w.send(s, [await depositIx({ owner: s, from: usdc, usdcMint: w.usdcMint, amount: USDC(50) })]);
  await w.send(s, [await setRuleIx(s, { weeklyAmount: USDC(5), roundupUnit: 0n, assetBps: 10000 })]);
  return { s, ...(await vaultAddresses(s.address)) };
}
const cranker = await w.person();
const save = async (u) => { w.setPrice(); await w.swapAccounts(u.s.address); return w.send(cranker, [await weeklyBuyIx({ cranker, owner: u.s.address, usdcMint: w.usdcMint, assetMint: w.assetMint, priceUpdate: w.priceFeed, amountIn: thisWeekSpend(await w.vault(u.s.address)) })]); };
const R2 = (bytes) => readRoom(bytes);
const room = async (r) => readRoom(w.svm.getAccount(r).data);
const member = async (r, owner) => readMember(w.svm.getAccount(await memberPda(r, owner)).data);
/** Stands in for the VRF oracle's answer: the drawn ticket number lands in the room (the real
 * callback can only be signed by MagicBlock's VRF identity; that round trip is tested on devnet). */
const oracleAnswers = (r, ticket) => {
  const acc = w.svm.getAccount(r); const d = Buffer.from(acc.data);
  d.writeUInt32LE((readRoom(acc.data)).week, ROOM_DRAW_OFFSET); d[ROOM_DRAW_OFFSET + 4] = 2; d.writeUInt32LE(ticket, ROOM_DRAW_OFFSET + 5);
  w.svm.setAccount({ ...acc, data: new Uint8Array(d) });
};
/** Draw and settle the finished week for whoever holds ticket 0 (here the only saver). */
const drawFor = async (r, owner, ticket = 0) => { oracleAnswers(r, ticket); return w.send(mallory, [await settleDrawIx({ room: r, owner })]); };

section('Opening a room and joining');
const ada = await saver(), bayo = await saver(), mallory = await w.person();
const adaSession = await w.person();
went('Ada opens a room', await w.send(ada.s, [await createRoomIx({ creator: ada.s, roomId: 1, name: 'Payday crew' })]));
const opener = await w.person();
went('anyone opens its draw-result record (the keeper does, beside the prize pot)', await w.send(opener, [await openResultIx({ payer: opener, room: await roomPda(ada.s.address, 1) })]));
const R = await roomPda(ada.s.address, 1);
check('the room is named and on week 1', (await room(R)).name === 'Payday crew' && (await room(R)).week === 1);
const exp = Number(w.now()) + 8 * 86400; // the longest a session may run
went('Ada joins with a session key', await w.send(ada.s, [await joinRoomIx({ owner: ada.s, room: R, userVault: ada.userVault, session: adaSession.address, sessionExpires: exp })]));
went('Bayo joins', await w.send(bayo.s, [await joinRoomIx({ owner: bayo.s, room: R, userVault: bayo.userVault, session: bayo.s.address, sessionExpires: exp })]));
refused('Mallory cannot join with Bayo\'s vault', await w.send(mallory, [await joinRoomIx({ owner: mallory, room: R, userVault: bayo.userVault, session: mallory.address, sessionExpires: exp })]), 'NotYourVault');
refused('a session longer than 120 days is refused', await w.send(mallory, [await joinRoomIx({ owner: mallory, room: R, userVault: mallory.address, session: mallory.address, sessionExpires: Number(w.now()) + 121 * 86400 })]), 'Error');
check('two members', (await room(R)).members === 2);
check('the roster lists them in joining order', JSON.stringify((await room(R)).roster) === JSON.stringify([ada.s.address, bayo.s.address]));
// each record carries its own private-rollup permission rent on top of being rent-exempt
const spare = (a) => { const acc = w.svm.getAccount(a); return BigInt(acc.lamports) - BigInt(w.svm.minimumBalanceForRentExemption(BigInt(acc.data.length))); };
check('the room carries its permission rent', spare(R) >= PERMISSION_RENT, `spare ${spare(R)}, needs ${PERMISSION_RENT}`);
check('each member record carries its permission rent', spare(await memberPda(R, ada.s.address)) >= PERMISSION_RENT && spare(await memberPda(R, bayo.s.address)) >= PERMISSION_RENT);

section('Checking in counts only a real save');
refused('no save yet, no check-in', await w.send(ada.s, [await checkInIx({ signer: ada.s, room: R, owner: ada.s.address, userVault: ada.userVault })]), 'NoNewSave');
w.setTime(w.now() + WEEK);
went('the weekly save lands in Ada\'s vault', await save(ada));
refused('Mallory cannot check in for Ada', await w.send(mallory, [await checkInIx({ signer: mallory, room: R, owner: ada.s.address, userVault: ada.userVault })]), 'NotYourSeat');
refused('Bayo cannot use his vault for Ada\'s seat', await w.send(ada.s, [await checkInIx({ signer: ada.s, room: R, owner: ada.s.address, userVault: bayo.userVault })]), 'NotYourVault');
// the week the room opened is over now (we moved the clock a week for the save), so roll first
refused('the room still sits in week 1, which is over', await w.send(adaSession, [await checkInIx({ signer: adaSession, room: R, owner: ada.s.address, userVault: ada.userVault })]), 'WeekOver');
went('anyone rolls the room to week 2', await w.send(mallory, [nextWeekIx({ anyone: mallory, room: R })]));
went('Ada\'s session key checks her in', await w.send(adaSession, [await checkInIx({ signer: adaSession, room: R, owner: ada.s.address, userVault: ada.userVault })]));
refused('the same week counts once', await w.send(ada.s, [await checkInIx({ signer: ada.s, room: R, owner: ada.s.address, userVault: ada.userVault })]), 'AlreadyCounted');
let m = await member(R, ada.s.address);
check('streak 1, one ticket', m.streak === 1 && m.tickets === 1, JSON.stringify({ streak: m.streak, tickets: m.tickets }));
refused('rolling the week early is refused', await w.send(mallory, [nextWeekIx({ anyone: mallory, room: R })]), 'WeekNotOver');

section('Streaks grow week on week, tickets cap at 4');
for (let week = 3; week <= 7; week++) {
  w.setTime(w.now() + WEEK);
  await drawFor(R, ada.s.address);
  await w.send(mallory, [nextWeekIx({ anyone: mallory, room: R })]);
  await save(ada);
  await w.send(ada.s, [await checkInIx({ signer: ada.s, room: R, owner: ada.s.address, userVault: ada.userVault })]);
}
m = await member(R, ada.s.address);
check('six weeks in a row: streak 6, tickets capped at 4', m.streak === 6 && m.tickets === 4, JSON.stringify({ streak: m.streak, tickets: m.tickets }));
check('the room counts this week\'s tickets and savers', (await room(R)).tickets === 4 && (await room(R)).savers === 1);
section('The weekly draw');
w.setTime(w.now() + WEEK);
refused('the room cannot move on with its draw unsettled', await w.send(mallory, [nextWeekIx({ anyone: mallory, room: R })]), 'DrawNotSettled');
refused('nobody settles a draw that has not been made', await w.send(mallory, [await settleDrawIx({ room: R, owner: ada.s.address })]), 'NotDrawn');
oracleAnswers(R, 3);
refused('Bayo has no tickets this week, so he cannot claim it', await w.send(mallory, [await settleDrawIx({ room: R, owner: bayo.s.address })]), 'NotThisWeek');
went('anyone settles it for Ada, whose tickets hold number 3', await w.send(mallory, [await settleDrawIx({ room: R, owner: ada.s.address })]));
{ const res = readResult(w.svm.getAccount(await resultPda(R)).data);
  check('the draw result record names Ada for this week: the only part that goes back to Solana for a private room', res.winner === ada.s.address && res.week === (await room(R)).drawWeek, JSON.stringify(res)); }
check('Ada is this week\'s winner', (await room(R)).winner === ada.s.address && (await room(R)).drawState === 3);
refused('a settled draw cannot be settled again', await w.send(mallory, [await settleDrawIx({ room: R, owner: ada.s.address })]), 'NotDrawn');
went('now the room moves on', await w.send(mallory, [nextWeekIx({ anyone: mallory, room: R })]));
refused('the draw cannot be asked for before the week ends', await w.send(mallory, [await requestDrawIx({ payer: mallory, room: R })]), 'WeekNotOver');
w.setTime(w.now() + WEEK);
refused('a week where nobody saved has no draw', await w.send(mallory, [await requestDrawIx({ payer: mallory, room: R })]), 'NoTickets');
for (const [name, queue] of [['test', 'GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb'], ['rollup test', 'Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT']]) {
  refused(`the draw refuses MagicBlock's ${name} VRF queue (local development only; the prize is real money)`, await w.send(mallory, [await requestDrawIx({ payer: mallory, room: R, queue: address(queue) })]), 'BadQueue');
}
went('and it moves on without one', await w.send(mallory, [nextWeekIx({ anyone: mallory, room: R })]));
await save(ada);
await w.send(ada.s, [await checkInIx({ signer: ada.s, room: R, owner: ada.s.address, userVault: ada.userVault })]);
m = await member(R, ada.s.address);
check('a missed week starts the streak again at 1', m.streak === 1 && m.tickets === 1, JSON.stringify({ streak: m.streak }));

section('Private rooms: viewer keys, joining on the rollup');
{
  const viewer = (await w.person()).address;
  const h = await saver();
  went('a host starts a room', await w.send(h.s, [await createRoomIx({ creator: h.s, roomId: 21n, name: 'Private crew' })]));
  const P = await roomPda(h.s.address, 21n);
  went('and joins with a viewer key from their phone', await w.send(h.s, [await joinRoomIx({ owner: h.s, room: P, userVault: h.userVault, session: h.s.address, sessionExpires: Number(w.now()) + 86400 * 7, viewer })]));
  check('the member record keeps the viewer key', (await member(P, h.s.address)).viewer === viewer);
  const g = await saver();
  const ask = async () => w.send(g.s, [await requestJoinIx({ owner: g.s, room: P, userVault: g.userVault, session: g.s.address, sessionExpires: Number(w.now()) + 86400 * 7, viewer })]);
  refused('asking to join through the rollup path is refused while the room is on Solana', await ask(), 'WrongRoom');
  // on Solana a private room is held by MagicBlock's delegation program, with a record naming the rooms program
  const acc = w.svm.getAccount(P);
  w.svm.setAccount({ ...acc, address: P, programAddress: address('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh') });
  const rec = new Uint8Array(96); rec.set(new Uint8Array(getAddressEncoder().encode(address('8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q'))), 40);
  w.svm.setAccount({ address: await delegationRecordOf(P), data: rec, executable: false, programAddress: address('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'), space: 96n, lamports: w.svm.minimumBalanceForRentExemption(96n) });
  went('a friend asks to join the private room: their record is made on Solana, the room untouched', await ask());
  check('they have a record but no seat yet', (await member(P, g.s.address)).streak === 0 && R2(w.svm.getAccount(P).data).members === 1);
  // back as the rollup sees it (owned by the rooms program) for the seat
  w.svm.setAccount({ ...w.svm.getAccount(P), address: P, programAddress: address('8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q') });
  went('on the rollup, anyone seats them', await w.send(mallory, [await admitIx({ room: P, owner: g.s.address })]));
  check('now the room has two members, the friend in seat two', (await room(P)).members === 2 && (await room(P)).roster[1] === g.s.address);
  refused('nobody is seated twice', await w.send(mallory, [await admitIx({ room: P, owner: g.s.address })]), 'AlreadySeated');
  // a new phone: the member asks on Solana, anyone applies it on the rollup
  const phone2 = (await w.person()).address;
  refused('an empty viewer key is refused', await w.send(g.s, [await requestViewerIx({ owner: g.s, room: P, viewer: '11111111111111111111111111111111' })]), 'BadViewer');
  went('the friend asks to use a new phone', await w.send(g.s, [await requestViewerIx({ owner: g.s, room: P, viewer: phone2 })]));
  went('anyone applies it', await w.send(mallory, [await applyViewerIx({ room: P, owner: g.s.address })]));
  check('their record now names the new phone', (await member(P, g.s.address)).viewer === phone2);
  const phone3 = (await w.person()).address;
  went('asking again replaces the request', await w.send(g.s, [await requestViewerIx({ owner: g.s, room: P, viewer: phone3 })]));
  await w.send(mallory, [await applyViewerIx({ room: P, owner: g.s.address })]);
  check('and the newest phone wins', (await member(P, g.s.address)).viewer === phone3);
  // nobody can put their phone on someone else's record: the request names its owner and the member must match
  const mal = await w.person();
  await w.send(mal, [await requestViewerIx({ owner: mal, room: P, viewer: mal.address })]);
  const steal = { ...(await applyViewerIx({ room: P, owner: mal.address })) };
  steal.accounts = [steal.accounts[0], (await applyViewerIx({ room: P, owner: g.s.address })).accounts[1]];
  refused('a stranger\'s request can\'t change a member\'s viewer', await w.send(mallory, [steal]), 'WrongRoom');
  check('the member still has their own phone', (await member(P, g.s.address)).viewer === phone3);
}

section('Rooms from before viewer keys keep working');
{
  const os_ = await w.person();
  const o0 = await w.tokenAccount(w.usdcMint, os_.address, USDC(10));
  await w.send(os_, [await openVaultIx({ payer: os_, owner: os_, usdcMint: w.usdcMint, assetMint: w.assetMint })]);
  await w.send(os_, [await depositIx({ owner: os_, from: o0, usdcMint: w.usdcMint, amount: USDC(5) })]);
  const o = { s: os_, ...(await vaultAddresses(os_.address)) };
  went('an older room\'s saver', await w.send(o.s, [await createRoomIx({ creator: o.s, roomId: 31n, name: 'Old crew' })]));
  const OR = await roomPda(o.s.address, 31n);
  await w.send(o.s, [await joinRoomIx({ owner: o.s, room: OR, userVault: o.userVault, session: o.s.address, sessionExpires: Number(w.now()) + 86400 * 7 })]);
  // as the record was before viewer keys: 32 bytes shorter
  const at = await memberPda(OR, o.s.address); const acc = w.svm.getAccount(at);
  w.svm.setAccount({ ...acc, address: at, data: acc.data.slice(0, acc.data.length - 32), space: BigInt(acc.data.length - 32) });
  const usdc = await w.tokenAccount(w.usdcMint, o.s.address, USDC(5));
  await w.send(o.s, [await depositIx({ owner: o.s, from: usdc, usdcMint: w.usdcMint, amount: USDC(2) })]);
  refused('an old record can\'t be checked in', await w.send(o.s, [await checkInIx({ signer: o.s, room: OR, owner: o.s.address, userVault: o.userVault })]), 'AccountDidNotDeserialize');
  const anyone = await w.person();
  went('anyone upgrades it', await w.send(anyone, [upgradeMemberIx({ payer: anyone, member: at })]));
  check('it is the new size, with its streak and session intact', w.svm.getAccount(at).data.length === 201 && (await member(OR, o.s.address)).sessionExpires > 0n);
  went('and the save counts now', await w.send(o.s, [await checkInIx({ signer: o.s, room: OR, owner: o.s.address, userVault: o.userVault })]));
  refused('a record already up to date is left alone', await w.send(anyone, [upgradeMemberIx({ payer: anyone, member: at })]), 'NotAnOldRecord');
  refused('and so is anything that isn\'t a member record', await w.send(anyone, [upgradeMemberIx({ payer: anyone, member: OR })]), 'NotAnOldRecord');
}

section('Kashutags');
{
  const ada = await w.person(), bo = await w.person();
  went('Ada claims $ada', await w.send(ada, [await claimTagIx({ owner: ada, tag: 'ada' })]));
  check('$ada points at Ada\'s wallet', readTag(w.svm.getAccount(await tagPda('ada')).data).owner === ada.address);
  check('and Ada\'s wallet names $ada', readTagOf(w.svm.getAccount(await tagOfPda(ada.address)).data) === 'ada');
  check('nobody else can take $ada', !(await w.send(bo, [await claimTagIx({ owner: bo, tag: 'ada' })])).ok);
  check('one tag per wallet: Ada can\'t claim a second', !(await w.send(ada, [await claimTagIx({ owner: ada, tag: 'ada2' })])).ok);
  // the program accepts exactly one spelling, whatever a client sends
  for (const [label, raw] of [['capitals', 'Bob'], ['a leading number', '1bo'], ['too few letters', 'bo'], ['a space', 'b o b'], ['a dash', 'b-ob']]) {
    const t = await w.send(bo, [{ ...(await claimTagIx({ owner: bo, tag: 'bobby' })), data: new Uint8Array([...(await claimTagIx({ owner: bo, tag: 'bobby' })).data.subarray(0, 8), ...tagBytes(raw)]),
      accounts: (await claimTagIx({ owner: bo, tag: raw })).accounts }]);
    refused(`a tag with ${label} is refused`, t, 'BadTag');
  }
  // "bo", a zero, then "b": would read as "bo" on screen while being a different record
  refused('and so is one with bytes hiding after its end', await w.send(bo, [await claimTagIx({ owner: bo, tag: 'bo\u0000b' })]), 'BadTag');
  refused('a name kept for Kashu is refused', await w.send(bo, [await claimTagIx({ owner: bo, tag: 'support' })]), 'ReservedTag');
  check('the app reads "$Ada " as ada', normalTag('$Ada ').tag === 'ada' && normalTag('kashu').tag === null && normalTag('1x').tag === null);
  went('Bo claims $bo_99', await w.send(bo, [await claimTagIx({ owner: bo, tag: 'bo_99' })]));
  const boLamports = BigInt(w.svm.getAccount(bo.address).lamports);
  const tagRent = BigInt(w.svm.getAccount(await tagPda('bo_99')).lamports);
  went('Bo changes to $bobo', await w.send(bo, [await changeTagIx({ owner: bo, from: 'bo_99', to: 'bobo' })]));
  check('the old tag\'s rent moved to the new one: Bo paid only the fee, and got no rent back', BigInt(w.svm.getAccount(bo.address).lamports) === boLamports - 5000n && BigInt(w.svm.getAccount(await tagPda('bobo')).lamports) === tagRent);
  check('$bobo points at Bo, and Bo\'s wallet names it', readTag(w.svm.getAccount(await tagPda('bobo')).data).owner === bo.address && readTagOf(w.svm.getAccount(await tagOfPda(bo.address)).data) === 'bobo');
  check('$bo_99 is let go', !w.svm.getAccount(await tagPda('bo_99'))?.data?.length);
  went('and anyone can take $bo_99 now', await w.send(ada, [await changeTagIx({ owner: ada, from: 'ada', to: 'bo_99' })]));
  check('Bo can\'t change Ada\'s tag', !(await w.send(bo, [{ ...(await changeTagIx({ owner: bo, from: 'bo_99', to: 'stolen' })) }])).ok);
  const dusted = await tagPda('dusty');
  w.svm.setAccount({ address: dusted, data: new Uint8Array(0), executable: false, programAddress: '11111111111111111111111111111111', space: 0n, lamports: 1n });
  went('a lamport sent to a free name\'s address doesn\'t block it', await w.send(bo, [await changeTagIx({ owner: bo, from: 'bobo', to: 'dusty' })]));
  went('(and back)', await w.send(bo, [await changeTagIx({ owner: bo, from: 'dusty', to: 'bobo' })]));
  refused('nor change onto a tag someone holds', await w.send(bo, [await changeTagIx({ owner: bo, from: 'bobo', to: 'bo_99' })]), 'TagTaken');
}

section('Private pockets');
{
  const ada = await w.person(), k1 = (await w.person()).address, k2 = (await w.person()).address;
  went('Ada names her private pocket', await w.send(ada, [await setPocketIx({ owner: ada, pocket: k1 })]));
  check('her wallet now names it', readPocketOf(w.svm.getAccount(await pocketOfPda(ada.address)).data) === k1);
  const paid = BigInt(w.svm.getAccount(ada.address).lamports);
  went('and can change it', await w.send(ada, [await setPocketIx({ owner: ada, pocket: k2 })]));
  check('the record is reused: changing costs only the fee', readPocketOf(w.svm.getAccount(await pocketOfPda(ada.address)).data) === k2 && BigInt(w.svm.getAccount(ada.address).lamports) === paid - 5000n);
  refused('an empty key is refused', await w.send(ada, [await setPocketIx({ owner: ada, pocket: '11111111111111111111111111111111' })]), 'BadPocket');
}

section('Profile photos');
{
  const ada = await w.person(), mal = await w.person();
  const h = new Uint8Array(32).fill(7);
  went('Ada sets her photo', await w.send(ada, [await setAvatarIx({ owner: ada, hash: h })]));
  check('her wallet names that image', readAvatarOf(w.svm.getAccount(await avatarOfPda(ada.address)).data) === '07'.repeat(32));
  const ix = await setAvatarIx({ owner: ada, hash: new Uint8Array(32).fill(9) });
  check('nobody else can change it', !(await w.send(mal, [{ ...ix, accounts: ix.accounts.map((x, i) => (i === 0 ? { address: mal.address, role: 3, signer: mal } : x)) }])).ok);
  went('she removes it', await w.send(ada, [await setAvatarIx({ owner: ada, hash: new Uint8Array(32) })]));
  check('and it reads as no photo', readAvatarOf(w.svm.getAccount(await avatarOfPda(ada.address)).data) === null);
}

section('A room left behind catches up');
{
  const c = await w.person();
  await w.send(c, [await createRoomIx({ creator: c, roomId: 41n, name: 'Behind crew' })]);
  const B = await roomPda(c.address, 41n);
  const start = (await room(B)).week;
  w.setTime(w.now() + WEEK * 5n + 60n); // five weeks and a minute later, nobody pressed anything
  went('next week, after five weeks of nothing', await w.send(c, [nextWeekIx({ anyone: c, room: B })]));
  const r1 = await room(B);
  check('the room jumps to the week running now, not one week on', r1.week === start + 5 && Number(w.now()) - Number(r1.weekStartsAt) < Number(WEEK), `week ${r1.week}`);
  refused('and that week is not over yet', await w.send(c, [nextWeekIx({ anyone: c, room: B })]), 'WeekNotOver');
}

section('Saving in dollars counts too');
{
  // a saver with room under the 50-dollar beta cap
  const ds = await w.person();
  const dUsdc0 = await w.tokenAccount(w.usdcMint, ds.address, USDC(20));
  await w.send(ds, [await openVaultIx({ payer: ds, owner: ds, usdcMint: w.usdcMint, assetMint: w.assetMint })]);
  await w.send(ds, [await depositIx({ owner: ds, from: dUsdc0, usdcMint: w.usdcMint, amount: USDC(10) })]);
  const d = { s: ds, ...(await vaultAddresses(ds.address)) };
  went('a saver keeps everything in dollars (no SOL)', await w.send(d.s, [await setRuleIx(d.s, { weeklyAmount: USDC(5), roundupUnit: 0n, assetBps: 0 })]));
  went('and starts a room', await w.send(d.s, [await createRoomIx({ creator: d.s, roomId: 9n, name: 'Dollar crew' })]));
  const D = await roomPda(d.s.address, 9n);
  went('and joins it', await w.send(d.s, [await joinRoomIx({ owner: d.s, room: D, userVault: d.userVault, session: d.s.address, sessionExpires: Number(w.now()) + 86400 * 7 })]));
  const usdc = await w.tokenAccount(w.usdcMint, d.s.address, USDC(10));
  went('she saves fifty cents', await w.send(d.s, [await depositIx({ owner: d.s, from: usdc, usdcMint: w.usdcMint, amount: USDC(0.5) })]));
  refused('fifty cents is saved but does not count as this week\'s save', await w.send(d.s, [await checkInIx({ signer: d.s, room: D, owner: d.s.address, userVault: d.userVault })]), 'NoNewSave');
  went('then two dollars', await w.send(d.s, [await depositIx({ owner: d.s, from: usdc, usdcMint: w.usdcMint, amount: USDC(2) })]));
  went('two dollars does, with no SOL bought', await w.send(d.s, [await checkInIx({ signer: d.s, room: D, owner: d.s.address, userVault: d.userVault })]));
  const m = await member(D, d.s.address);
  check('her window lights: streak 1, one ticket', m.streak === 1 && m.tickets === 1);
}

section('Cheers');
went('Bayo cheers Ada', await w.send(bayo.s, [await cheerIx({ signer: bayo.s, room: R, from: bayo.s.address, to: ada.s.address })]));
refused('nobody cheers themselves', await w.send(bayo.s, [await cheerIx({ signer: bayo.s, room: R, from: bayo.s.address, to: bayo.s.address })]), 'SelfCheer');
refused('Mallory cannot cheer as Bayo', await w.send(mallory, [await cheerIx({ signer: mallory, room: R, from: bayo.s.address, to: ada.s.address })]), 'NotYourSeat');
check('Ada has one cheer', (await member(R, ada.s.address)).cheers === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
