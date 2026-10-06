// Accounting-focused reconciliation tests.
//
// These check that the financial records agree with each other, not that screens render:
// borrowing shows once however it is viewed, internal transfers cancel in consolidation, a hedge
// preview's totals are the sum of its legs and what executes is what was shown, gross holdings are
// never netted away, and settlement follows real market and currency calendars.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo, DAY } from '../helpers.js';
import { fxValueDate, holidaysOf, isBusinessDay } from '../../server/quant/calendar.js';

const pin = (app, id, px, size = 1e6) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: size, askSize: size });
const near = (a, b, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const line = (bs, key) => bs.lines.find((l) => l.key === key);
const rcOf = (bs, key, unitId) => line(bs, key)?.cells[unitId]?.rc ?? 0;
const loanLeg = (ccy, qty, extra = {}) => ({
  kind: 'loan', action: 'borrow_cash', qty, purpose: 'financing',
  contract: { productId: 'unsecured_loan', name: `${ccy} loan`, marketView: ccy === 'USD' ? 'US_CASH' : 'FOREIGN_CASH', venueType: 'otc', tradingCcy: ccy, terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.06, maturity: '2026-09-01', counterparty: 'Example Bank', ...extra } },
});

// ---- calendars ---------------------------------------------------------------------------------------------

test('foreign markets and currencies settle on their own holiday calendars, not on weekends only', async () => {
  assert.deepEqual(holidaysOf('UK', 2026), ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']);
  assert.deepEqual(holidaysOf('TARGET', 2026), ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25']);
  for (const d of ['2026-01-02', '2026-05-04', '2026-05-05', '2026-05-06', '2026-09-21', '2026-09-22', '2026-09-23', '2026-12-31']) assert.equal(isBusinessDay(d, 'JP'), false, `${d} is a Tokyo holiday`);
  assert.equal(isBusinessDay('2026-07-03', 'USD'), true, 'the Fed does not move a Saturday holiday to Friday');
  assert.equal(isBusinessDay('2026-07-03', 'US'), false, 'NYSE observes Independence Day on the Friday');
  // USD/JPY dealt on Thursday 30 April 2026: Golden Week pushes the value date to 7 May.
  assert.equal(fxValueDate('2026-04-30', 'USD', 'JPY', 2).date, '2026-05-07');
  // EUR/USD dealt on 23 December: Christmas Day is skipped.
  assert.equal(fxValueDate('2026-12-23', 'EUR', 'USD', 2).date, '2026-12-28');
  assert.deepEqual(fxValueDate('2026-03-02', 'USD', 'CHF', 2).missing, ['CHF'], 'a currency with no calendar is named, not silently treated as weekends');

  const { app, clock, inst } = makeApp({ at: '2026-04-30T02:00:00.000Z' }); // 30 April in Tokyo hours, still 29 April in New York
  const { book, acct } = makeBook(app);
  await goTo(app, clock, '2026-04-30T15:00:00.000Z');
  // The demo Tokyo stock settles T+2 on the Tokyo calendar: 1 May, then Golden Week, then 7 May.
  const kaij = app.instruments.toView(inst.KAIJ);
  assert.equal(kaij.venueCountry, 'JP');
  assert.equal(kaij.calendar.id, 'JP');
  assert.equal(kaij.calendar.fallback, false);
  pin(app, inst['USD/JPY'].id, 150);
  app.data.market.set('USD/JPY', { value: 150 }); app.data.market.set('JPY/USD', { value: 1 / 150 });
  const fx = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: inst['USD/JPY'].id, qty: 100_000 }] });
  assert.equal(fx.legs[0].settleDate, '2026-05-07');
  pin(app, inst.KAIJ.id, 3000);
  const eq = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.KAIJ.id, quantity: 100 });
  assert.equal(eq.legs[0].settleDate, '2026-05-07', 'T+2 skips 4, 5 and 6 May');
  assert.ok(!eq.checks.some((c) => c.code === 'calendar-fallback'));

  // A market with no built-in calendar says so in the preview instead of quietly using weekends.
  const br = app.instruments.create({ productId: 'common_stock', name: 'Exemplo SA', symbol: 'EXSA', marketView: 'FOREIGN_CASH', venue: 'B3', venueType: 'exchange', venueCountry: 'BR', tradingCcy: 'BRL' });
  assert.equal(app.instruments.toView(br).calendar.fallback, true);
  pin(app, br.id, 20);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: br.id, quantity: 10 });
  assert.ok(pv.checks.some((c) => c.code === 'calendar-fallback' && /weekends only/.test(c.message)));
  // A holiday entered by hand is honoured.
  const { setExtraHolidays } = await import('../../server/quant/calendar.js');
  setExtraHolidays({ JP: ['2026-05-07'] });
  assert.equal(fxValueDate('2026-04-30', 'USD', 'JPY', 2).date, '2026-05-08');
  setExtraHolidays({});
});

