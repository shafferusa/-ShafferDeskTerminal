import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo, DAY, HOUR } from '../helpers.js';

const pin = (app, inst, bid, ask, size = 1e6) => app.data.market.set(inst.id, { bid, ask, value: (bid + ask) / 2, bidSize: size, askSize: size });

test('long: fills at the ask, records the quote used, settles T+1, realizes on sale', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 99.98, 100.02);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 100 });
  assert.equal(s.status, 'open');
  const o = s.orders[0];
  assert.equal(o.status, 'filled');
  assert.equal(o.avgPrice, 100.02, 'buys at the ask, not the last price');
  const f = o.fills[0];
  assert.equal(f.model, 'quoted-bid-ask');
  assert.equal(f.priceObservation.status, 'simulated');
  assert.equal(f.priceObservation.ask, 100.02);
  assert.equal(f.settleDate, '2026-03-03');
  // Trade date: position exists, cash not yet paid.
  let c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.settled, 500_000);
  assert.equal(c.payable, 10_002);
  assert.equal(c.availableToTrade, 489_998);
  await advance(app, clock, DAY);
  c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.settled, 489_998);
  assert.equal(c.payable, 0);
  // Sell half at a higher bid.
  pin(app, inst.ALFA, 110, 110.04);
  const pv = await app.packages.previewAction(s.id, 'close', { fraction: 0.5 });
  assert.equal(pv.blocking, 0);
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'close', legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.equal(r.strategy.positions[0].qty, 50);
  const pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.categories.find((x) => x.key === 'realized').rc, 499, '50 x (110.00 - 100.02)');
  assert.equal(pnl.unrealized.current, 500, '50 x (110.02 mark - 100.02)');
  assert.deepEqual(ledgerImbalance(app), []);
  // NAV identity: capital + internal funding + P&L = NAV.
  assert.equal(pnl.nav.end, 500_000 + 499 + 500);
});

test('large orders fill in parts against displayed size; each leg status is tracked', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 100, 100.02, 300);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000 });
  assert.equal(s.orders[0].status, 'partial');
  assert.equal(s.orders[0].filledQty, 300);
  assert.equal(s.status, 'partial');
  const pend = app.accounting.pending(book.id, acct.id);
  assert.equal(pend.partiallyFilled.length, 1);
  assert.equal(pend.partiallyFilled[0].remainingQty, 700);
  assert.equal(pend.awaitingSettlement.length, 1, 'the executed part is awaiting settlement, shown separately');
  await advance(app, clock, 5000, { ticks: 3 });
  const v = app.packages.strategyView(s.id);
  assert.equal(v.orders[0].status, 'filled');
  assert.equal(v.orders[0].fills.length, 4);
  assert.equal(v.status, 'open');
});

test('limit orders wait; day orders expire unfilled at end of day and land on the Failed tab', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 100, 100.02);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 100, orderType: 'limit', limitPrice: 99 });
  assert.equal(s.orders[0].status, 'working');
  assert.match(s.orders[0].statusReason, /Limit not reached/);
  pin(app, inst.ALFA, 98.9, 98.95);
  await advance(app, clock, 3000);
  assert.equal(app.packages.strategyView(s.id).orders[0].avgPrice, 98.95);

  const s2 = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.DLTA.id, quantity: 10, orderType: 'limit', limitPrice: 1 });
  assert.equal(s2.status, 'working');
  await goTo(app, clock, '2026-03-02T22:30:00.000Z'); // after the 17:00 New York cutoff
  const v2 = app.packages.strategyView(s2.id);
  assert.equal(v2.orders[0].status, 'expired');
  assert.equal(v2.status, 'failed');
  const failed = app.accounting.failed(book.id, acct.id);
  assert.ok(failed.orders.some((o) => o.id === v2.orders[0].id && o.category === 'Expired unfilled'));
});

