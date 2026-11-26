import { plain } from './plain.ts';
import { useState } from 'react';
import { money } from '../ui/money.ts';
import { pocket } from '../wallet/pocket.ts';
import * as P from '../wallet/pocket.ts';
import { NoPrf, makePocketKey } from '../wallet/pocket.ts';
import { addToPocket, cashOutPocket } from './live.ts';
import { useStore } from './store.ts';

/** The private pocket: a balance on MagicBlock's private rollup that nobody can look up. Opened with Face ID per session. */
export function PocketCard() {
  const s = useStore();
  const [bal, setBal] = useState<number | null>(pocket() ? null : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'add' | 'out' | null>(null);
  const [noPrf, setNoPrf] = useState(false);
  const read = async () => setBal(Number(await P.pocketBalance()) / 1e6);
  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label); setErr(null);
    try { await f(); await read(); setMode(null); setAmount(''); setNoPrf(false); } catch (e) { if (e instanceof NoPrf) setNoPrf(true); setErr(plain(e)); } finally { setBusy(null); }
  };
  const n = Number(amount);
  const fee = 0.2;
  return (
    <section className="me-card pocket" aria-labelledby="pocket-h">
      <h2 id="pocket-h">Private pocket</h2>
      <p>Money here sits on MagicBlock's private rollup: nobody can look it up, and paying a friend's pocket doesn't show on any public record. Free to pay from.</p>
      {bal === null ? (
        <><div className="me-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => run('Opening…', async () => { await P.openPocket(); })}>{busy ?? 'Open my pocket'}</button>
          {noPrf && <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => run('Scan the code with your phone…', async () => { await makePocketKey(); await P.openPocket(); })}>Use a passkey on my phone</button>}
        </div>
        {noPrf && <p className="hint">Your computer shows a QR code; your phone makes a passkey just for the pocket and keeps it. On this computer you'll open the pocket by scanning once per visit.</p>}</>
      ) : (
        <>
          <div className="pocket-bal"><span>In your pocket</span><b className="display">{money(bal)}</b></div>
          {!mode && (
            <div className="me-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setMode('add')}>Add money</button>
              {bal > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode('out')}>Move to my wallet</button>}
              <a className="btn btn-ghost btn-sm" href="#app-send">Pay privately</a>
            </div>
          )}
          {mode && (
            <form className="pocket-form" onSubmit={(e) => { e.preventDefault(); if (n >= 0.5) run(mode === 'add' ? 'Moving it in…' : 'Moving it out…', () => (mode === 'add' ? addToPocket(n) : cashOutPocket(n))); }}>
              <div className="amount-row"><span aria-hidden="true">$</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.50" aria-label="Amount" autoFocus /></div>
              <p className="hint">{mode === 'add'
                ? `From your wallet (${money(s.live?.walletUsdc ?? 0)} there). MagicBlock charges ${money(fee)} to move money in, and Kashu keeps ${money(fee)} aside for the trip back out.`
                : `MagicBlock charges ${money(fee)} to move money out. At least $0.50.`}</p>
              <div className="me-actions">
                <button className="btn btn-primary btn-sm" disabled={!(n >= 0.5) || !!busy}>{busy ?? (mode === 'add' ? `Add ${n > 0 ? money(n) : ''}` : `Move ${n > 0 ? money(n) : ''} out`)}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setMode(null); setErr(null); }}>Cancel</button>
              </div>
            </form>
          )}
        </>
      )}
      {err && <p className="review-error" role="alert">{err}</p>}
    </section>
  );
}
