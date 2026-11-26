import { plain } from './plain.ts';
import { useEffect, useRef, useState } from 'react';
import { AVATAR_BASE } from '../ui/Wall.tsx';
import { money } from '../ui/money.ts';
import { useStore } from './store.ts';
import { PocketCard } from './Pocket.tsx';
import { setPhoto, addPhone, enableWinAlerts, setPlan, setRoundups, setTag, tagFree, winAlertsOn } from './live.ts';
// @ts-expect-error plain JS module shared with the tests
import { normalTag } from '../../../client/rooms.mjs';
import { explorer, MAINNET } from '../config.ts';

/** A saver's face in the app: their tag's first letter on a colour picked from the tag, the same on every phone. */
export function Avatar({ tag, size = 40, photo }: { tag: string | null | undefined; size?: number; photo?: string | null }) {
  if (photo) return <img className="avatar avatar-photo" src={`${AVATAR_BASE}/${photo}.webp`} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  const tones = ['var(--kernel)', 'var(--leaf)', 'var(--apple)', 'var(--mist-2)', 'var(--kernel-deep)'];
  const t = tag ?? '';
  const h = [...t].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.46, background: t ? tones[h % tones.length] : 'var(--mist)' }} aria-hidden="true">
      {t ? t[0].toUpperCase() : '?'}
    </span>
  );
}

/** A plan as one bar: dollars in green, SOL in gold. Percent only, never amounts. */
export function PlanBar({ pct }: { pct: number }) {
  return <span className="plan-bar" aria-hidden="true"><span style={{ width: `${100 - pct}%` }} /><span style={{ width: `${pct}%` }} /></span>;
}

/** Copy to the clipboard, with "Copied" for a moment. */
function CopyButton({ text, label, className = 'btn btn-ghost btn-sm' }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={className} onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1600); }, () => {})}>
      {done ? 'Copied' : label}
    </button>
  );
}

