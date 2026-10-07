// Settlement and calendar configuration: calendars per instrument (trading, settlement, payment),
// the settlement convention per instrument and per transaction, calendar conflicts, and the
// flags for approximate and weekends-only calendars.
//
// Dates are worked out by hand from the 2026 calendar:
//   March 2026: Mon 2, Tue 3, Wed 4 ... Wed 18, Thu 19, Fri 20 (Vernal Equinox Day: Tokyo closed), Mon 23
//   April 2026: Wed 1, Thu 2, Fri 3 (Good Friday: NYSE, London and TARGET closed; the Federal Reserve is open), Mon 6 (Easter Monday)
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';
import { createApi } from '../../server/api.js';

const pin = (app, id, px, size = 1e6) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: size, askSize: size });
const WED_18 = '2026-03-18T15:00:00.000Z';
const one = (book, acct, inst, extra = {}) => ({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.id, qty: 100, ...extra }] });
const errors = (pv) => pv.checks.filter((c) => c.level === 'error');

test('an instrument reports its trading, settlement and payment calendars with their basis; payments also follow the currency calendar', async () => {
  const { app, inst } = makeApp();
  const api = createApi(app);
  const call = (method, path, body = {}, query = {}) => { const m = api.match(method, path); return m.handler({ params: m.params, query, body }); };
  // A US-listed equity: NYSE days for trading and settlement; payments need NYSE and Federal Reserve days.
  let v = await call('GET', `/api/instruments/${inst.ALFA.id}`);
  assert.deepEqual([v.calendar.trading.id, v.calendar.trading.basis, v.calendar.settlement.id, v.calendar.settlement.basis, v.calendar.payment.id], ['US', 'venue', 'US', 'venue', 'US+USD']);
  assert.deepEqual([v.calendar.payment.currencies, v.calendar.payment.currencyCalendars], [['USD'], { USD: 'USD' }]);
  assert.deepEqual([v.calendar.id, v.calendar.flag, v.conventions], ['US', null, null], 'top level stays the settlement calendar; nothing is flagged; nothing is set on the instrument');
  // A Tokyo-listed yen equity: Tokyo days throughout (the yen payment calendar is the same calendar).
  v = await call('GET', `/api/instruments/${inst.KAIJ.id}`);
  assert.deepEqual([v.calendar.trading.id, v.calendar.settlement.id, v.calendar.payment.id], ['JP', 'JP', 'JP']);
  // Set all three on the sterling equity, with a joint settlement calendar and dollar payments.
  v = await call('PUT', `/api/instruments/${inst.ROSE.id}`, { conventions: { tradingCalendar: 'UK', settlementCalendar: 'uk + target', paymentCalendar: 'USD', settleLag: 3 } });
  assert.deepEqual(v.conventions, { tradingCalendar: 'UK', settlementCalendar: 'UK+TARGET', paymentCalendar: 'USD', settleLag: 3 });
  assert.deepEqual([v.calendar.trading.id, v.calendar.trading.basis], ['UK', 'explicit']);
  assert.deepEqual([v.calendar.settlement.id, v.calendar.settlement.basis, v.calendar.settlement.joint], ['UK+TARGET', 'explicit', true]);
  // Payments: the calendar set (USD) joined with the payment calendar of the currency paid (GBP -> UK).
  assert.deepEqual([v.calendar.payment.id, v.calendar.payment.basis, v.calendar.payment.currencies], ['USD+UK', 'explicit', ['GBP']]);
  assert.deepEqual([v.settlement.lag, v.settlement.basis, v.settlement.label, v.settlement.configurable], [3, 'instrument', 'T+3', true]);
  // Clearing them puts the venue's calendar back.
  v = await call('PUT', `/api/instruments/${inst.ROSE.id}`, { conventions: null });
  assert.deepEqual([v.conventions, v.calendar.settlement.id, v.calendar.settlement.basis, v.settlement.basis], [null, 'UK', 'venue', 'book']);
  // What cannot be set is refused with the reason.
  await assert.rejects(async () => call('PUT', `/api/instruments/${inst.ROSE.id}`, { conventions: { settlementCalendar: 'UK+MARS' } }), /Settlement calendar: "MARS" is not a calendar the Terminal has/);
  await assert.rejects(async () => call('PUT', `/api/instruments/${inst['S5 2026-03'].id}`, { conventions: { settleLag: 2 } }), /future settles through daily variation margin/);
  await assert.rejects(async () => call('PUT', `/api/instruments/${inst.SIMCOIN.id}`, { conventions: { tradingCalendar: 'US' } }), /digital asset trades and settles on every calendar day/);
  await assert.rejects(async () => call('PUT', `/api/instruments/${inst.ALFA.id}`, { conventions: { settleLag: 31 } }), /whole number of business days from 0 \(same day\) to 30/);
  // A futures contract says that its settlement is fixed by the product.
  v = await call('GET', `/api/instruments/${inst['S5 2026-03'].id}`);
  assert.deepEqual([v.settlement.configurable, v.settlement.basis, v.settlement.lag], [false, 'product', 0]);
});