// ---- borrowing ------------------------------------------------------------------------------------------------

test('an Account-originated borrowing is one record, seen on the Account, in Treasury oversight and once in the Book', async () => {
  const { app, clock } = makeApp();
  const { book, acct, treasury } = makeBook(app, { cash: 1_000_000, account: 300_000 });
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', name: 'Account borrowing', legs: [loanLeg('USD', 200_000)] });
  assert.equal(s.orders[0].status, 'filled', 'an Account can borrow directly; borrowing is not restricted to Treasury');

  // One authoritative record.
  const reg = app.accounting.borrowings(book.id, 'book');
  assert.equal(reg.length, 1);
  const b = reg[0];
  assert.ok(b.id && b.contractId);
  assert.deepEqual([b.owner.id, b.originatedBy, b.accountOriginated], [acct.id, 'account', true]);
  assert.deepEqual([b.lender, b.ccy, b.principal, b.rate.text, b.maturity, b.collateral.kind], ['Example Bank', 'USD', 200_000, '6.000% fixed', '2026-09-01', 'none']);
  assert.equal(b.schedule.interest, 'Interest paid at maturity');
  assert.equal(b.schedule.next.date, '2026-09-01');

  // The Account's balance sheet carries the liability.
  const a = app.accounting.balanceSheet(book.id, acct.id);
  assert.equal(rcOf(a, 'borrowed', acct.id), 200_000);
  assert.equal(a.borrowings[0].id, b.id);

  // Treasury's own balance sheet does not: the borrowing appears only in its oversight view,
  // identified as Account-originated, and it is the same record.
  const t = app.accounting.balanceSheet(book.id, 'treasury');
  assert.equal(line(t, 'borrowed'), undefined, 'no second liability is created in Treasury');
  assert.equal(t.borrowings.length, 0);
  assert.deepEqual(t.oversight.accountBorrowings.map((x) => [x.id, x.accountOriginated]), [[b.id, true]]);
  assert.equal(t.oversight.accounts[0].cashBorrowed.rc, 200_000);
  const tv = app.accounting.treasury(book.id);
  assert.deepEqual([tv.borrowings.direct.length, tv.borrowings.accountOriginated[0].id], [0, b.id]);

  // The consolidated Book counts the external principal exactly once.
  const k = app.accounting.balanceSheet(book.id, 'book');
  assert.equal(rcOf(k, 'borrowed', treasury.id), 0);
  assert.equal(rcOf(k, 'borrowed', acct.id), 200_000);
  assert.equal(line(k, 'borrowed').total.rc, 200_000);
  assert.equal(app.ledger.balance([treasury.id, acct.id], 'loan.liab', 'USD'), -200_000);
  assert.equal(k.netAssets.total.rc, 1_000_000, 'borrowing adds cash and an equal liability: net assets are unchanged');
  assert.equal(k.nav.value, k.netAssets.total.rc);

  // Interest accrues once: on the Account, therefore once in the Book, never in Treasury.
  await advance(app, clock, 10 * DAY);
  const exp = (scope) => app.accounting.pnl(book.id, scope).categories.find((c) => c.key === 'borrowFunding').rc;
  const accrued = app.accounting.borrowings(book.id, 'book')[0].accrued;
  assert.ok(accrued > 0);
  assert.equal(exp(acct.id), -accrued);
  assert.equal(exp('treasury'), 0);
  assert.equal(exp('book'), -accrued);
  const k2 = app.accounting.balanceSheet(book.id, 'book');
  assert.equal(line(k2, 'accruedExpense').total.rc, accrued);
  assert.equal(app.accounting.borrowings(book.id, 'book')[0].interestToDate, accrued);

  // Moving the proceeds to Treasury is its own internal transfer. It does not move the liability,
  // and the internal balances cancel in consolidation.
  const before = app.accounting.balanceSheet(book.id, 'book').netAssets.total.rc;
  app.books.transfer({ bookId: book.id, fromUnitId: acct.id, toUnitId: treasury.id, ccy: 'USD', amount: 200_000, purpose: 'Loan proceeds to Treasury' });
  const k3 = app.accounting.balanceSheet(book.id, 'book');
  assert.equal(rcOf(k3, 'cash', treasury.id), 900_000);
  assert.equal(rcOf(k3, 'borrowed', acct.id), 200_000, 'the liability stays with the Account that owes it');
  assert.equal(rcOf(k3, 'borrowed', treasury.id), 0);
  const internal = k3.representedBy.find((x) => x.key === 'internal');
  assert.equal(internal.cells[acct.id].rc, 100_000, 'the Account has net funding of 300,000 received less 200,000 sent back');
  assert.equal(internal.cells[treasury.id].rc, -100_000);
  assert.equal(internal.total.rc, 0);
  assert.deepEqual(internal.residual, []);
  assert.equal(k3.netAssets.total.rc, before, 'an internal transfer changes nothing in the Book total');
  const moved = app.accounting.history(book.id, 'book', { type: 'transfer' }).events[0];
  assert.equal(moved.type, 'transfer.return');
  assert.equal(app.accounting.borrowings(book.id, 'book').length, 1, 'still one borrowing');

  // Every column obeys net assets = capital + internal funding + results, and the Book is the sum of its parts.
  for (const col of k3.columns) {
    const parts = k3.representedBy.reduce((x, r) => x + r.cells[col.id].rc, 0);
    near(k3.netAssets.cells[col.id].rc, parts);
  }
  near(k3.netAssets.total.rc, k3.columns.reduce((x, c) => x + k3.netAssets.cells[c.id].rc, 0));
  near(k3.netAssets.total.rc, app.accounting.balanceSheet(book.id, 'treasury').netAssets.total.rc + app.accounting.balanceSheet(book.id, acct.id).netAssets.total.rc);

  // Repayment by the Account that owes it removes the one record everywhere.
  const pos = app.positions.get(b.id);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'close', legs: [{ kind: 'repay', action: 'repay_cash', targetPositionId: pos.id, qty: 200_000, purpose: 'financing' }] });
  assert.equal(app.accounting.borrowings(book.id, 'book').length, 0);
  assert.equal(app.ledger.balance([treasury.id, acct.id], 'loan.liab', 'USD'), 0);
  assert.equal(app.accounting.balanceSheet(book.id, 'treasury').oversight.accountBorrowings.length, 0);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('Treasury and Account borrowings in two currencies consolidate without double counting', async () => {
  const { app, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app, { cash: 1_000_000, account: 300_000 });
  app.data.market.set('JPY/USD', { value: 1 / 150 }); app.data.market.set('USD/JPY', { value: 150 });
  pin(app, inst['USD/JPY'].id, 150);
  await app.data.refresh({ pairs: ['JPY/USD'] });
  await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [loanLeg('USD', 500_000)] });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loanLeg('JPY', 30_000_000)] });
  const reg = app.accounting.borrowings(book.id, 'book');
  assert.equal(new Set(reg.map((b) => b.id)).size, 2);
  assert.deepEqual(reg.map((b) => [b.owner.kind, b.accountOriginated, b.ccy, b.principal]).sort(), [['account', true, 'JPY', 30_000_000], ['treasury', false, 'USD', 500_000]]);
  const k = app.accounting.balanceSheet(book.id, 'book');
  const borrowed = line(k, 'borrowed');
  assert.deepEqual(borrowed.total.byCurrency, [{ ccy: 'USD', amount: 500_000 }, { ccy: 'JPY', amount: 30_000_000 }]);
  assert.equal(borrowed.total.rc, 700_000, '500,000 USD plus 30,000,000 JPY at 150');
  assert.equal(borrowed.cells[treasury.id].rc, 500_000, "Treasury's direct borrowing only");
  assert.equal(borrowed.cells[acct.id].rc, 200_000);
  const t = app.accounting.balanceSheet(book.id, 'treasury');
  assert.equal(line(t, 'borrowed').total.rc, 500_000, "Treasury's own balance sheet excludes the Account's loan");
  assert.equal(t.oversight.accountBorrowings.length, 1);
  assert.equal(t.oversight.accountBorrowings[0].principal, 30_000_000);
  assert.equal(k.netAssets.total.rc, 1_000_000);
});

