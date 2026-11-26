import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './receipt.css';

// A receipt in plain words: what happened, to whose money, and that it's done. It prints out of a slot
// line by line, like a till slip. The chain link sits at the bottom for anyone who wants to check it.
export type Line = { k: string; v: ReactNode; strong?: boolean } | 'rule';

export function Receipt({ title, sub, lines, check, stamp, demo = true }: {
  title: string; sub?: string; lines: Line[]; check?: { label: string; href: string }; stamp?: string; demo?: boolean;
}) {
  return (
    <div className="rcpt" role="group" aria-label={title}>
      <div className="rcpt-paper">
        <div className="rcpt-head">
          <img src="brand/kashu-mark-flat.svg" alt="" width={26} height={26} />
          <div><b>{title}</b>{sub && <span>{sub}</span>}</div>
          {demo && <span className="rcpt-demo">Demo</span>}
        </div>
        <ul className="rcpt-lines">
          {lines.map((l, i) => l === 'rule'
            ? <li key={i} className="rcpt-rule" style={{ ['--i' as string]: i }} aria-hidden="true" />
            : <li key={i} className={l.strong ? 'strong' : ''} style={{ ['--i' as string]: i }}><span>{l.k}</span><b>{l.v}</b></li>)}
        </ul>
        {stamp && <span className="rcpt-stamp" style={{ ['--i' as string]: lines.length }}>{stamp}</span>}
        {check && (
          <a className="rcpt-check" href={check.href} target="_blank" rel="noopener noreferrer" style={{ ['--i' as string]: lines.length + 1 }}>
            {check.label}
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </a>
        )}
      </div>
    </div>
  );
}

/** The receipt slides out of a slot over the screen; tap outside, the button, or Escape to put it away. */
export function ReceiptSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) setShown(true);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!shown) return null;
  return createPortal(
    <div className={`rcpt-sheet ${open ? 'in' : 'out'}`} onAnimationEnd={() => { if (!open) setShown(false); }}>
      <button type="button" className="rcpt-scrim" aria-label="Close the receipt" onClick={onClose} />
      <div className="rcpt-slot" role="dialog" aria-modal="true" aria-label="Receipt">
        <span className="rcpt-mouth" aria-hidden="true" />
        {children}
        <button type="button" className="btn btn-kernel rcpt-done" onClick={onClose}>Done</button>
      </div>
    </div>,
    document.body,
  );
}
