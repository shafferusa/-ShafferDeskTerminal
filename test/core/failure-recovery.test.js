// Engine regression tests for defects found by the system suite (test/system): each test is the smallest
// reproduction of one fix. Figures are worked out by hand in the comments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../server/api.js';
import { goTo, ledgerImbalance, makeApp, makeBook, trade } from '../helpers.js';

const pin = (app, inst, px) => app.data.market.set(inst.id, { bid: px, ask: px, value: px, bidSize: 1e6, askSize: 1e6 });
const errors = (pv) => pv.checks.filter((c) => c.level === 'error').map((c) => c.message);
const repoLeg = (inst, cash, qty, positionId) => ({ kind: 'repo_open', action: 'repo', qty: cash, purpose: 'financing', collateralPositionId: positionId,
  contract: { productId: 'term_repo', name: `Repo ${cash}`, marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { collateralInstrumentId: inst.id, collateralQty: qty, haircut: 0.02, rateType: 'fixed', rate: 0.045, term: 'term', endDate: '2026-03-10' } } });

test('a repo cannot raise more cash than its collateral supports after the haircut', async () => {
  const { app, inst } = makeApp();
  const { book, treasury } = makeBook(app, { cash: 3_000_000, account: 0 });
  pin(app, inst.ALFA, 100);
  const hold = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.ALFA.id, qty: 10_000 }] });
  const pos = hold.positions[0].positionId;
  const preview = (cash) => app.packages.preview({ bookId: book.id, unitId: treasury.id, template: 'custom', legs: [repoLeg(inst.ALFA, cash, 10_000, pos)] });
  // 10,000 shares x 100.00 = 1,000,000.00; less the 2% haircut = 980,000.00
  const over = await preview(980_000.01);
  assert.deepEqual(errors(over), ['Leg 1: The collateral supports at most 980,000.00 USD: 10,000 ALFA is worth 1,000,000.00 USD and the haircut is 2.00%; 980,000.01 USD requested.']);
  await assert.rejects(app.packages.submit({ ...over.input, legs: over.legs, clientToken: over.token, confirm: true }), /supports at most 980,000\.00 USD/);
  assert.equal(app.positions.get(pos).pledged_qty, 0, 'nothing was pledged');
  const ok = await preview(980_000);
  assert.equal(ok.blocking, 0);
  // Without a price for the collateral the cash it supports cannot be worked out, and nothing is assumed.
  const unpriced = app.instruments.create({ productId: 'common_stock', name: 'Unquoted Co', symbol: 'UNQ', marketView: 'US_CASH', venue: 'NYSE', tradingCcy: 'USD' });
  const h2 = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: unpriced.id, qty: 100, statedPrice: 50 }] });
  const np = await app.packages.preview({ bookId: book.id, unitId: treasury.id, template: 'custom', legs: [repoLeg(unpriced, 1_000, 100, h2.positions[0].positionId)] });
  assert.match(errors(np)[0], /UNQ has no price, so the cash this collateral supports cannot be worked out/);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a pledged holding cannot be sold: the preview blocks, no order is created and the holding keeps its status', async () => {
  const { app, inst } = makeApp();
  const { book, treasury } = makeBook(app, { cash: 3_000_000, account: 0 });
  pin(app, inst.ALFA, 100);
  const hold = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.ALFA.id, qty: 10_000 }] });
  await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [repoLeg(inst.ALFA, 500_000, 6_000, hold.positions[0].positionId)] });
  const orders = () => app.db.get('SELECT COUNT(*) AS n FROM orders').n;
  const n = orders();
  // 10,000 held, 6,000 pledged: 4,000 are free.
  const all = await app.packages.previewAction(hold.id, 'close');
  assert.deepEqual(errors(all), ['Leg 1: only 4,000 of the 10,000 ALFA held is unencumbered; the rest is pledged or out on loan and cannot be sold until it is released.']);
  await assert.rejects(app.packages.submit({ ...all.input, legs: all.legs, clientToken: all.token, confirm: true }), /unencumbered/);
  assert.equal(orders(), n, 'no order was created');
  assert.equal(app.packages.strategyView(hold.id).status, 'open', 'the holding is not left asking for attention');
  const part = await app.packages.previewAction(hold.id, 'close', { positionIds: [hold.positions[0].positionId], qty: 4_000 });
  assert.equal(part.blocking, 0, 'the 4,000 that are free can be sold');
});

