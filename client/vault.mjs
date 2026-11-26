// Instruction builders and account readers for the vault program, written by hand against
// programs/vault/src/lib.rs. There is no generated client yet (see README, next steps).

import { AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { B, sha256, disc as tag } from './bytes.mjs';

export const VAULT_PROGRAM = address('3jYUfoa788SJpFbbPS7vFxTNkWCRN1c4gx3rcgmH9GxH');
export const STUB_SWAP_PROGRAM = address('2GHiWi58tM1BMVHU52ey88ncEzQq2q6AHNnbujcvrUTF');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const LOADER_V3 = address('BPFLoaderUpgradeab1e11111111111111111111111');

export const WEEK = 7n * 24n * 60n * 60n;
export const RATE_SCALE = 1_000_000_000n;

const enc = getAddressEncoder();
const dec = getAddressDecoder();
const text = (s) => new TextEncoder().encode(s);
const disc = tag;
const u64 = (n) => { const b = B.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = B.alloc(2); b.writeUInt16LE(Number(n)); return b; };
const data = (name, ...parts) => new Uint8Array(B.concat([disc(name), ...parts]));

const pda = async (programAddress, seeds) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];

// Account metas. `s` may be a signer object or a plain address.
const addrOf = (s) => (typeof s === 'string' ? s : s.address);
const ro = (a) => ({ address: addrOf(a), role: AccountRole.READONLY });
const rw = (a) => ({ address: addrOf(a), role: AccountRole.WRITABLE });
const roSigner = (s) => ({ address: s.address, role: AccountRole.READONLY_SIGNER, signer: s });
const rwSigner = (s) => ({ address: s.address, role: AccountRole.WRITABLE_SIGNER, signer: s });

export const configPda = () => pda(VAULT_PROGRAM, [text('config')]);
export const programDataPda = (program = VAULT_PROGRAM) => pda(LOADER_V3, [enc.encode(program)]);

/** Every address that belongs to one user's vault. */
export async function vaultAddresses(owner) {
  const userVault = await pda(VAULT_PROGRAM, [text('vault'), enc.encode(owner)]);
  const seed = enc.encode(userVault);
  return {
    userVault,
    cash: await pda(VAULT_PROGRAM, [text('cash'), seed]),
    hold: await pda(VAULT_PROGRAM, [text('hold'), seed]),
    swapAuthority: await pda(VAULT_PROGRAM, [text('swap_auth'), seed]),
  };
}

/** The stub venue's addresses for one pair. */
export async function poolAddresses(usdcMint, assetMint) {
  const pool = await pda(STUB_SWAP_PROGRAM, [text('pool'), enc.encode(usdcMint), enc.encode(assetMint)]);
  return {
    pool,
    poolUsdc: await pda(STUB_SWAP_PROGRAM, [text('pool_usdc'), enc.encode(pool)]),
    poolAsset: await pda(STUB_SWAP_PROGRAM, [text('pool_asset'), enc.encode(pool)]),
  };
}

export async function initializeIx({ admin, usdcMint, assetMint, swapProgram = STUB_SWAP_PROGRAM, perUserCap, totalCap, floorRate }) {
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [rwSigner(admin), rw(await configPda()), ro(usdcMint), ro(assetMint), ro(swapProgram),
      ro(VAULT_PROGRAM), ro(await programDataPda()), ro(SYSTEM_PROGRAM)],
    data: data('initialize', u64(perUserCap), u64(totalCap), u64(floorRate)),
  };
}

const adminIx = async (name, admin, ...parts) => ({
  programAddress: VAULT_PROGRAM,
  accounts: [roSigner(admin), rw(await configPda())],
  data: data(name, ...parts),
});
export const setPausedIx = (admin, paused) => adminIx('set_paused', admin, B.from([paused ? 1 : 0]));
export const setCapsIx = (admin, perUserCap, totalCap) => adminIx('set_caps', admin, u64(perUserCap), u64(totalCap));
export const setFloorRateIx = (admin, floorRate) => adminIx('set_floor_rate', admin, u64(floorRate));
export const proposeAdminIx = (admin, next) => adminIx('propose_admin', admin, B.from(enc.encode(next)));
export const acceptAdminIx = (next) => adminIx('accept_admin', next);

