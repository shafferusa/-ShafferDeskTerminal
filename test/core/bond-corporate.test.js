// Debt securities: regression tests for faults found by the corporate and money-market group of the product
// test matrix (test/matrix/specs/bond-corporate.mjs). Figures are worked out by hand in the comments.
//
//   1. Coupon suspension (a default recorded by hand) left the interest accrued and not received on the books as an
//      asset that would never be paid, kept charging buyers accrued interest on a bond that trades flat, and let the
//      coupon date pass with nothing in the history. Now the holding goes on non-accrual: the accrued balance is
//      reversed out of coupon and interest income at once, trades are flat, and a missed coupon is listed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../server/api.js';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';

const TUE = '2027-05-18T14:00:00.000Z'; // Tuesday 18 May 2027, 10:00 New York
const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e9, askSize: 1e9 });
const accrued = (app, unit) => app.ledger.balance(unit.id, 'accrued.asset', 'USD');
const couponIncome = (app, book, unit) => app.accounting.pnl(book.id, unit.id).categories.find((x) => x.key === 'couponInterest').rc;
const events = (app, book, unit, type) => app.accounting.history(book.id, unit.id, { includeAccruals: true }).events.filter((e) => e.type === type);

test('bond coupon suspension: accrued interest is reversed (non-accrual), the bond trades flat and a missed coupon is listed', async () => {
  const { app, clock } = makeApp({ at: TUE });
  const { book, acct } = makeBook(app, { cash: 2_000_000, account: 1_000_000 });
  // 8.5% semi-annual, 30/360, coupons 1 June and 1 December.
  const b = app.instruments.create({ productId: 'high_yield_bond', name: 'Test 8.5% 1-Jun-2031', symbol: 'HY31', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.085, frequency: 2, maturity: '2031-06-01', issueDate: '2023-06-01', dayCount: '30/360' } });
  pin(app, b.id, 70);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: b.id, qty: 500_000 }] });
  // Settles Wednesday 19 May: 168 days of 30/360 from 1 Dec: 500,000 x 8.5% x 168/360 = 19,833.33.
  assert.equal(accrued(app, acct), 19_833.33);
  await goTo(app, clock, '2027-05-21T14:00:00.000Z'); // end of day 20 May: 169 days = 19,951.39
  assert.equal(accrued(app, acct), 19_951.39);

  const api = createApi(app);
  await api.match('POST', `/api/instruments/${b.id}/lifecycle`).handler({ params: { id: b.id }, query: {}, body: { action: 'suspend_coupon', suspended: true } });
  assert.equal(accrued(app, acct), 0, 'the interest that will not be paid is no longer an asset');
  assert.equal(couponIncome(app, book, acct), -19_833.33, 'income 118.06 earned, then 19,951.39 reversed');
  // Net assets: cash 1,000,000 - 350,000 - 19,833.33 + the bond at 70 (350,000).
  assert.equal(app.accounting.overview(book.id).nav, 1_980_166.67);

  // A trade while suspended is flat: no accrued interest changes hands.
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: b.id, qty: 100_000 }] });
  assert.equal(pv.legs[0].accrued, 0);
  assert.equal(pv.legs[0].cash, -70_000);

  await goTo(app, clock, '2027-06-01T14:00:00.000Z'); // 1 June: the coupon date passes
  assert.equal(events(app, book, acct, 'bond.coupon').length, 0, 'no coupon is paid');
  const missed = events(app, book, acct, 'bond.coupon_missed');
  assert.equal(missed.length, 1);
  assert.match(missed[0].summary, /Coupon of 2027-06-01 not paid on 500,000 HY31: coupons are suspended/);
  assert.equal(accrued(app, acct), 0, 'nothing accrues while suspended');
  assert.deepEqual(app.accounting.pending(book.id, acct.id).lifecycle.filter((x) => x.type === 'bond.coupon').map((x) => x.dueDate), ['2027-12-01']);
  assert.deepEqual(ledgerImbalance(app), []);
});

