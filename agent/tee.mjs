// MagicBlock's private rollup, checked the way its SDK does (verifyTeeRpcIntegrity): a fresh random challenge, the
// validator's Intel TDX quote verified against Intel's collateral, and the quote's report data must equal the
// challenge, so the quote was made now, for us, by genuine TDX hardware. Like the SDK, this proves the hardware is
// genuine; it does not prove which code runs inside (that needs MagicBlock to publish expected measurements).
import crypto from 'node:crypto';
import { getCollateral, verify, Quote } from '@phala/dcap-qvl';

const TEE = process.env.MB_TEE_URL || 'https://devnet-tee-as.magicblock.app';
let cached = null;
export async function teeCheck() {
  if (cached && Date.now() - cached.at < 600_000) return cached.v;
  const challenge = crypto.randomBytes(64);
  let v;
  try {
    const r = await fetch(`${TEE}/quote?challenge=${encodeURIComponent(challenge.toString('base64'))}`, { signal: AbortSignal.timeout(20_000) });
    const body = await r.json();
    if (r.status !== 200 || !body.quote) throw new Error(body.error ?? 'no quote');
    const raw = Uint8Array.from(Buffer.from(body.quote, 'base64'));
    const collateral = await getCollateral('https://pccs.phala.network/tdx/certification/v4', raw);
    const report = verify(raw, collateral, Math.floor(Date.now() / 1000));
    const q = Quote.parse(raw);
    const td = q.report.asTd10() ?? q.report.asTd15()?.base;
    if (!td) throw new Error('unsupported quote format');
    const fresh = Buffer.from(td.reportData).equals(challenge);
    v = { verified: fresh, hardware: 'Intel TDX', status: report?.status ?? null, mrtd: Buffer.from(td.mrTd).toString('hex').slice(0, 24), checkedAt: new Date().toISOString(), validator: TEE.replace('https://', '') };
  } catch (e) {
    v = { verified: false, error: String(e.message).slice(0, 120), checkedAt: new Date().toISOString() };
  }
  cached = { at: Date.now(), v };
  return v;
}
