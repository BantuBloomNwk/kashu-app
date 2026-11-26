import { MAINNET } from '../config.ts';
import { plain } from './plain.ts';
import { useEffect, useState } from 'react';
import { CheerBurst, knock, newCheers, windowCentre } from './Cheer.tsx';
import { Odometer } from '../ui/motion.tsx';
import { Moon } from '../ui/Mark.tsx';
import { AVATAR_BASE, KernelRow, Wall } from '../ui/Wall.tsx';
import { Proof } from './Proof.tsx';
import { LastWinner } from './Won.tsx';
import { Plans, useMoves, moveLine } from './Plans.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { RELAY } from '../wallet/wallet.ts';
import { PRIZE, money } from '../ui/money.ts';
import { me, useStore } from './store.ts';
import { addPhone, cheerFriend, nameFriend, roomPreview } from './live.ts';

/** A private room this phone can't read yet: one approval asks for it; Kashu's keeper adds it within a minute. */
/** A private room this phone can't read yet: its wall, every shutter closed (how many live there is public). */
function ClosedWall() {
  const s = useStore();
  const [n, setN] = useState(4);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => { if (s.live?.room) roomPreview(s.live.room).then((p) => { if (p) { setN(Math.max(1, Math.min(12, p.members))); setName(p.name); } }, () => {}); }, [s.live?.room]);
  const pats = ['louvre', 'panel', 'lattice', 'grid'] as const;
  const shut = Array.from({ length: n }, (_, i) => ({ id: `shut-${i}`, name: '', lit: false, streak: 0, pattern: pats[i % 4] }));
  return (
    <div className="closed-wall">
      {name && <p className="room-count"><b>{name}</b> · {n} {n === 1 ? 'saver' : 'savers'}</p>}
      <Wall friends={shut} size="md" cols={Math.min(3, n)} className={n < 3 ? 'wall-few' : ''} />
    </div>
  );
}

function AddPhone() {
  const [state, setState] = useState<'idle' | 'busy' | 'asked' | string>('idle');
  return (
    <div className="add-phone">
      <p><b>This phone can't see your private room yet.</b> Your savings are safe. Only one phone at a time can see the room; using this one moves the view here.</p>
      {state === 'asked' ? <p>Asked. It usually opens within a minute.</p> : (
        <button className="btn btn-primary btn-sm" disabled={state === 'busy'} onClick={async () => {
          setState('busy');
          try { setState((await addPhone()) ? 'asked' : 'idle'); } catch (e) { setState(plain(e)); }
        }}>{state === 'busy' ? 'Opening Face ID…' : 'Use this phone'}</button>
      )}
      {state !== 'idle' && state !== 'busy' && state !== 'asked' && <p className="review-error">{state}</p>}
    </div>
  );
}

