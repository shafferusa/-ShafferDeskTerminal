import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo, DAY } from '../helpers.js';

const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e9, askSize: 1e9 });
const near = (a, b, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('bond: clean price plus accrued, daily accrual into coupon income, coupon and redemption on schedule', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app, { account: 2_000_000, cash: 3_000_000 });
  // 4.25% semi-annual ACT/ACT, coupons 15 May / 15 Nov. Create a short-dated twin to see redemption.
  const b = app.instruments.create({ productId: 'treasury_note', name: 'Test 4% 15-May-2026', symbol: 'TEST26', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2, maturity: '2026-05-15', issueDate: '2021-05-15', dayCount: 'ACT/ACT' } });
  app.data.enterManual({ kind: 'price', subject: b.id, value: 99.5, currency: 'USD', units: '% of par (clean)' });
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: b.id, qty: 1_000_000 }] });
  const fill = s.orders[0].fills[0];
  assert.equal(fill.model, 'manual-mark');
  assert.equal(s.orders[0].avgPrice, 99.5 * 1.0003, 'manual mark plus the Book\'s assumed 3 bp half spread');
  // Settlement 3 March: 108 days into the 181-day period from 15 Nov 2025.
  const accrued = 1_000_000 * 0.02 * (108 / 181);
  near(app.ledger.balance(acct.id, 'accrued.asset', 'USD'), accrued);
  near(app.ledger.cash(acct.id, 'USD').payable, 1_000_000 * 0.995 * 1.0003 + accrued);
  const pos = s.positions[0];
  assert.equal(pos.notional, 1_000_000);
  near(pos.accrued, accrued);
  // Ten days later the accrual has grown and the growth is coupon income.
  await goTo(app, clock, '2026-03-12T22:30:00.000Z');
  near(app.ledger.balance(acct.id, 'accrued.asset', 'USD'), 1_000_000 * 0.02 * (117 / 181));
  let pnl = app.accounting.pnl(book.id, acct.id);
  near(pnl.categories.find((x) => x.key === 'couponInterest').rc, 1_000_000 * 0.02 * (9 / 181));
  // Maturity: final coupon 20,000 and redemption at par.
  await goTo(app, clock, '2026-05-15T22:30:00.000Z');
  const v = app.packages.strategyView(s.id);
  assert.equal(v.status, 'closed');
  pnl = app.accounting.pnl(book.id, acct.id);
  near(pnl.categories.find((x) => x.key === 'couponInterest').rc, 20_000 - accrued, 0.02);
  near(pnl.categories.find((x) => x.key === 'realized').rc, 1_000_000 * (1 - 0.995 * 1.0003), 0.02);
  near(app.ledger.balance(acct.id, 'accrued.asset', 'USD'), 0);
  near(app.ledger.cash(acct.id, 'USD').settled, 2_000_000 + pnl.investmentPnl, 0.02);
  assert.deepEqual(ledgerImbalance(app), []);
  const types = app.accounting.history(book.id, acct.id, { includeAccruals: true }).events.map((e) => e.type);
  assert.ok(types.includes('bond.coupon') && types.includes('bond.redemption') && types.includes('accrual.coupon'));
});

test('floating-rate note: a coupon without its fixing is blocked and says why', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const frn = app.instruments.create({ productId: 'floating_rate_note', name: 'Test FRN 2027', symbol: 'FRN27', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'float', referenceRate: 'XYZ-3M', spread: 0.01, frequency: 4, maturity: '2027-03-15', issueDate: '2025-03-15', dayCount: 'ACT/360' } });
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: frn.id, qty: 100_000, statedPrice: 100 }] });
  assert.equal(s.orders[0].fills[0].model, 'stated-price');
  await goTo(app, clock, '2026-03-16T15:00:00.000Z');
  const t = app.accounting.pending(book.id, acct.id).lifecycle.find((x) => x.type === 'bond.coupon');
  assert.equal(t.status, 'blocked');
  assert.match(t.reason, /Awaiting the XYZ-3M fixing/);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 400_000, 'no coupon cash was invented');
});

test('cash loan: interest accrues daily as funding expense and is paid on repayment', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const leg = { kind: 'loan', action: 'borrow_cash', qty: 360_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'Test loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.05, maturity: '2026-04-01' } } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg] });
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 860_000);
  assert.equal(app.accounting.overview(book.id).nav, 1_000_000, 'borrowed cash is a liability, not a gain');
  await goTo(app, clock, '2026-03-12T22:30:00.000Z');
  near(-app.ledger.balance(acct.id, 'accrued.liab', 'USD'), 360_000 * 0.05 * 10 / 360);
  near(app.accounting.pnl(book.id, acct.id).categories.find((x) => x.key === 'borrowFunding').rc, -500);
  await goTo(app, clock, '2026-04-01T22:30:00.000Z');
  assert.equal(app.packages.strategyView(s.id).status, 'closed');
  near(app.ledger.cash(acct.id, 'USD').settled, 500_000 - 360_000 * 0.05 * 30 / 360);
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'USD'), 0);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a loan that cannot be repaid at maturity fails visibly instead of overdrawing', async () => {
  const { app, clock } = makeApp();
  const { book, acct, treasury } = makeBook(app);
  const leg = { kind: 'loan', action: 'borrow_cash', qty: 100_000, contract: { productId: 'unsecured_loan', name: 'Test loan 2', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { rateType: 'fixed', rate: 0.05, maturity: '2026-03-10' } } };
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg] });
  app.books.transfer({ bookId: book.id, fromUnitId: acct.id, toUnitId: treasury.id, ccy: 'USD', amount: 600_000 });
  await goTo(app, clock, '2026-03-10T15:00:00.000Z');
  const f = app.accounting.failed(book.id, acct.id).lifecycleFailures;
  assert.equal(f.length, 1);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 0);
  assert.ok(app.alerts.open(book.id).some((a) => a.code === 'funding.failed'));
  // Funding the Account lets the next cycle repay.
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: acct.id, ccy: 'USD', amount: 200_000 });
  await advance(app, clock, 1000);
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'USD'), 0);
  assert.equal(app.alerts.open(book.id).some((a) => a.code === 'funding.failed'), false);
});

