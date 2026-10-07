// Debt securities: interest follows settlement while positions follow the trade date.
//
// Regression tests for four faults found by the product test matrix (test/matrix/specs/bond-government.mjs):
//   1. the end-of-day run on a trade date trued the accrued balance down to the trade date, although the interest
//      bought runs to the settlement date: a day (three over a weekend) of negative coupon income, given back later;
//   2. after downtime, a coupon was paid first and the end-of-day run of an earlier date then re-accrued the old
//      coupon period on top of it, overstating net assets by almost a full coupon until the next end of day;
//   3. a coupon was paid to the face held on trade date at the open of the coupon date, so a buyer whose purchase
//      settled on or after the coupon date (and paid no accrued interest for it) still received it, and a seller
//      lost a coupon the buyer had not paid for;
//   4. the previewed settlement amount rounded principal plus accrued together, the fill rounds each: one cent apart.
//
// Instrument: 4% semi-annual, ACT/ACT, coupons 15 May and 15 November, T+1 on the US bond calendar.
// 15 May 2026 to 15 Nov 2026 is 184 days; 15 Nov 2026 to 15 May 2027 is 181 days. Figures are worked out by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';

const MON = '2026-11-09T15:00:00.000Z'; // Monday 9 November 2026, 10:00 New York
const at1730 = (d) => `${d}T22:30:00.000Z`; // 17:30 New York: after the end-of-day cutoff
const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e9, askSize: 1e9 });
const note = (app) => {
  const b = app.instruments.create({ productId: 'treasury_note', name: 'Test 4% 15-Nov-2030', symbol: 'TEST30', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2, maturity: '2030-11-15', issueDate: '2023-11-15', dayCount: 'ACT/ACT' } });
  pin(app, b.id, 100);
  return b;
};
const buy = (app, book, unit, inst, qty) => trade(app, { bookId: book.id, unitId: unit.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.id, qty }] });
const accrued = (app, unit) => app.ledger.balance(unit.id, 'accrued.asset', 'USD');
const couponIncome = (app, book, unit) => app.accounting.pnl(book.id, unit.id).categories.find((x) => x.key === 'couponInterest').rc;
const events = (app, book, unit, type) => app.accounting.history(book.id, unit.id, { includeAccruals: true }).events.filter((e) => e.type === type);

