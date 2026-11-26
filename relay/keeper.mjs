import crypto from 'node:crypto';
// Kashu's keeper: keeps every room's week moving so nobody has to.
//   - checks a member in when their vault shows a new save (members name the keeper as the one allowed to
//     count their saves; check-in can't move money, and the rooms program counts only real saves)
//   - when a week ends: asks MagicBlock's VRF for the draw, settles it with the member holding the winning
//     ticket, pays the room's prize pot to the winner's vault, and rolls the room to its next week
//   - on devnet, adds a small sponsor bonus to each pot each week (devnet interest is nearly zero)
// Rooms that live on the private rollup are left to the rollup flow. No websockets: confirmations are polled.
//
//   RPC_URL=<Helius> KEEPER_KEYPAIR=/run/keeper.json [BONUS_USDC=1] node relay/keeper.mjs
import fs from 'node:fs';
import { sendPush, validSubscription, vapidKeys } from './push.mjs';
import {
  address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, getProgramDerivedAddress, getAddressEncoder, getAddressDecoder, AccountRole, signBytes, getBase58Encoder, getBase58Decoder,
} from '@solana/kit';
import * as V from '../client/vault.mjs';
import * as R from '../client/rooms.mjs';
import { LEND_MARKETS } from '../client/markets.mjs';

const MARKET = LEND_MARKETS[process.env.CLUSTER || 'devnet'];

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL || !process.env.KEEPER_KEYPAIR) { console.error('Set RPC_URL and KEEPER_KEYPAIR.'); process.exit(1); }
const rpc = createSolanaRpc(RPC_URL);
const keyBytes = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEEPER_KEYPAIR, 'utf8')));
const me = await createKeyPairSignerFromBytes(keyBytes);
keyBytes.fill(0);
const USDC = address(process.env.USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
// Kashu's agent has its own key: it may only run the chores savers set (the vault checks every one); the keeper pays its fees
const agent = process.env.AGENT_KEYPAIR && fs.existsSync(process.env.AGENT_KEYPAIR)
  ? await (async () => { const b = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.AGENT_KEYPAIR, 'utf8'))); const k = await createKeyPairSignerFromBytes(b); b.fill(0); return k; })()
  : null;
const WEEK = Number(process.env.WEEK_SECS || 600);
const BONUS = BigInt(Math.round(Number(process.env.BONUS_USDC || 0) * 1e6));
const EVERY = Number(process.env.EVERY_MS || 45_000);
const ROOM_DISC = 'nMdDG94XuV4='; // base64 of sha256("account:Room")[0..8]
const enc = getAddressEncoder(), dec = getAddressDecoder();
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- proof: each room's latest transaction of each kind, for the app's "Behind the scenes" (relay serves it) ----
const PROOF_DIR = process.env.PROOF_DIR;
let current = null; // the room being tended
const KINDS = [
  [/to the private rollup/, 'private'], [/shared with|reader list checked|re-shared/, 'shared'], [/^checked in/, 'checkin'],
  [/draw asked/, 'vrf'], [/ticket \d+ is/, 'drawn'], [/draw result committed/, 'committed'], [/prize paid/, 'paid'],
  [/into the prize/, 'harvest'], [/sponsor bonus/, 'bonus'], [/week \d+ starts|nobody saved, next week/, 'week'],
];
function proof(label, sig, where) {
  if (!PROOF_DIR || !current) return;
  const kind = KINDS.find(([re]) => re.test(label))?.[1];
  if (!kind) return;
  try {
    const file = `${PROOF_DIR}/${current}.json`;
    const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    old[kind] = { sig, where, at: Date.now() };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(old)); fs.renameSync(`${file}.tmp`, file);
  } catch (e) { log(`proof: ${e.message}`); }
}

