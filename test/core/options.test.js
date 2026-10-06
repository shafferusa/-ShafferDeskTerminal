import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo, DAY } from '../helpers.js';

const EXP = '2026-03-20';
const pinStock = (app, inst, px) => app.data.market.set(inst.id, { bid: px, ask: px, value: px, bidSize: 1e6, askSize: 1e6 });

/** Preview, state a fill price on each option leg, preview again, submit. */
async function tradeAt(app, input, prices) {
  let pv = await app.packages.preview(input);
  const legs = pv.legs.map((l) => (l.kind === 'trade' && l.option ? { ...l, statedPrice: prices[`${l.right}${l.strike}`] } : l));
  pv = await app.packages.preview({ ...input, legs });
  assert.equal(pv.blocking, 0, pv.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' | '));
  const r = await app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token, confirm: true });
  return { pv, s: r.strategy };
}

test('covered call: contracts come from the deliverable, the call depends on the stock, payoff is capped', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pinStock(app, inst.ALFA, 190);
  const input = { bookId: book.id, unitId: acct.id, template: 'covered_call', underlyingId: inst.ALFA.id, quantity: 250, options: { expiration: EXP, strikes: { call: 200 } } };
  const { pv, s } = await tradeAt(app, input, { C200: 2 });
  const call = pv.legs.find((l) => l.right === 'C');
  assert.equal(call.qty, 2, '250 shares cover two 100-share contracts, not 2.5');
  assert.equal(call.deliverableUnits, 100);
  assert.deepEqual(call.dependsOn, [1], 'the short call waits for the stock leg');
  assert.equal(pv.payoff.type, 'expiry-payoff');
  // 250 shares at 190 less 400 premium: break-even 188.40; above 200 only 50 uncovered shares keep rising.
  assert.deepEqual(pv.payoff.breakevens, [188.4]);
  assert.equal(pv.payoff.maxGain.unbounded, true, '50 of the 250 shares are not capped by the two calls');
  assert.equal(pv.payoff.maxLoss.value, -(250 * 190 - 400));
  assert.equal(s.status, 'open');
  assert.equal(s.positions.find((p) => p.family === 'option').qty, -2);
  assert.equal(s.holds.filter((h) => h.kind === 'option_margin').reduce((a, h) => a + h.amount, 0), 0, 'covered calls need no cash margin');
});

test('covered call on an existing position links it instead of buying again', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pinStock(app, inst.ALFA, 190);
  const long = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300 });
  const posId = long.positions[0].positionId;
  const cashBefore = app.ledger.cash(acct.id, 'USD').availableToTrade;
  // Establishing new while already holding raises the double-purchase warning.
  const warn = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'covered_call', underlyingId: inst.ALFA.id, quantity: 300, options: { expiration: EXP, strikes: { call: 200 } } });
  assert.ok(warn.checks.some((c) => c.code === 'already-held'));
  const { pv, s } = await tradeAt(app, { bookId: book.id, unitId: acct.id, template: 'covered_call', underlyingId: inst.ALFA.id, mode: 'existing', existingPositionId: posId, options: { expiration: EXP, strikes: { call: 200 } } }, { C200: 2 });
  assert.equal(pv.legs[0].kind, 'link');
  assert.equal(s.positions.find((p) => p.family === 'equity').qty, 300);
  assert.equal(s.positions.find((p) => p.family === 'option').qty, -3);
  assert.equal(app.ledger.cash(acct.id, 'USD').availableToTrade, cashBefore + 600 - 3 * 0.65, 'only the premium moved; no shares were bought');
  assert.equal(app.packages.strategyView(long.id).status, 'closed', 'the original strategy handed its position over');
  assert.equal(app.positions.list({ unitIds: [acct.id], instrumentId: inst.ALFA.id }).reduce((a, p) => a + p.qty, 0), 300, 'still 300 shares in total');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('cash-secured put reserves the exercise cash; assignment delivers stock at the strike', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pinStock(app, inst.ALFA, 190);
  const input = { bookId: book.id, unitId: acct.id, template: 'cash_secured_put', underlyingId: inst.ALFA.id, options: { expiration: EXP, strikes: { put: 180 }, contracts: 2 } };
  const { pv, s } = await tradeAt(app, input, { P180: 3 });
  assert.deepEqual(pv.legs.map((l) => l.kind), ['reserve', 'trade']);
  assert.equal(pv.legs[0].reserve.amount, 36_000);
  assert.equal(s.status, 'open');
  const c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.reserved, 36_000);
  assert.equal(c.availableToTrade, 500_000 + 600 - 1.3 - 36_000);
  // Expire in the money: close 175 on expiration.
  app.data.market.set(`${inst.ALFA.id}@${EXP}`, { value: 175 });
  await goTo(app, clock, '2026-03-20T21:30:00.000Z');
  const v = app.packages.strategyView(s.id);
  const stock = v.positions.find((p) => p.family === 'equity');
  assert.equal(stock.qty, 200, 'assigned: 2 contracts x 100 shares');
  assert.equal(stock.avgCost, 180, 'delivered at the strike');
  assert.equal(v.positions.find((p) => p.family === 'option'), undefined);
  assert.equal(app.ledger.cash(acct.id, 'USD').reserved, 0, 'the reservation is released once the put is gone');
  const pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.categories.find((x) => x.key === 'realized').rc, 600, 'the premium is realized');
  const hist = app.accounting.history(book.id, acct.id).events.map((e) => e.type);
  assert.ok(hist.includes('option.assigned') && hist.includes('option.delivery'));
  assert.deepEqual(ledgerImbalance(app), []);
});

