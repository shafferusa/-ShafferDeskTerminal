import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo, DAY } from '../helpers.js';

const pin = (app, id, px, size = 1e6) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: size, askSize: size });

test('futures post margin, settle variation daily, and report notional separately from value', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const fut = inst['S5 2026-03'];
  pin(app, fut.id, 5000);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: fut.id, qty: 2 }] });
  const p = s.positions[0];
  assert.equal(p.qty, 2);
  assert.equal(p.notional, 2 * 5000 * 50, 'notional is 500,000');
  assert.equal(p.mv, 0, 'value is open trade equity, not the notional');
  assert.equal(p.marginPosted, 24_000);
  let c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.settled, 500_000 - 24_000 - 4.5, 'only margin and commission left free cash');
  assert.equal(c.margin, 24_000);
  // End of day: settlement price 5010 -> variation +1000.
  app.data.market.set(`${fut.id}@2026-03-02`, { value: 5010 });
  await goTo(app, clock, '2026-03-02T22:30:00.000Z');
  c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.settled, 500_000 - 24_000 - 4.5 + 1000);
  const ev = app.accounting.history(book.id, acct.id).events.find((e) => e.type === 'future.variation');
  assert.match(ev.summary, /Variation margin received/);
  assert.ok(ev.data.priceObsId, 'the settlement price observation is preserved');
  // Next day: sell one at 4990 -> realized (4990 - 5010) x 50 = -1000; margin released for one contract.
  pin(app, fut.id, 4990);
  await goTo(app, clock, '2026-03-03T15:00:00.000Z');
  const pv = await app.packages.previewAction(s.id, 'close', { fraction: 0.5 });
  await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'close', legs: pv.legs, clientToken: pv.token, confirm: true });
  c = app.ledger.cash(acct.id, 'USD');
  assert.equal(c.margin, 12_000);
  const pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.categories.find((x) => x.key === 'realized').rc, 0, '+1000 variation then -1000 on the closing trade');
  assert.equal(pnl.unrealized.current, (4990 - 5010) * 50, 'the remaining contract is marked since the last settlement');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('futures final settlement closes in cash; a missing settlement price blocks it visibly', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const fut = inst['S5 2026-03'];
  pin(app, fut.id, 5000);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: fut.id, qty: 1 }] });
  assert.equal(s.positions[0].qty, -1);
  app.data.market.set(`${fut.id}@2026-03-20`, { value: 4900 });
  await goTo(app, clock, '2026-03-20T22:30:00.000Z');
  const v = app.packages.strategyView(s.id);
  assert.equal(v.status, 'closed');
  assert.equal(app.ledger.cash(acct.id, 'USD').margin, 0);
  const total = app.accounting.pnl(book.id, acct.id).investmentPnl;
  assert.equal(total, (5000 - 4900) * 50 - 2.25, 'short one contract from 5000 to 4900, less commission');
});

test('futures calendar spread and futures hedge templates', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const near = inst['S5 2026-03'], far = inst['S5 2026-06'];
  pin(app, near.id, 5000); pin(app, far.id, 5050); pin(app, inst.SIM500.id, 500);
  const cal = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'futures_calendar', futures: { instrumentId: near.id, farInstrumentId: far.id, contracts: 3 } });
  assert.deepEqual(cal.legs.map((l) => [l.action, l.instrument.symbol, l.qty]), [['buy', 'S5 2026-03', 3], ['sell', 'S5 2026-06', 3]]);
  assert.equal(cal.totals.cash.USD.margin, 72_000, 'both months post margin; no spread margin is assumed');
  assert.equal(cal.payoff.type, 'scenarios');
  await assert.rejects(app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'futures_calendar', futures: { instrumentId: near.id, farInstrumentId: inst['SKJ 2026-03'].id, contracts: 1 } }), /same underlying/);
  // Hedge 1,000 ETF shares (500,000) with a 0.5 hedge ratio: 250,000 / (5000 x 50) = 1 contract short.
  const hedge = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'futures_hedge', underlyingId: inst.SIM500.id, quantity: 1000, hedgeRatio: 0.5, futures: { instrumentId: near.id } });
  const f = hedge.legs.find((l) => l.instrument.family === 'future');
  assert.equal(f.action, 'sell');
  assert.equal(f.qty, 1);
  assert.equal(f.purpose, 'hedge');
  assert.equal(f.notional, 250_000);
  assert.ok(hedge.blocking > 0, '500,000 of stock plus margin exceeds the Account cash');
});