async function send(ixs, label, on = rpc) {
  const { value: blockhash } = await on.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(me, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ixs, m));
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(tx);
  await on.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: on !== rpc }).send();
  for (let i = 0; i < 30; i++) {
    const st = (await on.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err, (k, v) => (typeof v === "bigint" ? Number(v) : v))}`);
    if (st && st.confirmationStatus !== 'processed') { log(`${label}: ${sig}`); proof(label, sig, on === rpc ? 'solana' : 'tee'); return sig; }
    await sleep(1500);
  }
  throw new Error(`${label} not confirmed`);
}
const bytes = async (a) => {
  const v = (await rpc.getAccountInfo(address(a), { encoding: 'base64' }).send()).value;
  return v ? { owner: v.owner, data: Uint8Array.from(Buffer.from(v.data[0], 'base64')) } : null;
};
const ata = async (owner, mint) => (await getProgramDerivedAddress({ programAddress: address(V.ATA_PROGRAM), seeds: [owner, V.TOKEN_PROGRAM, mint].map((x) => enc.encode(address(x))) }))[0];
const errText = (e) => String(e?.context?.logs?.slice(-3).join(' ') || e?.message || e).slice(0, 240);

async function rooms() {
  // base58 filters (every node honours them), an exact size, and the tag checked here too: one node ignored a
  // filter on the delegation program and returned everything it holds
  const filters = [{ dataSize: 517n }, { memcmp: { offset: 0n, bytes: 'TDwuDPD9pEH', encoding: 'base58' } }];
  const isRoom = (a) => { const d = Buffer.from(a.account.data[0], 'base64'); return d.length === 517 && d.subarray(0, 8).equals(Buffer.from([156, 199, 67, 27, 222, 23, 185, 94])); };
  const home = (await rpc.getProgramAccounts(R.ROOMS_PROGRAM, { encoding: 'base64', filters }).send()).filter(isRoom);
  // a private room's copy on Solana is held by MagicBlock's delegation program and keeps the Room layout
  const away = (await rpc.getProgramAccounts(R.MB.delegation, { encoding: 'base64', filters }).send()).filter(isRoom);
  return [...home.map((a) => ({ address: a.pubkey, room: R.readRoom(Buffer.from(a.account.data[0], 'base64')), private: false })),
    ...away.map((a) => ({ address: a.pubkey, room: R.readRoom(Buffer.from(a.account.data[0], 'base64')), private: true }))];
}

// ---- the private rollup ----
const TEE = process.env.TEE_URL || 'https://devnet-tee-as.magicblock.app';
let tee = null, teeUntil = 0;
async function teeRpc() {
  if (tee && Date.now() < teeUntil) return tee;
  const c = await (await fetch(`${TEE}/auth/challenge?pubkey=${me.address}`)).json();
  const sig = await signBytes(me.keyPair.privateKey, new TextEncoder().encode(c.challenge));
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const b of sig) n = n * 256n + BigInt(b); let b58 = ''; while (n > 0n) { b58 = B58[Number(n % 58n)] + b58; n /= 58n; }
  const r = await (await fetch(`${TEE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pubkey: me.address, challenge: c.challenge, signature: b58 }) })).json();
  if (!r.token) throw new Error(`rollup sign-in refused: ${JSON.stringify(r).slice(0, 120)}`);
  tee = createSolanaRpc(`${TEE}?token=${r.token}`); teeUntil = Date.now() + 20 * 86400_000;
  return tee;
}
const teeBytes = async (a) => {
  const v = (await (await teeRpc()).getAccountInfo(address(a), { encoding: 'base64' }).send()).value;
  return v ? { owner: v.owner, data: Uint8Array.from(Buffer.from(v.data[0], 'base64')) } : null;
};
const MEMBER_SIZE = 8 + 161 + 32;
const legacy = new Set();
const sharedOnce = new Set(); // with the viewer key; older records can't go private

/** A room on Solana with members on the new layout goes to the private rollup: room, draw result, members; then shared. */
async function makePrivate(room, r) {
  for (const owner of r.roster) { const m = await bytes(await R.memberPda(room, owner)); if (!m || m.data.length !== MEMBER_SIZE) return false; }
  const missing = [...((await bytes(await R.resultPda(room))) ? [] : [await R.openResultIx({ payer: me, room })]), ...((await bytes(await V.potPda(room))) ? [] : [await V.openPotIx({ payer: me, room, usdcMint: USDC })])];
  if (missing.length) await send(missing, `${r.name}: prize pot and draw result opened`);
  await send([await R.delegateRoomIx({ payer: me, room, creator: r.creator, roomId: r.roomId }), await R.delegateResultIx({ payer: me, room })], `${r.name}: room and draw result to the private rollup`);
  for (const owner of r.roster) await send([await R.delegateMemberIx({ payer: me, room, owner })], `${r.name}: ${owner.slice(0, 4)}'s record to the private rollup`);
  for (let i = 0; i < 30 && !(await teeBytes(room)); i++) await sleep(1500);
  await send([await R.shareRoomIx({ payer: me, room, owners: r.roster })], `${r.name}: shared with its members' phones`, await teeRpc());
  return true;
}

/** Friends who asked to join a private room: their records are on Solana; send them over, seat them, share again. */
async function admitPending(room, r) {
  // base58 filter (the room's address already is one), and every record checked here too
  const roomBytes = Buffer.from(enc.encode(room));
  const asks = (await rpc.getProgramAccounts(R.ROOMS_PROGRAM, { encoding: 'base64', filters: [{ dataSize: BigInt(MEMBER_SIZE) }, { memcmp: { offset: 8n, bytes: room, encoding: 'base58' } }] }).send())
    .filter((a) => { const d = Buffer.from(a.account.data[0], 'base64'); return d.length === MEMBER_SIZE && d.subarray(8, 40).equals(roomBytes); });
  if (!asks.length) return r;
  for (const a of asks) {
    const owner = dec.decode(Buffer.from(a.account.data[0], 'base64').subarray(40, 72));
    await send([await R.delegateMemberIx({ payer: me, room, owner })], `${r.name}: ${owner.slice(0, 4)}'s join to the private rollup`);
    for (let i = 0; i < 30 && !(await teeBytes(await R.memberPda(room, owner))); i++) await sleep(1500);
    // a member already seated (joined on Solana before the room went private) only needed their record sent over
    if (!r.roster.includes(owner)) await send([await R.admitIx({ room, owner })], `${r.name}: ${owner.slice(0, 4)} seated`, await teeRpc());
  }
  const now = R.readRoom((await teeBytes(room)).data);
  await send([await R.shareRoomIx({ payer: me, room, owners: now.roster })], `${r.name}: shared with ${now.members} members' phones`, await teeRpc());
  return now;
}

