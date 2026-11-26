import { plain } from './plain.ts';
import { useEffect, useState } from 'react';
import { money } from '../ui/money.ts';
import { useStore } from './store.ts';
import { avatarOf, lookup, payPrivately, pocketOf, sendMoney } from './live.ts';
import { pocket } from '../wallet/pocket.ts';
import { Avatar } from './Me.tsx';
import { SendReceipt } from './receipts.tsx';
import { ReceiptSheet } from '../ui/Receipt.tsx';

type Who = { owner: string; tag: string | null };
/** The change a payment of n saves, when round-ups are on and the wallet covers both (matches sendMoney). */
const roundUp = (n: number, l: { roundup?: number; walletUsdc: number }) => {
  const unit = l.roundup ?? 0; if (!(n > 0) || !unit || n > l.walletUsdc) return 0;
  const c = Math.round((Math.ceil(n / unit - 1e-9) * unit - n) * 1e6) / 1e6;
  return l.walletUsdc - n >= c ? c : 0;
};

/** Send dollars to a friend by their Kashutag. A pay link (#app-send-ada) fills the tag in. */
export function Send({ to: preset }: { to?: string }) {
  const s = useStore();
  const l = s.live;
  const [to, setTo] = useState(preset ? `$${preset}` : '');
  const [who, setWho] = useState<Who | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ amount: number; sig: string; roundedUp: number; private?: boolean; fromWallet: number; fromSavings: number; at: Date } | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [theirPocket, setTheirPocket] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [priv, setPriv] = useState(false);

  useEffect(() => {
    setWho(null); setTheirPocket(null); setPriv(false);
    if (!to.trim()) { setNote(null); return; }
    setNote('Looking…');
    let live = true;
    const t = setTimeout(() => lookup(to).then((r) => {
      if (!live) return;
      if ('error' in r) { setNote(r.error); return; }
      if (l && r.owner === l.wallet) { setNote('That\'s you'); return; }
      setWho(r); setNote(null);
      avatarOf(r.owner).then((h) => live && setPhoto(h), () => {});
      pocketOf(r.owner).then((p) => { if (live) { setTheirPocket(p); setPriv(!!p && !!pocket()); } }, () => {});
    }, () => live && setNote('Couldn\'t check right now')), 350);
    return () => { live = false; clearTimeout(t); };
  }, [to]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!l) return <div className="send"><h1>Send money</h1><p className="hint">Start your room first.</p></div>;
  const n = Number(amount);
  const available = l.walletUsdc + s.balance;
  const fromSavings = Math.max(0, n - l.walletUsdc);
  const name = who?.tag ? `$${who.tag}` : who ? `${who.owner.slice(0, 4)}…${who.owner.slice(-4)}` : '';

  if (sent) return (
    <div className="send sent" role="status">
      <Avatar tag={who?.tag} photo={photo} size={72} />
      <h1 className="display">Sent {money(sent.amount)}</h1>
      <p>{name} has it now.{sent.roundedUp > 0 ? ` And ${money(sent.roundedUp)} of change went into your savings.` : ''}</p>
      {sent.private && <p className="hint">Paid privately from your pocket: nothing about it shows on a public explorer.</p>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowReceipt(true)}>See the receipt</button>
      <ReceiptSheet open={showReceipt} onClose={() => setShowReceipt(false)}>
        <SendReceipt to={name} amount={sent.amount} fromWallet={sent.fromWallet} fromSavings={sent.fromSavings} roundedUp={sent.roundedUp} sig={sent.sig} privately={!!sent.private} at={sent.at} />
      </ReceiptSheet>
      <a className="btn btn-primary" href="#app-me">Done</a>
    </div>
  );

  return (
    <form className="send" onSubmit={async (e) => {
      e.preventDefault();
      if (!who || !(n > 0)) return;
      setBusy(true); setError(null);
      try {
        const split = { fromWallet: Math.min(n, l.walletUsdc), fromSavings: Math.max(0, n - l.walletUsdc), at: new Date() };
        if (priv) { const sig = await payPrivately(who.owner, n); setSent({ amount: n, sig, roundedUp: 0, private: true, ...split, fromWallet: 0, fromSavings: 0 }); }
        else { const r = await sendMoney(who, n); if (r) setSent({ amount: n, ...r, ...split }); }
      }
      catch (err) { setError(plain(err)); }
      finally { setBusy(false); }
    }}>
      <h1>Send money</h1>
      <label className="field">
        <span>To</span>
        <div className={`to-row ${who ? 'found' : ''}`}>
          {who && <Avatar tag={who.tag} photo={photo} size={32} />}
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="$friend" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby="to-note" />
        </div>
        <small id="to-note" className={`tag-note ${who ? 'ok' : 'no'}`} aria-live="polite">{note ?? (who ? `Sending to ${name}` : '')}</small>
      </label>
      <label className="field">
        <span>Amount</span>
        <div className="amount-row"><span aria-hidden="true">$</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" aria-label="Amount in dollars" /></div>
        <small className="hint">
          {roundUp(n, l) > 0 ? `Rounds up: ${money(roundUp(n, l))} of change goes into your savings` :
          n > available ? `You have ${money(available)}` : n > 0 && fromSavings > 0 ? `${money(Math.min(n, l.walletUsdc))} from your wallet, ${money(fromSavings)} from your savings` : `You have ${money(available)}`}
        </small>
      </label>
      {theirPocket && (
        <label className="switch">
          <span><b>Pay privately from my pocket</b><br /><small>{pocket() ? 'Free, and it won\'t show on any public record' : 'Open your pocket in your profile first'}</small></span>
          <input type="checkbox" role="switch" checked={priv} disabled={!pocket()} onChange={(e) => setPriv(e.target.checked)} />
        </label>
      )}
      {error && <p className="review-error" role="alert">{error}</p>}
      <button className="btn btn-primary" disabled={!who || !(n > 0) || n > available || busy}>{busy ? 'One moment…' : who ? `${priv ? 'Pay' : 'Send'} ${n > 0 ? money(n) : ''} to ${name}${priv ? ' privately' : ''}` : 'Send'}</button>
    </form>
  );
}
