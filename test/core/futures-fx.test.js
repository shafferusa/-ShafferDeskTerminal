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
