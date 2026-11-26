import { plain } from './plain.ts';
import { useEffect, useState } from 'react';
import { useStore } from './store.ts';
import { setPlan } from './live.ts';
import { PlanBar } from './Me.tsx';


type Move = { owner: string; name: string; from: number; to: number; at: number };
const KEY = (room: string) => `kashu.moves.${room}`;
const words = (pct: number) => (pct ? `${pct}% SOL` : 'all dollars');
const ago = (at: number) => { const m = Math.round((Date.now() - at) / 60_000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

/**
 * Plan moves in this room, newest first. Plans are public on Solana as a percent, so this phone remembers the
 * last split it saw for each friend and notes a move when one changes. It only knows what it has seen.
 */
export function useMoves(): Move[] {
  const l = useStore().live;
  const room = l?.room, members = l?.members ?? [];
  const sig = members.map((m) => `${m.owner}:${m.plan}`).join(',');
  const [moves, setMoves] = useState<Move[]>([]);
  useEffect(() => {
    if (!room) return;
    let saved: { seen: Record<string, number>; moves: Move[] } = { seen: {}, moves: [] };
    try { saved = JSON.parse(localStorage.getItem(KEY(room)) || '') ?? saved; } catch { /* first look */ }
    const first = Object.keys(saved.seen).length === 0;
    for (const m of members) {
      if (m.you || m.plan == null) continue;
      const was = saved.seen[m.owner];
      if (!first && was !== undefined && was !== m.plan) saved.moves.unshift({ owner: m.owner, name: m.name, from: was, to: m.plan, at: Date.now() });
      saved.seen[m.owner] = m.plan;
    }
    saved.moves = saved.moves.slice(0, 12);
    try { localStorage.setItem(KEY(room), JSON.stringify(saved)); } catch { /* private mode */ }
    setMoves(saved.moves);
  }, [room, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return moves;
}
export const moveLine = (m: Move) => `${m.name} moved to ${words(m.to)}`;

/** Plans in this room: how each friend splits their weekly save, in percent only. Copy one in a tap. */
export function Plans() {
  const s = useStore();
  const [msg, setMsg] = useState<string | null>(null);
  const moves = useMoves();
  const copy = async (pct: number, name: string) => { setMsg('One moment…'); try { await setPlan(pct); setMsg(`You're on ${name}'s plan now.`); } catch (e) { setMsg(plain(e)); } };
  const l = s.live;
  if (!l) return null;
  const mine = l.assetPct ?? 0;
  return (
    <div className="plans">
      {moves.length > 0 && (
        <ol className="moves" aria-label="Recent plan moves">
          {moves.slice(0, 5).map((m) => (
            <li key={`${m.owner}${m.at}`}>
              <span><b>{m.name}</b> moved from {words(m.from)} to {words(m.to)}<small>{ago(m.at)}</small></span>
              {m.to !== mine && <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(m.to, m.name)}>Copy</button>}
            </li>
          ))}
        </ol>
      )}
      <p className="hint">How everyone splits their save. Percent only, never amounts.</p>
      <ul>
        {l.members.map((m) => (
          <li key={m.owner}>
            <span className="plans-name">{m.you ? 'You' : m.name}</span>
            {m.plan == null ? <span className="hint">not shared</span> : <>
              <PlanBar pct={m.plan} />
              <span className="plans-pct">{m.plan ? `${100 - m.plan}% $ · ${m.plan}% SOL` : 'All dollars'}</span>
              {!m.you && m.plan !== mine && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(m.plan!, m.name)}>Copy</button>
              )}
            </>}
          </li>
        ))}
      </ul>
      {msg && <p className="hint" role="status">{msg}</p>}
    </div>
  );
}