/** "Add this phone": requests made on Solana for a new viewer key, applied on the rollup, then the room re-shared. */
async function applyPhones(room, r) {
  const asks = (await rpc.getProgramAccounts(R.ROOMS_PROGRAM, { encoding: 'base64', filters: [{ dataSize: 105n }, { memcmp: { offset: 8n, bytes: room, encoding: 'base58' } }] }).send())
    .map((a) => R.readViewerRequest(Buffer.from(a.account.data[0], 'base64'))).filter((q) => q.room === room && r.roster.includes(q.owner));
  let changed = false;
  for (const q of asks) {
    const m = await teeBytes(await R.memberPda(room, q.owner));
    if (!m || R.readMember(m.data).viewer === q.viewer) continue;
    await send([await R.applyViewerIx({ room, owner: q.owner })], `${r.name}: ${q.owner.slice(0, 4)}'s new phone added`, await teeRpc());
    changed = true;
  }
  if (changed) await send([await R.shareRoomIx({ payer: me, room, owners: r.roster })], `${r.name}: re-shared with the new phone`, await teeRpc());
}

/** A private room's week, on the rollup; the prize is paid on Solana from the committed draw result. */
async function tendPrivate(room) {
  const rb = await teeBytes(room);
  if (!rb) return; // not a reader of this room (no member named the keeper)
  // every private room has its prize pot on Solana (opened beside the room's committed copy)
  if (!opened.has(room)) {
    if (await bytes(await V.potPda(room))) opened.add(room);
    else await send([await V.openPotIx({ payer: me, room, usdcMint: USDC })], `prize pot opened for a private room`).then(() => opened.add(room), (e) => log(`pot: ${errText(e)}`));
  }
  let r = await admitPending(room, R.readRoom(rb.data));
  await applyPhones(room, r).catch((e) => log(`phones ${r.name}: ${errText(e)}`));
  // once per keeper start, every private room is (re)shared: a share that failed part-way would otherwise leave a
  // room on the rollup with no reader list, readable by anyone signed in there
  if (!sharedOnce.has(room)) {
    await send([await R.shareRoomIx({ payer: me, room, owners: r.roster })], `${r.name}: reader list checked`, await teeRpc()).then(() => sharedOnce.add(room), (e) => log(`share ${r.name}: ${errText(e)}`));
  }
  const on = await teeRpc();
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(r.weekStartsAt) + WEEK) {
    for (const owner of r.roster) {
      const m = await teeBytes(await R.memberPda(room, owner));
      if (!m) continue;
      const vault = dec.decode(m.data.subarray(72, 104)), session = dec.decode(m.data.subarray(104, 136)), mm = R.readMember(m.data);
      if (session !== me.address || Number(mm.sessionExpires) <= now || mm.lastSavedWeek === r.week) continue;
      const v = await bytes(vault);
      if (!v || V.readUserVault(v.data).buysDone <= mm.lastBuysDone) continue;
      await send([await R.checkInIx({ signer: me, room, owner, userVault: vault })], `checked in ${owner.slice(0, 4)} in ${r.name} (private)`, on).catch((e) => log(`check-in ${owner.slice(0, 4)}: ${errText(e)}`));
    }
    return;
  }
  if (r.tickets === 0) { await send([R.nextWeekIx({ anyone: me, room })], `${r.name}: nobody saved, next week (private)`, on); return; }
  if (r.drawState === 0 || r.drawWeek !== r.week) {
    await harvestRoom(room, r).catch((e) => log(`harvest ${r.name}: ${errText(e)}`));
    if (BONUS > 0n) await bonus(room, r).catch((e) => log(`bonus ${r.name}: ${errText(e)}`));
    await send([await R.requestDrawIx({ payer: me, room, queue: R.VRF_EPHEMERAL_QUEUE })], `${r.name}: draw asked on the private rollup for week ${r.week}`, on);
    return;
  }
  if (r.drawState === 1) return;
  if (r.drawState === 2) {
    // settling writes the result on the rollup; each week's commit brings it back undelegated (MagicBlock caps plain
    // commits at 10 per delegation), so send it back first. While its undelegation is still landing, try next round.
    const rb = await bytes(await R.resultPda(room));
    if (rb && rb.owner === R.ROOMS_PROGRAM) {
      await send([await R.delegateResultIx({ payer: me, room })], `${r.name}: draw result back to the private rollup`);
      return;
    }
    for (const owner of r.roster) {
      const mm = R.readMember((await teeBytes(await R.memberPda(room, owner))).data);
      if (mm.ticketWeek === r.week && mm.ticketStart <= r.winningTicket && r.winningTicket < mm.ticketStart + mm.tickets) {
        await send([await R.settleDrawIx({ room, owner })], `${r.name}: ticket ${r.winningTicket} is ${owner.slice(0, 4)}'s (private)`, on);
        return;
      }
    }
    return;
  }
  // settled: only the draw result goes back to Solana; the prize is paid there from it, then the next week starts
  const res = await bytes(await R.resultPda(room));
  if (!res || R.readResult(res.data).week < r.drawWeek) {
    await send([await R.commitResultIx({ payer: me, room })], `${r.name}: draw result committed to Solana (the room stays private)`, on);
    return;
  }
  const pot = await bytes(await V.potPda(room));
  if (pot && V.readPot(pot.data).paidThrough <= r.drawWeek) {
    await payPrize(room, r, `${r.name}: prize paid to ${r.winner.slice(0, 4)} from the committed result`);
    await notify(r.winner, { title: 'You won this week\'s draw!', body: `The prize is in your savings now. Open Kashu to see it.`, url: '/#app-savings', tag: 'win' }).catch((e) => log(`notify: ${errText(e)}`));
  }
  await send([R.nextWeekIx({ anyone: me, room })], `${r.name}: week ${r.week + 1} starts (private)`, on);
}

