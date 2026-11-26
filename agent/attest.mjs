// Checks that a NEAR AI Cloud model really runs inside a TEE before the agent trusts it with a
// plan, and checks each answer was signed by that same TEE. Nothing here is kept after a run.
//
//   1. ask for an attestation report with a fresh random nonce
//   2. the Intel TDX quote: signature and cert chain checked against Intel's collateral
//   3. the quote's report_data must hold this TEE's signing address and our nonce, so the
//      quote was made for us, now, and for the key that will sign the answers
//   4. the GPU evidence goes to NVIDIA's attestation service, which must say yes for our nonce
//   5. the TDX event log replays to the quote's RTMR3, so the log is what really happened at boot
//   6. the app's compose file hashes to the quote's MRCONFIGID and to the log's compose-hash event,
//      so the containers in that file are the ones this enclave booted
//   7. after a chat, the response signature must recover to that signing address and its
//      hashes must match the exact bytes we sent and got back
import crypto from 'crypto';
import { ethers } from 'ethers';
import { getCollateralAndVerify } from '@phala/dcap-qvl';

export const BASE = 'https://cloud-api.near.ai';
const NRAS = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const jwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

export async function attest(model, key) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const url = `${BASE}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}`, 'x-no-aliasing': 'true' } });
  if (!res.ok) throw new Error(`attestation report ${res.status}: ${await res.text()}`);
  const report = await res.json();
  const nodes = report.model_attestations ?? [];
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
  add('the model runs on attested TEE nodes', nodes.length > 0, `${nodes.length} node(s)`);

  const signers = [];
  for (const a of nodes) {
    const who = a.signing_address;
    add(`${who} echoes our nonce`, a.request_nonce === nonce);

    const quote = Buffer.from(a.intel_quote, 'hex');
    try {
      const v = await getCollateralAndVerify(quote);
      add(`${who} Intel TDX quote verifies`, ['UpToDate', 'SWHardeningNeeded', 'ConfigurationAndSWHardeningNeeded'].includes(v.status), v.status);
    } catch (e) {
      add(`${who} Intel TDX quote verifies`, false, e.message);
    }
    // TDX v4 quote: 48-byte header, report_data is the last 64 bytes of the 584-byte body
    const rd = quote.subarray(568, 632).toString('hex');
    const bound = rd === who.slice(2).toLowerCase().padEnd(64, '0') + nonce;
    add(`${who} quote binds its signing key and our nonce`, bound, rd);

    // RTMR3: each event extends it with sha384(rtmr3 || digest). dstack leaves the digest out of its
    // own events, and it is sha384(type, little-endian || ":" || name || ":" || payload).
    try {
      const log = typeof a.event_log === 'string' ? JSON.parse(a.event_log) : a.event_log;
      const digest = (e) => {
        if (e.digest) return Buffer.from(e.digest, 'hex');
        const t = Buffer.alloc(4); t.writeUInt32LE(e.event_type);
        return crypto.createHash('sha384').update(Buffer.concat([t, Buffer.from(':'), Buffer.from(e.event || ''), Buffer.from(':'), Buffer.from(e.event_payload || '', 'hex')])).digest();
      };
      const events = log.filter((e) => e.imr === 3);
      let rtmr3 = Buffer.alloc(48);
      for (const e of events) rtmr3 = crypto.createHash('sha384').update(Buffer.concat([rtmr3, digest(e)])).digest();
      add(`${who} the boot log replays to the quote's RTMR3`, rtmr3.equals(quote.subarray(520, 568)), `${events.length} events`);
      const tcb = typeof a.info?.tcb_info === 'string' ? JSON.parse(a.info.tcb_info) : a.info?.tcb_info;
      const composeHash = crypto.createHash('sha256').update(tcb.app_compose).digest('hex');
      const mrConfig = quote.subarray(232, 280).toString('hex');
      add(`${who} the compose file is the one this enclave booted`, mrConfig.startsWith(`01${composeHash}`) && events.find((e) => e.event === 'compose-hash')?.event_payload === composeHash, composeHash.slice(0, 16));
    } catch (e) {
      add(`${who} the boot log replays to the quote's RTMR3`, false, e.message);
    }

    try {
      const body = typeof a.nvidia_payload === 'string' ? a.nvidia_payload : JSON.stringify(a.nvidia_payload);
      const sent = JSON.parse(body);
      const r = await fetch(NRAS, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!r.ok) throw new Error(`NVIDIA ${r.status}`);
      const out = await r.json();
      const overall = jwt(out.find((x) => Array.isArray(x))[1]);
      const gpus = Object.entries(out.find((x) => !Array.isArray(x)) ?? {}).map(([k, t]) => `${k} ${jwt(t).hwmodel}`);
      const ok = overall['x-nvidia-overall-att-result'] === true && overall.eat_nonce?.toLowerCase() === nonce && sent.nonce?.toLowerCase() === nonce;
      add(`${who} NVIDIA confirms the GPUs for our nonce`, ok, gpus.join(', '));
    } catch (e) {
      add(`${who} NVIDIA confirms the GPUs for our nonce`, false, e.message);
    }
    if (checks.filter((c) => c.name.startsWith(who)).every((c) => c.pass)) signers.push(who.toLowerCase());
  }
  const gateway = report.gateway_attestation?.signing_address?.toLowerCase();
  return { model, nonce, checks, signers, gateway, passed: signers.length > 0 && checks.every((c) => c.pass) };
}

// requestBody and responseText must be the exact strings that went over the wire
export async function checkAnswer({ model, key, chatId, requestBody, responseText, signers, gateway }) {
  let sig;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${BASE}/v1/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${key}` } });
    if (r.ok) { sig = await r.json(); break; }
    if (r.status !== 404) throw new Error(`signature ${r.status}: ${await r.text()}`);
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  if (!sig) throw new Error('no signature for this answer');
  const parts = sig.text.split(':');
  const kind = sig.signature_kind ?? (parts.length === 3 ? 'provider_tee' : 'gateway');
  const [req, resp] = kind === 'provider_tee' ? parts.slice(1) : parts;
  const signer = ethers.verifyMessage(sig.text, sig.signature).toLowerCase();
  const allowed = kind === 'provider_tee' ? signers : [gateway];
  return {
    kind,
    signer,
    hashesMatch: req === sha(requestBody) && resp === sha(responseText) && (kind !== 'provider_tee' || parts[0] === model),
    signerAttested: allowed.includes(signer),
    get passed() { return this.hashesMatch && this.signerAttested; },
  };
}
