// Date arithmetic on ISO 'YYYY-MM-DD' strings, done in UTC so there are no DST surprises.

export const toUtc = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
export const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
export const ymd = (iso) => ({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) });
export const makeDate = (y, m, d) => fromUtc(Date.UTC(y, m - 1, d));

const DAY = 86400000;
export const addDays = (iso, n) => fromUtc(toUtc(iso) + n * DAY);
export const diffDays = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY);
export const weekday = (iso) => new Date(toUtc(iso)).getUTCDay(); // 0 = Sunday
export const isWeekend = (iso) => {
  const w = weekday(iso);
  return w === 0 || w === 6;
};
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const isEndOfMonth = (iso) => {
  const { y, m, d } = ymd(iso);
  return d === daysInMonth(y, m);
};

/** Add calendar months, clamping to month end. With eom=true a month-end date stays on month end. */
export function addMonths(iso, n, { eom = false } = {}) {
  const { y, m, d } = ymd(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  const dim = daysInMonth(ny, nm);
  const nd = eom && isEndOfMonth(iso) ? dim : Math.min(d, dim);
  return makeDate(ny, nm, nd);
}

export const minDate = (a, b) => (a <= b ? a : b);
export const maxDate = (a, b) => (a >= b ? a : b);

/** n-th weekday (0=Sun) of a month; n = -1 for the last one. */
export function nthWeekday(y, m, wd, n) {
  if (n > 0) {
    const first = weekday(makeDate(y, m, 1));
    const day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    return makeDate(y, m, day);
  }
  const dim = daysInMonth(y, m);
  const last = weekday(makeDate(y, m, dim));
  return makeDate(y, m, dim - ((last - wd + 7) % 7));
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
export function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return makeDate(y, month, day);
}
