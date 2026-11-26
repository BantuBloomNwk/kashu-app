import { plain } from './plain.ts';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { money } from '../ui/money.ts';
import { Odometer } from '../ui/motion.tsx';
import { actions, me, useStore } from './store.ts';
import { setWinningsBuy, withdraw as withdrawLive } from './live.ts';
import { Insight } from './Insight.tsx';
import { MAINNET } from '../config.ts';

/** The balance sits behind a curtain; hold to show it (people check this on buses). */
function Curtain({ children, onToggle }: { children: (open: boolean) => React.ReactNode; onToggle?: (open: boolean) => void }) {
  const [open, setOpenRaw] = useState(false);
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => setOpenRaw((o) => { const n = typeof v === 'function' ? v(o) : v; if (n !== o) { onToggle?.(n); if (n) try { navigator.vibrate?.(8); } catch { /* fine */ } } return n; });
  return (
    <button type="button" className={`curtain ${open ? 'open' : ''}`} aria-pressed={open} aria-label={open ? 'Balance shown. Release to hide.' : 'Hold to show your balance'}
      onPointerDown={() => setOpen(true)} onPointerUp={() => setOpen(false)} onPointerLeave={() => setOpen(false)} onPointerCancel={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpen((o) => !o); }}>
      <span className="curtain-value">{children(open)}</span>
      <span className="curtain-cloth" aria-hidden="true"><span>Hold to show</span></span>
    </button>
  );
}

