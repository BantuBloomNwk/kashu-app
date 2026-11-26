import type { ReactNode } from 'react';
import './phone.css';

// The two phones are rendered in Blender (frame, glass, rim, island or punch-hole) with a see-through
// screen; the screen's position comes from the render's own measurements (art/out2/meta.json), so
// whatever sits underneath (a screenshot, or live HTML) lines up with the glass.
const DEV = {
  iphone: { frame: 'objects/phone-iphone.webp', ratio: 520 / 1029, s: { l: 6.96, t: 3.52, w: 86.08, h: 92.97, r: 12.87 }, label: 'iPhone' },
  seeker: { frame: 'objects/phone-seeker.webp', ratio: 520 / 1078, s: { l: 7.54, t: 3.64, w: 84.92, h: 92.73, r: 8.88 }, label: 'Solana Seeker' },
} as const;
export type Device = keyof typeof DEV;

function StatusBar({ device, dark }: { device: Device; dark?: boolean }) {
  return (
    <span className={`sbar sbar-${device} ${dark ? 'is-dark' : ''}`} aria-hidden="true">
      <span>9:41</span>
      <span className="sbar-icons">
        <svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" /><rect x="5" y="5.5" width="3" height="6.5" rx="1" /><rect x="10" y="3" width="3" height="9" rx="1" /><rect x="15" y="0" width="3" height="12" rx="1" /></svg>
        <svg viewBox="0 0 26 12"><rect x="0.5" y="0.5" width="22" height="11" rx="3" fill="none" strokeWidth="1" /><rect x="2.5" y="2.5" width="16" height="7" rx="1.6" /><rect x="23.5" y="4" width="2" height="4" rx="1" /></svg>
      </span>
    </span>
  );
}

/** A phone with a screen: pass `src` for a screenshot (or several, crossfaded by `index`), or children for live HTML. */
export function Phone({ device, src, index = 0, children, dark, className = '', label }: {
  device: Device; src?: string[]; index?: number; children?: ReactNode; dark?: boolean; className?: string; label?: string;
}) {
  const d = DEV[device];
  return (
    <figure className={`phone3d phone3d-${device} ${className}`} style={{ aspectRatio: String(d.ratio) }}>
      <span className="phone3d-screen" style={{ left: `${d.s.l}%`, top: `${d.s.t}%`, width: `${d.s.w}%`, height: `${d.s.h}%`, borderRadius: `${d.s.r}% / ${d.s.r * (d.s.w / d.s.h) * d.ratio}%` }}>
        <span className="phone3d-clip">
          {src ? src.map((u, i) => <img key={u} src={u} alt="" className={i === index ? 'on' : ''} draggable={false} />) : children}
          <StatusBar device={device} dark={dark} />
        </span>
      </span>
      <img className="phone3d-frame" src={d.frame} alt="" draggable={false} />
      {label !== '' && <figcaption>{label ?? d.label}</figcaption>}
    </figure>
  );
}
