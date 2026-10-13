// Debt securities, structured group B (test/matrix/specs/bond-structured-b.mjs): regression and behaviour tests for what
// the second structured group of the product matrix needed. Figures are worked out by hand in the comments.
//
//   1. A floating coupon held in two positions was paid at the new period's rate to every holder after the first: the
//      first holder's payment resets the coupon rate to the next period's fixing, and the next holder's coupon was worked
//      out from the instrument's current rate. Found while building the PIK coupon of a CLO class (b4, clo).
//   2. Structured terms added for group B: servicing fee (ABS), stated pool characteristics (specified pool), sequential
//      priority (CMO), coupons paid in kind (CLO, CDO, PIK-toggle private credit).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../server/api.js';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';

const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e9, askSize: 1e9 });
const api = (app, method, path, body = {}) => {
  const r = createApi(app).match(method, path);
  return r.handler({ params: r.params, query: {}, body });
};
const lifecycle = (app, inst, body) => api(app, 'POST', `/api/instruments/${inst.id}/lifecycle`, body);
const events = (app, book, unit) => app.accounting.history(book.id, unit.id, { includeAccruals: true }).events;

test('floating coupon held in two positions: each holder is paid the rate of the period that ended, not the next one', async () => {
  const { app, clock } = makeApp({ at: '2027-01-04T15:00:00.000Z' }); // Monday 4 January 2027
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_500_000 });
  const frn = app.instruments.create({ productId: 'floating_rate_note', name: 'Test FRN', symbol: 'FRN29', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD',
    terms: { couponType: 'float', referenceRate: 'TESTRATE', spread: 0.01, currentCoupon: 0.06, frequency: 4, maturity: '2029-04-20', issueDate: '2024-04-20', dayCount: 'ACT/360' } });
  pin(app, frn.id, 100);
  // Two strategies, so two positions and two coupon items for the same coupon date.
  for (let i = 0; i < 2; i++) await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: frn.id, qty: 1_000_000 }] });
  // The next period's fixing: 4.00% + 1.00% = 5.00%.
  api(app, 'POST', '/api/demo/fixtures/rate', { code: 'TESTRATE', value: 4, date: '2027-01-20' });
  await goTo(app, clock, '2027-01-20T15:00:00.000Z');
  // 20 Oct 2026 to 20 Jan 2027 is 92 days at 6.00%: 1,000,000 x 6% x 92/360 = 15,333.33 to EACH holder (the second one was
  // paid 1,000,000 x 5% x 92/360 = 12,777.78 before the fix).
  const coupons = events(app, book, acct).filter((e) => e.type === 'bond.coupon');
  assert.equal(coupons.length, 2);
  for (const c of coupons) assert.match(c.summary, /: 15,333\.33 USD$/);
  // The new period runs at 5.00%.
  assert.equal(app.instruments.get(frn.id).terms.currentCoupon, 0.05);
  assert.deepEqual(ledgerImbalance(app), []);
});
