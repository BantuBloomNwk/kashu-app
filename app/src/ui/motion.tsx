// Motion helpers for the landing and the app. Every one of them starts on being seen, stops off screen,
// and settles at once under reduced motion. Only transform and opacity move.
import { useEffect, useRef, useState, type ReactNode, type ElementType } from 'react';
import './motion.css';

export const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** true once the element has been on screen (or while it is, with once=false). */
export function useInView<T extends Element>(once = true, margin = '0px 0px -12% 0px') {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setSeen(true); if (once) io.disconnect(); } else if (!once) setSeen(false);
    }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [once, margin]);
  return [ref, seen] as const;
}

/** Children rise in once, staggered 80ms in groups of three (the reference site's rhythm). */
export function Reveal({ as: Tag = 'div', className = '', children, i = 0 }: { as?: ElementType; className?: string; children: ReactNode; i?: number }) {
  const [ref, seen] = useInView<HTMLElement>();
  return <Tag ref={ref} className={`rv ${seen ? 'in' : ''} ${className}`} style={{ ['--i' as string]: i % 3 }}>{children}</Tag>;
}

/** A highlighter bar sweeps in behind the one word that matters. */
export function Sweep({ children, tone = 'kernel' }: { children: ReactNode; tone?: 'kernel' | 'leaf' }) {
  const [ref, seen] = useInView<HTMLElement>(true, '0px 0px -25% 0px');
  return <mark ref={ref} className={`sweep sweep-${tone} ${seen ? 'in' : ''}`}>{children}</mark>;
}

/** Digits roll into place like an odometer. The text is the real value; the rolling copy is decoration. */
export function Odometer({ value, className = '', run }: { value: string; className?: string; run?: boolean }) {
  const [ref, seen] = useInView<HTMLSpanElement>(true, '0px');
  const on = run ?? seen;
  return (
    <span ref={ref} className={`odo ${on ? 'in' : ''} ${className}`}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true" className="odo-row">
        {[...value].map((ch, i) => /\d/.test(ch)
          ? <span key={i} className="odo-col"><span className="odo-reel" style={{ ['--d' as string]: ch, ['--k' as string]: i }}>{'0123456789'.split('').map((d) => <span key={d}>{d}</span>)}</span></span>
          : <span key={i} className="odo-ch">{ch}</span>)}
      </span>
    </span>
  );
}

/** Scroll progress through an element, 0 as its top meets the viewport top, 1 as its bottom does. */
export function useScrollProgress<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0; const el = ref.current; if (!el) return;
      const r = el.getBoundingClientRect(); const span = r.height - innerHeight;
      setP(span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : r.top < 0 ? 1 : 0);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(read); };
    read(); addEventListener('scroll', on, { passive: true }); addEventListener('resize', on);
    return () => { removeEventListener('scroll', on); removeEventListener('resize', on); cancelAnimationFrame(raf); };
  }, []);
  return [ref, p] as const;
}

/** The element leans toward the pointer (fine pointers only) and eases back when it leaves. The lean is
 * eased every frame (no jumps), small (a few degrees), and centred, so the card never looks lopsided. */
export function useTilt<T extends HTMLElement>(max = 3) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current; if (!el || reduceMotion() || matchMedia('(hover: none)').matches) return;
    let raf = 0, tx = 0, ty = 0, x = 0, y = 0;
    const paint = () => {
      x += (tx - x) * 0.12; y += (ty - y) * 0.12;
      el.style.setProperty('--rx', `${(-y * max).toFixed(3)}deg`); el.style.setProperty('--ry', `${(x * max).toFixed(3)}deg`);
      el.style.setProperty('--gx', `${((x + 0.5) * 100).toFixed(1)}%`); el.style.setProperty('--gy', `${((y + 0.5) * 100).toFixed(1)}%`);
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.001 ? requestAnimationFrame(paint) : 0;
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(paint); };
    const move = (e: PointerEvent) => { const r = el.getBoundingClientRect(); tx = (e.clientX - r.left) / r.width - 0.5; ty = (e.clientY - r.top) / r.height - 0.5; kick(); };
    const leave = () => { tx = 0; ty = 0; kick(); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerleave', leave);
    return () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave); cancelAnimationFrame(raf); };
  }, [max]);
  return ref;
}

/** Scroll progress through an element (0 at its top, 1 at its bottom), written straight to a CSS variable
 * and eased toward the real position every frame. No React render per scroll event, it only runs while
 * the element is near the screen, and it measures against the layout viewport, which does not change
 * size when a phone's address bar slides away (that resize is what made scroll scenes jitter). */
export function useScrollVar<T extends HTMLElement>(name: string, onProgress?: (p: number) => void) {
  const ref = useRef<T | null>(null);
  const cb = useRef(onProgress); cb.current = onProgress;
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let cur = -1, raf = 0, near = true;
    const vh = () => document.documentElement.clientHeight || innerHeight;
    const target = () => {
      const r = el.getBoundingClientRect(); const span = r.height - vh();
      return span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : r.top < 0 ? 1 : 0;
    };
    const tick = () => {
      raf = 0; const t = target();
      cur = cur < 0 || reduceMotion() ? t : cur + (t - cur) * 0.18;
      if (Math.abs(t - cur) < 0.0004) cur = t;
      el.style.setProperty(name, cur.toFixed(4)); cb.current?.(cur);
      if (near && cur !== t) raf = requestAnimationFrame(tick);
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
    const io = new IntersectionObserver(([e]) => { near = e.isIntersecting; if (near) kick(); }, { rootMargin: '25% 0px' });
    io.observe(el); addEventListener('scroll', kick, { passive: true }); addEventListener('resize', kick); kick();
    return () => { io.disconnect(); removeEventListener('scroll', kick); removeEventListener('resize', kick); cancelAnimationFrame(raf); };
  }, [name]);
  return ref;
}

/** A split-flap board: each cell shuffles, then settles on its letter, left to right. */
export function SplitFlap({ word, className = '' }: { word: string; className?: string }) {
  const [ref, seen] = useInView<HTMLSpanElement>(true, '0px 0px -20% 0px');
  const [shown, setShown] = useState(() => (reduceMotion() ? word : word.replace(/\S/g, ' ')));
  useEffect(() => {
    if (!seen || reduceMotion()) { if (reduceMotion()) setShown(word); return; }
    const pool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => {
      const k = (t - t0) / 1400;
      setShown([...word].map((ch, i) => (ch === ' ' || k > 0.25 + i * 0.1 ? ch : pool[(Math.random() * 26) | 0])).join(''));
      if (k < 0.3 + word.length * 0.1) raf = requestAnimationFrame(step); else setShown(word);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [seen, word]);
  return (
    <span ref={ref} className={`flap ${className}`} aria-label={word}>
      {[...shown].map((ch, i) => <span key={i} aria-hidden="true" className="flap-cell"><span key={ch} className="flap-ch">{ch}</span></span>)}
    </span>
  );
}
