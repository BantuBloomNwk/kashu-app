// The Friday prize, live on devnet, for the private room already on MagicBlock's TEE rollup.
//   Sets Kashu's cut (10%) once, opens the room's pot (the room is delegated, so the vault reads its committed
//   state through the delegation record), links the demo saver's vault to it, tries a harvest (Jupiter Lend's
//   devnet market pays almost nothing, so this usually finds under a cent), has a sponsor add a dollar, and
//   shows that the prize waits for a settled draw. Safe to run again.
// Uses ~/.config/solana/id.json (admin, pays), ~/.helius-main (never printed), ~/.kashu-devnet-saver.json.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import * as V from '../client/vault.mjs';

const ROOM = process.env.ROOM || '7U4K9uQTuQNvCPsnDgFhnDLnbL9SVDEmGc1xNXaWjiah';
const fx = JSON.parse(readFileSync(new URL('../tests/fixtures/juplend-devnet.json', import.meta.url)));
const market = fx.market;
const key = readFileSync(`${homedir()}/.helius-main`, 'utf8').trim();
const base = new Connection(`https://devnet.helius-rpc.com/?api-key=${key}`, 'confirmed');
const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, 'utf8'))));
const admin = load(`${homedir()}/.config/solana/id.json`);
const saver = load(`${homedir()}/.kashu-devnet-saver.json`);
const USDC = new PublicKey(market.mint);
const TOKEN = new PublicKey(V.TOKEN_PROGRAM), ATA = new PublicKey(V.ATA_PROGRAM);
const ex = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const log = (...a) => console.log(...a);
const as = (kp) => ({ address: kp.publicKey.toBase58() });
const w3 = (ix) => new TransactionInstruction({
  programId: new PublicKey(ix.programAddress), data: Buffer.from(ix.data),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })),
});
const build = (ixs, units) => { const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...ixs); tx.feePayer = admin.publicKey; return tx; };
const send = async (ixs, label, signers = [], units = 400_000) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const tx = build(ixs, units);
      tx.recentBlockhash = (await base.getLatestBlockhash('confirmed')).blockhash;
      tx.sign(admin, ...signers);
      const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
      for (let i = 0; i < 40; i++) {
        const st = (await base.getSignatureStatuses([sig])).value[0];
        if (st?.err) throw new Error(`failed on chain: ${JSON.stringify(st.err)}`);
        if (st && st.confirmationStatus !== 'processed') { log(`  ${label}: ${ex(sig)}`); return sig; }
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error('not confirmed in time');
    } catch (e) {
      if (attempt >= 3 || !/expired|block height|timed out|blockhash|not confirmed/i.test(e.message)) throw e;
      log(`  ${label}: dropped, trying again (${attempt})`);
    }
  }
};
/** Runs an instruction in simulation only and says why the program would refuse it. */
const wouldRefuse = async (ixs, signers = [], units = 600_000) => {
  const tx = build(ixs, units);
  tx.recentBlockhash = (await base.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(admin, ...signers);
  const sim = await base.simulateTransaction(tx);
  if (!sim.value.err) return null;
  const line = (sim.value.logs || []).find((l) => /Error Code:/.test(l));
  return line ? line.replace(/.*Error Code: (\w+).*Error Message: (.*)/, '$1 ($2)') : JSON.stringify(sim.value.err);
};
const exists = async (k) => !!(await base.getAccountInfo(new PublicKey(k)));
const ataOf = (owner, mint) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
const amount = async (a) => { const b = await base.getTokenAccountBalance(new PublicKey(a)).catch(() => null); return b ? BigInt(b.value.amount) : 0n; };

const roomInfo = await base.getAccountInfo(new PublicKey(ROOM));
log(`room ${ROOM}: on Solana it is held by ${roomInfo.owner.equals(new PublicKey(V.DELEGATION_PROGRAM)) ? 'MagicBlock\'s delegation program (it lives on the TEE rollup)' : roomInfo.owner.toBase58()}`);

if (!(await exists(await V.prizePda()))) await send([w3(await V.initPrizeIx(as(admin), 1000))], 'Kashu\'s cut set at 10% (never more)');
const pot = await V.potPda(ROOM), potUsdc = await V.potUsdcPda(ROOM);
if (!(await exists(pot))) await send([w3(await V.openPotIx({ payer: as(admin), room: ROOM, usdcMint: USDC.toBase58() }))], 'the room\'s pot opened (room read through its delegation record)');
const va = await V.vaultAddresses(saver.publicKey.toBase58());
if (!(await exists(await V.linkPda(va.userVault)))) await send([w3(await V.linkPotIx({ owner: as(saver), room: ROOM }))], 'the demo saver lets her interest feed the pot', [saver]);

const treasury = ataOf(admin.publicKey, USDC).toBase58();
const harvest = [w3(await V.harvestIx({ cranker: as(admin), owner: saver.publicKey.toBase58(), room: ROOM, treasury, usdcMint: USDC.toBase58(), market }))];
const why = await wouldRefuse(harvest);
if (why) log(`  harvest: not yet, ${why}`);
else await send(harvest, 'harvest: interest into the pot, 10% to the treasury', [], 600_000);

const topUp = new TransactionInstruction({ programId: TOKEN, keys: [
  { pubkey: new PublicKey(treasury), isSigner: false, isWritable: true }, { pubkey: new PublicKey(potUsdc), isSigner: false, isWritable: true }, { pubkey: admin.publicKey, isSigner: true, isWritable: false }],
data: Buffer.concat([Buffer.from([3]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(1_000_000n); return b; })()]) });
if ((await amount(potUsdc)) < 1_000_000n) await send([topUp], 'a sponsor adds 1 dollar to the pot');

const pay = [w3(await V.payPrizeIx({ cranker: as(admin), room: ROOM, winner: admin.publicKey.toBase58(), usdcMint: USDC.toBase58() }))];
const payWhy = await wouldRefuse(pay);
log(payWhy ? `  pay_prize: waits, ${payWhy}` : '  pay_prize: the draw is settled and the prize can be paid');
const p = V.readPot((await base.getAccountInfo(new PublicKey(pot))).data);
log(`\npot ${pot}: ${Number(await amount(potUsdc)) / 1e6} USDC; harvested ${Number(p.harvested) / 1e6}, cut ${Number(p.cutTaken) / 1e6}, paid out ${Number(p.paidOut) / 1e6}; weeks paid below ${p.paidThrough}`);
