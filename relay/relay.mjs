import crypto from 'node:crypto';
// Kashu's relay: the app's only door to the chain. The Helius key and the sponsor key live here, never in the app.
//
//   POST /rpc      a JSON-RPC call, passed on only for the methods the app needs, under size and rate limits.
//   POST /sponsor  { tx: base64 }  a transaction whose fee payer is our sponsor. Signed and sent only when:
//                    - the sponsor is the fee payer and the only signer (passkeys sign inside Swig, not here)
//                    - it names every account itself (no lookup tables), and calls only the fee program,
//                      the passkey check and Swig at the top level, with a sane fee
//                    - simulated, it succeeds, every program that actually runs is on our list, and the
//                      sponsor loses no more than the fee plus a little rent
//                    - the wallet, the caller's address and the whole day are inside their budgets
//   GET  /health
// No websockets: upgrade requests are refused. Node built-ins plus @solana/kit for decoding and signing.
//
//   RPC_URL=<Helius>  SPONSOR_KEYPAIR=/run/sponsor.json  PORT=8830  ALLOW_ORIGIN=https://app.example  node relay/relay.mjs
import http from 'node:http';
import fs from 'node:fs';
import { validSubscription, vapidKeys } from './push.mjs';
import {
  createKeyPairFromBytes, getAddressFromPublicKey, getBase64Encoder, getBase64Decoder, getTransactionDecoder, getTransactionEncoder,
  getCompiledTransactionMessageDecoder, partiallySignTransaction, getBase58Encoder, getBase58Decoder, getProgramDerivedAddress, getAddressEncoder, address,
} from '@solana/kit';

const RPC_URL = process.env.RPC_URL;
const PORT = Number(process.env.PORT || 8830);
const ORIGINS = (process.env.ALLOW_ORIGIN || '').split(',').filter(Boolean);
if (!RPC_URL || !process.env.SPONSOR_KEYPAIR) { console.error('Set RPC_URL and SPONSOR_KEYPAIR.'); process.exit(1); }
const sponsorBytes = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.SPONSOR_KEYPAIR, 'utf8')));
const sponsorKeys = await createKeyPairFromBytes(sponsorBytes);
sponsorBytes.fill(0);
const SPONSOR = await getAddressFromPublicKey(sponsorKeys.publicKey);
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);

export const PROGRAMS = {
  COMPUTE: 'ComputeBudget111111111111111111111111111111',
  SECP256R1: 'Secp256r1SigVerify1111111111111111111111111',
  SWIG: 'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB',
  VAULT: process.env.VAULT_PROGRAM || '3jYUfoa788SJpFbbPS7vFxTNkWCRN1c4gx3rcgmH9GxH',
  ROOMS: process.env.ROOMS_PROGRAM || '8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  SYSTEM: '11111111111111111111111111111111',
};
const SWIG_CREATE = 0, SWIG_SIGN_V1 = 4, SWIG_SIGN_V2 = 11;
const TOP_LEVEL = new Set([PROGRAMS.COMPUTE, PROGRAMS.SECP256R1, PROGRAMS.SWIG]);
// Jupiter Lend runs inside a vault's lend and unlend; its programs are pinned by the vault itself
const RUNS = new Set([...Object.values(PROGRAMS), ...(process.env.EXTRA_PROGRAMS || '7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3,5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL').split(',')]);

export const LIMITS = {
  bodyBytes: 16 * 1024,
  rpcPerMinute: Number(process.env.RPC_PER_MINUTE || 120),
  sponsorPerHourPerIp: Number(process.env.SPONSOR_PER_HOUR_PER_IP || 30),
  maxLossPerTx: BigInt(process.env.MAX_LOSS_PER_TX || 20_000_000), // lamports: the fee plus rent for a new room, its pot and a membership
  perWalletPerDay: BigInt(process.env.PER_WALLET_PER_DAY || 30_000_000),
  perDay: BigInt(process.env.SPONSOR_PER_DAY || 500_000_000),
  maxUnitPrice: 2_000_000n, maxUnits: 1_400_000,
};
const READS = new Set(['getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'getSignatureStatuses', 'getSlot', 'getBlockHeight', 'getBalance',
  'getTokenAccountBalance', 'getMinimumBalanceForRentExemption', 'getFeeForMessage', 'isBlockhashValid', 'simulateTransaction', 'getEpochInfo', 'getHealth']);

// ---- small budgets, kept in memory and reset by the clock ----
const windows = new Map();
function spend(key, amount, limit, ms) {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now - w.start >= ms) { w = { start: now, used: 0n }; windows.set(key, w); }
  if (w.used + BigInt(amount) > BigInt(limit)) return false;
  w.used += BigInt(amount);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, w] of windows) if (now - w.start > 86_400_000) windows.delete(k); }, 600_000).unref();

async function upstream(method, params) {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  if (r.status === 429) throw Object.assign(new Error('the network is busy, try again in a moment'), { status: 503 });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { status: 400, rpc: j.error });
  return j.result;
}