test('bond accrual: interest bought runs to the settlement date, so the trade date earns nothing and loses nothing', async () => {
  const { app, clock } = makeApp({ at: MON });
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_000_000 });
  const b = note(app);
  await buy(app, book, acct, b, 1_000_000);
  // Settles Tuesday 10 Nov: 179 days into the 184-day period. 1,000,000 x 2% x 179/184 = 19,456.5217.
  assert.equal(accrued(app, acct), 19_456.52);
  await goTo(app, clock, at1730('2026-11-09')); // end of the trade date
  assert.equal(accrued(app, acct), 19_456.52, 'the accrued bought is not trued down to the trade date');
  assert.equal(couponIncome(app, book, acct), 0, 'no negative income on the trade date');
  assert.equal(app.accounting.overview(book.id).nav, 3_000_000, 'buying accrued interest at par changes nothing');
  await goTo(app, clock, at1730('2026-11-10')); // end of the settlement date: interest to 10 Nov is what was bought
  assert.equal(accrued(app, acct), 19_456.52);
  assert.equal(couponIncome(app, book, acct), 0);
  await goTo(app, clock, at1730('2026-11-11')); // 180 days: 20,000 x 180/184 = 19,565.2174
  assert.equal(accrued(app, acct), 19_565.22);
  assert.equal(couponIncome(app, book, acct), 108.7);
  assert.ok(events(app, book, acct, 'accrual.coupon').every((e) => e.entries.find((x) => x.account === 'accrued.asset').amount > 0), 'every accrual added income');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('bond accrual: a coupon paid while catching up is not re-accrued by the end-of-day run of an earlier date', async () => {
  const { app, clock } = makeApp({ at: MON });
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_000_000 });
  const b = note(app);
  await buy(app, book, acct, b, 1_000_000);
  await goTo(app, clock, at1730('2026-11-12')); // 181 days: 20,000 x 181/184 = 19,673.913
  assert.equal(accrued(app, acct), 19_673.91);
  // The Terminal is closed from Thursday evening to Monday morning. The 15 Nov coupon (a Sunday) is paid on Monday 16
  // Nov, and the end-of-day run of Friday 13 Nov only happens after it.
  await goTo(app, clock, '2026-11-16T15:00:00.000Z');
  assert.equal(events(app, book, acct, 'bond.coupon').length, 1);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 2_000_000 - 1_019_456.52 + 20_000);
  assert.equal(accrued(app, acct), 0, 'the balance stands at the coupon date: nothing of the old period is accrued again');
  assert.equal(couponIncome(app, book, acct), 543.48); // 20,000 received less 19,456.52 bought
  assert.equal(app.accounting.overview(book.id).nav, 3_000_543.48);
  await goTo(app, clock, at1730('2026-11-16')); // one day into the 181-day period: 20,000 / 181 = 110.497
  assert.equal(accrued(app, acct), 110.5);
  assert.equal(couponIncome(app, book, acct), 653.98);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('bond coupon: paid to the face settled before the coupon date, whoever holds it on trade date', async () => {
  const { app, clock } = makeApp({ at: MON });
  const { book, acct, treasury } = makeBook(app, { cash: 5_000_000, account: 2_000_000 });
  const beta = app.books.createAccount(book.id, { name: 'Beta' });
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: beta.id, ccy: 'USD', amount: 1_000_000, purpose: 'test funding' });
  const b = note(app);
  const a = await buy(app, book, acct, b, 1_000_000); // settles 10 Nov: accrued 19,456.52
  const s = await buy(app, book, beta, b, 500_000); // settles 10 Nov: 500,000 x 2% x 179/184 = 9,728.26
  await goTo(app, clock, '2026-11-13T15:00:00.000Z'); // Friday: trades settle Monday 16 Nov, after the Sunday 15 Nov coupon date
  // Alpha sells 400,000 of its 1,000,000; Beta sells all 500,000; Treasury buys 300,000.
  const sell = async (strategy, unit, qty) => {
    const pv = await app.packages.previewAction(strategy.id, 'close', { positionIds: [strategy.positions[0].positionId], qty });
    assert.equal(pv.legs[0].settleDate, '2026-11-16');
    return (await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true })).strategy;
  };
  const afterSale = await sell(a, acct, 400_000);
  // Interest sold runs to 16 Nov, one day into the new period: 400,000 x 2% x 1/181 = 44.20.
  assert.equal(afterSale.orders.at(-1).fills[0].qty, 400_000);
  await sell(s, beta, 500_000); // 500,000 x 2% x 1/181 = 55.25 of interest sold
  const t = await buy(app, book, treasury, b, 300_000); // 300,000 x 2% x 1/181 = 33.15 of interest bought
  assert.equal(accrued(app, treasury), 33.15);
  // Beta is flat on trade date but still owns the coupon: it stays scheduled, and what Beta is still to receive stays on its books.
  assert.equal(app.positions.get(s.positions[0].positionId).qty, 0);
  assert.equal(accrued(app, beta), 10_000, 'the coupon still to be received');
  assert.equal(app.accounting.pending(book.id, beta.id).lifecycle.filter((x) => x.type === 'bond.coupon').length, 1);

  await goTo(app, clock, '2026-11-16T15:00:00.000Z');
  const coupons = (unit) => events(app, book, unit, 'bond.coupon').map((e) => e.cash[0].amount);
  assert.deepEqual(coupons(acct), [20_000], 'the seller is paid on all 1,000,000: its sale of 400,000 settles on the 16th');
  assert.deepEqual(coupons(beta), [10_000], 'sold everything before the coupon date, settling after it: the coupon is the seller\'s');
  assert.deepEqual(coupons(treasury), [], 'bought before the coupon date, settling after it: paid no accrued for it and receives no coupon');
  assert.equal(accrued(app, beta), 0);
  // Beta's interest income: 10,000 coupon + 55.25 sold - 9,728.26 bought = 326.99.
  assert.equal(couponIncome(app, book, beta), 326.99);
  assert.equal(app.accounting.pending(book.id, beta.id).lifecycle.length, 0, 'nothing is left scheduled on the closed position');
  // Alpha: 600,000 left. At the coupon date its balance is the interest sold, booked ahead: -44.20 until that sale's day passes.
  await goTo(app, clock, at1730('2026-11-16')); // interest to 16 Nov on the 600,000 now settled: 600,000 x 2% x 1/181 = 66.30
  assert.equal(accrued(app, acct), 66.3);
  // Alpha's income: 20,000 + 44.20 sold + 66.30 accrued - 19,456.52 bought = 653.98 (one day on 1,000,000 of the new period is 110.50).
  assert.equal(couponIncome(app, book, acct), 653.98);
  assert.equal(accrued(app, treasury), 33.15, 'interest to 16 Nov on 300,000 is what was bought');
  assert.equal(couponIncome(app, book, treasury), 0);
  assert.equal(t.status, 'open');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('bond preview: the settlement amount shown is the amount that settles, to the cent', async () => {
  const { app } = makeApp({ at: MON });
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_000_000 });
  const b = note(app);
  pin(app, b.id, 99.53125);
  const input = { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: b.id, qty: 123_400 }] };
  const pv = await app.packages.preview(input);
  // Principal 123,400 x 99.53125% = 122,821.5625 -> 122,821.56. Accrued 123,400 x 2% x 179/184 = 2,400.9348 -> 2,400.93.
  // Together 125,222.49 (rounding the sum 125,223.4973 first would give 125,222.50).
  assert.equal(pv.legs[0].gross, 122_821.56);
  assert.equal(pv.legs[0].accrued, 2_400.93);
  assert.equal(pv.legs[0].cash, -125_222.49);
  await app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.equal(app.accounting.pending(book.id, acct.id).awaitingSettlement[0].amount, -125_222.49);
  assert.equal(events(app, book, acct, 'order.fill_variance').length, 0, 'the fill is exactly what was confirmed');
});

