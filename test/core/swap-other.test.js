// Swaps that are not rate swaps: regression tests for the notional schedule, notional reset, dividend pass-through,
// payment lag and averaged price-leg rules of server/products/swap.js (s2). Every expected figure is worked out by hand in
// the comment beside it. The scenarios of test/matrix/specs/swap-other.mjs exercise the same rules through the interface.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo } from '../helpers.js';

const rate = (app, code, date, value) => app.data.enterManual({ kind: 'rate', subject: code, value, forDate: date, units: 'percent p.a.' });
const close = (app, inst, date, value) => app.data.enterManual({ kind: 'price', subject: inst.id, value, forDate: date, currency: inst.trading_ccy, units: 'per unit' });
const NO_COLLATERAL = { collateralBasis: { type: 'uncollateralized' } };
const cash = (app, unit, ccy = 'USD') => app.ledger.cash(unit.id, ccy).settled;
const open = (app, type) => app.db.all('SELECT type, status, due_date, blocked_reason FROM tasks WHERE type = ? ORDER BY due_date, created_at', type).filter((t) => ['pending', 'blocked', 'failed'].includes(t.status));
const summaries = (app, book, unit, type) => app.accounting.history(book.id, unit.id).events.filter((e) => e.type === type).map((e) => e.summary);
const NY10 = (date) => `${date}T${date >= '2026-03-08' && date < '2026-11-01' ? '14' : '15'}:00:00.000Z`; // 10:00 New York
const stock = (app, symbol) => app.instruments.create({ productId: 'common_stock', name: `${symbol} Inc.`, symbol, marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {} });

