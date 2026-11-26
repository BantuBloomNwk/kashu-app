// The weekly buy, live on devnet, on savings that are lent on Jupiter Lend.
//   First run: price the devnet venue from Pyth's SOL/USD (with a small premium) and fund it, name the venue
//   once, then a demo saver opens a vault, saves 3 USDC, sets a rule (2 a week, half into SOL) and lends it all.
//   Run again once the (10-minute devnet) week is up: a stranger brings back the 1 USDC shortfall
//   (prepare_buy) and presses the weekly button through the venue at the oracle-checked price.
// The devnet venue is the stub (Jupiter's aggregator is not on devnet); mainnet names Jupiter, proven in
// tests/jupiter.mjs. Uses ~/.config/solana/id.json (admin, pays), ~/.helius-main, ~/.kashu-devnet-saver.json.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as V from '../client/vault.mjs';

const fx = JSON.parse(readFileSync(new URL('../tests/fixtures/juplend-devnet.json', import.meta.url)));
const market = fx.market;
const key = readFileSync(`${homedir()}/.helius-main`, 'utf8').trim();
const base = new Connection(`https://devnet.helius-rpc.com/?api-key=${key}`, 'confirmed');
const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, 'utf8'))));
const admin = load(`${homedir()}/.config/solana/id.json`);
const saverFile = `${homedir()}/.kashu-devnet-saver.json`;
if (!existsSync(saverFile)) writeFileSync(saverFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
const saver = load(saverFile);
const USDC = new PublicKey(market.mint), WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN = new PublicKey(V.TOKEN_PROGRAM), ATA = new PublicKey(V.ATA_PROGRAM);
const PYTH_SOL_USD = new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
const ex = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const log = (...a) => console.log(...a);
const as = (kp) => ({ address: kp.publicKey.toBase58() });

const w3 = (ix) => new TransactionInstruction({
  programId: new PublicKey(ix.programAddress), data: Buffer.from(ix.data),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })),
});
const send = async (ixs, label, signers = [admin], units = 400_000) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...ixs);
      tx.feePayer = admin.publicKey;
      const sig = await sendAndConfirmTransaction(base, tx, [admin, ...signers.filter((s) => s !== admin)], { commitment: 'confirmed', maxRetries: 5 });
      log(`  ${label}: ${ex(sig)}`); return sig;
    } catch (e) {
      if (attempt >= 4 || !/expired|block height|timed out|blockhash/i.test(e.message)) { if (e.logs) log(e.logs.slice(-12).join('\n')); throw e; }
      log(`  ${label}: dropped, trying again (${attempt})`);
    }
  }
};
const ataOf = (owner, mint) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
const ensureAta = (owner, mint) => new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [
  { pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: ataOf(owner, mint), isSigner: false, isWritable: true },
  { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false }] });
const tokenTransfer = (from, to, owner, amount) => new TransactionInstruction({ programId: TOKEN, data: Buffer.concat([Buffer.from([3]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(amount)); return b; })()]),
  keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }] });
const syncNative = (acct) => new TransactionInstruction({ programId: TOKEN, data: Buffer.from([17]), keys: [{ pubkey: acct, isSigner: false, isWritable: true }] });
const exists = async (k) => !!(await base.getAccountInfo(new PublicKey(k)));
const amount = async (a) => { const b = await base.getTokenAccountBalance(a).catch(() => null); return b ? BigInt(b.value.amount) : 0n; };

// the live Pyth SOL/USD price (the sponsored devnet feed), checked the same way the vault checks it
const pyth = (await base.getAccountInfo(PYTH_SOL_USD)).data;
const feedId = new Uint8Array(pyth.subarray(41, 73));
const price = Number(pyth.readBigInt64LE(73)) * 10 ** pyth.readInt32LE(89);
const age = Math.floor(Date.now() / 1000) - Number(pyth.readBigInt64LE(93));
log(`Pyth SOL/USD on devnet: $${price.toFixed(2)}, ${age} s old`);

