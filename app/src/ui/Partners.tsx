import { useId } from 'react';
import mb from './magicblock.svg?raw';

/** The Solana logomark, in its own gradient (as on the Oira landing page). */
export function SolanaMark({ height = 18 }: { height?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 397.7 311.7" height={height} role="img" aria-label="Solana" style={{ width: 'auto', display: 'block' }}>
      <defs>
        <linearGradient id={`sol${id}`} gradientUnits="userSpaceOnUse" x1="360.88" y1="351.46" x2="141.21" y2="-69.29">
          <stop offset="0" stopColor="#00FFA3" /><stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <g fill={`url(#sol${id})`}>
        <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
        <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
        <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
      </g>
    </svg>
  );
}

/** MagicBlock's own logo (symbol and wordmark), in the surrounding text colour. */
export function MagicBlockLogo({ height = 18 }: { height?: number }) {
  return <span className="mb-logo" role="img" aria-label="MagicBlock" style={{ height, display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: mb }} />;
}

export function PoweredBy() {
  return (
    <span className="powered">
      <span className="powered-label">Powered by</span>
      <span className="powered-brand"><SolanaMark height={16} /><span>Solana</span></span>
      <span className="powered-x" aria-hidden="true">×</span>
      <MagicBlockLogo height={17} />
    </span>
  );
}
