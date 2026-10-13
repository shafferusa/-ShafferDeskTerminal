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

// Asset forwards settled by delivery (found by equity_forward, bond_forward and tba_mortgage):
//   - the seller delivers what the unit holds, in any strategy instance; without enough the delivery waits visibly
//     instead of opening an unborrowed short;
//   - delivery against payment on the value date itself, not a further settlement lag of the underlying;
//   - a bond forward in face amount (multiplier 0.01, taken from the bond) delivers that face, not 1% of it, and the
//     accrued interest bought on delivery is kept by the next end-of-day accrual;
//   - a TBA contract delivers the pool allocated to it by hand, refuses a pool of another coupon, and waits without one.
async function stockAndForward(app, book, acct, { valueDate = '2026-04-17' } = {}) {
  const stock = app.instruments.create({ productId: 'common_stock', name: 'Delivery Test Inc.', symbol: 'DLVT', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {} });
  const fwd = app.instruments.create({ productId: 'equity_forward', name: 'DLVT forward', symbol: 'DLVT-F', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'USD', underlyingId: stock.id,
    terms: { forwardType: 'asset', settlement: 'physical', valueDate, counterparty: 'Dealer', collateralBasis: { type: 'uncollateralized' } } });
  app.data.market.set(stock.id, { bid: 50, ask: 50, value: 50, bidSize: 1e6, askSize: 1e6 });
  return { stock, fwd };
}

test('a forward seller delivers shares held in another strategy instance, on the value date; without them it waits', async () => {
  const { app, clock, book, acct } = setup('2026-04-13T14:00:00.000Z');
  app.books.updateSettings(book.id, { fees: { forward: { perUnit: 0, minimum: 0, bps: 0 }, equity: { perUnit: 0, minimum: 0, bps: 0 } }, settlement: { equity: 1 } });
  const { stock, fwd } = await stockAndForward(app, book, acct);
  const sh = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: stock.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: stock.id, qty: 600 }] });
  const f = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: fwd.id, qty: 1_000, statedPrice: 52 }] });
  // Value date: 1,000 to deliver, 600 held: nothing is delivered, the item waits with the reason.
  clock.freeze('2026-04-17T14:00:00.000Z'); await app.engine.tick();
  const task = app.db.get(`SELECT status, blocked_reason FROM tasks WHERE position_id = ? AND type = 'forward.maturity'`, f.positions[0].positionId);
  assert.equal(task.status, 'blocked');
  assert.match(task.blocked_reason, /1,000 DLVT must be delivered at 52\.00, but Alpha holds 600/);
  assert.equal(app.positions.list({ unitIds: [acct.id] }).filter((p) => p.instrument_id === stock.id && p.qty < 0).length, 0, 'no short is opened');
  // 400 more bought into a third strategy instance (settles T+1, but the shares are held at once): delivered from both, same day.
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: stock.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: stock.id, qty: 400 }] });
  await app.engine.tick();
  const held = app.positions.list({ unitIds: [acct.id] }).filter((p) => p.instrument_id === stock.id).reduce((a, p) => a + p.qty, 0);
  assert.equal(held, 0);
  const recv = app.db.all(`SELECT due_date, amount, status FROM settlements WHERE instrument_id = ? AND amount > 0`, stock.id);
  // 600 x 52 + 400 x 52 = 52,000, delivery against payment on the value date.
  assert.deepEqual(recv.map((x) => [x.due_date, x.amount]).sort(), [['2026-04-17', 20_800], ['2026-04-17', 31_200]]);
  assert.equal(sh.positions.length, 1);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a bond forward delivers its face amount with the accrued interest of the value date, kept through the next end of day', async () => {
  const { app, clock, book, acct } = setup('2026-05-04T14:00:00.000Z');
  app.books.updateSettings(book.id, { fees: { forward: { perUnit: 0, minimum: 0, bps: 0 }, bond: { perUnit: 0, minimum: 0, bps: 0 } }, settlement: { bond: 1 } });
  app.books.transfer({ bookId: book.id, fromUnitId: app.books.treasuryOf(book.id).id, toUnitId: acct.id, ccy: 'USD', amount: 1_500_000 });
  const note = app.instruments.create({ productId: 'treasury_note', name: 'UST 4% Nov-2030', symbol: 'UST30-T', venueType: 'otc', domicile: 'US', tradingCcy: 'USD', multiplier: 0.01,
    terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2, maturity: '2030-11-15', issueDate: '2023-11-15', dayCount: 'ACT/ACT', redemption: 100 } });
  const fwd = app.instruments.create({ productId: 'bond_forward', name: 'UST30 forward', symbol: 'UST30-FT', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'USD', underlyingId: note.id,
    terms: { forwardType: 'asset', settlement: 'physical', valueDate: '2026-05-18', counterparty: 'Dealer', collateralBasis: { type: 'uncollateralized' } } });
  assert.equal(fwd.multiplier, 0.01, 'the bond\'s multiplier');
  assert.equal(app.instruments.toView(fwd).qtyLabel, 'Face amount');
  app.data.market.set(note.id, { bid: 99.25, ask: 99.25, value: 99.25, bidSize: 1e8, askSize: 1e8 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: fwd.id, qty: 2_000_000, statedPrice: 99.25 }] });
  clock.freeze('2026-05-18T14:00:00.000Z'); await app.engine.tick();
  const pos = app.positions.list({ unitIds: [acct.id] }).find((p) => p.instrument_id === note.id);
  assert.equal(pos.qty, 2_000_000);
  assert.equal(pos.cost, 1_985_000);
  // 2,000,000 x 2% x 3 / 184 (15 to 18 May) = 652.17, paid on 18 May and still carried after the pass of 15 May.
  assert.equal(app.ledger.positionBalance(pos.id, 'accrued.asset', 'USD'), 652.17);
  const paid = app.db.all(`SELECT due_date, amount FROM settlements WHERE position_id = ?`, pos.id);
  assert.deepEqual(paid.map((x) => [x.due_date, x.amount]), [['2026-05-18', -1_985_652.17]]);
});

