// Kashu's sentences for the signing review (@readback/review): every vault and rooms instruction, read back
// in plain words before the passkey prompt. Admin instructions are flagged: the app never asks a saver to
// sign one. Amounts use the mints the app passes in.
import { VAULT_PROGRAM, ROOMS_PROGRAM } from './vault.mjs';

// sha256("global:<name>")[0..8] for each instruction, precomputed so this runs in a browser (tests/review.mjs checks them)
export const DISC = {
  request_viewer: '2b8b79d1328bd3f5',
  apply_viewer: 'd3cd3d10b6fa21a0',
  request_join: '46a46f87e4ac61ba',
  admit: 'c0a9048af85ab82f',
  open_result: '1cfb6b151974cee4',
  delegate_result: 'c9c63345f1ad4b03',
  commit_result: '2d49e0de3043bfb9',
  open_vault: 'b5f8e44306af25a7',
  deposit: 'f223c68952e1f2b6',
  agent_run: 'a09203454e4b84e9',
  set_agent: '9a4a795b891365a6',
  save_private: '71d7acce8a85d1e8',
  set_rule: 'ed94b2ac7f467267',
  note_spend: 'ec0033b55fa643ae',
  lend: '59224ba87a2fb92d',
  unlend: 'e6806c213b52612d',
  withdraw_cash: '8b47670a1f2acdc2',
  withdraw_asset: '4ec1cf7d3fc1810c',
  link_pot: 'e61aaee034b4a451',
  unlink_pot: '94ed684341aa1e70',
  harvest: 'e4f11fb635a93bc7',
  pay_prize: '50826a1cb18ae21a',
  set_dca: 'acf29275251846fd',
  dca_buy: '34bcf1206e521711',
  prepare_buy: '78a32cc36c1934f1',
  weekly_buy: 'dfd3ab41c1735c6b',
  open_pot: 'c77d84945d370b91',
  enroll_pq: 'ae8d34fdae36df2d',
  rotate_pq: '525a27b9eaa796b9',
  withdraw_pq: '2eabffc46fe78319',
  initialize: 'afaf6d1f0d989bed',
  set_paused: '5b3c7dc0b0e1a6da',
  set_caps: 'adcc2f7d66c0f0a1',
  set_floor_rate: '622d41e57a2fe313',
  propose_admin: '79d6c7d4572775ea',
  accept_admin: '702a2d5a74b50daa',
  set_venue: '2846e72cad70f719',
  init_prize: '5241c71ca910cd44',
  set_prize_cut: '147d6aa9a99a52c3',
  create_room: '82a62002f778b235',
  join_room: '5fe8bc517c824e8b',
  check_in: 'd1fd04d9faf1cf32',
  cheer: '177f0f28312a1558',
  set_session: '9c877e6fb8cec28d',
  next_week: 'ff4798089fcd2319',
  request_draw: '16b408512f15569f',
  settle_draw: 'af9a4b1e76756bc2',
  delegate_room: '27067a46414ca61a',
  delegate_member: '49c3b1dbb688e68f',
  share_room: '5b4d61cbc1bfb3a9',
  settle_room: 'b36b790564a21b68',
  settle_member: '99a4a086f6c5a14a',
  set_avatar: '232ce6bf39c7b8f8',
  set_pocket: '8cb69f58f1060ef1',
  change_tag: '13fdc2e95f339b07',
  claim_tag: '52ce4eba1a84a59c',
  upgrade_member: '094ba218665bcc45',
};
const disc = (name) => DISC[name];
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u64 = (d, o) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const i64 = (d, o) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(o, true);
const u16 = (d, o) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
import { base58 } from '@readback/review';
/** Who the session key belongs to: a name the app knows (Kashu's keeper), or the address. */
const counter = (d, o) => o.names?.[base58(d.subarray(8, 40))] ?? short(base58(d.subarray(8, 40)));
/** The vault reads this amount as "everything in the account". */
const ALL = 18446744073709551615n;
const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));
const usd = (raw) => { const n = Number(raw) / 1e6; return `${n.toFixed(n % 1 ? 2 : 0)} USDC`; };
const sol = (raw) => `${(Number(raw) / 1e9).toLocaleString('en', { maximumFractionDigits: 6 })} SOL`;
const acct = (ix, i) => ix.accounts?.[i]?.address;