export async function openVaultIx({ payer, owner, usdcMint, assetMint }) {
  const a = await vaultAddresses(owner.address);
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [rwSigner(payer), roSigner(owner), ro(await configPda()), rw(a.userVault), rw(a.cash), rw(a.hold),
      ro(a.swapAuthority), ro(usdcMint), ro(assetMint), ro(TOKEN_PROGRAM), ro(SYSTEM_PROGRAM)],
    data: data('open_vault'),
  };
}

const ownerIx = async (name, owner, ...parts) => ({
  programAddress: VAULT_PROGRAM,
  accounts: [roSigner(owner), rw((await vaultAddresses(owner.address)).userVault)],
  data: data(name, ...parts),
});
export const setRuleIx = (owner, { weeklyAmount, roundupUnit, assetBps }) =>
  ownerIx('set_rule', owner, u64(weeklyAmount), u64(roundupUnit), u16(assetBps));
export const noteSpendIx = (owner, spendAmount) => ownerIx('note_spend', owner, u64(spendAmount));

export async function depositIx({ owner, from, usdcMint, amount, vaultOf = owner.address }) {
  const a = await vaultAddresses(vaultOf);
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [roSigner(owner), rw(await configPda()), rw(a.userVault), rw(a.cash), rw(from), ro(usdcMint), ro(TOKEN_PROGRAM)],
    data: data('deposit', u64(amount)),
  };
}

/**
 * The weekly button. The instruction carries no numbers. `overrides` exists only so tests can try
 * to cheat by swapping an account for another one.
 */
export const PYTH_RECEIVER = address('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
export const venuePda = () => pda(VAULT_PROGRAM, [text('venue')]);
/** This week's spend from the owner's rule (as the program works it out): what the weekly job routes. */
export function thisWeekSpend(v) {
  const budget = [v.weeklyAmount + v.pendingRoundup, v.cashTracked + (v.lentPrincipal ?? 0n)].reduce((a, b) => (a < b ? a : b));
  return (budget * BigInt(v.assetBps)) / 10_000n;
}
/** A route through the stub venue (tests, devnet): from the swap authority's own dollar account into its own asset account. */
export function stubRoute({ swapAuthority, source, destination, pool, poolUsdc, poolAsset, usdcMint, assetMint, amountIn, minOut = 0n }) {
  return {
    data: B.concat([disc('swap'), u64(amountIn), u64(minOut)]),
    accounts: [ro(swapAuthority), rw(source), rw(destination), ro(pool), rw(poolUsdc), rw(poolAsset), ro(usdcMint), ro(assetMint), ro(TOKEN_PROGRAM)],
  };
}
/**
 * The weekly buy. `route` is { data, accounts } for the venue (Jupiter's swap-instructions on mainnet,
 * stubRoute in tests); without one, a stub route for `amountIn` is built. `overrides` swaps any named
 * account, in the vault's list and in the stub route alike, so tests can try hostile ones.
 */
export async function weeklyBuyIx({ cranker, owner, usdcMint, assetMint, priceUpdate, amountIn = 0n, route, swapProgram = STUB_SWAP_PROGRAM, overrides = {} }) {
  const a = await vaultAddresses(owner);
  const p = await poolAddresses(usdcMint, assetMint);
  const x = { ...a, ...p, usdcMint, assetMint, swapProgram, priceUpdate, ...overrides };
  x.swapIn = x.swapIn ?? await shareAccount(x.swapAuthority, x.usdcMint);
  x.swapOut = x.swapOut ?? await shareAccount(x.swapAuthority, x.assetMint);
  const r = route ?? stubRoute({ swapAuthority: x.swapAuthority, source: x.routeSource ?? x.swapIn, destination: x.routeDestination ?? x.swapOut, pool: x.pool, poolUsdc: x.poolUsdc, poolAsset: x.poolAsset, usdcMint: x.usdcMint, assetMint: x.assetMint, amountIn, minOut: x.stubMinOut ?? 0n });
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [roSigner(cranker), ro(await configPda()), rw(x.userVault), rw(x.cash), rw(x.hold), ro(x.swapAuthority),
      ro(x.usdcMint), ro(x.assetMint), rw(x.swapIn), rw(x.swapOut), ro(x.venue ?? await venuePda()), ro(x.swapProgram), ro(x.priceUpdate), ro(TOKEN_PROGRAM), ...r.accounts],
    data: data('weekly_buy', B.concat([B.from(new Uint32Array([r.data.length]).buffer), B.from(r.data)])),
  };
}
export async function setVenueIx({ admin, swapProgram, priceFeed, feedId, maxAgeSecs = 120, maxConfBps = 100, slippageBps = 100 }) {
  const u32 = (n) => { const b = B.alloc(4); b.writeUInt32LE(n); return b; };
  const u16 = (n) => { const b = B.alloc(2); b.writeUInt16LE(n); return b; };
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [rwSigner(admin), ro(await configPda()), rw(await venuePda()), ro(swapProgram), ro(SYSTEM_PROGRAM)],
    data: data('set_venue', B.from(enc.encode(priceFeed)), B.from(feedId), u32(maxAgeSecs), u16(maxConfBps), u16(slippageBps)),
  };
}
/** Bytes of a Pyth PriceUpdateV2 account (fully verified), for tests and local checks. */
export function priceUpdateBytes({ feedId, price, conf, expo, publishTime }) {
  const b = B.alloc(133); let o = 0;
  sha256('account:PriceUpdateV2').copy(b, 0, 0, 8); o = 8;
  o += 32; b[o++] = 1; // write authority, then verification level Full
  B.from(feedId).copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(price), o); o += 8; b.writeBigUInt64LE(BigInt(conf), o); o += 8; b.writeInt32LE(expo, o); o += 4;
  b.writeBigInt64LE(BigInt(publishTime), o); o += 8; b.writeBigInt64LE(BigInt(publishTime), o); o += 8;
  b.writeBigInt64LE(BigInt(price), o); o += 8; b.writeBigUInt64LE(BigInt(conf), o); o += 8;
  return new Uint8Array(b);
}

