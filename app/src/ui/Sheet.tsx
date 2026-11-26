import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// A bottom sheet that behaves like a physical card: it follows the finger 1:1 from where it was grabbed, resists
// softly when pulled up past its home, and on release projects the throw (Apple's decay projection) to decide whether
// it goes or comes back, carrying the finger's speed into the motion. It can be grabbed again mid-flight.
const project = (v: number, d = 0.998) => ((v / 1000) * d) / (1 - d);
const rubber = (o: number, dim: number, c = 0.55) => (o * dim * c) / (dim + c * Math.abs(o));
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Sheet({ open, onClose, title, children, kicker }: { open: boolean; onClose: () => void; title: string; kicker?: string; children: ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ y0: number; last: { y: number; t: number }[]; base: number } | null>(null);
  const y = useRef(0);

  const place = (to: number, ms = 0, ease = 'var(--ease-drawer)') => {
    const el = sheet.current; if (!el) return;
    y.current = to;
    el.style.transition = ms ? `transform ${ms}ms ${ease}` : 'none';
    el.style.transform = `translate3d(0, ${to}px, 0)`;
    if (scrim.current) { scrim.current.style.transition = ms ? `opacity ${ms}ms linear` : 'none'; scrim.current.style.opacity = String(Math.max(0, 1 - to / Math.max(1, el.offsetHeight))); }
  };
  const close = (velocity = 0) => {
    const el = sheet.current; if (!el) return onClose();
    if (reduced()) { el.style.transition = 'opacity 180ms linear'; el.style.opacity = '0'; setTimeout(onClose, 170); return; }
    const remaining = el.offsetHeight - y.current;
    // the faster the throw, the quicker it leaves; never slower than a calm close
    const ms = Math.max(160, Math.min(340, velocity > 0 ? (remaining / velocity) * 1000 * 1.6 : 340));
    place(el.offsetHeight + 24, ms, 'cubic-bezier(0.2, 0.6, 0.3, 1)');
    setTimeout(onClose, ms - 10);
  };

  useEffect(() => {
    if (!open) return;
    const el = sheet.current; if (!el) return;
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    if (reduced()) { el.style.opacity = '0'; requestAnimationFrame(() => { el.style.transition = 'opacity 200ms linear'; el.style.opacity = '1'; }); }
    else { place(el.offsetHeight); requestAnimationFrame(() => place(0, 420)); }
    el.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', key);
    return () => { document.body.style.overflow = prev; removeEventListener('keydown', key); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, [data-no-drag]')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { y0: e.clientY, base: y.current, last: [{ y: e.clientY, t: performance.now() }] };
    place(y.current);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || !sheet.current) return;
    let to = d.base + (e.clientY - d.y0);
    if (to < 0) to = -rubber(-to, sheet.current.offsetHeight);
    d.last.push({ y: e.clientY, t: performance.now() }); if (d.last.length > 5) d.last.shift();
    place(to);
  };
  const up = () => {
    const d = drag.current; drag.current = null; const el = sheet.current; if (!d || !el) return;
    const a = d.last[0], b = d.last[d.last.length - 1];
    const v = b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0; // px/s, down is positive
    const landing = y.current + project(v);
    if (landing > el.offsetHeight * 0.45) close(Math.max(0, v));
    else place(0, 380, v < -400 ? 'cubic-bezier(0.34, 1.25, 0.64, 1)' : 'var(--ease-drawer)'); // a flick back up earns a little give
  };

  return createPortal(
    <div className="ksheet-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <button ref={scrim} className="ksheet-scrim" aria-label="Close" onClick={() => close()} />
      <div ref={sheet} className="ksheet" tabIndex={-1} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="ksheet-grip" aria-hidden="true"><span /></div>
        <header className="ksheet-head">
          <div>{kicker && <small>{kicker}</small>}<h2>{title}</h2></div>
          <button type="button" className="ksheet-x" aria-label="Close" onClick={() => close()}><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </header>
        <div className="ksheet-body" data-no-drag>{children}</div>
      </div>
    </div>, document.body);
}
