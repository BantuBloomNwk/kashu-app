import { RP_ID } from '../config.ts';
// The private pocket: a balance held on MagicBlock's private payments rollup (a TEE), so nobody can look it up and
// payments between pockets don't show on any public explorer.
//
// A passkey smart wallet can't own a pocket (MagicBlock needs an ordinary key as the owner), so the pocket has its own
// key, derived from the passkey with WebAuthn's PRF extension: the same passkey gives the same pocket on every device
// it syncs to, and Face ID is needed once per session to open it. The key lives only in this page's memory, as a
// non-extractable WebCrypto key; the seed it came from is wiped right after.
//
// Money in: the wallet sends dollars to the pocket's Solana account (passkey approval), then the pocket deposits them
// into its private balance (gasless: MagicBlock's sponsor pays the network, a 0.20 relay fee comes out of the deposit).
// Inside: pocket-to-pocket payments, free and private. Money out: a gasless withdrawal back to the pocket's Solana
// account, then Kashu's relay pays the fee for the one transfer from the pocket to its own wallet.
import { base58 } from '@readback/review';
import { RELAY, savedPasskey, USDC_MINT } from './wallet.ts';
import { TEE } from './viewer.ts';
import { POCKET_CLUSTER } from '../config.ts';

export const PAYMENTS = 'https://payments.magicblock.app';
const CLUSTER = (import.meta.env.VITE_POCKET_CLUSTER as string | undefined) ?? POCKET_CLUSTER;
/** MagicBlock's relay fee for a gasless deposit or withdrawal, and its minimum amount, in USDC units. */
export const POCKET_FEE = 200_000n, POCKET_MIN = 500_000n;
const SALT = new TextEncoder().encode('kashu-pocket-v1');
const PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

let open: { key: CryptoKey; address: string } | null = null;
let token: string | null = null;

/** The pocket, once opened this session (null until then). */
export const pocket = () => open;

/** A passkey made only for the pocket, kept on the person's phone, for computers whose own passkey has no PRF. */
const POCKET_CRED = 'kashu.pocketkey.v1';
export class NoPrf extends Error { constructor() { super('This device\'s passkey can\'t open a private pocket. Use a passkey on your phone instead.'); } }
const prfOf = (cred: PublicKeyCredential | null) => (cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } })?.prf?.results?.first ?? null;
async function prfWith(credentialId: string, hybrid = false) {
  return prfOf((await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: RP_ID, userVerification: 'required', timeout: 120_000,
      allowCredentials: [{ type: 'public-key', id: unb64u(credentialId), ...(hybrid ? { transports: ['hybrid', 'internal'] as AuthenticatorTransport[] } : {}) }],
      extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null);
}
/**
 * Makes the pocket passkey on the person's phone (the computer shows a QR code; the phone makes and keeps the passkey).
 * Its PRF output is the pocket's seed from then on, on this computer.
 */
export async function makePocketKey() {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: RP_ID, name: 'Kashu' },
      user: { id: crypto.getRandomValues(new Uint8Array(32)), name: 'Kashu private pocket', displayName: 'Kashu private pocket' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'cross-platform' },
      hints: ['hybrid'], extensions: { prf: {} } as AuthenticationExtensionsClientInputs, timeout: 180_000,
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was made');
  if (!(cred.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled) throw new Error('That phone\'s passkey can\'t open a pocket either. Try an iPhone on iOS 18 or newer, or Android with Google Password Manager.');
  try { localStorage.setItem(POCKET_CRED, btoa(String.fromCharCode(...new Uint8Array(cred.rawId))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')); } catch { /* the next open asks again */ }
}

/** Opens the pocket with Face ID: the passkey's PRF output, hashed with Kashu's label, is the pocket key's seed. */
export async function openPocket() {
  if (open) return open;
  const saved = savedPasskey();
  if (!saved) throw new Error('No passkey on this device');
  let pocketCred: string | null = null;
  try { pocketCred = localStorage.getItem(POCKET_CRED); } catch { /* none */ }
  // a computer that made a pocket passkey on the phone uses that one; otherwise the wallet's own passkey
  const prf = pocketCred ? await prfWith(pocketCred, true) : await prfWith(saved.credentialId);
  if (!prf) throw new NoPrf();
  const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...SALT, ...new Uint8Array(prf)])));
  const der = new Uint8Array([...PKCS8, ...seed]);
  // the public half: import once exportable to read it, then keep only a non-extractable private key
  const tmp = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', tmp);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  seed.fill(0); der.fill(0);
  open = { key, address: base58(unb64u(jwk.x!)) };
  return open;
}
export function closePocket() { open = null; token = null; }

const sign = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, open!.key, bytes));

