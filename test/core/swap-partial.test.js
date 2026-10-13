// The swaps the catalog marks partial: regression tests for the rules of server/products/swap-partial.js (s3). Every
// expected figure is worked out by hand in the comment beside it. The scenarios of test/matrix/specs/swap-partial.mjs
// exercise the same rules through the interface.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';
import { createApi } from '../../server/api.js';
import { setBasketLevel } from '../../server/products/swap-partial.js';

const rate = (app, code, date, value) => app.data.enterManual({ kind: 'rate', subject: code, value, forDate: date, units: 'percent p.a.' });
const close = (app, inst, date, value) => app.data.enterManual({ kind: 'price', subject: inst.id, value, forDate: date, currency: inst.trading_ccy, units: 'per unit' });
const NO_COLLATERAL = { collateralBasis: { type: 'uncollateralized' } };
const cash = (app, unit, ccy = 'USD') => app.ledger.cash(unit.id, ccy).settled;
const NY10 = (date) => `${date}T${date >= '2026-03-08' && date < '2026-11-01' ? '14' : '15'}:00:00.000Z`; // 10:00 New York
const leg = (contract, qty, action = 'buy') => ({ kind: 'trade', action, qty, statedPrice: 0, contract });

async function lifecycle(app, positionId, body) {
  const api = createApi(app);
  const m = api.match('POST', `/api/positions/${positionId}/lifecycle`);
  try { await m.handler({ params: m.params, query: {}, body }); return null; } catch (e) { return e.message; }
}

