// Web Push with nothing but Node's crypto: the message is encrypted for the subscriber's browser (RFC 8291,
// aes128gcm) and Kashu's server identifies itself to the push service with a signed token (RFC 8292, VAPID).
// Only the browser that subscribed can read the message; the push service (Google, Apple, Mozilla) cannot.
import crypto from 'node:crypto';
import fs from 'node:fs';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Push services a browser may subscribe through. Anything else is refused, so the keeper never calls an arbitrary URL. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/, /^android\.googleapis\.com$/];
export function validSubscription(sub) {
  try {
    const u = new URL(sub.endpoint);
    if (u.protocol !== 'https:' || u.port || !PUSH_HOSTS.some((re) => re.test(u.hostname)) || sub.endpoint.length > 1024) return false;
    return unb64u(sub.keys?.p256dh).length === 65 && unb64u(sub.keys?.auth).length === 16;
  } catch { return false; }
}

/** The server's VAPID key pair, made once and kept in a file only the relay and keeper can read. */
export function vapidKeys(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const k = { privateJwk: privateKey.export({ format: 'jwk' }), publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' }).subarray(-65)) };
  fs.writeFileSync(file, JSON.stringify(k), { mode: 0o400 });
  return k;
}

function encrypt(payload, sub) {
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = 65;
  return Buffer.concat([head, asPublic, body]);
}

function vapidHeader(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Sends one notification. Returns 'ok', 'gone' (the subscription expired: drop it) or 'failed'. */
export async function sendPush(sub, message, keys, subject = 'https://getkashu.com') {
  if (!validSubscription(sub)) return 'gone';
  const r = await fetch(sub.endpoint, {
    method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'error',
    headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high', authorization: vapidHeader(sub.endpoint, keys, subject) },
    body: encrypt(JSON.stringify(message), sub),
  }).catch(() => null);
  if (!r) return 'failed';
  if (r.status === 404 || r.status === 410) return 'gone';
  return r.ok ? 'ok' : 'failed';
}
