// Brings the demo saver's test USDC back to the admin wallet: everything lent comes back, is taken out of the
// vault, and is sent on. Devnet housekeeping for test money. node scripts/devnet-reclaim.mjs
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import * as V from '../client/vault.mjs';
const fx = JSON.parse(readFileSync(new URL('../tests/fixtures/juplend-devnet.json', import.meta.url)));
const conn = new Connection(`https://devnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`, 'confirmed');
const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, 'utf8'))));
const admin = load(`${homedir()}/.config/solana/id.json`), saver = load(`${homedir()}/.kashu-devnet-saver.json`);
const USDC = new PublicKey(fx.market.mint), WSOL = new PublicKey('So11111111111111111111111111111111111111112'), TOKEN = new PublicKey(V.TOKEN_PROGRAM), ATA = new PublicKey(V.ATA_PROGRAM);
const ataOf = (o, m) => PublicKey.findProgramAddressSync([o.toBuffer(), TOKEN.toBuffer(), m.toBuffer()], ATA)[0];
const w3 = (ix) => new TransactionInstruction({ programId: new PublicKey(ix.programAddress), data: Buffer.from(ix.data), keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })) });
const createAta = (owner, mint) => new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: ataOf(owner, mint), isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false }] });
const send = async (ixs, label) => {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...ixs);
  tx.feePayer = admin.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; tx.sign(admin, saver);
  const sig = await conn.sendRawTransaction(tx.serialize());
  for (let i = 0; i < 40; i++) { const st = (await conn.getSignatureStatuses([sig])).value[0]; if (st?.err) throw new Error(`${label}: ${JSON.stringify(st.err)}`); if (st?.confirmationStatus && st.confirmationStatus !== 'processed') break; await new Promise((r) => setTimeout(r, 1500)); }
  console.log(`${label}: ${sig}`);
};
const va = await V.vaultAddresses(saver.publicKey.toBase58());
const v = V.readUserVault((await conn.getAccountInfo(new PublicKey(va.userVault))).data);
const as = { address: saver.publicKey.toBase58() };
// shares can be worth a unit or two under the principal after earlier moves, so leave that rounding behind
const back = v.lentPrincipal > 10_000n ? v.lentPrincipal - 10_000n : 0n;
if (back > 0n) await send([w3(await V.unlendIx({ owner: as, usdcMint: USDC.toBase58(), market: fx.market, amount: back }))], `unlent ${Number(back) / 1e6}`);
const cash = V.readUserVault((await conn.getAccountInfo(new PublicKey(va.userVault))).data).cashTracked;
const mine = ataOf(saver.publicKey, USDC), mineSol = ataOf(saver.publicKey, WSOL);
if (cash > 0n) await send([createAta(saver.publicKey, WSOL), w3(await V.withdrawCashIx({ owner: as, ownerUsdc: mine.toBase58(), ownerAsset: mineSol.toBase58(), usdcMint: USDC.toBase58(), assetMint: WSOL.toBase58(), amount: cash }))], `took out ${Number(cash) / 1e6}`);
const bal = BigInt((await conn.getTokenAccountBalance(mine)).value.amount);
const d = Buffer.alloc(9); d[0] = 3; d.writeBigUInt64LE(bal, 1);
if (bal > 0n) await send([new TransactionInstruction({ programId: TOKEN, data: d, keys: [{ pubkey: mine, isSigner: false, isWritable: true }, { pubkey: ataOf(admin.publicKey, USDC), isSigner: false, isWritable: true }, { pubkey: saver.publicKey, isSigner: true, isWritable: false }] })], `sent ${Number(bal) / 1e6} USDC to admin`);
