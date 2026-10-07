// Rate swaps: regression tests for the cash-flow, fixing and principal-exchange rules of server/products/swap.js.
// Every expected figure is worked out by hand in the comment beside it. The scenarios of test/matrix/specs/swap-rates.mjs
// exercise the same rules through the interface; these pin each rule down on its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo } from '../helpers.js';

const rate = (app, code, date, value) => app.data.enterManual({ kind: 'rate', subject: code, value, forDate: date, units: 'percent p.a.' });
const NO_COLLATERAL = { collateralBasis: { type: 'uncollateralized' } };
const cash = (app, unit, ccy = 'USD') => app.ledger.cash(unit.id, ccy).settled;
const tasks = (app, type) => app.db.all('SELECT type, status, due_date, blocked_reason FROM tasks WHERE type = ? ORDER BY due_date, created_at', type);
const open = (app, type) => tasks(app, type).filter((t) => ['pending', 'blocked', 'failed'].includes(t.status));
const summaries = (app, book, unit, type) => app.accounting.history(book.id, unit.id).events.filter((e) => e.type === type).map((e) => e.summary);
const NY10 = (date) => `${date}T${date >= '2026-03-08' && date < '2026-11-01' ? '14' : '15'}:00:00.000Z`; // 10:00 New York

test('floating leg: only the fixing of the fixing date counts, an exact half cent rounds up, and the record never says "bought"', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = {
    productId: 'interest_rate_swap', name: 'IRS fixing dates', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-05', maturity: '2027-03-05', ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 0, dayCount: '30/360' },
      { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360' },
    ] },
  };
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 81_590, statedPrice: 0, contract }] });
  assert.deepEqual(summaries(app, book, acct, 'trade.fill'), ['Entered as written: 81,590 notional of IRS fixing dates at 0.00 per 100 notional']);

  // A fixing three days older than the period start exists. It is not the fixing of 5 March and is not used.
  rate(app, 'TEST-3M', '2026-03-02', 9.99);
  await goTo(app, clock, NY10('2026-06-05'));
  assert.match(open(app, 'swap.payment')[0].blocked_reason, /Awaiting the TEST-3M fixing for 2026-03-05/);
  assert.equal(cash(app, acct), 500_000, 'nothing is paid on a rate that is not the fixing');
  // 81,590 x 4.50% x 92/360 = 938.285 exactly: half a cent, which rounds up to 938.29.
  rate(app, 'TEST-3M', '2026-03-05', 4.5);
  await advance(app, clock, 1000);
  assert.equal(cash(app, acct), 500_938.29);

  // Second period, fixing of Friday 5 June: 81,590 x 4.00% x 92/360 = 834.03. 5 September is a Saturday and the 7th Labor Day: paid Tuesday the 8th.
  rate(app, 'TEST-3M', '2026-06-05', 4.0);
  assert.equal(open(app, 'swap.payment')[0].due_date, '2026-09-08');
  await goTo(app, clock, NY10('2026-09-08'));
  assert.equal(cash(app, acct), 501_772.32);

  // Third period starts on Saturday 5 September: its fixing is Friday the 4th. Thursday's does not do.
  rate(app, 'TEST-3M', '2026-09-03', 9.99);
  await goTo(app, clock, NY10('2026-12-07'));
  assert.match(open(app, 'swap.payment')[0].blocked_reason, /Awaiting the TEST-3M fixing for 2026-09-04/);
  // 81,590 x 3.00% x 91/360 = 618.72.
  rate(app, 'TEST-3M', '2026-09-04', 3.0);
  await advance(app, clock, 1000);
  assert.equal(cash(app, acct), 502_391.04);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('overnight-index leg: an ACT/365 leg compounds on 365, a Friday fixing covers three days, and a missing day blocks', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = {
    productId: 'ois', name: 'OIS five days', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-12', maturity: '2026-03-17', ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.03, months: 0, dayCount: 'ACT/365' },
      { id: 'B', side: 'receive', type: 'ois', ccy: 'USD', index: 'TEST-ON', spread: 0, months: 0, dayCount: 'ACT/365' },
    ] },
  };
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 10_000_000, statedPrice: 0, contract }] });
  rate(app, 'TEST-ON', '2026-03-12', 3.65); // Thursday, 1 day
  rate(app, 'TEST-ON', '2026-03-16', 3.65); // Monday, 1 day; Friday the 13th (3 days) is missing
  await goTo(app, clock, NY10('2026-03-17'));
  // Fixed, paid: 10,000,000 x 3.00% x 5/365 = 4,109.59.
  assert.equal(cash(app, acct), 500_000 - 4_109.59);
  assert.match(open(app, 'swap.payment')[0].blocked_reason, /Awaiting the TEST-ON fixing for 2026-03-13/);
  rate(app, 'TEST-ON', '2026-03-13', 3.65);
  await advance(app, clock, 1000);
  // (1 + 0.0365/365) x (1 + 3 x 0.0365/365) x (1 + 0.0365/365) = 1.0001 x 1.0003 x 1.0001 = 1.000500070003: 5,000.70.
  // On a 360 basis it would have been 5,070.20.
  assert.equal(cash(app, acct), 500_000 - 4_109.59 + 5_000.70);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('cap: a caplet that is not in the money is recorded as nothing due, and the next one is scheduled', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = {
    productId: 'interest_rate_cap', name: 'Cap 4%', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-05', maturity: '2027-03-05', ...NO_COLLATERAL, legs: [{ id: 'A', side: 'receive', type: 'cap', ccy: 'USD', index: 'TEST-3M', strike: 0.04, months: 3, dayCount: 'ACT/360' }] },
  };
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, statedPrice: 0.25, contract }] });
  rate(app, 'TEST-3M', '2026-03-05', 3.5);
  rate(app, 'TEST-3M', '2026-06-05', 5.0);
  await goTo(app, clock, NY10('2026-06-05'));
  assert.deepEqual(summaries(app, book, acct, 'swap.payment'), ['Nothing due on Cap 4%, leg A (cap), period 2026-03-05 to 2026-06-05: the TEST-3M fixing 3.500% is not above the strike 4.000%']);
  assert.equal(cash(app, acct), 500_000 - 2_500, 'only the premium has moved: 1,000,000 x 0.25 / 100');
  assert.equal(open(app, 'swap.payment')[0].due_date, '2026-09-08');
  await goTo(app, clock, NY10('2026-09-08'));
  // 1,000,000 x (5.00% - 4.00%) x 92/360 = 2,555.56.
  assert.equal(cash(app, acct), 500_000 - 2_500 + 2_555.56);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('cross-currency swap: principal is exchanged in both currencies or not at all, never from cash that is not there, and with the settlement of a later change', async () => {
  const { app, clock } = makeApp();
  const { book, acct, treasury } = makeBook(app, { cash: 3_000_000, account: 500_000 });
  const contract = {
    productId: 'cross_currency_swap', name: 'XCCY principal', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'DE', tradingCcy: 'EUR',
    terms: { effective: '2026-03-09', maturity: '2027-03-09', ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'pay', type: 'fixed', ccy: 'EUR', rate: 0.02, months: 12, dayCount: '30/360', exchangeNotional: true },
      { id: 'B', side: 'receive', type: 'fixed', ccy: 'USD', rate: 0.04, months: 12, dayCount: '30/360', notionalFactor: 1.1, exchangeNotional: true },
    ] },
  };
  // Agreed a week before the start: the principal is announced, not required today.
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, statedPrice: 0, contract }] });
  assert.equal(pv.blocking, 0);
  assert.deepEqual(pv.legs[0].otherCash, []);
  assert.ok(pv.legs[0].econNotes.some((n) => /Principal is exchanged on the effective date 2026-03-09: receive 1,000,000\.00 EUR, pay 1,100,000\.00 USD/.test(n) && /Alpha has 500,000\.00 USD of settled USD cash today/.test(n)), pv.legs[0].econNotes.join(' | '));
  const s = (await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', legs: pv.legs, clientToken: pv.token, confirm: true })).strategy;

  // The effective date: 1,100,000 USD is to be paid and the Account has 500,000. Nothing moves in either currency.
  await goTo(app, clock, NY10('2026-03-09'));
  assert.equal(cash(app, acct, 'USD'), 500_000, 'cash is never taken below zero');
  assert.equal(cash(app, acct, 'EUR'), 0, 'the euros are not received while the dollars cannot be paid');
  const failed = tasks(app, 'swap.notional')[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.blocked_reason, /Notional exchange on XCCY principal could not be made: 1,100,000\.00 USD is to be paid and Alpha has 500,000\.00 USD of settled USD cash\. Nothing was exchanged in either currency\./);
  assert.ok(app.alerts.open(book.id).some((a) => a.code === 'funding.failed'));

  // Funded: the exchange is made on the next pass. 500,000 + 700,000 - 1,100,000 = 100,000 USD; 1,000,000 EUR received and owed.
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: acct.id, ccy: 'USD', amount: 700_000, purpose: 'principal' });
  await advance(app, clock, 1000);
  assert.equal(cash(app, acct, 'USD'), 100_000);
  assert.equal(cash(app, acct, 'EUR'), 1_000_000);
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'EUR'), -1_000_000, 'the euro principal is owed back');
  assert.equal(app.ledger.balance(acct.id, 'loan.asset', 'USD'), 1_100_000, 'the dollar principal is owed to the Account');
  assert.ok(!app.alerts.open(book.id).some((a) => a.code === 'funding.failed'));

  // Doubling the swap while it runs would exchange another 1,100,000 USD at settlement: the Account has 100,000 and the trade is refused.
  const more = await app.packages.previewAction(s.id, 'resize', { factor: 2 });
  assert.ok(more.blocking > 0);
  assert.match(more.checks.find((c) => c.level === 'error').message, /Alpha is short 1,000,000\.00 USD/);

  // Half is terminated on Monday 1 June (settles Wednesday 3 June on TARGET). Its principal goes back on the 3rd, not today.
  await goTo(app, clock, NY10('2026-06-01'));
  const half = await app.packages.previewAction(s.id, 'close', { fraction: 0.5 });
  assert.deepEqual(half.legs[0].otherCash, [{ ccy: 'EUR', amount: -500_000 }, { ccy: 'USD', amount: 550_000 }]);
  await app.packages.submit({ ...half.input, legs: half.legs.map((l) => ({ ...l, statedPrice: 0 })), clientToken: half.token, confirm: true });
  assert.equal(cash(app, acct, 'EUR'), 1_000_000, 'no principal moves on the trade date');
  await goTo(app, clock, NY10('2026-06-03'));
  assert.equal(cash(app, acct, 'EUR'), 500_000);
  assert.equal(cash(app, acct, 'USD'), 650_000);

  // The rest is terminated on the 3rd (settles Friday the 5th). The position is then flat, and its principal still goes back on the 5th.
  const rest = await app.packages.previewAction(s.id, 'close', { fraction: 1 });
  await app.packages.submit({ ...rest.input, legs: rest.legs.map((l) => ({ ...l, statedPrice: 0 })), clientToken: rest.token, confirm: true });
  assert.equal(cash(app, acct, 'EUR'), 500_000);
  await goTo(app, clock, NY10('2026-06-05'));
  assert.equal(cash(app, acct, 'EUR'), 0);
  assert.equal(cash(app, acct, 'USD'), 1_200_000); // 500,000 + 700,000: the principal was never profit or loss
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'EUR'), 0);
  assert.equal(app.ledger.balance(acct.id, 'loan.asset', 'USD'), 0);
  assert.deepEqual(open(app, 'swap.notional'), []);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a swap keeps the trading currency its contract states when a leg is in it, and refuses one that no leg has', () => {
  const { app } = makeApp();
  const draft = (tradingCcy) => ({
    productId: 'cross_currency_basis_swap', name: `USD/JPY basis ${tradingCcy}`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy,
    terms: { effective: '2026-03-23', maturity: '2027-03-23', ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'pay', type: 'float', ccy: 'JPY', index: 'TORF3M', spread: -0.0035, months: 3, dayCount: 'ACT/365', notionalFactor: 150, exchangeNotional: true },
      { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0, months: 3, dayCount: 'ACT/360', exchangeNotional: true },
    ] },
  });
  // Stated in dollars with the yen leg written first: quantity and price stay in dollars (they used to become yen, silently).
  assert.equal(app.instruments.create(draft('USD')).trading_ccy, 'USD');
  assert.equal(app.instruments.create(draft('JPY')).trading_ccy, 'JPY');
  assert.throws(() => app.instruments.create(draft('GBP')), /The trading currency GBP is not the currency of any leg \(JPY, USD\)/);
});