test('an instrument with its own calendar and lag settles on different dates from its venue and Book defaults, in the ledger', async () => {
  const { app, clock, inst } = makeApp({ at: WED_18 });
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100); pin(app, inst.BRVO.id, 100); pin(app, inst.KAIJ.id, 3000);
  // Defaults, traded Wednesday 18 March 2026:
  //   BRVO (NYSE, Book lag T+1): Thu 19.
  //   KAIJ (Tokyo, Book lag T+2 for foreign cash): Thu 19, then Fri 20 is a Tokyo holiday, so Mon 23.
  assert.equal((await app.packages.preview(one(book, acct, inst.BRVO))).legs[0].settleDate, '2026-03-19');
  let k = (await app.packages.preview(one(book, acct, inst.KAIJ))).legs[0];
  assert.deepEqual([k.settleDate, k.settlement.lag, k.settlement.basis, k.settlement.calendarId], ['2026-03-23', 2, 'book', 'JP']);
  // KAIJ told to settle on NYSE days instead: Thu 19, Fri 20 -> 20 March. The Tokyo holiday no longer counts.
  app.instruments.update(inst.KAIJ.id, { conventions: { settlementCalendar: 'US' } });
  k = (await app.packages.preview(one(book, acct, inst.KAIJ))).legs[0];
  assert.deepEqual([k.settleDate, k.settlement.calendarId, k.calendar.settlement.basis, k.calendar.trading.id], ['2026-03-20', 'US', 'explicit', 'JP']);
  // ALFA given a joint NYSE + Tokyo settlement calendar and a lag of 2: Thu 19 (both open), Fri 20 (Tokyo closed), Mon 23.
  app.instruments.update(inst.ALFA.id, { conventions: { settlementCalendar: 'US+JP', settleLag: 2 } });
  const pv = await app.packages.preview(one(book, acct, inst.ALFA));
  assert.deepEqual([pv.legs[0].settleDate, pv.legs[0].settlement.lag, pv.legs[0].settlement.basis, pv.legs[0].settlement.label], ['2026-03-23', 2, 'instrument', 'T+2']);
  assert.equal(pv.blocking, 0);
  // Executed: 100 x 100.00 = 10,000.00 owed until Monday 23 March, then paid from settled cash.
  const s = (await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation })).strategy;
  assert.equal(s.orders[0].fills[0].settleDate, '2026-03-23');
  assert.deepEqual(app.settle.pending([acct.id]).map((p) => [p.due_date, p.ccy, p.amount]), [['2026-03-23', 'USD', -10_000]]);
  await goTo(app, clock, '2026-03-20T15:00:00.000Z'); // its default T+1 would have settled it by now
  assert.deepEqual([app.ledger.cash(acct.id, 'USD').settled, app.ledger.cash(acct.id, 'USD').payable], [500_000, 10_000]);
  await goTo(app, clock, '2026-03-23T15:00:00.000Z');
  assert.deepEqual([app.ledger.cash(acct.id, 'USD').settled, app.ledger.cash(acct.id, 'USD').payable], [490_000, 0]);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('the payment calendar moves payment dates: a loan due on Good Friday, with and without its own payment calendar', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const loan = (name, extra = {}) => ({ kind: 'loan', action: 'borrow_cash', qty: 10_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name, marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.05, maturity: '2026-04-03', interestPayment: 'maturity' }, ...extra } });
  const due = (s) => app.db.get(`SELECT t.due_date FROM tasks t JOIN positions p ON p.id = t.position_id WHERE p.strategy_id = ? AND t.type = 'loan.maturity'`, s.id).due_date;
  // Default: an instrument in a US market view uses NYSE days, joined with Federal Reserve days for payments.
  // Friday 3 April 2026 is Good Friday (NYSE closed), so the repayment falls on Monday 6 April.
  const a = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loan('Loan on market days')] });
  assert.equal(app.instruments.toView(app.instruments.get(a.positions[0].instrument.id)).calendar.payment.id, 'US+USD');
  assert.equal(due(a), '2026-04-06');
  // With the payment calendar set to Federal Reserve days alone, Good Friday is a banking day: 3 April stands.
  const b = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loan('Loan on bank days', { conventions: { paymentCalendar: 'USD' } })] });
  const view = app.instruments.toView(app.instruments.get(b.positions[0].instrument.id));
  assert.deepEqual([view.calendar.payment.id, view.calendar.payment.basis, view.conventions], ['USD', 'explicit', { paymentCalendar: 'USD' }]);
  assert.equal(due(b), '2026-04-03');
  // A yen loan due on Friday 20 March 2026 (Vernal Equinox Day): the yen payment calendar moves it to Monday 23 March.
  const y = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'loan', action: 'borrow_cash', qty: 1_000_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'Yen loan', marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: 'JPY', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.01, maturity: '2026-03-20', interestPayment: 'maturity' } } }] });
  const yv = app.instruments.toView(app.instruments.get(y.positions[0].instrument.id));
  assert.deepEqual([yv.calendar.payment.id, yv.calendar.settlement.basis, yv.calendar.flag], ['JP', 'currency', null], 'an OTC contract uses its currency calendar, and that is not an approximation');
  assert.equal(due(y), '2026-03-23');
  void inst;
});