test('vertical spread: defined risk, net debit, breakeven and max gain/loss', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pinStock(app, inst.ALFA, 190);
  const input = { bookId: book.id, unitId: acct.id, template: 'bull_call_spread', underlyingId: inst.ALFA.id, options: { expiration: EXP, strikes: { lower: 190, upper: 200 }, contracts: 5 } };
  const { pv, s } = await tradeAt(app, input, { C190: 4, C200: 1 });
  assert.deepEqual(pv.totals.netPremium, { amount: 1500, ccy: 'USD', type: 'debit', complete: true });
  assert.deepEqual(pv.payoff.breakevens, [193]);
  assert.equal(pv.payoff.maxGain.value, 3500);
  assert.equal(pv.payoff.maxLoss.value, -1500);
  assert.equal(pv.payoff.maxLoss.unbounded, false);
  assert.equal(s.holds.reduce((a, h) => a + h.amount, 0), 0, 'a debit spread reserves nothing beyond the premium paid');
  // Expire between the strikes: long call exercised, short call worthless.
  app.data.market.set(`${inst.ALFA.id}@${EXP}`, { value: 196 });
  await goTo(app, clock, '2026-03-20T21:30:00.000Z');
  const v = app.packages.strategyView(s.id);
  assert.equal(v.positions.find((p) => p.family === 'equity').qty, 500);
  assert.equal(v.positions.filter((p) => p.family === 'option').length, 0);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('credit spread reserves its width; iron condor and butterfly validate their strikes', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pinStock(app, inst.ALFA, 190);
  const base = { bookId: book.id, unitId: acct.id, underlyingId: inst.ALFA.id };
  const { pv, s } = await tradeAt(app, { ...base, template: 'bull_put_spread', options: { expiration: EXP, strikes: { lower: 180, upper: 185 }, contracts: 4 } }, { P180: 1, P185: 2.5 });
  assert.equal(pv.totals.netPremium.type, 'credit');
  assert.equal(pv.totals.netPremium.amount, -600);
  assert.equal(pv.payoff.maxLoss.value, -(4 * 100 * 5 - 600));
  assert.equal(s.holds.find((h) => h.kind === 'option_margin').amount, 2000, 'the spread width is reserved');
  await assert.rejects(app.packages.preview({ ...base, template: 'iron_condor', options: { expiration: EXP, strikes: { wingLower: 185, put: 180, call: 200, wingUpper: 205 }, contracts: 1 } }), /must be below/);
  await assert.rejects(app.packages.preview({ ...base, template: 'long_butterfly', options: { expiration: EXP, right: 'C', strikes: { lower: 185, middle: 190, upper: 200 }, contracts: 1 } }), /equal spacing/);
  const ic = await app.packages.preview({ ...base, template: 'iron_condor', options: { expiration: EXP, strikes: { wingLower: 175, put: 180, call: 200, wingUpper: 205 }, contracts: 1 } });
  assert.equal(ic.legs.length, 4);
  assert.equal(ic.payoff.maxLoss.unbounded, false);
  assert.equal(ic.payoff.breakevens.length, 2);
  const bf = await app.packages.preview({ ...base, template: 'long_butterfly', options: { expiration: EXP, right: 'C', strikes: { lower: 185, middle: 190, upper: 195 }, contracts: 3 } });
  assert.deepEqual(bf.legs.map((l) => [l.action, l.strike, l.qty]), [['buy', 185, 3], ['buy', 195, 3], ['sell', 190, 6]]);
});

test('synthetic short and naked calls are flagged as unbounded and margined', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pinStock(app, inst.ALFA, 190);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'synthetic_short', underlyingId: inst.ALFA.id, options: { expiration: EXP, strikes: { middle: 190 }, contracts: 1 } });
  assert.equal(pv.payoff.maxLoss.unbounded, true);
  assert.ok(pv.checks.some((c) => c.code === 'unbounded'));
  assert.ok(pv.checks.some((c) => c.code === 'naked-call'));
  assert.equal(pv.totals.optionRequirement[0].naked, 0.2 * 100 * 190);
  assert.equal(pv.legs.some((l) => l.kind === 'borrow_sec'), false, 'a synthetic short needs no stock borrow');
});