test('a TBA contract delivers the pool allocated to it by hand; another coupon is refused; without one it waits', async () => {
  const { app, clock, book, acct, call } = setup('2026-06-08T14:00:00.000Z');
  app.books.updateSettings(book.id, { fees: { forward: { perUnit: 0, minimum: 0, bps: 0 }, bond: { perUnit: 0, minimum: 0, bps: 0 } } });
  app.books.transfer({ bookId: book.id, fromUnitId: app.books.treasuryOf(book.id).id, toUnitId: acct.id, ccy: 'USD', amount: 1_000_000 });
  const pool = (cpn, sym) => app.instruments.create({ productId: 'agency_mbs', name: `UMBS ${cpn} ${sym}`, symbol: sym, venueType: 'otc', domicile: 'US', tradingCcy: 'USD', multiplier: 0.01,
    terms: { couponType: 'fixed', couponRate: cpn, frequency: 12, maturity: '2056-05-01', issueDate: '2026-05-01', dayCount: '30/360', redemption: 100, factor: 0.95, paymentDelayDays: 24 } });
  const p55 = pool(0.055, 'POOL-55'), p60 = pool(0.06, 'POOL-60');
  assert.throws(() => app.instruments.create({ productId: 'tba_mortgage', name: 'TBA no coupon', symbol: 'TBA-X', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'USD',
    terms: { forwardType: 'asset', valueDate: '2026-06-11', counterparty: 'Dealer', collateralBasis: { type: 'uncollateralized' } } }), /pass-through coupon/);
  const tba = app.instruments.create({ productId: 'tba_mortgage', name: 'UMBS 5.5 TBA', symbol: 'TBA-55', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'USD',
    terms: { forwardType: 'asset', coupon: 0.055, valueDate: '2026-06-11', counterparty: 'Dealer', collateralBasis: { type: 'uncollateralized' } } });
  assert.equal(tba.multiplier, 0.01);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: tba.id, qty: 1_000_000, statedPrice: 100 }] });
  const posId = s.positions[0].positionId;
  const allocate = (instrumentId) => call('POST', `/api/positions/${posId}/lifecycle`, { action: 'allocate', instrumentId });
  await rejects(() => allocate(p60.id), 'allocation_coupon', /POOL-60 pays 6%; TBA-55 is settled with 5\.5% pools/);
  // Settlement date without an allocation: it waits.
  clock.freeze('2026-06-11T14:00:00.000Z'); await app.engine.tick();
  assert.equal(app.db.get(`SELECT status FROM tasks WHERE position_id = ? AND type = 'forward.maturity'`, posId).status, 'blocked');
  await allocate(p55.id);
  await app.engine.tick();
  const held = app.positions.list({ unitIds: [acct.id] }).find((p) => p.instrument_id === p55.id);
  // 1,000,000 original face x 0.95 = 950,000 current face at 100: cost 950,000; accrued 10 days 30/360 = 1,451.39.
  assert.equal(held.qty, 1_000_000);
  assert.equal(held.cost, 950_000);
  assert.equal(app.ledger.positionBalance(held.id, 'accrued.asset', 'USD'), 1_451.39);
  assert.deepEqual(ledgerImbalance(app), []);
});