// ---- private pockets (MagicBlock private payments) ----
const ESPL = 'SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2';
const USDC = process.env.USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const aenc = getAddressEncoder();
const ataOf = async (owner, mint) => (await getProgramDerivedAddress({ programAddress: address(PROGRAMS.ATA), seeds: [owner, PROGRAMS.TOKEN, mint].map((x) => aenc.encode(address(x))) }))[0];
const b64tx = (wireB64) => { const wire = getBase64Encoder().encode(wireB64); if (wire.length > 4096) throw new Error('transaction too large'); return wire; };

/** A transaction MagicBlock's gasless sponsor already pays for (a pocket's deposit or withdrawal): forwarded as is. We pay nothing. */
async function submitPrepaid(wireB64, ip) {
  if (!spend(`submit:${ip}`, 1, 30, 3_600_000)) throw Object.assign(new Error('too many requests, try again later'), { status: 429 });
  const tx = getTransactionDecoder().decode(b64tx(wireB64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!msg.instructions) throw new Error('unsupported transaction');
  const keys = msg.staticAccounts;
  const signers = keys.slice(0, msg.header.numSignerAccounts);
  if (signers.includes(SPONSOR)) throw new Error('that one is not ours to pay');
  if (Object.values(tx.signatures).some((x) => !x)) throw new Error('the transaction is not fully signed');
  if (!msg.instructions.some((ix) => keys[ix.programAddressIndex] === ESPL)) throw new Error('only private-pocket transactions are forwarded');
  const sig = await upstream('sendTransaction', [wireB64, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
  log(`forwarded ${sig} (prepaid by ${keys[0]})`);
  return { signature: sig };
}

/** Money from a saver's private pocket back to their own wallet: exactly one USDC transfer, pocket to the wallet whose on-chain
 * record names that pocket. We pay the fee (no rent: the wallet's dollar account must exist). */
async function pocketOut(wireB64, wallet, ip) {
  if (!spend(`pocket:${ip}`, 1, 20, 3_600_000) || !spend(`pocketw:${wallet}`, 1, 20, 86_400_000)) throw Object.assign(new Error('too many requests, try again later'), { status: 429 });
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet || '')) throw new Error('not an address');
  const tx = getTransactionDecoder().decode(b64tx(wireB64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!msg.instructions || msg.addressTableLookups?.length) throw new Error('unsupported transaction');
  const keys = msg.staticAccounts;
  if (keys[0] !== SPONSOR || msg.header.numSignerAccounts !== 2) throw new Error('the sponsor pays, the pocket signs, nobody else');
  const pocket = keys[1];
  const moves = msg.instructions.filter((ix) => keys[ix.programAddressIndex] !== PROGRAMS.COMPUTE);
  if (moves.length !== 1) throw new Error('exactly one transfer');
  for (const ix of msg.instructions) if (keys[ix.programAddressIndex] === PROGRAMS.COMPUTE && ix.data?.[0] === 3 && new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true) > LIMITS.maxUnitPrice) throw new Error('the priority fee is too high');
  const t = moves[0], d = t.data ?? new Uint8Array(), a = (i) => keys[t.accountIndices[i]];
  if (keys[t.programAddressIndex] !== PROGRAMS.TOKEN || d.length !== 10 || d[0] !== 12 || d[9] !== 6) throw new Error('only a checked USDC transfer');
  if (a(0) !== await ataOf(pocket, USDC) || a(1) !== USDC || a(2) !== await ataOf(wallet, USDC) || a(3) !== pocket) throw new Error('only from the pocket to its own wallet');
  const [rec] = await getProgramDerivedAddress({ programAddress: address(PROGRAMS.ROOMS), seeds: [new TextEncoder().encode('pocket'), aenc.encode(address(wallet))] });
  const r = (await upstream('getAccountInfo', [rec, { encoding: 'base64', commitment: 'confirmed' }])).value;
  const named = r && r.owner === PROGRAMS.ROOMS ? getBase58Decoder().decode(Uint8Array.from(Buffer.from(r.data[0], 'base64')).subarray(8, 40)) : null;
  if (named !== pocket) throw new Error('that wallet does not name this pocket');
  if (!(await upstream('getAccountInfo', [a(2), { encoding: 'base64', commitment: 'confirmed' }])).value) throw new Error('the wallet has no dollar account yet');
  if (!spend('day', 10_000n, LIMITS.perDay, 86_400_000)) throw Object.assign(new Error('free transactions are paused for today'), { status: 503 });
  const signed = await partiallySignTransaction([sponsorKeys], tx);
  const b64 = getBase64Decoder().decode(getTransactionEncoder().encode(signed));
  const sim = await upstream('simulateTransaction', [b64, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
  if (sim.value.err) throw Object.assign(new Error(`the transaction would fail: ${JSON.stringify(sim.value.err)}`), { logs: (sim.value.logs || []).slice(-4) });
  const sig = await upstream('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 5 }]);
  log(`pocket ${pocket} paid out to ${wallet}: ${sig}`);
  return { signature: sig };
}

// the agent's public key, published by the keeper (it only ever runs chores savers set)
const agentAddress = () => { try { const a = fs.readFileSync(`${process.env.PROOF_DIR || '/proof'}/agent-address`, 'utf8').trim(); return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) ? a : null; } catch { return null; } };

// ---- funds: the sponsor and keeper balances, read at most once a minute ----
const LOW_SOL = Number(process.env.LOW_SOL || 0.3);
let fundsCache = null;
async function funds() {
  if (fundsCache && Date.now() - fundsCache.at < 60_000) return fundsCache.v;
  const who = { sponsor: SPONSOR, ...(process.env.KEEPER_ADDRESS ? { keeper: process.env.KEEPER_ADDRESS } : {}) };
  const sol = {};
  for (const [k, a] of Object.entries(who)) sol[k] = Number((await upstream('getBalance', [a, { commitment: 'confirmed' }])).value) / 1e9;
  // the keeper also pays each room's Friday bonus in dollars
  let keeperUsdc = null;
  // a failed read is reported as unknown (null), never as an empty balance: a false "low" sends people topping up for nothing
  if (who.keeper) { try { keeperUsdc = Number((await upstream('getTokenAccountBalance', [await ataOf(who.keeper, USDC), { commitment: 'confirmed' }])).value.uiAmount); } catch (e) { keeperUsdc = null; console.error(`funds: keeper USDC unreadable: ${e.message}`); } }
  const low = Object.keys(sol).filter((k) => sol[k] < LOW_SOL);
  if (keeperUsdc !== null && keeperUsdc < Number(process.env.LOW_USDC || 3)) low.push('keeper USDC (Friday bonus)');
  const v = { sol, keeperUsdc, low };
  if (v.low.length) log(`LOW FUNDS: ${v.low.join(', ')}`);
  fundsCache = { at: Date.now(), v };
  return v;
}

// what a stored photo is, or null when it's not one Kashu accepts
function photoType(buf) {
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.readUInt32LE(4) + 8 === buf.length) return 'image/webp';
  const jpeg = buf.length >= 128 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  if (jpeg) return 'image/jpeg';
  return null;
}

// a JPEG with every metadata block removed (APP1-APP15: EXIF, XMP, maker notes, location). Phone browsers add EXIF even to a
// photo redrawn on a canvas, so it's stripped here, never refused. JFIF (APP0) and the image itself are kept. null = broken.
function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda) { out.push(buf.subarray(i)); return Buffer.concat(out); } // start of scan: the rest is image data
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (!(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe) out.push(buf.subarray(i, i + 2 + len)); // drop APP1-15 and comments
    i += 2 + len;
  }
  return null;
}