// ---- the devnet venue (once): the stub pool, priced from Pyth with a 0.5% premium, and funded with SOL
const pool = await V.poolAddresses(USDC.toBase58(), WSOL.toBase58());
if (!(await exists(pool.pool))) {
  const rate = BigInt(Math.floor((1e12 / price) * 1.005)); // asset base units per dollar base unit, times 1e9
  await send([w3(await V.initPoolIx({ payer: as(admin), usdcMint: USDC.toBase58(), assetMint: WSOL.toBase58(), rate, mode: 0 }))], `devnet venue pool opened at $${(1e12 / Number(rate)).toFixed(2)} a SOL`);
  const myWsol = ataOf(admin.publicKey, WSOL);
  await send([ensureAta(admin.publicKey, WSOL), SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: myWsol, lamports: 200_000_000 }), syncNative(myWsol),
    tokenTransfer(myWsol, new PublicKey(pool.poolAsset), admin.publicKey, 200_000_000)], 'venue funded with 0.2 SOL');
}
if (!(await exists(await V.venuePda()))) {
  await send([w3(await V.setVenueIx({ admin: as(admin), swapProgram: V.STUB_SWAP_PROGRAM, priceFeed: PYTH_SOL_USD.toBase58(), feedId, maxAgeSecs: 3 * 60 * 60, maxConfBps: 100, slippageBps: 100 }))], 'venue named once: the devnet stub, Pyth SOL/USD, 1% slippage');
}

// ---- the demo saver
const va = await V.vaultAddresses(saver.publicKey.toBase58());
const vault = new PublicKey(va.userVault);
if (!(await exists(va.userVault))) {
  const mine = ataOf(admin.publicKey, USDC), theirs = ataOf(saver.publicKey, USDC);
  await send([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: saver.publicKey, lamports: 20_000_000 }), ensureAta(saver.publicKey, USDC), tokenTransfer(mine, theirs, admin.publicKey, 3_000_000)], `demo saver ${saver.publicKey.toBase58().slice(0, 8)}… given 3 USDC`);
  await send([w3(await V.openVaultIx({ payer: as(admin), owner: as(saver), usdcMint: USDC.toBase58(), assetMint: WSOL.toBase58() }))], 'vault opened', [saver]);
  await send([w3(await V.depositIx({ owner: as(saver), from: theirs.toBase58(), usdcMint: USDC.toBase58(), amount: 3_000_000n })), w3(await V.setRuleIx(as(saver), { weeklyAmount: 2_000_000n, roundupUnit: 0n, assetBps: 5000 }))], 'saved 3 USDC; rule: 2 a week, half into SOL', [saver]);
  await send([ensureAta(vault, new PublicKey(market.fTokenMint)), ensureAta(vault, USDC), ensureAta(new PublicKey(va.swapAuthority), USDC), ensureAta(new PublicKey(va.swapAuthority), WSOL)], 'vault and swap authority accounts ready');
  await send([w3(await V.lendIx({ owner: as(saver), usdcMint: USDC.toBase58(), market, amount: 3_000_000n }))], 'all 3 USDC lent on Jupiter Lend', [saver], 600_000);
}
let v = V.readUserVault((await base.getAccountInfo(vault)).data);
const wait = Number(v.nextBuyAt) - Math.floor(Date.now() / 1000);
log(`  vault ${vault.toBase58()}: ${Number(v.cashTracked) / 1e6} cash, ${Number(v.lentPrincipal) / 1e6} lent, ${v.buysDone} buys; next buy ${wait > 0 ? `in ${wait} s` : 'is due'}`);
if (wait > 0) { log('\nRun again when the buy is due.'); process.exit(0); }

// ---- the weekly button, pressed by a stranger (the admin wallet here), on savings that are lent
const spend = V.thisWeekSpend(v);
if (v.cashTracked < spend) {
  await send([w3(await V.prepareBuyIx({ cranker: as(admin), owner: saver.publicKey.toBase58(), usdcMint: USDC.toBase58(), market }))], `prepare_buy: ${Number(spend - v.cashTracked) / 1e6} USDC back from Jupiter Lend for the buy`, [admin], 600_000);
}
const holdBefore = await amount(new PublicKey(va.hold));
await send([w3(await V.weeklyBuyIx({ cranker: as(admin), owner: saver.publicKey.toBase58(), usdcMint: USDC.toBase58(), assetMint: WSOL.toBase58(), priceUpdate: PYTH_SOL_USD.toBase58(), amountIn: spend }))], `weekly buy: ${Number(spend) / 1e6} USDC into SOL at the Pyth-checked price`);
v = V.readUserVault((await base.getAccountInfo(vault)).data);
const got = (await amount(new PublicKey(va.hold))) - holdBefore;
log(`  bought ${Number(got) / 1e9} SOL for ${Number(spend) / 1e6} USDC ($${(Number(spend) / 1e6 / (Number(got) / 1e9)).toFixed(2)} a SOL; Pyth $${price.toFixed(2)})`);
log(`  vault now: ${Number(v.cashTracked) / 1e6} cash, ${Number(v.lentPrincipal) / 1e6} still lent and earning, ${v.buysDone} buy done`);
