// The app's state for the demo. One small store, read with useSyncExternalStore. When the app is wired
// to devnet (rooms + vault programs), these setters become transactions and the reads become account
// reads; the screens do not change.
import { useSyncExternalStore } from 'react';
import type { Friend } from '../ui/Wall.tsx';
import { PRIZE, local, weeklyDefault } from '../ui/money.ts';

export type DrawResult = { winnerId: string; prize: number; proof: string };
/** What the chain says, when the app is live: the person's wallet, vault, room, friends and the prize pot. */
export type LiveState = {
  wallet: string; vault: string; room: string | null;
  /** The saver's Kashutag, and the dollars sitting in their wallet (not yet saved). */
  tag: string | null; walletUsdc: number;
  /** The SHA-256 of the saver's profile photo (null: none), served by Kashu's relay. */
  avatar?: string | null;
  /** Round-up unit in dollars (0 = off) and the share of each save that buys SOL, in percent. */
  roundup?: number; assetPct?: number;
  /** What the weekly buy has bought so far: SOL held in the vault, buys done, and when the next one is due (unix s). */
  sol?: number; buys?: number; nextBuyAt?: number;
  /** Friday prizes paid to this wallet, in dollars (the keeper's tally of its own payments). */
  prizesWon?: number;
  /** Winnings not yet turned into SOL, and the weekly amount the saver chose for that (0 = off). */
  winningsLeft?: number; winningsWeekly?: number; roomName: string; week: number; saved: number; interest: number; pot: number; weekly: number;
  members: { owner: string; tag?: string | null; you: boolean; name: string; streak: number; lit: boolean; cheers?: number; plan?: number | null; avatar?: string | null }[];
  draw: { week: number; winner: string } | null;
  /** The room is on MagicBlock's private rollup: only its members' phones can read it. */
  private?: boolean;
  /** This phone isn't a reader of the private room yet (new phone, or a lost viewer key). */
  needsPhone?: boolean;
};
export type State = {
  started: boolean;
  roomName: string;
  weekly: number;
  friends: Friend[];
  balance: number;
  interest: number;
  prizes: number;
  history: { label: string; amount: number; saved: boolean }[];
  draw: DrawResult | null;
  drawSeen: boolean;
  calmDraw: boolean;
  share: { streak: boolean; saved: boolean; rank: boolean };
  live: LiveState | null;
};

const initial: State = {
  started: false,
  roomName: 'Payday crew',
  weekly: weeklyDefault,
  friends: [
    { id: 'ada', name: 'Ada', lit: true, streak: 4, pattern: 'louvre' },
    { id: 'tunde', name: 'Tunde', lit: true, streak: 6, pattern: 'panel' },
    { id: 'kemi', name: 'Kemi', lit: false, streak: 0, pattern: 'lattice' },
    { id: 'wanjiru', name: 'Wanjiru', lit: true, streak: 3, pattern: 'grid' },
    { id: 'you', name: 'You', lit: false, streak: 3, pattern: 'panel', you: true },
    { id: 'paolo', name: 'Paolo', lit: true, streak: 5, pattern: 'louvre' },
  ],
  balance: local(18000),
  interest: local(412),
  prizes: PRIZE,
  history: [
    { label: 'Last week', amount: weeklyDefault, saved: true },
    { label: '2 weeks ago', amount: Math.round(weeklyDefault * 1.25), saved: true },
    { label: '3 weeks ago', amount: weeklyDefault, saved: true },
    { label: '4 weeks ago', amount: 0, saved: false },
  ],
  draw: null,
  drawSeen: false,
  calmDraw: false,
  share: { streak: true, saved: true, rank: false },
  live: null,
};

let state: State = (() => {
  try { const s = sessionStorage.getItem('kashu.demo'); return s ? { ...initial, ...JSON.parse(s) } : initial; } catch { return initial; }
})();
const subs = new Set<() => void>();
function set(next: Partial<State>) {
  state = { ...state, ...next };
  try { sessionStorage.setItem('kashu.demo', JSON.stringify(state)); } catch { /* fine */ }
  subs.forEach((f) => f());
}
const PATTERNS = ['louvre', 'panel', 'lattice', 'grid'] as const;
/** Puts the chain's view into the same fields the screens already read. */
export function live(l: LiveState) {
  set({
    live: l, started: !!l.room, roomName: l.roomName, weekly: l.weekly || state.weekly, balance: l.saved, interest: l.interest, prizes: l.prizesWon ?? 0, draw: null, drawSeen: false,
    friends: l.members.map((m, i) => ({ id: m.you ? 'you' : m.owner, name: m.name, lit: m.lit, streak: m.streak, cheers: m.cheers, avatar: m.avatar, pattern: PATTERNS[i % PATTERNS.length], you: m.you || undefined })),
    history: [],
  });
}
export const useStore = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
/** You, in the room; a stand-in when the room can't be read yet (a new phone on a private room). */
export const me = (s: State): Friend => s.friends.find((f) => f.you) ?? { id: 'you', name: 'You', lit: false, streak: 0, pattern: 'panel', you: true };
/** Ticket list for the draw: each friend who saved this week, repeated once per week of streak (max 4). */
export const ticketsOf = (friends: Friend[]) => friends.filter((f) => f.lit).flatMap((f) => Array(Math.min(4, Math.max(1, f.streak))).fill(f.id) as string[]);

export const actions = {
  start(roomName: string, weekly: number) { set({ started: true, roomName: roomName || 'Payday crew', weekly }); },
  /** Saving this payday: the vault takes the amount; the room lights your window and grows the streak. */
  save(amount: number) {
    const you = me(state);
    if (you.lit) return;
    set({
      balance: Math.round((state.balance + amount) * 100) / 100,
      friends: state.friends.map((f) => (f.you ? { ...f, lit: true, streak: f.streak + 1 } : f)),
      history: [{ label: 'This week', amount, saved: true }, ...state.history],
    });
  },
  /** The draw's result is fixed before anything plays, so a refresh or a dropped connection lands on it. */
  draw() {
    if (state.draw) return state.draw;
    // the same rule the rooms program uses: every saver this week holds a numbered range of tickets
    // (one per week of streak, up to four); the random number picks one ticket
    const proof = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const tickets = ticketsOf(state.friends);
    const n = tickets.length ? parseInt(proof.slice(0, 8), 16) % tickets.length : 0;
    const winnerId = tickets[n] ?? 'ada';
    const d = { winnerId, prize: PRIZE, proof };
    set({ draw: d, prizes: winnerId === 'you' ? state.prizes + d.prize : state.prizes, balance: winnerId === 'you' ? state.balance + d.prize : state.balance });
    return d;
  },
  seenDraw() { set({ drawSeen: true }); },
  setCalm(calm: boolean) { set({ calmDraw: calm }); },
  setShare(k: keyof State['share'], v: boolean) { set({ share: { ...state.share, [k]: v } }); },
  withdraw(amount: number) {
    const all = amount >= state.balance;
    set({ balance: Math.max(0, Math.round((state.balance - amount) * 100) / 100), friends: all ? state.friends.map((f) => (f.you ? { ...f, streak: 0 } : f)) : state.friends });
  },
  reset() { try { sessionStorage.removeItem('kashu.demo'); } catch { /* fine */ } state = initial; subs.forEach((f) => f()); },
};
