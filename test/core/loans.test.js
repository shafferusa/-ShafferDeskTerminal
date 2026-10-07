// Cash loans and deposits: regression tests for defects found by the product test matrix (test/matrix/specs/loan.mjs).
// Expected figures are worked out by hand in the comments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { goTo, ledgerImbalance, makeApp, makeBook, trade } from '../helpers.js';

const loanLeg = (qty, terms) => ({
  kind: 'loan', action: 'borrow_cash', qty, purpose: 'financing',
  contract: { productId: 'unsecured_loan', name: 'Regression loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', dayCount: 'ACT/360', ...terms } },
});
const repayLeg = (pos, qty) => ({ kind: 'repay', action: 'repay_cash', purpose: 'financing', targetPositionId: pos.positionId, qty });

test('a part repayment first accrues interest to its date on the principal outstanding until then', async () => {
  const { app, clock } = makeApp(); // Monday 2 March 2026, 10:00 New York
  const { book, acct } = makeBook(app);
  // 360,000 at 5.00%, ACT/360: 360,000 x 0.05 / 360 = 50.00 a day.
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loanLeg(360_000, { rate: 0.05, maturity: '2026-06-01' })] });
  const pos = s.positions.find((p) => p.family === 'loan');
  const accrued = () => -app.ledger.positionBalance(pos.positionId, 'accrued.liab', 'USD');

  // Thursday 5 March, 10:00: half is repaid. Three days on 360,000 have run: 3 x 50.00 = 150.00.
  await goTo(app, clock, '2026-03-05T15:00:00.000Z');
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, legs: [repayLeg(pos, 180_000)] });
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'USD'), -180_000);
  assert.equal(accrued(), 150, 'interest to the repayment date is on the 360,000 that was outstanding until then');
  assert.equal(app.ledger.balance(acct.id, 'cash', 'USD'), 500_000 + 360_000 - 180_000, 'a part repayment pays principal only; the interest stays on its schedule');

  // Friday 6 March, after the end-of-day run: one more day, on 180,000: 25.00. Total 175.00
  // (not 4 days x 25.00 = 100.00, which is what accruing the whole period on the reduced principal would give).
  await goTo(app, clock, '2026-03-06T22:30:00.000Z');
  assert.equal(accrued(), 175);
  assert.equal(-app.ledger.balance(acct.id, 'pnl.funding', 'USD'), -175, 'the same amount is funding expense');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('repaying more than is outstanding is refused, not quietly cut down to what is owed', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loanLeg(100_000, { rate: 0.05, maturity: '2026-06-01' })] });
  const pos = s.positions.find((p) => p.family === 'loan');
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, legs: [repayLeg(pos, 150_000)] });
  assert.equal(pv.blocking, 1);
  assert.match(pv.checks.find((c) => c.level === 'error').message, /Outstanding principal is 100,000\.00 USD; cannot repay 150,000\.00 USD\./);
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'USD'), -100_000, 'nothing was repaid');
});

test('the preview shows one day of interest on the contract day count: ACT/365 divides by 365', async () => {
  const { app } = makeApp();
  const { book, treasury } = makeBook(app);
  const leg = (dayCount) => ({ kind: 'loan', action: 'borrow_cash', qty: 400_000, purpose: 'financing',
    contract: { productId: 'unsecured_loan', name: `Loan ${dayCount}`, marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.042, dayCount, maturity: '2026-06-01' } } });
  const daily = async (dayCount) => (await app.packages.preview({ bookId: book.id, unitId: treasury.id, template: 'custom', legs: [leg(dayCount)] })).legs[0].dailyCost;
  assert.equal(await daily('ACT/365'), 46.03); // 400,000 x 0.042 / 365 = 46.0274
  assert.equal(await daily('ACT/360'), 46.67); // 400,000 x 0.042 / 360 = 46.6667
});
