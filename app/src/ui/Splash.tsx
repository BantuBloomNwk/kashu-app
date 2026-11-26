import { useEffect, useRef, useState } from 'react';

// Kashu opening: the brand kit's logo reveal (the kernel K builds, the leaf sprouts, the wordmark types), then the
// tagline, then the splash lifts away and the app settles in beneath it. Once per visit, tap to skip, and calm for
// reduced motion. The video is cropped to the logo; the tagline is live text, so it's always the current one.
const SEEN = 'kashu.splash';
/** Night is when the app's sky says so (7pm to 5am): then the opening is the dusk one. */
const isNight = () => { const h = new Date().getHours(); return h >= 19 || h < 5; };
const STARS = Array.from({ length: 26 }, (_, i) => ({ x: (i * 47) % 100, y: (i * 29) % 62, s: 1 + ((i * 13) % 3), d: (i * 61) % 900 }));

/** The brand kit's reverse lockup, built part by part like the day reveal: shadow, stem, kernel, leaf, then the word. */
function NightLogo() {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => { fetch('brand/kashu-lockup-reverse.svg').then((r) => r.text()).then((t) => setSvg(t.replace(/ width="\d+" height="\d+"/, '')), () => setSvg('')); }, []);
  return svg ? <div className="night-logo" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="night-logo" />;
}
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Splash({ onDone }: { onDone?: () => void }) {
  const [phase, setPhase] = useState<'play' | 'tag' | 'leave' | 'gone'>(() => { try { return sessionStorage.getItem(SEEN) ? 'gone' : 'play'; } catch { return 'play'; } });
  const video = useRef<HTMLVideoElement>(null);
  const [still, setStill] = useState(false); // the finished logo, when the video can't play
  const [night] = useState(isNight);
  const leave = () => setPhase((p) => (p === 'gone' || p === 'leave' ? p : 'leave'));
  useEffect(() => {
    if (phase === 'gone') { onDone?.(); return; }
    if (phase === 'play') {
      try { sessionStorage.setItem(SEEN, '1'); } catch { /* fine */ }
      document.documentElement.classList.add('splashing');
      const v = video.current;
      if (night) { const t = setTimeout(() => setPhase('tag'), reduced() ? 300 : 1900); return () => clearTimeout(t); }
      if (reduced() || !v) { setStill(true); const t = setTimeout(() => setPhase('tag'), 300); return () => clearTimeout(t); }
      v.playbackRate = 1.6;
      v.play().catch(() => { setStill(true); setPhase('tag'); });
      // the logo is whole by about 1.9 s at this speed; don't wait for the video's tail
      const t = setTimeout(() => setPhase('tag'), 1900);
      return () => clearTimeout(t);
    }
    if (phase === 'tag') { const t = setTimeout(leave, reduced() ? 700 : 750); return () => clearTimeout(t); }
    if (phase === 'leave') {
      document.documentElement.classList.remove('splashing');
      document.documentElement.classList.add('arriving');
      const t = setTimeout(() => { setPhase('gone'); document.documentElement.classList.remove('arriving'); }, 520);
      return () => clearTimeout(t);
    }
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  if (phase === 'gone') return null;
  return (
    <div className={`splash is-${phase} ${night ? 'night' : ''}`} onPointerDown={leave} role="img" aria-label="Kashu. Save together. Win on Fridays.">
      {night && (
        <div className="night-sky" aria-hidden="true">
          {STARS.map((st, i) => <span key={i} className="star" style={{ left: `${st.x}%`, top: `${st.y}%`, width: st.s, height: st.s, animationDelay: `${st.d}ms` }} />)}
          <span className="night-moon"><img src="objects/moon.webp" alt="" draggable={false} /></span>
        </div>
      )}
      {!night && <span className="day-sun" aria-hidden="true"><img src="objects/sun.webp" alt="" draggable={false} /></span>}
      {night ? <NightLogo /> : <div className="splash-logo">
        {still ? <img src="brand/kashu-reveal-end.webp" alt="" />
          : <video ref={video} muted playsInline preload="auto" aria-hidden="true" onError={() => setStill(true)}>
              <source src="brand/kashu-reveal.webm" type="video/webm" />
              <source src="brand/kashu-reveal.mp4" type="video/mp4" />
            </video>}
      </div>}
      <p className="splash-tag" aria-hidden="true">Save together. Win on Fridays.</p>
    </div>
  );
}
