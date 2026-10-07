// The trading calendar gates matching: an order is not filled on a day that is closed in its
// instrument's trading calendar. It stays working, says why and when it will be matched, and its
// trade date and settlement run from the day it fills. A Day order placed on a closed day is good
// for the next trading day. Settlements, lifecycle events and accruals are not held back.
//
// Dates, from the 2026 calendar (New York is on daylight time from 8 March, so 14:00Z is 10:00 there):
//   March: Fri 6, Sat 7, Sun 8, Mon 9, Tue 10 ... Thu 19, Fri 20 (Vernal Equinox Day: Tokyo closed), Sat 21, Sun 22, Mon 23, Tue 24
//   April: Thu 2, Fri 3 (Good Friday: NYSE closed), Sat 4, Sun 5, Mon 6, Tue 7
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, ledgerImbalance, goTo } from '../helpers.js';
import { tradingDay } from '../../server/core/settlement.js';

const pin = (app, id, px, size = 1e6) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: size, askSize: size });
const buy = (book, acct, inst, extra = {}) => ({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.id, qty: 100, ...extra }] });
const place = async (app, input) => { const pv = await app.packages.preview(input); const out = await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation }); return { pv, s: out.strategy }; };
const order = (app, s, n = 0) => app.packages.strategyView(s.id).orders[n];
/** A dollar-denominated stock listed abroad, so the tests need no currency conversion. */
const listed = (app, symbol, country) => {
  const i = app.instruments.create({ productId: 'common_stock', name: `${symbol} (test)`, symbol, marketView: 'FOREIGN_CASH', venue: `TEST-${country}`, venueType: 'exchange', venueCountry: country, tradingCcy: 'USD' });
  pin(app, i.id, 50);
  return i;
};