test('a package in a currency with no conversion rate, or a stale one, says so in the preview', async () => {
  const { app, clock } = makeApp();
  const { book, treasury } = makeBook(app, { account: 0 });
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'SEK', amount: 1_000_000 }); // the demo feed has no SEK
  const nord = app.instruments.create({ productId: 'common_stock', name: 'Nordholm Verkstad AB', symbol: 'NORD', marketView: 'FOREIGN_CASH', venue: 'XSTO', venueCountry: 'SE', tradingCcy: 'SEK' });
  const input = { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: nord.id, qty: 100, statedPrice: 100 }] };
  let pv = await app.packages.preview(input);
  const missing = pv.checks.find((c) => c.code === 'fx-missing');
  assert.equal(missing.level, 'warning');
  assert.match(missing.message, /^No SEK\/USD conversion rate is available\. Amounts in SEK will be booked without a USD equivalent/);
  assert.equal(pv.blocking, 0, 'a purchase paid in its own currency is not blocked');
  // A rate that then goes stale: simulated observations are current for 60 seconds.
  app.data.market.set('SEK/USD', { value: 0.1 });
  await app.data.refresh({ pairs: ['SEK/USD'] });
  pv = await app.packages.preview(input);
  assert.equal(pv.checks.some((c) => c.code === 'fx-missing' || c.code === 'fx-stale'), false, 'a current rate: no warning');
  const refresh = app.data.refresh;
  app.data.refresh = async (need = {}) => refresh({ ...need, pairs: [] }); // the source stops answering for FX
  clock.advance(2 * 3600e3);
  pv = await app.packages.preview(input);
  app.data.refresh = refresh;
  const stale = pv.checks.find((c) => c.code === 'fx-stale');
  assert.match(stale.message, /^The SEK\/USD conversion rate is not current \(.*as of 2026-03-02T15:00:00\.000Z\)/);
});

test('a number of contracts stated for an exercise must be whole for a listed option', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 190);
  let pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long_call', underlyingId: inst.ALFA.id, options: { expiration: '2026-03-20', strikes: { call: 185 }, contracts: 3 } });
  pv = await app.packages.preview({ ...pv.input, legs: pv.legs.map((l) => ({ ...l, statedPrice: 7 })) });
  const s = (await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true })).strategy;
  const opt = s.positions[0];
  const api = createApi(app);
  const exercise = (contracts) => api.match('POST', `/api/positions/${opt.positionId}/lifecycle`).handler({ params: { id: opt.positionId }, query: {}, body: { action: 'exercise', contracts } });
  assert.throws(() => exercise(1.5), /The number of contracts must be a multiple of 1/);
  assert.throws(() => exercise(0), /positive number/);
  assert.throws(() => exercise('two'), /positive number/);
  assert.equal(app.positions.get(opt.positionId).qty, 3, 'nothing was exercised');
  exercise(1);
  assert.equal(app.positions.get(opt.positionId).qty, 2, 'one whole contract is exercised');
});

test('an order resting in a contract that expires ends with it and never fills afterwards', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 190);
  const input = { bookId: book.id, unitId: acct.id, template: 'long_call', underlyingId: inst.ALFA.id, options: { expiration: '2026-03-20', strikes: { call: 185 }, contracts: 1 }, orderType: 'limit', limitPrice: 0.5, tif: 'gtc' };
  const pv = await app.packages.preview(input);
  const s = (await app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token, confirm: true })).strategy;
  assert.equal(s.orders[0].status, 'working');
  const optionId = s.orders[0].instrument.id;
  app.data.market.set(`${inst.ALFA.id}@2026-03-20`, { value: 180 });
  await goTo(app, clock, '2026-03-20T15:00:00.000Z');
  assert.equal(app.packages.strategyView(s.id).orders[0].status, 'working', 'on its last day the order is still working');
  // Monday after expiry, with a quote the limit could fill against.
  app.data.market.set(optionId, { bid: 0.4, ask: 0.45, value: 0.45, bidSize: 100, askSize: 100 });
  await goTo(app, clock, '2026-03-23T15:00:00.000Z');
  const o = app.packages.strategyView(s.id).orders[0];
  assert.equal(o.status, 'expired');
  assert.equal(o.filledQty, 0);
  assert.match(o.statusReason, /expired on 2026-03-20; the unfilled order ended with it/);
  assert.equal(app.packages.strategyView(s.id).positions.length, 0);
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'order.expired' AND order_id = ?`, o.id).n, 1);
  await app.engine.tick();
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'order.expired' AND order_id = ?`, o.id).n, 1, 'a later cycle adds nothing');
});
