// Business-day calendars used for settlement dates and payment-date adjustment.
//
// These are the Terminal's own rule-based calendars, used until Shaffer MarketData supplies
// market calendars:
//
//   US       US equity markets (NYSE rules)
//   USBOND   US bond market (SIFMA recommendations)
//   USD      US dollar payments (Federal Reserve holidays)
//   UK       London markets and sterling payments (England and Wales bank holidays)
//   TARGET   euro payments (TARGET2 closing days); also Euronext's trading holidays
//   JP       Tokyo markets and yen payments (Japanese national holidays, 31 Dec to 3 Jan)
//   CA       Toronto markets and Canadian dollar payments
//   WEEKEND  Saturdays and Sundays only: an explicit fallback for a market with no calendar here
//   ALLDAYS  every calendar day (24/7 markets)
//
// Rule-based calendars cannot know one-off closures (a state funeral, a weather closure, a newly
// declared holiday). Those are added by hand as extra holidays (Settings) until the data service
// supplies them. Whenever a date is computed on WEEKEND for want of a real calendar, the caller is
// told so (see calendarInfo in products/security.js) and says so on screen: nothing falls back to
// weekends silently.
//
// A joint calendar is written 'A+B' and is open only when every member is open.

import { addDays, easterSunday, isWeekend, makeDate, nthWeekday, weekday, ymd } from './dates.js';

const holidayCache = new Map();
const extraHolidays = new Map(); // calendar id -> Set of ISO dates entered by hand

function observed(iso, { saturdayToFriday = true } = {}) {
  const w = weekday(iso);
  if (w === 0) return addDays(iso, 1);
  if (w === 6) return saturdayToFriday ? addDays(iso, -1) : null;
  return iso;
}
/** Monday after a weekend holiday (UK and Canadian substitute days). */
const mondayAfter = (iso) => (weekday(iso) === 6 ? addDays(iso, 2) : weekday(iso) === 0 ? addDays(iso, 1) : iso);

function cached(key, build) {
  let set = holidayCache.get(key);
  if (!set) { set = build(); holidayCache.set(key, set); }
  return set;
}

function usHolidays(y, bond) {
  return cached(`${bond ? 'B' : 'E'}${y}`, () => {
    const set = new Set();
    const add = (d) => d && set.add(d);
    // New Year's Day: NYSE does not close on the preceding Friday when Jan 1 is a Saturday.
    add(observed(makeDate(y, 1, 1), { saturdayToFriday: false }));
    add(nthWeekday(y, 1, 1, 3)); // Martin Luther King Jr. Day
    add(nthWeekday(y, 2, 1, 3)); // Washington's Birthday
    add(addDays(easterSunday(y), -2)); // Good Friday
    add(nthWeekday(y, 5, 1, -1)); // Memorial Day
    if (y >= 2022) add(observed(makeDate(y, 6, 19))); // Juneteenth
    add(observed(makeDate(y, 7, 4)));
    add(nthWeekday(y, 9, 1, 1)); // Labor Day
    add(nthWeekday(y, 11, 4, 4)); // Thanksgiving
    add(observed(makeDate(y, 12, 25)));
    if (bond) {
      add(nthWeekday(y, 10, 1, 2)); // Columbus Day
      add(observed(makeDate(y, 11, 11))); // Veterans Day
    }
    return set;
  });
}

/** Federal Reserve holidays. A Saturday holiday is not moved to Friday; Good Friday is a banking day. */
function fedHolidays(y) {
  return cached(`F${y}`, () => {
    const set = new Set();
    const add = (d) => d && set.add(d);
    const fixed = (m, d) => add(observed(makeDate(y, m, d), { saturdayToFriday: false }));
    fixed(1, 1);
    add(nthWeekday(y, 1, 1, 3));
    add(nthWeekday(y, 2, 1, 3));
    add(nthWeekday(y, 5, 1, -1));
    if (y >= 2021) fixed(6, 19);
    fixed(7, 4);
    add(nthWeekday(y, 9, 1, 1));
    add(nthWeekday(y, 10, 1, 2));
    fixed(11, 11);
    add(nthWeekday(y, 11, 4, 4));
    fixed(12, 25);
    return set;
  });
}