test('internal transfers cancel in the Book and inside a group of Accounts', async () => {
  const { app } = makeApp();
  const { book, acct, treasury } = makeBook(app, { cash: 1_000_000, account: 300_000 });
  const beta = app.books.createAccount(book.id, { name: 'Beta' });
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: beta.id, ccy: 'USD', amount: 150_000 });
  app.books.transfer({ bookId: book.id, fromUnitId: acct.id, toUnitId: beta.id, ccy: 'USD', amount: 40_000, purpose: 'Account to Account' });
  const k = app.accounting.balanceSheet(book.id, 'book');
  const internal = k.representedBy.find((x) => x.key === 'internal');
  assert.deepEqual([internal.cells[treasury.id].rc, internal.cells[acct.id].rc, internal.cells[beta.id].rc], [-450_000, 260_000, 190_000]);
  assert.equal(internal.total.rc, 0);
  assert.equal(internal.elimination.rc, 0, 'what Treasury advanced equals what the Accounts received');
  assert.equal(k.netAssets.total.rc, 1_000_000);
  // Two Accounts together: the transfer between them nets out; only funding from outside the pair remains.
  const pair = app.accounting.balanceSheet(book.id, `${acct.id},${beta.id}`);
  assert.deepEqual(pair.columns.map((c) => c.name), ['Alpha', 'Beta']);
  assert.equal(pair.representedBy.find((x) => x.key === 'internal').total.rc, 450_000);
  assert.equal(pair.netAssets.total.rc, 450_000);
  assert.equal(pair.consolidated, false);
  assert.equal(app.accounting.pnl(book.id, `${acct.id},${beta.id}`).capital.net, 450_000, 'capital flows of the pair exclude the transfer between them');
  assert.equal(app.accounting.pnl(book.id, 'book').capital.net, 1_000_000);
  // A scope cannot name anything outside its Book.
  const other = app.books.createBook({ name: 'Other Book', reportingCcy: 'USD' });
  assert.throws(() => app.books.scopeUnits(book.id, app.books.treasuryOf(other.id).id), /Unknown accounting scope/);
  assert.deepEqual(app.accounting.balanceSheet(other.id, 'book').lines, [], 'another Book is its own workspace and sees none of this');
});

