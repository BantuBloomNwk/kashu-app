// A passkey smart wallet (Swig) owns a Kashu vault, live on devnet.
//   A P-256 key stands in for the phone's passkey (the same curve and the same on-chain check as Face ID; the
//   browser flow signs through WebAuthn instead). Our admin wallet pays fees and rent, as the app's sponsor
//   will. The Swig wallet opens a vault and saves into it, each step signed only by the passkey key.
// Uses ~/.config/solana/id.json (pays) and ~/.helius-main (never printed). Writes ~/.kashu-devnet-passkey.json
// (the stand-in passkey and the Swig id) so a second run reuses them.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { generateKeyPairSync, randomBytes } from 'crypto';
import {
  address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage, getBase64EncodedWireTransaction,
  pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, getSignatureFromTransaction, AccountRole,
} from '@solana/kit';
import { Actions, createSecp256r1AuthorityInfo, getSigningFnForSecp256r1PrivateKey } from '@swig-wallet/lib';
import { fetchSwig, findSwigPda, getCreateSwigInstruction, getSignInstructions, getSwigWalletAddress } from '@swig-wallet/kit';
import * as V from '../client/vault.mjs';

const key = readFileSync(`${homedir()}/.helius-main`, 'utf8').trim();
const rpc = createSolanaRpc(`https://devnet.helius-rpc.com/?api-key=${key}`);
const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'), WSOL = address('So11111111111111111111111111111111111111112');
const ATA = address(V.ATA_PROGRAM), TOKEN = address(V.TOKEN_PROGRAM), SYSTEM = address('11111111111111111111111111111111');
const ex = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const log = (...a) => console.log(...a);

// the stand-in passkey: a P-256 key, kept so a second run is the same person
const file = `${homedir()}/.kashu-devnet-passkey.json`;
let me;
if (existsSync(file)) me = JSON.parse(readFileSync(file, 'utf8'));
else {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  me = { d: jwk.d, x: jwk.x, y: jwk.y, id: randomBytes(32).toString('base64') };
  writeFileSync(file, JSON.stringify(me), { mode: 0o600 });
}
const b64u = (s) => Buffer.from(s, 'base64url');
const y = b64u(me.y);
const compressed = Uint8Array.from([y[y.length - 1] & 1 ? 0x03 : 0x02, ...b64u(me.x)]);
const signingFn = getSigningFnForSecp256r1PrivateKey(Uint8Array.from(b64u(me.d)));
const id = Uint8Array.from(Buffer.from(me.id, 'base64'));

// sends with the admin as fee payer; confirms by polling (no websocket)
async function send(ixs, label) {
  for (let attempt = 1; ; attempt++) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(admin, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ixs, m));
    const tx = await signTransactionMessageWithSigners(msg);
    const sig = getSignatureFromTransaction(tx);
    try {
      await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
    } catch (e) {
      const logs = e?.context?.logs ?? e?.cause?.context?.logs;
      if (logs) log(logs.slice(-14).join('\n'));
      throw e;
    }
    for (let i = 0; i < 40; i++) {
      const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
      if (st?.err) throw new Error(`${label} failed on chain: ${JSON.stringify(st.err)}`);
      if (st && st.confirmationStatus !== 'processed') { log(`  ${label}: ${ex(sig)}`); return sig; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (attempt >= 3) throw new Error(`${label} not confirmed`);
    log(`  ${label}: dropped, trying again`);
  }
}
const exists = async (a) => !!(await rpc.getAccountInfo(a, { encoding: 'base64' }).send()).value;
const ataOf = async (owner, mint) => (await import('@solana/kit')).getProgramDerivedAddress({ programAddress: ATA, seeds: [(await import('@solana/kit')).getAddressEncoder().encode(owner), (await import('@solana/kit')).getAddressEncoder().encode(TOKEN), (await import('@solana/kit')).getAddressEncoder().encode(mint)] }).then((r) => r[0]);
const createAta = (owner, mint, ata) => ({ programAddress: ATA, data: new Uint8Array([1]), accounts: [
  { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin }, { address: ata, role: AccountRole.WRITABLE },
  { address: owner, role: AccountRole.READONLY }, { address: mint, role: AccountRole.READONLY }, { address: SYSTEM, role: AccountRole.READONLY }, { address: TOKEN, role: AccountRole.READONLY }] });

// 1. the smart wallet: one authority, the passkey, with full control of its own wallet
const swigAddress = await findSwigPda(id);
if (!(await exists(swigAddress))) {
  await send([await getCreateSwigInstruction({ payer: admin.address, id, actions: Actions.set().all().get(), authorityInfo: createSecp256r1AuthorityInfo(compressed) })], 'passkey smart wallet created (Swig, P-256 authority)');
} else log(`  smart wallet ${swigAddress} already exists`);
let swig = await fetchSwig(rpc, swigAddress);
const wallet = await getSwigWalletAddress(swig);
log(`  its wallet address (what owns the vault): ${wallet}`);

// 2. a dollar account for the wallet, and 2 test dollars from the sponsor
const walletUsdc = await ataOf(wallet, USDC);
if (!(await exists(walletUsdc))) {
  const adminUsdc = await ataOf(admin.address, USDC);
  await send([createAta(wallet, USDC, walletUsdc), { programAddress: TOKEN, data: Uint8Array.from([3, ...new Uint8Array(new BigUint64Array([2_000_000n]).buffer)]),
    accounts: [{ address: adminUsdc, role: AccountRole.WRITABLE }, { address: walletUsdc, role: AccountRole.WRITABLE }, { address: admin.address, role: AccountRole.READONLY_SIGNER, signer: admin }] }], 'the wallet gets 2 test USDC');
}

// 3. the vault, opened and funded by the smart wallet; the sponsor pays rent, the passkey authorises
const va = await V.vaultAddresses(wallet);
const owner = { address: wallet }; // signs through Swig, not with a key in this process
const sponsor = { address: admin.address };
const strip = (ix) => ({ ...ix, accounts: ix.accounts.map(({ signer, ...a }) => a) });
const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
const opts = { signingFn, payer: admin.address, currentSlot: slot };
if (!(await exists(va.userVault))) {
  const inner = [strip(await V.openVaultIx({ payer: sponsor, owner, usdcMint: USDC, assetMint: WSOL })),
    strip(await V.depositIx({ owner, from: walletUsdc, usdcMint: USDC, amount: 1_000_000n }))];
  const ixs = await getSignInstructions(swig, 0, inner, false, opts);
  await send(ixs.map((ix) => ({ ...ix, accounts: ix.accounts.map((a) => (a.address === admin.address ? { ...a, signer: admin } : a)) })), 'vault opened and 1 USDC saved, signed by the passkey');
} else log('  vault already open');
const v = V.readUserVault((await rpc.getAccountInfo(va.userVault, { encoding: 'base64' }).send()).value.data[0] ? Buffer.from((await rpc.getAccountInfo(va.userVault, { encoding: 'base64' }).send()).value.data[0], 'base64') : new Uint8Array());
log(`\nvault ${va.userVault}: owner ${v.owner} (the smart wallet), ${Number(v.cashTracked) / 1e6} USDC saved`);