test('bond registration: the minimum denomination is a whole face amount, and trades are multiples of it', async () => {
  const { app } = makeApp({ at: MON });
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_000_000 });
  const draft = (minDenomination) => ({ productId: 'municipal_bond', name: `Test muni ${minDenomination}`, marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.05, frequency: 2, maturity: '2031-06-01', dayCount: '30/360', minDenomination } });
  assert.throws(() => app.instruments.create(draft(0)), /Minimum denomination/);
  assert.throws(() => app.instruments.create(draft(2.5)), /Minimum denomination/);
  const m = app.instruments.create(draft(5000));
  pin(app, m.id, 101);
  assert.equal(app.instruments.toView(m).qtyStep, 5000);
  const preview = (qty) => app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: m.id, qty }] });
  const odd = await preview(12_000);
  assert.equal(odd.blocking, 1);
  assert.match(odd.checks.find((c) => c.level === 'error').message, /quantity must be a multiple of 5000/);
  assert.equal((await preview(15_000)).blocking, 0);
});

test('bond maturity: a debt security trades only for settlement before its maturity date', async () => {
  const { app, clock } = makeApp({ at: '2026-12-08T15:00:00.000Z' }); // Tuesday
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_000_000 });
  const bill = app.instruments.create({ productId: 'treasury_bill', name: 'Test bill 10-Dec-2026', symbol: 'TESTBILL', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'zero', maturity: '2026-12-10', dayCount: 'ACT/360' } });
  pin(app, bill.id, 99.98);
  const leg = (extra = {}) => ({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: bill.id, qty: 100_000, ...extra }] });
  // Tuesday 8 Dec, T+1: settles Wednesday 9 Dec, the day before maturity. Allowed.
  assert.equal((await app.packages.preview(leg())).blocking, 0);
  // A buy order below the market, good until cancelled, rests unfilled.
  const resting = await trade(app, leg({ orderType: 'limit', limitPrice: 99.5, tif: 'gtc' }));
  assert.equal(resting.orders[0].status, 'working');
  // Wednesday 9 Dec: a regular trade would settle on the maturity date itself, when the bill is redeemed. Refused, with the way out.
  await goTo(app, clock, '2026-12-09T15:00:00.000Z');
  const late = await app.packages.preview(leg());
  assert.equal(late.blocking, 1);
  assert.match(late.checks.find((c) => c.code === 'matured').message, /matures on 2026-12-10; this trade would settle on 2026-12-10/);
  assert.equal((await app.packages.preview(leg({ settle: { lag: 0 } }))).blocking, 0, 'same-day settlement is still before maturity');
  // Friday 11 Dec: the bill has matured. A new trade is refused, and the resting order, now marketable against the
  // quote that is still on file, ends rejected instead of filling.
  await goTo(app, clock, '2026-12-11T15:00:00.000Z');
  const after = await app.packages.preview(leg());
  assert.match(after.checks.find((c) => c.code === 'matured').message, /matured on 2026-12-10 and was redeemed/);
  pin(app, bill.id, 99.4);
  await app.engine.tick();
  const o = app.packages.strategyView(resting.id).orders[0];
  assert.equal(o.status, 'rejected');
  assert.match(o.statusReason, /matured on 2026-12-10/);
  assert.equal(o.filledQty, 0);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 2_000_000, 'nothing was bought');
});

