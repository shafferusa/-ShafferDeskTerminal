// t2: the Strategy page's hedge request goes with the package it was asked for.
//
// Found by the trading-path scenario "Strategy package with protection included" (test/matrix/specs/templates-b.mjs,
// path strategy-protection): a long collar built on the Strategies page sends a hedge request with the template's
// protection as context, and the demo fixture answers that nothing further is needed. The package was then confirmed
// without a hedge package, and the request stayed an unlinked draft: the position and the hedge review queue never
// showed it, and the next request made on the page for the same Account deleted it. Confirming the package with the
// request's id (input.hedgeRequestId) now links the request to the new strategy instance.
//
// The demo fixture answers for Shaffer Hedge (labelled "Demo fixture, not Shaffer Hedge"); everything else is the
// real engine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook } from '../helpers.js';
import { createFixtureControls } from '../../server/data/demo.js';

async function collarBook() {
  const { app } = makeApp({ demo: true });
  const fx = createFixtureControls(app);
  const { book, acct } = makeBook(app, { account: 100_000 });
  app.books.updateSettings(book.id, { fees: { option: { perUnit: 0.65, minimum: 0, bps: 0 }, equity: { perUnit: 0.005, minimum: 1, bps: 0 } }, settlement: { option: 1, equity: 1 } });
  const s = app.instruments.create({ productId: 'common_stock', name: 'Link Probe Inc.', symbol: 'LNKP', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {} });
  const opt = (right, strike) => app.instruments.create({ productId: 'equity_option', name: `LNKP ${strike} ${right}`, symbol: `LNKP260320${right}${strike}`, marketView: 'US_DERIV', venue: 'Cboe', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', underlyingId: s.id, multiplier: 100, terms: { right, strike, expiration: '2026-03-20', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
  const p48 = opt('P', 48), c52 = opt('C', 52);
  await fx.apply('quote', { instrumentId: s.id, bid: 49.98, ask: 50.02, last: 50, bidSize: 10_000, askSize: 10_000 });
  await fx.apply('quote', { instrumentId: p48.id, bid: 0.9, ask: 1.0, last: 0.95, bidSize: 100, askSize: 100 });
  await fx.apply('quote', { instrumentId: c52.id, bid: 0.8, ask: 0.9, last: 0.85, bidSize: 100, askSize: 100 });
  const CTX = { investmentStrategy: { id: 'DEMO-IS-002', name: 'Core Equity', resolved: true }, holdingPeriod: { days: 30 }, hedgeObjective: { type: 'downside_protection' } };
  const input = { bookId: book.id, unitId: acct.id, template: 'long_collar', underlyingId: s.id, origin: 'strategy_page', ...CTX, mode: 'new', quantity: 1000, hedgeRatio: 1, options: { expiration: '2026-03-20', strikes: { put: 48, call: 52 }, contracts: null }, orderType: 'market', tif: 'day', financing: null };
  const ask = () => app.hedge.request({ bookId: book.id, unitId: acct.id, scope: { type: 'trade' }, trigger: 'strategy_page', instrumentId: s.id, investmentStrategy: CTX.investmentStrategy, holdingPeriod: CTX.holdingPeriod, objective: CTX.hedgeObjective, package: { ...input, financing: null } });
  const confirm = async (extra = {}) => {
    const pv = await app.packages.preview({ ...input, ...extra });
    return (await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: { cash: { USD: pv.totals.cash.USD.required } } })).strategy;
  };
  return { app, book, ask, confirm };
}

test('a long collar confirmed with its hedge request id: the request is on the strategy instance and in the review queue, and current', async () => {
  const { app, book, ask, confirm } = await collarBook();
  const h = await ask();
  assert.equal(h.state, 'recommendation_ready');
  assert.equal(h.response.packages.length, 0);
  assert.match(h.response.note, /already protected \(10 puts in the template\)/);
  const s = await confirm({ hedgeRequestId: h.id });
  assert.equal(s.status, 'open');
  const mine = app.hedge.forStrategy(s.id);
  assert.deepEqual(mine.requests.map((r) => [r.id, r.state, r.trigger, r.freshness?.status]), [[h.id, 'recommendation_ready', 'strategy_page', 'current']]);
  // Every leg filled: 1,000 shares, 10 puts and 10 calls, the exposure the request described. The puts protect the shares (template).
  const shares = mine.protection.find((x) => x.protection);
  assert.deepEqual([shares.protection.exposureUnits, shares.protection.protectedUnits, shares.protection.remainingUnits, shares.protection.linked.map((a) => a.basis)], [1000, 1000, 0, ['template']]);
  assert.deepEqual(app.hedge.queue(book.id).items.map((x) => [x.id, x.state, x.packages]), [[h.id, 'recommendation_ready', 0]]);
  // Asking on the page again for another package does not delete a request that is linked.
  await ask();
  assert.equal(app.hedge.get(h.id).strategyId, s.id);
});

test('confirmed without the request id, the draft stays unlinked (nothing is guessed)', async () => {
  const { app, ask, confirm } = await collarBook();
  const h = await ask();
  const s = await confirm();
  assert.deepEqual(app.hedge.forStrategy(s.id).requests, []);
  assert.equal(app.hedge.get(h.id).strategyId, null);
});
