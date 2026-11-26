import { plain } from './plain.ts';
import { useEffect, useRef, useState } from 'react';
import { KernelRow, Window } from '../ui/Wall.tsx';
import { money } from '../ui/money.ts';
import { actions, me, useStore } from './store.ts';
import { savePrivately, save as saveLive } from './live.ts';

const WHERE = 'kashu.savewhere';
const savedWhere = (): 'earn' | 'private' => { try { return localStorage.getItem(WHERE) === 'private' ? 'private' : 'earn'; } catch { return 'earn'; } };

const HOLD_MS = 1100;

// Saving: hold to put this payday's amount away. The fill runs in a straight line while held and lets
// go safely if released early; no confirm dialog. Afterwards your window is lit.
export function Save() {
  const s = useStore();
  const you = me(s);
  const [amount, setAmount] = useState(s.weekly);
  const [where, setWhere] = useState(savedWhere);
  const pick = (w: 'earn' | 'private') => { setWhere(w); try { localStorage.setItem(WHERE, w); } catch { /* fine */ } };
  const [done, setDone] = useState(you.lit);
  const fill = useRef<HTMLSpanElement>(null);
  const t0 = useRef(0);
  const raf = useRef(0);
  const holding = useRef(false);
  const [filling, setFilling] = useState(false);
  const [settled, setSettled] = useState(0);

  const paint = (k: number, animate = false) => {
    const el = fill.current; if (!el) return;
    el.style.transition = animate ? 'clip-path 200ms cubic-bezier(0.23, 1, 0.32, 1)' : 'none';
    el.style.clipPath = `inset(0 ${(1 - k) * 100}% 0 0)`;
  };
  const tick = () => {
    if (!holding.current) return;
    const k = Math.min(1, (performance.now() - t0.current) / HOLD_MS);
    paint(k);
    if (k >= 1) { holding.current = false; setFilling(false); setSettled((n) => n + 1); complete(); return; }
    raf.current = requestAnimationFrame(tick);
  };
  const start = (e: React.PointerEvent) => {
    if (done || !(amount > 0)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    holding.current = true; setFilling(true); t0.current = performance.now(); raf.current = requestAnimationFrame(tick);

  };
  const stop = () => { if (!holding.current) return; holding.current = false; setFilling(false); cancelAnimationFrame(raf.current); paint(0, true); };
  const [error, setError] = useState<string | null>(null);
  const complete = async () => {
    navigator.vibrate?.(18);
    if (!s.live) { actions.save(amount); setDone(true); return; }
    try { if (await (where === 'private' ? savePrivately(amount) : saveLive(amount))) setDone(true); else paint(0, true); }
    catch (e) { setError(plain(e)); paint(0, true); }
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  // keyboard and screen readers: Enter or Space held does the same, and a plain button press works too
  const onKey = (e: React.KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && !done) { e.preventDefault(); complete(); } };

  if (done) {
    return (
      <div className="save save-done">
        <div className="save-win"><Window f={me(s)} size="lg" /></div>
        <h1>Kept safe.</h1>
        <p className="save-sub">That's {me(s).streak} week{me(s).streak === 1 ? '' : 's'} in a row. Still yours, any time.</p>
        <KernelRow filled={Math.min(8, me(s).streak)} total={8} />
        <a className="btn btn-primary save-back" href="#app-room">Back to the room</a>
      </div>
    );
  }
  const presets = [...new Set([0.5, 1, 2].map((k) => Math.max(1, Math.round(s.weekly * k))))];
  return (
    <div className="save">
      <div className={`save-jar ${filling ? 'filling' : ''}`} key={settled} aria-hidden="true">
        <img className="jar" src="objects/jar-cut.webp" alt="" draggable={false} />
        {filling && Array.from({ length: 9 }, (_, i) => (
          <img key={i} className="drop" src={`objects/${i % 2 ? 'kernel-a' : 'kernel-b'}.webp`} alt="" draggable={false}
            style={{ ['--i' as string]: i, ['--x' as string]: `${(i * 37) % 60 - 30}px`, ['--r' as string]: `${(i * 71) % 360}deg` }} />
        ))}
      </div>
      <p className="save-kicker">This payday</p>
      <div className="amount-big display">{money(amount)}</div>
      <div className="chips" role="group" aria-label="Amount">
        {presets.map((p) => <button key={p} type="button" className={`chip ${p === amount ? 'on' : ''}`} aria-pressed={p === amount} onClick={() => setAmount(p)}>{money(p)}</button>)}
      </div>
      {s.live && (
        <div className="save-where" role="radiogroup" aria-label="Where this save goes">
          <button type="button" role="radio" aria-checked={where === 'earn'} className={where === 'earn' ? 'on' : ''} onClick={() => pick('earn')}>
            <b>Earn interest</b><small>About 4% a year on Jupiter Lend, and it feeds Friday's prize</small>
          </button>
          <button type="button" role="radio" aria-checked={where === 'private'} className={where === 'private' ? 'on' : ''} onClick={() => pick('private')}>
            <b>Private</b><small>In your private pocket: nobody can look the balance up. No interest</small>
          </button>
        </div>
      )}
      <p className="save-note">{where === 'private' && s.live
        ? `Your room still sees that you saved, checked inside MagicBlock's private rollup; never the amount. MagicBlock charges ${money(0.2)} to move money in. At least $0.50.`
        : 'It goes into your own vault. Only you can take it out.'}</p>
      {error && <p className="review-error" role="alert">{error}</p>}
      <button type="button" className="hold" onPointerDown={start} onPointerUp={stop} onPointerCancel={stop} onPointerLeave={stop} onKeyDown={onKey}
        aria-label={`Hold to save ${money(amount)}`}>
        <span className="hold-label">Hold to save {money(amount)}</span>
        <span className="hold-fill" ref={fill} aria-hidden="true"><span className="hold-label">Hold to save {money(amount)}</span></span>
      </button>
      <a className="save-cancel" href="#app-room">Not now</a>
    </div>
  );
}
