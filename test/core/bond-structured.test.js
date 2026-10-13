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

const posLifecycle = (app, pos, body) => createApi(app).match('POST', `/api/positions/${pos.id}/lifecycle`).handler({ params: { id: pos.id }, query: {}, body });
const holding = (app, unit, instId) => app.positions.list({ unitIds: [unit.id] }).find((p) => p.instrument_id === instId);

//   3. Issuer calls, holder puts and conversions were not recordable as such: a call was a per-position early redemption at
//      any price on any day, a put the same, and a convertible could not be converted at all. Now a call is checked against
//      the call schedule and applies to every holder (pro rata when partial), a put only on a put date at its price, and a
//      conversion moves the carrying cost into the shares (fraction in cash, accrued forfeited).
test('callable, puttable and convertible bonds: call schedule, put dates and conversion rules', async () => {
  const { app } = makeApp({ at: '2028-06-15T14:00:00.000Z' }); // Thursday 15 June 2028
  const { book, acct } = makeBook(app, { cash: 5_000_000, account: 4_000_000 });
  const terms = { couponType: 'fixed', couponRate: 0.06, frequency: 2, maturity: '2033-06-15', issueDate: '2023-06-15', dayCount: '30/360', minDenomination: 1_000 };
  const callable = app.instruments.create({ productId: 'callable_bond', name: 'Test callable', symbol: 'CALL33', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { ...terms, callSchedule: '2028-06-15 101; 2029-06-15 100' } });
  assert.deepEqual(callable.terms.callSchedule, [{ date: '2028-06-15', price: 101 }, { date: '2029-06-15', price: 100 }]);
  pin(app, callable.id, 101);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: callable.id, qty: 1_000_000 }] });
  await assert.rejects(async () => lifecycle(app, callable, { action: 'call', price: 100 }), /call price in force on 2028-06-15 is 101\.00% of par/);
  // A 25% call pro rata: 250,000 redeemed at 101 (no accrued on the coupon date).
  await lifecycle(app, callable, { action: 'call', price: 101, share: 0.25 });
  assert.equal(holding(app, acct, callable.id).qty, 750_000);
  await lifecycle(app, callable, { action: 'call' }); // the price in force by default
  assert.equal(holding(app, acct, callable.id), undefined);
  assert.equal(app.instruments.get(callable.id).terms.calledOn, '2028-06-15');
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: callable.id, qty: 1_000 }] });
  assert.ok(pv.blocking > 0 && JSON.stringify(pv).includes('redeemed in full on 2028-06-15'));

  const puttable = app.instruments.create({ productId: 'puttable_bond', name: 'Test puttable', symbol: 'PUT33', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { ...terms, putSchedule: [{ date: '2028-06-16', price: 100 }] } });
  pin(app, puttable.id, 95);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: puttable.id, qty: 100_000 }] });
  await assert.rejects(async () => posLifecycle(app, holding(app, acct, puttable.id), { action: 'put' }), /2028-06-15 is not a put date of PUT33\. The holder may put only on 2028-06-16 at 100\.00; the next is 2028-06-16/);

  // Conversion: 10,000 face at 25.5 shares per 1,000 = 255 shares exactly; the shares take the bonds' cost 10,000 x 95% = 9,500.
  const stock = app.instruments.create({ productId: 'common_stock', name: 'Test stock', symbol: 'TSTK', marketView: 'US_CASH', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD' });
  assert.throws(() => app.instruments.create({ productId: 'convertible_bond', name: 'Test CB', symbol: 'CB31', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms }), /needs the shares it converts into/);
  const cb = app.instruments.create({ productId: 'convertible_bond', name: 'Test CB', symbol: 'CB31', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', underlyingId: stock.id, terms: { ...terms, conversionRatio: 25.5 } });
  pin(app, cb.id, 95); pin(app, stock.id, 38);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: cb.id, qty: 10_000 }] });
  await posLifecycle(app, holding(app, acct, cb.id), { action: 'convert', face: 10_000 });
  const shares = holding(app, acct, stock.id);
  assert.equal(shares.qty, 255);
  assert.equal(shares.cost, 9_500);
  assert.equal(holding(app, acct, cb.id), undefined);
  assert.deepEqual(ledgerImbalance(app), []);
});

//   4. Securitised paper: the payment delay was not modelled (coupons were paid on the coupon date), a paydown was paid at once
//      on the factor of the day and changed the coupon of the period already ended, and losses could not be allocated. Now:
//      coupons are due the registered number of days after the period ends, a paydown has an effective date and a payment date
//      (a receivable until then) and the coupon of the ended period keeps its factor; a loss writes the factor down without
//      payment, and is refused on a guaranteed pool.
test('MBS: payment delay, paydown effective from the 1st and paid on the 25th, coupon on the old factor, loss allocation', async () => {
  const { app, clock } = makeApp({ at: '2028-11-07T15:00:00.000Z' }); // Tuesday 7 November 2028
  const { book, acct } = makeBook(app, { cash: 5_000_000, account: 4_000_000 });
  const terms = { couponType: 'fixed', couponRate: 0.06, frequency: 12, maturity: '2054-10-01', issueDate: '2024-10-01', dayCount: '30/360', factor: 0.5, paymentDelayDays: 24 };
  const pool = app.instruments.create({ productId: 'non_agency_mbs', name: 'Test pool', symbol: 'POOL', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms });
  pin(app, pool.id, 100);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: pool.id, qty: 2_000_000 }] });
  // 1 Dec + 24 days = Monday 25 December, Christmas: due Tuesday 26 December.
  assert.deepEqual(app.accounting.pending(book.id, acct.id).lifecycle.filter((x) => x.type === 'bond.coupon').map((x) => x.dueDate), ['2028-12-26']);
  await goTo(app, clock, '2028-12-06T15:00:00.000Z');
  // Paydown 0.5 -> 0.49 from 1 Dec, paid 26 Dec: 2,000,000 x 0.01 = 20,000 receivable.
  await lifecycle(app, pool, { action: 'paydown', newFactor: 0.49, effective: '2028-12-01', payDate: '2028-12-26' });
  assert.equal(app.ledger.cash(acct.id, 'USD').receivable, 20_000);
  // A loss: 0.49 -> 0.48 from 1 Dec, no payment; cost 980,000 x 0.01 / 0.49 = 20,000 written off.
  await lifecycle(app, pool, { action: 'writedown', newFactor: 0.48, kind: 'loss', effective: '2028-12-01' });
  assert.equal(holding(app, acct, pool.id).cost, 960_000);
  await goTo(app, clock, '2028-12-26T15:00:00.000Z');
  // November's coupon on November's factor: 1,000,000 x 6% / 12 = 5,000 (not on 0.48).
  const coupon = app.accounting.history(book.id, acct.id, { includeAccruals: true }).events.find((e) => e.type === 'bond.coupon');
  assert.match(coupon.summary, /5,000\.00 USD$/);
  const guaranteed = app.instruments.create({ productId: 'agency_mbs', name: 'Test agency', symbol: 'AGY', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { ...terms, guarantor: 'Fannie Mae' } });
  await assert.rejects(async () => lifecycle(app, guaranteed, { action: 'writedown', newFactor: 0.4, kind: 'loss' }), /guaranteed by Fannie Mae/);
  assert.deepEqual(ledgerImbalance(app), []);
});
