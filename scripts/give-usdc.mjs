// Sends devnet test USDC from the admin wallet: node scripts/give-usdc.mjs <token account | --wallet address> <base units>
// With --wallet, the wallet's own USDC account is opened first if needed.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
const args = process.argv.slice(2);
const forWallet = args[0] === '--wallet';
const [toArg, amount] = forWallet ? args.slice(1) : args;
const conn = new Connection(`https://devnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`, 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'), TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const from = PublicKey.findProgramAddressSync([admin.publicKey.toBuffer(), TOKEN.toBuffer(), USDC.toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0];
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const to = forWallet ? PublicKey.findProgramAddressSync([new PublicKey(toArg).toBuffer(), TOKEN.toBuffer(), USDC.toBuffer()], ATA)[0].toBase58() : toArg;
const open = forWallet ? [new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [
  { pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: new PublicKey(to), isSigner: false, isWritable: true }, { pubkey: new PublicKey(toArg), isSigner: false, isWritable: false },
  { pubkey: USDC, isSigner: false, isWritable: false }, { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false }] })] : [];
const d = Buffer.alloc(9); d[0] = 3; d.writeBigUInt64LE(BigInt(amount), 1);
const tx = new Transaction().add(...open, new TransactionInstruction({ programId: TOKEN, data: d, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: new PublicKey(to), isSigner: false, isWritable: true }, { pubkey: admin.publicKey, isSigner: true, isWritable: false }] }));
tx.feePayer = admin.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; tx.sign(admin);
const sig = await conn.sendRawTransaction(tx.serialize());
for (let i = 0; i < 40; i++) { const st = (await conn.getSignatureStatuses([sig])).value[0]; if (st?.confirmationStatus && st.confirmationStatus !== 'processed') break; await new Promise((r) => setTimeout(r, 1500)); }
console.log(`gave ${Number(amount) / 1e6} test USDC: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