/** England and Wales bank holidays (London Stock Exchange closing days). */
function ukHolidays(y) {
  return cached(`UK${y}`, () => {
    const set = new Set();
    const easter = easterSunday(y);
    set.add(mondayAfter(makeDate(y, 1, 1)));
    set.add(addDays(easter, -2)); // Good Friday
    set.add(addDays(easter, 1)); // Easter Monday
    set.add(nthWeekday(y, 5, 1, 1)); // Early May bank holiday
    set.add(nthWeekday(y, 5, 1, -1)); // Spring bank holiday
    set.add(nthWeekday(y, 8, 1, -1)); // Summer bank holiday
    // Christmas Day and Boxing Day, each with its substitute when it falls on a weekend.
    const xmas = makeDate(y, 12, 25), w = weekday(xmas);
    if (w === 6) { set.add(makeDate(y, 12, 27)); set.add(makeDate(y, 12, 28)); } // Sat, Sun -> Mon, Tue
    else if (w === 0) { set.add(makeDate(y, 12, 26)); set.add(makeDate(y, 12, 27)); } // Sun, Mon -> Mon, Tue
    else if (w === 5) { set.add(xmas); set.add(makeDate(y, 12, 28)); } // Fri, Sat -> Fri, Mon
    else { set.add(xmas); set.add(makeDate(y, 12, 26)); }
    return set;
  });
}

/** TARGET2 closing days. */
function targetHolidays(y) {
  return cached(`T${y}`, () => {
    const easter = easterSunday(y);
    return new Set([makeDate(y, 1, 1), addDays(easter, -2), addDays(easter, 1), makeDate(y, 5, 1), makeDate(y, 12, 25), makeDate(y, 12, 26)]);
  });
}

/** Japanese national holidays, with substitute and bridge days, plus the 31 Dec to 3 Jan market closure. */
function jpHolidays(y) {
  return cached(`JP${y}`, () => {
    const eq = (base) => Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    const national = [
      makeDate(y, 1, 1), nthWeekday(y, 1, 1, 2), makeDate(y, 2, 11), makeDate(y, 2, 23), makeDate(y, 3, eq(20.8431)),
      makeDate(y, 4, 29), makeDate(y, 5, 3), makeDate(y, 5, 4), makeDate(y, 5, 5), nthWeekday(y, 7, 1, 3), makeDate(y, 8, 11),
      nthWeekday(y, 9, 1, 3), makeDate(y, 9, eq(23.2488)), nthWeekday(y, 10, 1, 2), makeDate(y, 11, 3), makeDate(y, 11, 23),
    ];
    const set = new Set(national);
    // A holiday on a Sunday moves to the next day that is not itself a holiday.
    for (const d of national) {
      if (weekday(d) !== 0) continue;
      let sub = addDays(d, 1);
      while (set.has(sub)) sub = addDays(sub, 1);
      set.add(sub);
    }
    // A weekday between two holidays is a holiday too.
    for (const d of national) {
      const mid = addDays(d, 1);
      if (!set.has(mid) && set.has(addDays(d, 2)) && weekday(mid) !== 0) set.add(mid);
    }
    set.add(makeDate(y, 1, 2)); set.add(makeDate(y, 1, 3)); set.add(makeDate(y, 12, 31));
    return set;
  });
}

/** Toronto Stock Exchange closing days. */
function caHolidays(y) {
  return cached(`CA${y}`, () => {
    const set = new Set();
    set.add(mondayAfter(makeDate(y, 1, 1)));
    set.add(nthWeekday(y, 2, 1, 3)); // Family Day
    set.add(addDays(easterSunday(y), -2)); // Good Friday
    let v = makeDate(y, 5, 24); // Victoria Day: the Monday before 25 May
    while (weekday(v) !== 1) v = addDays(v, -1);
    set.add(v);
    set.add(mondayAfter(makeDate(y, 7, 1))); // Canada Day
    set.add(nthWeekday(y, 8, 1, 1)); // Civic Holiday
    set.add(nthWeekday(y, 9, 1, 1)); // Labour Day
    set.add(nthWeekday(y, 10, 1, 2)); // Thanksgiving
    const xmas = makeDate(y, 12, 25), w = weekday(xmas);
    if (w === 6) { set.add(makeDate(y, 12, 27)); set.add(makeDate(y, 12, 28)); } else if (w === 0) { set.add(makeDate(y, 12, 26)); set.add(makeDate(y, 12, 27)); } else if (w === 5) { set.add(xmas); set.add(makeDate(y, 12, 28)); } else { set.add(xmas); set.add(makeDate(y, 12, 26)); }
    return set;
  });
}

