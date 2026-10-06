// Day-count conventions. All functions take ISO dates.

import { daysInMonth, diffDays, isLeap, toUtc, ymd } from './dates.js';

export const DAY_COUNTS = ['ACT/360', 'ACT/365', 'ACT/ACT', '30/360', '30E/360'];

function days30(a, b, european) {
  const A = ymd(a), B = ymd(b);
  let d1 = A.d, d2 = B.d;
  if (european) {
    if (d1 === 31) d1 = 30;
    if (d2 === 31) d2 = 30;
  } else {
    // US (bond basis)
    const aEomFeb = A.m === 2 && A.d === daysInMonth(A.y, 2);
    const bEomFeb = B.m === 2 && B.d === daysInMonth(B.y, 2);
    if (aEomFeb && bEomFeb) d2 = 30;
    if (aEomFeb) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
    if (d1 === 31) d1 = 30;
  }
  return (B.y - A.y) * 360 + (B.m - A.m) * 30 + (d2 - d1);
}

/**
 * Year fraction between two dates.
 * 'ACT/ACT' here is ISDA (actual days split across leap and non-leap years). Bond accrued interest
 * on an ACT/ACT (ICMA) basis is computed per coupon period in bond.js instead.
 */
export function yearFraction(start, end, basis = 'ACT/360') {
  if (end === start) return 0;
  if (end < start) return -yearFraction(end, start, basis);
  switch (basis) {
    case 'ACT/360':
      return diffDays(start, end) / 360;
    case 'ACT/365':
      return diffDays(start, end) / 365;
    case '30/360':
      return days30(start, end, false) / 360;
    case '30E/360':
      return days30(start, end, true) / 360;
    case 'ACT/ACT': {
      const ys = ymd(start).y, ye = ymd(end).y;
      if (ys === ye) return diffDays(start, end) / (isLeap(ys) ? 366 : 365);
      let f = (toUtc(`${ys + 1}-01-01`) - toUtc(start)) / 86400000 / (isLeap(ys) ? 366 : 365);
      f += ye - ys - 1;
      f += (toUtc(end) - toUtc(`${ye}-01-01`)) / 86400000 / (isLeap(ye) ? 366 : 365);
      return f;
    }
    default:
      throw new Error(`Unknown day-count basis ${basis}`);
  }
}

/** Number of accrual days under the basis' numerator convention. */
export function accrualDays(start, end, basis = 'ACT/360') {
  if (basis === '30/360') return days30(start, end, false);
  if (basis === '30E/360') return days30(start, end, true);
  return diffDays(start, end);
}