// ---- hedge costs ----------------------------------------------------------------------------------------------------

test('a hedge preview is one snapshot: totals are the sum of its legs, and what executes is what was shown', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 160);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300, origin: 'marketplace' });
  await advance(app, clock, 1000);
  const h = app.hedge.prompts(book.id)[0];
  const pkg = h.response.packages.find((p) => p.id === 'demo-protective');
  const pv = await app.hedge.previewPackage(h.id, pkg.id);
  const usd = pv.totals.cash.USD;
  const leg = pv.legs[0];
  // Leg: premium is quantity x multiplier x the estimated fill; fees are separate and additional.
  near(-leg.cash, leg.qty * leg.multiplier * leg.price.estimate, 0.005);
  assert.equal(leg.feeTotal, 1.95, '3 contracts at 0.65');
  // Totals derive from the legs and from nothing else.
  near(usd.purchases, pv.legs.reduce((a, l) => a + Math.max(0, -(l.cash || 0)), 0), 0.005);
  near(usd.fees, pv.legs.reduce((a, l) => a + (l.feeTotal || 0), 0), 0.005);
  near(usd.required, usd.purchases + usd.fees + usd.margin + usd.collateral + usd.reserved + usd.financingOut, 0.005);
  near(pv.totals.netPremium.amount, -leg.cash, 0.005);
  // The estimate that came with the recommendation is on the same executable side of the same quote.
  near(pkg.costs.premiums, -leg.cash, 0.005);

  // Executing the displayed package moves exactly the cash that was shown.
  const beforeCash = app.ledger.cash(acct.id, 'USD').availableToTrade;
  const out = await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: { cash: { USD: usd.required } } });
  const order = out.strategy.orders.find((o) => o.submission === pv.token);
  assert.equal(order.status, 'filled');
  const fill = order.fills[0];
  near(fill.gross, -leg.cash, 0.005);
  near(fill.fees.reduce((a, f) => a + f.amount, 0), leg.feeTotal, 0.005);
  near(beforeCash - app.ledger.cash(acct.id, 'USD').availableToTrade, usd.required, 0.005);
  assert.ok(fill.priceObservation, 'the quote used for the fill is kept');
  const cost = app.accounting.history(book.id, acct.id).events.find((e) => e.orderId === order.id && e.type === 'trade.fill');
  near(-cost.entries.filter((e) => ['pay.settle', 'cash'].includes(e.account)).reduce((a, e) => a + e.amount, 0), usd.required, 0.005);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a confirmation is refused when prices have moved away from the figures that were displayed', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000 });
  assert.equal(pv.totals.cash.USD.required, 100_000);
  pin(app, inst.ALFA.id, 103); // 3% away from what was shown
  await assert.rejects(
    () => app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: { cash: { USD: pv.totals.cash.USD.required } } }),
    (err) => err.code === 'preview_changed' && err.details.preview.totals.cash.USD.required === 103_000,
  );
  assert.equal(app.packages.listStrategies({ bookId: book.id }).length, 0, 'nothing was submitted');
  // Within the tolerance the displayed package is accepted.
  pin(app, inst.ALFA.id, 100.2);
  const out = await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: { cash: { USD: pv.totals.cash.USD.required } } });
  assert.equal(out.strategy.orders[0].status, 'filled');
});