const opened = new Set();
async function tend({ address: room, room: r, private: away }) {
  if (away) return tendPrivate(room);
  // rooms from before member records carried a viewer key can't be settled any more: left alone, logged once
  if (legacy.has(room)) return;
  // member records from before viewer keys are brought up to date (Kashu pays the few extra bytes of rent)
  for (const owner of r.roster) {
    const at = await R.memberPda(room, owner), m = await bytes(at);
    if (!m || m.data.length === MEMBER_SIZE) continue;
    if (m.owner !== R.ROOMS_PROGRAM || m.data.length !== MEMBER_SIZE - 32) { legacy.add(room); log(`${r.name}: a record that can't be upgraded here, left alone`); return; }
    await send([R.upgradeMemberIx({ payer: me, member: at })], `${r.name}: ${owner.slice(0, 4)}'s record brought up to date`);
  }
  if (r.members > 0 && (await makePrivate(room, r).catch((e) => { log(`private ${r.name}: ${errText(e)}`); return false; }))) return;
  const now = Math.floor(Date.now() / 1000);
  // every room gets its prize pot (members join the prize with their first save)
  if (!opened.has(room)) {
    if (await bytes(await V.potPda(room))) opened.add(room);
    else await send([await V.openPotIx({ payer: me, room, usdcMint: USDC }), ...((await bytes(await R.resultPda(room))) ? [] : [await R.openResultIx({ payer: me, room })])], `${r.name}: prize pot and draw result opened`).then(() => opened.add(room), (e) => log(`pot ${r.name}: ${errText(e)}`));
  }
  const weekOver = now >= Number(r.weekStartsAt) + WEEK;
  // 1. count new saves, for members who let the keeper do it
  if (!weekOver) {
    for (const owner of r.roster) {
      const m = await bytes(await R.memberPda(room, owner));
      if (!m) continue;
      const d = m.data, vault = dec.decode(d.subarray(72, 104)), session = dec.decode(d.subarray(104, 136));
      const mm = R.readMember(d);
      if (session !== me.address || Number(mm.sessionExpires) <= now || mm.lastSavedWeek === r.week) continue;
      const v = await bytes(vault);
      if (!v || V.readUserVault(v.data).buysDone <= mm.lastBuysDone) continue;
      await send([await R.checkInIx({ signer: me, room, owner, userVault: vault })], `checked in ${owner.slice(0, 4)} in ${r.name}`).catch((e) => log(`check-in ${owner.slice(0, 4)}: ${errText(e)}`));
    }
    return;
  }
  // 2. the week is over: first the savers' interest goes into the prize (only what's worth a cent or more), then
  //    draw, settle, pay, move on
  if (r.drawState === 0 || r.drawWeek !== r.week) await harvestRoom(room, r).catch((e) => log(`harvest ${r.name}: ${errText(e)}`));

  if (r.tickets === 0) { await send([R.nextWeekIx({ anyone: me, room })], `${r.name}: nobody saved, next week`); return; }
  const thisWeek = r.drawWeek === r.week;
  if (!thisWeek || r.drawState === 0) {
    if (BONUS > 0n) await bonus(room).catch((e) => log(`bonus ${r.name}: ${errText(e)}`));
    await send([await R.requestDrawIx({ payer: me, room })], `${r.name}: draw asked for week ${r.week}`);
    return;
  }
  if (r.drawState === 1) return; // waiting on the oracle
  if (r.drawState === 2) {
    // settling writes the result on the rollup; each week's commit brings it back undelegated (MagicBlock caps plain
    // commits at 10 per delegation), so send it back first. While its undelegation is still landing, try next round.
    const rb = await bytes(await R.resultPda(room));
    if (rb && rb.owner === R.ROOMS_PROGRAM) {
      await send([await R.delegateResultIx({ payer: me, room })], `${r.name}: draw result back to the private rollup`);
      return;
    }
    for (const owner of r.roster) {
      const m = await bytes(await R.memberPda(room, owner));
      if (!m) continue;
      const mm = R.readMember(m.data);
      if (mm.ticketWeek === r.week && mm.ticketStart <= r.winningTicket && r.winningTicket < mm.ticketStart + mm.tickets) {
        await send([await R.settleDrawIx({ room, owner })], `${r.name}: ticket ${r.winningTicket} is ${owner.slice(0, 4)}'s`);
        return;
      }
    }
    log(`${r.name}: no member holds ticket ${r.winningTicket}`);
    return;
  }
  if (r.drawState === 3) {
    const pot = await bytes(await V.potPda(room));
    if (pot && V.readPot(pot.data).paidThrough <= r.drawWeek) {
      await payPrize(room, r, `${r.name}: prize paid to ${r.winner.slice(0, 4)}`);
    await notify(r.winner, { title: 'You won this week\'s draw!', body: `The prize is in your savings now. Open Kashu to see it.`, url: '/#app-savings', tag: 'win' }).catch((e) => log(`notify: ${errText(e)}`));
    }
    await send([R.nextWeekIx({ anyone: me, room })], `${r.name}: week ${r.week + 1} starts`);
  }
}

