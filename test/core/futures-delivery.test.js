// Physical delivery of futures, decided by each contract's own settlement terms.
//
// Found by the futures matrix (commodity_future, step request-delivery): a `deliver` lifecycle action had been added
// for spot assets and answered "Physical delivery does not apply to this position" for every future, whatever its
// terms, while a physically delivered contract held to expiry was closed in cash. Now:
//   - a physically delivered contract whose deliverable is configured (Underlying = the deliverable asset) is
//     delivered on paper when held to the last trading day: the contracts close at the final settlement price,
//     margin is released, the goods are received (long) or given up (short) at the invoice amount, payable or
//     receivable on the deliverable's own settlement date, and the entries say "simulated";
//   - the short may give notice during the delivery window, at the settlement price of the day;
//   - each request the terms do not allow is refused with its own reason: cash-settled, bond future (basket not
//     modelled), no deliverable configured, more contracts than held, before the window, wrong side, closed
//     position, settlement price not yet published, short without the goods.
// Every figure below is worked by hand from the inputs in the test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../server/api.js';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';

const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e6, askSize: 1e6 });
const settle = (app, id, date, px) => app.data.market.set(`${id}@${date}`, { value: px });
const NO_FEES = { fees: { future: { perUnit: 0, minimum: 0, bps: 0 }, spot: { perUnit: 0, minimum: 0, bps: 0 } }, settlement: { spot: 2, future: 0 } };

function setup(at) {
  const { app, clock, inst } = makeApp({ at });
  const { book, acct } = makeBook(app, { cash: 2_000_000, account: 1_000_000 });
  app.books.updateSettings(book.id, NO_FEES);
  const api = createApi(app);
  const deliver = (positionId, body = {}) => api.match('POST', `/api/positions/${positionId}/lifecycle`).handler({ params: { id: positionId }, query: {}, body: { action: 'deliver', ...body } });
  return { app, clock, inst, book, acct, deliver };
}
const rejects = (p, code, re) => assert.rejects(() => Promise.resolve().then(p), (err) => { assert.equal(err.code, code, err.message); if (re) assert.match(err.message, re); return true; });

function oil(app, { underlying = true } = {}) {
  const wti = app.instruments.create({ productId: 'crude_oil', name: 'WTI crude oil, Cushing', symbol: 'WTI-T', venueType: 'otc', venueCountry: 'US', marketView: 'US_CASH', tradingCcy: 'USD', terms: { quantityUnit: 'barrels', priceUnits: 'USD per barrel' } });
  const cl = app.instruments.create({ productId: 'commodity_future', name: 'Light sweet crude future, June 2026', symbol: 'CLM6T', venue: 'NYMEX', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', multiplier: 1000,
    underlyingId: underlying ? wti.id : undefined,
    terms: { root: 'CL', expiration: '2026-05-19', tickSize: 0.01, initialMargin: 6000, settlement: 'physical', priceUnits: 'USD per barrel', delivery: { units: 1000, grade: 'Light sweet crude oil', location: 'Cushing, Oklahoma' } } });
  return { wti, cl };
}