// ---- duplicate protection -----------------------------------------------------------------------------------------------

test('protection already in the template or the position is recognised; more must be deliberate and is measured against what remains', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app, { cash: 2_000_000, account: 1_000_000 });
  pin(app, inst.ALFA.id, 190);
  const chain = (await app.data.market.optionChain(inst.ALFA, {})).chain;
  const exp = chain.expirations[2];
  const strikes = (await app.data.market.optionChain(inst.ALFA, { expiration: exp })).chain.strikes;
  const lo = strikes.filter((k) => k < 190).at(-2), hi = strikes.filter((k) => k > 190)[1];
  const collar = { bookId: book.id, unitId: acct.id, template: 'long_collar', underlyingId: inst.ALFA.id, quantity: 1000, options: { expiration: exp, strikes: { put: lo, call: hi } }, origin: 'strategy_page' };
  const ctx = { investmentStrategy: { name: 'Quality Compounders' }, holdingPeriod: { days: 60 }, objective: { type: 'downside_protection' } };

  // The request tells Shaffer Hedge about the collar's own put, and the fixture proposes nothing further for price risk.
  const withCollar = await app.hedge.request({ bookId: book.id, unitId: acct.id, scope: { type: 'trade' }, trigger: 'strategy_page', instrumentId: inst.ALFA.id, ...ctx, package: collar });
  assert.equal(withCollar.request.proposedLegs.filter((l) => l.isProtection).length, 2);
  assert.equal(withCollar.response.packages.length, 0);
  assert.match(withCollar.message, /already protected/);

  // If a put package is added to the collar anyway, the preview blocks it until it is confirmed as deliberate.
  const plain = await app.hedge.request({ bookId: book.id, unitId: acct.id, scope: { type: 'trade' }, trigger: 'manual', instrumentId: inst.ALFA.id, quantity: 1000, direction: 'long', ...ctx });
  const put = plain.response.packages.find((p) => p.id === 'demo-protective');
  const blocked = await app.packages.preview({ ...collar, ...ctx, hedgeLinkId: plain.id, hedgePackageId: put.id, appendHedge: true });
  const chk = blocked.checks.find((c) => c.code === 'extra-protection');
  assert.equal(chk.level, 'error');
  assert.match(chk.message, /exposure in ALFA is 1,000 units, of which 1,000 are already protected, leaving 0; the package adds puts on 1,000/);
  assert.equal(blocked.protection.needsAcknowledgement, true);
  const deliberate = await app.packages.preview({ ...collar, ...ctx, hedgeLinkId: plain.id, hedgePackageId: put.id, appendHedge: true, extraProtection: true });
  assert.equal(deliberate.blocking, 0);
  assert.equal(deliberate.checks.find((c) => c.code === 'extra-protection').level, 'warning');

  // A plain long has no protection, so the same package is accepted without ceremony.
  const clean = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000, ...ctx, hedgeLinkId: plain.id, hedgePackageId: put.id, appendHedge: true });
  assert.equal(clean.blocking, 0);
  assert.ok(!clean.checks.some((c) => c.code === 'extra-protection'));

  // A position half protected: the fixture sizes the next proposal on the unprotected remainder only.
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000, origin: 'marketplace' });
  await advance(app, clock, 1000);
  const first = app.hedge.prompts(book.id)[0];
  const pv = await app.hedge.previewPackage(first.id, 'demo-protective');
  const half = pv.legs.map((l) => ({ ...l, qty: 5 }));
  await app.packages.submit({ ...pv.input, legs: half, clientToken: pv.token, confirm: true });
  const again = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: s.id, scope: { type: 'trade' }, trigger: 'manual', ...ctx });
  assert.equal(again.request.existingHedges.length, 1);
  const next = again.response.packages.find((p) => p.id === 'demo-protective');
  assert.equal(next.legs[0].quantity, 5, '1,000 held, 500 already protected, 5 contracts for the remaining 500');
  assert.match(next.notes.join(' '), /unprotected remainder: 500 of 1000/);
  const more = await app.hedge.previewPackage(again.id, next.id);
  assert.equal(more.checks.find((c) => c.code === 'extra-protection').level, 'error', 'even a correctly sized top-up has to be confirmed as deliberate');
  assert.match(more.checks.find((c) => c.code === 'extra-protection').message, /of which 500 are already protected, leaving 500; the package adds puts on 500/);
});

