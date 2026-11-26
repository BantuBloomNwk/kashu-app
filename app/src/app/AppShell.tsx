import { useEffect, useState } from 'react';
import { Mark } from '../ui/Mark.tsx';
import { useStore } from './store.ts';
import { Start } from './Start.tsx';
import { Room } from './Room.tsx';
import { Save } from './Save.tsx';
import { Draw } from './Draw.tsx';
import { Savings } from './Savings.tsx';
import { Advanced } from './Advanced.tsx';
import { Me, Avatar } from './Me.tsx';
import { Send } from './Send.tsx';
import { Agent } from './Agent.tsx';
import { ReviewSheet } from './ReviewSheet.tsx';
import { WonMoment } from './Won.tsx';
import { Sky } from './Sky.tsx';
import { refresh } from './live.ts';
import { savedPasskey } from '../wallet/wallet.ts';
import './app.css';

function Nav({ route }: { route: string }) {
  const tab = route.startsWith('savings') ? 'savings' : route.startsWith('draw') ? 'draw' : route.startsWith('agent') ? 'agent' : route.startsWith('me') || route.startsWith('send') ? null : 'room';
  const items = [
    { id: 'savings', label: 'My savings', icon: <svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" strokeWidth="2.2" /></svg> },
    { id: 'room', label: 'Room', icon: <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="8.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="8.5" rx="2" /><rect x="3" y="13" width="7.5" height="8" rx="2" /><rect x="13.5" y="13" width="7.5" height="8" rx="2" /></svg> },
    { id: 'draw', label: 'Draw night', icon: <svg viewBox="0 0 24 24"><path d="M15 3a9 9 0 1 0 6 13A7.2 7.2 0 0 1 15 3z" /></svg> },
    { id: 'agent', label: 'Agent', icon: <svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="4" /><circle cx="9.5" cy="13" r="1.6" fill="var(--canopy-deep)" /><circle cx="14.5" cy="13" r="1.6" fill="var(--canopy-deep)" /><path d="M12 7V4" fill="none" strokeWidth="2.2" /><circle cx="12" cy="3.5" r="1.4" /></svg> },
  ];
  return (
    <nav className="app-nav" aria-label="App" style={{ ['--tab' as string]: items.findIndex((i) => i.id === tab) }}>
      {tab && <span className="nav-pill" aria-hidden="true" />}
      {items.map((i) => (
        <a key={i.id} href={`#app-${i.id}`} className={tab === i.id ? 'on' : ''} aria-current={tab === i.id ? 'page' : undefined}>
          {i.icon}<span>{i.label}</span>
        </a>
      ))}
    </nav>
  );
}

export function AppShell({ route }: { route: string }) {
  const s = useStore();
  // a returning saver: read their vault and room from the chain
  const [failed, setFailed] = useState(false);
  // keep the screens in step with the chain: on every screen change, every 20 s while the app is on screen, and
  // when the person comes back to it (the keeper counts saves and runs the draw without the app's help)
  useEffect(() => {
    if (!savedPasskey()) return;
    const read = () => { if (document.visibilityState === 'visible') refresh().then(() => setFailed(false), (e) => { setFailed(true); console.warn('kashu: refresh', (e as Error).message); }); };
    read();
    const timer = setInterval(read, 20_000);
    document.addEventListener('visibilitychange', read);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, [route]);
  const join = route.startsWith('join/') ? route.slice(5) : undefined;
  // a returning saver (a passkey saved here) waits for their room instead of seeing Start
  const loading = !s.started && !join && !!savedPasskey() && !s.live && route !== 'advanced';
  const page = join ? 'start' : loading ? 'loading' : !s.started && route !== 'advanced' ? 'start' : route;
  const base = page.split('/')[0];
  const dusk = base === 'draw';
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dusk ? '#16263A' : '#F6F7F1');
  }, [dusk]);
  const screen = (() => {
    switch (base) {
      case 'start': return <Start joinRoom={join} />;
      case 'loading': return failed
        ? <div className="app-loading"><p>Couldn't reach the network.</p><button className="btn btn-primary btn-sm" onClick={() => { setFailed(false); refresh().catch(() => setFailed(true)); }}>Try again</button></div>
        : <p className="app-loading" aria-live="polite">Loading your room…</p>;
      case 'save': return <Save />;
      case 'draw': return <Draw />;
      case 'savings': return <Savings withdraw={page === 'savings/withdraw'} />;
      case 'advanced': return <Advanced />;
      case 'me': return <Me />;
      case 'agent': return <Agent />;
      case 'send': return <Send to={page.split('/')[1]} />;
      default: return <Room />;
    }
  })();
  const chrome = base !== 'start';
  return (
    <div className={`app ${dusk ? 'is-dusk' : ''}`}>
      {!dusk && <Sky />}
      <div className="app-frame">
        {chrome && (
          <header className="app-top">
            {['me', 'send', 'advanced'].includes(base)
              ? <button type="button" className="app-back" aria-label="Back" onClick={() => { if (history.length > 1) history.back(); else location.hash = '#app-room'; }}><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg></button>
              : <a href="#top" className="app-home" aria-label="Kashu home"><Mark size={30} tone={dusk ? 'reverse' : 'flat'} /></a>}
            <span className="app-room">{s.roomName}</span>
            <a href="#app-me" className="app-me" aria-label={s.live?.tag ? `You, $${s.live.tag}` : 'You'}><Avatar tag={s.live?.tag} photo={s.live?.avatar} size={34} /></a>
          </header>
        )}
        <main className="app-main" key={base}>{screen}</main>
        {chrome && <Nav route={page} />}
      </div>
      <ReviewSheet />
      <WonMoment />
    </div>
  );
}
