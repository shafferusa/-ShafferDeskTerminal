// Fixed-income contract arithmetic: coupon schedules, accrued interest, and the standard
// price <-> yield conversion. Nothing here estimates a market price; marks come from Shaffer
// MarketData / Analytics Lab or from manual entry.

import { accrualDays, yearFraction } from './daycount.js';
import { addMonths, diffDays, isEndOfMonth } from './dates.js';
import { adjust } from './calendar.js';
import { notionalPeriod } from './schedule.js';

const freqOf = (terms) => (terms.couponType === 'zero' ? 0 : Number(terms.frequency ?? 2));

/** Coupon dates strictly after `after` up to and including maturity. */
export function couponDates(terms, after) {
  const freq = freqOf(terms);
  if (!freq || !terms.maturity) return [];
  const months = 12 / freq;
  const eom = terms.eom ?? isEndOfMonth(terms.maturity);
  const out = [];
  for (let i = 0; i < 2000; i++) {
    const d = addMonths(terms.maturity, -months * i, { eom });
    if (d <= after) break;
    if (terms.firstCouponDate && d < terms.firstCouponDate) break;
    out.push(d);
  }
  return out.reverse();
}

export function nextCouponDate(terms, after) {
  return couponDates(terms, after)[0] || null;
}

/** The accrual period that contains `date`, clipped to the dated/issue date. */
export function couponPeriod(terms, date) {
  const freq = freqOf(terms);
  if (!freq) return null;
  const months = 12 / freq;
  const eom = terms.eom ?? isEndOfMonth(terms.maturity);
  if (date >= terms.maturity) return null;
  const p = notionalPeriod(terms.maturity, months, date, eom);
  const dated = terms.datedDate || terms.issueDate;
  return { start: p.start, end: p.end, accrualStart: dated && dated > p.start ? dated : p.start };
}

/** Coupon rate in force (decimal per annum). Floating-rate notes carry their current reset rate. */
export function currentCouponRate(terms) {
  if (terms.couponType === 'float') return terms.currentCoupon ?? null;
  return Number(terms.couponRate || 0);
}

/** Accrued interest per 100 face at `settle`. Returns null when a floating coupon has no fixing. */
export function accruedPer100(terms, settle) {
  const freq = freqOf(terms);
  if (!freq) return 0;
  const dated = terms.datedDate || terms.issueDate;
  if (dated && settle <= dated) return 0;
  const period = couponPeriod(terms, settle);
  if (!period) return 0;
  const rate = currentCouponRate(terms);
  if (rate === null) return null;
  const basis = terms.dayCount || 'ACT/ACT';
  if (basis === 'ACT/ACT') {
    const full = diffDays(period.start, period.end);
    const elapsed = diffDays(period.accrualStart, settle);
    return (100 * rate / freq) * (elapsed / full);
  }
  return 100 * rate * yearFraction(period.accrualStart, settle, basis);
}

/** Coupon paid per 100 face on a coupon date. */
export function couponPer100(terms, couponDate) {
  const freq = freqOf(terms);
  if (!freq) return 0;
  const rate = currentCouponRate(terms);
  if (rate === null) return null;
  const months = 12 / freq;
  const eom = terms.eom ?? isEndOfMonth(terms.maturity);
  const start = addMonths(couponDate, -months, { eom });
  const dated = terms.datedDate || terms.issueDate;
  const accrualStart = dated && dated > start ? dated : start;
  const basis = terms.dayCount || 'ACT/ACT';
  if (basis === 'ACT/ACT' || basis === '30/360' || basis === '30E/360') {
    if (accrualStart === start) return 100 * rate / freq;
    if (basis === 'ACT/ACT') return (100 * rate / freq) * (diffDays(accrualStart, couponDate) / diffDays(start, couponDate));
    return 100 * rate * yearFraction(accrualStart, couponDate, basis);
  }
  return 100 * rate * yearFraction(accrualStart, couponDate, basis);
}

/** Remaining cash flows per 100 face after `settle`. */
export function cashflowsPer100(terms, settle, calendar = 'USBOND') {
  const redemption = Number(terms.redemption ?? 100);
  const flows = couponDates(terms, settle).map((d) => ({ date: d, payDate: adjust(d, 'following', calendar), amount: couponPer100(terms, d), type: 'coupon' }));
  if (terms.maturity && terms.maturity > settle) {
    flows.push({ date: terms.maturity, payDate: adjust(terms.maturity, 'following', calendar), amount: redemption, type: 'principal' });
  }
  return flows;
}

/**
 * Street-convention clean price per 100 from a yield (decimal, compounded `frequency` times a year;
 * zero-coupon instruments use semi-annual compounding beyond one period and simple yield inside it).
 */
export function priceFromYield(terms, settle, y) {
  const freq = freqOf(terms) || 2;
  const redemption = Number(terms.redemption ?? 100);
  const coupons = couponDates(terms, settle);
  const months = 12 / freq;
  const eom = terms.eom ?? isEndOfMonth(terms.maturity);
  const firstNext = coupons.length ? coupons[0] : terms.maturity;
  const prev = addMonths(firstNext, -months, { eom });
  const w = diffDays(settle, firstNext) / diffDays(prev, firstNext); // fraction of a period to next date
  let dirty = 0;
  if (!freqOf(terms)) {
    const periods = yearFraction(settle, terms.maturity, 'ACT/ACT') * freq;
    dirty = periods <= 1 ? redemption / (1 + y * periods / freq) : redemption / (1 + y / freq) ** periods;
    return { clean: dirty, dirty, accrued: 0 };
  }
  coupons.forEach((d, i) => {
    dirty += (couponPer100(terms, d) || 0) / (1 + y / freq) ** (w + i);
  });
  dirty += redemption / (1 + y / freq) ** (w + Math.max(coupons.length - 1, 0));
  const accrued = accruedPer100(terms, settle) || 0;
  return { clean: dirty - accrued, dirty, accrued };
}

/** Yield (decimal) implied by a clean price, by bisection. Returns null if it cannot be bracketed. */
export function yieldFromPrice(terms, settle, clean) {
  if (!terms.maturity || terms.maturity <= settle || !(clean > 0)) return null;
  let lo = -0.5, hi = 2;
  const f = (y) => priceFromYield(terms, settle, y).clean - clean;
  let flo = f(lo), fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (Math.abs(fm) < 1e-10) return mid;
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/** Simple interest on a principal between two dates. */
export function simpleInterest(principal, rate, start, end, basis = 'ACT/360') {
  return principal * rate * yearFraction(start, end, basis);
}

export { accrualDays };