// ---- holdings -------------------------------------------------------------------------------------------------------------

test('gross holdings: long, short and net are reported separately, with the owning Account', async () => {
  const { app, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app);
  pin(app, inst.ALFA.id, 100);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 200 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  await trade(app, { bookId: book.id, unitId: treasury.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 50 });
  const h = app.accounting.openPositions(book.id, 'book').holdings.find((x) => x.instrument.id === inst.ALFA.id);
  assert.deepEqual([h.long, h.short, h.net], [250, 100, 150]);
  assert.deepEqual(h.owners.map((o) => [o.name, o.long, o.short, o.net]).sort(), [['Alpha', 200, 100, 100], ['Treasury', 50, 0, 50]]);
  const own = app.accounting.openPositions(book.id, acct.id).holdings.find((x) => x.instrument.id === inst.ALFA.id);
  assert.deepEqual([own.long, own.short, own.net], [200, 100, 100], 'the long holding is 200, not the net 100');
});

// ---- settlement and valuation ---------------------------------------------------------------------------------------------

test('a purchase that settles before its funding arrives fails visibly, then settles; nothing is funded silently', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app, { cash: 1_000_000, account: 100_000 });
  pin(app, inst['USD/JPY'].id, 150);
  app.data.market.set('USD/JPY', { value: 150 }); app.data.market.set('JPY/USD', { value: 1 / 150 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [loanLeg('JPY', 15_000_000, { maturity: null }), { kind: 'trade', action: 'buy', instrumentId: inst['USD/JPY'].id, qty: 100_000, dependsOn: [1] }] });
  pin(app, inst.ALFA.id, 100);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1500 });
  assert.equal(s.orders[0].fills[0].settleDate, '2026-03-03');
  await goTo(app, clock, '2026-03-03T15:00:00.000Z');
  const failed = app.accounting.failed(book.id, acct.id).settlementFailures;
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /Insufficient settled USD cash: 100,000\.00 USD available, 150,000\.00 USD due/);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 100_000, 'cash did not go negative to cover it');
  await goTo(app, clock, '2026-03-04T15:00:00.000Z');
  assert.equal(app.accounting.failed(book.id, acct.id).settlementFailures.length, 0);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 50_000);
  assert.equal(app.ledger.cash(acct.id, 'USD').payable, 0);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('NAV is provisional when a position has no price, a mark is stale or a conversion rate is missing, and says which', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 100 });
  assert.equal(app.accounting.openPositions(book.id, 'book').nav.provisional, false);
  // A holding with no price source.
  const priv = app.instruments.create({ productId: 'common_stock', name: 'Unquoted Co', symbol: 'UNQ', marketView: 'US_CASH', venue: 'NYSE', tradingCcy: 'USD' });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: priv.id, qty: 10, statedPrice: 50 }] });
  let nav = app.accounting.openPositions(book.id, 'book').nav;
  assert.equal(nav.provisional, true);
  assert.deepEqual(nav.affected.map((x) => [x.kind, x.instrument.symbol, x.owner]), [['unpriced', 'UNQ', 'Alpha']]);
  assert.equal(app.accounting.overview(book.id).navProvisional, true);
  assert.equal(app.accounting.balanceSheet(book.id, 'book').nav.provisional, true);
  // A manual mark values it; the NAV is no longer provisional.
  app.data.enterManual({ kind: 'price', subject: priv.id, value: 55, currency: 'USD' });
  assert.equal(app.accounting.openPositions(book.id, 'book').nav.provisional, false);
  // A mark that has gone stale keeps its value but makes the NAV provisional again.
  const eod = app.instruments.create({ productId: 'common_stock', name: 'Slow Co', symbol: 'SLOW', marketView: 'US_CASH', venue: 'NYSE', tradingCcy: 'USD' });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: eod.id, qty: 10, statedPrice: 20 }] });
  app.data.market.set(eod.id, { value: 21, bid: 21, ask: 21 });
  await app.data.refresh({ instruments: [eod] });
  assert.equal(app.accounting.openPositions(book.id, 'book').nav.provisional, false);
  clock.advance(2 * 3600e3);
  nav = app.accounting.openPositions(book.id, 'book').nav;
  assert.equal(nav.provisional, true);
  assert.ok(nav.affected.some((x) => x.kind === 'stale-price' && x.instrument.symbol === 'SLOW'));
  assert.equal(nav.complete, true, 'a stale mark still values the position; the figure is provisional, not incomplete');
});