async function withdrawIx(name, { owner, ownerUsdc, ownerAsset, usdcMint, assetMint, amount, vaultOf = owner.address }) {
  const a = await vaultAddresses(vaultOf);
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [roSigner(owner), rw(await configPda()), rw(a.userVault), rw(a.cash), rw(a.hold), rw(ownerUsdc), rw(ownerAsset),
      ro(usdcMint), ro(assetMint), ro(TOKEN_PROGRAM)],
    data: data(name, u64(amount)),
  };
}
export const withdrawCashIx = (args) => withdrawIx('withdraw_cash', args);
export const withdrawAssetIx = (args) => withdrawIx('withdraw_asset', args);

// The hash-based withdrawal key. Messages here must match programs/vault/src/lib.rs byte for byte.
const u32 = (n) => { const b = B.alloc(4); b.writeUInt32LE(n); return b; };
const vec32 = (items) => B.concat([u32(items.length), ...items]);
const sha = (...parts) => sha256(...parts);

/** What a one-time key signs to let `amount` of `mint` go to `destination`. */
export const withdrawMessage = ({ userVault, leaf, mint, amount, destination }) =>
  sha(text('sv-withdraw'), enc.encode(VAULT_PROGRAM), enc.encode(userVault), u32(leaf), enc.encode(mint), u64(amount), enc.encode(destination));

/** What a one-time key signs to hand over to a new key tree. */
export const rotateMessage = ({ userVault, leaf, newSeed, newRoot, newHeight }) =>
  sha(text('sv-rotate'), enc.encode(VAULT_PROGRAM), enc.encode(userVault), u32(leaf), newSeed, newRoot, B.from([newHeight]));

export const enrollPqIx = (owner, { seed, root, height }) => ownerIx('enroll_pq', owner, seed, root, B.from([height]));

/** Needs a v1 transaction: the signature alone is 2,144 bytes. */
export async function withdrawPqIx({ relayer, owner, destination, usdcMint, assetMint, isCash, amount, leaf, sig, path }) {
  const a = await vaultAddresses(owner);
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [roSigner(relayer), rw(await configPda()), rw(a.userVault), rw(a.cash), rw(a.hold), rw(destination),
      ro(usdcMint), ro(assetMint), ro(TOKEN_PROGRAM)],
    data: data('withdraw_pq', B.from([isCash ? 1 : 0]), u64(amount), u32(leaf), vec32(sig), vec32(path)),
  };
}