// photos Kashu removed after review (one hash per line, kept by scripts/photos.sh); read at most once a minute
let removedCache = { at: 0, set: new Set() };
function removedPhotos() {
  if (Date.now() - removedCache.at < 60_000) return removedCache.set;
  let set = new Set();
  try { set = new Set(fs.readFileSync(`${process.env.AVATAR_DIR || '/avatars'}/removed.txt`, 'utf8').split('\n').filter((h) => /^[0-9a-f]{64}$/.test(h))); } catch { /* none removed */ }
  removedCache = { at: Date.now(), set };
  return set;
}

// ---- spending insight ----
const histCache = new Map();
const seedPda = async (program, seeds) => (await getProgramDerivedAddress({ programAddress: address(program), seeds }))[0];
async function history(wallet) {
  const hit = histCache.get(wallet); if (hit && Date.now() - hit.at < 120_000) return hit.v;
  const te = new TextEncoder();
  const vault = await seedPda(PROGRAMS.VAULT, [te.encode('vault'), aenc.encode(address(wallet))]);
  const cash = await seedPda(PROGRAMS.VAULT, [te.encode('cash'), aenc.encode(address(vault))]);
  const usdc = await ataOf(wallet, USDC);
  const pocketRec = (await upstream('getAccountInfo', [await seedPda(PROGRAMS.ROOMS, [te.encode('pocket'), aenc.encode(address(wallet))]), { encoding: 'base64' }])).value;
  const pocket = pocketRec ? getBase58Decoder().decode(Buffer.from(pocketRec.data[0], 'base64').subarray(8, 40)) : null;
  const agent = agentAddress();
  const sigs = (await upstream('getSignaturesForAddress', [usdc, { limit: 40, commitment: 'confirmed' }])).filter((x) => !x.err);
  const items = [];
  for (const sg of sigs) {
    const tx = await upstream('getTransaction', [sg.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]).catch(() => null);
    if (!tx?.meta) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const owners = Object.fromEntries([...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])].map((b) => [keys[b.accountIndex], b.owner]));
    // every token transfer in the transaction, top level and inside programs, read from the transfer itself
    const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions || []).flatMap((g) => g.instructions)];
    const moves = all.filter((ix) => ix.parsed && ['transfer', 'transferChecked'].includes(ix.parsed.type) && (ix.program === 'spl-token'))
      .map((ix) => ({ from: ix.parsed.info.source, to: ix.parsed.info.destination, amount: Number(ix.parsed.info.tokenAmount?.amount ?? ix.parsed.info.amount) / 1e6 }));
    const base = { at: (tx.blockTime ?? 0) * 1000, sig: sg.signature, agent: !!agent && keys.includes(agent) };
    const out = moves.filter((m) => m.from === usdc), inn = moves.filter((m) => m.to === usdc);
    const sentAlso = out.some((m) => m.to !== cash && owners[m.to] !== pocket);
    for (const m of out) {
      if (m.to === cash) items.push({ ...base, kind: sentAlso && !base.agent ? 'roundup' : 'saved', amount: m.amount });
      else if (owners[m.to] === pocket) items.push({ ...base, kind: 'saved-private', amount: m.amount });
      else if (base.agent && m.amount <= 0.010001 && out.length > 1) items.push({ ...base, kind: 'fee', amount: m.amount });
      else items.push({ ...base, kind: 'sent', amount: m.amount, to: owners[m.to] ?? null });
    }
    for (const m of inn) items.push({ ...base, kind: m.from === cash ? 'took-out' : owners[m.from] === pocket ? 'from-pocket' : 'received', amount: m.amount, from: m.from === cash ? null : owners[m.from] ?? null });
  }
  const v = { wallet, items };
  histCache.set(wallet, { at: Date.now(), v });
  return v;
}

