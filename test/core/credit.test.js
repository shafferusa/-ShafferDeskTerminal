// Credit default swaps: regression tests for the conventions and credit events of server/products/credit.js (s3). Every
// expected figure is worked out by hand in the comment beside it. The scenarios of test/matrix/specs/cds.mjs exercise the
// same rules through the interface.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance } from '../helpers.js';
import { createApi } from '../../server/api.js';

const NO_COLLATERAL = { collateralBasis: { type: 'uncollateralized' } };
const cash = (app, unit, ccy = 'USD') => app.ledger.cash(unit.id, ccy);
const leg = (contract, qty, action = 'buy', price = 0) => ({ kind: 'trade', action, qty, statedPrice: price, contract });

async function creditEvent(app, inst, body) {
  const api = createApi(app);
  const m = api.match('POST', `/api/instruments/${inst.id}/lifecycle`);
  try { await m.handler({ params: m.params, query: {}, body: { action: 'credit_event', ...body } }); return null; } catch (e) { return e.message; }
}

test('standard CDS bought on Mon 2 March 2026: the full first coupon is due 20 March and the accrued premium to step-in is received at trade', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = { productId: 'cds_single_name', name: 'Standard CDS test', symbol: 'SCDS-T', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { referenceEntity: 'Test Corp', coupon: 0.01, effective: '2026-03-02', maturity: '2031-03-20', recovery: 0.4, convention: 'standard', ...NO_COLLATERAL } };
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(contract, 1_000_000)] });
  // Accrued from the last roll date, Mon 22 December 2025 (20 December was a Saturday), to step-in Tue 3 March:
  // 71 days: 1,000,000 x 1% x 71/360 = 1,972.22, received by the buyer with the upfront (settling T+3, Thu 5 March).
  const ev = app.db.all(`SELECT type, summary FROM events WHERE type = 'cds.accrued' ORDER BY id`);
  assert.equal(ev.length, 1);
  assert.match(ev[0].summary, /1,972\.22 USD/);
  assert.equal(cash(app, acct).receivable, 1_972.22);
  const coupon = app.tasks.open([acct.id]).find((t) => t.type === 'cds.premium');
  assert.equal(coupon.due_date, '2026-03-20');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('sovereign terms: bankruptcy is refused by name; failure to pay settles (1 - recovery) of the notional and ends the contract', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = { productId: 'cds_sovereign', name: 'Sovereign CDS test', symbol: 'SOV-T', marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { referenceEntity: 'Republic of Test', coupon: 0.01, effective: '2026-03-02', maturity: '2031-03-20', recovery: 0.4, creditEventSet: 'sovereign', ...NO_COLLATERAL } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(contract, 1_000_000)] });
  const inst = app.instruments.get(s.positions[0].instrument.id);
  assert.match(await creditEvent(app, inst, { eventType: 'bankruptcy', recovery: 0.3 }), /^Bankruptcy is not a credit event under the terms of SOV-T\. Its credit events: /);
  const before = cash(app, acct).settled;
  assert.equal(await creditEvent(app, inst, { eventType: 'failure_to_pay', recovery: 0.3 }), null);
  // Protection: 1,000,000 x (1 - 0.30) = 700,000.00, less the premium accrued from 22 December to the event, paid by the buyer.
  const moved = app.db.all(`SELECT summary FROM events WHERE type = 'cds.credit_event'`);
  assert.equal(moved.length, 1);
  assert.match(moved[0].summary, /700,000\.00 USD/);
  assert.ok(cash(app, acct).settled + cash(app, acct).unsettled > before, 'the buyer is paid the protection');
  assert.equal(app.positions.get(s.positions[0].positionId).qty, 0);
  assert.match(await creditEvent(app, inst, { eventType: 'failure_to_pay', recovery: 0.3 }), /has ended/);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('index: a constituent default pays (1 - recovery) x its weight of the original notional and lowers the index factor', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = { productId: 'cds_index', name: 'Index CDS test', symbol: 'IDX-T', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { referenceEntity: 'Test Index S1', coupon: 0.01, effective: '2026-03-02', maturity: '2031-03-20', recovery: 0.4, indexFactor: 1, ...NO_COLLATERAL } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(contract, 1_000_000)] });
  const inst = app.instruments.get(s.positions[0].instrument.id);
  assert.equal(await creditEvent(app, inst, { eventType: 'bankruptcy', recovery: 0.25, weight: 0.01, entity: 'Name One' }), null);
  // 1,000,000 x 1% x (1 - 0.25) = 7,500.00; the factor falls from 1 to 0.99.
  assert.equal(app.instruments.get(inst.id).terms.indexFactor, 0.99);
  const moved = app.db.all(`SELECT summary FROM events WHERE type = 'cds.credit_event'`);
  assert.match(moved[0].summary, /7,500\.00 USD/);
  assert.equal(app.positions.get(s.positions[0].positionId).qty, 1_000_000, 'the position goes on, on the outstanding notional');
  assert.deepEqual(ledgerImbalance(app), []);
});