const VAULT = {
  open_vault: () => ({ text: 'Open your savings vault (only you can take money out of it)', tone: 'info' }),
  deposit: (d) => ({ text: `Save ${usd(u64(d, 8))} into your vault`, tone: 'info' }),
  set_agent: (d) => {
    const agent = base58(d.subarray(8, 40));
    if (agent === '11111111111111111111111111111111') return { text: 'Turn your agent off: it can run no more chores', tone: 'info' };
    const kinds = { 1: 'save', 2: 'save privately', 3: 'pay someone you named', 4: 'remind you' };
    const jobs = [0, 1, 2, 3].map((i) => { const o = 176 + i * 20; return d[o] ? `${kinds[d[o]] ?? 'an unknown chore'}${d[o] !== 4 ? ` ${usd(u64(d, o + 1))}` : ''}` : null; }).filter(Boolean);
    return { text: `Let your agent ${jobs.join(', ')} each week, up to ${usd(u64(d, 40))} a week in all, plus Kashu's 1 cent fee each time a chore runs. It can't take money out of your vault`, tone: 'warn' };
  },
  agent_run: () => ({ text: 'Your agent runs one of the chores you set', tone: 'info' }),
  save_private: (d) => ({ text: `Save ${usd(u64(d, 8))} into your private pocket (it counts as this week's save; the balance stays private)`, tone: 'info' }),
  set_rule: (d) => ({ text: `Set your plan: ${usd(u64(d, 8))} a week, ${u16(d, 24) / 100}% of it into SOL, ${u64(d, 16) > 0n ? `payments rounded up to the next ${usd(u64(d, 16))} with the change saved` : 'no round-ups'}`, tone: 'info' }),
  note_spend: (d) => ({ text: `Round up a spend of ${usd(u64(d, 8))} into savings`, tone: 'info' }),
  lend: (d) => ({ text: `Put ${usd(u64(d, 8))} of your savings to work on Jupiter Lend. It stays in your vault`, tone: 'info' }),
  unlend: (d) => ({ text: `Bring ${usd(u64(d, 8))} back from Jupiter Lend into your vault`, tone: 'info' }),
  withdraw_cash: (d, ix, o) => ({ text: `Take ${u64(d, 8) === ALL ? 'everything' : usd(u64(d, 8))} out of your vault to ${o.names?.[acct(ix, 5)] ?? short(acct(ix, 5))}`, tone: (o.mine ?? []).includes(acct(ix, 5)) ? 'info' : 'danger' }),
  withdraw_asset: (d, ix, o) => ({ text: `Take ${u64(d, 8) === ALL ? 'all your SOL' : sol(u64(d, 8))} out of your vault to ${o.names?.[acct(ix, 6)] ?? short(acct(ix, 6))}`, tone: (o.mine ?? []).includes(acct(ix, 6)) ? 'info' : 'danger' }),
  link_pot: (d, ix, o) => ({ text: `Let your savings' interest feed your room's Friday prize (Kashu keeps ${o.cutPercent ?? 10}% of it). Your savings never go in`, tone: 'info' }),
  unlink_pot: () => ({ text: 'Stop feeding the Friday prize. All your interest stays yours', tone: 'info' }),
  harvest: () => ({ text: 'Move a saver\'s interest into their room\'s prize', tone: 'info' }),
  pay_prize: () => ({ text: 'Pay this week\'s prize to the winner\'s vault', tone: 'info' }),
  set_dca: (d) => ({ text: u64(d, 8) > 0n ? `Turn ${usd(u64(d, 8))} of your prize winnings into SOL each week. Your own savings stay as they are` : 'Stop turning your winnings into SOL', tone: 'info' }),
  dca_buy: () => ({ text: 'Turn this week\'s share of your prize winnings into SOL', tone: 'info' }),
  prepare_buy: () => ({ text: 'Bring back from lending what this week\'s buy needs', tone: 'info' }),
  weekly_buy: () => ({ text: 'Run this week\'s planned SOL buy at a checked price', tone: 'info' }),
  open_pot: () => ({ text: 'Open your room\'s prize pot', tone: 'info' }),
  enroll_pq: () => ({ text: 'Add a backup key that will be the only way to take money out', tone: 'warn' }),
  rotate_pq: () => ({ text: 'Replace your vault\'s backup key', tone: 'warn' }),
  withdraw_pq: () => ({ text: 'Take money out with your backup key', tone: 'warn' }),
};
const ADMIN = ['initialize', 'set_paused', 'set_caps', 'set_floor_rate', 'propose_admin', 'accept_admin', 'set_venue', 'init_prize', 'set_prize_cut'];

