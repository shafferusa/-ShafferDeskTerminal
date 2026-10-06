import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo } from '../helpers.js';

const near = (a, b, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const rate = (app, code, date, value) => app.data.enterManual({ kind: 'rate', subject: code, value, forDate: date, units: 'percent p.a.' });

test('interest-rate swap: full contract terms, fixed and floating payments from fixings, never "buy/sell swap"', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = {
    productId: 'interest_rate_swap', name: 'USD IRS 4.00% vs TEST-3M 2026-03-02/2027-03-02', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer A', collateral: 'CSA, daily, zero threshold', legs: [
      { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' },
      { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', spread: 0.001, months: 3, dayCount: 'ACT/360' },
    ] },
  };
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 10_000_000, statedPrice: 0, contract }] });
  const details = Object.fromEntries(pv.legs[0].instrument.details);
  assert.match(details['Leg A'], /Pay fixed 4\.000% USD, every 6 months, 30\/360/);
  assert.match(details['Leg B'], /Receive TEST-3M \+ 0\.10% USD, every 3 months, ACT\/360/);
  assert.equal(details.Counterparty, 'Dealer A');
  assert.equal(details['Collateral terms'], 'CSA, daily, zero threshold');
  assert.equal(pv.legs[0].notional, 10_000_000);
  assert.equal(pv.legs[0].cash, 0, 'notional is not paid');
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', legs: pv.legs, clientToken: pv.token, confirm: true });
  const s = r.strategy;
  assert.equal(s.positions[0].direction, 'as written');
  assert.equal(s.positions[0].mv, null, 'no NPV mark is available, so the value is missing rather than zero');
  // First floating payment (2 Mar - 2 Jun) is blocked until its fixing exists.
  await goTo(app, clock, '2026-06-02T15:00:00.000Z');
  let t = app.accounting.pending(book.id, acct.id).lifecycle.find((x) => x.type === 'swap.payment' && x.data.legId === 'B');
  assert.equal(t.status, 'blocked');
  assert.match(t.reason, /TEST-3M fixing for 2026-03-02/);
  rate(app, 'TEST-3M', '2026-03-02', 4.4);
  await advance(app, clock, 1000);
  near(app.ledger.cash(acct.id, 'USD').settled, 500_000 + 10_000_000 * 0.045 * 92 / 360);
  // Fixed payment at six months; second floating payment needs the June fixing.
  rate(app, 'TEST-3M', '2026-06-02', 4.2);
  await goTo(app, clock, '2026-09-02T15:00:00.000Z');
  near(app.ledger.cash(acct.id, 'USD').settled, 500_000 + 115_000 + 10_000_000 * 0.043 * 92 / 360 - 200_000);
  const ev = app.accounting.history(book.id, acct.id).events.filter((e) => e.type === 'swap.payment');
  assert.equal(ev.length, 3);
  assert.ok(ev[0].data.obsIds.length || ev[1].data.obsIds.length, 'fixings used are preserved');
  // A manual NPV mark values the position, labelled as manual.
  app.data.enterManual({ kind: 'price', subject: s.positions[0].instrument.id, value: 0.35, units: 'NPV per 100 notional' });
  const p = app.accounting.openPositions(book.id, acct.id).positions[0];
  assert.equal(p.mv, 35_000);
  assert.equal(p.priceObs.status, 'manual');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('total-return swap: return leg against financing leg, dividends passed through', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = {
    productId: 'equity_trs', name: 'TRS ALFA', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', underlyingId: inst.ALFA.id,
    terms: { effective: '2026-03-02', maturity: '2026-09-02', initialPrices: { A: 200 }, legs: [
      { id: 'A', side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: inst.ALFA.id, passDividends: true },
      { id: 'B', side: 'pay', type: 'float', ccy: 'USD', index: 'SIM-ON', spread: 0.005, months: 3, dayCount: 'ACT/360' },
    ] },
  };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, statedPrice: 0, contract }] });
  // Dividend of 0.55 on 5,000 reference shares (1,000,000 / 200).
  app.corpactions.record({ instrumentId: inst.ALFA.id, type: 'cash_dividend', exDate: '2026-03-16', amount: 0.55 });
  await goTo(app, clock, '2026-03-16T15:00:00.000Z');
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 500_000 + 2750);
  app.data.market.set(`${inst.ALFA.id}@2026-06-02`, { value: 210 });
  app.data.market.set('SIM-ON@2026-03-02', { value: 4.0 });
  await goTo(app, clock, '2026-06-02T22:30:00.000Z');
  // Return +5% on 1,000,000 = +50,000; financing 4.5% x 92/360 = -11,500.
  // The demo feed also supplies ALFA's own 15 May dividend, which is passed through as well.
  near(app.ledger.cash(acct.id, 'USD').settled, 500_000 + 2750 + 2750 + 50_000 - 11_500);
  const div = app.accounting.history(book.id, acct.id).events.filter((e) => e.type === 'swap.dividend');
  assert.equal(div.length, 2);
  assert.equal(app.positions.get(s.positions[0].positionId).data.legs.A.lastFixing, 210, 'the next period starts from the reset level');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('credit default swap: quarterly premiums, then a credit event with stated recovery', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = { productId: 'cds_single_name', name: 'CDS Acme 5Y', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { referenceEntity: 'Acme Corp', coupon: 0.01, effective: '2026-03-02', maturity: '2031-03-20', recovery: 0.4 } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 5_000_000, statedPrice: 1.5, contract }] });
  assert.equal(s.positions[0].direction, 'protection bought');
  await goTo(app, clock, '2026-03-20T15:00:00.000Z');
  // Upfront 1.5% = 75,000 paid at settlement; premium for 2-20 March = 5,000,000 x 1% x 18/360.
  near(app.ledger.cash(acct.id, 'USD').settled, 500_000 - 75_000 - 2500);
  app.db.tx(() => app.products.get('cds').creditEvent(app, { inst: app.instruments.get(s.positions[0].instrument.id), recovery: 0.25 }));
  // Protection 5,000,000 x 75% = 3,750,000; no premium accrued since the same day's coupon.
  near(app.ledger.cash(acct.id, 'USD').settled, 500_000 - 75_000 - 2500 + 3_750_000);
  app.packages.refreshStrategy(s.id);
  assert.equal(app.packages.strategyView(s.id).status, 'closed');
  const pnl = app.accounting.pnl(book.id, acct.id);
  near(pnl.investmentPnl, 3_750_000 - 75_000 - 2500);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('FX forward delivers both currencies on the value date; an NDF cash-settles against its fixing', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const fwd = { productId: 'fx_forward', name: 'EUR/USD fwd 2026-04-02', marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { forwardType: 'fx', base: 'EUR', quote: 'USD', valueDate: '2026-04-02', counterparty: 'Dealer B' } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 100_000, statedPrice: 1.09, contract: fwd }] });
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 500_000, 'no cash at trade');
  await goTo(app, clock, '2026-04-02T15:00:00.000Z');
  assert.equal(app.ledger.cash(acct.id, 'EUR').settled, 100_000);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 500_000 - 109_000);
  assert.equal(app.packages.strategyView(s.id).status, 'closed');
  // NDF: sell 1,000,000 USD/JPY at 150, fixing 155 -> short USD loses 5 JPY per USD, settled in JPY.
  const ndf = { productId: 'ndf', name: 'USD/JPY NDF 2026-05-01', marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: 'JPY', underlyingId: inst['USD/JPY'].id, terms: { forwardType: 'ndf', base: 'USD', quote: 'JPY', valueDate: '2026-05-01', fixingDate: '2026-04-29', settleCcy: 'JPY' } };
  const n = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', qty: 1_000_000, statedPrice: 150, contract: ndf }] });
  app.data.market.set(`${inst['USD/JPY'].id}@2026-04-29`, { value: 155 });
  await goTo(app, clock, '2026-04-29T22:30:00.000Z');
  assert.equal(app.ledger.cash(acct.id, 'JPY').payable, 5_000_000, 'fixed on the fixing date, payable on the value date');
  await goTo(app, clock, '2026-05-01T15:00:00.000Z');
  // No JPY is held: the payment fails rather than overdrawing.
  assert.equal(app.accounting.failed(book.id, acct.id).settlementFailures.length, 1);
  assert.equal(app.ledger.cash(acct.id, 'JPY').settled, 0);
  assert.equal(app.packages.strategyView(n.id).positions.length, 0);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('OTC digital option pays its fixed amount; an exotic waits for a manual settlement amount', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const dig = { productId: 'digital_option', name: 'ALFA digital call 200', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', underlyingId: inst.ALFA.id, terms: { right: 'C', strike: 200, expiration: '2026-03-20', optionType: 'digital', payout: 10 } };
  const asian = { productId: 'asian_option', name: 'ALFA asian call', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', underlyingId: inst.ALFA.id, terms: { right: 'C', strike: 190, expiration: '2026-03-20', optionType: 'asian', settlement: 'cash' } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1000, statedPrice: 3, contract: dig }, { kind: 'trade', action: 'buy', qty: 1000, statedPrice: 5, contract: asian }] });
  app.data.market.set(`${inst.ALFA.id}@2026-03-20`, { value: 201 });
  await goTo(app, clock, '2026-03-20T22:30:00.000Z');
  const tasks = app.accounting.pending(book.id, acct.id).lifecycle;
  const blocked = tasks.find((t) => t.type === 'option.expiry' && t.status === 'blocked');
  assert.match(blocked.reason, /Enter the settlement amount for this asian option/);
  await goTo(app, clock, '2026-03-23T15:00:00.000Z');
  near(app.ledger.cash(acct.id, 'USD').settled, 500_000 - 3000 - 5000 + 10_000, 0.01);
  const t = app.tasks.get(blocked.id);
  app.tasks.setData(t.id, { ...t.data, manualAmount: 7500 });
  await advance(app, clock, 1000);
  await goTo(app, clock, '2026-03-24T15:00:00.000Z');
  near(app.ledger.cash(acct.id, 'USD').settled, 500_000 - 8000 + 10_000 + 7500, 0.01);
  assert.equal(app.packages.strategyView(s.id).status, 'closed');
  assert.deepEqual(ledgerImbalance(app), []);
});
