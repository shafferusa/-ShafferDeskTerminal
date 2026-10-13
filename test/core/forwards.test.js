// Forwards: Terminal behaviour added or fixed while proving the forwards family in the product matrix
// (test/matrix/specs/forward.mjs). Every figure is worked by hand from the inputs in the test.
//   - An FX forward's value date must be a business day of both currencies' calendars (found by fx_forward,
//     step register-value-date-on-holiday: a contract for value on Juneteenth was accepted).
//   - Early termination at a stated amount (lifecycle action `terminate`): realized, settled on the date stated or
//     two business days later, collateral returned, each invalid request refused with its own reason; for a
//     non-deliverable forward the amount is in its settlement currency (found by fx_forward, ndf).
//   - Before an accounting read the API refreshes the FX rate of every currency an open position is valued in, not
//     only of currencies held as cash (found by fra, step tuesday: the NAV was provisional on a stale EUR rate while
//     the rate was in force).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../server/api.js';
import { createFixtureControls } from '../../server/data/demo.js';
import { makeApp, makeBook, trade, ledgerImbalance } from '../helpers.js';

const NO_FEES = { fees: { forward: { perUnit: 0, minimum: 0, bps: 0 } } };
function setup(at = '2026-06-01T14:00:00.000Z') {
  const { app, clock } = makeApp({ at });
  const { book, acct } = makeBook(app, { cash: 2_000_000, account: 500_000 });
  app.books.updateSettings(book.id, NO_FEES);
  const api = createApi(app);
  const call = (method, path, body = {}, query = {}) => { const m = api.match(method, path); return m.handler({ params: m.params, query, body }); };
  const fixtures = createFixtureControls(app);
  return { app, clock, book, acct, call, fixtures };
}
const rejects = (p, code, re) => assert.rejects(() => Promise.resolve().then(p), (err) => { if (code) assert.equal(err.code, code, err.message); if (re) assert.match(err.message, re); return true; });
const eurusd = (app, valueDate, basis = { type: 'uncollateralized' }) => app.instruments.create({ productId: 'fx_forward', name: `EUR/USD forward ${valueDate}`, symbol: `EURUSD-${valueDate}`, venueType: 'otc', jurisdiction: 'US', tradingCcy: 'USD',
  terms: { forwardType: 'fx', base: 'EUR', quote: 'USD', valueDate, counterparty: 'Dealer', collateralBasis: basis } });

test('an FX forward for value on a day one currency does not settle is refused', () => {
  const { app } = setup();
  assert.throws(() => eurusd(app, '2026-06-19'), /The value date 2026-06-19 is not a business day for USD \(USD calendar\)/); // Juneteenth
  assert.throws(() => eurusd(app, '2026-05-01'), /The value date 2026-05-01 is not a business day for EUR \(TARGET calendar\)/); // TARGET holiday
  assert.equal(eurusd(app, '2026-06-22').terms.valueDate, '2026-06-22');
});

