import { useStore } from './store.ts';
import { DrawReceipt, KeepReceipt, ROOMS_ID, SaveReceipt, VAULT_ID, VRF_ID } from './receipts.tsx';
import { explorer } from '../config.ts';

// How it works, as receipts in plain words. The raw addresses are still here, folded away, for anyone
// who wants them.
const PROGRAMS = [
  ['Savings vault', VAULT_ID],
  ['Rooms (MagicBlock Ephemeral Rollup)', ROOMS_ID],
  ['Draw randomness (MagicBlock VRF)', VRF_ID],
];
export function Advanced() {
  const s = useStore();
  return (
    <div className="advanced">
      <h1>How it works</h1>
      <p className="adv-lede">Everything that happens to your money comes with a receipt. You never need the technical part; it's at the bottom for anyone who wants to check.</p>
      <div className="receipts">
        <SaveReceipt s={s} />
        {s.draw ? <DrawReceipt s={s} /> : <p className="adv-lede">This week's draw receipt prints on Friday at 8pm.</p>}
        <KeepReceipt />
      </div>
      <details className="adv-tech">
        <summary>For the technical: program addresses (devnet beta)</summary>
        <ul className="ledger">
          {PROGRAMS.map(([n, a]) => (
            <li key={a}><span>{n}</span><a href={explorer('address', a)} target="_blank" rel="noopener noreferrer"><code>{a.slice(0, 6)}...{a.slice(-6)}</code></a></li>
          ))}
        </ul>
      </details>
      <a className="btn btn-ghost" href="#app-room">Back to the room</a>
    </div>
  );
}