const callable = (productId, right) => ({
  productId, name: `${productId} test`, symbol: productId === 'callable_swap' ? 'CALLT' : 'PUTT', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
  terms: { effective: '2026-03-04', maturity: '2029-03-04', ...NO_COLLATERAL, callRight: right, legs: [
    { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 12, dayCount: '30/360' },
    { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', months: 3, dayCount: 'ACT/360' },
  ] },
});

test('callable and puttable swaps: the right follows the product (the registry form sends no kind)', () => {
  const { app } = makeApp();
  const put = app.instruments.create(callable('puttable_swap', { by: 'opposite', dates: '2027-03-04' }));
  assert.deepEqual(put.terms.callRight, { kind: 'put', by: 'opposite', dates: ['2027-03-04'] });
  const call = app.instruments.create(callable('callable_swap', { kind: 'put', by: 'written', dates: '2028-03-06; 2027-03-04' }));
  assert.deepEqual(call.terms.callRight, { kind: 'call', by: 'written', dates: ['2027-03-04', '2028-03-06'] });
  assert.throws(() => app.instruments.create(callable('callable_swap', { by: 'written', dates: '2030-01-02' })), /Every call date falls after the effective date and before maturity/);
});

test('call exercised by hand: refused off its dates and for the side without the right; on a date it settles each leg accrued and ends the swap', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(callable('callable_swap', { by: 'written', dates: '2026-05-04; 2026-11-04' }), 1_000_000)] });
  const p = s.positions[0];
  rate(app, 'TEST-3M', '2026-03-04', 5.0);
  await goTo(app, clock, NY10('2026-05-01'));
  assert.equal(await lifecycle(app, p.positionId, { action: 'call_exercise', by: 'us' }), 'CALLT can be called only on its call dates (2026-05-04, 2026-11-04); today is 2026-05-01.');
  await goTo(app, clock, NY10('2026-05-04'));
  assert.equal(await lifecycle(app, p.positionId, { action: 'call_exercise', by: 'counterparty' }), 'The call on CALLT belongs to this position: the counterparty cannot exercise it. Record our own exercise instead.');
  const before = cash(app, acct);
  assert.equal(await lifecycle(app, p.positionId, { action: 'call_exercise', by: 'us' }), null);
  // Fixed 4 March to 4 May (60 days of 30/360): 1,000,000 x 4% x 60/360 = 6,666.67 paid; float (61 days) at 5%:
  // 1,000,000 x 5% x 61/360 = 8,472.22 received; net 1,805.55.
  assert.equal(Number((cash(app, acct) - before).toFixed(2)), 1_805.55);
  assert.equal(app.positions.get(p.positionId).qty, 0);
  assert.equal(app.tasks.open([acct.id]).filter((t) => t.position_id === p.positionId).length, 0, 'nothing is scheduled afterwards');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('loan TRS: a repayment passed through in the first period runs from the close of the effective date, with the financing accrued on it', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const loan = app.instruments.create({ productId: 'leveraged_loan', name: 'Test Term Loan B', symbol: 'TLB-T', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', multiplier: 0.01,
    terms: { couponType: 'float', referenceRate: 'TSOFR3M', spread: 0.0325, currentCoupon: 0.074, frequency: 4, maturity: '2031-01-15', issueDate: '2024-01-15', dayCount: 'ACT/360', redemption: 100, factor: 1, minDenomination: 1_000 } });
  const contract = { productId: 'loan_trs', name: 'Loan TRS test', symbol: 'LTRS-T', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-04', maturity: '2027-03-04', ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: loan.id },
      { id: 'B', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.036, months: 3, dayCount: 'ACT/360' },
    ] } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(contract, 1_000_000)] });
  const p = s.positions[0];
  close(app, loan, '2026-03-04', 95);
  await goTo(app, clock, NY10('2026-04-03'));
  const before = cash(app, acct);
  assert.equal(await lifecycle(app, p.positionId, { action: 'pass_through', kind: 'principal', share: 0.5, price: 100 }), null);
  // 500,000 repaid at 100 against 95: 500,000 x (100 / 95 - 1) = 26,315.79 received; its financing 4 March to 3 April
  // (30 days): 500,000 x 3.6% x 30/360 = 1,500.00 paid.
  assert.equal(Number((cash(app, acct) - before).toFixed(2)), 24_815.79);
  assert.equal(app.positions.get(p.positionId).qty, 500_000);
  // Interest: 1.80 per 100 on the 500,000 left = 9,000.00.
  assert.equal(await lifecycle(app, p.positionId, { action: 'pass_through', kind: 'interest', amount: 1.8 }), null);
  assert.equal(Number((cash(app, acct) - before).toFixed(2)), 33_815.79);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('basket return leg: the payment waits for the level entered by hand; the next period starts from it', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = { productId: 'equity_basket_swap', name: 'Basket test', symbol: 'BSKT-T', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-04', maturity: '2026-09-04', ...NO_COLLATERAL, legs: [
      { id: 'A', side: 'receive', type: 'return', ccy: 'USD', months: 3, basket: 'AAA: 0.5; BBB: 0.5', initialLevel: 200 },
      { id: 'B', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0, months: 3, dayCount: 'ACT/360' },
    ] } };
  assert.throws(() => app.instruments.create({ ...contract, terms: { ...contract.terms, legs: [{ ...contract.terms.legs[0], basket: 'AAA: 0.5; BBB: 0.4' }, contract.terms.legs[1]] } }), /the basket weights add up to 0.9, not 1/);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(contract, 1_000_000)] });
  const p = s.positions[0];
  await goTo(app, clock, NY10('2026-06-04'));
  const waiting = () => app.tasks.open([acct.id]).find((t) => t.position_id === p.positionId && t.type === 'swap.payment' && t.status === 'blocked');
  assert.match(waiting().blocked_reason, /^Awaiting the basket level of 2026-06-04 for leg A of /);
  const before = cash(app, acct);
  setBasketLevel(app, app.tasks.get(waiting().id), 210);
  await goTo(app, clock, NY10('2026-06-05'));
  assert.equal(cash(app, acct) - before, 50_000); // 1,000,000 x (210 / 200 - 1)
  await goTo(app, clock, NY10('2026-09-04'));
  setBasketLevel(app, app.tasks.get(waiting().id), 199.5);
  await goTo(app, clock, NY10('2026-09-08'));
  assert.equal(cash(app, acct) - before, 0); // second period from 210: 1,000,000 x (199.5 / 210 - 1) = -50,000.00
  assert.deepEqual(ledgerImbalance(app), []);
});
