// Funds are forward-priced: an order deals at the next NAV struck after it is placed, never at a live quote
// (products/security.js "funds: forward pricing"). Found by the c1 matrix scenario for mutual_fund: before this,
// a fund order filled at once against whatever price was on hand.
//
// Figures worked out by hand: 100 shares at a last published NAV of 20.00 reserve 2,000.00; dealt at the
// 2 March NAV of 20.50 the purchase costs 2,050.00 and settles T+1 (3 March).

import test from 'node:test';
import assert from 'node:assert/strict';
import { goTo, makeApp, makeBook, trade } from '../helpers.js';

function setup() {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  app.books.updateSettings?.(book.id, { fees: { fund: { perUnit: 0, minimum: 0, bps: 0 } }, settlement: { fund: 1 } });
  const fund = app.instruments.create({ productId: 'mutual_fund', name: 'Test Balanced Fund', symbol: 'TBFX', venueType: 'otc', venueCountry: 'US', domicile: 'US', marketView: 'US_CASH', tradingCcy: 'USD', terms: {} });
  app.data.enterManual({ kind: 'price', subject: fund.id, value: 20, currency: 'USD', note: 'last published NAV' });
  const buy = (qty, extra = {}) => trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: fund.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: fund.id, qty, ...extra }] });
  return { app, clock, book, acct, fund, buy };
}

test('fund order waits for the NAV of its dealing date, with its estimated cost reserved, then deals at that NAV', async () => {
  const { app, clock, acct, fund, buy } = setup();
  const s = await buy(100); // Monday 10:00 New York, before the 16:00 cut-off: dealing date 2 March
  const o = s.orders[0];
  assert.equal(o.status, 'working');
  assert.match(o.statusReason, /Waiting for the NAV of 2026-03-02/);
  assert.equal(app.ledger.reserved(acct.id, 'USD'), 2000); // 100 x 20.00
  app.data.enterManual({ kind: 'price', subject: fund.id, value: 20.5, currency: 'USD', forDate: '2026-03-02', note: 'NAV of 2 March' });
  await goTo(app, clock, '2026-03-02T23:00:00.000Z');
  const after = app.packages.strategyView(s.id).orders[0];
  assert.equal(after.status, 'filled');
  assert.equal(after.avgPrice, 20.5);
  assert.equal(after.fills[0].settleDate, '2026-03-03');
  assert.equal(app.ledger.reserved(acct.id, 'USD'), 0);
  const pend = app.db.all(`SELECT due_date, amount FROM settlements WHERE unit_id = ? AND status = 'pending'`, acct.id);
  assert.deepEqual(pend.map((r) => [r.due_date, r.amount]), [['2026-03-03', -2050]]); // 100 x 20.50
});

test('a fund order placed after the cut-off deals at the next day\'s NAV and is not expired at the end of the day', async () => {
  const { app, clock, fund, buy } = setup();
  app.data.enterManual({ kind: 'price', subject: fund.id, value: 20.2, currency: 'USD', forDate: '2026-03-02', note: 'NAV of 2 March, already published' });
  await goTo(app, clock, '2026-03-02T22:00:00.000Z'); // 17:00 New York, after the cut-off
  const s = await buy(10);
  await goTo(app, clock, '2026-03-02T23:30:00.000Z'); // the end-of-day run has passed
  let o = app.packages.strategyView(s.id).orders[0];
  assert.equal(o.status, 'working', 'not filled at the 2 March NAV and not expired');
  assert.match(o.statusReason, /NAV of 2026-03-03/);
  app.data.enterManual({ kind: 'price', subject: fund.id, value: 20.4, currency: 'USD', forDate: '2026-03-03', note: 'NAV of 3 March' });
  await goTo(app, clock, '2026-03-03T23:00:00.000Z');
  o = app.packages.strategyView(s.id).orders[0];
  assert.equal(o.status, 'filled');
  assert.equal(o.avgPrice, 20.4);
  assert.equal(o.fills[0].settleDate, '2026-03-04'); // dealing date 3 March, T+1
});

test('a limit order in a fund is refused at the preview', async () => {
  const { buy } = setup();
  await assert.rejects(buy(10, { orderType: 'limit', limitPrice: 19 }), /does not apply/);
});
