import { RP_ID } from '../config.ts';
// The Kashu wallet: a passkey (Face ID, fingerprint or the phone's lock) controls a Swig smart wallet on Solana.
// Nothing secret is stored here. The phone keeps the passkey; this keeps only public facts (the passkey's id and
// public key, and the wallet's id). Our relay pays the network fees, and every signature goes through the
// signing review first: the passkey signs once, and only what the person was shown.
import {
  address, appendTransactionMessageInstructions, compileTransaction, createSolanaRpcFromTransport, createDefaultRpcTransport, createTransactionMessage,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageConfig, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address,
} from '@solana/kit';
import { Actions, createSecp256r1AuthorityInfo } from '@swig-wallet/lib';
import { rawWebAuthnSigningFn } from './rawWebAuthn.ts';
import { fetchNullableSwig, findSwigPda, getCreateSwigInstruction, getSignInstructions, getSwigWalletAddress } from '@swig-wallet/kit';
import { review, oneSigning, PROGRAMS, type Line } from '@readback/review';
// @ts-expect-error plain JS module shared with the tests
import { KASHU_DECODERS } from '../../../client/review.mjs';
// @ts-expect-error plain JS module shared with the tests
import { VAULT_PROGRAM, ROOMS_PROGRAM } from '../../../client/vault.mjs';
import { DEFAULT_USDC } from '../config.ts';

export const RELAY = (import.meta.env.VITE_RELAY as string | undefined) ?? 'https://kashu-relay.161-97-74-212.sslip.io';
// reads go through Kashu's relay; a dropped connection or a busy moment is retried once before the screen hears of it
const transport = createDefaultRpcTransport({ url: `${RELAY}/rpc` });
const retrying = (async (args: Parameters<typeof transport>[0]) => {
  try { return await transport(args); } catch { await new Promise((r) => setTimeout(r, 900)); return transport(args); }
}) as typeof transport;
export const rpc = createSolanaRpcFromTransport(retrying);
// Swig's account decoder is built on an older @solana/kit; the calls are the same, only the types differ
const swigRpc = rpc as never;
// the slot our last transaction landed in: later reads must come from a node at least that far along, or the
// wallet's replay counter can be read stale and the next signature refused
let landedSlot = (() => { try { return BigInt(localStorage.getItem('kashu.slot') || '0'); } catch { return 0n; } })();
const landed = (slot: bigint) => { if (slot > landedSlot) { landedSlot = slot; try { localStorage.setItem('kashu.slot', String(slot)); } catch { /* fine */ } } };
const fresh = () => ({ commitment: 'confirmed' as const, ...(landedSlot ? { minContextSlot: landedSlot } : {}) });
const STORE = 'kashu.passkey.v1';
type Saved = { credentialId: string; publicKey: string; swigId: string };

const b64u = {
  enc: (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
const load = (): Saved | null => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } };
const save = (s: Saved) => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* private mode: the person signs in again next time */ } };

let sponsorAddress: Address | null = null;
let keeperAddress: Address | null = null;
async function health() {
  const h = await (await fetch(`${RELAY}/health`)).json();
  sponsorAddress = address(h.sponsor);
  keeperAddress = h.keeper ? address(h.keeper) : null;
}
async function sponsor(): Promise<Address> {
  if (!sponsorAddress) await health();
  return sponsorAddress!;
}
/** Kashu's keeper: counts saves in rooms and runs the weekly draw. Members let it check them in (never to move money). */
export async function keeper(): Promise<Address> {
  if (!sponsorAddress) await health();
  if (!keeperAddress) throw new Error('The keeper is not running yet');
  return keeperAddress;
}
export { sponsor as sponsorAddress };

/** True when this browser can make a passkey on the device itself. */
export async function passkeysAvailable() {
  return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false));
}

/** The passkey's P-256 public key, compressed to 33 bytes, from the SPKI the browser hands back. */
function compressSpki(spki: ArrayBuffer) {
  const raw = new Uint8Array(spki).slice(-65); // 0x04 || x || y
  if (raw[0] !== 4) throw new Error('This passkey is not a P-256 key');
  return Uint8Array.from([raw[64] & 1 ? 3 : 2, ...raw.slice(1, 33)]);
}

