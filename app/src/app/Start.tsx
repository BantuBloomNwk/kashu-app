import { plain } from './plain.ts';
import { useEffect, useState } from 'react';
import { Mark } from '../ui/Mark.tsx';
import { Wall, type Friend } from '../ui/Wall.tsx';
import { money, showDollars, weeklyDefault } from '../ui/money.ts';
import { actions } from './store.ts';
import { onboard, roomPreview, signIn } from './live.ts';
import { MAINNET } from '../config.ts';

// First run: the promise on screen one, no carousel and no sign-up wall. Tap a window and it lights:
// that is saving. Then a weekly amount, then a room. The account is a passkey; no wallet words.
export function Start({ joinRoom }: { joinRoom?: string }) {
  const [code, setCode] = useState(() => { try { return sessionStorage.getItem('kashu.invite') ?? ''; } catch { return ''; } });
  const [invite, setInvite] = useState<Awaited<ReturnType<typeof roomPreview>> | 'none' | null>(null);
  useEffect(() => { if (joinRoom) roomPreview(joinRoom).then((p) => setInvite(p ?? 'none'), () => setInvite('none')); }, [joinRoom]);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // live savings are in dollars (USDC), so the weekly choices are too
  showDollars(true);
  const [trio, setTrio] = useState<Friend[]>([
    { id: 'a', name: 'Ada', lit: true, streak: 2, pattern: 'louvre' },
    { id: 'you', name: 'You', lit: false, streak: 0, pattern: 'panel', you: true },
    { id: 'b', name: 'Bayo', lit: false, streak: 0, pattern: 'grid' },
  ]);
  const [weekly, setWeekly] = useState(5);
  const [room, setRoom] = useState('');
  const youLit = trio.find((f) => f.you)!.lit;
  const presets = [1, 2, 5, 10];
  void weeklyDefault;
  const go = async () => {
    setBusy(true); setError(null);
    try { if (await onboard({ roomName: room.trim(), weekly, joinRoom })) location.hash = '#app-room'; }
    catch (e) { setError(plain(e) || 'Something went wrong. Nothing was taken.'); }
    finally { setBusy(false); }
  };
  const demo = () => { showDollars(false); actions.start('Payday crew', weeklyDefault); location.hash = '#app-room'; };

  return (
    <div className="start">
      <div className="start-top"><Mark size={44} />
        <span className="start-progress" role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step + 1} aria-label={`Step ${step + 1} of 3`}>
          {[0, 1, 2].map((i) => <span key={i} className={i <= step ? 'on' : ''} />)}
        </span>
      </div>
      {joinRoom && invite && invite !== 'none' && (
        <div className="invite-card">
          <span className="invite-kicker">{invite.by ? `$${invite.by} invited you to` : 'You\'re invited to'}</span>
          <b className="display">{invite.name}</b>
          <span>{invite.members} {invite.members === 1 ? 'person saves' : 'people save'} here{invite.private ? ' · private room' : ''}</span>
        </div>
      )}
      {joinRoom && invite === 'none' && <p className="review-error" role="alert">This invite link doesn't point at a Kashu room. Ask your friend to send it again.</p>}
      {step === 0 && (
        <section className="start-body">
          {error && step === 0 && <p className="review-error" role="alert">{error}</p>}
          <h1>Your savings stay yours.</h1>
          <p className="start-lede">Tap your window.</p>
          <div className="start-wall facade">
            <Wall friends={trio} size="lg" onPress={(id) => id === 'you' && setTrio((t) => t.map((f) => (f.you ? { ...f, lit: !f.lit } : f)))} />
          </div>
          <p className={`start-reveal ${youLit ? 'on' : ''}`} aria-live="polite">
            {youLit ? 'That\'s saving. Your money stays yours. The light is all your friends see.' : ' '}
          </p>
          {MAINNET && (
            <label className="field invite-field">
              <span>Invite code</span>
              <input value={code} onChange={(e) => { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24); setCode(v); try { sessionStorage.setItem('kashu.invite', v); } catch { /* fine */ } }}
                placeholder="From a friend already saving" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
              <small className="hint">Kashu is invite-only during the beta.</small>
            </label>
          )}
          <button className="btn btn-primary start-next" disabled={!youLit || (MAINNET && code.length < 6)} onClick={() => setStep(1)}>Next</button>
          <button type="button" className="start-alt start-signin" disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try { (await signIn()) === 'ok' ? (location.hash = '#app-room') : setError('That passkey has no Kashu account in it yet. Start a new one below.'); }
            catch (e) { setError((e as Error).name === 'NotAllowedError' || /NotAllowed|cancel/i.test((e as Error).message) ? 'No Kashu passkey came back. If you saw "no passkeys found", yours is saved in another browser or password manager on this phone (Samsung Pass or Google, say): open Kashu in that browser, or pick that password manager when asked.' : plain(e)); }
            finally { setBusy(false); }
          }}>Already saving with Kashu? Sign in</button>
        </section>
      )}
      {step === 1 && (
        <section className="start-body">
          <img className="start-object" src="objects/jar-cut.webp" alt="" draggable={false} />
          <h1>How much each payday?</h1>
          <p className="start-lede">Small is fine. You can change it any time, and take it all out whenever you need it.</p>
          <div className="amount-big display" aria-live="polite">{money(weekly)}</div>
          <div className="chips" role="group" aria-label="Pick an amount">
            {presets.map((p) => (
              <button key={p} type="button" className={`chip ${p === weekly ? 'on' : ''}`} aria-pressed={p === weekly} onClick={() => setWeekly(p)}>{money(p)}</button>
            ))}
          </div>
          <label className="field">
            <span>Or type an amount</span>
            <input inputMode="decimal" type="number" min={1} value={weekly} onChange={(e) => setWeekly(Math.max(0, Number(e.target.value)))} />
          </label>
          <button className="btn btn-primary start-next" disabled={!(weekly > 0)} onClick={() => setStep(2)}>Next</button>
        </section>
      )}
      {step === 2 && (
        <section className="start-body">
          <span className="start-object start-vault" aria-hidden="true">
            <img src="objects/vault-body.webp" alt="" draggable={false} /><img className="vault-dial" src="objects/vault-dial.webp" alt="" draggable={false} /><img className="vault-handle" src="objects/vault-handle.webp" alt="" draggable={false} />
          </span>
          <h1>{joinRoom ? 'Join the room' : 'Start your room'}</h1>
          <p className="start-lede">{joinRoom ? 'Join, and your window goes up next to theirs. They see that you saved, never how much.' : 'Name it, then send the link to your people. Your first draw night is on once two friends join.'}</p>
          {!joinRoom && (
            <label className="field">
              <span>Room name</span>
              <input value={room} maxLength={24} placeholder="Payday crew" onChange={(e) => setRoom(e.target.value)} />
            </label>
          )}
          <div className="passkey">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M21 12v2" strokeWidth="2.2" fill="none" /></svg>
            <p>Your account uses a passkey: your phone's fingerprint or face. No passwords, nothing to write down. You'll approve twice: once to open your vault, once for the room.</p>
          </div>
          {error && <p className="review-error" role="alert">{error}</p>}
          <button className="btn btn-primary start-next" disabled={busy} onClick={go}>{busy ? 'Setting up…' : joinRoom ? 'Join with my passkey' : 'Create my room'}</button>
          <button type="button" className="start-alt" onClick={demo}>Just look around first (demo money)</button>
        </section>
      )}
    </div>
  );
}