async function api(path: string, body?: unknown) {
  const r = await fetch(PAYMENTS + path, body === undefined
    ? { headers: token ? { authorization: `Bearer ${token}` } : {} }
    : { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message ?? `MagicBlock didn't answer (${r.status})`);
  return j;
}

/** Signs in to the private rollup as the pocket (its key signs MagicBlock's challenge). */
async function signIn() {
  if (token) return;
  const c = await api(`/v1/spl/challenge?pubkey=${open!.address}&cluster=${CLUSTER}`);
  const sig = await sign(new TextEncoder().encode(c.challenge));
  token = (await api('/v1/spl/login', { pubkey: open!.address, challenge: c.challenge, signature: base58(sig), cluster: CLUSTER })).token;
}

/** Puts the pocket's signature into a transaction MagicBlock built (any version): it is one of the required signers. */
async function signBuilt(b64: string) {
  const wire = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  let o = 0; let n = 0, shift = 0;
  for (;;) { const x = wire[o++]; n |= (x & 0x7f) << shift; if (!(x & 0x80)) break; shift += 7; }
  const sigsAt = o, msg = wire.subarray(o + n * 64);
  let m = 0;
  if (msg[0] & 0x80) m = 1; // versioned: the version byte, then the header
  const required = msg[m];
  let k = m + 3, count = 0; shift = 0;
  for (;;) { const x = msg[k++]; count |= (x & 0x7f) << shift; if (!(x & 0x80)) break; shift += 7; }
  const mine = unb64uAddr(open!.address);
  let at = -1;
  for (let i = 0; i < Math.min(required, count); i++) if (msg.subarray(k + i * 32, k + i * 32 + 32).every((b, j) => b === mine[j])) at = i;
  if (at < 0) throw new Error('This transaction isn\'t the pocket\'s to sign');
  wire.set(await sign(msg), sigsAt + at * 64);
  return btoa(String.fromCharCode(...wire));
}
// the pocket's address as bytes
function unb64uAddr(a: string) {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const ch of a) n = n * 58n + BigInt(ALPHA.indexOf(ch));
  const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}

/** Sends a signed MagicBlock transaction where it belongs: the private rollup directly, Solana through Kashu's relay. */
async function deliver(built: { transactionBase64: string; sendTo: string }) {
  const b64 = await signBuilt(built.transactionBase64);
  if (built.sendTo === 'ephemeral') {
    const inner = token!.split('.').slice(1).join('.') || token!;
    const url = `${TEE}?token=${encodeURIComponent(inner)}`;
    const call = async (method: string, params: unknown[]) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
    const r = await call('sendTransaction', [b64, { encoding: 'base64' }]);
    if (r.error) throw new Error(r.error.message ?? 'The private rollup refused it');
    for (let i = 0; i < 30; i++) {
      const st = (await call('getSignatureStatuses', [[r.result]])).result?.value?.[0];
      if (st?.err) throw new Error('The private payment failed');
      if (st?.confirmationStatus) return r.result as string;
      await new Promise((res) => setTimeout(res, 700));
    }
    throw new Error('The private payment wasn\'t confirmed in time');
  }
  const r = await fetch(`${RELAY}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: b64 }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'Kashu\'s relay refused it');
  return j.signature as string;
}

/** The pocket's private balance, in USDC units (only the pocket can read it). */
export async function pocketBalance(): Promise<bigint> {
  await signIn();
  const b = await api(`/v1/spl/private-balance?address=${open!.address}&mint=${USDC_MINT}&cluster=${CLUSTER}`).catch((e) => {
    if (/not found|no .*account|does not exist/i.test((e as Error).message)) return { balance: '0' };
    throw e;
  });
  return BigInt(b.balance ?? b.amount ?? 0);
}

/** Moves dollars already in the pocket's Solana account into its private balance (gasless; 0.20 fee taken on top). */
export async function pocketDeposit(units: bigint) {
  if (units < POCKET_MIN) throw new Error('At least $0.50 at a time');
  const built = await api('/v1/spl/deposit', { owner: open!.address, amount: Number(units), mint: USDC_MINT, cluster: CLUSTER, initIfMissing: true, initVaultIfMissing: true, initAtasIfMissing: true, idempotent: true, private: true, gasless: true });
  return deliver(built);
}

/** A private payment from this pocket to another pocket. Free, and nothing about it shows on Solana. */
export async function pocketPay(to: string, units: bigint) {
  await signIn();
  const built = await api('/v1/spl/transfer', { from: open!.address, to, mint: USDC_MINT, amount: Number(units), visibility: 'private', fromBalance: 'ephemeral', toBalance: 'ephemeral', cluster: CLUSTER, initIfMissing: true, exactOut: true });
  return deliver(built);
}

/** Takes dollars out of the private balance back to the pocket's Solana account (gasless; 0.20 fee). */
export async function pocketWithdraw(units: bigint) {
  if (units < POCKET_MIN) throw new Error('At least $0.50 at a time');
  await signIn();
  const built = await api('/v1/spl/withdraw', { owner: open!.address, mint: USDC_MINT, amount: Number(units), cluster: CLUSTER, idempotent: true, gasless: true });
  return deliver(built);
}

/** Signs the relay-paid transfer from the pocket's Solana account to its own wallet (built by the app, checked by the relay). */
export async function pocketToWallet(wireB64: string, wallet: string) {
  const b64 = await signBuilt(wireB64);
  const r = await fetch(`${RELAY}/pocket-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: b64, wallet }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'Kashu\'s relay refused it');
  return j.signature as string;
}