/** Makes a passkey on this device (the person sees the phone's own Face ID or fingerprint prompt). */
export async function createPasskey(displayName = 'Kashu saver'): Promise<Saved> {
  // the passkey carries its wallet's id (as its user handle), so it alone is enough to sign in on any device later
  const swigId = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: RP_ID, name: 'Kashu' },
      user: { id: swigId, name: displayName, displayName },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      // the PRF extension lets this passkey derive the private pocket's key, the same on every device it syncs to
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      attestation: 'none',
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was made');
  const response = cred.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  if (!spki) throw new Error('This browser did not share the passkey\'s public key');
  const saved = { credentialId: b64u.enc(cred.rawId), publicKey: b64u.enc(compressSpki(spki)), swigId: b64u.enc(swigId) };
  save(saved);
  return saved;
}

export const savedPasskey = load;

/**
 * "I already have Kashu": Face ID finds a Kashu passkey on this device (or synced to it), and the passkey's user
 * handle names its wallet. Nothing is created. Returns false when the passkey has no wallet in it (made before
 * passkeys carried one) or its wallet doesn't exist.
 */
export async function signInWithPasskey(): Promise<boolean> {
  const cred = (await navigator.credentials.get({
    publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: RP_ID, userVerification: 'required', timeout: 120_000 },
  })) as PublicKeyCredential | null;
  if (!cred) return false;
  const resp = cred.response as AuthenticatorAssertionResponse;
  let handle = new Uint8Array(resp.userHandle ?? new ArrayBuffer(0));
  if (handle.length !== 32) {
    // a passkey made before passkeys carried their wallet: recover its public key from this very signature (ECDSA
    // gives two candidates) and ask which Kashu wallet that key controls (public on chain)
    const { p256 } = await import('@noble/curves/p256');
    const { sha256 } = await import('@noble/hashes/sha256');
    const msg = sha256(new Uint8Array([...new Uint8Array(resp.authenticatorData), ...sha256(new Uint8Array(resp.clientDataJSON))]));
    const sig = p256.Signature.fromDER(new Uint8Array(resp.signature));
    const keys = [0, 1].map((bit) => { try { return sig.addRecoveryBit(bit).recoverPublicKey(msg).toHex(true); } catch { return null; } }).filter(Boolean) as string[];
    const found = (await (await fetch(`${RELAY}/wallet-of-key?keys=${keys.join(',')}`)).json()).wallets ?? [];
    if (!found.length) return false;
    handle = Uint8Array.from(atob(found[0].swigId.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=')), (c) => c.charCodeAt(0));
  }
  const swig = await fetchNullableSwig(swigRpc, await findSwigPda(handle), fresh());
  if (!swig) return false;
  save({ credentialId: b64u.enc(cred.rawId), publicKey: '', swigId: b64u.enc(handle) });
  return true;
}

/** The rooms this wallet is a member of (membership records are public on Solana), newest first. */
export async function roomsOf(wallet: string): Promise<string[]> {
  const r = await fetch(`${RELAY}/rooms-of?wallet=${encodeURIComponent(wallet)}`);
  return r.ok ? (await r.json()).rooms ?? [] : [];
}

/** Sends a transaction through the relay, which checks it and pays the fee. Resolves once it is confirmed. */
async function sendSponsored(instructions: Parameters<typeof appendTransactionMessageInstructions>[0]) {
  const payer = await sponsor();
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  // v1 transactions (up to 4096 bytes): a passkey signature carries the browser's whole clientDataJSON
  const msg = pipe(createTransactionMessage({ version: 1 }), (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(instructions, m),
    // room for the vault, Jupiter Lend and the smart wallet's checks; no priority fee (the relay refuses one)
    (m) => setTransactionMessageConfig({ computeUnitLimit: 1_000_000, loadedAccountsDataSizeLimit: 4 * 1024 * 1024 }, m));
  const tx = getBase64EncodedWireTransaction(compileTransaction(msg));
  const r = await fetch(`${RELAY}/sponsor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx, invite: (() => { try { return sessionStorage.getItem('kashu.invite') ?? ''; } catch { return ''; } })() }) });
  const body = await r.json();
  // the raw reason and the program's logs travel with the error; app/plain.ts turns them into words for the saver
  if (!r.ok) throw Object.assign(new Error(body.error || 'The network said no'), { logs: body.logs ?? [] });
  for (let i = 0; i < 40; i++) {
    const st = (await rpc.getSignatureStatuses([body.signature]).send()).value[0];
    if (st?.err) throw new Error('It didn\'t go through. Nothing changed.');
    if (st && st.confirmationStatus !== 'processed') { landed(st.slot); return body.signature as string; }
    await new Promise((res) => setTimeout(res, 1200));
  }
  throw new Error('Still waiting on the network. Check again in a minute.');
}

/** The smart wallet for this passkey: created (fee paid by Kashu) the first time. Returns its address. */
export async function ensureWallet(p: Saved = load()!) {
  const swigAddress = await findSwigPda(b64u.dec(p.swigId));
  let swig = await fetchNullableSwig(swigRpc, swigAddress, fresh());
  if (!swig) {
    await sendSponsored([await getCreateSwigInstruction({ payer: await sponsor(), id: b64u.dec(p.swigId), actions: Actions.set().all().get(), authorityInfo: createSecp256r1AuthorityInfo(b64u.dec(p.publicKey)) })]);
    swig = await fetchNullableSwig(swigRpc, swigAddress, fresh());
    if (!swig) throw new Error('The wallet wasn\'t created');
  }
  return { swig, wallet: await getSwigWalletAddress(swig) };
}

// devnet test USDC; mainnet uses Circle's USDC
export const USDC_MINT = (import.meta.env.VITE_USDC_MINT as string | undefined) ?? DEFAULT_USDC;
export const ALLOWED = [VAULT_PROGRAM, ROOMS_PROGRAM, PROGRAMS.TOKEN, PROGRAMS.ATA, PROGRAMS.SYSTEM] as string[];
export type Pending = { lines: Line[]; blocked: boolean; approve: () => Promise<string> };
type Ix = { programAddress: string; accounts: { address: string; role: number }[]; data: Uint8Array };

/**
 * Reads the instructions back and returns them with an approve function. The screen shows `lines`; tapping
 * approve opens the passkey prompt, which can sign only these exact instructions, once.
 */
/**
 * `before` holds instructions Kashu adds ahead of the wallet's own (today only rent Kashu sends the wallet): they are
 * shown in the review but the passkey doesn't sign them, so they sit outside its seal.
 */
export async function prepare(instructions: Ix[], context: { names?: Record<string, string>; mine?: string[]; trustedDelegates?: string[] } = {}, before: Ix[] = []): Promise<Pending> {
  const p = load();
  if (!p) throw new Error('Make a passkey first');
  const r = await review(instructions, { allow: ALLOWED, programs: KASHU_DECODERS, mints: { [USDC_MINT]: { symbol: 'USDC', decimals: 6 } }, ...context });
  const pre = before.length ? await review(before, { allow: ALLOWED, programs: KASHU_DECODERS, ...context }) : null;
  // everything the network can tell us is fetched now, before the sheet opens: phones (Safari above all) only
  // allow the passkey prompt right after a tap, so tapping approve must go straight to it
  const [{ swig }, payer] = await Promise.all([ensureWallet(p), sponsor()]);
  let slot = await rpc.getSlot(fresh()).send(), at = Date.now();
  const passkey = rawWebAuthnSigningFn({ rpId: RP_ID, allowCredentials: [{ type: 'public-key', id: b64u.dec(p.credentialId) }], userVerification: 'required', timeout: 120_000 });
  return {
    lines: [...(pre?.lines ?? []), ...r.lines],
    blocked: r.blocked || !!pre?.blocked,
    approve: async () => {
      if (r.blocked) throw new Error('This contains something Kashu never does, so it can\'t be signed.');
      // a slot older than about a minute would be refused by the wallet program; the estimate keeps it fresh
      if (Date.now() - at > 30_000) { slot += BigInt(Math.floor((Date.now() - at) / 400)); at = Date.now(); }
      const signed = await getSignInstructions(swig, 0, instructions as never, false, { signingFn: oneSigning(passkey, r.seal, instructions), payer, currentSlot: slot });
      return sendSponsored([...(before as never[]), ...signed]);
    },
  };
}
