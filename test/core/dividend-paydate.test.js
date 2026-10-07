// A cash dividend with a pay date later than its ex-date: entitlement is fixed by the holding at the
// open of the ex-date, and the cash is posted on the pay date, not before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';
import { createApi } from '../../server/api.js';

const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e6, askSize: 1e6 });

test('a dividend recorded with a later pay date posts on the pay date, on the ex-date holding', async () => {
  const { app, clock, inst } = makeApp(); // Monday 2 March 2026
  const { book, acct } = makeBook(app);
  const api = createApi(app);
  const call = (method, path, body = {}, query = {}) => { const m = api.match(method, path); return m.handler({ params: m.params, query, body }); };
  pin(app, inst.ALFA.id, 100);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000 }); // 100,000.00, settles Tue 3 March
  // Recorded through the route the form uses: 0.50 a share, ex-date Wed 4 March, pay date Wed 18 March.
  const ca = await call('POST', '/api/corporate-actions', { instrumentId: inst.ALFA.id, type: 'cash_dividend', exDate: '2026-03-04', payDate: '2026-03-18', amount: 0.5 });
  assert.equal(ca.duplicate, false);
  assert.deepEqual((await call('GET', '/api/corporate-actions', {}, { instrumentId: inst.ALFA.id })).items.map((c) => [c.ex_date, c.pay_date, c.status]), [['2026-03-04', '2026-03-18', 'pending']]);
  // A pay date before the ex-date is refused.
  await assert.rejects(async () => call('POST', '/api/corporate-actions', { instrumentId: inst.ALFA.id, type: 'cash_dividend', exDate: '2026-03-04', payDate: '2026-03-03', amount: 0.25 }), /Pay date must be on or after the ex-date/);
  // Half the position is sold on Thursday 5 March, after the ex-date: the dividend is still due on all 1,000 shares.
  await goTo(app, clock, '2026-03-05T15:00:00.000Z');
  const s = app.packages.listStrategies({ bookId: book.id })[0];
  const pv = await app.packages.previewAction(s.id, 'close', { fraction: 0.5 });
  await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation });
  // On and after the ex-date, before the pay date: nothing has been posted.
  await goTo(app, clock, '2026-03-17T21:30:00.000Z');
  assert.equal(app.ledger.balance(acct.id, 'pnl.dividend', 'USD'), 0);
  assert.equal(app.accounting.history(book.id, acct.id).events.filter((e) => e.type === 'dividend').length, 0);
  // Cash so far: 500,000 - 100,000 + 50,000 (500 sold at 100.00) = 450,000.00.
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 450_000);
  // Wednesday 18 March, the pay date: 1,000 x 0.50 = 500.00 is posted once.
  await goTo(app, clock, '2026-03-18T14:00:00.000Z');
  const ev = app.accounting.history(book.id, acct.id).events.filter((e) => e.type === 'dividend');
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].businessDate, ev[0].data.exDate, ev[0].data.payDate, ev[0].data.qty], ['2026-03-18', '2026-03-04', '2026-03-18', 1000]);
  assert.equal(app.ledger.balance(acct.id, 'pnl.dividend', 'USD'), -500);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 450_500);
  // The next day nothing more is posted.
  await goTo(app, clock, '2026-03-19T14:00:00.000Z');
  assert.equal(app.accounting.history(book.id, acct.id).events.filter((e) => e.type === 'dividend').length, 1);
  assert.deepEqual(ledgerImbalance(app), []);
});