/** The sponsor's rules, applied to a decoded transaction before anything is signed. Throws a plain reason. */
export function checkShape(wire) {
  const tx = getTransactionDecoder().decode(wire);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (msg.version !== 0 && msg.version !== 'legacy' && msg.version !== 1) throw new Error('only legacy, v0 and v1 transactions are sponsored');
  // v1 (up to 4096 bytes) lists instructions as headers and payloads, and carries fee settings in its config;
  // we sponsor v1 only without config overrides, so a priority fee can't slip past the fee check below
  if (msg.version === 1) {
    // config bits: 0-1 priority fee (never sponsored), 2 compute limit, 3 loaded-data limit, 4 heap size
    if (msg.configMask & 3) throw new Error('priority fees are not sponsored');
    if (msg.configMask & ~0b11100) throw new Error('unknown transaction settings');
    let vi = 0;
    for (const bit of [2, 3, 4]) {
      if (!(msg.configMask & (1 << bit))) continue;
      const v = Number(msg.configValues[vi++]?.value);
      if (bit === 2 && v > LIMITS.maxUnits) throw new Error('too many compute units');
      if (bit === 3 && v > 8 * 1024 * 1024) throw new Error('loaded-data limit too high');
      if (bit === 4 && v > 256 * 1024) throw new Error('heap too large');
    }
    msg.instructions = msg.instructionHeaders.map((h, i) => ({ programAddressIndex: h.programAccountIndex, accountIndices: msg.instructionPayloads[i].instructionAccountIndices, data: msg.instructionPayloads[i].instructionData }));
  }
  if (msg.addressTableLookups?.length) throw new Error('lookup tables are not sponsored: every account must be visible');
  const keys = msg.staticAccounts;
  if (keys[0] !== SPONSOR) throw new Error('the sponsor must be the fee payer');
  if (msg.header.numSignerAccounts !== 1) throw new Error('the sponsor must be the only signer');
  const sigs = Object.values(tx.signatures);
  if (sigs.length !== 1) throw new Error('unexpected signatures');
  let swig = null;
  const rentTo = [];
  for (const ix of msg.instructions) {
    const p = keys[ix.programAddressIndex];
    const d = ix.data ?? new Uint8Array();
    // the one top-level transfer we pay: rent into a smart wallet, from the sponsor, which the simulation must
    // show was all spent in the same transaction (see sponsor())
    if (p === PROGRAMS.SYSTEM && d.length === 12 && d[0] === 2 && d[1] === 0 && keys[ix.accountIndices[0]] === SPONSOR) {
      const lamports = new DataView(d.buffer, d.byteOffset).getBigUint64(4, true);
      if (lamports > LIMITS.maxLossPerTx) throw new Error('that rent is more than we sponsor');
      rentTo.push(keys[ix.accountIndices[1]]);
      continue;
    }
    if (!TOP_LEVEL.has(p)) throw new Error(`program ${p} is not sponsored at the top level`);
    if (p === PROGRAMS.COMPUTE) {
      if (d[0] === 3 && new DataView(d.buffer, d.byteOffset).getBigUint64(1, true) > LIMITS.maxUnitPrice) throw new Error('the priority fee is too high');
      if (d[0] === 2 && new DataView(d.buffer, d.byteOffset).getUint32(1, true) > LIMITS.maxUnits) throw new Error('too many compute units');
    }
    if (p === PROGRAMS.SWIG) {
      // only creating a wallet and signing through it; closing one would hand its sponsor-paid rent to the caller,
      // and authority changes are for recovery flows the person pays for themselves
      const kind = d.length >= 2 ? d[0] | (d[1] << 8) : -1;
      if (![SWIG_CREATE, SWIG_SIGN_V1, SWIG_SIGN_V2].includes(kind)) throw new Error('that smart wallet action is not sponsored');
      const first = keys[ix.accountIndices?.[0]];
      if (swig && first !== swig) throw new Error('one smart wallet per sponsored transaction');
      swig = first;
    }
  }
  if (!swig) throw new Error('nothing to sponsor: no smart wallet instruction');
  if (rentTo.length > 1) throw new Error('one rent transfer per transaction');
  return { tx, msg, swig, rentTo: rentTo[0] ?? null };
}

