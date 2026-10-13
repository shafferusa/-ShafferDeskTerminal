// t2: a package's cash shortfall is measured leg by leg, in the order the legs execute, not only netted.
//
// Found by the iron condor template scenario (test/matrix/specs/templates-b.mjs): with Treasury funding sized to the
// netted shortfall, both written legs of a condor were rejected at execution ("Insufficient USD cash to secure the
// short option"), because the written put must find its whole reserve before the written call's premium arrives.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook } from '../helpers.js';
import { createFixtureControls } from '../../server/data/demo.js';

async function condorBook({ account }) {
  const { app } = makeApp();
  const fx = createFixtureControls(app);
  const { book, acct } = makeBook(app, { account });
  app.books.updateSettings(book.id, { fees: { option: { perUnit: 0.65, minimum: 0, bps: 0 } }, settlement: { option: 1 }, margin: { nakedCallPct: 0.2 } });
  const idx = app.instruments.create({ productId: 'etf', name: 'Probe 100 Index (reference level)', symbol: 'PRBX', marketView: 'US_CASH', venue: 'Probe Indices', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {} });
  const opt = (sym, right, strike) => app.instruments.create({ productId: 'index_option', name: sym, symbol: sym, marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', underlyingId: idx.id, multiplier: 100, terms: { right, strike, expiration: '2026-03-20', exercise: 'european', settlement: 'cash', deliverable: { units: 100 } } });
  const legs = [[opt('PRBX260320P90', 'P', 90), 0.9, 1.0], [opt('PRBX260320P95', 'P', 95), 1.9, 2.0], [opt('PRBX260320C105', 'C', 105), 1.8, 1.9], [opt('PRBX260320C110', 'C', 110), 0.8, 0.9]];
  await fx.apply('quote', { instrumentId: idx.id, bid: 99.99, ask: 100.01, last: 100, bidSize: 1000, askSize: 1000 });
  for (const [i, bid, ask] of legs) await fx.apply('quote', { instrumentId: i.id, bid, ask, last: (bid + ask) / 2, bidSize: 20, askSize: 20 });
  const input = { bookId: book.id, unitId: acct.id, template: 'iron_condor', underlyingId: idx.id, options: { expiration: '2026-03-20', strikes: { wingLower: 90, put: 95, call: 105, wingUpper: 110 }, contracts: 5 } };
  return { app, input };
}

test('iron condor: the shortfall is the deepest point of the legs executing in order, and Treasury funding covers it', async () => {
  // 5 contracts: wings bought 5 x 1.00 x 100 = 500 and 5 x 0.90 x 100 = 450; inner legs sold 5 x 1.90 x 100 = 950 and
  // 5 x 1.80 x 100 = 900; commission 20 x 0.65 = 13; reserve 5 x 100 x (95 - 90) = 2,500 (one side can lose at a time).
  // Netted: 950 + 13 + 2,500 - 1,850 - 1,000 = 613. Leg by leg from 1,000: -503.25 -453.25 = 43.50 free; the written put
  // brings 946.75 and needs 2,500: 43.50 + 946.75 - 2,500 = -1,509.75. The written call then adds 896.75 and no reserve.
  const { app, input } = await condorBook({ account: 1_000 });
  const bare = await app.packages.preview(input);
  assert.equal(bare.blocking, 1);
  assert.equal(bare.totals.cash.USD.shortfall, 1_509.75);
  assert.match(bare.checks.find((c) => c.code === 'cash').message, /^Alpha is short 1,509\.75 USD while the legs execute/);

  const funded = await app.packages.preview({ ...input, financing: { mode: 'treasury' } });
  assert.equal(funded.blocking, 0);
  assert.equal(funded.legs[0].kind, 'funding');
  assert.equal(funded.legs[0].qty, 1_509.75);
  const r = await app.packages.submit({ ...input, financing: { mode: 'treasury' }, legs: funded.legs, clientToken: funded.token, confirm: true, expected: funded.confirmation });
  assert.equal(r.strategy.status, 'open');
  assert.deepEqual(r.strategy.orders.map((o) => o.status), ['filled', 'filled', 'filled', 'filled', 'filled']);
});

test('iron condor with ample cash: the leg-by-leg path needs no more than the netted figure', async () => {
  // 10,000 in the Account: free after the wings 10,000 - 956.50 = 9,043.50; after the written put 9,043.50 + 946.75 -
  // 2,500 = 7,490.25; nothing short at any point.
  const { app, input } = await condorBook({ account: 10_000 });
  const pv = await app.packages.preview(input);
  assert.equal(pv.blocking, 0);
  assert.equal(pv.totals.cash.USD.shortfall, 0);
  assert.equal(pv.totals.cash.USD.required, 3_463);
});

test('closing a spread buys back the written legs first, and the sale of the protection waits on them', async () => {
  // Found by the bear call spread scenario: Close sold the bought wing first, leaving the written leg uncovered (its
  // reserve went to the uncovered figure) and, when the buy-back could not fill, leaving it naked.
  const { app, input } = await condorBook({ account: 10_000 });
  const pv = await app.packages.preview(input);
  const opened = (await app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation })).strategy;
  assert.equal(opened.status, 'open');
  const close = await app.packages.previewAction(opened.id, 'close', { fraction: 1 });
  const legs = close.legs.map((l) => [l.action, l.instrument.symbol, l.dependsOn]);
  assert.deepEqual(legs, [
    ['buy', 'PRBX260320P95', []],
    ['buy', 'PRBX260320C105', []],
    ['sell', 'PRBX260320P90', [1, 2]],
    ['sell', 'PRBX260320C110', [1, 2]],
  ]);
  // Nothing on the way out needs more than the instance already reserves.
  assert.equal(close.blocking, 0);
  assert.equal(close.totals.cash.USD.reserved, 0);
});