test('short: borrow first, proceeds are restricted, fees accrue, cover returns the borrow', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 200, 200.04);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  assert.equal(s.status, 'open');
  assert.deepEqual(s.orders.map((o) => [o.kind, o.status]), [['borrow_sec', 'filled'], ['trade', 'filled']]);
  assert.equal(s.orders[1].avgPrice, 200, 'sells at the bid');
  const short = s.positions.find((p) => p.family === 'equity');
  assert.equal(short.qty, -100);
  assert.equal(s.positions.find((p) => p.family === 'secloan').qty, 100);
  let c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.availableToTrade, 500_000 - 0.3 * 100 * 200.02, 'proceeds are not buying power; a margin hold applies');
  await goTo(app, clock, '2026-03-03T22:30:00.000Z');
  c = app.ledger.cash(acct.id, 'USD');
  const px = app.data.price(inst.ALFA.id).value;
  assert.equal(c.restricted, Math.round(1.02 * 100 * px * 100) / 100, 'collateral is 102% of market value');
  assert.equal(c.settled + c.restricted, 520_000, 'only the top-up came out of free cash');
  const fee = -app.ledger.balance(acct.id, 'accrued.liab', 'USD');
  assert.ok(fee > 0.2 && fee < 0.4, `one day of borrow fee at 0.5% on ~20,000 (${fee})`);
  // Close: buy to cover, then return the borrow.
  pin(app, inst.ALFA, 189.96, 190);
  await app.data.refresh({ instruments: [inst.ALFA] });
  const pv = await app.packages.previewAction(s.id, 'close');
  assert.deepEqual(pv.legs.map((l) => l.kind), ['trade', 'return_sec']);
  assert.equal(pv.legs[0].action, 'buy_to_cover');
  assert.deepEqual(pv.legs[1].dependsOn, [1]);
  assert.equal(pv.blocking, 0);
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'close', legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.equal(r.strategy.status, 'closed');
  await goTo(app, clock, '2026-03-04T22:30:00.000Z');
  c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.restricted, 0, 'collateral is released once the cover settles');
  const pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.categories.find((x) => x.key === 'realized').rc, 1000, '100 x (200 - 190)');
  assert.ok(pnl.categories.find((x) => x.key === 'borrowFunding').rc < 0);
  assert.equal(c.settled, 500_000 + pnl.investmentPnl);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a failed borrow prevents its dependent short sale', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  // Preview: unavailable borrow blocks submission outright.
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.CHRL.id, quantity: 100 });
  assert.ok(pv.blocking > 0);
  assert.match(pv.checks.find((c) => c.code === 'borrow-unavailable').message, /not available to borrow/);
  // Limited supply.
  const pv2 = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.BRVO.id, quantity: 500 });
  assert.match(pv2.checks.find((c) => c.code === 'borrow-short').message, /only 300/);
  // Borrow disappears between preview and execution: the borrow leg fails and the sale is rejected with it.
  const ok = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  assert.equal(ok.blocking, 0);
  app.data.market.setBorrow(inst.ALFA.id, { available: false, quantity: 0, feeRate: 0 });
  await assert.rejects(app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100, legs: ok.legs, clientToken: ok.token, confirm: true }), /not available to borrow/);
  assert.equal(app.packages.listStrategies({ bookId: book.id }).length, 0, 'nothing was submitted');
});

test('dependency failure at execution rejects the dependent leg and never marks the strategy complete', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  // Simulate the borrow vanishing after validation but before the matching pass.
  const realPreview = app.packages.preview;
  const orig = app.data.borrowInfo;
  let calls = 0;
  app.data.borrowInfo = (id) => (++calls > 1 ? { available: false, quantity: 0, feeRate: 0, obs: { source: 'Simulated demo feed' } } : orig(id));
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100, legs: pv.legs, clientToken: pv.token, confirm: true });
  app.data.borrowInfo = orig;
  void realPreview;
  const [borrow, sale] = r.strategy.orders;
  assert.equal(borrow.status, 'rejected');
  assert.equal(sale.status, 'rejected');
  assert.match(sale.statusReason, /Dependency failed/);
  assert.equal(r.strategy.status, 'failed');
  assert.equal(r.strategy.complete, false);
  assert.equal(r.strategy.positions.length, 0);
});