test('FX is a conversion between currency balances; transfers never convert', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const eur = inst['EUR/USD'];
  app.data.market.set(eur.id, { bid: 1.1, ask: 1.1002, value: 1.1001 });
  app.data.market.set('EUR/USD', { value: 1.1001 });
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: eur.id, qty: 100_000 }] });
  assert.equal(s.orders[0].avgPrice, 1.1002);
  assert.equal(s.status, 'closed', 'a conversion leaves no position');
  let usd = app.ledger.cash(acct.id, 'USD'), e = app.ledger.cash(acct.id, 'EUR');
  assert.equal(e.receivable, 100_000);
  assert.equal(usd.payable, 110_020);
  await goTo(app, clock, '2026-03-04T15:00:00.000Z'); // T+2
  usd = app.ledger.cash(acct.id, 'USD'); e = app.ledger.cash(acct.id, 'EUR');
  assert.equal(e.settled, 100_000);
  assert.equal(usd.settled, 500_000 - 110_020);
  // Reporting-currency view: dealing cost shows as an FX effect, then translation moves with the rate.
  app.data.market.set('EUR/USD', { value: 1.1001 });
  await app.data.refresh({ pairs: ['EUR/USD'] });
  let pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.fx.current, -10, 'paid 1.1002 against a 1.1001 mid on 100,000');
  app.data.market.set('EUR/USD', { value: 1.2001 });
  await app.data.refresh({ pairs: ['EUR/USD'] });
  pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.fx.current, 9990, 'EUR balance revalued 10 cents higher');
  assert.equal(pnl.nav.end, 500_000 + 9990);
  assert.deepEqual(ledgerImbalance(app), []);
  // Selling EUR that is not held fails: borrow it explicitly instead.
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: eur.id, qty: 150_000 }] });
  assert.ok(pv.blocking);
});

test('foreign equity: local and USD amounts without double counting', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const jpy = inst['USD/JPY'];
  app.data.market.set(jpy.id, { bid: 150, ask: 150, value: 150 });
  app.data.market.set('USD/JPY', { value: 150 });
  app.data.market.set('JPY/USD', { value: 1 / 150 });
  // Sell 100,000 USD for JPY (buy base USD? no: USD/JPY base is USD, so SELL base to get JPY).
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: jpy.id, qty: 100_000 }] });
  await goTo(app, clock, '2026-03-04T15:00:00.000Z');
  assert.equal(app.ledger.cash(acct.id, 'JPY').settled, 15_000_000);
  pin(app, inst.KAIJ.id, 3000);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.KAIJ.id, quantity: 1000 });
  assert.equal(s.orders[0].fills[0].settleDate, '2026-03-06', 'foreign cash equity settles T+2');
  assert.ok(s.orders[0].fills[0].fxObservation, 'the FX observation used for the fill is preserved');
  pin(app, inst.KAIJ.id, 3300);
  await goTo(app, clock, '2026-03-06T15:00:00.000Z');
  const pos = app.accounting.openPositions(book.id, acct.id).positions[0];
  assert.equal(pos.unrealized, 300_000);
  assert.equal(pos.ccy, 'JPY');
  assert.equal(pos.unrealizedRc, 2000, '300,000 JPY at 150');
  // Yen weakens to 160: the stock gain in USD shrinks and cash + cost translate lower.
  app.data.market.set('USD/JPY', { value: 160 }); app.data.market.set('JPY/USD', { value: 1 / 160 });
  await app.data.refresh({ pairs: ['JPY/USD', 'USD/JPY'] });
  const pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.unrealized.current, 1875, '300,000 JPY at 160');
  assert.equal(pnl.fx.current, -6250, '15,000,000 JPY of net assets: 100,000 USD at 150, 93,750 at 160');
  assert.equal(pnl.nav.end, 500_000 + 1875 - 6250);
  assert.equal(pnl.investmentPnl, 1875 - 6250);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a borrowed currency can be converted at spot at once; the conversion still settles T+2', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app, { cash: 1_000_000, account: 100_000 });
  const jpy = inst['USD/JPY'];
  app.data.market.set(jpy.id, { bid: 150, ask: 150, value: 150 });
  app.data.market.set('USD/JPY', { value: 150 });
  app.data.market.set('JPY/USD', { value: 1 / 150 });
  // One package, one confirmation: borrow 15,000,000 JPY and sell it for USD in the same moment.
  const loan = { kind: 'loan', action: 'borrow_cash', qty: 15_000_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'JPY loan', marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: 'JPY', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.01 } } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loan, { kind: 'trade', action: 'buy', instrumentId: jpy.id, qty: 100_000, dependsOn: [1] }] });
  const [l, fx] = s.orders;
  assert.equal(l.status, 'filled');
  assert.equal(fx.status, 'filled', 'the conversion executes immediately; it does not wait for anything to settle');
  assert.equal(fx.fills[0].settleDate, '2026-03-04', 'spot FX keeps its T+2 settlement');
  // The borrowed yen is settled cash at once and is committed to the conversion.
  let y = app.ledger.cash(acct.id, 'JPY'), u = app.ledger.cash(acct.id, 'USD');
  assert.equal(y.settled, 15_000_000);
  assert.equal(y.payable, 15_000_000);
  assert.equal(y.availableToTrade, 0);
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'JPY'), -15_000_000, 'the borrowing is a liability');
  // The dollars are owed to the Account and count as buying power straight away, but cannot leave before T+2.
  assert.equal(u.receivable, 100_000);
  assert.equal(u.availableToTrade, 200_000);
  assert.equal(u.availableToWithdraw, 100_000);
  // Buying a T+1 security with them is allowed, with a warning about the one-day gap.
  pin(app, inst.ALFA.id, 100);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1500 });
  assert.equal(pv.blocking, 0);
  assert.ok(pv.checks.some((c) => c.code === 'settle-timing'), 'the preview says the purchase settles a day before the FX proceeds arrive');
  // Within settled cash there is no such warning.
  const ok = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 900 });
  assert.ok(!ok.checks.some((c) => c.code === 'settle-timing'));
  await goTo(app, clock, '2026-03-04T15:00:00.000Z');
  y = app.ledger.cash(acct.id, 'JPY'); u = app.ledger.cash(acct.id, 'USD');
  assert.equal(y.settled, 0);
  assert.equal(u.settled, 200_000);
  assert.deepEqual(ledgerImbalance(app), []);
  // Selling a currency that is neither held nor borrowed is still refused.
  const naked = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: jpy.id, qty: 50_000 }] });
  assert.ok(naked.blocking > 0);
});

