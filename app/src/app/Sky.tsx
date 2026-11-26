import { useEffect, useState } from 'react';

// The sky over the wall follows the saver's own day, as the landing's day does: mist at dawn, a kernel haze in the
// afternoon, kernel into coral at golden hour, a dusk tint at night with the moon. It's a band behind the header that
// fades into paper, so text keeps full contrast in bright sun. Nothing loops; the sun just sits where it would be now.
type Phase = 'dawn' | 'day' | 'golden' | 'night';
const phaseOf = (h: number): Phase => (h >= 5 && h < 9 ? 'dawn' : h >= 9 && h < 16 ? 'day' : h >= 16 && h < 19 ? 'golden' : 'night');

export function Sky() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  const h = now.getHours() + now.getMinutes() / 60;
  const phase = phaseOf(Math.floor(h));
  // the sun crosses from 6 to 19, the moon from 19 to 6; x across the band, y on an arc
  const k = phase === 'night' ? ((h + 24 - 19) % 24) / 11 : Math.min(1, Math.max(0, (h - 6) / 13));
  // it stays in the header band, clear of the logo and of every heading below it
  // beside the avatar (just left of it, in the header), rising a little through the day and setting again
  const y = 34 - Math.sin(k * Math.PI) * 10;
  return (
    <div className="sky" data-phase={phase} aria-hidden="true">
      {/* the orb lives in the app's own column, so it sits by the avatar on a phone and on a wide screen alike */}
      <div className="sky-col">
      <img className={`sky-orb ${phase === 'night' ? 'moon' : 'sun'}`} src={phase === 'night' ? 'objects/moon.webp' : 'objects/sun.webp'} alt="" draggable={false} style={{ top: `calc(${y}px + var(--safe-t))` }} />
      </div>
    </div>
  );
}