test('a long physically delivered future held to the last trading day is delivered on paper at the invoice amount', async () => {
  const { app, clock, book, acct, deliver } = setup('2026-05-11T14:00:00.000Z'); // Monday 11 May 2026, 10:00 New York
  const { wti, cl } = oil(app);
  pin(app, cl.id, 60); pin(app, wti.id, 60.20);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: cl.id, qty: 2 }] });
  const posId = s.positions[0].positionId;
  // Margin 2 x 6,000 = 12,000 out of 1,000,000.
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 988_000);

  await rejects(() => deliver(posId, { contracts: 3 }), 'delivery_more_than_held', /requested, but this CLM6T position holds only 2/);
  await rejects(() => deliver(posId, { contracts: 2 }), 'delivery_before_window', /accepted from 2026-05-19 \(first notice day\)/);
  await goTo(app, clock, '2026-05-19T14:00:00.000Z');
  await rejects(() => deliver(posId, { contracts: 2 }), 'delivery_wrong_side', /Only the short side gives notice/);

  // Final settlement 62.50 on 19 May: variation (62.50 - 60) x 1,000 x 2 = 5,000 received, margin 12,000 released;
  // 2,000 barrels received at 62.50: invoice 125,000 payable T+2 on 21 May.
  settle(app, cl.id, '2026-05-19', 62.5);
  await goTo(app, clock, '2026-05-19T21:30:00.000Z');
  const c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.margin, 0);
  assert.equal(c.settled, 1_005_000); // 988,000 + 5,000 + 12,000
  const goods = app.positions.find(acct.id, wti.id, s.id);
  assert.equal(goods.qty, 2000);
  assert.equal(goods.cost, 125_000);
  const pend = app.db.all(`SELECT due_date, amount FROM settlements WHERE position_id = ? AND status = 'pending'`, goods.id);
  assert.deepEqual(pend.map((x) => [x.due_date, x.amount]), [['2026-05-21', -125_000]]);
  const ev = app.accounting.history(book.id, acct.id).events;
  assert.ok(ev.some((e) => e.type === 'future.final_settlement' && /closed at 62.50 for simulated physical delivery/.test(e.summary)));
  assert.ok(ev.some((e) => e.type === 'future.delivery' && /Simulated delivery \(paper entry, no goods move\): received 2,000 barrels WTI-T/.test(e.summary) && /125,000.00 USD payable 2026-05-21/.test(e.summary)));
  assert.equal(app.positions.get(posId).qty, 0);
  await rejects(() => deliver(posId, { contracts: 1 }), 'delivery_position_closed', /closed: it holds no contracts/);

  await goTo(app, clock, '2026-05-21T14:00:00.000Z');
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 880_000); // 1,005,000 - 125,000
  assert.deepEqual(ledgerImbalance(app), []);
});

