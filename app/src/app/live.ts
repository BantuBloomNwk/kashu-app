// The app on devnet: each action the screens offer becomes real instructions, read back in the review sheet,
// approved with the passkey, and paid for by Kashu's relay. Afterwards the chain is read back into the store,
// so the screens show what is actually there.
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { RELAY, createPasskey, ensureWallet, keeper, prepare, roomsOf, rpc, savedPasskey, signInWithPasskey, sponsorAddress, USDC_MINT, type Pending } from '../wallet/wallet.ts';
// @ts-expect-error plain JS modules shared with the tests
import * as V from '../../../client/vault.mjs';
// @ts-expect-error plain JS modules shared with the tests
import * as R from '../../../client/rooms.mjs';
import { showDollars } from '../ui/money.ts';
import { teeAccount, viewerKey } from '../wallet/viewer.ts';
import * as P from '../wallet/pocket.ts';
// @ts-expect-error plain JS module shared with the tests
import { LEND_MARKETS } from '../../../client/markets.mjs';
const MARKET = MAINNET ? LEND_MARKETS.mainnet : LEND_MARKETS.devnet;
import { live as setLive, type LiveState } from './store.ts';
import { MAINNET } from '../config.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111';
const ROOM_KEY = 'kashu.room.v1';
const NAMES_KEY = 'kashu.names.v1';
// Kashu's keeper may count this member's saves for 90 days (it can only count real saves, never move money)
const SESSION_DAYS = 90;
const DELEGATION = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
const enc = getAddressEncoder();

const read = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
export const savedRoom = () => read<{ room: string } | null>(ROOM_KEY, null);
/** Friends' names stay on this phone: the chain only knows their addresses. */
export const names = () => read<Record<string, string>>(NAMES_KEY, {});
export function nameFriend(addr: string, name: string) { write(NAMES_KEY, { ...names(), [addr]: name.slice(0, 24) }); void refresh(); }

const ata = async (owner: string, mint: string) =>
  (await getProgramDerivedAddress({ programAddress: address(V.ATA_PROGRAM), seeds: [owner, V.TOKEN_PROGRAM, mint].map((x) => enc.encode(address(x))) }))[0];
type Ix = { programAddress: string; accounts: { address: string; role: number }[]; data: Uint8Array };
// the client's builders attach signer objects; inside the smart wallet the wallet signs, so they come off
const strip = (ix: any): Ix => ({ ...ix, accounts: ix.accounts.map(({ signer: _s, ...a }: any) => a) });
/** The vault's Jupiter Lend share account and staging account, opened (idempotently) with Kashu paying the rent. */
async function lendAccounts(payer: string, vault: string): Promise<Ix[]> {
  return [createAta(payer, vault, await V.shareAccount(vault, MARKET.fTokenMint), MARKET.fTokenMint), createAta(payer, vault, await V.shareAccount(vault, USDC_MINT), USDC_MINT)];
}
const systemTransfer = (from: string, to: string, lamports: bigint): Ix => {
  const d = new Uint8Array(12); d[0] = 2; new DataView(d.buffer).setBigUint64(4, lamports, true);
  return { programAddress: SYSTEM, data: d, accounts: [{ address: from, role: 3 }, { address: to, role: 1 }] };
};
const createAta = (payer: string, owner: string, account: string, mint: string): Ix => ({
  programAddress: V.ATA_PROGRAM, data: new Uint8Array([1]), // idempotent
  accounts: [{ address: payer, role: 3 }, { address: account, role: 1 }, { address: owner, role: 0 }, { address: mint, role: 0 }, { address: SYSTEM, role: 0 }, { address: V.TOKEN_PROGRAM, role: 0 }],
});

// ---- the review sheet: screens ask, the sheet shows the lines, the person approves or doesn't ----
type Ask = { title: string; pending: Pending; resolve: (sig: string | null) => void };
let asking: Ask | null = null;
const askSubs = new Set<() => void>();
export const reviewState = () => asking;
export const onReview = (f: () => void) => { askSubs.add(f); return () => askSubs.delete(f); };
function ask(title: string, pending: Pending) {
  return new Promise<string | null>((resolve) => { asking = { title, pending, resolve }; askSubs.forEach((f) => f()); });
}
export function closeReview(sig: string | null) { const a = asking; asking = null; if (sig) forget(); askSubs.forEach((f) => f()); a?.resolve(sig); }

async function context() {
  const { wallet } = await ensureWallet();
  const va = await V.vaultAddresses(wallet);
  const usdc = await ata(wallet, USDC_MINT), sol = await ata(wallet, WSOL);
  return { wallet, va, usdc, sol, s: await sponsorAddress(), names: { [wallet]: 'your wallet', [usdc]: 'your wallet', [sol]: 'your wallet', [va.userVault]: 'your vault' } as Record<string, string>, mine: [usdc, sol] };
}

/** "I already have Kashu": sign in with a passkey, then find the wallet's room on chain. */
export async function signIn(): Promise<'ok' | 'no-account'> {
  if (!(await signInWithPasskey())) return 'no-account';
  const { wallet } = await ensureWallet();
  const rooms = await roomsOf(wallet);
  if (rooms.length) write(ROOM_KEY, { room: rooms[0] });
  await refresh();
  return 'ok';
}