test('early termination at a stated amount: realized, settled two business days later, collateral returned, invalid requests refused', async () => {
  const { app, book, acct, call } = setup();
  const fwd = eurusd(app, '2026-06-22', { type: 'position', independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: false });
  app.data.market.set(fwd.id, { bid: 1.085, ask: 1.085, value: 1.085, bidSize: 1e7, askSize: 1e7 });
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: fwd.id, qty: 1_000_000, statedPrice: 1.085 }] });
  const posId = s.positions[0].positionId;
  // Independent amount 2% x 1,000,000 x 1.085 = 21,700.
  assert.equal(app.ledger.cash(acct.id, 'USD').margin, 21_700);
  const terminate = (body) => call('POST', `/api/positions/${posId}/lifecycle`, { action: 'terminate', ...body });
  await rejects(() => terminate({}), 'termination_amount');
  await rejects(() => terminate({ amount: 100, qty: 1_500_000 }), 'termination_more_than_held', /holds only 1,000,000/);
  await rejects(() => terminate({ amount: 100, settleDate: '2026-05-29' }), 'termination_settle_date');
  // 400,000 terminated, 900 received: due Wednesday 3 June (Monday 1 June + 2 business days). IA trued up to 2% x 600,000 x 1.085 = 13,020.
  const r = await terminate({ amount: 900, qty: 400_000 });
  assert.equal(r.result.settleDate, '2026-06-03');
  assert.equal(app.positions.get(posId).qty, 600_000);
  assert.equal(app.ledger.cash(acct.id, 'USD').margin, 13_020);
  const pending = app.db.all(`SELECT due_date, amount FROM settlements WHERE position_id = ? AND status = 'pending'`, posId);
  assert.deepEqual(pending.map((x) => [x.due_date, x.amount]), [['2026-06-03', 900]]);
  // The rest: 1,250 paid on a stated date. Everything posted comes back; nothing is scheduled.
  await terminate({ amount: -1_250, settleDate: '2026-06-05' });
  assert.equal(app.positions.get(posId).qty, 0);
  assert.equal(app.ledger.cash(acct.id, 'USD').margin, 0);
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE position_id = ? AND status IN ('pending','blocked','failed')`, posId).n, 0);
  assert.equal(app.accounting.pnl(book.id, acct.id).categories.find((c) => c.key === 'realized').rc, -350); // 900 - 1,250
  await rejects(() => terminate({ amount: 1 }), 'termination_position_closed');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a non-deliverable forward is terminated in its settlement currency', async () => {
  const { app, book, acct, call } = setup('2026-03-02T15:00:00.000Z');
  const ndf = app.instruments.create({ productId: 'ndf', name: 'USD/INR NDF', symbol: 'USDINR-T', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'INR',
    terms: { forwardType: 'ndf', base: 'USD', quote: 'INR', valueDate: '2026-05-04', fixingDate: '2026-04-30', settleCcy: 'USD', counterparty: 'Dealer', collateralBasis: { type: 'uncollateralized' } } });
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: ndf.id, qty: 1_000_000, statedPrice: 87.5 }] });
  await call('POST', `/api/positions/${s.positions[0].positionId}/lifecycle`, { action: 'terminate', amount: -2_000 });
  const pend = app.db.all(`SELECT ccy, amount FROM settlements WHERE position_id = ? AND status = 'pending'`, s.positions[0].positionId);
  assert.deepEqual(pend.map((x) => [x.ccy, x.amount]), [['USD', -2_000]]);
});

test('an accounting read refreshes the rate of a currency an open position is valued in, even with no cash in it', async () => {
  const { app, clock, book, acct, call, fixtures } = setup('2026-03-02T15:00:00.000Z');
  const fra = app.instruments.create({ productId: 'fra', name: 'EUR FRA 3x6', symbol: 'EURFRA-T', venueType: 'otc', jurisdiction: 'GB', tradingCcy: 'EUR',
    terms: { forwardType: 'fra', periodStart: '2026-06-03', periodEnd: '2026-09-03', fixingRate: 'EURIBOR3M', fixingDate: '2026-06-01', counterparty: 'Dealer', collateralBasis: { type: 'uncollateralized' } } });
  await fixtures.apply('fx', { pair: 'EUR/USD', rate: 1.08 });
  await fixtures.apply('quote', { instrumentId: fra.id, bid: 2.29, ask: 2.31, last: 2.30, bidSize: 1e8, askSize: 1e8 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: fra.id, qty: 10_000_000, statedPrice: 2.15 }] });
  // Two hours later, before any end-of-day pass: the rate observed at the trade is old, the fixture still in force.
  clock.freeze('2026-03-02T17:00:00.000Z');
  await fixtures.apply('quote', { instrumentId: fra.id, bid: 2.29, ask: 2.31, last: 2.30, bidSize: 1e8, askSize: 1e8 });
  const pnl = await call('GET', `/api/books/${book.id}/accounting/pnl`, {}, { scope: acct.id });
  // 10,000,000 x 0.15 / 100 x 92/360 = 3,833.33 EUR = 4,140.00 USD at 1.08, and not provisional.
  assert.equal(pnl.unrealized.current, 4_140);
  const nav = app.accounting.overview(book.id);
  assert.equal(nav.navProvisional, false, JSON.stringify(nav.missing || {}));
});