test('bond short: collateral is marked on the market value including the accrued coupon the short owes', async () => {
  const { app, clock } = makeApp({ at: '2027-02-09T15:00:00.000Z' }); // Tuesday
  const { book, acct } = makeBook(app, { cash: 5_000_000, account: 2_000_000 });
  // 4.5% semi-annual ACT/ACT, coupons 15 Feb and 15 Aug. 15 Aug 2026 to 15 Feb 2027 is 184 days.
  const b = app.instruments.create({ productId: 'treasury_bond', name: 'Test 4.5% 15-Feb-2052', symbol: 'TEST52', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.045, frequency: 2, maturity: '2052-02-15', issueDate: '2022-02-15', dayCount: 'ACT/ACT' } });
  pin(app, b.id, 96.5);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: b.id, legs: [
    { kind: 'borrow_sec', action: 'borrow_sec', instrumentId: b.id, qty: 1_000_000, purpose: 'financing', role: 'borrow', borrow: { available: true, feeRate: 0.004 } },
    { kind: 'trade', action: 'sell_short', instrumentId: b.id, qty: 1_000_000, role: 'underlying', dependsOn: [1] },
  ] });
  assert.equal(s.status, 'open');
  // Sold at 96.5: principal 965,000. Accrued to the 10 Feb settlement, 179 of 184 days: 22,500 x 179/184 = 21,888.59. No commission in this Book.
  await goTo(app, clock, '2027-02-10T15:00:00.000Z');
  const restricted = () => app.ledger.balance(acct.id, 'cash.restricted', 'USD');
  // 102% x (965,000 clean + 21,888.59 accrued owed) = 1,006,626.36. Marking on the clean value alone (984,300.00) would
  // have released 2,588.59 of the accrued interest received from the buyer into free cash.
  assert.equal(restricted(), 1_006_626.36);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 2_000_000 - (1_006_626.36 - 986_888.59), 'the top-up came from settled cash');
  // Tuesday 16 Feb (15 Feb is Washington's Birthday): the coupon is paid to the lender, the accrued owed is gone, and the collateral follows.
  await goTo(app, clock, '2027-02-16T15:00:00.000Z');
  const coupon = events(app, book, acct, 'bond.coupon');
  assert.equal(coupon.length, 1);
  assert.equal(coupon[0].summary, 'Coupon paid on 1,000,000 TEST52 sold short: 22,500.00 USD');
  assert.equal(accrued(app, acct), 0);
  assert.equal(restricted(), 984_300, '102% of the clean value once no accrued coupon is owed');
  // Interest cost of the short so far: 22,500 paid less 21,888.59 received.
  assert.equal(couponIncome(app, book, acct), -611.41);
  assert.ok(events(app, book, acct, 'accrual.coupon').every((e) => /^Interest cost accrued on TEST52/.test(e.summary)), 'a short accrues an interest cost, and the history says so');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('bond coupon: a fixed coupon on ACT/365 pays the rate divided by the frequency; the day count governs accrued interest only', async () => {
  const { accruedPer100, couponPer100 } = await import('../../server/quant/bond.js');
  // A Japanese government bond: 1.4%, semi-annual on 20 June and 20 December, accrued on ACT/365.
  const jgb = { couponType: 'fixed', couponRate: 0.014, frequency: 2, maturity: '2035-12-20', dayCount: 'ACT/365' };
  // 20 June to 20 December 2026 is 183 days, 20 December to 20 June 2027 is 182: both coupons are 0.70 per 100.
  const near0 = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  near0(couponPer100(jgb, '2026-12-20'), 0.7);
  near0(couponPer100(jgb, '2027-06-20'), 0.7);
  // Accrued interest counts actual days over 365: 153 days to 20 November 2026.
  assert.ok(Math.abs(accruedPer100(jgb, '2026-11-20') - (1.4 * 153) / 365) < 1e-12);
  // A floating coupon on ACT/365, and any coupon on the money-market basis ACT/360, pays for the actual days of its period.
  const frn = { couponType: 'float', currentCoupon: 0.014, frequency: 2, maturity: '2035-12-20', dayCount: 'ACT/365' };
  assert.ok(Math.abs(couponPer100(frn, '2026-12-20') - (1.4 * 183) / 365) < 1e-12);
  assert.ok(Math.abs(couponPer100({ ...jgb, dayCount: 'ACT/360' }, '2026-12-20') - (1.4 * 183) / 360) < 1e-12);
});

