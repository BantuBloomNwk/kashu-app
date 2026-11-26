// Money in the rider's own currency. The demo picks it from the browser's region; the real app uses
// the account's country. Amounts are whole units (no cents on screen for savings this size).
export type Country = 'NG' | 'KE' | 'MY' | 'PH' | 'US';
const CUR: Record<Country, { code: string; locale: string; weekly: number }> = {
  NG: { code: 'NGN', locale: 'en-NG', weekly: 2000 },
  KE: { code: 'KES', locale: 'en-KE', weekly: 200 },
  MY: { code: 'MYR', locale: 'en-MY', weekly: 20 },
  PH: { code: 'PHP', locale: 'en-PH', weekly: 100 },
  US: { code: 'USD', locale: 'en-US', weekly: 5 },
};
export function guessCountry(): Country {
  const r = (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] ?? '').toUpperCase();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (r === 'NG' || tz === 'Africa/Lagos') return 'NG';
  if (r === 'KE' || tz === 'Africa/Nairobi') return 'KE';
  if (r === 'MY' || tz === 'Asia/Kuala_Lumpur') return 'MY';
  if (r === 'PH' || tz === 'Asia/Manila') return 'PH';
  return 'US';
}
export const country: Country = (() => {
  const q = new URLSearchParams(location.search).get('cc')?.toUpperCase();
  return (q && q in CUR ? q : guessCountry()) as Country;
})();
export const weeklyDefault = CUR[country].weekly;
/** Scale a demo amount written in naira-ish units into the local currency's everyday size. */
export const local = (ngnAmount: number) => Math.round((ngnAmount / 2000) * CUR[country].weekly * 100) / 100;
// The live app holds USDC, so it shows dollars until it can convert at a real exchange rate.
let dollars = false;
export function showDollars(on: boolean) { dollars = on; }
export function money(n: number) {
  const c = dollars ? CUR.US : CUR[country];
  return new Intl.NumberFormat(c.locale, { style: 'currency', currency: c.code, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
}

// Honest demo prize. A room of six with about US$270 saved, lent at a conservative 4.5% a year, earns
// about US$0.23 a week; Kashu keeps 10% of the interest (the program's ceiling, to be lowered later),
// so the room's share is about US$0.21. The
// Friday bonus (sponsors, or Kashu at launch) is never from anyone's savings. Units: 400 = US$1.
export const LEND_RATE = 0.045;
export const KASHU_CUT = 0.1;
export const PRIZE_INTEREST = local(84);
export const PRIZE_BONUS = local(800);
export const PRIZE = Math.round((PRIZE_INTEREST + PRIZE_BONUS) * 100) / 100;