/** Moves each linked saver's interest into the room's pot, Kashu's cut to the admin's dollar account. */
let treasury = null;
// every prize paid is added to the winner's running total (prizes.json, served by the relay), so "Prizes won" is real
async function payPrize(room, r, label) {
  const potUsdc = await V.potUsdcPda(room);
  const before = BigInt((await rpc.getTokenAccountBalance(potUsdc, { commitment: 'confirmed' }).send()).value.amount);
  await send([await V.payPrizeIx({ cranker: me, room, winner: r.winner, usdcMint: USDC })], label);
  if (!PROOF_DIR || before === 0n) return;
  const file = `${PROOF_DIR}/prizes.json`;
  try {
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const was = all[r.winner] ?? { won: 0, prizes: 0 };
    all[r.winner] = { won: was.won + Number(before), prizes: was.prizes + 1 };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(all)); fs.renameSync(`${file}.tmp`, file);
  } catch (e) { log(`prizes ledger: ${e.message}`); }
}
async function harvestRoom(room, r) {
  if (!treasury) {
    const cfg = V.readConfig((await bytes(await V.configPda())).data);
    treasury = await ata(cfg.admin, USDC);
  }
  const price = V.tokenExchangePrice((await bytes(MARKET.lending)).data);
  for (const owner of r.roster) {
    const va = await V.vaultAddresses(owner);
    const link = await bytes(await V.linkPda(va.userVault));
    if (!link || dec.decode(link.data.subarray(8, 40)) !== room) continue;
    const shares = await bytes(await V.shareAccount(va.userVault, MARKET.fTokenMint));
    const v = await bytes(va.userVault);
    if (!shares || !v) continue;
    const held = Buffer.from(shares.data).readBigUInt64LE(64);
    const interest = (held * price) / 1_000_000_000_000n - V.readUserVault(v.data).lentPrincipal - 2n;
    if (interest < 10_000n) continue; // under a cent: not worth a transaction
    await send([await V.harvestIx({ cranker: me, owner, room, treasury, usdcMint: USDC, market: MARKET })], `${r.name}: ${owner.slice(0, 4)}'s interest (${Number(interest) / 1e6} USDC) into the prize`);
  }
}

/** A sponsor's Friday bonus on devnet: test USDC from the keeper into the pot, once per week. */
const bonused = new Set();
async function bonus(room, known) {
  const r = known ?? R.readRoom((await bytes(room)).data);
  const key = `${room}:${r.week}`;
  if (bonused.has(key) || !(await bytes(await V.potPda(room)))) return;
  const from = await ata(me.address, USDC);
  const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(BONUS, 1);
  await send([{ programAddress: address(V.TOKEN_PROGRAM), data: new Uint8Array(b), accounts: [
    { address: from, role: AccountRole.WRITABLE }, { address: await V.potUsdcPda(room), role: AccountRole.WRITABLE }, { address: me.address, role: AccountRole.READONLY_SIGNER, signer: me }] }], `${r.name}: sponsor bonus ${Number(BONUS) / 1e6} USDC`);
  bonused.add(key);
}

// ---- cheers: filed by the relay, each signed by the sender's phone; checked here against the room's own records ----
const INBOX = process.env.INBOX_DIR;
const cheered = new Set();
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const b58 = getBase58Encoder();
// ---- win notifications: subscriptions checked against the member's phone key, kept where only the keeper reads ----
const SUBS = PROOF_DIR ? `${PROOF_DIR}/subs` : null;
if (SUBS) fs.mkdirSync(SUBS, { recursive: true });
const subsOf = (owner) => { try { return JSON.parse(fs.readFileSync(`${SUBS}/${owner}.json`, 'utf8')); } catch { return []; } };
const saveSubs = (owner, list) => { fs.writeFileSync(`${SUBS}/${owner}.tmp`, JSON.stringify(list.slice(-5))); fs.renameSync(`${SUBS}/${owner}.tmp`, `${SUBS}/${owner}.json`); };
async function pushSubscription(file) {
  let p; try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { p = null; }
  try { fs.unlinkSync(file); } catch { /* gone */ }
  if (!p || !SUBS || !validSubscription(p.sub)) return;
  try {
    const priv = (await bytes(p.room))?.owner === 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
    const m = await (priv ? teeBytes : bytes)(await R.memberPda(p.room, p.owner));
    if (!m || m.data.length < 201) return log('push refused: not a member');
    const viewer = Buffer.from(m.data.subarray(169, 201));
    const ok = !viewer.every((x) => x === 0) && crypto.verify(null, Buffer.from(`kashu-push:${p.room}:${p.sub.endpoint}`), crypto.createPublicKey({ key: Buffer.concat([SPKI, viewer]), format: 'der', type: 'spki' }), Buffer.from(b58.encode(p.sig)));
    if (!ok) return log(`push refused: bad signature for ${p.owner.slice(0, 4)}`);
    const list = subsOf(p.owner).filter((x) => x.endpoint !== p.sub.endpoint);
    saveSubs(p.owner, [...list, p.sub]);
    log(`${p.owner.slice(0, 4)} will hear about wins on ${new URL(p.sub.endpoint).hostname}`);
  } catch (e) { log(`push: ${errText(e)}`); }
}
/** Tells a member's phones something (a win). Expired subscriptions are dropped. */
async function notify(owner, message) {
  if (!SUBS) return;
  const keys = vapidKeys(process.env.VAPID_FILE || '/run/vapid.json');
  const list = subsOf(owner), keep = [];
  for (const sub of list) { const r = await sendPush(sub, message, keys); if (r !== 'gone') keep.push(sub); if (r === 'ok') log(`told ${owner.slice(0, 4)}: ${message.title}`); }
  if (keep.length !== list.length) saveSubs(owner, keep);
}