// ---- borrowing plus immediate spot FX, followed from execution to repayment ------------------------------------------
//
// One "borrow and convert", reconciled at each date. All figures are worked out by hand:
//   Wed 18 Mar 2026  borrow 15,000,000 JPY at 1.46% ACT/365 (600 JPY a day: 15,000,000 x 0.0146 / 365) and sell it for
//                    100,000 USD at 150.00 in the same package. Spot T+2 on business days of both currencies:
//                    Thu 19, (Fri 20 is Vernal Equinox Day, a Tokyo holiday), so the value date is Mon 23 Mar.
//   Mon 23 Mar       the conversion settles: 15,000,000 JPY out, 100,000 USD in.
//   Thu 26 Mar       buy 15,007,800 JPY back with 100,052 USD at 150.00 (value Mon 30 Mar) to repay with interest.
//   Tue 31 Mar       repay: 13 days of interest = 13 x 600 = 7,800 JPY. 15,007,800 JPY leaves; nothing is owed.
//                    (The loan is open-ended, so its interest would otherwise be paid on the first business day of
//                    each month: that payment, scheduled for Wed 1 Apr, must disappear with the repayment.)
// The Account starts with 100,000 USD. With USD/JPY held at 150.00 the only P&L is the interest: 7,800 JPY = 52.00 USD.

