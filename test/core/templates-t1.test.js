// Engine regressions found while driving the execution templates as linked packages (test matrix, templates-a).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';

const pin = (app, inst, bid, ask, size = 1e6) => app.data.market.set(inst.id, { bid, ask, value: (bid + ask) / 2, bidSize: size, askSize: size });

test('a cover is paid from the short\'s restricted collateral: the preview does not ask for free cash it will not use', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app, { account: 20_000 });
  pin(app, inst.ALFA, 200, 200.04);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  await goTo(app, clock, '2026-03-03T22:30:00.000Z'); // the sale settles into restricted cash; the 2% top-up posts
  // Move every free dollar to Treasury: nothing is left to trade with, but the restricted collateral (about 20,400) stays.
  const free = app.ledger.cash(acct.id, 'USD').availableToWithdraw;
  app.books.transfer({ bookId: book.id, fromUnitId: acct.id, toUnitId: treasury.id, ccy: 'USD', amount: free, purpose: 'sweep' });
  assert.equal(app.ledger.cash(acct.id, 'USD').availableToTrade, 0);
  pin(app, inst.ALFA, 189.96, 190);
  await app.data.refresh({ instruments: [inst.ALFA] });
  const pv = await app.packages.previewAction(s.id, 'close');
  // 100 x 190 = 19,000 plus 1.00 of commission at the Book default schedule: all of it from restricted cash.
  const c = pv.totals.cash.USD;
  assert.equal(pv.blocking, 0, pv.checks.filter((x) => x.level === 'error').map((x) => x.message).join(' | '));
  assert.ok(c.coverCollateral > 19_000 - 1e-9 && c.coverCollateral <= c.purchases + c.fees + 1e-9, `paid from collateral: ${c.coverCollateral}`);
  assert.equal(c.shortfall, 0);
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'close', legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.equal(r.strategy.status, 'closed', 'the order engine pays the cover from restricted cash, as the preview said');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a resized short holds two borrows; closing half returns half of each, as together they support what is still short', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 200, 200.04);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  const grow = await app.packages.previewAction(s.id, 'resize', { factor: 2 });
  assert.deepEqual(grow.legs.map((l) => [l.kind, l.qty]), [['borrow_sec', 100], ['trade', 100]], 'the resize borrows again');
  await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'resize', legs: grow.legs, clientToken: grow.token, confirm: true });
  const half = await app.packages.previewAction(s.id, 'close', { fraction: 0.5 });
  assert.deepEqual(half.legs.map((l) => [l.kind, l.qty]), [['trade', 100], ['return_sec', 50], ['return_sec', 50]]);
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'close', legs: half.legs, clientToken: half.token, confirm: true });
  const last = r.strategy.orders.filter((o) => o.submission === half.token);
  assert.deepEqual(last.map((o) => [o.kind, o.status]), [['trade', 'filled'], ['return_sec', 'filled'], ['return_sec', 'filled']], last.map((o) => o.statusReason).join(' | '));
  const left = r.strategy.positions.filter((p) => p.family === 'secloan').reduce((a, p) => a + p.qty, 0);
  assert.equal(left, 100, '200 borrowed, 100 returned: 100 still borrowed against the 100 still short');
  assert.equal(r.strategy.positions.find((p) => p.family === 'equity').qty, -100);
  // A return beyond what the short leaves free is still refused.
  const tooMuch = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, legs: [{ kind: 'return_sec', action: 'return_sec', purpose: 'financing', targetPositionId: r.strategy.positions.find((p) => p.family === 'secloan').positionId, qty: 50 }] });
  assert.ok(tooMuch.checks.some((c) => c.level === 'error' && /still sold short against this borrow/.test(c.message)));
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a protective put waits for its shares: the put is not bought while the stock leg is unfilled, and a retry keeps that link', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 200, 200.04);
  const input = { bookId: book.id, unitId: acct.id, template: 'protective_put', underlyingId: inst.ALFA.id, quantity: 100, options: { expiration: '2026-04-17', strikes: { put: 190 } } };
  const first = await app.packages.preview(input);
  assert.deepEqual(first.legs.map((l) => l.dependsOn), [[], [1]], 'the put depends on the stock leg');
  // The stock at a limit the market never reaches: no shares, so no put either.
  const legs = first.legs.map((l, i) => (i === 0 ? { ...l, orderType: 'limit', limitPrice: 150, tif: 'gtc' } : l));
  const pv = await app.packages.preview({ ...input, legs, clientToken: first.token });
  const r = await app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.deepEqual(r.strategy.orders.map((o) => o.filledQty || 0), [0, 0], r.strategy.orders.map((o) => `${o.status} ${o.statusReason || ''}`).join(' | '));
  assert.equal(r.strategy.positions.length, 0, 'an unprotected put on shares not held is never bought');
  const v = app.packages.applyAction(r.strategy.id, 'cancel_working');
  const retry = await app.packages.previewAction(v.id, 'retry');
  assert.deepEqual(retry.legs.map((l) => l.dependsOn), [[], [1]], 'the retried put still waits for the retried shares');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('resizing a protective package: the added options wait for the added underlying, as in the template', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 200, 200.04);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'protective_put', underlyingId: inst.ALFA.id, quantity: 100, options: { expiration: '2026-04-17', strikes: { put: 190 } } });
  const pv = await app.packages.previewAction(s.id, 'resize', { factor: 2 });
  assert.deepEqual(pv.legs.map((l) => [l.kind, l.action, l.qty, l.dependsOn]), [['trade', 'buy', 100, []], ['trade', 'buy', 1, [1]]]);
});

test('a protective call exercised against the short it protects returns the borrow: nothing stays borrowed against nothing sold', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 200, 200.04);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'protective_call', underlyingId: inst.ALFA.id, quantity: 100, options: { expiration: '2026-04-17', strikes: { call: 190 } } });
  const callPos = app.positions.get(s.positions.find((p) => p.family === 'option').positionId);
  const callInst = app.instruments.get(callPos.instrument_id);
  app.products.get(callInst.family).exercise(app, { book, unit: acct, inst: callInst, pos: callPos });
  app.packages.refreshStrategy(s.id); // as the position lifecycle route does after an exercise
  const v = app.packages.strategyView(s.id);
  assert.deepEqual(v.positions.map((p) => [p.family, p.qty]), [], 'the 100 shares received cover the short and the borrow goes back');
  assert.equal(v.status, 'closed');
  assert.ok(app.accounting.history(book.id, acct.id).events.some((e) => e.type === 'secloan.return'));
  assert.deepEqual(ledgerImbalance(app), []);
});
