// Prints the Swig wallet address for a saved wallet id (base64url, as the app stores it): node scripts/wallet-of.mjs <swigId>
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { createSolanaRpc } from '@solana/kit';
import { fetchSwig, findSwigPda, getSwigWalletAddress } from '@swig-wallet/kit';
const rpc = createSolanaRpc(`https://devnet.helius-rpc.com/?api-key=${readFileSync(`${homedir()}/.helius-main`, 'utf8').trim()}`);
const swig = await fetchSwig(rpc, await findSwigPda(Uint8Array.from(Buffer.from(process.argv[2], 'base64url'))));
console.log(await getSwigWalletAddress(swig));