//   2. A floating-rate note whose next fixing was missing at a reset: the coupon just paid was not recognised as income
//      (the accrued balance was left negative because the new period had no rate, although nothing accrues on its first
//      day); a fixing supplied or entered later was never taken, so the next coupon stayed blocked for ever; and a trade
//      in the meantime booked its accrued interest as zero. Now: the coupon is income when paid, the fixing of the period
//      start is taken as soon as it exists (never a later one), and a trade waits for it.
test('floating-rate note: a missing fixing blocks the coupon until that fixing exists, a later fixing is not used, a trade waits', async () => {
  const { app, clock } = makeApp({ at: '2027-04-12T14:00:00.000Z' }); // Monday 12 April 2027
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_500_000 });
  const api = createApi(app);
  const call = (method, path, body) => { const m = api.match(method, path); return m.handler({ params: m.params, query: {}, body }); };
  // 3M term SOFR + 0.95%, quarterly on 20 Jan/Apr/Jul/Oct, ACT/360; the running period's coupon is 5.30%.
  const b = app.instruments.create({ productId: 'floating_rate_note', name: 'Test FRN 20-Oct-2029', symbol: 'FRN29', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'float', referenceRate: 'TSOFR3M', spread: 0.0095, currentCoupon: 0.053, frequency: 4, maturity: '2029-10-20', issueDate: '2024-10-20', dayCount: 'ACT/360' } });
  pin(app, b.id, 100);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: b.id, qty: 2_000_000 }] });
  assert.equal(accrued(app, acct), 24_438.89); // to 13 Apr, 83 days: 2,000,000 x 5.3% x 83/360

  await goTo(app, clock, '2027-04-20T14:00:00.000Z'); // coupon of 20 Apr: 90 days at 5.30% = 26,500; no 20 Apr fixing
  assert.equal(events(app, book, acct, 'bond.coupon').length, 1);
  assert.equal(accrued(app, acct), 0, 'the coupon just paid is income; nothing has accrued yet in the new period');
  assert.equal(couponIncome(app, book, acct), 2_061.11); // 26,500 - 24,438.89

  await goTo(app, clock, '2027-04-28T14:00:00.000Z');
  assert.equal(accrued(app, acct), 0, 'no rate, nothing accrued');
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: b.id, qty: 500_000 }] });
  assert.ok(pv.blocking > 0 || (pv.errors || []).length > 0, 'a trade whose accrued interest cannot be computed is blocked');

  await goTo(app, clock, '2027-07-20T14:00:00.000Z');
  const blocked = () => app.accounting.pending(book.id, acct.id).lifecycle.find((x) => x.type === 'bond.coupon' && x.dueDate === '2027-07-20');
  assert.equal(blocked().status, 'blocked');
  // The 20 July fixing arrives: it belongs to the next period and the blocked coupon does not take it.
  await call('POST', '/api/demo/fixtures/rate', { code: 'TSOFR3M', value: 4.05, date: '2027-07-20' });
  await app.engine.tick();
  assert.equal(blocked().status, 'blocked');
  assert.equal(events(app, book, acct, 'bond.coupon').length, 1);
  // The 20 April fixing entered by hand: the coupon is paid at 5.15% for 91 days = 26,036.11, and the next period runs at 5.00%.
  await call('POST', '/api/observations', { kind: 'rate', subject: 'TSOFR3M', value: 4.2, units: 'percent p.a.', forDate: '2027-04-20' });
  await app.engine.tick();
  const coupons = events(app, book, acct, 'bond.coupon');
  assert.equal(coupons.length, 2);
  assert.ok(coupons.some((e) => /: 26,036\.11 USD$/.test(e.summary)), 'the 20 July coupon is paid at 5.15% for 91 days');
  assert.equal(couponIncome(app, book, acct), 28_097.22);
  assert.ok(Math.abs(app.instruments.get(b.id).terms.currentCoupon - 0.05) < 1e-12);
  await goTo(app, clock, '2027-07-22T14:00:00.000Z'); // end of day 21 Jul: one day at 5.00% = 277.78
  assert.equal(accrued(app, acct), 277.78);
  assert.deepEqual(ledgerImbalance(app), []);
});