async function cheers() {
  if (!INBOX) return;
  for (const f of fs.readdirSync(INBOX).filter((n) => n.startsWith('push-') && n.endsWith('.json')).slice(0, 50)) await pushSubscription(`${INBOX}/${f}`);
  for (const f of fs.readdirSync(INBOX).filter((n) => !n.startsWith('push-') && n.endsWith('.json')).slice(0, 50)) {
    const file = `${INBOX}/${f}`;
    let c; try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { c = null; }
    try { fs.unlinkSync(file); } catch { /* gone */ }
    if (!c) continue;
    const key = `${c.room}.${c.from}.${c.to}.${c.week}`;
    if (cheered.has(key)) { log('cheer refused: already cheered this friend this week'); continue; }
    try {
      const priv = (await bytes(c.room))?.owner === 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
      const read = priv ? teeBytes : bytes;
      const rb = await read(c.room); if (!rb) continue;
      const r = R.readRoom(rb.data);
      // a cheer signed for this week or the one that just ended still counts (cheers are counts; repeats are refused above)
      if (c.week > r.week || c.week + 1 < r.week) { log(`cheer refused: week ${c.week}, room is on ${r.week}`); continue; }
      if (!r.roster.includes(c.from) || !r.roster.includes(c.to)) { log('cheer refused: not both in the room'); continue; }
      const m = await read(await R.memberPda(c.room, c.from)); if (!m || m.data.length < 201) continue;
      const viewer = Buffer.from(m.data.subarray(169, 201));
      if (viewer.every((x) => x === 0)) { log('cheer refused: sender has no phone key'); continue; }
      const msg = Buffer.from(`kashu-cheer:${c.room}:${c.to}:${c.week}`);
      const ok = crypto.verify(null, msg, crypto.createPublicKey({ key: Buffer.concat([SPKI, viewer]), format: 'der', type: 'spki' }), Buffer.from(b58.encode(c.sig)));
      if (!ok) { log(`cheer refused: bad signature for ${c.from.slice(0, 4)}`); continue; }
      cheered.add(key);
      await send([await R.cheerIx({ signer: me, room: c.room, from: c.from, to: c.to })], `${r.name}: ${c.from.slice(0, 4)} cheered ${c.to.slice(0, 4)}`, priv ? await teeRpc() : rpc);
    } catch (e) { log(`cheer: ${errText(e)}`); }
  }
}
(async () => { for (;;) { await cheers().catch((e) => log(`cheers: ${errText(e)}`)); await sleep(3000); } })();

// ---- the agent: chores from policies that name it, run when due ----
// Kashu's treasury for the agent's one-cent fee per run: the vault admin's dollar account (the vault checks the owner)
const TREASURY_OWNER = process.env.TREASURY_OWNER || 'Hk3Eo6rZJSeSD1MMXmwyaVRFiSrrYMCq686Q3XzL6D44';
const POLICY_SIZE = 8 + 32 + 32 + 8 + 8 + 8 + 4 * 32 + 4 * 20 + 1;
// devnet weeks are ten minutes, so there a chore runs as soon as the vault allows; on mainnet at its weekday and hour (UTC)
const ON_SCHEDULE = process.env.AGENT_SCHEDULE !== 'asap';
const reminded = new Map(), choreFailed = new Map();
async function agentRound() {
  if (!agent) return;
  const list = (await rpc.getProgramAccounts(V.VAULT_PROGRAM, { encoding: 'base64', filters: [{ dataSize: BigInt(POLICY_SIZE) }, { memcmp: { offset: 40n, bytes: agent.address, encoding: 'base58' } }] }).send());
  const now = new Date(), t = Math.floor(now.getTime() / 1000);
  for (const a of list) {
    const p = V.readPolicy(Buffer.from(a.account.data[0], 'base64'));
    if (p.agent !== agent.address) continue;
    const vb = await bytes(p.userVault); if (!vb) continue;
    const owner = V.readUserVault(vb.data).owner;
    for (let i = 0; i < 4; i++) {
      const c = p.chores[i];
      if (!c.kind) continue;
      const due = !ON_SCHEDULE || (now.getUTCDay() === c.weekday && now.getUTCHours() === c.hour);
      if (!due) continue;
      if (c.kind === V.CHORE.REMIND) {
        const key = `${a.pubkey}.${i}`;
        if (Date.now() - (reminded.get(key) ?? 0) < (ON_SCHEDULE ? 2 * 3600_000 : WEEK * 1000)) continue;
        reminded.set(key, Date.now());
        await notify(owner, { title: 'Payday reminder', body: 'Your agent here: you haven\'t saved this week yet. Your room is waiting.', url: '/#app-save', tag: 'remind' }).catch(() => {});
        continue;
      }
      if (c.lastRun && t < Number(c.lastRun) + V.CHORE_GAP) continue;
      const failKey = `${a.pubkey}.${i}`;
      if (Date.now() - (choreFailed.get(failKey) ?? 0) < 600_000) continue; // a chore that just failed (say, the wallet is short) waits ten minutes
      if (p.spent + c.amount > p.weeklyCap && t < Number(p.windowStart) + V.CAP_WINDOW) continue;
      const va = await V.vaultAddresses(owner);
      const to = c.kind === V.CHORE.SAVE ? va.cash
        : c.kind === V.CHORE.SAVE_PRIVATE ? await (async () => { const r = await bytes(await R.pocketOfPda(owner)); return r ? ata(R.readPocketOf(r.data), USDC) : null; })()
        : await ata(p.payees[c.payee], USDC);
      if (!to || !(await bytes(to))) { log(`agent: ${owner.slice(0, 4)}'s chore ${i} has nowhere to go yet`); continue; }
      const what = ['', 'saved', 'saved privately', 'paid a payee', ''][c.kind];
      await send([await V.agentRunIx({ agent, owner, chore: i, from: await ata(owner, USDC), to, usdcMint: USDC, treasury: await ata(TREASURY_OWNER, USDC) })], `agent ${what} ${Number(c.amount) / 1e6} USDC for ${owner.slice(0, 4)}`)
        .then(() => { if (c.kind !== V.CHORE.PAY) return; return notify(owner, { title: 'Your agent paid someone', body: `${Number(c.amount) / 1e6} dollars, as you asked. Open Kashu for the receipt.`, url: '/#app-agent', tag: 'agent' }); })
        .catch((e) => { choreFailed.set(failKey, Date.now()); log(`agent chore ${owner.slice(0, 4)}/${i}: ${errText(e)}`); });
    }
  }
}
if (agent && PROOF_DIR) { try { fs.writeFileSync(`${PROOF_DIR}/agent-address`, agent.address); } catch { /* the app falls back to no agent */ } }
if (agent) { log(`agent ${agent.address} (${ON_SCHEDULE ? 'on schedule' : 'as soon as allowed'})`); (async () => { for (;;) { await agentRound().catch((e) => log(`agent round: ${errText(e)}`)); await sleep(60_000); } })(); }

