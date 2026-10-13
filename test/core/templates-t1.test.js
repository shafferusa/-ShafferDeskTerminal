// Engine regressions found while driving the execution templates as linked packages (test matrix, templates-a).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';

const pin = (app, inst, bid, ask, size = 1e6) => app.data.market.set(inst.id, { bid, ask, value: (bid + ask) / 2, bidSize: size, askSize: size });

test('a cover is paid from the short\'s restricted collateral: the preview does not ask for free cash it will not use', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app, { account: 20_000 });
  pin(app, inst.ALFA, 200, 200.04);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  await goTo(app, clock, '2026-03-03T22:30:00.000Z'); // the sale settles into restricted cash; the 2% top-up posts
  // Move every free dollar to Treasury: nothing is left to trade with, but the restricted collateral (about 20,400) stays.
  const free = app.ledger.cash(acct.id, 'USD').availableToWithdraw;
  app.books.transfer({ bookId: book.id, fromUnitId: acct.id, toUnitId: treasury.id, ccy: 'USD', amount: free, purpose: 'sweep' });
  assert.equal(app.ledger.cash(acct.id, 'USD').availableToTrade, 0);
  pin(app, inst.ALFA, 189.96, 190);
  await app.data.refresh({ instruments: [inst.ALFA] });
  const pv = await app.packages.previewAction(s.id, 'close');
  // 100 x 190 = 19,000 plus 1.00 of commission at the Book default schedule: all of it from restricted cash.
  const c = pv.totals.cash.USD;
  assert.equal(pv.blocking, 0, pv.checks.filter((x) => x.level === 'error').map((x) => x.message).join(' | '));
  assert.ok(c.coverCollateral > 19_000 - 1e-9 && c.coverCollateral <= c.purchases + c.fees + 1e-9, `paid from collateral: ${c.coverCollateral}`);
  assert.equal(c.shortfall, 0);
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'close', legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.equal(r.strategy.status, 'closed', 'the order engine pays the cover from restricted cash, as the preview said');
  assert.deepEqual(ledgerImbalance(app), []);
});