/** Withdraw: a sheet from the bottom that tracks the thumb 1:1 and can be thrown away. */
function WithdrawSheet() {
  const s = useStore();
  const [amount, setAmount] = useState(s.balance);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; t0: number; dy: number } | null>(null);
  const close = () => { location.hash = '#app-savings'; };
  useEffect(() => { const el = sheet.current; if (el) { el.style.transform = 'translateY(100%)'; requestAnimationFrame(() => { el.style.transition = 'transform 420ms var(--ease-drawer)'; el.style.transform = 'translateY(0)'; }); } }, []);
  const down = (e: React.PointerEvent) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { y0: e.clientY, t0: performance.now(), dy: 0 }; if (sheet.current) sheet.current.style.transition = 'none'; };
  const move = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || !sheet.current) return;
    let dy = e.clientY - d.y0;
    if (dy < 0) dy *= 0.2; // rubber-band upward
    d.dy = dy; sheet.current.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    const d = drag.current; drag.current = null; const el = sheet.current; if (!d || !el) return;
    const v = d.dy / Math.max(1, performance.now() - d.t0);
    if (d.dy > el.offsetHeight * 0.4 || v > 0.6) { el.style.transition = 'transform 240ms var(--ease-out)'; el.style.transform = 'translateY(100%)'; setTimeout(close, 220); }
    else { el.style.transition = 'transform 380ms cubic-bezier(0.34, 1.3, 0.64, 1)'; el.style.transform = 'translateY(0)'; } // a small settle on release
  };
  const all = amount >= s.balance;
  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-labelledby="wd-h">
      <button className="sheet-scrim" aria-label="Close" onClick={close} />
      <div className="sheet" ref={sheet}>
        <div className="sheet-grip" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}><span /></div>
        {done ? (
          <div className="sheet-body">
            <h2 id="wd-h">On its way</h2>
            <p>{money(amount)} is in your wallet{s.live ? '' : ' (demo money)'}.</p>
            <button className="btn btn-primary" onClick={close}>Done</button>
          </div>
        ) : (
          <div className="sheet-body">
            <h2 id="wd-h">Take money out</h2>
            <p className="sheet-lead">All of it is yours to take.</p>
            <div className="amount-big display">{money(amount)}</div>
            <input className="range" type="range" min={0} max={s.balance} step={s.live ? 0.01 : Math.max(1, Math.round(s.balance / 100))} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Amount to take out" />
            <ul className="sheet-facts">
              <li><b>Where it goes</b><span>Your wallet</span></li>
              <li><b>How long</b><span>A few seconds</span></li>
              <li><b>Your streak</b><span>{all ? 'Starts again from your next save' : 'Stays as it is'}</span></li>
            </ul>
            {error && <p className="review-error" role="alert">{error}</p>}
            <button className="btn btn-primary" disabled={!(amount > 0)} onClick={async () => {
              if (!s.live) { actions.withdraw(amount); setDone(true); return; }
              try { if (await withdrawLive(amount)) setDone(true); } catch (e) { setError(plain(e)); }
            }}>Take out {money(amount)}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Devnet only: the app runs on test money. Circle gives free test USDC to any Solana devnet address. */
function TestDollars({ wallet, inWallet }: { wallet: string; inWallet: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="test-dollars">
      <p><b>This beta runs on test dollars.</b> {inWallet > 0 ? `${money(inWallet)} is in your wallet, ready to save.` : 'Get free ones from Circle (choose Solana Devnet).'}</p>
      <div className="test-dollars-actions">
        <a className="btn btn-primary btn-sm" href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer" onClick={() => navigator.clipboard?.writeText(wallet).then(() => setCopied(true), () => {})}>Get test dollars</a>
        {copied && <span className="hint" role="status">Your wallet address is copied: paste it there.</span>}
      </div>
    </div>
  );
}

export function Savings({ withdraw }: { withdraw: boolean }) {
  const s = useStore();
  const you = me(s);
  const [vaultOpen, setVaultOpen] = useState(false);
  return (
    <div className="savings">
      <div className="savings-head"><h1>My savings</h1><span className="only-you"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" fill="none" strokeWidth="2.2" /></svg>Only you</span></div>
      <div className="balance-card">
        <div className="bal-head">
          <span className="bal-label">Your savings</span>
          <span className={`kvault ${vaultOpen ? 'open' : ''}`} aria-hidden="true">
            <img className="vault-body" src="objects/vault-body.webp" alt="" draggable={false} />
            <img className="vault-dial" src="objects/vault-dial.webp" alt="" draggable={false} />
            <img className="vault-handle" src="objects/vault-handle.webp" alt="" draggable={false} />
          </span>
        </div>
        <Curtain onToggle={setVaultOpen}>{(open) => <span className="bal display"><Odometer value={money(s.balance)} run={open} /></span>}</Curtain>
        <div className="bal-rows">
          <div><span>Interest earned</span><b>{(s.live && s.interest > 0 && s.interest < 0.01 ? `$${s.interest.toFixed(6)}` : money(s.interest))}</b></div>
          <div><span>Prizes won</span><b>{money(s.prizes)}</b></div>
          {s.live && ((s.live.assetPct ?? 0) > 0 || (s.live.sol ?? 0) > 0) && <div><span>Bought as SOL</span><b>{(s.live.sol ?? 0).toFixed(5)} SOL<small className="bal-note">{s.live.buys ? `${s.live.buys} weekly ${s.live.buys === 1 ? 'buy' : 'buys'}` : 'First buy'}{(s.live.nextBuyAt ?? 0) * 1000 > Date.now() ? `, next ${new Date((s.live.nextBuyAt ?? 0) * 1000).toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ' due now'}</small></b></div>}
          {s.live && <div><span>Private pocket</span><b><a className="bal-link" href="#app-me">Open to see</a></b></div>}
        </div>
      </div>
      {s.live && (s.live.prizesWon ?? 0) > 0 && <WinningsBuy />}
      {s.live && !MAINNET && <TestDollars wallet={s.live.wallet} inWallet={s.live.walletUsdc} />}
      <div className="savings-actions">
        <a className="btn btn-primary savings-main" href="#app-save">Save more</a>
        <a className="btn btn-ghost" href="#app-savings-withdraw">Take money out</a>
        <a className="btn btn-ghost" href="#app-send">Send</a>
      </div>
      <Insight />
      <h2 className="sub-h">Your streak</h2>
      {s.live && s.history.length === 0 && <p className="hint">Your saves will show here, week by week.</p>}
      <ol className="history">
        {s.history.map((h, i) => (
          <li key={i} className={h.saved ? 'saved' : 'missed'}>
            <span className="h-dot" aria-hidden="true" />
            <span className="h-label"><b>{h.label}</b><span>{h.saved ? 'Saved' : 'Missed. A new streak started.'}</span></span>
            <span className="h-amt">{h.saved ? money(h.amount) : ''}</span>
          </li>
        ))}
      </ol>
      <h2 className="sub-h">What your friends see about you</h2>
      <div className="shares">
        {([['saved', 'That you saved this payday'], ['streak', `Your streak (${you.streak} weeks)`], ['rank', 'Your place in the room']] as const).map(([k, l]) => (
          <label key={k} className="switch">
            <span>{l}</span>
            <input type="checkbox" role="switch" checked={s.share[k]} onChange={(e) => actions.setShare(k, e.target.checked)} />
          </label>
        ))}
        <p className="shares-note">Amounts are never shown to anyone but you.</p>
      </div>
      {withdraw && createPortal(<WithdrawSheet />, document.body)}
    </div>
  );
}

/** Prize winnings into SOL, a little each week. Only winnings: the saver's own savings are never part of it. */
function WinningsBuy() {
  const l = useStore().live!;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const left = l.winningsLeft ?? l.prizesWon ?? 0, on = l.winningsWeekly ?? 0;
  const pick = async (d: number) => { setBusy(true); setMsg(null); try { if (await setWinningsBuy(d)) setMsg(d ? `Done. Each week, up to ${money(d)} of your winnings becomes SOL.` : 'Stopped. Your winnings stay in dollars.'); } catch (e) { setMsg(plain(e)); } finally { setBusy(false); } };
  return (
    <section className="winnings">
      <h2 className="sub-h">Your winnings</h2>
      <p className="hint">{money(left)} of your prize money is still in dollars. Turn it into SOL bit by bit, and your own savings stay as they are.</p>
      <div className="winnings-pick" role="radiogroup" aria-label="Winnings into SOL each week">
        {[0, 1, 2, 5].map((d) => (
          <button key={d} type="button" role="radio" aria-checked={on === d} className={`btn btn-sm ${on === d ? 'btn-primary' : 'btn-ghost'}`} disabled={busy} onClick={() => on !== d && pick(d)}>{d ? `${money(d)} a week` : 'Off'}</button>
        ))}
      </div>
      {msg && <p className="hint" role="status">{msg}</p>}
    </section>
  );
}