// ---- hedge waiting workflow -----------------------------------------------------------------------------------------------

test('a hedge request made while Analytics Lab is away waits, then refreshes in place against current exposure without trading', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  app.data.setSetting('demo.hedgeFixture', false); // the service is unavailable
  pin(app, inst.ALFA.id, 100);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300, origin: 'marketplace' });
  await advance(app, clock, 1000);
  const prompts = app.hedge.prompts(book.id);
  assert.equal(prompts.length, 1, 'the popup is prompted even though there is nothing to recommend yet');
  assert.equal(prompts[0].status, 'awaiting');
  const id = prompts[0].id;
  assert.deepEqual(app.hedge.queue(book.id).items.map((x) => [x.id, x.status, x.owner]), [[id, 'awaiting', 'Alpha']]);
  assert.equal(app.accounting.openPositions(book.id, acct.id).positions[0].hedgeRequest.id, id, 'the request stays visible on the position');
  await advance(app, clock, 10 * 60e3, { ticks: 3 });
  assert.equal(app.hedge.list(book.id).length, 1, 'waiting does not pile up duplicate requests');

  // The position grows while the request waits.
  const grow = await app.packages.previewAction(s.id, 'resize', { factor: 2 });
  await app.packages.submit({ ...grow.input, legs: grow.legs, clientToken: grow.token, confirm: true });
  const ordersBefore = app.orders.forStrategy(s.id).length;

  // The service comes back: the same request is refreshed against the position as it is now.
  app.data.setSetting('demo.hedgeFixture', true);
  await advance(app, clock, 3000);
  const all = app.hedge.list(book.id);
  assert.equal(all.length, 1, 'refreshed in place, not duplicated');
  assert.equal(all[0].id, id);
  assert.equal(all[0].status, 'received');
  assert.equal(all[0].request.primary.quantity, 600, 'sized on current exposure, not the exposure when first asked');
  assert.equal(all[0].response.packages.find((p) => p.id === 'demo-protective').legs[0].quantity, 6);
  assert.equal(app.orders.forStrategy(s.id).length, ordersBefore, 'nothing was traded automatically');
  assert.ok(app.alerts.open(book.id).some((a) => a.code === 'hedge.ready'));
  assert.equal(app.hedge.queue(book.id).items[0].packages > 0, true);
  // Acting on it clears it from the queue.
  app.hedge.dismiss(id);
  assert.equal(app.hedge.queue(book.id).items.length, 0);
  assert.ok(!app.alerts.open(book.id).some((a) => a.code === 'hedge.ready'));
});

