// Every error a saver sees goes through plain(): program errors, the relay, the network and the passkey prompt all become
// plain words. Messages Kashu writes itself are already plain and pass through. Anything unusual gets a calm general
// line, and the raw detail goes to the console for us.

const ROOMS_PROGRAM = '8wZZyrkF7eucjx9oqnoXecGs2ZNHEwo6mFMASgWYpb5q';

const TRY_AGAIN = 'Something went wrong and nothing changed. Please try again in a moment.';
const ODD = 'Something unusual went wrong and nothing changed. Please try again, and tell us if it keeps happening.';

// the programs' errors by name, in the order they're declared (Anchor numbers them from 6000)
const VAULT = ['Math', 'Paused', 'ZeroAmount', 'UserCap', 'TotalCap', 'CapTooHigh', 'BadDecimals', 'BadMix', 'BadRule', 'NotDue',
  'NothingToBuy', 'BadFloor', 'SwapTookWrongAmount', 'SwapPaidTooLittle', 'SwapAccountClash', 'NotAdmin', 'NotPendingAdmin',
  'NotUpgradeAuthority', 'Insufficient', 'PqRequired', 'PqAlreadyEnrolled', 'PqNotEnrolled', 'BadPqKey', 'PqLeafUsed',
  'BadPqSignature', 'WrongMint', 'WrongVenue', 'VenueMisbehaved', 'WrongShareAccount', 'BadPrice', 'StalePrice', 'UnsurePrice',
  'SavingsStillLent', 'BadVenueBounds', 'CutTooHigh', 'NotARoom', 'WrongPot', 'WrongTreasury', 'NothingToHarvest',
  'HarvestTouchedSavings', 'DrawNotSettled', 'PrizeAlreadyPaid', 'NotTheWinner', 'NotYourPocket', 'BadChore', 'NotTheAgent',
  'ChoreTooSoon', 'AgentCap', 'AgentDestination'];
const ROOMS = ['PairsExpected', 'BadPermission', 'BadSession', 'RoomFull', 'NotYourVault', 'NotYourSeat', 'WeekOver', 'WeekNotOver',
  'AlreadyCounted', 'NoNewSave', 'WrongRoom', 'SelfCheer', 'Overflow', 'NoTickets', 'DrawAlreadyAsked', 'NoDrawAsked', 'NotDrawn',
  'NotThisWeek', 'NotTheWinner', 'DrawNotSettled', 'BadQueue', 'NotAnOldRecord', 'BadViewer', 'AlreadySeated', 'TooManyReaders',
  'BadTag', 'ReservedTag', 'NotYourTag', 'TagTaken', 'BadPocket'];

// the ones a saver can meet, in their words
const SAY: Record<string, string> = {
  Paused: 'Saving is paused for a moment. Your money is safe, and taking it out still works.',
  ZeroAmount: 'Enter an amount above zero.',
  UserCap: 'That would take you over the savings limit for the beta.',
  TotalCap: 'Kashu\'s beta is full for now. Your savings are safe and still earning.',
  Insufficient: 'There isn\'t that much in your vault.',
  NotDue: 'This week\'s buy isn\'t due yet.',
  NothingToBuy: 'There\'s nothing to buy this week.',
  StalePrice: 'Prices are a little behind right now. Try again in a minute.',
  UnsurePrice: 'Prices are moving too fast right now. Try again in a minute.',
  SavingsStillLent: 'Your savings are still earning. Try again in a moment.',
  NotYourPocket: 'That isn\'t your private pocket.',
  ChoreTooSoon: 'That chore already ran this week.',
  AgentCap: 'That would go over the weekly limit you set for your agent.',
  AgentDestination: 'Your agent can only send money to your vault, your pocket, or people you named.',
  BadChore: 'That chore isn\'t set up.',
  RoomFull: 'This room is full (12 friends max).',
  NotYourVault: 'That isn\'t your vault.',
  NotYourSeat: 'You\'re not in this room on this device yet.',
  WeekOver: 'This week just ended. Your save counts toward next week.',
  AlreadyCounted: 'Your save is already counted this week.',
  NoNewSave: 'Save first, then your window lights up.',
  SelfCheer: 'You can\'t cheer yourself.',
  NoTickets: 'Nobody saved this week, so there\'s no draw.',
  BadTag: 'A Kashutag is 3 to 15 letters, numbers or _, and starts with a letter.',
  ReservedTag: 'That Kashutag is kept for Kashu. Try another.',
  NotYourTag: 'That isn\'t your Kashutag.',
  TagTaken: 'That Kashutag is taken. Try another.',
  BadPocket: 'That pocket key doesn\'t look right.',
  BadSession: 'Please sign in again.',
};

/** True when a message is already something a saver can read. */
// Kashu's own messages start with a capital; the relay's and libraries' start lowercase and use our internal words
const isPlain = (m: string) => m.length > 0 && m.length < 220 && /^[A-Z"'$]/.test(m) &&
  !/Error Code|custom program error|0x[0-9a-f]{2,}|InstructionError|Anchor|Program log|Custom|[{}[\]]|Simulation|TypeError|undefined|null|is not a function|Cannot read|[1-9A-HJ-NP-Za-km-z]{32,}/i.test(m);

function programError(text: string): string | null {
  const named = /Error Code: (\w+)/.exec(text)?.[1];
  if (named) return SAY[named] ?? ODD;
  const n = Number(/"Custom":\s*(\d+)/.exec(text)?.[1] ?? /custom program error: 0x([0-9a-f]+)/i.exec(text)?.[1]?.replace(/^/, '0x') ?? NaN);
  if (!Number.isFinite(n) || n < 6000) return null;
  const list = text.includes(`${ROOMS_PROGRAM} failed`) ? ROOMS : VAULT;
  const name = list[n - 6000];
  return name ? SAY[name] ?? ODD : null;
}

export function plain(e: unknown): string {
  const err = e as { message?: string; name?: string; logs?: string[] } | undefined;
  const message = String(err?.message ?? e ?? '');
  const text = `${message} ${(err?.logs ?? []).join(' ')}`;
  const said = (m: string) => { if (m !== message) console.warn('kashu:', message, err?.logs ?? ''); return m; };

  // the passkey prompt
  if (err?.name === 'NotAllowedError' || /NotAllowed|cancel+ed|user denied/i.test(message)) return said('No problem, nothing changed.');
  if (err?.name === 'InvalidStateError') return said('This passkey is already on this device.');

  // the programs
  const p = programError(text);
  if (p) return said(p);

  // the relay
  if (/too many requests/i.test(message)) return said('You\'re going a little fast. Wait a minute and try again.');
  if (/used today'?s free transactions/i.test(message)) return said('You\'ve used today\'s free actions. Try again tomorrow.');
  if (/free transactions are paused/i.test(message)) return said('Kashu is busy right now. Please try again later.');
  if (/invite/i.test(message) && /code/i.test(message)) return said(message);

  // money and timing
  if (/insufficient (funds|lamports)|insufficient balance|not enough/i.test(text)) return said('There isn\'t enough money for that.');
  if (/blockhash|expired|timed? ?out|took too long/i.test(text)) return said('That took too long and didn\'t go through. Nothing changed. Try again.');

  // the network
  if (/Failed to fetch|NetworkError|Load failed|network (error|request)|ERR_|ECONN|fetch failed|502|503|504/i.test(message)) {
    return said('Couldn\'t reach Kashu. Check your connection and try again.');
  }

  // Kashu's own messages are already plain
  if (isPlain(message)) return message;
  return said(text.trim() ? ODD : TRY_AGAIN);
}