test('the short gives notice during the delivery window and delivers goods it holds; without them it is refused or blocked', async () => {
  const { app, clock, book, acct, deliver } = setup('2026-05-26T14:00:00.000Z'); // Tuesday 26 May 2026
  // Gold, modelled on COMEX: 100 troy ounces a contract; June contract first notice day 29 May, last trading day 26 June.
  const au = app.instruments.create({ productId: 'precious_metal', name: 'Gold, 100 oz bar', symbol: 'AU-T', venueType: 'otc', venueCountry: 'US', marketView: 'US_CASH', tradingCcy: 'USD', terms: { quantityUnit: 'troy ounces', priceUnits: 'USD per troy ounce' } });
  const gc = app.instruments.create({ productId: 'commodity_future', name: 'Gold future, June 2026', symbol: 'GCM6T', venue: 'COMEX', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', multiplier: 100, underlyingId: au.id,
    terms: { root: 'GC', expiration: '2026-06-26', tickSize: 0.1, initialMargin: 10_000, settlement: 'physical', priceUnits: 'USD per troy ounce', delivery: { units: 100, firstNotice: '2026-05-29', grade: 'Gold, at least 995 fine', location: 'Exchange-approved vault, New York' } } });
  pin(app, au.id, 2400); pin(app, gc.id, 2410);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: au.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: au.id, qty: 200 }] }); // 480,000 payable 28 May
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: gc.id, qty: 3 }] });
  const posId = s.positions[0].positionId;
  await rejects(() => deliver(posId, { contracts: 2 }), 'delivery_before_window', /accepted from 2026-05-29/);
  await rejects(() => deliver(posId, { contracts: 1.5 }), 'delivery_contracts');

  await goTo(app, clock, '2026-05-29T14:00:00.000Z'); // Friday 29 May, 10:00: no settlement price yet today
  await rejects(() => deliver(posId, { contracts: 2 }), 'delivery_awaiting_price', /settlement price of GCM6T for 2026-05-29/);
  // 3 contracts need 300 oz; 200 are held.
  settle(app, gc.id, '2026-05-29', 2390);
  await goTo(app, clock, '2026-05-29T21:30:00.000Z'); // variation on the short: (2,390 - 2,410) x 100 x -3 = +6,000
  await rejects(() => deliver(posId, { contracts: 3 }), 'delivery_goods_short', /300 troy ounces of AU-T must be delivered, but Alpha holds 200/);
  const before = app.ledger.cash(acct.id, 'USD');
  // 1,000,000 - 480,000 (gold, settled 28 May) - 30,000 margin + 6,000 variation = 496,000.
  assert.equal(before.settled, 496_000);
  const r = await deliver(posId, { contracts: 2 });
  assert.equal(r.result.invoice, 478_000); // 2 x 100 x 2,390
  const c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.margin, 10_000, 'one contract still open');
  assert.equal(c.settled, 516_000); // 496,000 + 20,000 released; realized 0 since marked at 2,390 this evening
  assert.equal(app.positions.get(posId).qty, -1);
  const goldLeft = app.positions.list({ unitIds: [acct.id] }).filter((p) => p.instrument_id === au.id).reduce((a, p) => a + p.qty, 0);
  assert.equal(goldLeft, 0);
  // Gold sold on delivery at 2,390 against cost 2,400: realized (2,390 - 2,400) x 200 = -2,000; 478,000 receivable 2 June.
  const recv = app.db.all(`SELECT due_date, amount FROM settlements WHERE instrument_id = ? AND status = 'pending'`, au.id);
  assert.deepEqual(recv.map((x) => [x.due_date, x.amount]), [['2026-06-02', 478_000]]);

  // The last contract held to the last trading day, with no gold left: the delivery waits, visibly.
  settle(app, gc.id, '2026-06-26', 2450);
  await goTo(app, clock, '2026-06-26T21:30:00.000Z');
  const task = app.db.get(`SELECT status, blocked_reason FROM tasks WHERE position_id = ? AND type = 'future.expiry'`, posId);
  assert.equal(task.status, 'blocked');
  assert.match(task.blocked_reason, /100 troy ounces of AU-T must be delivered, but Alpha holds 0/);
  assert.equal(app.positions.get(posId).qty, -1);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('delivery is refused with the contract\'s own reason when its terms do not provide for it', async () => {
  const { app, inst, book, acct, deliver } = setup('2026-03-02T15:00:00.000Z');
  // Cash-settled index future from the demo seed.
  const s5 = inst['S5 2026-03'];
  pin(app, s5.id, 5000);
  const a = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: s5.id, qty: 1 }] });
  await rejects(() => deliver(a.positions[0].positionId), 'delivery_cash_settled', /is cash-settled under its contract terms/);
  // A Treasury future: physically delivered, but the deliverable basket is not modelled.
  const ty = app.instruments.create({ productId: 'treasury_future', name: '10-Year Note future, June 2026', symbol: 'TYM6T', venue: 'CBOT', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', multiplier: 1000, terms: { root: 'TY', expiration: '2026-06-18', initialMargin: 2200, settlement: 'physical' } });
  pin(app, ty.id, 112);
  const b = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: ty.id, qty: 1 }] });
  await rejects(() => deliver(b.positions[0].positionId), 'delivery_bond_future', /conversion factor plus its accrued interest/);
  // A physically delivered commodity future without a deliverable configured.
  const { cl } = oil(app, { underlying: false });
  pin(app, cl.id, 60);
  const c = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: cl.id, qty: 1 }] });
  await rejects(() => deliver(c.positions[0].positionId), 'delivery_not_configured', /No deliverable is configured for CLM6T/);
  assert.equal(app.instruments.get(cl.id).terms.delivery.units, 1000);
});