test('a settlement date or lag stated for one transaction overrides the convention, is confirmed, and settles in the ledger on that date', async () => {
  const { app, clock, inst } = makeApp(); // Monday 2 March 2026
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100); pin(app, inst.SIMGOV31.id, 100);
  // Convention: NYSE T+1 = Tue 3 March.
  const std = (await app.packages.preview(one(book, acct, inst.ALFA))).legs[0];
  assert.deepEqual([std.settleDate, std.settlement.basis, std.settle], ['2026-03-03', 'book', null]);
  // A lag of 3 stated for this trade: Tue 3, Wed 4, Thu 5.
  const pv = await app.packages.preview(one(book, acct, inst.ALFA, { settle: { lag: 3 } }));
  assert.deepEqual([pv.legs[0].settleDate, pv.legs[0].settlement.basis, pv.legs[0].settlement.label, pv.legs[0].settlement.standard.date], ['2026-03-05', 'transaction-lag', 'Stated: T+3', '2026-03-03']);
  assert.equal(pv.confirmation.legs[0].settleDate, '2026-03-05', 'the stated settlement date is one of the confirmed figures');
  const s = (await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation })).strategy;
  const o = s.orders[0];
  assert.deepEqual([o.settle, o.confirmed.settleDate, o.fills[0].settleDate, o.fills[0].confirm.exact], [{ lag: 3 }, '2026-03-05', '2026-03-05', true]);
  await goTo(app, clock, '2026-03-04T15:00:00.000Z');
  assert.equal(app.ledger.cash(acct.id, 'USD').payable, 10_000, 'still owed on Wednesday');
  await goTo(app, clock, '2026-03-05T15:00:00.000Z');
  assert.deepEqual([app.ledger.cash(acct.id, 'USD').payable, app.ledger.cash(acct.id, 'USD').settled], [0, 490_000]);

  // A stated date. Thursday 5 March, traded Thursday 5 March: same-day settlement, paid from settled cash at once.
  const same = await app.packages.preview(one(book, acct, inst.ALFA, { settle: { date: '2026-03-05' } }));
  assert.deepEqual([same.legs[0].settleDate, same.legs[0].settlement.lag, same.legs[0].settlement.basis, same.legs[0].settlement.label], ['2026-03-05', 0, 'transaction-date', 'Stated date 2026-03-05 (same day)']);
  await app.packages.submit({ ...same.input, legs: same.legs, clientToken: same.token, confirm: true, expected: same.confirmation });
  assert.deepEqual([app.ledger.cash(acct.id, 'USD').payable, app.ledger.cash(acct.id, 'USD').settled], [0, 480_000]);
  // A stated date four business days out: Mon 9, Tue 10, Wed 11 -> Wednesday 11 March is T+4 from Thursday 5.
  const d4 = (await app.packages.preview(one(book, acct, inst.ALFA, { settle: { date: '2026-03-11' } }))).legs[0];
  assert.deepEqual([d4.settleDate, d4.settlement.lag, d4.settlement.label], ['2026-03-11', 4, 'Stated date 2026-03-11 (T+4)']);

  // A bond: accrued interest runs to the settlement date, so stating the date changes the cash.
  // SIMGOV31 pays 4.25% semi-annually on 15 May and 15 November, ACT/ACT: 2.125 per 100 per half year;
  // the current period 15 Nov 2025 -> 15 May 2026 has 181 days.
  //   convention T+1 from Thu 5 March = Fri 6 March: 111 days accrued -> 100,000 x 2.125% x 111/181 = 1,303.18
  //   stated Thu 12 March:                              117 days accrued -> 100,000 x 2.125% x 117/181 = 1,373.62
  const bond = (settle) => app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.SIMGOV31.id, qty: 100_000, ...(settle ? { settle } : {}) }] });
  const b0 = (await bond(null)).legs[0], b1 = (await bond({ date: '2026-03-12' })).legs[0];
  assert.deepEqual([b0.settleDate, b0.accrued, b0.cash], ['2026-03-06', 1303.18, -101_303.18]);
  assert.deepEqual([b1.settleDate, b1.accrued, b1.cash], ['2026-03-12', 1373.62, -101_373.62]);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('spot FX: the pair lag, a lag set on the instrument and a lag stated on the trade, on the joint currency calendar', async () => {
  const { app, inst } = makeApp({ at: WED_18 });
  const { book, acct } = makeBook(app);
  const jpy = inst['USD/JPY'], eur = inst['EUR/USD'];
  app.data.market.set(jpy.id, { bid: 150, ask: 150, value: 150 }); app.data.market.set(eur.id, { bid: 1.1, ask: 1.1, value: 1.1 });
  const sell = (i, extra = {}) => app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: i.id, qty: 1000, ...extra }] });
  // USD/JPY traded Wed 18 March, T+2 on business days of both currencies: Thu 19, (Fri 20 Tokyo holiday), Mon 23.
  let l = (await sell(jpy)).legs[0];
  assert.deepEqual([l.settleDate, l.settlement.calendarId, l.settlement.lag, l.settlement.basis], ['2026-03-23', 'USD+JP', 2, 'instrument']);
  assert.deepEqual([l.calendar.settlement.joint, l.calendar.flag], [true, null]);
  // EUR/USD the same day is not affected by the Tokyo holiday: Thu 19, Fri 20.
  l = (await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: eur.id, qty: 1000 }] })).legs[0];
  assert.deepEqual([l.settleDate, l.settlement.calendarId], ['2026-03-20', 'TARGET+USD']);
  // Stated for this trade: T+1 = Thu 19 March; and a stated value date on the Tokyo holiday is a conflict.
  assert.equal((await sell(jpy, { settle: { lag: 1 } })).legs[0].settleDate, '2026-03-19');
  const bad = await sell(jpy, { settle: { date: '2026-03-20' } });
  assert.equal(bad.blocking, 1);
  assert.equal(errors(bad)[0].code, 'settle-not-business-day');
  assert.match(errors(bad)[0].message, /2026-03-20 \(Friday\) is a holiday on JP, not a business day on the settlement calendar of USD\/JPY \(USD\+JP: .*\)\. The nearest business days are 2026-03-19 and 2026-03-23\./);
  // A lag set on the pair itself (T+1) becomes its convention.
  app.instruments.update(jpy.id, { conventions: { settleLag: 1 } });
  l = (await sell(jpy)).legs[0];
  assert.deepEqual([l.settleDate, l.settlement.lag, l.settlement.basis], ['2026-03-19', 1, 'instrument']);
});