test('bond coupon: a trade on the coupon date, after the coupon was paid, does not schedule and pay it again', async () => {
  const { app, clock } = makeApp({ at: MON });
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_000_000 });
  // Coupons on 16 May and 16 November: 16 November 2026 is a Monday, a business day.
  const b = app.instruments.create({ productId: 'treasury_note', name: 'Test 4% 16-Nov-2030', symbol: 'TEST16', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2, maturity: '2030-11-16', issueDate: '2023-11-16', dayCount: 'ACT/ACT' } });
  pin(app, b.id, 100);
  const s = await buy(app, book, acct, b, 1_000_000); // settles 10 Nov, 178 days into the 184-day period: 20,000 x 178/184 = 19,347.83
  await goTo(app, clock, '2026-11-16T15:00:00.000Z');
  assert.deepEqual(events(app, book, acct, 'bond.coupon').map((e) => e.cash[0].amount), [20_000]);
  // Part of the position is sold later the same day.
  const pv = await app.packages.previewAction(s.id, 'close', { positionIds: [s.positions[0].positionId], qty: 400_000 });
  await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true });
  await app.engine.tick();
  await goTo(app, clock, '2026-11-17T15:00:00.000Z');
  assert.deepEqual(events(app, book, acct, 'bond.coupon').map((e) => e.cash[0].amount), [20_000], 'the coupon of 16 November was paid once');
  const open = app.accounting.pending(book.id, acct.id).lifecycle.filter((x) => x.type === 'bond.coupon');
  assert.deepEqual(open.map((x) => x.dueDate), ['2027-05-17'], 'the next coupon (16 May 2027, a Sunday) is the one scheduled');
  // Cash: 2,000,000 - 1,019,347.83 paid + 20,000 coupon + 400,000 x 100% + 400,000 x 2% x 1/181 (one day of the new period) sold.
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 1_400_696.37);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('bond coupon: a position bought for settlement on or after the coupon date is not scheduled for that coupon', async () => {
  const { app, clock } = makeApp({ at: '2026-11-13T15:00:00.000Z' }); // Friday 13 November 2026
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_000_000 });
  const b = note(app);
  await buy(app, book, acct, b, 1_000_000); // settles Monday 16 Nov, after the coupon date of Sunday 15 Nov: bought ex coupon
  assert.equal(accrued(app, acct), 110.5, 'one day of the new 181-day period was bought: 20,000 x 1/181 = 110.497');
  const coupons = () => app.accounting.pending(book.id, acct.id).lifecycle.filter((x) => x.type === 'bond.coupon').map((x) => x.dueDate);
  assert.deepEqual(coupons(), ['2027-05-17'], 'the first coupon listed is the one the position will be paid (15 May 2027 is a Saturday), not the 15 November one');
  await goTo(app, clock, '2026-11-17T15:00:00.000Z');
  assert.deepEqual(events(app, book, acct, 'bond.coupon'), [], 'no coupon on 16 November');
  assert.deepEqual(coupons(), ['2027-05-17']);
  assert.deepEqual(ledgerImbalance(app), []);
});