test('weekend: an order placed on Saturday stays working with the reason, is matched on Monday, and settles from Monday', async () => {
  const { app, clock, inst } = makeApp({ at: '2026-03-07T15:00:00.000Z' }); // Saturday
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100);
  const { pv, s } = await place(app, buy(book, acct, inst.ALFA));
  // Preview: a warning, not a block; trade date Monday 9 March, NYSE T+1 = Tuesday 10 March.
  assert.equal(pv.blocking, 0);
  assert.equal(pv.checks.find((c) => c.code === 'not-trading-day').level, 'warning');
  assert.deepEqual([pv.legs[0].trading.tradeDate, pv.legs[0].settleDate], ['2026-03-09', '2026-03-10']);
  // Not filled: working, with the reason, on the order, in the strategy and in the Book's working orders.
  let o = order(app, s);
  assert.deepEqual([o.status, o.filledQty, o.fills.length], ['working', 0, 0]);
  assert.equal(o.statusReason, 'Market closed today on calendar US (2026-03-07 is a Saturday); will be matched on 2026-03-09.');
  assert.equal(app.packages.strategyView(s.id).status, 'working');
  assert.equal(app.accounting.pending(book.id, 'book').openOrders[0].statusReason, o.statusReason);
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM entries e JOIN events v ON v.id = e.event_id WHERE v.strategy_id = ?`, s.id).n, 0, 'nothing is booked');
  // Sunday: still working; the reason names the day.
  await goTo(app, clock, '2026-03-08T15:00:00.000Z');
  o = order(app, s);
  assert.deepEqual([o.status, o.statusReason], ['working', 'Market closed today on calendar US (2026-03-08 is a Sunday); will be matched on 2026-03-09.']);
  // Monday 9 March: matched. Trade date and settlement run from the fill: T+1 = Tuesday 10 March, as previewed.
  await goTo(app, clock, '2026-03-09T14:00:00.000Z');
  o = order(app, s);
  assert.deepEqual([o.status, o.fills[0].businessDate, o.fills[0].settleDate, o.fills[0].confirm.exact], ['filled', '2026-03-09', '2026-03-10', true]);
  assert.deepEqual(app.settle.pending([acct.id]).map((p) => [p.due_date, p.amount]), [['2026-03-10', -10_000]]);
  await goTo(app, clock, '2026-03-10T14:00:00.000Z');
  assert.deepEqual([app.ledger.cash(acct.id, 'USD').settled, app.ledger.cash(acct.id, 'USD').payable], [490_000, 0]);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a Day order placed on a closed day is good for the next trading day and expires at the end of that day', async () => {
  const { app, clock, inst } = makeApp({ at: '2026-03-07T15:00:00.000Z' }); // Saturday
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100);
  // A limit that the market never reaches, so the order can only expire.
  const { s } = await place(app, buy(book, acct, inst.ALFA, { orderType: 'limit', limitPrice: 95, tif: 'day' }));
  assert.equal(order(app, s).status, 'working');
  // The end-of-day run for Friday 6 March happens on this first cycle; the order was placed after it and is good for Monday.
  await goTo(app, clock, '2026-03-08T22:30:00.000Z');
  assert.equal(order(app, s).status, 'working', 'not expired over the weekend');
  // Monday morning it is in the market, waiting on its limit.
  await goTo(app, clock, '2026-03-09T14:00:00.000Z');
  assert.match(order(app, s).statusReason, /Limit not reached/);
  // Monday after the close (17:30 New York): expired.
  await goTo(app, clock, '2026-03-09T21:30:00.000Z');
  assert.deepEqual([order(app, s).status, order(app, s).statusReason], ['expired', 'Day order did not fill before the end of the business day']);
  // For comparison, a Day order placed on Tuesday, a trading day, expires at Tuesday's close.
  await goTo(app, clock, '2026-03-10T14:00:00.000Z');
  const tue = await place(app, buy(book, acct, inst.ALFA, { orderType: 'limit', limitPrice: 95, tif: 'day' }));
  await goTo(app, clock, '2026-03-10T21:30:00.000Z');
  assert.equal(order(app, tue.s).status, 'expired');
});

test('a US holiday: an NYSE order waits over Good Friday while a 24x7 instrument trades on every day', async () => {
  const { app, clock, inst } = makeApp({ at: '2026-04-03T15:00:00.000Z' }); // Good Friday
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100); pin(app, inst.SIMCOIN.id, 30_000);
  const a = await place(app, buy(book, acct, inst.ALFA));
  assert.deepEqual([order(app, a.s).status, order(app, a.s).statusReason], ['working', 'Market closed today on calendar US (2026-04-03 is a holiday on US); will be matched on 2026-04-06.']);
  assert.equal(a.pv.legs[0].settleDate, '2026-04-07', 'trade Monday 6 April, T+1');
  // A digital asset (calendar ALLDAYS) is not affected: it fills on Good Friday and on Saturday, settling the same day.
  const coin = (qty) => ({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.SIMCOIN.id, qty }] });
  const c1 = await place(app, coin(1));
  assert.ok(!c1.pv.checks.some((c) => c.code === 'not-trading-day'));
  assert.deepEqual([order(app, c1.s).status, order(app, c1.s).fills[0].businessDate, order(app, c1.s).fills[0].settleDate], ['filled', '2026-04-03', '2026-04-03']);
  await goTo(app, clock, '2026-04-04T15:00:00.000Z'); // Saturday
  const c2 = await place(app, coin(1));
  assert.deepEqual([order(app, c2.s).status, order(app, c2.s).fills[0].businessDate], ['filled', '2026-04-04']);
  assert.equal(order(app, a.s).status, 'working', 'the NYSE order is still waiting on Saturday');
  // Monday 6 April: the NYSE order is matched and settles Tuesday 7 April.
  await goTo(app, clock, '2026-04-06T14:00:00.000Z');
  assert.deepEqual([order(app, a.s).status, order(app, a.s).fills[0].businessDate, order(app, a.s).fills[0].settleDate], ['filled', '2026-04-06', '2026-04-07']);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a foreign holiday on a foreign-listed instrument: Tokyo closed, New York open; settlements are not held back', async () => {
  const { app, clock, inst } = makeApp({ at: '2026-03-19T14:00:00.000Z' }); // Thursday
  const { book, acct } = makeBook(app);
  const tky = listed(app, 'TKYD', 'JP');
  // Its trades settle through a US custodian, one NYSE day after the trade: set on the instrument.
  app.instruments.update(tky.id, { conventions: { settlementCalendar: 'US', settleLag: 1 } });
  pin(app, inst.ALFA.id, 100);
  // Thursday 19 March: Tokyo is open. 100 x 50.00 = 5,000.00, settling Friday 20 March.
  const thu = await place(app, buy(book, acct, tky));
  assert.deepEqual([order(app, thu.s).status, order(app, thu.s).fills[0].settleDate], ['filled', '2026-03-20']);
  // Friday 20 March: Tokyo is closed. A Day order in TKYD waits; an NYSE order placed at the same moment fills.
  await goTo(app, clock, '2026-03-20T14:00:00.000Z');
  const fri = await place(app, buy(book, acct, tky));
  const us = await place(app, buy(book, acct, inst.ALFA));
  assert.deepEqual([order(app, fri.s).status, order(app, fri.s).statusReason], ['working', 'Market closed today on calendar JP (2026-03-20 is a holiday on JP); will be matched on 2026-03-23.']);
  assert.deepEqual([order(app, us.s).status, order(app, us.s).fills[0].businessDate], ['filled', '2026-03-20']);
  assert.equal(fri.pv.legs[0].settleDate, '2026-03-24', 'trade Monday 23 March, one NYSE day later');
  // Thursday's purchase settles today although the instrument's own market is closed: settlement is not gated.
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 495_000);
  assert.deepEqual(app.settle.pending([acct.id]).map((p) => [p.due_date, p.amount]), [['2026-03-23', -10_000]], 'only the NYSE purchase of today is pending');
  // Friday's end of day (a New York business day): the TKYD Day order is good for Monday and is not expired.
  await goTo(app, clock, '2026-03-20T21:30:00.000Z');
  assert.equal(order(app, fri.s).status, 'working');
  await goTo(app, clock, '2026-03-22T15:00:00.000Z'); // Sunday
  assert.deepEqual([order(app, fri.s).status, order(app, fri.s).statusReason], ['working', 'Market closed today on calendar JP (2026-03-22 is a Sunday); will be matched on 2026-03-23.']);
  // Monday 23 March: matched; trade date 23 March, settlement Tuesday 24 March.
  await goTo(app, clock, '2026-03-23T14:00:00.000Z');
  const f = order(app, fri.s).fills[0];
  assert.deepEqual([order(app, fri.s).status, f.businessDate, f.settleDate, f.confirm.exact], ['filled', '2026-03-23', '2026-03-24', true]);
  // A Day order placed on the Tokyo holiday that cannot fill expires at Monday's close, not Friday's.
  const again = makeApp({ at: '2026-03-20T14:00:00.000Z' });
  const b2 = makeBook(again.app);
  const tky2 = listed(again.app, 'TKYD', 'JP');
  const lim = await place(again.app, buy(b2.book, b2.acct, tky2, { orderType: 'limit', limitPrice: 40, tif: 'day' }));
  await goTo(again.app, again.clock, '2026-03-20T21:30:00.000Z');
  assert.equal(order(again.app, lim.s).status, 'working', 'still good after Friday\'s end of day');
  await goTo(again.app, again.clock, '2026-03-23T21:30:00.000Z');
  assert.equal(order(again.app, lim.s).status, 'expired');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a joint trading calendar is closed when any member is, and the weekends-only fallback gates weekends only', async () => {
  const { app, clock, inst } = makeApp({ at: '2026-03-20T14:00:00.000Z' }); // Friday: Tokyo closed, New York open
  const { book, acct } = makeBook(app);
  pin(app, inst.BRVO.id, 50);
  app.instruments.update(inst.BRVO.id, { conventions: { tradingCalendar: 'US+JP' } });
  const j = await place(app, buy(book, acct, inst.BRVO));
  assert.deepEqual([order(app, j.s).status, order(app, j.s).statusReason], ['working', 'Market closed today on calendar US+JP (2026-03-20 is a holiday on JP); will be matched on 2026-03-23.']);
  // The same calendar on Good Friday: closed for New York, and the next day both are open is Monday 6 April.
  assert.deepEqual([tradingDay(app.instruments.get(inst.BRVO.id), '2026-04-03').open, tradingDay(app.instruments.get(inst.BRVO.id), '2026-04-03').next], [false, '2026-04-06']);
  await goTo(app, clock, '2026-03-23T14:00:00.000Z');
  assert.deepEqual([order(app, j.s).status, order(app, j.s).fills[0].businessDate, order(app, j.s).fills[0].settleDate], ['filled', '2026-03-23', '2026-03-24']);

  // A Hong Kong listing has no calendar here: weekends only. Good Friday 3 April is a holiday there in fact, but the
  // fallback does not know it, so the order trades (and the preview says the calendar is weekends only).
  const hk = listed(app, 'HKTD', 'HK');
  await goTo(app, clock, '2026-04-03T15:00:00.000Z');
  const g = await place(app, buy(book, acct, hk));
  assert.ok(g.pv.checks.some((c) => c.code === 'calendar-fallback'));
  assert.deepEqual([order(app, g.s).status, order(app, g.s).fills[0].businessDate], ['filled', '2026-04-03']);
  // Saturday 4 April: gated, matched Monday 6 April.
  await goTo(app, clock, '2026-04-04T15:00:00.000Z');
  const w = await place(app, buy(book, acct, hk));
  assert.deepEqual([order(app, w.s).status, order(app, w.s).statusReason], ['working', 'Market closed today on calendar WEEKEND (2026-04-04 is a Saturday); will be matched on 2026-04-06.']);
  await goTo(app, clock, '2026-04-06T14:00:00.000Z');
  assert.deepEqual([order(app, w.s).status, order(app, w.s).fills[0].businessDate], ['filled', '2026-04-06']);
});

test('a package on a closed day: market legs wait together, internal funding does not, accruals keep running', async () => {
  const { app, clock, inst } = makeApp({ at: '2026-03-06T15:00:00.000Z' }); // Friday
  const { book, acct, treasury } = makeBook(app, { cash: 1_000_000, account: 20_000 });
  pin(app, inst.ALFA.id, 100);
  // Friday: a 10,000.00 loan at 3.6% a year (ACT/360: 1.00 a day) is drawn; loans are matched on market days too.
  const loan = { kind: 'loan', action: 'borrow_cash', qty: 10_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'Weekend loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.036, maturity: '2026-06-30', interestPayment: 'maturity' } } };
  const fri = await place(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loan] });
  assert.equal(order(app, fri.s).status, 'filled');
  // Saturday: a short sale (borrow, then sell) and a second loan are placed. All three wait for Monday.
  await goTo(app, clock, '2026-03-07T15:00:00.000Z');
  const short = await place(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 50 });
  assert.deepEqual(app.packages.strategyView(short.s.id).orders.map((o) => [o.kind, o.status]), [['borrow_sec', 'working'], ['trade', 'working']]);
  assert.ok(app.packages.strategyView(short.s.id).orders.every((o) => /Market closed today on calendar US \(2026-03-07 is a Saturday\); will be matched on 2026-03-09\./.test(o.statusReason)));
  const sat = await place(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ ...loan, contract: { ...loan.contract, name: 'Second loan' } }] });
  assert.deepEqual([order(app, sat.s).status, app.ledger.balance(acct.id, 'loan.liab', 'USD')], ['working', -10_000]);
  // A purchase funded from Treasury: 400 x 100.00 = 40,000.00 against 30,000.00 in the Account (20,000 + Friday's 10,000 loan),
  // so 10,000.00 comes from Treasury. That transfer is internal and happens at once; the purchase waits for Monday.
  const funded = await place(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 400, financing: { mode: 'treasury' } });
  assert.deepEqual(app.packages.strategyView(funded.s.id).orders.map((o) => [o.kind, o.status]), [['funding', 'filled'], ['trade', 'working']]);
  // Treasury 1,000,000 - 20,000 - 10,000 = 970,000.00; Account 20,000 + 10,000 + 10,000 = 40,000.00.
  assert.deepEqual([app.ledger.balance(treasury.id, 'cash', 'USD'), app.ledger.balance(acct.id, 'cash', 'USD')], [970_000, 40_000]);
  // Monday 9 March: everything that waited is matched.
  await goTo(app, clock, '2026-03-09T14:00:00.000Z');
  assert.deepEqual(app.packages.strategyView(short.s.id).orders.map((o) => o.status), ['filled', 'filled']);
  assert.deepEqual([order(app, sat.s).status, app.ledger.balance(acct.id, 'loan.liab', 'USD')], ['filled', -20_000]);
  assert.deepEqual([order(app, funded.s, 1).status, order(app, funded.s, 1).fills[0].businessDate, order(app, funded.s, 1).fills[0].settleDate], ['filled', '2026-03-09', '2026-03-10']);
  // Interest is not gated. Friday's loan (10,000 at 3.6%, ACT/360 = 1.00 a day) has accrued over the weekend:
  // by Monday's end of day three nights (Friday, Saturday, Sunday) = 3.00. The loan drawn on Monday has accrued nothing yet.
  await goTo(app, clock, '2026-03-09T21:30:00.000Z');
  assert.equal(0 - app.ledger.positionBalance(fri.s.positions[0].positionId, 'accrued.liab', 'USD'), 3);
  assert.equal(0 - app.ledger.positionBalance(app.packages.strategyView(sat.s.id).positions[0].positionId, 'accrued.liab', 'USD'), 0);
  assert.deepEqual(ledgerImbalance(app), []);
});