const RULES = { US: (y) => usHolidays(y, false), USBOND: (y) => usHolidays(y, true), USD: fedHolidays, UK: ukHolidays, TARGET: targetHolidays, JP: jpHolidays, CA: caHolidays };

export const CALENDARS = {
  US: { id: 'US', label: 'US equity markets (NYSE rules)', approximate: false },
  USBOND: { id: 'USBOND', label: 'US bond market (SIFMA rules)', approximate: false },
  USD: { id: 'USD', label: 'US dollar payments (Federal Reserve holidays)', approximate: false },
  UK: { id: 'UK', label: 'London markets and sterling payments (England and Wales bank holidays)', approximate: false },
  TARGET: { id: 'TARGET', label: 'Euro payments (TARGET2 closing days)', approximate: false },
  JP: { id: 'JP', label: 'Tokyo markets and yen payments (Japanese national holidays)', approximate: false },
  CA: { id: 'CA', label: 'Toronto markets and Canadian dollar payments', approximate: false },
  WEEKEND: { id: 'WEEKEND', label: 'Weekends only: no holiday calendar for this market', approximate: true },
  ALLDAYS: { id: 'ALLDAYS', label: 'Every calendar day (24/7 markets)', approximate: false },
};

/** Payment calendar of a currency, or null when the Terminal has none (the caller must say so). */
export const CURRENCY_CALENDAR = { USD: 'USD', EUR: 'TARGET', GBP: 'UK', JPY: 'JP', CAD: 'CA' };
/** Market calendar by listing-venue country (ISO 3166 alpha-2). Euro-area venues use TARGET days. */
const EURO_AREA = ['DE', 'FR', 'NL', 'BE', 'IT', 'ES', 'PT', 'IE', 'AT', 'FI', 'LU', 'GR'];
export const COUNTRY_CALENDAR = { US: 'US', GB: 'UK', UK: 'UK', JP: 'JP', CA: 'CA', ...Object.fromEntries(EURO_AREA.map((c) => [c, 'TARGET'])) };
export const isEuroAreaVenue = (country) => EURO_AREA.includes(String(country || '').toUpperCase());

/** Replace the hand-entered extra holidays: { calendarId: ['YYYY-MM-DD', ...] }. */
export function setExtraHolidays(map) {
  extraHolidays.clear();
  for (const [cal, dates] of Object.entries(map || {})) extraHolidays.set(cal, new Set(dates));
}
export const getExtraHolidays = () => Object.fromEntries([...extraHolidays].map(([k, v]) => [k, [...v].sort()]));

/** Holidays of one calendar in one year (weekends excluded), for display. */
export function holidaysOf(cal, y) {
  const rule = RULES[cal] ? [...RULES[cal](y)] : [];
  const extra = [...(extraHolidays.get(cal) || [])].filter((d) => d.startsWith(String(y)));
  return [...new Set([...rule, ...extra])].filter((d) => !isWeekend(d)).sort();
}

export function isBusinessDay(iso, cal = 'US') {
  if (cal.includes('+')) return cal.split('+').every((c) => isBusinessDay(iso, c));
  if (cal === 'ALLDAYS') return true;
  if (isWeekend(iso)) return false;
  if (extraHolidays.get(cal)?.has(iso)) return false;
  const rule = RULES[cal];
  return rule ? !rule(ymd(iso).y).has(iso) : true;
}

/**
 * Spot value date of a currency pair: `days` good days ahead, where a day counts only if it is a
 * business day for both currencies (US dollar holidays do not interrupt the count), and the value
 * date itself must be a business day for both currencies and for the US dollar.
 * Returns the date and the currencies for which no payment calendar exists.
 */
export function fxValueDate(tradeDate, base, quote, days = 2) {
  const missing = [base, quote].filter((c) => !CURRENCY_CALENDAR[c]);
  const cals = [base, quote].map((c) => CURRENCY_CALENDAR[c] || 'WEEKEND');
  const counting = cals.filter((c) => c !== 'USD');
  let d = tradeDate, left = days;
  while (left > 0) {
    d = addDays(d, 1);
    if (!isWeekend(d) && counting.every((c) => isBusinessDay(d, c))) left--;
  }
  while (!(cals.every((c) => isBusinessDay(d, c)) && isBusinessDay(d, 'USD'))) d = addDays(d, 1);
  return { date: d, calendar: [...new Set([...cals, 'USD'])].join('+'), missing };
}