/** First run: a passkey, then "Open your vault", then "Start your room" (or join one). Two approvals. */
export async function onboard({ roomName, weekly, joinRoom }: { roomName: string; weekly: number; joinRoom?: string }) {
  if (!savedPasskey()) await createPasskey();
  const c = await context();
  const k = await keeper();
  const vaultExists = await exists(c.va.userVault);
  if (!vaultExists) {
    const step1 = [createAta(c.s, c.wallet, c.usdc, USDC_MINT), createAta(c.s, c.wallet, c.sol, WSOL),
      strip(await V.openVaultIx({ payer: { address: c.s }, owner: { address: c.wallet }, usdcMint: USDC_MINT, assetMint: WSOL })),
      // the vault's own accounts for lending on Jupiter Lend: its share account and the account it stages moves through
      ...(await lendAccounts(c.s, c.va.userVault)),
      strip(await V.setRuleIx({ address: c.wallet }, { weeklyAmount: BigInt(Math.round(weekly * 1e6)), roundupUnit: 0n, assetBps: 0 }))];
    if (!(await ask('Open your vault', await prepare(step1, { names: c.names, mine: c.mine })))) return false;
  }
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const roomId = BigInt(Math.floor(Date.now() / 1000));
  // the room and joining it; the room's prize pot is opened by Kashu's keeper, and joining the prize happens
  // with the first save (one transaction can only be so big)
  // the room and joining it, with this phone's viewer key so the room can be read once it's private; a room that
  // is already private is joined in two steps (the record here, the seat on the rollup by Kashu's keeper)
  const viewer = (await viewerKey()).address;
  const joinPrivate = !!joinRoom && (await account(joinRoom))?.owner === DELEGATION;
  const joinArgs = { owner: { address: c.wallet }, room: joinRoom ?? (await R.roomPda(c.wallet, roomId)), userVault: c.va.userVault, session: k, sessionExpires: expires, viewer };
  const step2: Ix[] = [
    ...(joinRoom ? [] : [strip(await R.createRoomIx({ creator: { address: c.wallet }, roomId, name: roomName || 'Payday crew' }))]),
    strip(joinPrivate ? await R.requestJoinIx(joinArgs) : await R.joinRoomIx(joinArgs)),
  ];
  const finalRoom = joinRoom ?? (await R.roomPda(c.wallet, roomId));
  // the room and membership records are paid from the wallet, which starts with no SOL: Kashu sends exactly
  // their rent first, in the same reviewed transaction (8 + Room and 8 + Member with its viewer key, plus each record's private-rollup rent)
  const rent = rentFor;
  const lamports = (joinRoom ? 0n : (await rent(517)) + R.PERMISSION_RENT) + (await rent(201)) + R.PERMISSION_RENT;
  const rentIx = systemTransfer(c.s, c.wallet, lamports);
  if (!(await ask(joinRoom ? 'Join the room' : 'Start your room', await prepare(step2, { names: { ...c.names, [k]: 'Kashu', [c.s]: 'Kashu' }, mine: c.mine }, [rentIx])))) return false;
  write(ROOM_KEY, { room: finalRoom });
  await refresh();
  return true;
}

/** This payday's save: the deposit, and the keeper's permission to count it renewed for another week. */
/** How much more this saver may put in before the vault's per-saver cap (the $50 beta cap on mainnet). */
export async function roomToSave(): Promise<number> {
  const c = await context();
  const [cfgBytes, vBytes] = await Promise.all([bytes(await V.configPda()), bytes(c.va.userVault)]);
  const cfg = V.readConfig(cfgBytes), v = V.readUserVault(vBytes);
  const held = v.cashTracked + v.assetBasis + v.lentPrincipal;
  return cfg.perUserCap > held ? Number(cfg.perUserCap - held) / 1e6 : 0;
}
const dollars = (n: number) => `$${n.toFixed(2).replace(/\.00$/, '')}`;

export async function save(amount: number) {
  const c = await context(), r = savedRoom(), k = await keeper();
  const units = BigInt(Math.round(amount * 1e6));
  // the vault refuses anything over the per-saver cap; say so plainly instead of sending a save that can't land
  const left = await roomToSave();
  if (left < 0.01) throw new Error('You\'ve reached the savings limit for the beta. Everything you\'ve saved is still earning.');
  if (amount > left + 1e-9) throw new Error(`You can save up to ${dollars(left)} more during the beta.`);
  // the save goes into the vault and straight to work on Jupiter Lend; vaults opened before lending get their accounts first
  const ready = await exists(await V.shareAccount(c.va.userVault, MARKET.fTokenMint));
  const ixs = [...(ready ? [] : await lendAccounts(c.s, c.va.userVault)),
    strip(await V.depositIx({ owner: { address: c.wallet }, from: c.usdc, usdcMint: USDC_MINT, amount: units })),
    strip(await V.lendIx({ owner: { address: c.wallet }, usdcMint: USDC_MINT, market: MARKET, amount: units }))];
  // join the room's Friday prize once its pot is open (the keeper opens it shortly after the room starts); the
  // small record that says so is paid with rent Kashu sends first, all of it spent on that record
  const before: Ix[] = [];
  if (r && !(await exists(await V.linkPda(c.va.userVault))) && (await exists(await V.potPda(r.room)))) {
    ixs.push(strip(await V.linkPotIx({ owner: { address: c.wallet }, room: r.room })));
    before.push(systemTransfer(c.s, c.wallet, await rentFor(8 + 32 + 1)));
  }
  const sig = await ask('Save this payday', await prepare(ixs, { names: { ...c.names, [k]: 'Kashu', [c.s]: 'Kashu' }, mine: c.mine }, before));
  if (sig) await refresh();
  return sig;
}

