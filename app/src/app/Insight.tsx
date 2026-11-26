import { useEffect, useState } from 'react';
import { money } from '../ui/money.ts';
import { RELAY } from '../wallet/wallet.ts';
import { useStore } from './store.ts';

type Item = { kind: 'saved' | 'saved-private' | 'roundup' | 'sent' | 'received' | 'took-out' | 'from-pocket' | 'fee'; amount: number; at: number; agent?: boolean; to?: string | null };
const WEEK = 7 * 86400_000;
const sum = (xs: Item[]) => xs.reduce((a, x) => a + x.amount, 0);

/** This week in your money, in plain words, from your own history on Solana, and the last four weeks of saving. */
export function Insight() {
  const s = useStore();
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    if (!s.live?.wallet) return;
    fetch(`${RELAY}/history?wallet=${s.live.wallet}`).then((r) => r.json()).then((j) => setItems(j.items ?? []), () => setItems([]));
  }, [s.live?.wallet]);
  if (!s.live || !items) return null;
  const now = Date.now();
  const inWeek = (w: number) => items.filter((x) => x.at > now - (w + 1) * WEEK && x.at <= now - w * WEEK);
  const wk = inWeek(0);
  const saved = sum(wk.filter((x) => x.kind === 'saved' || x.kind === 'saved-private' || x.kind === 'roundup'));
  const round = wk.filter((x) => x.kind === 'roundup');
  const sent = wk.filter((x) => x.kind === 'sent'), got = wk.filter((x) => x.kind === 'received');
  const people = new Set(sent.map((x) => x.to)).size;
  const byAgent = wk.filter((x) => x.agent && x.kind !== 'fee' && x.kind !== 'received').length;
  const weeks = [3, 2, 1, 0].map((w) => sum(inWeek(w).filter((x) => x.kind === 'saved' || x.kind === 'saved-private' || x.kind === 'roundup')));
  const top = Math.max(0.01, ...weeks);
  const lines = [
    saved > 0 ? `You put away ${money(saved)}${round.length ? `, ${money(sum(round))} of it change from ${round.length} round-up${round.length === 1 ? '' : 's'}` : ''}.` : 'Nothing saved yet this week.',
    sent.length ? `You sent ${money(sum(sent))} to ${people} ${people === 1 ? 'person' : 'people'}.` : null,
    got.length ? `${money(sum(got))} came in from friends.` : null,
    byAgent ? `Your agent did ${byAgent} chore${byAgent === 1 ? '' : 's'} for you.` : null,
    s.interest > 0 ? `Your savings have earned ${s.interest < 0.01 ? `$${s.interest.toFixed(4)}` : money(s.interest)} in interest so far.` : null,
  ].filter(Boolean) as string[];
  return (
    <section className="insight" aria-labelledby="ins-h">
      <h2 id="ins-h">This week</h2>
      <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
      <div className="ins-weeks" role="img" aria-label={`Saved over the last four weeks: ${weeks.map((w) => money(w)).join(', ')}`}>
        {weeks.map((w, i) => (
          <div key={i} className={i === 3 ? 'now' : ''}><span style={{ height: `${Math.max(4, (w / top) * 100)}%` }} /><small>{i === 3 ? 'This week' : `${3 - i} wk ago`}</small></div>
        ))}
      </div>
    </section>
  );
}
