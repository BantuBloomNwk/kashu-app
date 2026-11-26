import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type Burst = { n: number; text: string; x: number; y: number; knock?: boolean };
/**
 * A cheer, in 3D: real rendered kernels thrown up out of the window that was tapped, each on its own arc and spin,
 * falling back under their own weight, with a word that rises from the same window. A knock rattles the shutters
 * instead. Origin is the window's centre (or the screen's, for cheers you received).
 */
export function CheerBurst({ burst }: { burst: Burst }) {
  const [shown, setShown] = useState<Burst | null>(null);
  useEffect(() => {
    if (!burst.n) return;
    setShown(burst);
    try { navigator.vibrate?.(burst.knock ? [10, 60, 10] : [14, 30, 22]); } catch { /* fine */ }
    const t = setTimeout(() => setShown(null), 1500);
    return () => clearTimeout(t);
  }, [burst.n]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown || shown.knock) return null;
  const kernels = Array.from({ length: 16 }, (_, i) => {
    const a = (-90 + (Math.random() - 0.5) * 150) * (Math.PI / 180), v = 120 + Math.random() * 130;
    return { i, dx: Math.cos(a) * v, dy: Math.sin(a) * v, rz: (Math.random() - 0.5) * 900, ry: (Math.random() - 0.5) * 540, s: 0.55 + Math.random() * 0.55, d: Math.random() * 90, img: i % 2 ? 'kernel-a' : 'kernel-b' };
  });
  return createPortal(
    <div className="cheer3d" key={shown.n} role="status" aria-live="polite" style={{ ['--x' as string]: `${shown.x}px`, ['--y' as string]: `${shown.y}px` }}>
      {kernels.map((k) => (
        <img key={k.i} className="cheer-kernel" src={`objects/${k.img}.webp`} alt="" draggable={false}
          style={{ ['--dx' as string]: `${k.dx}px`, ['--dy' as string]: `${k.dy}px`, ['--rz' as string]: `${k.rz}deg`, ['--ry' as string]: `${k.ry}deg`, ['--s' as string]: k.s, animationDelay: `${k.d}ms` }} />
      ))}
      <span className="cheer-pill"><img src="objects/kernel-a.webp" alt="" />{shown.text}</span>
    </div>, document.body);
}

/** Where a friend's window is on screen (centre), for a burst to come out of it. */
export function windowCentre(id: string) {
  const el = document.querySelector(`[data-friend="${CSS.escape(id)}"]`);
  if (!el) return { x: innerWidth / 2, y: innerHeight / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height * 0.4 };
}
/** Rattles a friend's shutters (a knock). */
export function knock(id: string) {
  const el = document.querySelector(`[data-friend="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.remove('knocking'); void (el as HTMLElement).offsetWidth; el.classList.add('knocking');
  setTimeout(() => el.classList.remove('knocking'), 700);
}

const KEY = (room: string) => `kashu.cheers.${room}`;
/** Cheers this member got since the app last showed them (counts live on chain; what was shown lives on this phone). */
export function newCheers(room: string, total: number) {
  let seen = 0;
  try { seen = Number(localStorage.getItem(KEY(room)) ?? -1); } catch { return 0; }
  try { localStorage.setItem(KEY(room), String(total)); } catch { /* fine */ }
  return seen < 0 ? 0 : Math.max(0, total - seen); // the first visit only remembers, so old cheers don't burst at once
}