test('calendar spread shows a scenario view with its assumptions', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long_calendar', underlyingId: inst.ALFA.id, options: { expiration: EXP, farExpiration: '2026-04-17', right: 'C', strikes: { middle: 190 }, contracts: 1 } });
  assert.equal(pv.blocking, 0);
  assert.deepEqual(pv.legs.map((l) => [l.action, l.expiration]), [['buy', '2026-04-17'], ['sell', EXP]]);
  assert.equal(pv.payoff.type, 'expiry-payoff');
  assert.equal(pv.payoff.asOfExpiry, EXP);
  assert.ok(pv.payoff.assumptions.some((a) => /Black-Scholes/.test(a)), 'the later-dated option is valued with a stated model assumption');
});

test('long option: early exercise by hand, and worthless expiry', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pinStock(app, inst.ALFA, 190);
  const { s } = await tradeAt(app, { bookId: book.id, unitId: acct.id, template: 'long_call', underlyingId: inst.ALFA.id, options: { expiration: EXP, strikes: { call: 185 }, contracts: 3 } }, { C185: 7 });
  const opt = s.positions[0];
  const instObj = app.instruments.get(opt.instrument.id);
  app.db.tx(() => app.products.get('option').exercise(app, { book, unit: acct, inst: instObj, pos: app.positions.get(opt.positionId), contracts: 1 }));
  let v = app.packages.strategyView(s.id);
  assert.equal(v.positions.find((p) => p.family === 'option').qty, 2);
  assert.equal(v.positions.find((p) => p.family === 'equity').qty, 100);
  app.data.market.set(`${inst.ALFA.id}@${EXP}`, { value: 180 });
  await goTo(app, clock, '2026-03-20T21:30:00.000Z');
  v = app.packages.strategyView(s.id);
  assert.equal(v.positions.find((p) => p.family === 'option'), undefined, 'the remaining calls expired worthless');
  const pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.categories.find((x) => x.key === 'realized').rc, -2100, 'all three premiums are realized losses');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('expiration is blocked, not guessed, when the fixing is missing', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pinStock(app, inst.ALFA, 190);
  const { s } = await tradeAt(app, { bookId: book.id, unitId: acct.id, template: 'long_put', underlyingId: inst.ALFA.id, options: { expiration: EXP, strikes: { put: 190 }, contracts: 1 } }, { P190: 4 });
  // Take the feed away for the close.
  const realCloses = app.data.market.closes;
  app.data.market.closes = async (reqs) => new Map(reqs.map((r) => [`${r.instrument.id}@${r.date}`, null]));
  const realCloseFor = app.data.closeFor;
  app.data.closeFor = (id, date) => app.data.latestManual('price', id, { forDate: date });
  await goTo(app, clock, '2026-03-23T15:00:00.000Z');
  const pend = app.accounting.pending(book.id, acct.id).lifecycle.find((t) => t.type === 'option.expiry');
  assert.equal(pend.status, 'blocked');
  assert.match(pend.reason, /Awaiting the 2026-03-20 fixing/);
  assert.equal(app.packages.strategyView(s.id).positions.length, 1, 'the option is still on the books');
  // Entering the closing price by hand unblocks it.
  app.data.enterManual({ kind: 'price', subject: inst.ALFA.id, value: 184, forDate: EXP, currency: 'USD' });
  await advance(app, clock, 1000);
  app.data.market.closes = realCloses;
  app.data.closeFor = realCloseFor;
  const v = app.packages.strategyView(s.id);
  assert.equal(v.positions.find((p) => p.family === 'equity').qty, -100, 'the put was exercised: 100 shares delivered at 190');
  const ev = app.accounting.history(book.id, acct.id).events.find((e) => e.type === 'option.exercised');
  assert.equal(ev.data.fixing, 184);
  assert.ok(ev.data.fixingObsId, 'the manual fixing used is preserved');
});

test('contract size is never assumed: without contract data the multiplier must be supplied', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  // KAIJ has no option chain in the demo feed.
  await assert.rejects(app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'protective_put', underlyingId: inst.KAIJ.id, quantity: 1000, options: { expiration: EXP, strikes: { put: 2700 } } }), /does not assume 100 shares/);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'protective_put', underlyingId: inst.KAIJ.id, quantity: 1000, options: { expiration: EXP, strikes: { put: 2700 }, contractSpec: { multiplier: 10, deliverableUnits: 10, exercise: 'european', settlement: 'physical' } } });
  assert.equal(pv.legs[1].qty, 100, '1000 shares / 10 per contract');
  assert.equal(pv.legs[1].multiplier, 10);
});