test('repo pledges collateral and repurchases with interest; reverse repo earns interest', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app, { cash: 3_000_000, account: 0 });
  const bond = inst.SIMGOV31;
  pin(app, bond.id, 100);
  const hold = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: bond.id, qty: 1_000_000 }] });
  await goTo(app, clock, '2026-03-03T15:00:00.000Z');
  const bondPos = hold.positions[0].positionId;
  const repoLeg = { kind: 'repo_open', action: 'repo', qty: 980_000, purpose: 'financing', collateralPositionId: bondPos, contract: { productId: 'term_repo', name: 'Repo SIMGOV31 7d', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { collateralInstrumentId: bond.id, collateralQty: 1_000_000, haircut: 0.02, rateType: 'fixed', rate: 0.045, term: 'term', endDate: '2026-03-10' } } };
  const cashBefore = app.ledger.cash(treasury.id, 'USD').settled;
  const s = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [repoLeg] });
  assert.equal(app.ledger.cash(treasury.id, 'USD').settled, cashBefore + 980_000);
  assert.equal(app.positions.get(bondPos).pledged_qty, 1_000_000);
  const tv = app.accounting.treasury(book.id);
  assert.equal(tv.collateralInventory[0].availableQty, 0, 'pledged collateral is no longer available');
  assert.equal(tv.arrangements.length, 1);
  // The pledged bond cannot be sold while it is on repo.
  const sell = await app.packages.previewAction(hold.id, 'close');
  const r = await app.packages.submit({ bookId: book.id, unitId: treasury.id, template: 'custom', attachTo: hold.id, intent: 'close', legs: sell.legs, clientToken: sell.token, confirm: true });
  assert.match(r.strategy.orders.at(-1).statusReason, /pledged/);
  await goTo(app, clock, '2026-03-10T22:30:00.000Z');
  assert.equal(app.packages.strategyView(s.id).status, 'closed');
  assert.equal(app.positions.get(bondPos).pledged_qty, 0);
  near(app.ledger.cash(treasury.id, 'USD').settled, cashBefore - 980_000 * 0.045 * 7 / 360 + 0, 0.02);
  near(app.accounting.pnl(book.id, treasury.id).categories.find((x) => x.key === 'borrowFunding').rc, -857.5, 0.02);
  // Reverse repo: lend cash against collateral received.
  const rev = { kind: 'repo_open', action: 'reverse_repo', qty: 500_000, contract: { productId: 'reverse_repo', name: 'Reverse repo SIMCORP29', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { collateralInstrumentId: inst.SIMCORP29.id, collateralQty: 520_000, haircut: 0.03, rateType: 'fixed', rate: 0.04, term: 'term', endDate: '2026-03-20' } } };
  await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [rev] });
  assert.equal(app.accounting.treasury(book.id).collateralReceived[0].qty, 520_000);
  await goTo(app, clock, '2026-03-20T22:30:00.000Z');
  near(app.accounting.pnl(book.id, treasury.id).categories.find((x) => x.key === 'couponInterest').byCurrency[0].amount > 0 ? 1 : 0, 1);
  assert.equal(app.ledger.balance(treasury.id, 'loan.asset', 'USD'), 0);
  assert.deepEqual(ledgerImbalance(app), []);
  void acct;
});

test('securities lending: shares go on loan, cash collateral is a liability, fee income accrues', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 200);
  const long = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000 });
  const src = long.positions[0].positionId;
  const leg = { kind: 'lend_sec', action: 'lend_sec', qty: 600, sourcePositionId: src, contract: { productId: 'securities_lending', name: 'Lend ALFA', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', underlyingId: inst.ALFA.id, terms: { feeRate: 0.036, collateralPct: 1.02 } } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', attachTo: long.id, legs: [leg] });
  assert.equal(app.positions.get(src).onloan_qty, 600);
  assert.equal(app.ledger.cash(acct.id, 'USD').restricted, 122_400, '102% of 600 x 200 held as restricted cash');
  assert.equal(app.ledger.balance(acct.id, 'coll.received', 'USD'), -122_400);
  assert.equal(app.accounting.overview(book.id).units.find((u) => u.id === acct.id).nav, 500_000, 'collateral received does not change NAV');
  await goTo(app, clock, '2026-03-12T22:30:00.000Z');
  near(app.accounting.pnl(book.id, acct.id).categories.find((x) => x.key === 'lendingIncome').rc, 600 * 200 * 0.036 * 10 / 360);
  // Only the 400 not on loan can be sold.
  const sell = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, legs: [{ kind: 'trade', action: 'sell', instrumentId: inst.ALFA.id, qty: 500 }] });
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, legs: sell.legs, clientToken: sell.token, confirm: true });
  assert.match(r.strategy.orders.at(-1).statusReason, /unencumbered/);
  assert.deepEqual(ledgerImbalance(app), []);
});
