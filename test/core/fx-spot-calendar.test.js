// A spot currency pair trades on the global FX market (Monday to Friday); a bank holiday of one of its currencies
// moves the value date, it does not stop the trade. Found by the c1 matrix scenario for fx_spot: before the fix the
// pair's trading calendar was the joint payment calendar, so a USD/JPY order on Showa Day (29 April, a Tokyo
// holiday) waited for the next day.
//
// By hand: sold 10,000 USD on Wednesday 29 April 2026; yen days counted from there: Thursday 30 April (1), Friday
// 1 May (2), a US dollar banking day too, so the value date is 1 May.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade } from '../helpers.js';
import { calendarInfo } from '../../server/products/security.js';

test('USD/JPY trades on a Tokyo holiday and settles on the next good day for both currencies', async () => {
  const { app, inst } = makeApp({ at: '2026-04-29T14:00:00.000Z' });
  const { book, acct } = makeBook(app);
  const pair = inst['USD/JPY'];
  assert.equal(calendarInfo(pair).trading.id, 'FX');
  assert.equal(calendarInfo(pair).settlement.id, 'USD+JP');
  const input = { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: pair.id, qty: 10_000 }] };
  const pv = await app.packages.preview(input);
  assert.ok(!pv.checks.some((c) => c.code === 'not-trading-day'), 'no market-closed warning on Showa Day');
  assert.equal(pv.legs[0].settleDate, '2026-05-01');
  const s = await trade(app, input);
  assert.equal(s.orders[0].status, 'filled');
  assert.equal(s.orders[0].fills[0].businessDate, '2026-04-29');
});

test('a currency pair still waits at the weekend', async () => {
  const { app, inst } = makeApp({ at: '2026-05-02T14:00:00.000Z' }); // Saturday
  const { book, acct } = makeBook(app);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst['EUR/USD'].id, qty: 1_000 }] });
  assert.equal(s.orders[0].status, 'working');
  assert.match(s.orders[0].statusReason, /Market closed today on calendar FX/);
});