/** Money out, to the person's own wallet. Lent savings come back from Jupiter Lend first, in the same approval. */
export async function withdraw(amount: number) {
  const c = await context();
  const v = V.readUserVault(await bytes(c.va.userVault));
  const units = BigInt(Math.round(amount * 1e6));
  const ixs: Ix[] = [];
  // money at work on Jupiter Lend comes back first, in the same approval; asking for all of it hands back every share
  const short = units > v.cashTracked ? units - v.cashTracked : 0n;
  if (short > 0n) ixs.push(strip(await V.unlendIx({ owner: { address: c.wallet }, usdcMint: USDC_MINT, market: MARKET, amount: short >= v.lentPrincipal ? v.lentPrincipal : short })));
  // taking everything: the vault reads the maximum as "all the cash there is", whatever lending returned
  const everything = units >= v.cashTracked + v.lentPrincipal;
  ixs.push(strip(await V.withdrawCashIx({ owner: { address: c.wallet }, ownerUsdc: c.usdc, ownerAsset: c.sol, usdcMint: USDC_MINT, assetMint: WSOL, amount: everything ? 18446744073709551615n : units })));
  const sig = await ask('Take money out', await prepare(ixs, { names: c.names, mine: c.mine }));
  if (sig) await refresh();
  return sig;
}

// ---- the plan: weekly amount, round-ups, and the share that buys SOL each week (one on-chain rule) ----
async function rule(change: { roundup?: number; assetPct?: number }, title: string) {
  const c = await context();
  const v = V.readUserVault(await bytes(c.va.userVault));
  const next = {
    weeklyAmount: v.weeklyAmount,
    roundupUnit: change.roundup === undefined ? v.roundupUnit : BigInt(Math.round(change.roundup * 1e6)),
    assetBps: change.assetPct === undefined ? v.assetBps : Math.round(change.assetPct * 100),
  };
  const sig = await ask(title, await prepare([strip(await V.setRuleIx({ address: c.wallet }, next))], { names: c.names, mine: c.mine }));
  if (sig) await refresh();
  return sig;
}
/** Round every payment up to the next dollar and save the change (0 turns it off). */
export const setRoundups = (dollars: number) => rule({ roundup: dollars }, dollars ? 'Round up my payments' : 'Stop rounding up');
/** The share of each week's save that buys SOL (the rest stays in dollars). */
export const setPlan = (pct: number) => rule({ assetPct: pct }, `Plan: ${100 - pct}% dollars, ${pct}% SOL`);

/** How many dollars of prize winnings become SOL each week (0 stops it). Never touches the saver's own savings. */
export async function setWinningsBuy(dollars: number) {
  const c = await context();
  const fresh = !(await exists(await V.winningsPda(c.va.userVault)));
  const before = fresh ? [systemTransfer(c.s, c.wallet, await rentFor(8 + 69))] : [];
  const sig = await ask(dollars ? `Turn ${dollars} dollars of winnings into SOL weekly` : 'Stop the winnings buy', await prepare([strip(await V.setDcaIx({ owner: { address: c.wallet }, weekly: BigInt(Math.round(dollars * 1e6)) }))], { names: { ...c.names, [c.s]: 'Kashu' }, mine: c.mine }, before));
  if (sig) await refresh();
  return sig;
}

// ---- Kashutags and sending ----
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** The Kashutag a wallet holds, or null. Tags are public on Solana, so a friend's can be read by anyone. */
export async function tagOfWallet(wallet: string, fresh = false): Promise<string | null> {
  const at = await R.tagOfPda(wallet);
  if (fresh) seen.delete(at);
  const v = await account(at);
  return v ? R.readTagOf(v.data) as string : null;
}
/** Who a Kashutag (or, for the technical, a wallet address) points at. */
export async function lookup(input: string): Promise<{ owner: string; tag: string | null } | { error: string }> {
  const raw = input.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) && !raw.startsWith('$')) return { owner: raw, tag: await tagOfWallet(raw).catch(() => null) };
  const n = R.normalTag(raw);
  if (!n.tag) return { error: n.why };
  const v = await account(await R.tagPda(n.tag));
  if (!v) return { error: `Nobody has $${n.tag} yet` };
  return { owner: R.readTag(v.data).owner, tag: n.tag };
}
/** Is a tag free to claim? */
export async function tagFree(t: string) { return !(await exists(await R.tagPda(t))); }

/** Claim a Kashutag, or swap the one held for a free one. */
export async function setTag(t: string) {
  const n = R.normalTag(t);
  if (!n.tag) throw new Error(n.why);
  const c = await context();
  const held = await tagOfWallet(c.wallet, true);
  if (held === n.tag) return null;
  if (!(await tagFree(n.tag))) throw new Error(`$${n.tag} is taken`);
  let sig: string | null;
  if (held) {
    // the old name's rent moves to the new one, so nothing is paid
    sig = await ask(`Change to $${n.tag}`, await prepare([strip(await R.changeTagIx({ owner: { address: c.wallet }, from: held, to: n.tag }))], { names: c.names, mine: c.mine }));
  } else {
    const rent = (await rentFor(56)) + (await rentFor(24));
    sig = await ask(`Claim $${n.tag}`, await prepare([strip(await R.claimTagIx({ owner: { address: c.wallet }, tag: n.tag }))], { names: { ...c.names, [c.s]: 'Kashu' }, mine: c.mine }, [systemTransfer(c.s, c.wallet, rent)]));
  }
  if (sig) await refresh();
  return sig;
}

/**
 * Send dollars to a friend's wallet. Dollars already in the wallet go first; anything more comes out of savings
 * (back from Jupiter Lend if needed) in the same approval. The friend's dollar account is opened if they have none.
 */
