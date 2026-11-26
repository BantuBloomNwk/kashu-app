import { ReceiptSheet } from '../ui/Receipt.tsx';
import { DrawReceipt } from './receipts.tsx';
import { useEffect, useRef, useState } from 'react';
import { Moon } from '../ui/Mark.tsx';
import { Wall } from '../ui/Wall.tsx';
import { PRIZE, money } from '../ui/money.ts';
import { actions, me, useStore } from './store.ts';

// Draw night: the one dusk screen. The result is fixed before anything plays (a refresh lands on the
// result); a light travels the lit windows and rests. Skip is always there; the calm draw just fades.
export function Draw() {
  const s = useStore();
  const [phase, setPhase] = useState<'before' | 'running' | 'result'>(s.drawSeen && s.draw ? 'result' : 'before');
  const [at, setAt] = useState<string | null>(s.drawSeen && s.draw ? s.draw.winnerId : null);
  const timers = useRef<number[]>([]);
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const finish = (id: string) => { timers.current.forEach(clearTimeout); setAt(id); setPhase('result'); actions.seenDraw(); navigator.vibrate?.([12, 60, 24]); };
  const begin = () => {
    const d = actions.draw();
    if (s.calmDraw || reduce) { finish(d.winnerId); return; }
    setPhase('running');
    const lit = s.friends.filter((f) => f.lit).map((f) => f.id);
    const path = [...lit, ...lit, ...lit.slice(0, lit.indexOf(d.winnerId) + 1)];
    let t = 0;
    path.forEach((id, i) => {
      const k = i / path.length;
      t += 85 + Math.pow(k, 3) * 420; // quick at first, slowing to rest
      timers.current.push(window.setTimeout(() => { setAt(id); if (i === path.length - 1) finish(id); }, t));
    });
  };
  const [receipt, setReceipt] = useState(false);
  const d = s.draw;
  const you = me(s);
  const winner = d ? s.friends.find((f) => f.id === d.winnerId) : null;
  const youWon = d?.winnerId === 'you';

  return (
    <div className={`draw draw-${phase}`}>
      <div className="draw-sky"><Moon size={phase === 'result' ? 92 : 120} /></div>
      <p className="draw-when">Draw night · Friday 8pm</p>
      <Wall friends={s.friends} size="md" highlightId={at ?? undefined} className="draw-wall" />

      {phase === 'before' && s.live && (
        <div className="draw-copy">
          <h1>Prize so far: {money(s.live.pot)}</h1>
          {s.live.pot === 0 && <p className="hint">The pot starts empty after each draw and fills up during the week from the room's interest and sponsors.</p>}
          <p>{s.live.draw && s.live.draw.week >= s.live.week - 1
            ? (s.live.draw.winner === s.live.wallet ? 'You won this week. The prize is in your vault, as your own savings.' : `${s.friends.find((f) => f.id === s.live!.draw!.winner)?.name ?? 'A friend'} won this week. Your savings are all still here.`)
            : `When the week ends, Kashu starts the draw and MagicBlock's randomness picks one ticket. ${you.lit ? `You have ${Math.min(4, you.streak)} chance${Math.min(4, you.streak) > 1 ? 's' : ''}.` : 'Save this week to be in it.'}`}</p>
        </div>
      )}
      {phase === 'before' && !s.live && (
        <div className="draw-copy">
          <h1>Tonight's prize: {money(PRIZE)}</h1>
          <p>The room's interest plus a Friday bonus goes to one saver. {you.lit ? `You have ${Math.min(4, you.streak)} chance${Math.min(4, you.streak) > 1 ? 's' : ''}.` : 'Save this week to be in it.'}</p>
          <button className="btn btn-kernel draw-go" onClick={begin}>Start the draw</button>
          <label className="calm"><input type="checkbox" checked={s.calmDraw} onChange={(e) => actions.setCalm(e.target.checked)} /> Calm draw</label>
        </div>
      )}
      {phase === 'running' && (
        <div className="draw-copy">
          <p className="draw-wait" aria-live="polite">Picking this week's saver...</p>
          <button className="btn draw-skip" onClick={() => d && finish(d.winnerId)}>Skip</button>
        </div>
      )}
      {phase === 'result' && d && (
        <div className="draw-copy draw-result" aria-live="polite">
          {youWon ? (
            <>
              {!s.calmDraw && !reduce && <KernelBurst />}
              <h1 className="win-title">It's you!</h1>
              <p>The prize is yours, and your savings are still right where you left them.</p>
              <div className="draw-prize display">{money(d.prize)}</div>
            </>
          ) : (
            <>
              <p className="draw-who">{winner?.name} won this week's {money(d.prize)}</p>
              <h1>Not this week.</h1>
              <p>Your savings are all still here, and your streak keeps growing.</p>
            </>
          )}
          <a className="btn btn-kernel" href="#app-room">Back to the room</a>
          <button type="button" className="draw-proof" onClick={() => setReceipt(true)}>See the receipt</button>
          <ReceiptSheet open={receipt} onClose={() => setReceipt(false)}><DrawReceipt s={s} /></ReceiptSheet>
        </div>
      )}
      <p className="draw-fine">Nothing is paid to enter. The prize comes from interest and sponsors, never from anyone's savings.</p>
    </div>
  );
}

/** A one-time burst of kernels for the winner (never for anyone else, never under calm or reduced motion). */
function KernelBurst() {
  const seeds = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2 + (i % 2) * 0.2;
    const r = 120 + (i % 4) * 34;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.8 - 40, rot: (i * 47) % 360, d: (i % 5) * 40 };
  });
  return (
    <div className="burst" aria-hidden="true">
      {seeds.map((k, i) => (
        <svg key={i} viewBox="0 0 24 24" style={{ '--x': `${k.x}px`, '--y': `${k.y}px`, '--r': `${k.rot}deg`, animationDelay: `${k.d}ms` } as React.CSSProperties}>
          <path d="M16.5 3.2c-5.2 1.1-9.3 4.9-9.6 9.6-.2 3.6 2.2 6.8 5.6 7.6 1.4.3 2.5-.6 2.5-1.8 0-1-.7-1.6-1.6-1.9-1.6-.5-2.7-2-2.6-3.7.2-2.8 2.6-5.1 5.8-5.9 1.3-.3 2-1.3 1.8-2.4-.2-1.2-1.1-1.8-1.9-1.5z" />
        </svg>
      ))}
    </div>
  );
}