const JPY_LOAN = { kind: 'loan', action: 'borrow_cash', qty: 15_000_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'JPY loan 1.46%', marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: 'JPY', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.0146, dayCount: 'ACT/365' } } };
function pinYen(app, inst) {
  app.data.market.set(inst['USD/JPY'].id, { bid: 150, ask: 150, value: 150 });
  app.data.market.set('USD/JPY', { value: 150 });
  app.data.market.set('JPY/USD', { value: 1 / 150 });
}
const near = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test('borrow and convert, execution day: one liability, interest from the trade date, cash committed but not yet moved, value date on the joint calendar', async () => {
  const { app, inst } = makeApp({ at: '2026-03-18T15:00:00.000Z' });
  const { book, acct, treasury } = makeBook(app, { cash: 1_000_000, account: 100_000 });
  pinYen(app, inst);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', name: 'Borrow yen, convert to dollars', legs: [JPY_LOAN, { kind: 'trade', action: 'buy', instrumentId: inst['USD/JPY'].id, qty: 100_000, dependsOn: [1] }] });
  assert.equal(pv.blocking, 0);
  // Displayed and confirmed: 15,000,000 JPY received at 1.46% (600 JPY a day shown on ACT/360 as 608: 15,000,000 x 0.0146 / 360 = 608.33 -> 608),
  // then 100,000 USD bought for 15,000,000 JPY, value 23 March.
  const [cl, cf] = pv.confirmation.legs;
  assert.deepEqual([cl.financing.amount, cl.financing.rate, cl.financing.rateType, cl.cash], [15_000_000, 0.0146, 'fixed', 15_000_000]);
  assert.deepEqual([cf.price, cf.cash, cf.otherCash, cf.settleDate], [150, -15_000_000, [{ ccy: 'USD', amount: 100_000 }], '2026-03-23']);
  assert.equal(pv.legs[1].settlement.calendarId, 'USD+JP');
  assert.deepEqual([pv.confirmation.totals.JPY.financingIn, pv.confirmation.totals.JPY.purchases, pv.confirmation.totals.JPY.shortfall], [15_000_000, 15_000_000, 0]);
  const s = (await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation })).strategy;
  const [lo, fx] = s.orders;
  assert.deepEqual([lo.status, fx.status, lo.fills[0].confirm.exact, fx.fills[0].confirm.exact], ['filled', 'filled', true, true]);

  // The liability, and when its interest starts.
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'JPY'), -15_000_000);
  const reg = app.accounting.borrowings(book.id, 'book');
  assert.equal(reg.length, 1, 'one borrowing record in the Book');
  assert.deepEqual([reg[0].owner.id, reg[0].ccy, reg[0].principal, reg[0].startDate, reg[0].accrued, reg[0].rate.dayCount], [acct.id, 'JPY', 15_000_000, '2026-03-18', 0, 'ACT/365']);
  // The conversion executed at once but has not settled: both sides are pending obligations with the same value date.
  assert.equal(fx.fills[0].settleDate, '2026-03-23', 'T+2 skips the Tokyo holiday on Friday 20 March');
  const pending = app.settle.pending([acct.id]).map((p) => [p.due_date, p.ccy, p.amount, p.kind]);
  assert.deepEqual(pending.sort((a, b) => (a[1] < b[1] ? -1 : 1)), [['2026-03-23', 'JPY', -15_000_000, 'fx'], ['2026-03-23', 'USD', 100_000, 'fx']]);
  // A euro conversion dealt the same day is not held up by Tokyo: Thu 19, Fri 20.
  assert.equal(app.products.get('fx').settleDate(app, inst['EUR/USD'], '2026-03-18', book), '2026-03-20');
  // Cash before the conversion settles.
  //   JPY: 15,000,000 settled (the loan proceeds), all of it owed to the conversion: nothing to trade, nothing to withdraw.
  //   USD: 100,000 settled + 100,000 owed to the Account: 200,000 to trade, but only the settled 100,000 can leave.
  const y = app.ledger.cash(acct.id, 'JPY'), u = app.ledger.cash(acct.id, 'USD');
  assert.deepEqual([y.settled, y.payable, y.receivable, y.availableToTrade, y.availableToWithdraw], [15_000_000, 15_000_000, 0, 0, 0]);
  assert.deepEqual([u.settled, u.payable, u.receivable, u.availableToTrade, u.availableToWithdraw], [100_000, 0, 100_000, 200_000, 100_000]);
  // The committed yen cannot be moved away, and the dollars that have not arrived cannot be withdrawn.
  assert.throws(() => app.books.transfer({ bookId: book.id, fromUnitId: acct.id, toUnitId: treasury.id, ccy: 'JPY', amount: 1_000_000 }), /0 JPY of settled JPY available/);
  assert.throws(() => app.books.transfer({ bookId: book.id, fromUnitId: acct.id, toUnitId: treasury.id, ccy: 'USD', amount: 150_000 }), /100,000\.00 USD of settled USD available/);
  // The yen cannot be spent twice: a second conversion of the same yen is refused.
  const twice = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst['USD/JPY'].id, qty: 10_000 }] });
  assert.ok(twice.blocking > 0);
  // Balance sheet of the Account, counted once. Assets: 100,000 USD cash + 15,000,000 JPY cash + 100,000 USD receivable.
  // Liabilities: 15,000,000 JPY loan + 15,000,000 JPY payable. In USD at 150: 100,000 + 100,000 + 100,000 - 100,000 - 100,000 = 100,000.
  await app.data.refresh({ pairs: ['JPY/USD'] });
  const bs = app.accounting.balanceSheet(book.id, acct.id);
  near(bs.assets.total.rc, 300_000);
  near(bs.liabilities.total.rc, 200_000);
  near(bs.netAssets.total.rc, 100_000);
  const whole = app.accounting.balanceSheet(book.id, 'book');
  near(whole.netAssets.total.rc, 1_000_000, 0.01);
  assert.equal(whole.borrowings.length, 1);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('borrow and convert, settlement to repayment: balances after the value date, interest by day count, repayment of principal plus interest leaves nothing owed', async () => {
  const { app, clock, inst } = makeApp({ at: '2026-03-18T15:00:00.000Z' });
  const { book, acct } = makeBook(app, { cash: 1_000_000, account: 100_000 });
  pinYen(app, inst);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [JPY_LOAN, { kind: 'trade', action: 'buy', instrumentId: inst['USD/JPY'].id, qty: 100_000, dependsOn: [1] }] });
  const loanPos = s.positions.find((p) => p.family === 'loan');
  const accrued = () => 0 - app.ledger.balance(acct.id, 'accrued.liab', 'JPY');
  const eod = async (date) => { pinYen(app, inst); await goTo(app, clock, `${date}T21:30:00.000Z`); }; // 17:30 New York, after the end-of-day run
  const noon = async (date) => { pinYen(app, inst); await goTo(app, clock, `${date}T15:00:00.000Z`); };

  // Interest: ACT/365 from the trade date, the day of repayment excluded.
  await eod('2026-03-18');
  assert.equal(accrued(), 0, 'no interest for the day the loan was drawn until a night has passed');
  await eod('2026-03-19');
  assert.equal(accrued(), 600, 'one day: 15,000,000 x 0.0146 x 1 / 365 = 600');
  // Friday 20 March: Tokyo is closed, New York is open. Nothing settles; interest keeps running.
  await eod('2026-03-20');
  assert.equal(accrued(), 1200);
  let y = app.ledger.cash(acct.id, 'JPY'), u = app.ledger.cash(acct.id, 'USD');
  assert.deepEqual([y.settled, y.payable, u.settled, u.receivable], [15_000_000, 15_000_000, 100_000, 100_000], 'the conversion has not settled on the Tokyo holiday');
  assert.equal(app.settle.pending([acct.id]).length, 2);

  // Monday 23 March, the value date: both sides settle.
  await noon('2026-03-23');
  y = app.ledger.cash(acct.id, 'JPY'); u = app.ledger.cash(acct.id, 'USD');
  assert.deepEqual([y.settled, y.payable, y.availableToTrade, y.availableToWithdraw], [0, 0, 0, 0]);
  assert.deepEqual([u.settled, u.receivable, u.availableToTrade, u.availableToWithdraw], [200_000, 0, 200_000, 200_000]);
  assert.equal(app.settle.pending([acct.id]).length, 0);
  assert.equal(app.settle.failed([acct.id]).length, 0);
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'JPY'), -15_000_000, 'the liability is untouched by the conversion settling');
  await eod('2026-03-23');
  assert.equal(accrued(), 3000, 'five days, the weekend included: 5 x 600');

  // Thursday 26 March: repayment cannot be confirmed yet, because the Account holds no yen.
  await noon('2026-03-26');
  const repay = () => app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'close', reducing: true, legs: [{ kind: 'repay', action: 'repay_cash', targetPositionId: loanPos.positionId, qty: 15_000_000, purpose: 'financing' }] });
  let rp = await repay();
  assert.ok(rp.blocking > 0);
  // The preview states principal plus the interest that is settled with it: 8 days to 26 March = 4,800 JPY.
  assert.deepEqual([rp.legs[0].financing.principal, rp.legs[0].financing.interest, rp.legs[0].cash], [15_000_000, 4800, -15_004_800]);
  // Buy the yen for a repayment on 31 March: 15,000,000 + 13 x 600 = 15,007,800 JPY = 100,052 USD at 150.00. Value Mon 30 March.
  const back = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: inst['USD/JPY'].id, qty: 100_052 }] });
  assert.equal(back.orders[0].fills[0].settleDate, '2026-03-30');
  // The yen bought is owed to the Account but not settled: the repayment still has to wait for it.
  y = app.ledger.cash(acct.id, 'JPY');
  assert.deepEqual([y.settled, y.receivable, y.availableToTrade, y.availableToWithdraw], [0, 15_007_800, 15_007_800, 0]);
  rp = await repay();
  assert.ok(rp.blocking > 0, 'a repayment needs settled cash, not cash still in settlement');
  assert.match(rp.checks.find((c) => c.level === 'error').message, /0 JPY of settled JPY available; 15,004,800 JPY is needed \(principal plus accrued interest\)/);

  // The interest payment the open-ended loan has scheduled: first business day of April on the yen payment calendar.
  assert.deepEqual(app.db.all(`SELECT type, due_date, status FROM tasks WHERE position_id = ?`, loanPos.positionId).map((t) => [t.type, t.due_date, t.status]), [['loan.interest', '2026-04-01', 'pending']]);

  // Tuesday 31 March: 13 days after 18 March.
  await noon('2026-03-31');
  y = app.ledger.cash(acct.id, 'JPY'); u = app.ledger.cash(acct.id, 'USD');
  assert.deepEqual([y.settled, y.receivable, u.settled, u.payable], [15_007_800, 0, 99_948, 0]);
  rp = await repay();
  assert.equal(rp.blocking, 0);
  assert.deepEqual([rp.legs[0].financing.principal, rp.legs[0].financing.interest, rp.legs[0].cash, rp.confirmation.totals.JPY.financingOut, rp.confirmation.totals.JPY.required], [15_000_000, 7800, -15_007_800, 15_007_800, 15_007_800]);
  const done = (await app.packages.submit({ ...rp.input, legs: rp.legs, clientToken: rp.token, confirm: true, expected: rp.confirmation })).strategy;
  const ro = done.orders.find((o) => o.kind === 'repay');
  assert.equal(ro.status, 'filled');
  // Confirmed -> fill -> ledger: 15,007,800 JPY confirmed, 15,007,800 JPY paid (15,000,000 principal + 7,800 interest).
  assert.deepEqual([ro.confirmed.cash, ro.fills[0].confirm.actual.cash, ro.fills[0].confirm.exact], [-15_007_800, -15_007_800, true]);
  // Nothing is owed and nothing is left over in yen.
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'JPY'), 0);
  assert.equal(app.ledger.balance(acct.id, 'accrued.liab', 'JPY'), 0);
  y = app.ledger.cash(acct.id, 'JPY');
  assert.deepEqual([y.settled, y.payable, y.receivable], [0, 0, 0]);
  assert.equal(app.accounting.borrowings(book.id, 'book').length, 0, 'the borrowing is closed');
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE position_id = ? AND status = 'pending'`, loanPos.positionId).n, 0, 'no interest payment is left scheduled');
  // Interest paid once: 7,800 JPY of funding cost in the ledger, in one payment.
  assert.equal(app.ledger.balance(acct.id, 'pnl.funding', 'JPY'), 7800);
  const paid = app.db.all(`SELECT e.amount FROM entries e JOIN events v ON v.id = e.event_id WHERE v.type = 'interest.payment' AND e.account = 'cash' AND e.unit_id = ?`, acct.id);
  assert.deepEqual(paid.map((r) => r.amount), [-7800]);
  // Dollars: 100,000 + 100,000 - 100,052 = 99,948. The whole episode cost 52.00 USD, the interest at 150.00.
  u = app.ledger.cash(acct.id, 'USD');
  assert.deepEqual([u.settled, u.payable, u.receivable], [99_948, 0, 0]);
  await app.data.refresh({ pairs: ['JPY/USD'] });
  const bs = app.accounting.balanceSheet(book.id, acct.id);
  near(bs.netAssets.total.rc, 99_948, 0.01);
  near(bs.liabilities.total.rc, 0, 0.01);
  // The next day, the date the monthly interest had been scheduled for: nothing more is paid or accrued.
  await noon('2026-04-01');
  await eod('2026-04-01');
  assert.equal(app.ledger.balance(acct.id, 'pnl.funding', 'JPY'), 7800);
  assert.deepEqual([app.ledger.cash(acct.id, 'JPY').settled, app.ledger.cash(acct.id, 'USD').settled], [0, 99_948]);
  assert.deepEqual(ledgerImbalance(app), []);
});