// ---- invite-only (mainnet beta): making a new wallet needs a code; the file holds only the codes' SHA-256 and how many
// times each may be used ("<sha256-hex> <uses>" per line); members already in are never asked ----
const INVITES = process.env.INVITES_FILE;
const usedFile = () => `${process.env.INBOX_DIR || '/inbox'}/invites-used.state`;
function spendInvite(code) {
  if (!INVITES) return true;
  const want = crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
  let max = 0;
  try { for (const line of fs.readFileSync(INVITES, 'utf8').split('\n')) { const [h, n] = line.trim().split(/\s+/); if (h === want) max = Number(n) || 1; } } catch { return false; }
  if (!max) return false;
  let used = {}; try { used = JSON.parse(fs.readFileSync(usedFile(), 'utf8')); } catch { /* none yet */ }
  if ((used[want] ?? 0) >= max) return false;
  used[want] = (used[want] ?? 0) + 1;
  try { fs.writeFileSync(usedFile(), JSON.stringify(used)); } catch { return false; }
  return true;
}

async function sponsor(wireB64, ip, invite = '') {
  if (!spend(`ip:${ip}`, 1, LIMITS.sponsorPerHourPerIp, 3_600_000)) throw Object.assign(new Error('too many requests from this address, try again later'), { status: 429 });
  const wire = getBase64Encoder().encode(wireB64);
  if (wire.length > 4096) throw new Error('transaction too large');
  const { tx, msg, swig, rentTo } = checkShape(wire);
  if (INVITES && msg.instructions.some((ix) => msg.staticAccounts[ix.programAddressIndex] === PROGRAMS.SWIG && (ix.data?.[0] ?? -1) === SWIG_CREATE && (ix.data?.[1] ?? 0) === 0)) {
    if (!spendInvite(invite)) throw Object.assign(new Error('Kashu is invite-only for now: that invite code isn\'t valid or has been used up'), { status: 403 });
  }
  const signed = await partiallySignTransaction([sponsorKeys], tx);
  const b64 = getBase64Decoder().decode(getTransactionEncoder().encode(signed));
  // run it first: it must succeed, only our programs may run, and the sponsor may lose only a little
  const before = BigInt((await upstream('getBalance', [SPONSOR, { commitment: 'confirmed' }])).value);
  const rentBefore = rentTo ? BigInt((await upstream('getBalance', [rentTo, { commitment: 'confirmed' }])).value) : 0n;
  const sim = await upstream('simulateTransaction', [b64, { encoding: 'base64', sigVerify: true, commitment: 'confirmed', innerInstructions: true, accounts: { encoding: 'base64', addresses: rentTo ? [SPONSOR, rentTo] : [SPONSOR] } }]);
  if (sim.value.err) throw Object.assign(new Error(`the transaction would fail: ${JSON.stringify(sim.value.err)}`), { logs: (sim.value.logs || []).slice(-6) });
  const keys = msg.staticAccounts;
  for (const group of sim.value.innerInstructions || []) for (const ix of group.instructions) {
    // the node may name the program or give its position in the account list; anything else is refused
    const p = ix.programId ?? keys[ix.programIdIndex];
    // the sponsor pays rent when a program opens an account (the vault, a token account: those CPIs run one level
    // below the smart wallet, and the loss limit bounds them). What the smart wallet itself calls directly may not move
    // the sponsor's SOL. Swig already refuses that (devnet-relay.mjs shows its 3019); this is the second line.
    // The one exception: creating the smart wallet, which charges the sponsor for it.
    const top = msg.instructions[group.index];
    const topData = top?.data ?? new Uint8Array();
    const creating = keys[top?.programAddressIndex] === PROGRAMS.SWIG && topData.length >= 2 && (topData[0] | (topData[1] << 8)) === SWIG_CREATE;
    const touches = (ix.accounts ?? []).some((a) => (typeof a === 'number' ? keys[a] : a) === SPONSOR);
    if (p === PROGRAMS.SYSTEM && ix.stackHeight === 2 && touches && !creating) throw new Error('the smart wallet can\'t move the sponsor\'s SOL');
    if (!p || !RUNS.has(p)) throw new Error(`the transaction runs a program we don't sponsor (${p})`);
    // closing a token account returns its rent to whoever closes it: not on our fee
    if (p === PROGRAMS.TOKEN && typeof ix.data === 'string' && getBase58Encoder().encode(ix.data)[0] === 9) throw new Error('closing token accounts is not sponsored');
  }
  // rent we send a wallet must all go on rent in this transaction: the wallet may not end up richer
  if (rentTo && BigInt(sim.value.accounts?.[1]?.lamports ?? 0) > rentBefore) throw new Error('the rent we sent was not all spent on rent');
  const after = BigInt(sim.value.accounts?.[0]?.lamports ?? before);
  const loss = before - after + 5_000n; // the fee is charged on landing, not in simulation
  if (loss > LIMITS.maxLossPerTx) throw new Error('the transaction costs the sponsor more than allowed');
  if (!spend(`wallet:${swig}`, loss, LIMITS.perWalletPerDay, 86_400_000)) throw Object.assign(new Error('this wallet has used today\'s free transactions'), { status: 429 });
  if (!spend('day', loss, LIMITS.perDay, 86_400_000)) throw Object.assign(new Error('free transactions are paused for today'), { status: 503 });
  const sig = await upstream('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 5 }]);
  log(`sponsored ${sig} for ${swig}, ${loss} lamports`);
  return { signature: sig };
}

function send(res, status, body, origin) {
  const h = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (origin && ORIGINS.includes(origin)) Object.assign(h, { 'access-control-allow-origin': origin, vary: 'Origin' });
  res.writeHead(status, h);
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'OPTIONS') {
    if (!origin || !ORIGINS.includes(origin)) { res.writeHead(403); return res.end(); }
    res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, GET', 'access-control-allow-headers': 'content-type, solana-client', 'access-control-max-age': '600', vary: 'Origin' });
    return res.end();
  }
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/funds')) {
    // the accounts that pay for everything, with a flag when one runs low; /health always answers 200 (the app reads
    // the sponsor and keeper from it), /funds answers 503 when something is low, for an uptime monitor to watch
    const strict = req.url === '/funds';
    funds().then((f) => send(res, strict && f.low.length ? 503 : 200, { ok: !f.low.length, sponsor: SPONSOR, keeper: process.env.KEEPER_ADDRESS || null, agent: agentAddress(), sol: f.sol, keeperUsdc: f.keeperUsdc, low: f.low }, origin),
      () => send(res, 200, { ok: true, sponsor: SPONSOR, keeper: process.env.KEEPER_ADDRESS || null }, origin));
    return;
  }
  if (req.method === 'POST' && (req.url === '/submit' || req.url === '/pocket-out')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { return send(res, 400, { error: 'bad request' }, origin); }
      (req.url === '/submit' ? submitPrepaid(j.transaction, ip) : pocketOut(j.transaction, j.wallet, ip))
        .then((r) => send(res, 200, r, origin), (e) => send(res, e.status || 400, { error: String(e.message).slice(0, 200), logs: e.logs }, origin));
    });
    return;
  }
  // profile photos: stored by their SHA-256 (the wallet names that hash on chain; only the wallet can), served forever
  if (req.method === 'GET' && /^\/avatar\/[0-9a-f]{64}\.webp$/.test(req.url)) {
    const file = `${process.env.AVATAR_DIR || '/avatars'}/${req.url.slice(8)}`;
    // a photo Kashu removed is never served again, wherever it's referenced
    if (removedPhotos().has(req.url.slice(8, 72))) { res.writeHead(410, { 'cache-control': 'no-store' }); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end(); }
      res.writeHead(200, { 'content-type': photoType(buf) ?? 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'cross-origin', 'content-security-policy': "default-src 'none'" });
      res.end(buf);
    });
    return;
  }
  // reporting a photo: kept for Kashu to review (scripts/photos.sh); a few reasons only, nothing free-form
  if (req.method === 'POST' && req.url === '/report-photo') {
    if (!spend(`report:${ip}`, 1, 20, 3_600_000)) return send(res, 429, { error: 'slow down' }, origin);
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 512) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (!/^[0-9a-f]{64}$/.test(j.hash) || !['nudity', 'violence', 'hate', 'impersonation', 'other'].includes(j.reason)) throw new Error('bad report');
        fs.appendFileSync(`${process.env.INBOX_DIR || '/inbox'}/photo-reports.log`, JSON.stringify({ at: new Date().toISOString(), hash: j.hash, reason: j.reason }) + '\n');
        send(res, 202, { ok: true }, origin);
      } catch (e) { send(res, 400, { error: String(e.message).slice(0, 60) }, origin); }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/avatar') {
    if (!spend(`avatar:${ip}`, 1, 10, 3_600_000)) return send(res, 429, { error: 'Too many photos for now, try again later' }, origin);
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 65_536) { req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      // a WebP (RIFF....WEBP, declared size matching), or a JPEG (iPhones can't make WebP) with its metadata
      // stripped, so no photo kept here carries a location or a camera's details
      const type = photoType(buf);
      if (type === null) { log(`photo refused: ${buf.length} bytes, starts ${buf.subarray(0, 12).toString('hex')}`); return send(res, 400, { error: 'That isn\'t a photo Kashu can use' }, origin); }
      if (type === 'image/jpeg') { buf = stripJpeg(buf); if (!buf) return send(res, 400, { error: 'That photo looks damaged. Try another one.' }, origin); }
      const dir = process.env.AVATAR_DIR || '/avatars';
      try {
        if (fs.readdirSync(dir).length > 20_000) return send(res, 503, { error: 'Busy, try again soon' }, origin);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        if (!fs.existsSync(`${dir}/${hash}.webp`)) fs.writeFileSync(`${dir}/${hash}.webp`, buf);
        send(res, 200, { hash }, origin);
      } catch { send(res, 500, { error: 'Couldn\'t keep that photo' }, origin); }
    });
    return;
  }
  // win notifications: the VAPID public key, and a subscription signed by the member's phone key (the keeper checks it
  // against the room's record, so nobody can subscribe to someone else's wins)
  if (req.method === 'GET' && req.url === '/push-key') return send(res, 200, { key: vapidKeys(process.env.VAPID_FILE || '/run/vapid.json').publicKey }, origin);
  if (req.method === 'POST' && req.url === '/push') {
    if (!spend(`push:${ip}`, 1, 20, 3_600_000)) return send(res, 429, { error: 'slow down' }, origin);
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const isAddr = (x) => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
        if (!isAddr(j.room) || !isAddr(j.owner) || typeof j.sig !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(j.sig)) throw new Error('bad request');
        const sub = { endpoint: j.sub?.endpoint, keys: { p256dh: j.sub?.keys?.p256dh, auth: j.sub?.keys?.auth } };
        if (!validSubscription(sub)) throw new Error('not a browser push subscription');
        const dir = process.env.INBOX_DIR || '/inbox';
        if (fs.readdirSync(dir).length > 2000) return send(res, 503, { error: 'busy, try again soon' }, origin);
        const id = Buffer.from(sub.endpoint).toString('base64url').slice(-24);
        fs.writeFileSync(`${dir}/push-${j.owner}-${id}.json`, JSON.stringify({ room: j.room, owner: j.owner, sub, sig: j.sig }));
        send(res, 202, { ok: true }, origin);
      } catch (e) { send(res, 400, { error: String(e.message).slice(0, 80) }, origin); }
    });
    return;
  }
  // a cheer, signed by the sender's phone (its viewer key); Kashu's keeper checks the signature against the room's own
  // record of that key and adds the cheer on the private rollup. The relay only files it.
  if (req.method === 'POST' && req.url === '/cheer') {
    if (!spend(`cheer:${ip}`, 1, 30, 60_000)) return send(res, 429, { error: 'slow down' }, origin);
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const isAddr = (x) => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
        if (!isAddr(j.room) || !isAddr(j.from) || !isAddr(j.to) || j.from === j.to || !Number.isInteger(j.week) || j.week < 1 || j.week > 1e6) throw new Error('bad cheer');
        if (typeof j.sig !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(j.sig)) throw new Error('bad signature');
        const dir = process.env.INBOX_DIR || '/inbox';
        if (fs.readdirSync(dir).length > 2000) return send(res, 503, { error: 'busy, try again soon' }, origin);
        fs.writeFileSync(`${dir}/${j.room}.${j.from}.${j.to}.${j.week}.json`, JSON.stringify({ room: j.room, from: j.from, to: j.to, week: j.week, sig: j.sig }));
        send(res, 202, { ok: true }, origin);
      } catch (e) { send(res, 400, { error: String(e.message).slice(0, 80) }, origin); }
    });
    return;
  }
  // what a wallet has won in Friday prizes (written by the keeper as it pays them; every payment is public on Solana)
  if (req.method === 'GET' && req.url.startsWith('/prizes?')) {
    const wallet = new URL(req.url, 'http://x').searchParams.get('wallet') || '';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return send(res, 400, { error: 'bad wallet' }, origin);
    if (!spend(`prizes:${ip}`, 1, 30, 60_000)) return send(res, 429, { error: 'slow down' }, origin);
    let all = {}; try { all = JSON.parse(fs.readFileSync(`${process.env.PROOF_DIR || '/proof'}/prizes.json`, 'utf8')); } catch { /* none paid yet */ }
    const w = all[wallet] ?? { won: 0, prizes: 0 };
    return send(res, 200, { won: w.won / 1e6, prizes: w.prizes }, origin);
  }
  // a room's latest proof of each kind (written by the keeper): signatures only, all public on Solana or the rollup
  if (req.method === 'GET' && req.url.startsWith('/proof?')) {
    const room = new URL(req.url, 'http://x').searchParams.get('room') || '';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(room)) return send(res, 400, { error: 'not an address' }, origin);
    if (!spend(`proof:${ip}`, 1, 30, 60_000)) return send(res, 429, { error: 'slow down' }, origin);
    try { return send(res, 200, JSON.parse(fs.readFileSync(`${process.env.PROOF_DIR || '/proof'}/${room}.json`, 'utf8')), origin); }
    catch { return send(res, 200, {}, origin); }
  }
  // which Kashu wallet a passkey controls: a Swig wallet keeps its passkey's compressed public key at byte 64 of a 112-byte
  // account and its id at byte 2 (public on chain). Lets passkeys made before they carried their wallet sign back in.
  if (req.method === 'GET' && req.url.startsWith('/wallet-of-key?')) {
    const keys = (new URL(req.url, 'http://x').searchParams.get('keys') || '').split(',').filter((k) => /^[0-9a-f]{66}$/.test(k)).slice(0, 2);
    if (!keys.length) return send(res, 400, { error: 'no key' }, origin);
    if (!spend(`wok:${ip}`, 1, 20, 60_000)) return send(res, 429, { error: 'slow down' }, origin);
    Promise.all(keys.map((k) => upstream('getProgramAccounts', [PROGRAMS.SWIG, { encoding: 'base64', filters: [{ dataSize: 112 }, { memcmp: { offset: 64, bytes: getBase58Decoder().decode(Buffer.from(k, 'hex')), encoding: 'base58' } }] }])
      .then((list) => list.map((a) => ({ key: k, swigId: Buffer.from(a.account.data[0], 'base64').subarray(2, 34).toString('base64url') })))))
      .then((found) => send(res, 200, { wallets: found.flat() }, origin), (e) => send(res, 503, { error: String(e.message).slice(0, 120) }, origin));
    return;
  }
  // spending insight: a wallet's recent dollar movements, sorted into what they were (everything here is public on chain)
  if (req.method === 'GET' && req.url.startsWith('/history?')) {
    const wallet = new URL(req.url, 'http://x').searchParams.get('wallet') || '';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return send(res, 400, { error: 'not an address' }, origin);
    if (!spend(`hist:${ip}`, 1, 12, 60_000)) return send(res, 429, { error: 'slow down' }, origin);
    history(wallet).then((h) => send(res, 200, h, origin), (e) => send(res, 503, { error: String(e.message).slice(0, 120) }, origin));
    return;
  }
  // the rooms a wallet belongs to (membership records are public on Solana), so a passkey alone can sign back in
  if (req.method === 'GET' && req.url.startsWith('/rooms-of?')) {
    const wallet = new URL(req.url, 'http://x').searchParams.get('wallet') || '';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return send(res, 400, { error: 'not an address' }, origin);
    if (!spend(`rooms:${ip}`, 1, 20, 60_000)) return send(res, 429, { error: 'slow down' }, origin);
    const filters = [{ dataSize: 201 }, { memcmp: { offset: 40, bytes: wallet, encoding: 'base58' } }];
    const isMember = (a) => { const d = Buffer.from(a.account.data[0], 'base64'); return d.length === 201 && d.subarray(0, 8).equals(Buffer.from([54, 19, 162, 21, 29, 166, 17, 198])) && d.subarray(40, 72).equals(Buffer.from(getBase58Encoder().encode(wallet))); };
    Promise.all([PROGRAMS.ROOMS, 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'].map((pid) => upstream('getProgramAccounts', [pid, { encoding: 'base64', filters }])))
      .then((lists) => send(res, 200, { rooms: [...new Set(lists.flat().filter(isMember).map((a) => getBase58Decoder().decode(Buffer.from(a.account.data[0], 'base64').subarray(8, 40))))] }, origin))
      .catch((e) => send(res, 503, { error: String(e.message).slice(0, 120) }, origin));
    return;
  }
  if (req.method !== 'POST' || !['/rpc', '/sponsor'].includes(req.url)) return send(res, 404, { error: 'not found' }, origin);
  if (origin && !ORIGINS.includes(origin)) return send(res, 403, { error: 'origin not allowed' }, origin);
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > LIMITS.bodyBytes) { send(res, 413, { error: 'too large' }, origin); req.destroy(); } });
  req.on('end', async () => {
    if (res.writableEnded) return;
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'not JSON' }, origin); }
    try {
      if (req.url === '/rpc') {
        if (Array.isArray(body)) return send(res, 400, { error: 'one call at a time' }, origin);
        if (!READS.has(body.method) && body.method !== 'sendTransaction') return send(res, 403, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: `${String(body.method).slice(0, 40)} is not available here` } }, origin);
        if (!spend(`rpc:${ip}`, 1, LIMITS.rpcPerMinute, 60_000)) return send(res, 429, { jsonrpc: '2.0', id: body.id ?? null, error: { code: 429, message: 'slow down' } }, origin);
        const result = await upstream(body.method, Array.isArray(body.params) ? body.params : []);
        return send(res, 200, { jsonrpc: '2.0', id: body.id ?? 1, result }, origin);
      }
      if (typeof body.tx !== 'string') return send(res, 400, { error: 'send { tx: base64 }' }, origin);
      return send(res, 200, await sponsor(body.tx, ip, typeof body.invite === 'string' ? body.invite : ''), origin);
    } catch (e) {
      const status = e.status || 400;
      if (req.url === '/rpc' && e.rpc) return send(res, 200, { jsonrpc: '2.0', id: body.id ?? 1, error: e.rpc }, origin);
      return send(res, status, { error: String(e.message).slice(0, 300), ...(e.logs ? { logs: e.logs } : {}) }, origin);
    }
  });
});
server.on('upgrade', (req, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
server.headersTimeout = 10_000; server.requestTimeout = 15_000;
server.listen(PORT, process.env.HOST || '127.0.0.1', () => log(`kashu relay on :${PORT}, sponsor ${SPONSOR}`));
