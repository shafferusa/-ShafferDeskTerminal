// Payment schedules. Periods are generated backwards from the end date (so any stub is at the
// front), with unadjusted accrual dates and a business-day-adjusted pay date.

import { adjust } from './calendar.js';
import { addMonths, isEndOfMonth } from './dates.js';

/**
 * @param {Object} o
 * @param {string} o.start        effective date
 * @param {string} o.end          maturity date
 * @param {number} o.months       period length in months; 0 = a single period (zero-coupon / bullet)
 * @param {string} [o.calendar]   calendar id for pay-date adjustment
 * @param {string} [o.convention] business-day convention for pay dates
 * @param {boolean} [o.eom]       keep month-end dates on month end
 * @param {string} [o.firstEnd]   explicit end of the first period (odd first coupon)
 * @returns {{start:string,end:string,payDate:string}[]}
 */
export function generateSchedule({ start, end, months, calendar = 'US', convention = 'following', eom, firstEnd }) {
  if (!start || !end || end <= start) return [];
  if (!months) return [{ start, end, payDate: adjust(end, convention, calendar) }];
  const useEom = eom ?? isEndOfMonth(end);
  const bounds = [end];
  for (let i = 1; i < 2000; i++) {
    const d = addMonths(end, -months * i, { eom: useEom });
    if (d <= start) break;
    if (firstEnd && d < firstEnd) break;
    bounds.push(d);
  }
  if (firstEnd && bounds[bounds.length - 1] !== firstEnd && firstEnd > start && firstEnd < end) bounds.push(firstEnd);
  bounds.push(start);
  bounds.reverse();
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] <= bounds[i]) continue;
    out.push({ start: bounds[i], end: bounds[i + 1], payDate: adjust(bounds[i + 1], convention, calendar) });
  }
  return out;
}

/** The period that contains `date` (start <= date < end), or null. */
export function periodContaining(schedule, date) {
  return schedule.find((p) => p.start <= date && date < p.end) || null;
}

/** The quasi-coupon period around `date` for a regular schedule that may start after `date`. */
export function notionalPeriod(end, months, date, eom) {
  let periodEnd = end;
  let periodStart = addMonths(periodEnd, -months, { eom });
  let guard = 0;
  while (periodStart > date && guard++ < 2000) {
    periodEnd = periodStart;
    periodStart = addMonths(periodEnd, -months, { eom });
  }
  return { start: periodStart, end: periodEnd };
}

const IMM_MONTHS = [3, 6, 9, 12];
/** Standard CDS payment dates: the 20th of March, June, September and December. */
export function cdsDates(start, end) {
  const out = [];
  let y = Number(start.slice(0, 4));
  for (let guard = 0; guard < 400; guard++) {
    for (const m of IMM_MONTHS) {
      const d = `${y}-${String(m).padStart(2, '0')}-20`;
      if (d > start && d <= end) out.push(d);
    }
    y++;
    if (`${y}-01-01` > end) break;
  }
  if (!out.length || out[out.length - 1] !== end) out.push(end);
  return out;
}