export async function sendMoney(to: { owner: string; tag: string | null }, amount: number) {
  const c = await context();
  if (to.owner === c.wallet) throw new Error('That\'s you');
  const units = BigInt(Math.round(amount * 1e6));
  if (units <= 0n) throw new Error('Choose an amount');
  const inWallet = (await exists(c.usdc)) ? tokenAmount(await bytes(c.usdc)) : 0n;
  const ixs: Ix[] = [];
  const short = units > inWallet ? units - inWallet : 0n;
  if (short > 0n) {
    const v = V.readUserVault(await bytes(c.va.userVault));
    if (short > v.cashTracked + v.lentPrincipal) throw new Error('That\'s more than you have');
    const lendShort = short > v.cashTracked ? short - v.cashTracked : 0n;
    if (lendShort > 0n) ixs.push(strip(await V.unlendIx({ owner: { address: c.wallet }, usdcMint: USDC_MINT, market: MARKET, amount: lendShort >= v.lentPrincipal ? v.lentPrincipal : lendShort })));
    ixs.push(strip(await V.withdrawCashIx({ owner: { address: c.wallet }, ownerUsdc: c.usdc, ownerAsset: c.sol, usdcMint: USDC_MINT, assetMint: WSOL, amount: short })));
  }
  const theirs = await ata(to.owner, USDC_MINT);
  const before: Ix[] = [];
  if (!(await exists(theirs))) {
    ixs.push(createAta(c.wallet, to.owner, theirs, USDC_MINT));
    before.push(systemTransfer(c.s, c.wallet, await rentFor(165)));
  }
  const d = new Uint8Array(10); d[0] = 12; new DataView(d.buffer).setBigUint64(1, units, true); d[9] = 6;
  ixs.push({ programAddress: TOKEN, data: d, accounts: [{ address: c.usdc, role: 1 }, { address: USDC_MINT, role: 0 }, { address: theirs, role: 1 }, { address: c.wallet, role: 2 }] });
  // round-ups: the change up to the next whole unit is saved in the same approval, from what's left in the wallet
  // (never taken from savings to be put back into savings)
  const v = V.readUserVault(await bytes(c.va.userVault));
  const over = v.roundupUnit > 0n ? units % v.roundupUnit : 0n;
  const change = over ? v.roundupUnit - over : 0n;
  if (change > 0n && short === 0n && inWallet - units >= change && (await exists(await V.shareAccount(c.va.userVault, MARKET.fTokenMint)))) {
    ixs.push(strip(await V.depositIx({ owner: { address: c.wallet }, from: c.usdc, usdcMint: USDC_MINT, amount: change })));
    ixs.push(strip(await V.lendIx({ owner: { address: c.wallet }, usdcMint: USDC_MINT, market: MARKET, amount: change })));
  }
  const who = to.tag ? `$${to.tag}` : `${to.owner.slice(0, 4)}…${to.owner.slice(-4)}`;
  const sig = await ask(`Send to ${who}`, await prepare(ixs, { names: { ...c.names, [theirs]: who, [to.owner]: who, [c.s]: 'Kashu' }, mine: c.mine }, before));
  if (sig) await refresh();
  return sig ? { sig, roundedUp: Number(change) / 1e6 } : null;
}

// ---- the private pocket (MagicBlock private payments) ----
const tokenBal = async (owner: string) => { const a = await account(await ata(owner, USDC_MINT)); return a ? tokenAmount(a.data) : 0n; };
/** The pocket key a wallet has named on chain, or null. */
export async function pocketOf(wallet: string): Promise<string | null> {
  const a = await account(await R.pocketOfPda(wallet));
  return a ? R.readPocketOf(a.data) as string : null;
}
/** Waits until the pocket's Solana account holds at least `units` (a transfer or withdrawal landing). */
async function untilPocketHas(pocketAddr: string, units: bigint) {
  for (let i = 0; i < 40; i++) { forget(); if ((await tokenBal(pocketAddr)) >= units) return; await new Promise((r) => setTimeout(r, 1500)); }
  throw new Error('The money is taking a while to arrive. Try again in a minute.');
}
/** Moves dollars from the wallet into the private pocket: one passkey approval, then the pocket deposits them privately. */
export async function addToPocket(amount: number) {
  const units = BigInt(Math.round(amount * 1e6));
  if (units < P.POCKET_MIN) throw new Error('At least $0.50 at a time');
  const pk = await P.openPocket();
  const c = await context();
  const theirs = await ata(pk.address, USDC_MINT);
  const have = await tokenBal(pk.address);
  // the deposit, its 0.20 fee, and 0.20 kept for the fee on the way out again
  const need = units + P.POCKET_FEE * 2n;
  const top = need > have ? need - have : 0n;
  const ixs: Ix[] = [];
  const before: Ix[] = [];
  let rent = 0n;
  if (!(await exists(theirs))) { ixs.push(createAta(c.wallet, pk.address, theirs, USDC_MINT)); rent += await rentFor(165); }
  if ((await pocketOf(c.wallet)) !== pk.address) {
    if (!(await exists(await R.pocketOfPda(c.wallet)))) rent += await rentFor(8 + 32 + 1);
    ixs.push(strip(await R.setPocketIx({ owner: { address: c.wallet }, pocket: pk.address })));
  }
  // through the vault's save_private: it checks the pocket is the one this wallet named, and counts the save for the room
  if (top > 0n) ixs.push(strip(await V.savePrivateIx({ owner: { address: c.wallet }, from: c.usdc, to: theirs, usdcMint: USDC_MINT, amount: top })));
  if (rent > 0n) before.push(systemTransfer(c.s, c.wallet, rent));
  if (ixs.length) {
    const sig = await ask('Save privately', await prepare(ixs, { names: { ...c.names, [theirs]: 'your private pocket', [pk.address]: 'your private pocket', [c.s]: 'Kashu' }, mine: c.mine }, before));
    if (!sig) return null;
  }
  await untilPocketHas(pk.address, units + P.POCKET_FEE);
  const sig = await P.pocketDeposit(units);
  await refresh();
  return sig;
}
/** Saving privately: the dollars go into the private pocket, and the vault counts the save (save_private). */
export const savePrivately = (amount: number) => addToPocket(amount);

