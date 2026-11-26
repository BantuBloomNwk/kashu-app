import { Receipt, type Line } from '../ui/Receipt.tsx';
import { KASHU_CUT, PRIZE_BONUS, PRIZE_INTEREST, money } from '../ui/money.ts';
import { me, ticketsOf, type State } from './store.ts';
import { explorer } from '../config.ts';
import { useEffect, useState } from 'react';
import { RELAY } from '../wallet/wallet.ts';

// Plain-words receipts for the things that happen to your money. Each ends with a link to check it on
// Solana; nobody needs that link to understand the receipt.
const EXPLORER = (a: string) => explorer('address', a);
export const VAULT_ID = '3jYUfoa788SJpFbbPS7vFxTNkWCRN1c4gx3rcgmH9GxH';
export const ROOMS_ID = '8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q';
export const VRF_ID = 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz';
const nameOf = (s: State, id: string) => (id === 'you' ? 'You' : s.friends.find((f) => f.id === id)?.name ?? id);

export function DrawReceipt({ s }: { s: State }) {
  const d = s.draw; if (!d) return null;
  const tickets = ticketsOf(s.friends);
  const n = tickets.length ? parseInt(d.proof.slice(0, 8), 16) % tickets.length : 0;
  const lit = s.friends.filter((f) => f.lit).length;
  const first = tickets.indexOf(d.winnerId) + 1, last = tickets.lastIndexOf(d.winnerId) + 1;
  const lines: Line[] = [
    { k: 'Room', v: s.roomName },
    { k: 'Draw', v: 'Friday, 8pm' },
    'rule',
    { k: 'Saved this week', v: `${lit} of ${s.friends.length} friends` },
    { k: 'Tickets in the draw', v: `${tickets.length}` },
    { k: `${nameOf(s, d.winnerId)} held`, v: first === last ? `ticket ${first}` : `tickets ${first} to ${last}` },
    { k: 'Random number picked', v: `ticket ${n + 1}` },
    'rule',
    { k: 'Winner', v: nameOf(s, d.winnerId), strong: true },
    { k: 'Interest the room earned', v: money(Math.round((PRIZE_INTEREST / (1 - KASHU_CUT)) * 100) / 100) },
    { k: `Kashu's ${Math.round(KASHU_CUT * 100)}%`, v: `-${money(Math.round((PRIZE_INTEREST / (1 - KASHU_CUT)) * KASHU_CUT * 100) / 100)}` },
    { k: 'Room\'s share of the interest', v: money(PRIZE_INTEREST) },
    { k: 'Friday bonus (sponsor)', v: money(PRIZE_BONUS) },
    { k: 'Prize', v: money(d.prize), strong: true },
    { k: 'Everyone\'s savings', v: 'Untouched' },
    { k: 'Paid to enter', v: 'Nothing' },
  ];
  return <Receipt title="Draw night receipt" sub="How this week's winner was picked" lines={lines} stamp="Fair draw" check={{ label: 'Check the random number on Solana', href: EXPLORER(VRF_ID) }} />;
}

export function SaveReceipt({ s }: { s: State }) {
  const h = s.history.find((x) => x.saved); if (!h) return null;
  const you = me(s);
  const lines: Line[] = [
    { k: 'Room', v: s.roomName },
    { k: 'When', v: h.label },
    'rule',
    { k: 'You saved', v: money(h.amount), strong: true },
    { k: 'Went into', v: 'Your own vault' },
    { k: 'Who can take it out', v: 'Only you' },
    { k: 'Fee', v: 'None' },
    { k: 'Streak', v: `${you.streak} week${you.streak === 1 ? '' : 's'} in a row` },
  ];
  return <Receipt title="Savings receipt" sub="Your last payday save" lines={lines} stamp="Saved" check={{ label: 'Check your vault on Solana', href: EXPLORER(VAULT_ID) }} />;
}

export function KeepReceipt() {
  const lines: Line[] = [
    { k: 'Your savings', v: 'In your own vault' },
    { k: 'Who can move them', v: 'Only you' },
    { k: 'Rooms, streaks, cheers', v: 'A fast lane by MagicBlock' },
    { k: 'The draw\'s number', v: 'Independent and checkable' },
    'rule',
    { k: 'Beta limit, per person', v: 'US$50' },
    { k: 'Beta limit, everyone', v: 'US$5,000' },
  ];
  return <Receipt title="How Kashu keeps it" sub="Where everything lives" lines={lines} check={{ label: 'Check the rooms on Solana', href: EXPLORER(ROOMS_ID) }} />;
}

/** A payment by Kashutag, in plain words. The Solana link is the last line, for anyone who wants to check. */
export function SendReceipt({ to, amount, fromWallet, fromSavings, roundedUp, sig, privately, at }: {
  to: string; amount: number; fromWallet: number; fromSavings: number; roundedUp: number; sig: string; privately: boolean; at: Date;
}) {
  // the enclave's hardware report, checked by Kashu's server against Intel's: the reason "private" is more than a word
  const [tee, setTee] = useState<{ verified: boolean; hardware?: string; status?: string } | null>(null);
  useEffect(() => { if (privately) fetch(`${RELAY}/agent/tee`).then((r) => r.json()).then(setTee, () => setTee({ verified: false })); }, [privately]);
  const lines: Line[] = [
    { k: 'To', v: to, strong: true },
    { k: 'When', v: at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) },
    'rule',
    { k: 'Amount', v: money(amount), strong: true },
    ...(privately ? [{ k: 'Paid from', v: 'Your private pocket' }] : [
      ...(fromWallet > 0 ? [{ k: 'From your wallet', v: money(fromWallet) }] : []),
      ...(fromSavings > 0 ? [{ k: 'From your savings', v: money(fromSavings) }] : []),
    ]),
    ...(roundedUp > 0 ? [{ k: 'Change saved (round-up)', v: money(roundedUp) }] : []),
    { k: 'Fee you paid', v: privately ? 'None (pocket to pocket is free)' : 'None (Kashu covered the network fee)' },
    'rule',
    { k: 'Status', v: privately ? 'Done, privately' : 'Done, on Solana' },
    { k: 'Who can see it', v: privately ? 'Only you and them' : 'Anyone who looks it up on Solana' },
    ...(privately ? [
      'rule' as const,
      { k: 'Where it ran', v: 'MagicBlock\'s private rollup, inside a sealed chip (a TEE)' },
      { k: 'The sealed chip', v: tee === null ? 'Checking…' : tee.verified ? `Verified genuine: ${tee.hardware}, ${tee.status === 'UpToDate' ? 'up to date' : tee.status}` : 'Could not be checked just now' },
      { k: 'Private record', v: `${sig.slice(0, 6)}…${sig.slice(-4)} (only you and them can look it up)` },
      { k: 'What stays public', v: 'Money going into or out of a pocket. Payments between pockets never show on Solana.' },
    ] : []),
  ];
  return <Receipt demo={false} title="Payment receipt" sub={privately ? 'Paid privately from your pocket' : 'Paid by Kashutag'} lines={lines} stamp={privately ? 'Private' : 'Paid'}
    check={privately ? { label: 'See the chip\'s report', href: `${RELAY}/agent/tee` } : { label: 'Check it on Solana', href: explorer('tx', sig) }} />;
}
