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
    const left = app.db.all(`SELECT unit_id, account, ccy, ROUND(SUM(amount), 2) AS s FROM entries WHERE book_id = ? AND account IN ('cash.restricted','cash.margin','recv.settle','pay.settle','accrued.asset','accrued.liab','pos','loan.asset','loan.liab','coll.received') GROUP BY unit_id, account, ccy HAVING ABS(SUM(amount)) > 0.004`, ctx.ids.book);
    c.eq(left, [], 'end: no restricted cash, margin, unsettled trade, accrual, position, loan or collateral balance is left in the ledger');
    c.eq(app.db.get(`SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND released_at IS NULL`, ctx.ids.book).n, 0, 'end: no cash is still reserved');
    c.eq(app.db.all(`SELECT ccy, ROUND(SUM(amount), 2) AS s FROM entries WHERE book_id = ? AND account = 'cash' GROUP BY ccy HAVING ABS(SUM(amount)) > 0.004 ORDER BY ccy`, ctx.ids.book), [{ ccy: 'EUR', s: 100_380 }, { ccy: 'USD', s: 2_025_858.99 }], 'end: the Book holds 2,025,858.99 USD and 100,380.00 EUR');
    c.ok(Object.keys(EXPECT).length === 11, 'eleven checkpoints were compared');
  } finally {
    await w.close();
  }
  assert.deepEqual(c.problems, [], `${c.problems.length} of ${c.count} checks failed:\n${c.problems.join('\n')}`);
});