/** A private payment to a friend's pocket: free, and nothing about it shows on Solana. */
export async function payPrivately(toWallet: string, amount: number) {
  const units = BigInt(Math.round(amount * 1e6));
  const them = await pocketOf(toWallet);
  if (!them) throw new Error('They haven\'t opened a private pocket yet');
  await P.openPocket();
  if ((await P.pocketBalance()) < units) throw new Error('Not enough in your pocket');
  return P.pocketPay(them, units);
}
/** Money from the pocket back to the wallet: a gasless withdrawal, then Kashu's relay pays for the last short hop. */
export async function cashOutPocket(amount: number) {
  const units = BigInt(Math.round(amount * 1e6));
  const pk = await P.openPocket();
  const c = await context();
  if ((await P.pocketBalance()) < units) throw new Error('Not enough in your pocket');
  // MagicBlock takes its 0.20 fee from the pocket's Solana account: top it up from the wallet if it's short
  const have = await tokenBal(pk.address);
  if (have < P.POCKET_FEE) {
    const d = new Uint8Array(10); d[0] = 12; new DataView(d.buffer).setBigUint64(1, P.POCKET_FEE - have, true); d[9] = 6;
    const theirs = await ata(pk.address, USDC_MINT);
    const sig = await ask('Cover the pocket\'s 0.20 fee', await prepare([{ programAddress: TOKEN, data: d, accounts: [{ address: c.usdc, role: 1 }, { address: USDC_MINT, role: 0 }, { address: theirs, role: 1 }, { address: c.wallet, role: 2 }] }], { names: { ...c.names, [theirs]: 'your private pocket' }, mine: c.mine }));
    if (!sig) return null;
    await untilPocketHas(pk.address, P.POCKET_FEE);
  }
  const start = await tokenBal(pk.address);
  await P.pocketWithdraw(units);
  await untilPocketHas(pk.address, start - P.POCKET_FEE + units);
  // the hop home: built here, signed by the pocket, paid and checked by the relay
  const { setTransactionMessageFeePayer, createTransactionMessage, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction, getBase64EncodedWireTransaction, pipe } = await import('@solana/kit');
  const d = new Uint8Array(10); d[0] = 12; new DataView(d.buffer).setBigUint64(1, units, true); d[9] = 6;
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const pocketAta = await ata(pk.address, USDC_MINT);
  const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(address(c.s), m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions([{ programAddress: address(TOKEN), data: d, accounts: [
      { address: address(pocketAta), role: 1 }, { address: address(USDC_MINT), role: 0 }, { address: address(c.usdc), role: 1 }, { address: address(pk.address), role: 2 }] }], m));
  const walletBefore = await tokenBal(c.wallet);
  const sig = await P.pocketToWallet(getBase64EncodedWireTransaction(compileTransaction(msg as never)), c.wallet);
  // the relay answers once it has sent it: wait for the dollars to land so the screen shows them
  for (let i = 0; i < 30; i++) { forget(); if ((await tokenBal(c.wallet)) >= walletBefore + units) break; await new Promise((r) => setTimeout(r, 1000)); }
  await refresh();
  return sig;
}

// ---- reading accounts: one batched request where it can be, and a short memory so a screen's reads don't repeat ----
type Acc = { owner: string; data: Uint8Array } | null;
const seen = new Map<string, { at: number; v: Promise<Acc> }>();
const FRESH_MS = 2500;
const decode = (v: any): Acc => (v ? { owner: v.owner as string, data: Uint8Array.from(atob(v.data[0] as string), (ch) => ch.charCodeAt(0)) } : null);
/** Fetches up to 100 accounts in one request and remembers them for a moment. */
async function prime(addrs: string[]) {
  const list = [...new Set(addrs)];
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    const got = rpc.getMultipleAccounts(part.map((a) => address(a)), { encoding: 'base64' }).send().then((r) => r.value.map(decode));
    part.forEach((a, j) => seen.set(a, { at: Date.now(), v: got.then((vals) => vals[j]) }));
    await got;
  }
}
function account(a: string): Promise<Acc> {
  const hit = seen.get(a);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.v;
  const v = rpc.getAccountInfo(address(a), { encoding: 'base64' }).send().then((r) => decode(r.value));
  seen.set(a, { at: Date.now(), v });
  v.catch(() => seen.delete(a));
  return v;
}
/** Forget what was read (after a transaction lands, everything is read again). */
const forget = () => seen.clear();
const exists = async (a: string) => !!(await account(a));
async function bytes(a: string) {
  const v = await account(a);
  if (!v) throw new Error('missing account');
  return v.data;
}
const rents = new Map<number, Promise<bigint>>();
/** Rent for an account of this size (it doesn't change, so it's asked once). */
const rentFor = (size: number) => { if (!rents.has(size)) rents.set(size, rpc.getMinimumBalanceForRentExemption(BigInt(size)).send().then(BigInt)); return rents.get(size)!; };
const tokenAmount = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset).getBigUint64(64, true);