export async function rotatePqIx({ relayer, owner, newSeed, newRoot, newHeight, leaf, sig, path }) {
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [roSigner(relayer), rw((await vaultAddresses(owner)).userVault)],
    data: data('rotate_pq', newSeed, newRoot, B.from([newHeight]), u32(leaf), vec32(sig), vec32(path)),
  };
}

/** Stub venue, tests and devnet only. */
export async function initPoolIx({ payer, usdcMint, assetMint, rate, mode = 0 }) {
  const p = await poolAddresses(usdcMint, assetMint);
  return {
    programAddress: STUB_SWAP_PROGRAM,
    accounts: [rwSigner(payer), ro(usdcMint), ro(assetMint), rw(p.pool), rw(p.poolUsdc), rw(p.poolAsset), ro(TOKEN_PROGRAM), ro(SYSTEM_PROGRAM)],
    data: data('init_pool', u64(rate), B.from([mode])),
  };
}

// Readers. Offsets follow the field order in programs/vault/src/state.rs, after the 8-byte tag.
export function readConfig(bytes) {
  const b = B.from(bytes);
  const key = (o) => dec.decode(b.subarray(o, o + 32));
  return {
    admin: key(8), pendingAdmin: key(40), usdcMint: key(72), assetMint: key(104), swapProgram: key(136),
    perUserCap: b.readBigUInt64LE(168), totalCap: b.readBigUInt64LE(176), totalPrincipal: b.readBigUInt64LE(184),
    floorRate: b.readBigUInt64LE(192), paused: b[200] === 1,
  };
}

export function readUserVault(bytes) {
  const b = B.from(bytes);
  return {
    owner: dec.decode(b.subarray(8, 40)),
    cashTracked: b.readBigUInt64LE(40), assetBasis: b.readBigUInt64LE(48), weeklyAmount: b.readBigUInt64LE(56),
    roundupUnit: b.readBigUInt64LE(64), pendingRoundup: b.readBigUInt64LE(72), assetBps: b.readUInt16LE(80),
    nextBuyAt: b.readBigInt64LE(82), buysDone: b.readUInt32LE(90),
    pqRoot: b.subarray(130, 162), pqHeight: b[162], pqNextLeaf: b.readUInt32LE(163),
    lentPrincipal: b.length >= 175 ? b.readBigUInt64LE(167) : 0n,
  };
}

/**
 * What a friend is allowed to see: the shape of the mix in whole percent, never an amount.
 * `rate` is asset base units per dollar base unit times RATE_SCALE (from a price feed later).
 */
export function mixPercent({ cashAmount, assetAmount, rate }) {
  const assetInDollars = (BigInt(assetAmount) * RATE_SCALE) / BigInt(rate);
  const total = BigInt(cashAmount) + assetInDollars;
  if (total === 0n) return { dollars: 0, asset: 0 };
  const asset = Number((assetInDollars * 100n + total / 2n) / total);
  return { dollars: 100 - asset, asset };
}

// ---- Jupiter Lend (Earn): the vault lends its own dollars and holds the shares itself ----------------
export const LEND = {
  devnet: { program: address('7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3'), liquidity: address('5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL') },
  mainnet: { program: address('jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9'), liquidity: address('jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC') },
};
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const shareAccount = (vault, shareMint) => pda(ATA_PROGRAM, [enc.encode(vault), enc.encode(TOKEN_PROGRAM), enc.encode(shareMint)]);
/**
 * `market` holds Jupiter Lend's accounts for our dollar token (from the Lend SDK's deposit context):
 * lendingAdmin, lending, fTokenMint, supplyReserves, supplyPosition, rateModel, vault, liquidity,
 * rewardsRateModel, claimAccount, and `cluster` ('devnet' | 'mainnet').
 */
async function lendAccounts(name, { owner, usdcMint, market }, withClaim) {
  const a = await vaultAddresses(owner.address);
  const ids = LEND[market.cluster];
  const accounts = [roSigner(owner), rw(await configPda()), rw(a.userVault), rw(a.cash), rw(await shareAccount(a.userVault, market.fTokenMint)), rw(await shareAccount(a.userVault, usdcMint)), ro(usdcMint)];
  if (withClaim) accounts.push(rw(market.claimAccount));
  accounts.push(ro(market.lendingAdmin), rw(market.lending), rw(market.fTokenMint), rw(market.supplyReserves), rw(market.supplyPosition),
    ro(market.rateModel), rw(market.vault), rw(market.liquidity), rw(ids.liquidity), ro(market.rewardsRateModel), ro(ids.program),
    ro(TOKEN_PROGRAM), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM));
  return accounts;
}
export async function lendIx(args) {
  return { programAddress: VAULT_PROGRAM, accounts: await lendAccounts('lend', args, false), data: data('lend', u64(args.amount)) };
}
export async function unlendIx(args) {
  return { programAddress: VAULT_PROGRAM, accounts: await lendAccounts('unlend', args, true), data: data('unlend', u64(args.amount)) };
}