test('calendar conflicts block the preview and the confirmation with a specific message; nothing is moved silently', async () => {
  const { app, clock, inst } = makeApp({ at: '2026-04-01T15:00:00.000Z' }); // Wednesday 1 April 2026
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100);
  const tryIt = async (settle, i = inst.ALFA) => { const pv = await app.packages.preview(one(book, acct, i, { settle })); return { pv, e: errors(pv) }; };
  // A holiday: Good Friday on the NYSE calendar.
  let r = await tryIt({ date: '2026-04-03' });
  assert.equal(r.pv.blocking, 1);
  assert.equal(r.e[0].code, 'settle-not-business-day');
  assert.equal(r.e[0].message, 'Leg 1: Calendar conflict: the stated settlement date 2026-04-03 (Friday) is a holiday on US, not a business day on the settlement calendar of ALFA (US: US equity markets (NYSE rules)). The nearest business days are 2026-04-02 and 2026-04-06.');
  assert.equal(r.pv.legs[0].settleDate, '2026-04-03', 'the stated date is shown as stated, not moved to a business day');
  await assert.rejects(app.packages.submit({ ...r.pv.input, legs: r.pv.legs, clientToken: r.pv.token, confirm: true, expected: r.pv.confirmation }), (err) => err.code === 'preview_failed' && /Calendar conflict/.test(err.message));
  // A weekend.
  r = await tryIt({ date: '2026-04-04' });
  assert.match(r.e[0].message, /2026-04-04 \(Saturday\) is a Saturday, not a business day/);
  // Before the trade date.
  r = await tryIt({ date: '2026-03-31' });
  assert.equal(r.e[0].code, 'settle-before-trade');
  assert.equal(r.e[0].message, 'Leg 1: Calendar conflict: the stated settlement date 2026-03-31 is before the trade date 2026-04-01. A trade cannot settle before it is done.');
  // Not a date; not a whole lag; too far out. Monday 1 June 2026 is 41 NYSE business days after Wednesday 1 April:
  // 20 in April (2, 6-10, 13-17, 20-24, 27-30), 20 in May (1, 4-8, 11-15, 18-22, 26-29; Memorial Day is the 25th) and 1 June.
  assert.equal((await tryIt({ date: '2026-02-31' })).e[0].code, 'settle-date-invalid');
  assert.equal((await tryIt({ lag: 1.5 })).e[0].code, 'settle-lag-invalid');
  assert.equal((await tryIt({ lag: 31 })).e[0].code, 'settle-lag-invalid');
  r = await tryIt({ date: '2026-06-01' });
  assert.equal(r.e[0].code, 'settle-too-far');
  assert.match(r.e[0].message, /the longest a trade may state is 30\. A later delivery is a forward/);
  // A product whose settlement is fixed: a future.
  pin(app, inst['S5 2026-06'].id, 5000);
  r = await tryIt({ lag: 1 }, inst['S5 2026-06']);
  assert.equal(r.e[0].code, 'settlement-fixed');
  assert.match(r.e[0].message, /cannot be stated for S5 2026-06\. A future settles through daily variation margin/);
  assert.equal(app.packages.listStrategies({ bookId: book.id }).length, 0, 'none of these was submitted');

  // The same holiday is a conflict on the instrument's own joint calendar, and a business day when the
  // instrument settles on Federal Reserve days (the Fed is open on Good Friday).
  app.instruments.update(inst.ALFA.id, { conventions: { settlementCalendar: 'USD' } });
  r = await tryIt({ date: '2026-04-03' });
  assert.deepEqual([r.pv.blocking, r.pv.legs[0].settleDate, r.pv.legs[0].settlement.lag], [0, '2026-04-03', 2]);
  app.instruments.update(inst.ALFA.id, { conventions: null });

  // An order confirmed with a stated date that can no longer be honoured when it fills is rejected, not re-dated.
  // Limit 95 with the market at 100: it waits. Stated settlement Thursday 2 April.
  const lim = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.ALFA.id, qty: 100, orderType: 'limit', limitPrice: 95, tif: 'gtc', settle: { date: '2026-04-02' } }] });
  assert.equal(lim.blocking, 0);
  const s = (await app.packages.submit({ ...lim.input, legs: lim.legs, clientToken: lim.token, confirm: true, expected: lim.confirmation })).strategy;
  assert.equal(s.orders[0].status, 'working');
  pin(app, inst.ALFA.id, 94);
  await goTo(app, clock, '2026-04-06T15:00:00.000Z'); // Monday 6 April: the price reaches the limit after the stated date
  const o = app.packages.strategyView(s.id).orders[0];
  assert.equal(o.status, 'rejected');
  assert.match(o.statusReason, /Calendar conflict: the stated settlement date 2026-04-02 is before the trade date 2026-04-06/);
  assert.equal(app.ledger.balance(acct.id, 'pos', 'USD'), 0, 'nothing was booked');
});