/** What an invite shows before joining: the room's name, who started it (their tag) and how many are in it. */
export async function roomPreview(room: string): Promise<{ name: string; by: string | null; members: number; private: boolean } | null> {
  const acc = await account(room).catch(() => null);
  if (!acc) return null;
  try {
    const r = R.readRoom(acc.data);
    return { name: r.name, by: await tagOfWallet(r.creator).catch(() => null), members: r.members, private: acc.owner === DELEGATION };
  } catch { return null; }
}

/**
 * A cheer: free, no Face ID. This phone's viewer key (which the room already lists) signs it, and Kashu's keeper checks
 * that signature against the room's record before adding the cheer, on the private rollup when the room is private.
 */
export async function cheerFriend(to: string, week: number) {
  const r = savedRoom();
  if (!r || !week) throw new Error('No room yet');
  const { wallet } = await ensureWallet();
  const msg = new TextEncoder().encode(`kashu-cheer:${r.room}:${to}:${week}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, (await viewerKey()).keys.privateKey, msg));
  const { base58 } = await import('@readback/review');
  const res = await fetch(`${RELAY}/cheer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: r.room, from: wallet, to, week, sig: base58(sig) }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'The cheer didn\'t go through');
}

// ---- Kashu's agent: chores the saver sets, which the vault enforces ----
export const AGENT_URL = `${RELAY}/agent`;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export type Proposal = { weekly_cap: number; chores: { kind: 'save' | 'save_private' | 'pay' | 'remind'; amount?: number; weekday: string; hour: number; to?: string }[] };
export type AgentState = { on: boolean; cap: number; spent: number; chores: { kind: number; amount: number; weekday: number; hour: number; to: string | null; lastRun: number }[] } | null;
/** The saver's agent policy, as the chain has it (null when they never set one). */
export async function readAgent(): Promise<AgentState> {
  const c = await context();
  const a = await account(await V.agentPolicyPda(c.wallet));
  if (!a) return null;
  const p = V.readPolicy(a.data);
  const tags = await Promise.all(p.payees.map((w: string) => (w === SYSTEM ? null : tagOfWallet(w).then((t) => (t ? `$${t}` : `${w.slice(0, 4)}…`), () => null))));
  return {
    on: p.agent !== SYSTEM, cap: Number(p.weeklyCap) / 1e6, spent: Number(p.spent) / 1e6,
    chores: p.chores.filter((x: { kind: number }) => x.kind).map((x: { kind: number; amount: bigint; weekday: number; hour: number; payee: number; lastRun: bigint }) => ({ kind: x.kind, amount: Number(x.amount) / 1e6, weekday: x.weekday, hour: x.hour, to: x.kind === V.CHORE.PAY ? tags[x.payee] : null, lastRun: Number(x.lastRun) })),
  };
}
/** A local weekday and hour, as the chain keeps them (UTC). */
function toUtc(weekday: string, hour: number) {
  const d = new Date(); const want = DAYS.indexOf(weekday.toLowerCase());
  d.setDate(d.getDate() + ((want - d.getDay() + 7) % 7)); d.setHours(hour, 0, 0, 0);
  return { weekday: d.getUTCDay(), hour: d.getUTCHours() };
}
/** UTC back to this phone's local weekday and hour, for showing. */
export function toLocal(weekday: number, hour: number) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7)); d.setUTCHours(hour, 0, 0, 0);
  return { day: DAYS[d.getDay()][0].toUpperCase() + DAYS[d.getDay()].slice(1), hour: d.getHours() };
}
/** Sets up the agent the saver approved: their policy and the allowance (to the vault's agent authority, never the agent). */
export async function setupAgent(p: Proposal) {
  const c = await context();
  const agent = (await (await fetch(`${RELAY}/health`)).json()).agent as string | null;
  if (!agent) throw new Error('Kashu\'s agent isn\'t running right now');
  const payees: string[] = [];
  const chores = [];
  for (const ch of p.chores.slice(0, 4)) {
    const kind = { save: V.CHORE.SAVE, save_private: V.CHORE.SAVE_PRIVATE, pay: V.CHORE.PAY, remind: V.CHORE.REMIND }[ch.kind];
    let payee = 0;
    if (ch.kind === 'pay') {
      const who = await lookup(ch.to ?? '');
      if ('error' in who) throw new Error(`${ch.to}: ${who.error}`);
      payee = payees.indexOf(who.owner); if (payee < 0) { payees.push(who.owner); payee = payees.length - 1; }
    }
    if (ch.kind === 'save_private' && !(await pocketOf(c.wallet))) throw new Error('Open your private pocket once first (in your profile), so the agent knows where it is');
    chores.push({ kind, amount: BigInt(Math.round((ch.amount ?? 0) * 1e6)), payee, ...toUtc(ch.weekday, ch.hour) });
  }
  const cap = BigInt(Math.round(p.weekly_cap * 1e6));
  const auth = await V.agentAuthPda(c.wallet);
  const fresh = !(await exists(await V.agentPolicyPda(c.wallet)));
  const before = fresh ? [systemTransfer(c.s, c.wallet, await rentFor(8 + 297))] : [];
  const ixs = [strip(await V.setAgentIx({ owner: { address: c.wallet }, agent, weeklyCap: cap, payees, chores })),
    // a month of chores' worth, with Kashu's one-cent fee per run; the vault still holds the agent to its weekly cap
    strip(await V.approveAgentIx({ owner: { address: c.wallet }, from: c.usdc, usdcMint: USDC_MINT, amount: (cap + BigInt(chores.filter((x) => x.kind !== V.CHORE.REMIND).length) * V.AGENT_FEE) * 4n }))];
  const sig = await ask('Set up your agent', await prepare(ixs, { names: { ...c.names, [auth]: 'your agent (only through your vault\'s rules)', [c.s]: 'Kashu' }, mine: c.mine, trustedDelegates: [auth] }, before));
  if (sig) await refresh();
  return sig;
}
/** Turns the agent off and takes back its allowance. */
export async function stopAgent() {
  const c = await context();
  const revoke: Ix = { programAddress: TOKEN, data: new Uint8Array([5]), accounts: [{ address: c.usdc, role: 1 }, { address: c.wallet, role: 2 }] };
  const sig = await ask('Turn your agent off', await prepare([strip(await V.setAgentIx({ owner: { address: c.wallet } })), revoke], { names: c.names, mine: c.mine }));
  if (sig) await refresh();
  return sig;
}