/** Anyone, when a buy is due: bring back from Jupiter Lend exactly what the buy is short. */
export async function prepareBuyIx({ cranker, owner, usdcMint, market }) {
  const a = await vaultAddresses(owner);
  const ids = LEND[market.cluster];
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [roSigner(cranker), ro(await configPda()), rw(a.userVault), rw(a.cash), rw(await shareAccount(a.userVault, market.fTokenMint)),
      rw(await shareAccount(a.userVault, usdcMint)), ro(usdcMint), rw(market.claimAccount),
      ro(market.lendingAdmin), rw(market.lending), rw(market.fTokenMint), rw(market.supplyReserves), rw(market.supplyPosition),
      ro(market.rateModel), rw(market.vault), rw(market.liquidity), rw(ids.liquidity), ro(market.rewardsRateModel), ro(ids.program),
      ro(TOKEN_PROGRAM), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM)],
    data: data('prepare_buy'),
  };
}

// ---- the Friday prize: interest feeds each room's pot, the pot pays the draw's winner ----
export const ROOMS_PROGRAM = address('8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q');
export const DELEGATION_PROGRAM = address('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
export const prizePda = () => pda(VAULT_PROGRAM, [text('prize')]);
export const potPda = (room) => pda(VAULT_PROGRAM, [text('pot'), enc.encode(room)]);
export const potUsdcPda = (room) => pda(VAULT_PROGRAM, [text('pot_usdc'), enc.encode(room)]);
export const linkPda = (userVault) => pda(VAULT_PROGRAM, [text('link'), enc.encode(userVault)]);
export const resultOf = (room) => pda(ROOMS_PROGRAM, [text('result'), enc.encode(room)]);
export const delegationRecordPda = (account) => pda(DELEGATION_PROGRAM, [text('delegation'), enc.encode(account)]);

export async function initPrizeIx(admin, cutBps) {
  return { programAddress: VAULT_PROGRAM, accounts: [rwSigner(admin), ro(await configPda()), rw(await prizePda()), ro(SYSTEM_PROGRAM)], data: data('init_prize', u16(cutBps)) };
}
export async function setPrizeCutIx(admin, cutBps) {
  return { programAddress: VAULT_PROGRAM, accounts: [roSigner(admin), ro(await configPda()), rw(await prizePda())], data: data('set_prize_cut', u16(cutBps)) };
}
/** Anyone opens a room's pot. The room must be a rooms-program Room (at home or delegated). */
export async function openPotIx({ payer, room, usdcMint }) {
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [rwSigner(payer), ro(await configPda()), ro(room), ro(await delegationRecordPda(room)), rw(await potPda(room)), rw(await potUsdcPda(room)),
      ro(usdcMint), ro(TOKEN_PROGRAM), ro(SYSTEM_PROGRAM)],
    data: data('open_pot'),
  };
}
export async function linkPotIx({ owner, room }) {
  const a = await vaultAddresses(owner.address);
  return { programAddress: VAULT_PROGRAM, accounts: [rwSigner(owner), ro(a.userVault), ro(await potPda(room)), rw(await linkPda(a.userVault)), ro(SYSTEM_PROGRAM)], data: data('link_pot') };
}
export async function unlinkPotIx({ owner }) {
  const a = await vaultAddresses(owner.address);
  return { programAddress: VAULT_PROGRAM, accounts: [rwSigner(owner), ro(a.userVault), rw(await linkPda(a.userVault))], data: data('unlink_pot') };
}
/** Anyone harvests a linked vault's interest into its room's pot; `treasury` is the admin's own dollar account. */
export async function harvestIx({ cranker, owner, room, treasury, usdcMint, market }) {
  const a = await vaultAddresses(owner);
  const ids = LEND[market.cluster];
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [roSigner(cranker), ro(await configPda()), ro(await prizePda()), rw(a.userVault), ro(await linkPda(a.userVault)), rw(await potPda(room)),
      rw(await potUsdcPda(room)), rw(treasury), rw(a.cash), rw(await shareAccount(a.userVault, market.fTokenMint)), rw(await shareAccount(a.userVault, usdcMint)),
      ro(usdcMint), rw(market.claimAccount),
      ro(market.lendingAdmin), rw(market.lending), rw(market.fTokenMint), rw(market.supplyReserves), rw(market.supplyPosition),
      ro(market.rateModel), rw(market.vault), rw(market.liquidity), rw(ids.liquidity), ro(market.rewardsRateModel), ro(ids.program),
      ro(TOKEN_PROGRAM), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM)],
    data: data('harvest'),
  };
}
/** Anyone pays a settled draw: the room's whole pot to the winner's vault. */
export async function payPrizeIx({ cranker, room, winner, usdcMint }) {
  const w = await vaultAddresses(winner);
  return {
    programAddress: VAULT_PROGRAM,
    // the rooms program's draw-result record for the room (and its delegation record when it is on the rollup)
    accounts: [roSigner(cranker), rw(await configPda()), rw(await potPda(room)), rw(await potUsdcPda(room)), ro(await resultOf(room)), ro(await delegationRecordPda(await resultOf(room))),
      rw(w.userVault), rw(w.cash), ro(usdcMint), ro(TOKEN_PROGRAM), rw(await winningsPda(w.userVault)), ro(SYSTEM_PROGRAM)],
    data: data('pay_prize'),
  };
}
/** A saver's winnings record ["winnings", user_vault]: kept apart from their savings. */
export const winningsPda = (userVault) => pda(VAULT_PROGRAM, [text('winnings'), enc.encode(userVault)]);
export function readWinnings(bytes) {
  const b = B.from(bytes);
  return { vault: dec.decode(b.subarray(8, 40)), totalWon: b.readBigUInt64LE(40), left: b.readBigUInt64LE(48), weekly: b.readBigUInt64LE(56), nextAt: b.readBigInt64LE(64), prizes: b.readUInt32LE(72) };
}
/** How many dollars of winnings become the asset each week (zero stops it). Never touches savings. */
export async function setDcaIx({ owner, weekly }) {
  const a = await vaultAddresses(owner.address);
  return { programAddress: VAULT_PROGRAM, accounts: [rwSigner(owner), ro(a.userVault), rw(await winningsPda(a.userVault)), ro(SYSTEM_PROGRAM)], data: data('set_dca', u64(weekly)) };
}
/** The winnings buy: the weekly buy's accounts (same hostile-route checks), then the winnings record. */
export async function dcaBuyIx(args) {
  const ix = await weeklyBuyIx(args);
  const a = await vaultAddresses(args.owner);
  const n = 14; // weekly_buy's own accounts, before the route's
  return { ...ix, accounts: [...ix.accounts.slice(0, n), rw(await winningsPda(a.userVault)), ...ix.accounts.slice(n)], data: B.concat([disc('dca_buy'), B.from(ix.data).subarray(8)]) };
}
export function readPot(bytes) {
  const b = B.from(bytes);
  return { room: dec.decode(b.subarray(8, 40)), paidThrough: b.readUInt32LE(40), harvested: b.readBigUInt64LE(44), cutTaken: b.readBigUInt64LE(52), paidOut: b.readBigUInt64LE(60) };
}
/** Jupiter Lend's recorded share price (1e12 scale) from its lending account. */
export const tokenExchangePrice = (lendingBytes) => B.from(lendingBytes).readBigUInt64LE(115);

