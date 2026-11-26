import { plain } from './plain.ts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { closeReview, onReview, reviewState } from './live.ts';

// What you're about to sign, read back in plain words before Face ID. Danger lines come first and in red;
// anything Kashu never does can't be approved at all. Approve goes straight to the passkey prompt.
export function ReviewSheet() {
  const ask = useSyncExternalStore(onReview, reviewState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setBusy(false); setError(null); }, [ask]);
  if (!ask) return null;
  const { title, pending } = ask;
  const approve = async () => {
    setBusy(true); setError(null);
    try { closeReview(await pending.approve()); }
    catch (e) {
      const msg = (e as Error).message || '';
      setError(/NotAllowed|cancel|abort/i.test(msg) ? 'Face ID was cancelled. Nothing was signed.' : plain(e));
      setBusy(false);
    }
  };
  return createPortal(
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-labelledby="rv-h">
      <button className="sheet-scrim" aria-label="Cancel" onClick={() => !busy && closeReview(null)} />
      <div className="sheet review-sheet">
        <div className="sheet-grip"><span /></div>
        <div className="sheet-body">
          <h2 id="rv-h">{title}</h2>
          <p className="sheet-lead">Here's exactly what you're approving.</p>
          <ul className="review-lines">
            {pending.lines.map((l, i) => <li key={i} className={`rv-${l.tone}`}>{l.text}</li>)}
          </ul>
          {pending.blocked && <p className="review-stop">This has something in it Kashu never does, so it can't be approved.</p>}
          {error && <p className="review-error" role="alert">{error}</p>}
          <button className="btn btn-primary" disabled={busy || pending.blocked} onClick={approve}>
            {busy ? 'Waiting for Face ID…' : 'Approve with Face ID'}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => closeReview(null)}>Not now</button>
          <p className="review-note">Kashu pays the network fee. Your passkey signs only this, once.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