// ---- profile photos ----
/** A saver's photo hash (null: none), for showing them anywhere (a friend found by tag, say). */
export async function avatarOf(wallet: string) { const a = await account(await R.avatarOfPda(wallet)).catch(() => null); return a ? R.readAvatarOf(a.data) as string | null : null; }
/**
 * Sets the saver's profile photo: cropped square and re-encoded here (256 px WebP, which also drops any location or
 * camera details the original carried), stored by Kashu's relay under its SHA-256, and named on chain by the wallet.
 */
/** Opens a picked photo. createImageBitmap is fastest, but some phones' photos (HEIC) only open through an <img>. */
async function decodePhoto(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try { return await createImageBitmap(file); } catch { /* try the browser's own image loader */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('Kashu can\'t open that kind of photo on this phone. Try a JPEG or a screenshot.');
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export async function setPhoto(file: File | null) {
  const c = await context();
  let hash = new Uint8Array(32);
  if (file) {
    const img = await decodePhoto(file);
    const w = 'naturalWidth' in img ? img.naturalWidth : img.width, h = 'naturalHeight' in img ? img.naturalHeight : img.height;
    const side = Math.min(w, h), canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#f6efe4'; g.fillRect(0, 0, 256, 256); // a transparent PNG would turn black as a JPEG
    g.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 256, 256);
    // WebP where the browser can make it; iPhones can't, and quietly hand back a PNG, so JPEG there. Redrawing on a
    // canvas leaves the original's metadata (location, camera) behind either way.
    let blob: Blob | null = null;
    for (const type of ['image/webp', 'image/jpeg']) {
      for (const q of [0.86, 0.72, 0.55]) { blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, q)); if (!blob || blob.type !== type || blob.size <= 60_000) break; }
      if (blob && blob.type === type && blob.size <= 60_000) break;
      blob = null;
    }
    if (!blob) throw new Error('This phone couldn\'t shrink that photo. Try a screenshot of it instead.');
    const r = await fetch(`${RELAY}/avatar`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? 'The photo didn\'t upload');
    hash = Uint8Array.from(j.hash.match(/../g).map((x: string) => parseInt(x, 16)));
  }
  const fresh = !(await exists(await R.avatarOfPda(c.wallet)));
  const before = fresh ? [systemTransfer(c.s, c.wallet, await rentFor(8 + 33))] : [];
  const sig = await ask(file ? 'Set your photo' : 'Remove your photo', await prepare([strip(await R.setAvatarIx({ owner: { address: c.wallet }, hash }))], { names: { ...c.names, [c.s]: 'Kashu' }, mine: c.mine }, before));
  if (sig) await refresh();
  return sig;
}

// ---- win notifications ----
const PUSH_KEY = 'kashu.push.v1';
export const winAlertsOn = () => { try { return localStorage.getItem(PUSH_KEY) === '1'; } catch { return false; } };
/** Asks this phone to show a notification when the saver wins. The subscription is signed by this phone's room key,
 * which Kashu's keeper checks against the room before it will notify anyone. */