// ---- TRS alternative ------------------------------------------------------------------------------------------------------

test('the TRS alternative is a complete swap: both legs, posted collateral, resets, cash flows and accounting', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 200);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 500, origin: 'marketplace' });
  await advance(app, clock, 1000);
  const h = app.hedge.prompts(book.id)[0];
  const pv = await app.hedge.previewPackage(h.id, 'demo-trs');
  const leg = pv.legs[0];
  const terms = Object.fromEntries(leg.instrument.details);
  assert.match(terms['Leg A'], /Pay total return on ALFA/);
  assert.match(terms['Leg B'], /Receive SIM-ON \+ 0\.50% USD/);
  assert.match(terms['Collateral terms'], /Independent amount of 10\.00% of notional/);
  assert.equal(leg.notional, 100_000);
  assert.equal(leg.initialMargin, 10_000, 'collateral is a share of notional, so it is known before any price');
  assert.equal(pv.totals.cash.USD.margin, 10_000);
  assert.equal(pv.totals.cash.USD.required, 10_000);
  // Indicative terms are not an executable quote: the swap is entered at a stated price of zero upfront.
  const out = await app.packages.submit({ ...pv.input, legs: pv.legs.map((l) => ({ ...l, statedPrice: 0 })), clientToken: pv.token, confirm: true });
  const swap = out.strategy.positions.find((p) => p.family === 'swap');
  assert.equal(swap.purpose, 'hedge');
  assert.equal(swap.marginPosted, 10_000);
  assert.equal(app.ledger.balance(acct.id, 'cash.margin', 'USD'), 10_000);
  const bs = app.accounting.balanceSheet(book.id, acct.id);
  assert.equal(rcOf(bs, 'margin', acct.id), 10_000, 'posted collateral stays an asset of the Account');
  const cashAfterEntry = app.ledger.cash(acct.id, 'USD').settled;

  // First quarterly reset: the Account pays the total return on ALFA and receives SIM-ON + 0.50%.
  const first = app.tasks.open([acct.id]).filter((t) => t.type === 'swap.payment').sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  const end = first.data.periodEnd;
  app.data.market.set(`${inst.ALFA.id}@${end}`, { value: 210 });
  app.data.market.set('SIM-ON@2026-03-02', { value: 4.0 });
  await goTo(app, clock, `${first.due_date}T22:30:00.000Z`);
  const flows = app.accounting.history(book.id, acct.id, { type: 'swap.payment' }).events;
  assert.equal(flows.length, 2, 'one cash flow per leg');
  const ret = flows.find((e) => /leg A/.test(e.summary)), fin = flows.find((e) => /leg B/.test(e.summary));
  near(ret.cash[0].amount, -5000, 0.01); // +5% on 100,000, paid away
  assert.ok(fin.cash[0].amount > 0, 'the financing leg is received');
  assert.equal(app.positions.get(swap.positionId).data.legs.A.lastFixing, 210, 'the return leg reset to the new level');
  // The stock gained what the swap paid away: the hedge did its job, and both sides are in the P&L.
  const pnl = app.accounting.pnl(book.id, acct.id);
  assert.ok(pnl.categories.find((c) => c.key === 'realized').rc < 0);
  // Closing the swap returns the collateral.
  const close = await app.packages.previewAction(s.id, 'close', { positionIds: [swap.positionId] });
  await app.packages.submit({ ...close.input, legs: close.legs.map((l) => ({ ...l, statedPrice: 0 })), clientToken: close.token, confirm: true });
  assert.equal(app.ledger.balance(acct.id, 'cash.margin', 'USD'), 0);
  assert.ok(app.accounting.history(book.id, acct.id, { type: 'swap.collateral' }).events.length >= 2, 'collateral posted and returned are both in the audit trail');
  void cashAfterEntry;
  assert.deepEqual(ledgerImbalance(app), []);
});
