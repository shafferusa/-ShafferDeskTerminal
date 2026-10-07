// Independent calculators.
//
// Small, plain functions that work figures out from first principles, without importing anything
// from server/. They are NOT used to produce the expected values in specs (those are literals,
// worked out by hand, with the arithmetic beside them). They are used by the spec audit
// (specs.test.js) to check those literals a second way from the spec's own inputs, and they are
// here for anyone writing a new family to check their hand arithmetic against.

/** Round to a currency's minor unit, halves away from zero (0 decimals for yen-like currencies). */
export function money(x, ccy = 'USD') {
  const dp = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'IDR'].includes(ccy) ? 0 : ['BHD', 'KWD', 'OMR', 'JOD', 'TND'].includes(ccy) ? 3 : 2;
  const r = Number(`${Math.round(Number(`${Math.abs(x)}e${dp}`))}e-${dp}`);
  return x < 0 ? -r : r;
}

/** Commission on one fill from a fee schedule { perUnit, bps, minimum }: per unit plus basis points of principal, raised to the minimum. */
export function commission(schedule, qty, principal, ccy = 'USD') {
  const s = schedule || {};
  let fee = (s.perUnit || 0) * qty + ((s.bps || 0) / 10000) * Math.abs(principal);
  if (fee > 0 && s.minimum) fee = Math.max(fee, s.minimum);
  return money(fee, ccy);
}

/** Interest or a fee on a balance for a number of days on an ACT/360 or ACT/365 basis (not rounded). */
export const simpleInterest = (principal, annualRate, days, basis = 360) => (principal * annualRate * days) / basis;

/** Average cost after buying `qty` at `price` into a position of `heldQty` carried at `heldCost`. */
export const averageCost = (heldQty, heldCost, qty, price) => (heldCost + qty * price) / (heldQty + qty);

/** Realized gain on selling `qty` at `price` out of a position of `heldQty` carried at `heldCost` (average cost). */
export const realizedOnSale = (heldQty, heldCost, qty, price, ccy = 'USD') => money(qty * price - money((heldCost * qty) / heldQty, ccy), ccy);

/** The New York calendar date ('YYYY-MM-DD') of an instant. The Terminal's business date is New York's. */
export function newYorkDate(instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The date `n` business days after `date`, counting Monday to Friday and skipping the listed holidays.
 * Holidays are given by the caller, from a calendar checked by hand: nothing is looked up here.
 */
export function addBusinessDays(date, n, holidays = []) {
  const skip = new Set(holidays);
  const d = new Date(`${date}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !skip.has(d.toISOString().slice(0, 10))) left--;
  }
  return d.toISOString().slice(0, 10);
}