/** A private save: from the saver's wallet to their own private pocket's dollar account; the vault only counts it. */
export async function savePrivateIx({ owner, from, to, usdcMint, amount }) {
  const a = await vaultAddresses(owner.address);
  const pocketOf = await pda(ROOMS_PROGRAM, [text('pocket'), enc.encode(owner.address)]);
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [roSigner(owner), ro(await configPda()), rw(a.userVault), rw(from), rw(to), ro(pocketOf), ro(usdcMint), ro(TOKEN_PROGRAM)],
    data: data('save_private', u64(amount)),
  };
}

// ---- Kashu's agent: a policy the saver signs, and the one instruction the agent may run ----
export const CHORE = { NONE: 0, SAVE: 1, SAVE_PRIVATE: 2, PAY: 3, REMIND: 4 };
/** Kashu's fee each time a chore runs (USDC units): one cent. */
export const AGENT_FEE = 10_000n;
/** Devnet build: a chore may run every 9 minutes, and the weekly cap counts over 10 (mainnet: 6 days and 7). */
export const CHORE_GAP = Number(globalThis.process?.env?.CHORE_GAP_SECS ?? 540), CAP_WINDOW = Number(globalThis.process?.env?.CAP_WINDOW_SECS ?? 600);
export const agentPolicyPda = async (owner) => pda(VAULT_PROGRAM, [text('agent'), enc.encode((await vaultAddresses(owner)).userVault)]);
export const agentAuthPda = async (owner) => pda(VAULT_PROGRAM, [text('agent_auth'), enc.encode((await vaultAddresses(owner)).userVault)]);
const ZERO_KEY = '11111111111111111111111111111111';
const choreBytes = (c = {}) => { const b = B.alloc(20); b[0] = c.kind ?? 0; b.writeBigUInt64LE(BigInt(c.amount ?? 0), 1); b[9] = c.weekday ?? 0; b[10] = c.hour ?? 0; b[11] = c.payee ?? 0; return b; };
/** The saver's policy: agent key, weekly cap, up to 4 payees (wallets) and up to 4 chores {kind, amount, weekday, hour, payee}. */
export async function setAgentIx({ owner, agent = ZERO_KEY, weeklyCap = 0n, payees = [], chores = [] }) {
  const a = await vaultAddresses(owner.address);
  const ps = [0, 1, 2, 3].map((i) => B.from(enc.encode(payees[i] ?? ZERO_KEY)));
  const cs = [0, 1, 2, 3].map((i) => choreBytes(chores[i]));
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [rwSigner(owner), ro(a.userVault), rw(await agentPolicyPda(owner.address)), ro(SYSTEM_PROGRAM)],
    data: data('set_agent', B.from(enc.encode(agent)), u64(weeklyCap), ...ps, ...cs),
  };
}
/** The agent runs chore `chore` of `owner`'s policy, sending to `to` (their cash, pocket account, or a payee's account). */
export async function agentRunIx({ agent, owner, chore, from, to, usdcMint, treasury }) {
  const a = await vaultAddresses(owner);
  return {
    programAddress: VAULT_PROGRAM,
    accounts: [roSigner(agent), rw(await configPda()), rw(a.userVault), rw(await agentPolicyPda(owner)), ro(await agentAuthPda(owner)), rw(from), rw(to), ro(a.cash),
      ro(await pda(ROOMS_PROGRAM, [text('pocket'), enc.encode(owner)])), rw(treasury), ro(usdcMint), ro(TOKEN_PROGRAM)],
    data: data('agent_run', B.from([chore])),
  };
}
export function readPolicy(bytes) {
  const b = B.from(bytes);
  const payees = [0, 1, 2, 3].map((i) => dec.decode(b.subarray(96 + i * 32, 128 + i * 32)));
  const chores = [0, 1, 2, 3].map((i) => { const o = 224 + i * 20; return { kind: b[o], amount: b.readBigUInt64LE(o + 1), weekday: b[o + 9], hour: b[o + 10], payee: b[o + 11], lastRun: b.readBigInt64LE(o + 12) }; });
  return { userVault: dec.decode(b.subarray(8, 40)), agent: dec.decode(b.subarray(40, 72)), weeklyCap: b.readBigUInt64LE(72), windowStart: b.readBigInt64LE(80), spent: b.readBigUInt64LE(88), payees, chores };
}
/** The token program's ApproveChecked: let the agent authority spend up to `amount` of the saver's dollars (through the vault only). */
export async function approveAgentIx({ owner, from, usdcMint, amount }) {
  const d = B.alloc(10); d[0] = 13; d.writeBigUInt64LE(BigInt(amount), 1); d[9] = 6;
  return { programAddress: TOKEN_PROGRAM, accounts: [rw(from), ro(usdcMint), ro(await agentAuthPda(owner.address)), roSigner(owner)], data: new Uint8Array(d) };
}
