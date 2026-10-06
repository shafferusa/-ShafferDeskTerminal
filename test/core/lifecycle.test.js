import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo } from '../helpers.js';

const pin = (app, id, px, size = 1e6) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: size, askSize: size });
const confirm = (app, book, acct, sid, pv, extra = {}) => app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: sid, intent: pv.intent, legs: pv.legs, clientToken: pv.token, confirm: true, ...extra });

test('dividends: longs receive, shorts pay compensation on borrowed shares; entitlement is the ex-date holding', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 200); pin(app, inst.DLTA.id, 50);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.DLTA.id, quantity: 400 });
  app.corpactions.record({ instrumentId: inst.ALFA.id, type: 'cash_dividend', exDate: '2026-03-10', amount: 0.5 });
  app.corpactions.record({ instrumentId: inst.DLTA.id, type: 'cash_dividend', exDate: '2026-03-10', amount: 0.25 });
  // Bought on the ex-date itself: not entitled.
  await goTo(app, clock, '2026-03-10T14:00:00.000Z');
  const pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.categories.find((c) => c.key === 'dividends').rc, 150);
  const bf = pnl.categories.find((c) => c.key === 'borrowFunding');
  assert.ok(bf.rc <= -100 && bf.rc > -102, `dividend compensation of 100 plus a week of borrow fee (${bf.rc})`);
  const types = app.accounting.history(book.id, acct.id).events.map((e) => e.type);
  assert.ok(types.includes('dividend') && types.includes('dividend.compensation'));
  assert.deepEqual(ledgerImbalance(app), []);
});

test('stock split adjusts shares, listed options and the securities borrow', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 200);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'protective_put', underlyingId: inst.ALFA.id, quantity: 100, options: { expiration: '2026-04-17', strikes: { put: 190 } } });
  const cost = s.positions.find((p) => p.family === 'equity').cost;
  app.corpactions.record({ instrumentId: inst.ALFA.id, type: 'split', exDate: '2026-03-09', ratioNum: 2, ratioDen: 1 });
  await goTo(app, clock, '2026-03-09T14:00:00.000Z');
  const v = app.packages.strategyView(s.id);
  const stock = v.positions.find((p) => p.family === 'equity'), put = v.positions.find((p) => p.family === 'option');
  assert.equal(stock.qty, 200);
  assert.equal(stock.cost, cost, 'cost basis is unchanged');
  assert.equal(put.qty, 2);
  assert.equal(put.instrument.terms.strike, 95);
});

test('pairs trade: long one, borrow and short the other by the sizing ratio', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 200); pin(app, inst.DLTA.id, 50);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'pairs_trade', underlyingId: inst.ALFA.id, quantity: 100, pair: { instrumentId: inst.DLTA.id, ratio: 4 } });
  assert.deepEqual(s.orders.map((o) => [o.kind, o.action, o.qty, o.status]), [['trade', 'buy', 100, 'filled'], ['borrow_sec', 'borrow_sec', 400, 'filled'], ['trade', 'sell_short', 400, 'filled']]);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'pairs_trade', underlyingId: inst.ALFA.id, quantity: 100, pair: { instrumentId: inst.DLTA.id, ratio: 4 } });
  assert.equal(pv.payoff.type, 'scenarios');
  assert.deepEqual(pv.payoff.netExposure, { USD: 0 }, 'dollar neutral at these prices');
  assert.equal(pv.payoff.maxLoss.unbounded, true);
});

