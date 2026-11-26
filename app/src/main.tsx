import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/jaro/400.css';
import '@fontsource/andika/400.css';
import '@fontsource/andika/700.css';
import './styles/tokens.css';
import './styles/base.css';
import { Landing } from './landing/Landing.tsx';
import { AppShell } from './app/AppShell.tsx';
import { Splash } from './ui/Splash.tsx';
import { DrawRules, Privacy, Security, Terms } from './landing/Legal.tsx';

// Two surfaces, one look: the landing at "#top" and the app at "#app-..." (plain names; a dash stands for a slash). A hash route keeps the
// whole thing a static site (and a Capacitor bundle) with no server routing.
function useRoute() {
  const [hash, setHash] = useState(() => location.hash || '#top');
  useEffect(() => {
    const on = () => setHash(location.hash || '#top');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Root() {
  const hash = useRoute();
  useEffect(() => { scrollTo(0, 0); }, [hash.startsWith('#app')]);
  const legal = hash === '#terms' ? <Terms /> : hash === '#privacy' ? <Privacy /> : hash === '#draw-rules' ? <DrawRules /> : hash === '#security' ? <Security /> : null;
  return <>{hash.startsWith('#app') ? <AppShell route={hash.slice(5).replace(/-/g, '/') || 'room'} /> : legal ?? <Landing />}<Splash /></>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
