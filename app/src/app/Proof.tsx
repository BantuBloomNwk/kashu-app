import { useEffect, useState } from 'react';
import { RELAY } from '../wallet/wallet.ts';
import { explorer } from '../config.ts';

type Tee = { verified: boolean; hardware?: string; status?: string; checkedAt: string; validator?: string; error?: string };
/** The private rollup's hardware, checked just now: a fresh Intel TDX quote bound to Kashu's challenge. */
function TeeBadge() {
  const [t, setT] = useState<Tee | null>(null);
  useEffect(() => { fetch(`${RELAY}/agent/tee`).then((r) => r.json()).then(setT, () => setT({ verified: false, checkedAt: new Date().toISOString(), error: 'unreachable' })); }, []);
  if (!t) return <p className="tee-badge">Checking the private rollup's hardware…</p>;
  return (
    <details className={`tee-badge ${t.verified ? 'ok' : 'off'}`}>
      <summary>{t.verified ? `Private rollup verified: genuine ${t.hardware} hardware` : 'The private rollup\'s hardware check didn\'t pass just now'}</summary>
      <p>Kashu asks MagicBlock's private rollup ({t.validator ?? 'TEE'}) to prove itself with a fresh challenge. Its Intel TDX quote is checked against Intel's own records{t.status ? ` (status: ${t.status})` : ''} and must carry that exact challenge, so it was made now, by real sealed hardware. This proves the hardware, not which code runs inside it.</p>
      <small>checked {new Date(t.checkedAt).toLocaleTimeString()}</small>
    </details>
  );
}

type P = { sig: string; where: 'solana' | 'tee'; at: number };
// what each step is, in plain words, and which part of the stack did it
const STEPS: [string, string, string][] = [
  ['private', 'Room moved to a private rollup', 'MagicBlock Private Ephemeral Rollup (a TEE)'],
  ['shared', 'Only members\' phones may read it', 'MagicBlock PER permissions'],
  ['checkin', 'A save counted, for free, in milliseconds', 'MagicBlock Ephemeral Rollup + session key'],
  ['vrf', 'Friday\'s random number asked for', 'MagicBlock VRF'],
  ['drawn', 'Winning ticket picked from it', 'Rooms program, on the rollup'],
  ['committed', 'Only the result sent back to Solana', 'MagicBlock commit'],
  ['harvest', 'Interest moved into the prize', 'Jupiter Lend'],
  ['paid', 'Prize paid to the winner\'s vault', 'Kashu vault on Solana'],
];
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

/** Behind the scenes: the room's latest real transaction for each step, so anyone can check it happened. */
export function Proof({ room }: { room: string }) {
  const [p, setP] = useState<Record<string, P> | null>(null);
  useEffect(() => {
    let live = true;
    const get = () => fetch(`${RELAY}/proof?room=${room}`).then((r) => r.json()).then((j) => live && setP(j), () => live && setP({}));
    get(); const t = setInterval(get, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [room]);
  return (
    <div className="proof">
      <TeeBadge />
      {!p ? <p className="hint">Reading the chain…</p> : (
        <ol className="proof-steps">
          {STEPS.map(([k, what, by], i) => {
            const x = p[k];
            return (
              <li key={k} className={x ? 'done' : ''} style={{ ['--i' as string]: i }}>
                <span className="proof-dot" aria-hidden="true" />
                <span className="proof-text"><b>{what}</b><small>{by}</small></span>
                {x ? (x.where === 'solana'
                  ? <a href={explorer('tx', x.sig)} target="_blank" rel="noopener noreferrer">{ago(x.at)} · receipt</a>
                  : <span className="proof-private" title={x.sig}>{ago(x.at)} · private</span>)
                  : <span className="proof-wait">not yet</span>}
              </li>
            );
          })}
        </ol>
      )}
      <p className="hint">Receipts on Solana open in the public explorer. Steps on the private rollup can only be read by this room's members: that's the point.</p>
    </div>
  );
}