const amortizing = (productId, scheduleA) => ({
  productId, name: `${productId} test`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
  terms: { effective: '2026-03-05', maturity: '2027-03-05', ...NO_COLLATERAL, legs: [
    { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360', notionalSchedule: scheduleA },
    { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', months: 3, dayCount: 'ACT/360' },
  ] },
});

test('notional schedule: a missing period, a step off the periods, the wrong direction and an unreadable step are refused by name', () => {
  const { app } = makeApp();
  const refused = (draft) => { try { app.instruments.create(draft); } catch (e) { return e.message; } return null; };
  // Semi-annual fixed leg: periods start 2026-03-05 and 2026-09-05.
  assert.equal(refused(amortizing('amortizing_swap', [{ from: '2026-03-05', factor: 1 }])), 'Leg A: the notional schedule has no step for the period starting 2026-09-05. An amortizing swap states the notional of every period.');
  assert.match(refused(amortizing('amortizing_swap', [{ from: '2026-03-05', factor: 1 }, { from: '2026-10-05', factor: 0.5 }])), /^Leg A: the notional schedule step from 2026-10-05 is not the start of a period of this leg \(periods start on 2026-03-05, 2026-09-05\)/);
  assert.equal(refused(amortizing('amortizing_swap', [{ from: '2026-03-05', factor: 0.5 }, { from: '2026-09-05', factor: 1 }])), 'Leg A: an amortizing schedule goes down from period to period (and changes at least once); this one does not.');
  assert.equal(refused(amortizing('accreting_swap', [{ from: '2026-03-05', factor: 1 }, { from: '2026-09-05', factor: 0.5 }])), 'Leg A: an accreting schedule goes up from period to period (and changes at least once); this one does not.');
  // A step that cannot be read was silently dropped before; now it is refused, on any swap.
  assert.equal(refused(amortizing('interest_rate_swap', [{ from: '2026-03-05', factor: 1 }, { from: '2026-09-05', factor: null }])), 'Leg A: notional schedule step from 2026-09-05 needs a factor above zero (1 = the trade notional).');
  assert.equal(refused({ ...amortizing('amortizing_swap', null), terms: { ...amortizing('amortizing_swap', null).terms, legs: amortizing('amortizing_swap', null).terms.legs.map((l) => ({ ...l, notionalSchedule: undefined })) } }), 'An amortizing swap needs a notional schedule: state the notional factor of every period on each leg it applies to.');
  assert.ok(app.instruments.create(amortizing('amortizing_swap', [{ from: '2026-03-05', factor: 1 }, { from: '2026-09-05', factor: 0.5 }])).id);
});

test('notional reset: the financing of a period is on the notional it started with, even when the return leg is paid first', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const s = stock(app, 'RSET');
  const contract = {
    productId: 'equity_swap', name: 'Reset test', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    conventions: { paymentCalendar: 'US+USD' },
    terms: { effective: '2026-03-05', maturity: '2026-09-05', ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: s.id, resetNotional: true, paymentLag: 1 },
      { id: 'B', side: 'pay', type: 'float', ccy: 'USD', index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360', paymentLag: 1 },
    ] },
  };
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, statedPrice: 0, contract }] });
  // Periods 5 March to 5 June and 5 June to 5 September (92 days each). Paid 1 business day after each end: Monday 8 June; the 5th of
  // September is a Saturday and Monday the 7th Labor Day: Tuesday 8 September. The second period ends on a Saturday: Friday's close.
  close(app, s, '2026-03-05', 50); close(app, s, '2026-06-05', 60);
  rate(app, 'TEST-3M', '2026-03-05', 4.0); rate(app, 'TEST-3M', '2026-06-05', 4.0);
  await goTo(app, clock, NY10('2026-06-08'));
  // Return: 1,000,000 x (60 / 50 - 1) = 200,000.00. Financing on 1,000,000 (not the reset 1,200,000): 1,000,000 x 4% x 92/360 = 10,222.22.
  assert.equal(cash(app, acct), 500_000 + 200_000 - 10_222.22);
  close(app, s, '2026-09-04', 54);
  await goTo(app, clock, NY10('2026-09-08'));
  // Second period on the reset notional 1,200,000: return 1,200,000 x (54 / 60 - 1) = -120,000.00; financing 1,200,000 x 4% x 92/360 = 12,266.67.
  assert.equal(cash(app, acct), 500_000 + 200_000 - 10_222.22 - 120_000 - 12_266.67);
  assert.deepEqual(open(app, 'swap.maturity'), []);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('dividend pass-through: a dividend in the first period is passed through from the start fixing; a missing fixing holds it and the maturity', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const s = stock(app, 'DIVP');
  const contract = {
    productId: 'equity_trs', name: 'Dividend test', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-05', maturity: '2026-06-05', ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'receive', type: 'return', ccy: 'USD', months: 0, underlyingId: s.id, passDividends: true },
      { id: 'B', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.0, months: 0, dayCount: 'ACT/360' },
    ] },
  };
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 2_000_000, statedPrice: 0, contract }] });
  app.corpactions.record({ instrumentId: s.id, type: 'cash_dividend', exDate: '2026-04-01', amount: 0.75 });
  await goTo(app, clock, NY10('2026-04-01'));
  // The start fixing (5 March) is not known: the pass-through waits, visibly.
  assert.match(open(app, 'swap.dividend')[0].blocked_reason, /Awaiting the 2026-03-05 fixing for DIVP, the start of the period, to pass through the dividend of 0\.75 \(ex-date 2026-04-01\)/);
  assert.equal(cash(app, acct), 500_000);
  close(app, s, '2026-03-05', 40);
  await advance(app, clock, 1000);
  // 2,000,000 / 40 = 50,000 reference shares x 0.75 = 37,500.00.
  assert.deepEqual(summaries(app, book, acct, 'swap.dividend'), ['Dividend pass-through on Dividend test: received 37,500.00 USD (50,000 reference shares x 0.75)']);
  assert.equal(cash(app, acct), 537_500);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('averaged price legs, peak hours and net settlement: a missing pricing day is named, then one net amount moves', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const idx = app.instruments.create({ productId: 'electricity', name: 'Test peak index', symbol: 'TPEAK', marketView: 'US_CASH', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', terms: {} });
  const peak = { hours: 'peak', peakHours: 16, peakCalendar: 'WEEKEND' };
  const contract = {
    productId: 'electricity_swap', name: 'Peak test', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-06-01', maturity: '2026-07-01', netSettlement: true, ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'pay', type: 'price', ccy: 'USD', months: 1, units: 1, fixedPrice: 45, ...peak },
      { id: 'B', side: 'receive', type: 'price', ccy: 'USD', months: 1, units: 1, underlyingId: idx.id, averaging: 'daily', pricingCalendar: 'WEEKEND', ...peak },
    ] },
  };
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1, statedPrice: 0, contract }] });
  // June 2026 has 22 weekdays: 22 x 16 = 352 peak hours. Every weekday's index is 50.00 except 10 June, not supplied.
  for (let d = 1; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, '0')}`;
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6 && date !== '2026-06-10') close(app, idx, date, 50);
  }
  await goTo(app, clock, NY10('2026-07-01'));
  const blocked = open(app, 'swap.payment');
  assert.equal(blocked.length, 2);
  for (const t of blocked) assert.match(t.blocked_reason, /Awaiting the averaging fixings of TPEAK for 2026-06-10 \(1 of the 22 pricing days of the period 2026-06-01 to 2026-07-01\)/);
  assert.equal(cash(app, acct), 500_000, 'nothing moves while one leg cannot be worked out');
  close(app, idx, '2026-06-10', 50);
  await advance(app, clock, 1000);
  // Net: 352 MWh x (50.00 - 45.00) = 1,760.00, one event with both legs.
  assert.deepEqual(summaries(app, book, acct, 'swap.payment'), ['Net swap receipt on Peak test, period 2026-06-01 to 2026-07-01: 1,760.00 USD (leg A, fixed price 45.00 x 352 (352 hours): 15,840.00 USD paid; leg B, average of 22 fixings 50.00 x 352 (352 hours): 17,600.00 USD received)']);
  assert.equal(cash(app, acct), 501_760);
  assert.deepEqual(open(app, 'swap.payment'), []);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('net settlement is refused with a return leg; a payment lag outside 0-10 business days is refused', () => {
  const { app } = makeApp();
  const s = stock(app, 'NETR');
  const refused = (draft) => { try { app.instruments.create(draft); } catch (e) { return e.message; } return null; };
  const base = { productId: 'equity_swap', name: 'Net test', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD' };
  assert.match(refused({ ...base, terms: { effective: '2026-03-05', maturity: '2026-09-05', netSettlement: true, ...NO_COLLATERAL, legs: [
    { side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: s.id }, { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 3 }] } }), /^Net settlement applies to fixed, floating, price, cap and floor legs/);
  assert.equal(refused({ ...base, terms: { effective: '2026-03-05', maturity: '2026-09-05', ...NO_COLLATERAL, legs: [
    { side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: s.id, paymentLag: 12 }, { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 3 }] } }), 'Leg A: the payment lag is a whole number of business days from 0 to 10.');
});
