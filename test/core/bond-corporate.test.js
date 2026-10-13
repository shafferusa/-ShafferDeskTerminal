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