test('a day that is not a trading day on the instrument trading calendar is flagged in the preview', async () => {
  const { app, inst } = makeApp({ at: '2026-03-20T03:00:00.000Z' }); // still Thursday 19 March in New York
  const { book, acct } = makeBook(app);
  pin(app, inst.KAIJ.id, 3000);
  let pv = await app.packages.preview(one(book, acct, inst.KAIJ));
  assert.ok(!pv.checks.some((c) => c.code === 'not-trading-day'), 'Thursday 19 March is a Tokyo trading day');
  // Give the instrument a trading calendar on which the business date is closed (19 March entered as a one-off closure of WEEKEND would
  // affect other markets, so use a joint calendar with a real holiday instead): Friday 20 March, Tokyo closed.
  const friday = makeApp({ at: '2026-03-20T15:00:00.000Z' });
  const fb = makeBook(friday.app);
  pin(friday.app, friday.inst.KAIJ.id, 3000);
  pv = await friday.app.packages.preview(one(fb.book, fb.acct, friday.inst.KAIJ));
  const w = pv.checks.find((c) => c.code === 'not-trading-day');
  assert.equal(w.level, 'warning');
  assert.match(w.message, /today, 2026-03-20, is a holiday on JP, not a trading day on the trading calendar of KAIJ \(JP\)/);
  // The same day is a trading day for an NYSE instrument, and for KAIJ once its trading calendar is set to NYSE days.
  pin(friday.app, friday.inst.ALFA.id, 100);
  assert.ok(!(await friday.app.packages.preview(one(fb.book, fb.acct, friday.inst.ALFA))).checks.some((c) => c.code === 'not-trading-day'));
  friday.app.instruments.update(friday.inst.KAIJ.id, { conventions: { tradingCalendar: 'US' } });
  assert.ok(!(await friday.app.packages.preview(one(fb.book, fb.acct, friday.inst.KAIJ))).checks.some((c) => c.code === 'not-trading-day'));
});