// Home: who has saved this payday. The wall is the screen; amounts never appear.
export function Room() {
  const s = useStore();
  const moves = useMoves();
  const you = me(s);
  const saved = s.friends.filter((f) => f.lit).length;
  const chances = you.lit ? Math.min(4, you.streak) : 0;
  // tap a friend's window: a lit one gets a cheer, a dark one a gentle nudge (the rooms program's `cheer`)
  const [pop, setPop] = useState<{ id: string; n: number; text: string } | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'proof' | 'plans' | null>(null);
  const [about, setAbout] = useState<string | null>(null);
  const [reported, setReported] = useState<string | null>(null);
  const [burst, setBurst] = useState<{ n: number; text: string; x: number; y: number; knock?: boolean }>({ n: 0, text: '', x: 0, y: 0 });
  const [note, setNote] = useState<string | null>(null);
  // development only: lets the visual tests fire a cheer or a knock on a window (stripped from production builds)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __kashuCheer?: (id: string, k?: boolean) => void }).__kashuCheer = (id, k) => { if (k) knock(id); setBurst((b) => ({ n: b.n + 1, text: k ? '' : 'Cheered Ada', knock: !!k, ...windowCentre(id) })); };
  }, []);
  // cheers this saver got since they last looked: one burst for the lot
  useEffect(() => {
    if (!s.live?.room) return;
    const got = newCheers(s.live.room, you.cheers ?? 0);
    if (got > 0) { const c = windowCentre('you'); setBurst((b) => ({ n: b.n + 1, text: got === 1 ? 'Your room cheered you' : `${got} cheers from your room`, ...c })); }
  }, [s.live?.room, you.cheers]); // eslint-disable-line react-hooks/exhaustive-deps
  const press = (id: string) => {
    const f = s.friends.find((x) => x.id === id); if (!f) return;
    if (f.you) { if (!f.lit) location.hash = '#app-save'; return; }
    // live: a friend without a Kashutag gets a name on this phone first; everyone else gets a real cheer
    if (s.live) {
      if (/^Friend \d+$/.test(f.name)) { setNaming(id); return; }
      // the moment happens on the tap (a lit window gets kernels, a dark one a knock on its shutters); the network catches up
      if (f.lit) setBurst((b) => ({ n: b.n + 1, text: `Cheered ${f.name}`, ...windowCentre(id) }));
      else { knock(id); setBurst((b) => ({ n: b.n + 1, text: '', knock: true, ...windowCentre(id) })); }
      setNote(null);
      cheerFriend(id, s.live.week).then(
        () => setNote(f.lit ? `${f.name} will see your cheer on their window.` : `You knocked on ${f.name}'s window. They'll see it.`),
        (e) => setNote(plain(e)));
      return;
    }
    setPop((p) => ({ id, n: (p?.n ?? 0) + 1, text: f.lit ? `You cheered ${f.name}.` : `You nudged ${f.name}. They'll see a little knock on their window.` }));
    try { navigator.vibrate?.(12); } catch { /* fine */ }
  };
  if (s.live?.needsPhone) return <div className="room"><ClosedWall /><AddPhone /></div>;
  return (
    <div className="room">
      <div className="room-head">
        <p className="room-count"><b><Odometer value={String(saved)} /> of {s.friends.length}</b> have saved this payday</p>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => {
          const url = s.live?.room ? `${location.origin}${location.pathname}#app-join-${s.live.room}` : location.origin;
          if (navigator.share) navigator.share({ title: 'Join my Kashu room', text: `Save with me in ${s.roomName}.`, url }).catch(() => {});
          else navigator.clipboard?.writeText(url).then(() => setPop({ id: 'you', n: Date.now(), text: 'Invite link copied.' }), () => {});
        }}>Invite</button>
      </div>
      {s.live?.needsPhone && <AddPhone />}
      {s.live && !s.live.tag && !s.live.needsPhone && (
        <a className="tag-nudge" href="#app-me"><b>Pick your Kashutag</b><span>So friends can send you money, and see you by name in the room</span></a>
      )}
      {s.live?.private && <p className="room-private"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" fill="none" strokeWidth="2.2" /></svg>Private room: only your friends' phones can see it</p>}
      <Wall friends={s.friends} size="md" onPress={press} onHold={s.live ? (id) => setAbout(id) : undefined} pop={pop ?? undefined} />
      <CheerBurst burst={burst} />
      {note && <p className="cheer-note" role="status" key={note}>{note}</p>}
      <LastWinner />
      {s.live?.room && (
        <div className="room-tiles">
          <button type="button" className="room-tile" onClick={() => setSheet('proof')}>
            <img src="objects/vault-body.webp" alt="" width={44} height={44} />
            <span><b>Behind the scenes</b><small>Every step, with its receipt</small></span>
          </button>
          <button type="button" className="room-tile" onClick={() => setSheet('plans')}>
            <img src="objects/jar-cut.webp" alt="" width={44} height={44} />
            <span><b>Plans in this room</b><small>{moves[0] ? moveLine(moves[0]) : 'How friends split their save'}</small></span>
          </button>
        </div>
      )}
      <Sheet open={sheet === 'proof'} onClose={() => setSheet(null)} kicker="MagicBlock + Solana" title="Behind the scenes">{s.live?.room && <Proof room={s.live.room} />}</Sheet>
      {(() => {
        const f = s.friends.find((x) => x.id === about);
        return (
          <Sheet open={!!f} onClose={() => { setAbout(null); setReported(null); }} kicker="In your room" title={f?.name ?? ''}>
            {f && (
              <div className="about">
                {f.avatar ? <img className="about-photo" src={`${AVATAR_BASE}/${f.avatar}.webp`} alt="" /> : null}
                <p>{f.lit ? `Saved this payday${f.streak > 1 ? `, ${f.streak} weeks in a row` : ''}.` : 'Hasn\'t saved yet this payday.'}{f.cheers ? ` ${f.cheers} cheers so far.` : ''}</p>
                {f.avatar && (reported === f.avatar ? <p className="hint" role="status">Thanks. Kashu will look at this photo.</p> : (
                  <div className="report">
                    <b>Report this photo</b>
                    <div className="report-reasons">
                      {([['nudity', 'Nudity'], ['violence', 'Violence'], ['hate', 'Hate'], ['impersonation', 'Pretending to be someone'], ['other', 'Something else']] as const).map(([k, l]) => (
                        <button key={k} type="button" className="chip" onClick={() => fetch(`${RELAY}/report-photo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: f.avatar, reason: k }) }).then(() => setReported(f.avatar!), () => setReported(f.avatar!))}>{l}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Sheet>
        );
      })()}
      <Sheet open={sheet === 'plans'} onClose={() => setSheet(null)} kicker="Percent only" title="Plans in this room"><Plans /></Sheet>
      {naming && (
        <form className="name-friend" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get('n'); if (v) nameFriend(naming, String(v)); setNaming(null); }}>
          <label className="field"><span>What do you call this friend? Only you see this.</span><input name="n" maxLength={24} autoFocus defaultValue={s.friends.find((f) => f.id === naming)?.name} /></label>
          <button className="btn btn-primary btn-sm">Save name</button>
        </form>
      )}
      <p className="cheer-line" aria-live="polite">{pop ? <span key={pop.n}>{pop.text}</span> : <span className="hint">{s.live && s.friends.some((f) => !f.you && /^Friend \d+$/.test(f.name)) ? 'Tap a friend\'s window to give them a name.' : s.friends.length > 1 ? 'Tap a friend\'s window to cheer them on.' : 'Invite your people: their windows go up next to yours.'}</span>}</p>
      <div className="streak-card">
        <div>
          <span className="streak-n display"><Odometer value={String(you.streak)} /></span>
          <span className="streak-l">week{you.streak === 1 ? '' : 's'} in a row</span>
          {s.live && !MAINNET && <small className="hint">Test network: a week here is 10 minutes</small>}
        </div>
        <KernelRow filled={Math.min(8, you.streak)} total={8} />
        <span className="chances">{chances ? `${chances} chance${chances > 1 ? 's' : ''} on Friday` : 'Save this week to get chances'}</span>
      </div>
      <a className="draw-card" href="#app-draw">
        <Moon size={52} glow={false} />
        <span>
          <span className="draw-when">Draw night · Friday 8pm</span>
          <span className="draw-pot display">Prize so far <Odometer value={money(s.live ? s.live.pot : PRIZE)} /></span>
        </span>
        <svg viewBox="0 0 24 24" className="chev" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" strokeWidth="2.6" strokeLinecap="round" /></svg>
      </a>
      {you.lit
        ? <p className="room-done">Saved. Still yours, any time.</p>
        : <a className="btn btn-primary room-cta" href="#app-save">Save this week</a>}
    </div>
  );
}
