// Accounting verification, engine level (part of npm test).
//
// One Book ("Verification Book", reporting USD) with Treasury and two Accounts, taken through every situation of the
// owner's section 7 and back to a clean end state. The scenario and its hand-worked expectations are in
// test/system/cases/accounting.mjs (runVerification, EXPECT); docs/ACCOUNTING-VERIFICATION.md derives every literal by
// hand from the stated inputs, with the arithmetic shown. Here it runs in-process against the real route handlers,
// engine and ledger on a disposable database file with a frozen clock; the same scenario runs through HTTP and the
// browser in the system suite (SA/SB:accounting:verification-book).

import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld } from '../system/lib/world.mjs';
import { createChecks } from '../system/lib/kit.mjs';
import { runVerification, EXPECT, AT } from '../system/cases/accounting.mjs';

test('Verification Book: every checkpoint from capital in to a clean end state matches the hand-worked ledger', { timeout: 300_000 }, async () => {
  const w = await openWorld('engine', { label: 'accounting-verification', at: AT.mon });
  const c = createChecks();
  try {
    const ctx = await runVerification(w, c);
    // Engine-level reads straight from the ledger, beside the route answers: the end state is cash only.
    const app = w.t.app;
    const left = app.db.all(`SELECT unit_id, account, ccy, ROUND(SUM(amount), 2) AS s FROM entries WHERE book_id = ? AND account IN ('cash.restricted','cash.margin','recv.settle','pay.settle','accrued.asset','accrued.liab','pos','loan.asset','loan.liab','coll.received') GROUP BY unit_id, account, ccy HAVING ABS(SUM(amount)) > 0.004`, ctx.ids.book).map((r) => ({ ...r }));
    c.eq(left, [], 'end: no restricted cash, margin, unsettled trade, accrual, position, loan or collateral balance is left in the ledger');
    c.eq(app.db.get(`SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND released_at IS NULL`, ctx.ids.book).n, 0, 'end: no cash is still reserved');
    c.eq(app.db.all(`SELECT ccy, ROUND(SUM(amount), 2) AS s FROM entries WHERE book_id = ? AND account = 'cash' GROUP BY ccy HAVING ABS(SUM(amount)) > 0.004 ORDER BY ccy`, ctx.ids.book).map((r) => ({ ...r })), [{ ccy: 'EUR', s: 100_380 }, { ccy: 'USD', s: 2_025_858.99 }], 'end: the Book holds 2,025,858.99 USD and 100,380.00 EUR');
    c.ok(Object.keys(EXPECT).length === 11, 'eleven checkpoints were compared');
  } finally {
    await w.close();
  }
  assert.deepEqual(c.problems, [], `${c.problems.length} of ${c.count} checks failed:\n${c.problems.join('\n')}`);
});

// The fault this verification found (fixed in server/core/accounting.js, balanceSheet): capital and internal funding were
// retranslated at today's rate, so "Results to date" lost the FX effect that the P&L statement counts, and contributed
// capital moved with the exchange rate. By hand: 100,000 EUR deposited at 1.10 is 110,000 USD of capital; at 1.12 the
// Book holds 112,000; results are +2,000, all of it FX. 60,000 EUR funded to an Account at 1.10 is 66,000 of funding;
// at 1.12 the Account holds 67,200: its results are +1,200, Treasury's +800.
test('balance sheet: capital and internal funding stay at the rates they were booked at, so results to date equal the P&L', async () => {
  const w = await openWorld('engine', { label: 'accounting-booked-rates', at: AT.mon });
  try {
    await w.fixture('fx', { pair: 'EUR/USD', rate: 1.10 });
    const b = await w.post('/api/books', { name: 'Booked rates', reportingCcy: 'USD' });
    const T = b.units.find((u) => u.kind === 'treasury').id;
    await w.post(`/api/books/${b.id}/capital`, { type: 'deposit', ccy: 'EUR', amount: 100_000, note: 'capital' });
    const A = (await w.post(`/api/books/${b.id}/accounts`, { name: 'Alpha' })).id;
    await w.post(`/api/books/${b.id}/transfers`, { fromUnitId: T, toUnitId: A, ccy: 'EUR', amount: 60_000, purpose: 'funding' });
    await w.fixture('fx', { pair: 'EUR/USD', rate: 1.12 });
    const bs = await w.get(`/api/books/${b.id}/accounting/balance`, { scope: 'book' });
    const rep = (k) => bs.representedBy.find((r) => r.key === k);
    assert.equal(bs.netAssets.total.rc, 112_000);
    assert.equal(rep('capital').total.rc, 110_000, 'capital as contributed: 100,000 EUR at 1.10');
    assert.deepEqual(rep('capital').total.byCurrency, [{ ccy: 'EUR', amount: 100_000 }]);
    assert.equal(rep('results').total.rc, 2_000, '112,000 - 110,000: the FX gain on the euros held');
    assert.deepEqual([rep('internal').cells[T].rc, rep('internal').cells[A].rc], [-66_000, 66_000], 'funding as booked: 60,000 EUR at 1.10');
    assert.deepEqual([rep('results').cells[T].rc, rep('results').cells[A].rc], [800, 1_200]);
    assert.equal(rep('internal').elimination.rc, 0);
    const pnl = await w.get(`/api/books/${b.id}/accounting/pnl`, { scope: 'book' });
    assert.equal(pnl.fx.current, 2_000);
    assert.equal(pnl.investmentPnl, rep('results').total.rc, 'results to date on the balance sheet = investment P&L');
    const alpha = await w.get(`/api/books/${b.id}/accounting/pnl`, { scope: A });
    assert.equal(alpha.investmentPnl, rep('results').cells[A].rc);
    const t = await w.get(`/api/books/${b.id}/accounting/balance`, { scope: 'treasury' });
    assert.equal(t.oversight.accounts[0].fundingReceived.rc, 66_000, 'Treasury oversight shows the same funding figure');
  } finally {
    await w.close();
  }
});
