// Options on futures: one option delivers ONE futures contract, and the future has its own multiplier.
// Regression tests for three faults found by the product matrix (test/matrix/specs/option.mjs, option_on_future):
//   - the notional of an option on a future left out the future's multiplier (284.84 instead of 284,840);
//   - the cash reserved against a written put on a future was contracts x strike, without the multiplier
//     (132 instead of 132,000), so a written futures option was all but unsecured;
//   - a contract registered without deliverable units defaulted to "the multiplier" futures per option.
// The delivery on exercise is also labelled as simulated in the history.
//
// Expected figures are worked out by hand in the comments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance } from '../helpers.js';

function setup() {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  // A crude oil future of 1,000 barrels with 6,500 initial margin, and American options on it.
  const fut = app.instruments.create({ productId: 'commodity_future', name: 'Test Crude June 2026', symbol: 'TCLM6', marketView: 'US_DERIV', venue: 'NYMEX', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', multiplier: 1000, terms: { root: 'TCL', expiration: '2026-05-19', tickSize: 0.01, initialMargin: 6500 } });
  const option = (symbol, right, strike, deliverable) => app.instruments.create({
    productId: 'option_on_future', name: `TCL June 2026 ${strike} ${right === 'C' ? 'call' : 'put'}`, symbol, marketView: 'US_DERIV', venue: 'NYMEX', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', underlyingId: fut.id, multiplier: 1000,
    terms: { right, strike, expiration: '2026-05-14', exercise: 'american', settlement: 'physical', ...(deliverable ? { deliverable } : {}) },
  });
  const call = option('TCLM6C70', 'C', 70); // deliverable left out on purpose
  const put = option('TCLM6P66', 'P', 66, { units: 1 });
  app.data.market.set(fut.id, { bid: 71.20, ask: 71.22, value: 71.21, bidSize: 500, askSize: 500 });
  app.data.market.set(call.id, { bid: 2.10, ask: 2.14, value: 2.12, bidSize: 500, askSize: 500 });
  app.data.market.set(put.id, { bid: 0.80, ask: 0.84, value: 0.82, bidSize: 500, askSize: 500 });
  const ticket = (inst, action, qty) => ({ bookId: book.id, unitId: acct.id, template: 'custom', underlyingId: inst.id, origin: 'marketplace', legs: [{ kind: 'trade', action, instrumentId: inst.id, qty, role: 'underlying' }] });
  return { app, clock, book, acct, fut, call, put, ticket };
}

test('an option on a future delivers one future per contract unless the contract says otherwise', () => {
  const { call, put } = setup();
  assert.equal(call.terms.deliverable.units, 1, 'left out: one futures contract, not "the multiplier" futures');
  assert.equal(put.terms.deliverable.units, 1);
  assert.equal(call.multiplier, 1000, 'the premium multiplier is the future\'s 1,000 barrels');
});

test('the notional of an option on a future is contracts x futures multiplier x futures price', async () => {
  const { app, call, ticket } = setup();
  const pv = await app.packages.preview(ticket(call, 'buy', 4));
  assert.equal(pv.blocking, 0);
  assert.equal(pv.legs[0].cash, -8560, '4 contracts x 2.14 x 1,000');
  assert.equal(pv.legs[0].notional, 284_840, '4 contracts x 1 future x 1,000 barrels x 71.21');
});

test('a written put on a future is cash-secured on its whole contract value', async () => {
  const { app, acct, put, ticket } = setup();
  const pv = await app.packages.preview(ticket(put, 'sell', 2));
  assert.equal(pv.totals.optionRequirement[0].amount, 132_000, '2 contracts x 1,000 barrels x 66');
  assert.equal(pv.totals.cash.USD.reserved, 132_000);
  const s = await trade(app, ticket(put, 'sell', 2));
  assert.equal(s.holds.find((h) => h.kind === 'option_margin').amount, 132_000);
  assert.equal(app.ledger.cash(acct.id, 'USD').reserved, 132_000);
});

test('a written call on a future is covered by one future in the same strategy instance, and otherwise reserves 20% of 1,000 barrels', async () => {
  const { app, book, acct, fut, call, ticket } = setup();
  // Uncovered: 1 contract x 1,000 barrels x 71.21 x 20% = 14,242.
  const naked = await app.packages.preview(ticket(call, 'sell', 1));
  assert.equal(naked.totals.optionRequirement[0].amount, 14_242);
  assert.equal(naked.totals.optionRequirement[0].uncoveredCallUnits, 1000);
  // Covered: a long future bought in the same package covers the call, barrel for barrel.
  const covered = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', underlyingId: fut.id, legs: [
    { kind: 'trade', action: 'buy', instrumentId: fut.id, qty: 1, role: 'underlying' },
    { kind: 'trade', action: 'sell', instrumentId: call.id, qty: 1, role: 'call', purpose: 'hedge', dependsOn: [1] },
  ] });
  assert.equal(covered.blocking, 0, covered.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' | '));
  assert.equal(covered.totals.optionRequirement[0].amount, 0);
  assert.equal(covered.totals.optionRequirement[0].coveredCallUnits, 1000);
});

test('exercise of a call on a future opens one future per contract at the strike, posts its margin, and says the delivery is simulated', async () => {
  const { app, book, acct, fut, call, ticket } = setup();
  const s = await trade(app, ticket(call, 'buy', 3));
  const pos = app.positions.get(s.positions[0].positionId);
  app.db.tx(() => app.products.get('option').exercise(app, { book, unit: acct, inst: app.instruments.get(call.id), pos, contracts: 2 }));
  const v = app.packages.strategyView(s.id);
  const future = v.positions.find((p) => p.family === 'future');
  assert.equal(future.qty, 2, '2 option contracts deliver 2 futures');
  assert.equal(future.avgCost, 70, 'opened at the strike');
  assert.equal(future.marginPosted, 13_000, '2 x 6,500 initial margin');
  assert.equal(future.unrealized, 2420, '(71.21 - 70) x 1,000 x 2');
  assert.equal(v.positions.find((p) => p.family === 'option').qty, 1);
  assert.equal(app.ledger.cash(acct.id, 'USD').margin, 13_000);
  const delivery = app.accounting.history(book.id, acct.id).events.find((e) => e.type === 'option.delivery');
  assert.match(delivery.summary, /^Simulated delivery: received 2 TCLM6 at strike 70 on exercise of TCLM6C70/);
  assert.deepEqual(ledgerImbalance(app), []);
  void fut;
});
