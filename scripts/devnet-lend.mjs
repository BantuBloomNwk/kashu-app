// Savings on Jupiter Lend, live on devnet: save 10 USDC into the vault, lend all 10 on Jupiter Lend's
// devnet USDC market, bring 2 back to prove the round trip, and leave 8 earning. Prints explorer links.
// Run from the repo root: node scripts/devnet-lend.mjs   (uses ~/.config/solana/id.json and ~/.helius-main)
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as V from '../client/vault.mjs';

const fx = JSON.parse(readFileSync(new URL('../tests/fixtures/juplend-devnet.json', import.meta.url)));
const market = fx.market;
const heliusKey = (() => { try { return readFileSync(`${homedir()}/.helius-main`, 'utf8').trim(); } catch { return ''; } })();
const base = new Connection(process.env.BASE_RPC || (heliusKey ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}` : 'https://rpc.magicblock.app/devnet'), 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const me = { address: payer.publicKey.toBase58() };
const USDC = new PublicKey(market.mint);
const TOKEN = new PublicKey(V.TOKEN_PROGRAM), ATA = new PublicKey(V.ATA_PROGRAM);
const ex = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const log = (...a) => console.log(...a);

const w3 = (ix) => new TransactionInstruction({
  programId: new PublicKey(ix.programAddress), data: Buffer.from(ix.data),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })),
});
const send = async (ixs, label, units = 200_000) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...ixs);
      const sig = await sendAndConfirmTransaction(base, tx, [payer], { commitment: 'confirmed', maxRetries: 5 });
      log(`  ${label}: ${ex(sig)}`); return sig;
    } catch (e) {
      if (attempt >= 4 || !/expired|block height|timed out|blockhash/i.test(e.message)) { if (e.logs) log(e.logs.slice(-10).join('\n')); throw e; }
      log(`  ${label}: dropped, trying again (${attempt})`);
    }
  }
};
const ataOf = (owner, mint) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
// create an associated token account if it is missing (idempotent; anyone may pay for anyone's)
const ensureAta = (owner, mint) => new TransactionInstruction({
  programId: ATA, data: Buffer.from([1]),
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: ataOf(owner, mint), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false },
  ],
});
const amount = async (acct) => { const b = await base.getTokenAccountBalance(acct).catch(() => null); return b ? BigInt(b.value.amount) : 0n; };
const vaultState = async (vault) => V.readUserVault((await base.getAccountInfo(new PublicKey(vault))).data);
const usd = (n) => `$${(Number(n) / 1e6).toFixed(2)}`;

const va = await V.vaultAddresses(me.address);
const vault = new PublicKey(va.userVault);
const mine = ataOf(payer.publicKey, USDC);
log(`wallet ${me.address}: ${usd(await amount(mine))} devnet USDC`);

// 1. save 10 dollars into the vault
await send([w3(await V.depositIx({ owner: me, from: mine.toBase58(), usdcMint: USDC.toBase58(), amount: 10_000_000n }))], 'saved $10 into the vault');
// 2. the vault's own share and staging accounts (associated accounts; Jupiter Lend takes only those)
await send([ensureAta(vault, new PublicKey(market.fTokenMint)), ensureAta(vault, USDC)], 'vault share and staging accounts ready');
// 3. lend all 10 on Jupiter Lend
const args = (amount) => ({ owner: me, usdcMint: USDC.toBase58(), market, amount });
await send([w3(await V.lendIx(args(10_000_000n)))], 'lent $10 on Jupiter Lend', 600_000);
const shares = ataOf(vault, new PublicKey(market.fTokenMint));
let v = await vaultState(vault);
log(`    vault: ${usd(v.cashTracked)} cash, ${usd(v.lentPrincipal)} lent, ${(await amount(shares)) / 1_000_000n} jlUSDC shares (${await amount(shares)} base units)`);
// 4. bring 2 back, leave 8 earning
await send([w3(await V.unlendIx(args(2_000_000n)))], 'brought $2 back from Jupiter Lend', 600_000);
v = await vaultState(vault);
log(`    vault: ${usd(v.cashTracked)} cash, ${usd(v.lentPrincipal)} lent and earning, ${await amount(shares)} share base units`);
log(`\nvault ${vault.toBase58()}  shares ${shares.toBase58()}`);