test('approximate and weekends-only calendars are flagged on the instrument, in instrument lists and on the preview leg', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const api = createApi(app);
  const call = (method, path, body = {}, query = {}) => { const m = api.match(method, path); return m.handler({ params: m.params, query, body }); };
  // A Hong Kong listing: no calendar is built in for HK or for HKD.
  const hk = await call('POST', '/api/instruments', { productId: 'common_stock', name: 'Harbour Holdings (test)', symbol: 'HARB', marketView: 'FOREIGN_CASH', venue: 'TEST-HK', venueType: 'exchange', venueCountry: 'HK', tradingCcy: 'HKD' });
  assert.deepEqual([hk.calendar.flag, hk.calendar.flagLabel, hk.calendar.settlement.id, hk.calendar.settlement.fallback, hk.calendar.payment.missingCurrencies], ['weekends-only', 'Weekends-only calendar', 'WEEKEND', true, ['HKD']]);
  assert.equal(hk.calendar.flagText, 'Trading, settlement and payment dates for this instrument are worked out on weekends only: no holiday calendar exists for its market, so local holidays are not recognised.');
  // The Marketplaces list carries the flag on its rows.
  const rows = (await call('GET', '/api/instruments', {}, { tagView: 'FOREIGN_CASH', bookId: book.id })).items;
  assert.equal(rows.find((i) => i.id === hk.id).calendar.flag, 'weekends-only');
  assert.equal(rows.find((i) => i.symbol === 'KAIJ').calendar.flag, null);
  // A euro-area venue uses TARGET days: approximate, and says why.
  const alpn = rows.find((i) => i.symbol === 'ALPN');
  assert.deepEqual([alpn.calendar.flag, alpn.calendar.flagLabel], ['approximate', 'Approximate calendar']);
  assert.match(alpn.calendar.flagText, /^Trading, settlement and payment dates for this instrument use an approximate calendar\. TARGET closing days are used for this euro-area venue/);
  // The preview leg carries the same flag and sentence, and a warning with the date it produced.
  await call('POST', '/api/observations', { kind: 'price', subject: hk.id, value: 10, currency: 'HKD' });
  const pv = await call('POST', '/api/strategies/preview', { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: hk.id, qty: 100 }] });
  assert.deepEqual([pv.legs[0].calendar.flag, pv.legs[0].settleDate], ['weekends-only', '2026-03-04']); // Mon 2 March + 2 weekdays
  assert.ok(pv.checks.some((c) => c.code === 'calendar-fallback' && /worked out on weekends only/.test(c.message)));
  // Setting real calendars on the instrument removes the flag for the roles they cover.
  const fixed = await call('PUT', `/api/instruments/${hk.id}`, { conventions: { tradingCalendar: 'UK', settlementCalendar: 'UK', paymentCalendar: 'UK' } });
  assert.deepEqual([fixed.calendar.settlement.fallback, fixed.calendar.flag], [false, 'approximate']);
  assert.match(fixed.calendar.flagText, /^Payment dates for this instrument use an approximate calendar\. No payment calendar is built in for HKD/);
  void inst;
});
