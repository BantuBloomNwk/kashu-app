// A bare page for checking the passkey wallet end to end (driven by a headless browser). Not part of the app.
import { address } from '@solana/kit';
import { createPasskey, ensureWallet, prepare, rpc } from './wallet.ts';
// @ts-expect-error plain JS module shared with the tests
import { openVaultIx, depositIx, vaultAddresses, ATA_PROGRAM, TOKEN_PROGRAM } from '../../../client/vault.mjs';
import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'), WSOL = address('So11111111111111111111111111111111111111112');
const out = document.getElementById('out')!;
const say = (s: string) => { out.textContent += `\n${s}`; };
const strip = (ix: any) => ({ ...ix, accounts: ix.accounts.map(({ signer: _s, ...a }: any) => a) });
const enc = getAddressEncoder();
const ataOf = async (owner: string, mint: string) => (await getProgramDerivedAddress({ programAddress: address(ATA_PROGRAM), seeds: [owner, TOKEN_PROGRAM, mint].map((x) => enc.encode(address(x))) }))[0];
const sponsor = async () => (await (await fetch(`${(await import('./wallet.ts')).RELAY}/health`)).json()).sponsor as string;

(window as any).kashu = {
  async create() { const p = await createPasskey('Test saver'); const { wallet } = await ensureWallet(p); say(`wallet ${wallet}`); return wallet; },
  async setup() {
    const { wallet } = await ensureWallet(); const s = await sponsor(); const ata = await ataOf(wallet, USDC);
    const createAta = { programAddress: ATA_PROGRAM, data: new Uint8Array([1]), accounts: [
      { address: s, role: 3 }, { address: ata, role: 1 }, { address: wallet, role: 0 }, { address: USDC, role: 0 }, { address: '11111111111111111111111111111111', role: 0 }, { address: TOKEN_PROGRAM, role: 0 }] };
    const p = await prepare([createAta, strip(await openVaultIx({ payer: { address: s }, owner: { address: wallet }, usdcMint: USDC, assetMint: WSOL }))], { names: { [wallet]: 'your wallet' } });
    say(`review: ${p.lines.map((l) => `[${l.tone}] ${l.text}`).join(' / ')}`);
    const sig = await p.approve(); say(`setup ${sig}`); return { sig, ata };
  },
  async deposit(amount: number) {
    const { wallet } = await ensureWallet(); const ata = await ataOf(wallet, USDC);
    const p = await prepare([strip(await depositIx({ owner: { address: wallet }, from: ata, usdcMint: USDC, amount: BigInt(amount) }))]);
    say(`review: ${p.lines.map((l) => `[${l.tone}] ${l.text}`).join(' / ')}`);
    const sig = await p.approve(); say(`deposit ${sig}`);
    const va = await vaultAddresses(wallet);
    const acc = (await rpc.getAccountInfo(va.userVault, { encoding: 'base64' }).send()).value;
    return { sig, vault: va.userVault, exists: !!acc };
  },
  async tampered() {
    const { wallet } = await ensureWallet(); const ata = await ataOf(wallet, USDC);
    const ixs = [strip(await depositIx({ owner: { address: wallet }, from: ata, usdcMint: USDC, amount: 1n }))];
    const p = await prepare(ixs);
    ixs[0] = strip(await depositIx({ owner: { address: wallet }, from: ata, usdcMint: USDC, amount: 999n }));
    try { await p.approve(); return 'SIGNED (bad)'; } catch (e) { return String((e as Error).message); }
  },
};
out.textContent = 'ready';
