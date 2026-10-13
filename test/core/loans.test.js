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

test('a day count the accrual does not implement is refused, not replaced by ACT/360', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const leg = loanLeg(100_000, { rate: 0.05, maturity: '2026-06-01', dayCount: '30/360' });
  await assert.rejects(app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg] }), /Day count 30\/360 is not supported for a cash loan or deposit/);
  // The two it does implement are accepted as stated.
  for (const dayCount of ['ACT/360', 'ACT/365']) {
    const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [loanLeg(100_000, { rate: 0.05, maturity: '2026-06-01', dayCount })] });
    assert.equal(pv.blocking, 0);
    assert.ok(pv.legs[0].instrument.details.some(([k, v]) => k === 'Day count' && v === dayCount));
  }
});

test('a loan or deposit cannot be bought or sold like a security, and is not enlarged by resizing: both are refused in words', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loanLeg(100_000, { rate: 0.05, maturity: '2026-06-01' })] });
  const instrumentId = s.positions.find((p) => p.family === 'loan').instrument.id;
  await assert.rejects(app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId, qty: 100_000 }] }),
    (err) => err.status === 400 && /is a financing arrangement\. It cannot be bought or sold/.test(err.message));
  await assert.rejects(app.packages.previewAction(s.id, 'resize', { factor: 1.5 }),
    (err) => err.status === 400 && /is not enlarged by resizing\. Open a new arrangement/.test(err.message));
  // Resizing down is a part repayment, offered as an optional leg.
  const down = await app.packages.previewAction(s.id, 'resize', { factor: 0.5 });
  assert.deepEqual(down.legs.map((l) => [l.kind, l.qty]), [['repay', 50_000]]);
});

test('a secured loan with nothing pledged is refused: it would be an unsecured loan under another name', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const leg = { ...loanLeg(50_000, { rate: 0.05, maturity: '2026-06-01' }) };
  leg.contract = { ...leg.contract, productId: 'secured_loan', terms: { ...leg.contract.terms, loanType: 'secured', collateral: [] } };
  await assert.rejects(app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg] }), /A secured loan pledges collateral: choose the position to pledge and the quantity\./);
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'USD'), 0, 'nothing was borrowed');
});

test('a floating loan is previewed on the fixing the feed supplies, not reported as having none', async () => {
  const { app } = makeApp(); // the demo feed publishes SIM-ON (a simulated overnight rate) for every US business day
  const { book, acct } = makeBook(app);
  const leg = loanLeg(300_000, { rateType: 'floating', referenceRate: 'SIM-ON', spread: 0.015 });
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg] });
  assert.equal(pv.checks.filter((c) => c.code === 'no-rate').length, 0, 'the fixing was asked for before the preview said there was none');
  const fixing = pv.legs[0].financing.fixing;
  assert.equal(typeof fixing, 'number');
  // One day of interest: principal x (fixing + spread) / 360.
  assert.equal(pv.legs[0].dailyCost, Math.round(300_000 * (fixing / 100 + 0.015) / 360 * 100) / 100);
});

test('without a fixing, a floating loan\'s interest payment waits (blocked) and repayment is refused; fixings entered by hand release both', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const fix = (date, value) => app.data.enterManual({ kind: 'rate', subject: 'TESTFIX', value, forDate: date, units: 'percent p.a.' });
  fix('2026-03-02', 5); // the only fixing: it covers 2 to 9 March (a fixing is used for at most a week)
  // 360,000 at TESTFIX flat, open-ended (interest monthly): 360,000 x 0.05 / 360 = 50.00 a day.
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loanLeg(360_000, { rateType: 'floating', referenceRate: 'TESTFIX', spread: 0 })] });
  const pos = s.positions.find((p) => p.family === 'loan');
  const accrued = () => 0 - app.ledger.positionBalance(pos.positionId, 'accrued.liab', 'USD') || 0;
  const task = () => app.tasks.open([acct.id]).find((t) => t.type === 'loan.interest');

  // Wednesday 1 April, 10:00: interest stopped at 10 March (2 to 9 March, 8 days, 400.00); the payment due today waits.
  await goTo(app, clock, '2026-04-01T14:00:00.000Z');
  assert.equal(accrued(), 400);
  assert.equal(task().status, 'blocked');
  assert.match(task().blocked_reason, /waiting for a TESTFIX fixing: none is available from 2026-03-10/);
  assert.equal(app.ledger.balance(acct.id, 'cash', 'USD'), 860_000, 'nothing was paid on interest that cannot be worked out');
  for (const qty of [360_000, 100_000]) {
    const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, legs: [repayLeg(pos, qty)] });
    assert.equal(pv.blocking, 1, `a repayment of ${qty} is refused`);
    assert.match(pv.checks.find((c) => c.level === 'error').message, /no TESTFIX fixing from 2026-03-10\. Enter the fixing by hand or set the rate before repaying\./);
  }

  // The fixings are entered by hand, 4.00% each Monday: 10 to 31 March, 22 days x 40.00 = 880.00. The next cycle pays
  // 400.00 + 880.00 = 1,280.00.
  for (const d of ['2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']) fix(d, 4);
  await goTo(app, clock, '2026-04-01T15:00:00.000Z');
  assert.equal(accrued(), 0);
  assert.equal(app.ledger.balance(acct.id, 'cash', 'USD'), 860_000 - 1_280);
  assert.equal(task().due_date, '2026-05-01', 'the next payment is scheduled');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a product that exists on one side only is refused on the other: no lending under a facility, no borrowing a deposit', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const leg = (productId, action, loanType) => ({ ...loanLeg(10_000, { rate: 0.05, maturity: '2026-06-01', loanType }), action, contract: { ...loanLeg(10_000, {}).contract, productId, terms: { loanType, rateType: 'fixed', rate: 0.05, dayCount: 'ACT/360', maturity: '2026-06-01' } } });
  const errors = async (l) => (await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [l] })).checks.filter((c) => c.level === 'error').map((c) => c.message);
  assert.match((await errors(leg('revolving_credit_facility', 'lend_cash', 'facility'))).join(' '), /A margin loan or a credit facility drawing is borrowed, not lent\./);
  assert.match((await errors(leg('margin_loan', 'lend_cash', 'margin'))).join(' '), /borrowed, not lent/);
  assert.match((await errors(leg('term_deposit', 'borrow_cash', 'deposit'))).join(' '), /A deposit or certificate of deposit is placed \(lent\), not borrowed\./);
  assert.deepEqual(await errors(leg('revolving_credit_facility', 'borrow_cash', 'facility')), [], 'the side the product exists on is accepted');
  assert.deepEqual(await errors(leg('term_deposit', 'lend_cash', 'deposit')), []);
});