test('partial package: failed leg leaves residual exposure, with retry / unwind / accept as recovery', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app, { account: 25_000 });
  pin(app, inst.ALFA.id, 200); pin(app, inst.DLTA.id, 50);
  // Two buys in one custom package; cash covers both at preview, then DLTA gaps up before it fills.
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.ALFA.id, qty: 100 }, { kind: 'trade', action: 'buy', instrumentId: inst.DLTA.id, qty: 100, orderType: 'limit', limitPrice: 40, tif: 'gtc' }] });
  assert.equal(pv.blocking, 0);
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.equal(r.strategy.status, 'partial', 'one leg filled, one still working');
  assert.equal(r.strategy.complete, false);
  // Cancel the working leg: the package needs attention, it is not complete.
  let v = app.packages.applyAction(r.strategy.id, 'cancel_working');
  assert.equal(v.status, 'attention');
  assert.equal(v.residual.length, 1);
  assert.match(v.residual[0].label, /DLTA/);
  assert.ok(app.alerts.open(book.id).some((a) => a.code === 'strategy.attention'));
  assert.deepEqual(v.actions.filter((a) => ['retry', 'unwind', 'accept'].includes(a)), ['retry', 'unwind', 'accept']);
  // Retry re-submits only the failed leg, through preview and confirmation again.
  const retry = await app.packages.previewAction(v.id, 'retry');
  assert.equal(retry.legs.length, 1);
  assert.equal(retry.legs[0].instrument.symbol, 'DLTA');
  const legs = retry.legs.map((l) => ({ ...l, orderType: 'market', limitPrice: null }));
  const pv2 = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: v.id, intent: 'retry', legs });
  v = (await confirm(app, book, acct, v.id, pv2)).strategy;
  assert.equal(v.status, 'open');
  assert.equal(v.positions.length, 2);
  assert.equal(app.alerts.open(book.id).some((a) => a.code === 'strategy.attention'), false);
  void clock;
});

test('accepting a broken package records that it no longer matches its template', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 200);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.ALFA.id, qty: 100 }, { kind: 'trade', action: 'buy', instrumentId: inst.DLTA.id, qty: 100, orderType: 'limit', limitPrice: 1 }] });
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', legs: pv.legs, clientToken: pv.token, confirm: true });
  app.packages.applyAction(r.strategy.id, 'cancel_working');
  const v = app.packages.applyAction(r.strategy.id, 'accept');
  assert.equal(v.status, 'open');
  assert.match(v.note, /no longer matches its template/);
  assert.ok(app.accounting.history(book.id, acct.id).events.some((e) => e.type === 'strategy.accepted'));
});

test('roll and resize go through preview and confirmation and stay linked to the strategy', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'protective_put', underlyingId: inst.ALFA.id, quantity: 200, options: { expiration: '2026-03-20', strikes: { put: 185 } } });
  const put = s.positions.find((p) => p.family === 'option');
  const roll = await app.packages.previewAction(s.id, 'roll', { positionIds: [put.positionId], newExpiration: '2026-04-17', newStrike: 180 });
  assert.deepEqual(roll.legs.map((l) => [l.action, l.expiration, l.strike, l.qty]), [['sell', '2026-03-20', 185, 2], ['buy', '2026-04-17', 180, 2]]);
  let v = (await confirm(app, book, acct, s.id, roll)).strategy;
  const puts = v.positions.filter((p) => p.family === 'option');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].instrument.terms.expiration, '2026-04-17');
  assert.equal(puts[0].purpose, 'hedge');
  // Halve it.
  const half = await app.packages.previewAction(s.id, 'resize', { factor: 0.5 });
  assert.deepEqual(half.legs.map((l) => [l.action, l.qty]).sort(), [['sell', 1], ['sell', 100]]);
  v = (await confirm(app, book, acct, s.id, half)).strategy;
  assert.equal(v.positions.find((p) => p.family === 'equity').qty, 100);
  assert.equal(v.positions.find((p) => p.family === 'option').qty, 1);
  // Double it again.
  const dbl = await app.packages.previewAction(s.id, 'resize', { factor: 2 });
  v = (await confirm(app, book, acct, s.id, dbl)).strategy;
  assert.equal(v.positions.find((p) => p.family === 'equity').qty, 200);
  assert.equal(v.orders.every((o) => o.strategyId === s.id), true, 'every leg carries the one strategy-instance id');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a recalled borrow must be covered; otherwise a buy-in is forced at the deadline', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 200);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  const loan = s.positions.find((p) => p.family === 'secloan');
  const r = app.db.tx(() => app.products.get('secloan').recall(app, { book, unit: acct, inst: app.instruments.get(loan.instrument.id), pos: app.positions.get(loan.positionId) }));
  assert.equal(r.due, '2026-03-04');
  assert.ok(app.alerts.open(book.id).some((a) => a.code === 'secloan.recalled'));
  await goTo(app, clock, '2026-03-04T15:00:00.000Z');
  const v = app.packages.strategyView(s.id);
  assert.equal(v.status, 'closed');
  assert.ok(v.orders.some((o) => o.role === 'forced_buy_in' && o.status === 'filled'));
  assert.ok(app.accounting.history(book.id, acct.id).events.some((e) => e.type === 'secloan.buy_in'));
  assert.deepEqual(ledgerImbalance(app), []);
});