export async function enableWinAlerts() {
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error(iOS && !installed ? 'On iPhone, add Kashu to your Home Screen first (Share, then Add to Home Screen), then turn this on there.' : 'This browser can\'t show notifications.');
  }
  const r = savedRoom(); if (!r) throw new Error('Join a room first');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are off for Kashu. Turn them on in your phone\'s settings.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const key = (await (await fetch(`${RELAY}/push-key`)).json()).key as string;
  const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }));
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const { wallet } = await ensureWallet();
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, (await viewerKey()).keys.privateKey, new TextEncoder().encode(`kashu-push:${r.room}:${j.endpoint}`)));
  const { base58 } = await import('@readback/review');
  const res = await fetch(`${RELAY}/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: r.room, owner: wallet, sub: j, sig: base58(sig) }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Couldn\'t turn it on');
  try { localStorage.setItem(PUSH_KEY, '1'); } catch { /* fine */ }
}

/** "Add this phone": ask (on Solana) for this phone's viewer key to read the private room; Kashu's keeper applies it. */
export async function addPhone() {
  const c = await context(), r = savedRoom();
  if (!r) throw new Error('No room yet');
  const viewer = (await viewerKey()).address;
  const ix = strip(await R.requestViewerIx({ owner: { address: c.wallet }, room: r.room, viewer }));
  const fresh = !(await exists(await R.viewerRequestPda(r.room, c.wallet)));
  const before = fresh ? [systemTransfer(c.s, c.wallet, await rentFor(105))] : [];
  return ask('Use this phone', await prepare([ix], { names: { ...c.names, [c.s]: 'Kashu' }, mine: c.mine }, before));
}

/** Reads the person's vault, room, friends and prize pot from the chain into the store. */
export async function refresh() {
  if (!savedPasskey()) return;
  showDollars(true);
  const c = await context();
  const r = savedRoom();
  forget();
  await prime([c.va.userVault, await V.shareAccount(c.va.userVault, MARKET.fTokenMint), MARKET.lending, c.usdc, await R.tagOfPda(c.wallet),
    await R.avatarOfPda(c.wallet), ...(r ? [r.room, await V.potUsdcPda(r.room), await R.resultPda(r.room)] : [])]);
  const live: LiveState = { avatar: await account(await R.avatarOfPda(c.wallet)).then((a) => (a ? R.readAvatarOf(a.data) : null), () => null), tag: await tagOfWallet(c.wallet).catch(() => null), walletUsdc: (await exists(c.usdc)) ? Number(tokenAmount(await bytes(c.usdc))) / 1e6 : 0, wallet: c.wallet, vault: c.va.userVault, room: r?.room ?? null, roomName: 'Your room', members: [], week: 0, saved: 0, interest: 0, pot: 0, weekly: 0, draw: null };
  try {
    const v = V.readUserVault(await bytes(c.va.userVault));
    live.saved = Number(v.cashTracked + v.lentPrincipal + v.assetBasis) / 1e6;
    // interest: what the vault's lending shares are worth at Jupiter's price, above what was put in
    try {
      const shares = tokenAmount(await bytes(await V.shareAccount(c.va.userVault, MARKET.fTokenMint)));
      const value = (shares * V.tokenExchangePrice(await bytes(MARKET.lending))) / 1_000_000_000_000n;
      live.interest = Math.max(0, Number(value - v.lentPrincipal) / 1e6);
    } catch { /* not lending yet */ }
    live.weekly = Number(v.weeklyAmount) / 1e6;
    live.roundup = Number(v.roundupUnit) / 1e6;
    live.assetPct = v.assetBps / 100;
    live.buys = v.buysDone;
    // prize winnings: the vault's own record when it has one (every prize since it began), else the keeper's tally
    const won = await account(await V.winningsPda(c.va.userVault)).then((a) => (a ? V.readWinnings(a.data) : null), () => null);
    if (won) { live.prizesWon = Number(won.totalWon) / 1e6; live.winningsLeft = Number(won.left) / 1e6; live.winningsWeekly = Number(won.weekly) / 1e6; }
    else live.prizesWon = await fetch(`${RELAY}/prizes?wallet=${c.wallet}`).then((r) => (r.ok ? r.json() : null)).then((j) => (j ? Number(j.won) || 0 : 0), () => 0);
    live.nextBuyAt = Number(v.nextBuyAt);
    live.sol = (await exists(c.va.hold)) ? Number(tokenAmount(await bytes(c.va.hold))) / 1e9 : 0;
  } catch { /* no vault yet */ }
  if (r) {
    // a private room is read on MagicBlock's TEE rollup with this phone's viewer key; on Solana only its holder shows
    const onSolana = await account(r.room);
    live.private = onSolana?.owner === DELEGATION;
    const roomBytes = live.private ? await teeAccount(r.room) : await bytes(r.room);
    if (!roomBytes) {
      // a private room this phone can't read: a new phone, or a browser that lost its viewer key
      live.needsPhone = true;
      setLive(live);
      return;
    }
    const room = R.readRoom(roomBytes);
    live.roomName = room.name; live.week = room.week;
    const nick = names();
    const avatarAt = Object.fromEntries(await Promise.all(room.roster.map(async (o: string) => [o, await R.avatarOfPda(o)])));
    const vaultOf = Object.fromEntries(await Promise.all(room.roster.map(async (o: string) => [o, (await V.vaultAddresses(o)).userVault])));
    await prime([...Object.values(avatarAt) as string[], ...Object.values(vaultOf) as string[], ...(await Promise.all(room.roster.map((o: string) => R.tagOfPda(o)))), ...(live.private ? [] : await Promise.all(room.roster.map((o: string) => R.memberPda(r.room, o))))]);
    live.members = await Promise.all(room.roster.map(async (owner: string, i: number) => {
      const at = await R.memberPda(r.room, owner);
      const mb = live.private ? await teeAccount(at) : await bytes(at);
      const m = mb ? R.readMember(mb) : { streak: 0, lastSavedWeek: -1, ticketWeek: -1, cheers: 0 };
      const t = await tagOfWallet(owner).catch(() => null);
      return { owner, tag: t, you: owner === c.wallet, name: owner === c.wallet ? 'You' : t ? `$${t}` : nick[owner] ?? `Friend ${i + 1}`, cheers: Number(m.cheers ?? 0), avatar: await account(avatarAt[owner]).then((a) => (a ? R.readAvatarOf(a.data) : null), () => null), plan: await account(vaultOf[owner]).then((a) => (a ? V.readUserVault(a.data).assetBps / 100 : null), () => null), streak: m.streak, lit: m.lastSavedWeek === room.week && m.ticketWeek === room.week };
    }));
    try { live.pot = Number(tokenAmount(await bytes(await V.potUsdcPda(r.room)))) / 1e6; } catch { /* no pot */ }
    // the latest settled draw lives in its own record, which outlasts the week (the room moves on right after paying)
    try {
      const res = R.readResult(await bytes(await R.resultPda(r.room)));
      if (res.week > 0) live.draw = { week: res.week, winner: res.winner };
    } catch { if (room.drawState === 3) live.draw = { week: room.drawWeek, winner: room.winner }; }
  }
  setLive(live);
}