test('insufficient cash blocks the trade unless explicit financing is included', async () => {
  const { app, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app, { account: 10_000 });
  app.data.market.set(inst.ALFA.id, { bid: 100, ask: 100, value: 100, bidSize: 1e6, askSize: 1e6 });
  const base = { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 500 };
  const pv = await app.packages.preview(base);
  assert.ok(pv.blocking);
  assert.match(pv.checks.find((c) => c.code === 'cash').message, /short 40,000\.00 USD/);
  // Treasury funding leg sized to the shortfall.
  const s = await trade(app, { ...base, financing: { mode: 'treasury' } });
  assert.deepEqual(s.orders.map((o) => o.kind), ['funding', 'trade']);
  assert.equal(s.status, 'open');
  assert.equal(app.ledger.cash(treasury.id, 'USD').settled, 990_000 - 40_000);
  // Borrowing leg: borrowed cash is a liability, not income.
  const s2 = await trade(app, { ...base, financing: { mode: 'loan', rateType: 'fixed', rate: 0.06 } });
  assert.deepEqual(s2.orders.map((o) => o.kind), ['loan', 'trade']);
  const loan = s2.positions.find((p) => p.family === 'loan');
  assert.equal(loan.qty, -50_000);
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'USD'), -50_000);
  const nav = app.accounting.overview(book.id);
  assert.equal(nav.nav, 1_000_000, 'borrowing does not change NAV');
});

test('a confirmation token can be used only once', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const input = { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 10 };
  const pv = await app.packages.preview(input);
  await assert.rejects(app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token }), /Explicit confirmation/);
  const a = await app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token, confirm: true });
  const b = await app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.strategy.id, a.strategy.id);
  assert.equal(app.packages.listStrategies({ bookId: book.id }).length, 1);
  assert.equal(app.packages.strategyView(a.strategy.id).positions[0].qty, 10);
});

test('a plain sell or cover from the ticket reduces one position by an exact quantity', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 100, 100);
  const long = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 700 });
  const pos = long.positions[0];
  const pv = await app.packages.previewAction(long.id, 'close', { positionIds: [pos.positionId], qty: 300, order: { orderType: 'limit', limitPrice: 99, tif: 'gtc' } });
  assert.equal(pv.blocking, 0);
  assert.equal(pv.legs.length, 1);
  assert.equal(pv.legs[0].action, 'sell');
  assert.equal(pv.legs[0].qty, 300, 'exactly the quantity asked for, not a rounded fraction');
  assert.equal(pv.legs[0].orderType, 'limit');
  await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.equal(app.positions.get(pos.positionId).qty, 400);
  await assert.rejects(() => app.packages.previewAction(long.id, 'close', { positionIds: [pos.positionId], qty: 500 }), /more than it holds/);

  // Covering part of a short buys to cover and returns the same quantity of the borrow.
  pin(app, inst.BRVO, 50, 50);
  const short = await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.BRVO.id, quantity: 200 });
  const sp = short.positions.find((p) => p.qty < 0);
  const cover = await app.packages.previewAction(short.id, 'close', { positionIds: [sp.positionId], qty: 50 });
  assert.equal(cover.blocking, 0);
  assert.deepEqual(cover.legs.map((l) => [l.kind, l.action, l.qty]), [['trade', 'buy_to_cover', 50], ['return_sec', 'return_sec', 50]]);
  const after = (await app.packages.submit({ ...cover.input, legs: cover.legs, clientToken: cover.token, confirm: true })).strategy;
  assert.equal(after.positions.find((p) => p.instrument.id === inst.BRVO.id).qty, -150);
  assert.equal(after.positions.find((p) => p.family === 'secloan').qty, 150, 'the borrow shrinks with the short');
  assert.deepEqual(ledgerImbalance(app), []);
});