/** Pick or change a Kashutag, checked as you type. */
export function TagForm({ current, onDone }: { current: string | null; onDone?: () => void }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const n = normalTag(value) as { tag: string | null; why: string | null };
  useEffect(() => {
    if (!value) { setState(null); return; }
    if (!n.tag) { setState({ ok: false, text: n.why! }); return; }
    if (n.tag === current) { setState({ ok: false, text: 'That one is already yours' }); return; }
    setState({ ok: false, text: 'Checking…' });
    let live = true;
    const t = setTimeout(() => tagFree(n.tag!).then((free) => live && setState(free ? { ok: true, text: `$${n.tag} is free` } : { ok: false, text: `$${n.tag} is taken` }), () => live && setState({ ok: false, text: 'Couldn\'t check right now' })), 350);
    return () => { live = false; clearTimeout(t); };
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <form className="tag-form" onSubmit={async (e) => {
      e.preventDefault();
      if (!state?.ok || !n.tag) return;
      setBusy(true);
      try { if (await setTag(n.tag)) { setValue(''); onDone?.(); } }
      catch (err) { setState({ ok: false, text: plain(err) }); }
      finally { setBusy(false); }
    }}>
      <label className="tag-input">
        <span aria-hidden="true">$</span>
        <input value={value} onChange={(e) => setValue(e.target.value.replace(/\s/g, ''))} placeholder={current ?? 'yourname'} maxLength={16}
          autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Your Kashutag" aria-describedby="tag-note" />
      </label>
      <p id="tag-note" className={`tag-note ${state ? (state.ok ? 'ok' : 'no') : ''}`} aria-live="polite">{state?.text ?? '3 to 15 letters, numbers or _'}</p>
      <button className="btn btn-primary" disabled={!state?.ok || busy}>{busy ? 'One moment…' : current ? (n.tag ? `Change to $${n.tag}` : 'Change your tag') : (n.tag ? `Claim $${n.tag}` : 'Claim your tag')}</button>
    </form>
  );
}

export function Me() {
  const s = useStore();
  const l = s.live;
  const [changing, setChanging] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [alerts, setAlerts] = useState(winAlertsOn());
  const photoInput = useRef<HTMLInputElement>(null);
  const run = async (f: () => Promise<unknown>) => { setBusy('One moment…'); try { await f(); setBusy(null); } catch (e) { setBusy(plain(e)); } };
  if (!l) return <div className="me"><h1>You</h1><p className="hint">Start your room first, then your profile lives here.</p></div>;
  const link = l.tag ? `${location.origin}${location.pathname}#app-send-${l.tag}` : '';
  return (
    <div className="me">
      <div className="me-head">
        <button type="button" className="me-photo" onClick={() => photoInput.current?.click()} aria-label={l.avatar ? 'Change your photo' : 'Add a photo'}>
          <Avatar tag={l.tag} photo={l.avatar} size={72} />
          <span className="me-photo-badge" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.4" /></svg></span>
        </button>
        <input ref={photoInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) run(() => setPhoto(f)); }} />
        <div>
          <h1 className="display">{l.tag ? `$${l.tag}` : 'Pick your Kashutag'}</h1>
          <p className="me-sub">{l.tag ? 'Friends send you money with this. Kashu never shows your balance to anyone.' : 'A name friends can send money to, instead of a long address.'}</p>
        </div>
      </div>

      {busy && <p className="hint me-status" role="status">{busy}</p>}

      {(!l.tag || changing) && <TagForm current={l.tag} onDone={() => setChanging(false)} />}

      {l.tag && !changing && (
        <section className="me-card get-paid" aria-labelledby="gp-h">
          <h2 id="gp-h">Get paid</h2>
          <p>Share your tag or your link. Money sent to you lands in your wallet, ready to save.</p>
          <div className="me-actions">
            <CopyButton text={`$${l.tag}`} label={`Copy $${l.tag}`} className="btn btn-primary btn-sm" />
            <CopyButton text={link} label="Copy pay link" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChanging(true)}>Change tag</button>
          </div>
        </section>
      )}

      <section className="me-card" aria-labelledby="money-h">
        <h2 id="money-h">Money</h2>
        <ul className="me-rows">
          <li><span>In your wallet, not saved yet</span><b>{money(l.walletUsdc)}</b></li>
          <li><span>Saved</span><b>{money(s.balance)}</b></li>
        </ul>
        <div className="me-actions">
          <a className="btn btn-primary btn-sm" href="#app-send">Send money</a>
          {l.walletUsdc > 0 && <a className="btn btn-ghost btn-sm" href="#app-save">Save it</a>}
        </div>
      </section>

      <PocketCard />

      <section className="me-card" aria-labelledby="plan-h">
        <h2 id="plan-h">Your plan</h2>
        <label className="switch">
          <span><b>Round up my payments</b><br /><small>Send $4.30 and $0.70 of change goes into your savings</small></span>
          <input type="checkbox" role="switch" checked={(l.roundup ?? 0) > 0} disabled={!!busy} onChange={(e) => run(() => setRoundups(e.target.checked ? 1 : 0))} />
        </label>
        <p className="plan-q">Each week's save, split</p>
        <div className="plan-pick" role="radiogroup" aria-label="How each week's save is split" style={{ ['--sel' as string]: Math.max(0, [0, 10, 25, 50].indexOf(l.assetPct ?? 0)) }}>
          {[0, 10, 25, 50].map((pct) => (
            <button key={pct} type="button" role="radio" aria-checked={(l.assetPct ?? 0) === pct} className={(l.assetPct ?? 0) === pct ? 'on' : ''} disabled={!!busy}
              onClick={() => (l.assetPct ?? 0) !== pct && run(() => setPlan(pct))}>
              <PlanBar pct={pct} /><span>{pct ? `${100 - pct}/${pct}` : 'All dollars'}</span>
            </button>
          ))}
        </div>
        <p className="hint">Dollars earn interest on Jupiter Lend. The SOL share is bought once a week at a checked price, and only on mainnet: in this test beta your plan is saved, nothing is bought.</p>
      </section>

      <section className="me-card" aria-labelledby="alerts-h">
        <h2 id="alerts-h">Notifications</h2>
        <label className="switch">
          <span><b>Tell me when I win</b><br /><small>A notification on this phone when the draw pays you, even with Kashu closed</small></span>
          <input type="checkbox" role="switch" checked={alerts} disabled={alerts || !!busy} onChange={() => run(async () => { await enableWinAlerts(); setAlerts(true); })} />
        </label>
      </section>

      <section className="me-card" aria-labelledby="phone-h">
        <h2 id="phone-h">Your phones</h2>
        {l.needsPhone ? (
          <>
            <p>This phone can't see your private room yet.</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={async () => { try { if (await addPhone()) setPhoneMsg('Asked. Your room opens here in about a minute.'); } catch (e) { setPhoneMsg(plain(e)); } }}>Use this phone</button>
          </>
        ) : <p>{l.private ? 'This phone can see your private room.' : 'Your room goes private after its first week.'}</p>}
        {phoneMsg && <p className="hint" role="status">{phoneMsg}</p>}
        <p className="hint">On a new phone or computer, open Kashu and choose "I already have Kashu". Your passkey (saved by Apple, Google or your password manager) is all you need.</p>
      </section>

      <details className="me-card me-details">
        <summary>Wallet details</summary>
        <p className="hint">Kashu runs on Solana. You never need these, but they're yours to check. Like any Solana account, these can be looked up by anyone who has the address.</p>
        <ul className="me-rows mono">
          <li><span>Wallet</span><span className="addr"><a href={explorer('address', l.wallet)} target="_blank" rel="noopener noreferrer"><code>{l.wallet.slice(0, 6)}…{l.wallet.slice(-6)}</code></a><CopyButton text={l.wallet} label="Copy" /></span></li>
          <li><span>Savings vault</span><span className="addr"><a href={explorer('address', l.vault)} target="_blank" rel="noopener noreferrer"><code>{l.vault.slice(0, 6)}…{l.vault.slice(-6)}</code></a></span></li>
        </ul>
        {!MAINNET && <div className="me-actions">
          <a className="btn btn-ghost btn-sm" href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">Get test dollars (paste the wallet address)</a>
        </div>}
      </details>

      <a className="btn btn-ghost" href="#app-advanced">How Kashu works</a>
    </div>
  );
}
