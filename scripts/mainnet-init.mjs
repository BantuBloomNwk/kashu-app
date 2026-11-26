// Sets Kashu's vault up on MAINNET, once, after both programs are deployed: the config (real USDC, SOL as the asset,
// Jupiter as the only swap venue, the beta caps the program also hard-codes: $50 a saver, $5,000 in all) and the prize
// (Kashu's cut of interest: 10%, the most the program allows). Run by the deploy wallet, which is the admin until the
// Squads multisig takes over. Prints what it did; never prints a key.
//   node scripts/mainnet-init.mjs
import { readFileSync } from 'fs'; import { homedir } from 'os';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import * as V from '../client/vault.mjs';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', WSOL = 'So11111111111111111111111111111111111111112';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`, 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEPLOY_KEY || `${homedir()}/.kashu-mainnet-deployer.json`, 'utf8'))));
const web3 = (k) => new TransactionInstruction({ programId: new PublicKey(k.programAddress), data: Buffer.from(k.data), keys: k.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role % 2 === 1 })) });
const send = async (label, ixs) => { const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs.map(web3)); console.log(label, await sendAndConfirmTransaction(conn, tx, [admin])); };
const me = { address: admin.publicKey.toBase58() };
if (!(await conn.getAccountInfo(new PublicKey(await V.configPda())))) await send('vault config set up:', [await V.initializeIx({ admin: me, usdcMint: USDC, assetMint: WSOL, swapProgram: JUPITER, perUserCap: 50_000_000n, totalCap: 5_000_000_000n, floorRate: 1n })]);
else console.log('vault config already set up');
if (!(await conn.getAccountInfo(new PublicKey(await V.prizePda())))) await send('prize set up (10% of interest):', [await V.initPrizeIx(me, 1000)]);
else console.log('prize already set up');
