import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from './store.ts';

const key = (room: string, week: number) => `kashu.won.${room}.${week}`;
const seen = (k: string) => { try { return !!localStorage.getItem(k); } catch { return true; } };

/** The moment you win: once per win, over whatever screen is open. */
export function WonMoment() {
  const s = useStore();
  const d = s.live?.draw, room = s.live?.room;
  const mine = !!(d && room && d.winner === s.live?.wallet);
  const [show, setShow] = useState(false);
  useEffect(() => { if (mine && d && room && !seen(key(room, d.week))) setShow(true); }, [mine, d?.week, room]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!show || !d || !room) return null;
  const close = () => { try { localStorage.setItem(key(room, d.week), '1'); } catch { /* fine */ } setShow(false); };
  return createPortal(
    <div className="won" role="dialog" aria-modal="true" aria-labelledby="won-h">
      <div className="won-card">
        <div className="won-burst" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <span key={i} style={{ ['--i' as string]: i }} />)}</div>
        <p className="won-kicker">Week {d.week} draw</p>
        <h2 id="won-h" className="display">You won!</h2>
        <p>This week's prize is in your vault now, as your own savings. Your friends' savings weren't touched: the prize came from interest.</p>
        <div className="won-actions">
          <a className="btn btn-ghost" href="#app-savings" onClick={close}>See my savings</a>
          <button className="btn btn-primary" onClick={close}>Nice</button>
        </div>
      </div>
    </div>, document.body);
}

/** In the room: who won the last draw. */
export function LastWinner() {
  const s = useStore();
  const d = s.live?.draw;
  if (!d || !s.live) return null;
  const you = d.winner === s.live.wallet;
  const name = you ? 'You' : s.friends.find((f) => f.id === d.winner)?.name ?? 'A friend';
  return <p className="last-winner"><span aria-hidden="true" className="last-moon" />{name} won week {d.week}'s draw{you ? '. It\'s in your savings.' : '.'}</p>;
}
