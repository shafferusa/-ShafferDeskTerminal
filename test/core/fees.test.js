// Commission: the fee schedule, its minimum included, applies once to an order, not to each fill.
//
// After every fill the fees charged on the order equal the schedule applied to everything the order
// has filled so far, so an order filled in parts costs what the preview showed for the whole order.
// The minimum is carried by the first fill. All figures are worked out by hand in the comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, ledgerImbalance, advance } from '../helpers.js';

const pin = (app, id, px, size) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: size, askSize: size });
const confirm = (app, pv) => app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation });
const commission = (f) => f.fees.reduce((a, x) => a + x.amount, 0);

test('the minimum binds on the whole order: three fills pay it once, on the first fill', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  // 0.005 a share, at least 5.00 an order.
  app.books.updateSettings(book.id, { fees: { equity: { perUnit: 0.005, minimum: 5, bps: 0 } } });
  pin(app, inst.ALFA.id, 20, 200); // 200 shares on offer per cycle
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 600 });
  // Preview, whole order: 600 x 20.00 = 12,000.00; 600 x 0.005 = 3.00, raised to the 5.00 minimum; required 12,005.00.
  assert.deepEqual([pv.legs[0].cash, pv.legs[0].feeTotal, pv.totals.cash.USD.required], [-12_000, 5, 12_005]);
  assert.match(pv.legs[0].fees[0].label, /min 5 an order/);
  let s = (await confirm(app, pv)).strategy;
  await advance(app, clock, 1000);
  await advance(app, clock, 1000);
  s = app.packages.strategyView(s.id);
  const o = s.orders[0];
  assert.deepEqual([o.status, o.filledQty, o.fills.length], ['filled', 600, 3]);
  // Schedule on what the order has filled so far: after 200 shares 1.00 -> 5.00; after 400, 2.00 -> 5.00; after 600, 3.00 -> 5.00.
  // So the fills pay 5.00, 0.00 and 0.00: 5.00 in all, as previewed (three per-fill minimums would have been 15.00).
  assert.deepEqual(o.fills.map(commission), [5, 0, 0]);
  assert.equal(app.ledger.balance(acct.id, 'pnl.commission', 'USD'), 5);
  // Each fill owes its 200 x 20.00 = 4,000.00, the first one plus the 5.00: 12,005.00 payable, the cash the preview required.
  assert.deepEqual(app.settle.pending([acct.id]).map((p) => p.amount), [-4_005, -4_000, -4_000]);
  assert.equal(app.ledger.cash(acct.id, 'USD').payable, 12_005);
  // Every fill reconciles with the confirmation: the fee each was expected to carry follows the same order-level rule.
  assert.deepEqual(o.confirmed.feeSchedule, { perUnit: 0.005, bps: 0, minimum: 5 });
  assert.deepEqual(o.fills.map((f) => [f.confirm.confirmed.fees, f.confirm.actual.fees, f.confirm.variance.fees, f.confirm.exact]), [[5, 5, 0, true], [0, 0, 0, true], [0, 0, 0, true]]);
  assert.equal(o.fills.reduce((a, f) => a + f.confirm.confirmed.fees, 0), o.confirmed.fees, 'the expected fees of the fills add up to the confirmed fee');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('the minimum does not bind on the whole order: the first fill pays it, later fills pay only what the schedule adds', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  // 0.01 a share, at least 5.00 an order.
  app.books.updateSettings(book.id, { fees: { equity: { perUnit: 0.01, minimum: 5, bps: 0 } } });
  pin(app, inst.ALFA.id, 20, 300);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 900 });
  // Whole order: 900 x 0.01 = 9.00, above the minimum.
  assert.equal(pv.legs[0].feeTotal, 9);
  let s = (await confirm(app, pv)).strategy;
  // After the first fill alone the order has paid the minimum: 300 x 0.01 = 3.00 -> 5.00.
  assert.deepEqual(s.orders[0].fills.map(commission), [5]);
  await advance(app, clock, 1000);
  await advance(app, clock, 1000);
  s = app.packages.strategyView(s.id);
  const o = s.orders[0];
  // To date: 3.00 -> 5.00; 6.00; 9.00. Fills pay 5.00, then 6.00 - 5.00 = 1.00, then 9.00 - 6.00 = 3.00. Total 9.00 (per fill it was 15.00).
  assert.deepEqual(o.fills.map(commission), [5, 1, 3]);
  assert.equal(app.ledger.balance(acct.id, 'pnl.commission', 'USD'), 9);
  assert.deepEqual(app.settle.pending([acct.id]).map((p) => p.amount), [-6_005, -6_001, -6_003]); // 300 x 20.00 = 6,000.00 each
  assert.deepEqual(o.fills.map((f) => [f.confirm.confirmed.fees, f.confirm.variance.fees, f.confirm.exact]), [[5, 0, true], [1, 0, true], [3, 0, true]]);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('basis points with a minimum, fills at different prices, and an order that stops part filled', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  // 10 basis points of principal, at least 5.00 an order.
  app.books.updateSettings(book.id, { fees: { equity: { perUnit: 0, minimum: 5, bps: 10 } } });
  pin(app, inst.BRVO.id, 10, 300);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.BRVO.id, quantity: 900, tif: 'gtc' });
  assert.equal(pv.legs[0].feeTotal, 9); // 900 x 10.00 = 9,000.00; 10 bp = 9.00
  let s = (await confirm(app, pv)).strategy;
  pin(app, inst.BRVO.id, 10.1, 300);
  await advance(app, clock, 1000);
  // Two fills: 300 x 10.00 = 3,000.00 and 300 x 10.10 = 3,030.00. To date: 3.00 -> 5.00, then 10 bp of 6,030.00 = 6.03.
  s = app.packages.strategyView(s.id);
  assert.deepEqual(s.orders[0].fills.map(commission), [5, 1.03]);
  // The order is cancelled with 600 of 900 filled: it has paid 6.03, exactly the schedule on what it filled.
  app.orders.cancel(s.orders[0].id);
  assert.equal(app.ledger.balance(acct.id, 'pnl.commission', 'USD'), 6.03);
  // Against the confirmation (10.00 a share): expected 5.00 then 6.00 - 5.00 = 1.00; the second fill paid 0.03 more with its higher price.
  s = app.packages.strategyView(s.id);
  assert.deepEqual(s.orders[0].fills.map((f) => [f.confirm.confirmed.fees, f.confirm.actual.fees, f.confirm.variance.fees]), [[5, 5, 0], [1, 1.03, 0.03]]);

  // A new order is a new minimum: 100 x 10.10 = 1,010.00; 10 bp = 1.01 -> 5.00.
  pin(app, inst.BRVO.id, 10.1, 1e6);
  const again = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.BRVO.id, quantity: 100 });
  const s2 = (await confirm(app, again)).strategy;
  assert.deepEqual(s2.orders[0].fills.map(commission), [5]);
  assert.equal(app.ledger.balance(acct.id, 'pnl.commission', 'USD'), 11.03);
  assert.deepEqual(ledgerImbalance(app), []);
});
