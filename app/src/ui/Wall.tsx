import { useRef } from 'react';
import './wall.css';

export type Pattern = 'louvre' | 'panel' | 'lattice' | 'grid';
export type Friend = { id: string; name: string; lit: boolean; streak: number; you?: boolean; pattern: Pattern; glow?: boolean; cheers?: number; avatar?: string | null };
/** Where profile photos are served (by their hash). */
export const AVATAR_BASE = `${(import.meta.env.VITE_RELAY as string | undefined) ?? 'https://kashu-relay.161-97-74-212.sslip.io'}/avatar`;

/** One friend's window. Lit = saved this payday: the shutters swing open on their hinges and the
 * light is on. You see the light, never the amount inside. */
export function Window({ f, size = 'md', onPress, onHold, highlight, pop }: { f: Friend; size?: 'sm' | 'md' | 'lg'; onPress?: () => void; onHold?: () => void; highlight?: boolean; pop?: number }) {
  // press and hold (about half a second) opens more about this friend; a hold never also counts as a tap
  const hold = useRef<{ t: ReturnType<typeof setTimeout> | null; fired: boolean }>({ t: null, fired: false });
  const down = () => { if (!onHold) return; hold.current.fired = false; hold.current.t = setTimeout(() => { hold.current.fired = true; try { navigator.vibrate?.(10); } catch { /* fine */ } onHold(); }, 520); };
  const up = () => { if (hold.current.t) clearTimeout(hold.current.t); hold.current.t = null; };
  const label = `${f.you ? 'You' : f.name}: ${f.lit ? 'saved this payday' : 'not yet'}${f.streak ? `, ${f.streak} weeks in a row` : ''}`;
  const Tag = onPress ? 'button' : 'div';
  return (
    <Tag className={`win win-${size} ${f.lit ? 'is-lit' : ''} ${f.you ? 'is-you' : ''} ${highlight ? 'is-hi' : ''} ${f.glow ? 'is-glow' : ''}`}
      onClick={() => { if (hold.current.fired) { hold.current.fired = false; return; } onPress?.(); }} onPointerDown={down} onPointerUp={up} onPointerLeave={up} onPointerCancel={up}
      onContextMenu={onHold ? (e) => e.preventDefault() : undefined} aria-label={label} data-friend={f.id} {...(onPress ? { type: 'button' as const, 'aria-pressed': f.lit } : { role: 'img' })}>
      <span className="win-frame">
        <img className="wf wf-dark" src="windows/frame-dark.webp" alt="" draggable={false} />
        <img className="wf wf-lit" src="windows/frame-lit.webp" alt="" draggable={false} />
        <img className="ws ws-l" src={`windows/shutter-${f.pattern}-l.webp`} alt="" draggable={false} />
        <img className="ws ws-r" src={`windows/shutter-${f.pattern}-r.webp`} alt="" draggable={false} />
      </span>
      {pop ? <span key={pop} className="win-pop" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <svg key={i} viewBox="0 0 24 24" style={{ ['--a' as string]: `${-70 + i * 35}deg` }}><path d="M16.5 3.2c-5.2 1.1-9.3 4.9-9.6 9.6-.2 3.6 2.2 6.8 5.6 7.6 1.4.3 2.5-.6 2.5-1.8 0-1-.7-1.6-1.6-1.9-1.6-.5-2.7-2-2.6-3.7.2-2.8 2.6-5.1 5.8-5.9 1.3-.3 2-1.3 1.8-2.4-.2-1.2-1.1-1.8-1.9-1.5z" /></svg>)}</span> : null}
      {size !== 'sm' && (
        <span className="win-meta">
          <span className="win-name">{f.avatar && <img className="win-face" src={`${AVATAR_BASE}/${f.avatar}.webp`} alt="" loading="lazy" />}{f.you ? 'You' : f.name}</span>
          <span className="win-state">{f.lit ? (f.streak > 1 ? `${f.streak} in a row` : 'Saved') : 'Not yet'}</span>
          {!!f.cheers && <span className="win-cheers" aria-label={`${f.cheers} cheers`}>{f.cheers} {f.cheers === 1 ? 'cheer' : 'cheers'}</span>}
        </span>
      )}
    </Tag>
  );
}

export function Wall({ friends, size = 'md', cols = 3, onPress, onHold, highlightId, className = '', pop }: {
  friends: Friend[]; size?: 'sm' | 'md' | 'lg'; cols?: number; onPress?: (id: string) => void; onHold?: (id: string) => void; highlightId?: string; className?: string; pop?: { id: string; n: number };
}) {
  return (
    <div className={`wall ${className}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {friends.map((f) => <Window key={f.id} f={f} size={size} highlight={highlightId === f.id} pop={pop?.id === f.id ? pop.n : 0} onPress={onPress ? () => onPress(f.id) : undefined} onHold={onHold && !f.you ? () => onHold(f.id) : undefined} />)}
    </div>
  );
}

/** The streak as a row of kernels filling in week by week. */
export function KernelRow({ filled, total = 8, label }: { filled: number; total?: number; label?: string }) {
  return (
    <span className="krow" role="img" aria-label={label ?? `${filled} weeks in a row`}>
      {Array.from({ length: total }, (_, i) => (
        <svg key={i} viewBox="0 0 24 24" className={`kseed ${i < filled ? 'on' : ''}`} style={{ animationDelay: `${i * 45}ms` }}>
          <path d="M16.5 3.2c-5.2 1.1-9.3 4.9-9.6 9.6-.2 3.6 2.2 6.8 5.6 7.6 1.4.3 2.5-.6 2.5-1.8 0-1-.7-1.6-1.6-1.9-1.6-.5-2.7-2-2.6-3.7.2-2.8 2.6-5.1 5.8-5.9 1.3-.3 2-1.3 1.8-2.4-.2-1.2-1.1-1.8-1.9-1.5z" />
        </svg>
      ))}
    </span>
  );
}