export function nextBusinessDay(iso, cal = 'US') {
  let d = addDays(iso, 1);
  while (!isBusinessDay(d, cal)) d = addDays(d, 1);
  return d;
}

export function prevBusinessDay(iso, cal = 'US') {
  let d = addDays(iso, -1);
  while (!isBusinessDay(d, cal)) d = addDays(d, -1);
  return d;
}

/** Add n business days (n may be negative). n = 0 returns iso rolled forward to a business day. */
export function addBusinessDays(iso, n, cal = 'US') {
  let d = iso;
  if (n === 0) {
    while (!isBusinessDay(d, cal)) d = addDays(d, 1);
    return d;
  }
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    d = addDays(d, step);
    if (isBusinessDay(d, cal)) left--;
  }
  return d;
}

/** Business-day adjustment conventions: none | following | modified-following | preceding. */
export function adjust(iso, convention = 'following', cal = 'US') {
  if (convention === 'none' || isBusinessDay(iso, cal)) return iso;
  if (convention === 'preceding') return prevBusinessDay(iso, cal);
  const f = nextBusinessDay(iso, cal);
  if (convention === 'modified-following' && f.slice(0, 7) !== iso.slice(0, 7)) return prevBusinessDay(iso, cal);
  return f;
}

/** Most recent business day on or before iso. */
export function onOrBefore(iso, cal = 'US') {
  return isBusinessDay(iso, cal) ? iso : prevBusinessDay(iso, cal);
}

/** Third Friday of a month (standard monthly listed-option expiration). */
export const thirdFriday = (y, m) => nthWeekday(y, m, 5, 3);

// ---- calendar ids, joint calendars and what to say about them -------------------------------------------

/** The member calendars of an id ('US' -> ['US'], 'JP+USD' -> ['JP', 'USD']). */
export const calendarParts = (id) => String(id || '').split('+').map((p) => p.trim().toUpperCase()).filter(Boolean);

/** Members of an id that are not calendars the Terminal has. An unknown member is never treated as "weekends only" silently. */
export const unknownCalendars = (id) => calendarParts(id).filter((p) => !CALENDARS[p]);
export const isKnownCalendar = (id) => calendarParts(id).length > 0 && unknownCalendars(id).length === 0;

/**
 * Join calendars into one id: open only when every member is open. Members are de-duplicated and
 * kept in the order given. ALLDAYS adds nothing to a joint calendar, so it is dropped when another
 * member exists. WEEKEND is kept: it carries the holidays entered by hand for markets with no
 * calendar, and it keeps the joint calendar flagged as approximate.
 */
export function joinCalendars(...ids) {
  const parts = [];
  for (const id of ids) for (const p of calendarParts(id)) if (!parts.includes(p)) parts.push(p);
  const real = parts.filter((p) => p !== 'ALLDAYS');
  return (real.length ? real : parts).join('+');
}

/** Label and quality of a calendar id, joint or single. */
export function describeCalendar(id) {
  const parts = calendarParts(id);
  const weekendsOnly = parts.length > 0 && parts.every((p) => p === 'WEEKEND');
  const partlyWeekends = !weekendsOnly && parts.includes('WEEKEND');
  const label = parts.length === 1 ? CALENDARS[parts[0]]?.label || parts[0] : `Joint calendar ${parts.join(' + ')}: a business day in every one of them`;
  return { id: parts.join('+'), parts, label, joint: parts.length > 1, weekendsOnly, partlyWeekends };
}

/** Why a date is not a business day on a calendar: 'a Saturday', 'a holiday on JP', or null when it is one. */
export function closedReason(iso, cal = 'US') {
  if (isBusinessDay(iso, cal)) return null;
  const parts = calendarParts(cal);
  if (!parts.includes('ALLDAYS') || parts.length > 1) {
    const w = weekday(iso);
    if (w === 6) return 'a Saturday';
    if (w === 0) return 'a Sunday';
  }
  const shut = parts.filter((p) => !isBusinessDay(iso, p));
  return `a holiday on ${shut.join(' and ')}`;
}

/** Business days from `from` (exclusive) to `to` (inclusive) on a calendar; 0 when to <= from. */
export function businessDaysBetween(from, to, cal = 'US') {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isBusinessDay(d, cal)) n++;
  return n;
}