// ---- the weekly buy: savers whose plan puts part of each week into SOL get that part bought when their week is up.
// Devnet routes through the stub venue priced from Pyth; mainnet needs a Jupiter route first, so it is skipped there.
const ON_DEVNET = (process.env.CLUSTER || 'devnet') === 'devnet';
const ASSET = address(process.env.ASSET_MINT || 'So11111111111111111111111111111111111111112');
const PRICE_FEED = address(process.env.PRICE_FEED || '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
const VAULT_DISC = getBase58Decoder().decode(crypto.createHash('sha256').update('account:UserVault').digest().subarray(0, 8));
const buyFailed = new Map();
const openAta = async (owner, mint) => ({
  programAddress: address(V.ATA_PROGRAM), data: new Uint8Array([1]),
  accounts: [{ address: me.address, role: AccountRole.WRITABLE_SIGNER, signer: me }, { address: await ata(owner, mint), role: AccountRole.WRITABLE },
    { address: address(owner), role: AccountRole.READONLY }, { address: mint, role: AccountRole.READONLY },
    { address: address('11111111111111111111111111111111'), role: AccountRole.READONLY }, { address: address(V.TOKEN_PROGRAM), role: AccountRole.READONLY }],
});
async function buyRound() {
  if (!ON_DEVNET) return;
  const list = await rpc.getProgramAccounts(V.VAULT_PROGRAM, { encoding: 'base64', filters: [{ memcmp: { offset: 0n, bytes: VAULT_DISC, encoding: 'base58' } }] }).send();
  const t = Math.floor(Date.now() / 1000);
  for (const a of list) {
    const v = V.readUserVault(Buffer.from(a.account.data[0], 'base64'));
    if (!v.assetBps || Number(v.nextBuyAt) > t) continue;
    const spend = V.thisWeekSpend(v);
    if (spend < 10_000n) continue; // under a cent: nothing worth buying this week
    if (Date.now() - (buyFailed.get(a.pubkey) ?? 0) < 600_000) continue;
    const va = await V.vaultAddresses(v.owner);
    try {
      const missing = [];
      for (const mint of [USDC, ASSET]) if (!(await bytes(await ata(va.swapAuthority, mint)))) missing.push(await openAta(va.swapAuthority, mint));
      if (missing.length) await send(missing, `weekly buy: swap accounts opened for ${v.owner.slice(0, 4)}`);
      if (v.cashTracked < spend) await send([await V.prepareBuyIx({ cranker: me, owner: v.owner, usdcMint: USDC, market: MARKET })], `weekly buy: ${Number(spend - v.cashTracked) / 1e6} USDC back from Jupiter Lend for ${v.owner.slice(0, 4)}`);
      const held = async () => BigInt((await rpc.getTokenAccountBalance(va.hold, { commitment: 'confirmed' }).send().catch(() => ({ value: { amount: '0' } }))).value.amount);
      const before = await held();
      await send([await V.weeklyBuyIx({ cranker: me, owner: v.owner, usdcMint: USDC, assetMint: ASSET, priceUpdate: PRICE_FEED, amountIn: spend })], `weekly buy: ${Number(spend) / 1e6} USDC into SOL for ${v.owner.slice(0, 4)}`);
      const got = (await held()) - before;
      await notify(v.owner, { title: 'Your weekly buy is done', body: `${Number(spend) / 1e6} dollars of your savings became ${(Number(got) / 1e9).toFixed(5)} SOL.`, url: '/#app-save', tag: 'buy' }).catch(() => {});
    } catch (e) { buyFailed.set(a.pubkey, Date.now()); log(`weekly buy ${v.owner.slice(0, 4)}: ${errText(e)}`); }
  }
}
(async () => { for (;;) { await buyRound().catch((e) => log(`buy round: ${errText(e)}`)); await sleep(120_000); } })();
// ---- winnings into SOL: savers who chose a weekly amount from their prize winnings get it bought when due
const WINNINGS_DISC = getBase58Decoder().decode(crypto.createHash('sha256').update('account:Winnings').digest().subarray(0, 8));
async function winningsRound() {
  if (!ON_DEVNET) return;
  const list = await rpc.getProgramAccounts(V.VAULT_PROGRAM, { encoding: 'base64', filters: [{ memcmp: { offset: 0n, bytes: WINNINGS_DISC, encoding: 'base58' } }] }).send();
  const t = Math.floor(Date.now() / 1000);
  for (const a of list) {
    const x = V.readWinnings(Buffer.from(a.account.data[0], 'base64'));
    if (!x.weekly || !x.left || Number(x.nextAt) > t) continue;
    if (Date.now() - (buyFailed.get(a.pubkey) ?? 0) < 600_000) continue;
    const vb = await bytes(x.vault); if (!vb) continue;
    const v = V.readUserVault(vb.data);
    const spend = [x.weekly, x.left, v.cashTracked].reduce((p, q) => (p < q ? p : q));
    if (spend < 10_000n) continue;
    const va = await V.vaultAddresses(v.owner);
    try {
      const missing = [];
      for (const mint of [USDC, ASSET]) if (!(await bytes(await ata(va.swapAuthority, mint)))) missing.push(await openAta(va.swapAuthority, mint));
      if (missing.length) await send(missing, `winnings buy: swap accounts opened for ${v.owner.slice(0, 4)}`);
      await send([await V.dcaBuyIx({ cranker: me, owner: v.owner, usdcMint: USDC, assetMint: ASSET, priceUpdate: PRICE_FEED, amountIn: spend })], `winnings buy: ${Number(spend) / 1e6} USDC of prizes into SOL for ${v.owner.slice(0, 4)}`);
      await notify(v.owner, { title: 'Your winnings bought SOL', body: `${Number(spend) / 1e6} dollars of your prize money became SOL. Your own savings weren't touched.`, url: '/#app-savings', tag: 'dca' }).catch(() => {});
    } catch (e) { buyFailed.set(a.pubkey, Date.now()); log(`winnings buy ${v.owner.slice(0, 4)}: ${errText(e)}`); }
  }
}
(async () => { for (;;) { await winningsRound().catch((e) => log(`winnings round: ${errText(e)}`)); await sleep(120_000); } })();

// ---- profile photos: once a day, photos uploaded over a day ago that no wallet names on chain are deleted ----
const AVATARS = process.env.AVATAR_DIR;
const AVATAR_DISC = Buffer.from([201, 2, 211, 0, 105, 152, 231, 77]);
async function sweepAvatars() {
  if (!AVATARS || !fs.existsSync(AVATARS)) return;
  const named = new Set((await rpc.getProgramAccounts(R.ROOMS_PROGRAM, { encoding: 'base64', filters: [{ dataSize: 41n }, { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(AVATAR_DISC), encoding: 'base58' } }] }).send())
    .map((a) => Buffer.from(a.account.data[0], 'base64')).filter((d) => d.subarray(0, 8).equals(AVATAR_DISC)).map((d) => d.subarray(8, 40).toString('hex')));
  let gone = 0;
  for (const f of fs.readdirSync(AVATARS).filter((n) => /^[0-9a-f]{64}\.webp$/.test(n))) { // photos only, never the removal list
    const at = `${AVATARS}/${f}`, hash = f.replace(/\.webp$/, '');
    if (named.has(hash) || Date.now() - fs.statSync(at).mtimeMs < 86_400_000) continue;
    try { fs.unlinkSync(at); gone++; } catch { /* next time */ }
  }
  if (gone) log(`photos: ${gone} nobody uses any more, deleted (${named.size} in use)`);
}
(async () => { for (;;) { await sweepAvatars().catch((e) => log(`photos: ${errText(e)}`)); await sleep(86_400_000); } })();

log(`kashu keeper ${me.address}, week ${WEEK} s`);
// every ten minutes: the keeper pays rent and fees for every room; say so loudly before it runs dry
(async () => { for (;;) { try { const l = Number((await rpc.getBalance(me.address, { commitment: 'confirmed' }).send()).value) / 1e9; if (l < Number(process.env.LOW_SOL || 0.3)) log(`LOW FUNDS: keeper has ${l} SOL; room actions that need rent will fail`); } catch { /* next time */ } await sleep(600_000); } })();
for (;;) {
  try {
    for (const r of await rooms()) {
      current = r.address;
      try { await tend(r); } catch (e) { log(`${r.room.name}: ${errText(e)} @ ${String(e?.stack || '').split('\n').filter((l) => l.includes('keeper.mjs')).slice(0, 2).map((l) => l.trim().replace(/.*keeper\.mjs:/, 'line ')).join(' < ')}`); }
    }
  } catch (e) { log(`round: ${errText(e)}`); }
  await sleep(EVERY);
}
