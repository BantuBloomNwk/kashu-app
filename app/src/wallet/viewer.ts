// The viewer key: an Ed25519 key the browser makes on this phone to read a private room on MagicBlock's TEE rollup.
// A passkey smart wallet can't sign the rollup's sign-in message, so this key does. It is created non-extractable
// (its secret never leaves the browser's key store, not even to our own code), it can only read the room, and the
// rooms program lists it as a reader when the member joins.
import { base58 } from '@readback/review';
import { DEFAULT_TEE } from '../config.ts';

export const TEE = (import.meta.env.VITE_TEE as string | undefined) ?? DEFAULT_TEE;
const DB = 'kashu-keys', STORE = 'keys', ID = 'viewer';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function get(): Promise<CryptoKeyPair | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => { const t = d.transaction(STORE).objectStore(STORE).get(ID); t.onsuccess = () => resolve(t.result); t.onerror = () => reject(t.error); });
}
async function put(k: CryptoKeyPair) {
  const d = await db();
  return new Promise<void>((resolve, reject) => { const t = d.transaction(STORE, 'readwrite').objectStore(STORE).put(k, ID); t.onsuccess = () => resolve(); t.onerror = () => reject(t.error); });
}

/** This phone's viewer key (made the first time), and its public key as a Solana address. */
export async function viewerKey() {
  let k = await get();
  if (!k) {
    k = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    await put(k);
  }
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
  return { keys: k, address: base58(raw) };
}

let token: { value: string; until: number } | null = null;
/** Signs in to the TEE rollup with the viewer key (challenge, signature, token) and returns a token for reads. */
export async function teeToken() {
  if (token && token.until > Date.now() + 60_000) return token.value;
  const { keys, address } = await viewerKey();
  const c = await (await fetch(`${TEE}/auth/challenge?pubkey=${address}`)).json();
  if (!c.challenge) throw new Error('The private rollup did not answer');
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, new TextEncoder().encode(c.challenge)));
  const r = await (await fetch(`${TEE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pubkey: address, challenge: c.challenge, signature: base58(sig) }) })).json();
  if (!r.token) throw new Error('The private rollup refused the sign-in');
  token = { value: r.token, until: r.expiresAt ? Number(r.expiresAt) : Date.now() + 25 * 86400_000 };
  return token.value;
}

/** Reads an account on the private rollup as this phone's viewer. Null when it can't be seen. */
export async function teeAccount(address: string, retried = false): Promise<Uint8Array | null> {
  const t = await teeToken();
  const r = await (await fetch(`${TEE}?token=${t}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'confirmed' }] }) })).json();
  const v = r.result?.value;
  // a sign-in made before this phone was added to the room may not carry the new access: sign in again once
  if (!v && !retried) { token = null; return teeAccount(address, true); }
  return v ? Uint8Array.from(atob(v.data[0]), (ch) => ch.charCodeAt(0)) : null;
}
