// Engine regressions found while driving the cash-secured put template as a linked package (test matrix, templates-a, t1b).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, ledgerImbalance } from '../helpers.js';

const pin = (app, inst, bid, ask, size = 1e6) => app.data.market.set(inst.id, { bid, ask, value: (bid + ask) / 2, bidSize: size, askSize: size });
const putOn = (app, und, strike) => app.instruments.ensureOption({ underlyingId: und.id, expiration: '2026-04-17', strike, right: 'P', multiplier: 100, deliverableUnits: 100, exercise: 'american', settlement: 'physical', refSource: 'demo' });
const holdsOf = (app, unitId, strategyId) => Object.fromEntries(['exercise_cash', 'option_margin'].map((k) => [k, app.ledger.listHolds([unitId]).filter((h) => h.ref_type === 'strategy' && h.ref_id === strategyId && h.kind === k).reduce((a, h) => a + h.amount, 0)]));
const confirm = async (app, input) => { const pv = await app.packages.preview(input); assert.equal(pv.blocking, 0, pv.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' | ')); return app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token, confirm: true }); };

test('a cash-secured put is secured by its own reservation: written when the Account holds exactly the exercise cash', async () => {
  const { app, inst } = makeApp();
  // 1 contract of the 190 put: 1 x 100 x 190 = 19,000 reserved. The Account has exactly that; the premium pays the commission.
  const { book, acct } = makeBook(app, { account: 19_000 });
  pin(app, inst.ALFA, 200, 200.04);
  const put = putOn(app, inst.ALFA, 190);
  pin(app, put, 2.0, 2.1);
  const r = await confirm(app, { bookId: book.id, unitId: acct.id, template: 'cash_secured_put', underlyingId: inst.ALFA.id, options: { expiration: '2026-04-17', strikes: { put: 190 }, contracts: 1 } });
  assert.deepEqual(r.strategy.orders.map((o) => [o.kind, o.status]), [['reserve', 'filled'], ['trade', 'filled']], r.strategy.orders.map((o) => o.statusReason).join(' | '));
  // The put needs 19,000, all of it already reserved: nothing more is held for it.
  assert.deepEqual(holdsOf(app, acct.id, r.strategy.id), { exercise_cash: 19_000, option_margin: 0 });
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a cash-secured put releases the reservation its written puts no longer need: a part-filled sale cancelled, puts bought back', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 200, 200.04);
  const put = putOn(app, inst.ALFA, 190);
  pin(app, put, 2.0, 2.1, 1); // one contract displayed: one is written on confirmation, one in the next cycle
  const r = await confirm(app, { bookId: book.id, unitId: acct.id, template: 'cash_secured_put', underlyingId: inst.ALFA.id, options: { expiration: '2026-04-17', strikes: { put: 190 }, contracts: 3 } });
  const sid = r.strategy.id;
  assert.equal(r.strategy.orders[1].filledQty, 1);
  assert.deepEqual(holdsOf(app, acct.id, sid), { exercise_cash: 57_000, option_margin: 0 }, 'while the sale works, all 3 x 19,000 stays reserved');
  app.packages.applyAction(sid, 'cancel_working');
  assert.deepEqual(holdsOf(app, acct.id, sid), { exercise_cash: 19_000, option_margin: 0 }, 'the 1 put written needs 19,000; 38,000 is released');
  // Two more written by a resize (the reservation stays; the rest is option margin), then two bought back.
  pin(app, put, 2.0, 2.1);
  const grow = await app.packages.previewAction(sid, 'resize', { factor: 3 });
  await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: sid, intent: 'resize', legs: grow.legs, clientToken: grow.token, confirm: true });
  assert.deepEqual(holdsOf(app, acct.id, sid), { exercise_cash: 19_000, option_margin: 38_000 });
  const cut = await app.packages.previewAction(sid, 'close', { fraction: 2 / 3 });
  await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: sid, intent: 'close', legs: cut.legs, clientToken: cut.token, confirm: true });
  assert.deepEqual(holdsOf(app, acct.id, sid), { exercise_cash: 19_000, option_margin: 0 }, 'one put left: 19,000');
  const all = await app.packages.previewAction(sid, 'close');
  await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: sid, intent: 'close', legs: all.legs, clientToken: all.token, confirm: true });
  assert.deepEqual(holdsOf(app, acct.id, sid), { exercise_cash: 0, option_margin: 0 });
  assert.equal(app.ledger.cash(acct.id, 'USD').reserved, 0);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a cash-secured put with financing: the reservation waits for the funding leg', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app, { account: 1_000 });
  pin(app, inst.ALFA, 200, 200.04);
  const put = putOn(app, inst.ALFA, 190);
  pin(app, put, 2.0, 2.1);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'cash_secured_put', underlyingId: inst.ALFA.id, options: { expiration: '2026-04-17', strikes: { put: 190 }, contracts: 1 }, financing: { mode: 'treasury' } });
  assert.deepEqual(pv.legs.map((l) => [l.kind, l.dependsOn]), [['funding', []], ['reserve', [1]], ['trade', [2, 1]]]);
  assert.equal(pv.legs[0].qty, 18_000, '19,000 reserved before the premium arrives; 1,000 free');
});

test('a vertical spread keeps its written leg covered when resized and rolled', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA, 200, 200.04);
  const call = (strike, expiration = '2026-04-17') => app.instruments.ensureOption({ underlyingId: inst.ALFA.id, expiration, strike, right: 'C', multiplier: 100, deliverableUnits: 100, exercise: 'american', settlement: 'physical', refSource: 'demo' });
  pin(app, call(200), 8, 8.2); pin(app, call(210), 4, 4.2); pin(app, call(200, '2026-05-15'), 11, 11.2); pin(app, call(210, '2026-05-15'), 6, 6.2);
  const r = await confirm(app, { bookId: book.id, unitId: acct.id, template: 'bull_call_spread', underlyingId: inst.ALFA.id, options: { expiration: '2026-04-17', strikes: { lower: 200, upper: 210 }, contracts: 2 } });
  const sid = r.strategy.id;
  // Resize: the added written calls wait for the added bought calls (as the template opened them).
  const grow = await app.packages.previewAction(sid, 'resize', { factor: 2 });
  assert.deepEqual(grow.legs.map((l) => [l.action, l.strike, l.dependsOn]), [['buy', 200, []], ['sell', 210, [1]]]);
  // Roll: written calls bought back first, the covering calls sold after them; the new written calls wait for the new bought ones.
  const roll = await app.packages.previewAction(sid, 'roll', { newExpiration: '2026-05-15' });
  assert.deepEqual(roll.legs.map((l) => [l.action, l.strike, l.expiration, l.dependsOn]), [['buy', 210, '2026-04-17', []], ['sell', 200, '2026-04-17', [1]], ['buy', 200, '2026-05-15', []], ['sell', 210, '2026-05-15', [3]]]);
  const done = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: sid, intent: 'roll', legs: roll.legs, clientToken: roll.token, confirm: true });
  assert.equal(done.strategy.status, 'open', done.strategy.orders.map((o) => `${o.status} ${o.statusReason || ''}`).join(' | '));
  assert.deepEqual(ledgerImbalance(app), []);
});