const ROOMS = {
  create_room: (d) => ({ text: `Start the room "${new TextDecoder().decode(d.subarray(16, 40)).replace(/\0+$/, '')}"`, tone: 'info' }),
  join_room: (d, ix, o) => ({ text: `Join this room, and let ${counter(d, o)} count your saves in it until ${new Date(Number(i64(d, 40)) * 1000).toDateString()} (it can't move money)`, tone: 'info' }),
  check_in: () => ({ text: 'Count this week\'s save in your room', tone: 'info' }),
  cheer: () => ({ text: 'Cheer a friend', tone: 'info' }),
  set_session: (d, ix, o) => ({ text: `Let ${counter(d, o)} keep counting your saves until ${new Date(Number(i64(d, 40)) * 1000).toDateString()} (it can't move money)`, tone: o.names?.[base58(d.subarray(8, 40))] ? 'info' : 'warn' }),
  next_week: () => ({ text: 'Start the room\'s next week', tone: 'info' }),
  request_draw: () => ({ text: 'Ask for this week\'s random draw', tone: 'info' }),
  settle_draw: () => ({ text: 'Settle this week\'s draw', tone: 'info' }),
  delegate_room: () => ({ text: 'Move the room to the private rollup', tone: 'info' }),
  delegate_member: () => ({ text: 'Move your place in the room to the private rollup', tone: 'info' }),
  share_room: () => ({ text: 'Let the room\'s members (and only them) see the room', tone: 'info' }),
  settle_room: () => ({ text: 'Bring the room back from the private rollup', tone: 'info' }),
  request_join: (d, ix, o) => ({ text: `Ask to join this private room, and let ${counter(d, o)} count your saves in it until ${new Date(Number(i64(d, 40)) * 1000).toDateString()} (it can't move money)`, tone: 'info' }),
  admit: () => ({ text: 'Give a friend their seat in the room', tone: 'info' }),
  open_result: () => ({ text: 'Open the room\'s draw result', tone: 'info' }),
  settle_member: () => ({ text: 'Bring your place in the room back from the private rollup', tone: 'info' }),
  request_viewer: () => ({ text: 'Let this phone see your private room instead of your old one (it can only look, never move money)', tone: 'info' }),
  apply_viewer: () => ({ text: 'Give a member the phone they asked for', tone: 'info' }),
  upgrade_member: () => ({ text: 'Bring an older room membership up to date', tone: 'info' }),
  set_avatar: (d) => ({ text: d.subarray(8, 40).every((x) => x === 0) ? 'Remove your profile photo' : 'Set your profile photo (friends see it next to your Kashutag)', tone: 'info' }),
  set_pocket: (d) => ({ text: `Name ${short(base58(d.subarray(8, 40)))} as your private pocket, so friends paying your Kashutag can pay you privately`, tone: 'info' }),
  claim_tag: (d) => ({ text: `Claim your Kashutag $${new TextDecoder().decode(d.subarray(8, 23)).replace(/\0+$/, '')}: friends can send you money with it`, tone: 'info' }),
  change_tag: (d) => ({ text: `Change your Kashutag to $${new TextDecoder().decode(d.subarray(8, 23)).replace(/\0+$/, '')} (the old one is let go)`, tone: 'info' }),
};

function decoder(name, table, admin = []) {
  const byDisc = Object.fromEntries([...Object.keys(table), ...admin].map((n) => [disc(n), n]));
  return {
    name,
    line(ix, o) {
      const d = ix.data, n = byDisc[hex(d.subarray(0, 8))];
      if (!n) return { text: `A ${name} action this review cannot read`, tone: 'warn' };
      if (admin.includes(n)) return { text: `An admin action (${n.replace(/_/g, ' ')}). Kashu never asks a saver to sign this.`, tone: 'danger' };
      return table[n](d, ix, o);
    },
  };
}

export const KASHU_DECODERS = {
  [VAULT_PROGRAM]: decoder('Kashu vault', VAULT, ADMIN),
  [ROOMS_PROGRAM]: decoder('Kashu rooms', ROOMS),
};