test('zero-coupon fixed leg: compounded annually when the contract says so; compounding is refused on a leg that pays periodically', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const legs = (extra) => [
    { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.025, months: 0, dayCount: '30/360', compounding: 'annual', ...extra },
    { id: 'B', side: 'receive', type: 'fixed', ccy: 'USD', rate: 0.025, months: 0, dayCount: '30/360' },
  ];
  const contract = { productId: 'interest_rate_swap', name: 'Compounded v simple', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { effective: '2026-03-09', maturity: '2028-03-09', ...NO_COLLATERAL, legs: legs() } };
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 8_000_000, statedPrice: 0, contract }] });
  assert.match(Object.fromEntries(pv.legs[0].instrument.details)['Leg A'], /Pay fixed 2\.500% USD, compounded annually, at maturity, 30\/360/);
  await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', legs: pv.legs, clientToken: pv.token, confirm: true });
  await goTo(app, clock, NY10('2028-03-09'));
  await advance(app, clock, 1000);
  // Paid, compounded: 8,000,000 x (1.025^2 - 1) = 8,000,000 x 0.050625 = 405,000.00. Received, simple: 8,000,000 x 2.5% x 2 = 400,000.00.
  assert.equal(cash(app, acct), 500_000 - 405_000 + 400_000);
  assert.throws(() => app.instruments.create({ ...contract, name: 'Compounded semi-annual', terms: { ...contract.terms, legs: legs({ months: 6 }) } }), /compounding applies to a fixed leg paid once, at maturity/);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('return leg: the fixing a period starts from is asked of the data service, and a boundary on a weekend takes the last business day before it', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  // A reference index with no data of its own: only the closes supplied below exist for it.
  const index = app.instruments.create({ productId: 'physical_commodity', name: 'Reference index', symbol: 'REFIX', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: {} });
  const contract = {
    productId: 'equity_index_swap', name: 'Index return v fixed', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-05', maturity: '2026-09-05', ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: index.id },
      { id: 'B', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 3, dayCount: '30/360' },
    ] },
  };
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, statedPrice: 0, contract }] });
  app.data.market.set(`${index.id}@2026-03-05`, { value: 200 });
  app.data.market.set(`${index.id}@2026-06-05`, { value: 210 });
  app.data.market.set(`${index.id}@2026-09-04`, { value: 199.5 }); // Friday: 5 September, the period end, is a Saturday
  // After the close of 5 June. Return: 1,000,000 x (210 / 200 - 1) = +50,000. Fixed: 1,000,000 x 4% x 90/360 = -10,000.
  await goTo(app, clock, '2026-06-05T22:30:00.000Z');
  assert.equal(cash(app, acct), 500_000 + 50_000 - 10_000, 'the first period is paid from supplied closes: its start fixing was asked for');
  // Tuesday 8 September (Monday is Labor Day). Return: 1,000,000 x (199.5 / 210 - 1) = -50,000, on Friday's close. Fixed: -10,000.
  await goTo(app, clock, NY10('2026-09-08'));
  await advance(app, clock, 1000);
  assert.equal(cash(app, acct), 540_000 - 50_000 - 10_000);
  assert.deepEqual(open(app, 'swap.payment'), []);
  assert.deepEqual(ledgerImbalance(app), []);
});
