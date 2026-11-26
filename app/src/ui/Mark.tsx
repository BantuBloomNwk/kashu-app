// The kernel K. Flat inside the app (DESIGN.md); the glossy mark is for marketing pieces only.
export function Mark({ size = 40, tone = 'flat', label = 'Kashu' }: { size?: number; tone?: 'flat' | 'reverse' | 'mono' | 'glossy'; label?: string }) {
  const src = { flat: 'kashu-mark-flat.svg', reverse: 'kashu-mark-reverse.svg', mono: 'kashu-mark-mono.svg', glossy: 'kashu-mark.svg' }[tone];
  return <img src={`brand/${src}`} width={size} height={size} alt={label} style={{ width: size, height: size, objectFit: 'contain' }} />;
}

export function Wordmark({ height = 36, reverse = false }: { height?: number; reverse?: boolean }) {
  return <img src={`brand/${reverse ? 'kashu-lockup-reverse.svg' : 'kashu-lockup-flat.svg'}`} alt="Kashu" style={{ height, width: 'auto' }} />;
}

/** The draw night moon: a render of the real moon (NASA LRO colour map), a waxing crescent, with a soft glow. */
export function Moon({ size = 96, glow = true }: { size?: number; glow?: boolean }) {
  return (
    <span className={`moon ${glow ? 'has-glow' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <img src="objects/moon.webp" alt="" width={size} height={size} draggable={false} />
    </span>
  );
}

/** The sun, rendered: granulated surface, darker toward the edge, with a halo drawn by the page. */
export function Sun({ size = 120 }: { size?: number }) {
  return (
    <span className="sunr" style={{ width: size, height: size }} aria-hidden="true">
      <img src="objects/sun.webp" alt="" width={size} height={size} draggable={false} />
    </span>
  );
}
