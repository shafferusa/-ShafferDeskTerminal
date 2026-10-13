// Debt securities with structured terms: regression and behaviour tests for what the structured group of the product
// test matrix (test/matrix/specs/bond-structured-a.mjs) needed. Figures are worked out by hand in the comments.
//
//   1. Commission on a bond with an index ratio (or a pool factor) was charged on face x price, not on the principal
//      that actually changes hands (face x ratio x price): the fee schedule's basis points were applied to the wrong
//      amount. Found by tips, step open.
//   2. Inflation-linked bonds had no index ratio at all: the catalog says the ratio is recorded by hand, and nothing in
//      the Terminal could record it or apply it. Now the ratio is required at registration, recorded by hand on the
//      instrument (inflation accretion booked), and used for settlement, accrued interest, coupons and redemption
//      (floored at par when the bond has a deflation floor).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../server/api.js';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';

const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e9, askSize: 1e9 });
const accrued = (app, unit) => app.ledger.balance(unit.id, 'accrued.asset', 'USD');
const couponIncome = (app, book, unit) => app.accounting.pnl(book.id, unit.id).categories.find((x) => x.key === 'couponInterest').rc;
const lifecycle = (app, inst, body) => createApi(app).match('POST', `/api/instruments/${inst.id}/lifecycle`).handler({ params: { id: inst.id }, query: {}, body });

test('TIPS: index ratio required, applied to principal, accrued, fees and coupon; recorded by hand with accretion; redemption floored at par', async () => {
  const { app, clock } = makeApp({ at: '2026-12-01T15:00:00.000Z' }); // Tuesday 1 December 2026
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_000_000 });
  book.settings.fees.bond = { perUnit: 0, minimum: 0, bps: 1 };
  app.books.updateSettings?.(book.id, { fees: book.settings.fees });
  const draft = { productId: 'tips', name: 'Test TIPS 0.375% 15-Jan-2027', symbol: 'TIPS27', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.00375, frequency: 2, maturity: '2027-01-15', issueDate: '2022-01-15', dayCount: 'ACT/ACT', minDenomination: 100 } };
  assert.throws(() => app.instruments.create(draft), /needs its index ratio/);
  const b = app.instruments.create({ ...draft, terms: { ...draft.terms, indexRatio: 1.02, inflationFloor: true } });
  pin(app, b.id, 100);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: b.id, qty: 1_000_000 }] });
  // Principal 1,000,000 x 1.02 x 100% = 1,020,000; settles 2 Dec, 140 of 184 days: 1,020,000 x 0.1875% x 140/184 = 1,455.16.
  assert.equal(pv.legs[0].gross, 1_020_000);
  assert.equal(pv.legs[0].accrued, 1_455.16);
  // Commission on the principal that changes hands: 1 bp of 1,020,000 = 102.00 (not 1 bp of 1,000,000).
  assert.equal(pv.legs[0].feeTotal, 102);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: b.id, qty: 1_000_000 }] });
  await goTo(app, clock, '2026-12-02T15:00:00.000Z');

  // Recorded by hand: 1.02 to 0.99. Accretion 1,000,000 x -0.03 = -30,000 into cost and income; accrued trued up to 2 Dec
  // at the new ratio: 990,000 x 0.1875% x 140/184 = 1,412.36 (down 42.80).
  await lifecycle(app, b, { action: 'index_ratio', ratio: 0.99, asOf: '2026-12-02' });
  const pos = app.positions.list({ unitIds: [acct.id] })[0];
  assert.equal(pos.cost, 990_000); // 1,020,000 - 30,000
  assert.equal(accrued(app, acct), 1_412.36);
  assert.equal(couponIncome(app, book, acct), -30_042.80);
  await assert.rejects(async () => lifecycle(app, b, { action: 'index_ratio', ratio: 0.99 }), /already 0\.99000/);

  // 15 January 2027: coupon on 1,000,000 x 0.99 x 0.1875% = 1,856.25 (not floored); redemption floored at par, 1,000,000:
  // realized 1,000,000 - 990,000 = 10,000.
  await goTo(app, clock, '2027-01-15T15:00:00.000Z');
  const ev = app.accounting.history(book.id, acct.id, { includeAccruals: true }).events;
  assert.match(ev.find((e) => e.type === 'bond.coupon').summary, /1,856\.25 USD$/);
  assert.match(ev.find((e) => e.type === 'bond.redemption').summary, /floored at par, 1,000,000\.00 USD/);
  assert.equal(app.accounting.pnl(book.id, acct.id).categories.find((x) => x.key === 'realized').rc, 10_000);
  assert.equal(app.positions.list({ unitIds: [acct.id] }).length, 0);
  assert.deepEqual(ledgerImbalance(app), []);
});
