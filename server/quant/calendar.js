// Business-day calendars used for settlement dates and payment-date adjustment.
//
// These are the Terminal's DEFAULT calendars, used until Shaffer MarketData supplies market
// calendars. 'US' follows NYSE holiday rules, 'USBOND' adds the SIFMA bond-market holidays, and
// 'WEEKEND' (used for every other market) only knows Saturdays and Sundays, so local holidays in
// foreign markets are not recognised. That limitation is reported in the coverage notes.

import { addDays, easterSunday, isWeekend, makeDate, nthWeekday, weekday, ymd } from './dates.js';

const holidayCache = new Map();

function observed(iso, { saturdayToFriday = true } = {}) {
  const w = weekday(iso);
  if (w === 0) return addDays(iso, 1);
  if (w === 6) return saturdayToFriday ? addDays(iso, -1) : null;
  return iso;
}

function usHolidays(y, bond) {
  const key = `${bond ? 'B' : 'E'}${y}`;
  let set = holidayCache.get(key);
  if (set) return set;
  set = new Set();
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
  holidayCache.set(key, set);
  return set;
}

export const CALENDARS = {
  US: { id: 'US', label: 'US equity markets (NYSE rules)', approximate: false },
  USBOND: { id: 'USBOND', label: 'US bond market (SIFMA rules)', approximate: false },
  WEEKEND: { id: 'WEEKEND', label: 'Weekends only (local holidays not recognised)', approximate: true },
  ALLDAYS: { id: 'ALLDAYS', label: 'Every calendar day (24/7 markets)', approximate: false },
};

export function isBusinessDay(iso, cal = 'US') {
  if (cal === 'ALLDAYS') return true;
  if (isWeekend(iso)) return false;
  if (cal === 'US') return !usHolidays(ymd(iso).y, false).has(iso);
  if (cal === 'USBOND') return !usHolidays(ymd(iso).y, true).has(iso);
  return true;
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
