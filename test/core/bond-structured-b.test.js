// Debt securities, structured group B (test/matrix/specs/bond-structured-b.mjs): regression and behaviour tests for what
// the second structured group of the product matrix needed. Figures are worked out by hand in the comments.
//
//   1. A floating coupon held in two positions was paid at the new period's rate to every holder after the first: the
//      first holder's payment resets the coupon rate to the next period's fixing, and the next holder's coupon was worked
//      out from the instrument's current rate. Found while building the PIK coupon of a CLO class (b4, clo).
//   2. Structured terms added for group B: servicing fee (ABS), stated pool characteristics (specified pool), sequential
//      priority (CMO), coupons paid in kind (CLO, CDO, PIK-toggle private credit).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../server/api.js';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';

const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e9, askSize: 1e9 });
const api = (app, method, path, body = {}) => {
  const r = createApi(app).match(method, path);
  return r.handler({ params: r.params, query: {}, body });
};
const lifecycle = (app, inst, body) => api(app, 'POST', `/api/instruments/${inst.id}/lifecycle`, body);
const events = (app, book, unit) => app.accounting.history(book.id, unit.id, { includeAccruals: true }).events;

test('floating coupon held in two positions: each holder is paid the rate of the period that ended, not the next one', async () => {
  const { app, clock } = makeApp({ at: '2027-01-04T15:00:00.000Z' }); // Monday 4 January 2027
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_500_000 });
  const frn = app.instruments.create({ productId: 'floating_rate_note', name: 'Test FRN', symbol: 'FRN29', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD',
    terms: { couponType: 'float', referenceRate: 'TESTRATE', spread: 0.01, currentCoupon: 0.06, frequency: 4, maturity: '2029-04-20', issueDate: '2024-04-20', dayCount: 'ACT/360' } });
  pin(app, frn.id, 100);
  // Two strategies, so two positions and two coupon items for the same coupon date.
  for (let i = 0; i < 2; i++) await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: frn.id, qty: 1_000_000 }] });
  // The next period's fixing: 4.00% + 1.00% = 5.00%.
  api(app, 'POST', '/api/demo/fixtures/rate', { code: 'TESTRATE', value: 4, date: '2027-01-20' });
  await goTo(app, clock, '2027-01-20T15:00:00.000Z');
  // 20 Oct 2026 to 20 Jan 2027 is 92 days at 6.00%: 1,000,000 x 6% x 92/360 = 15,333.33 to EACH holder (the second one was
  // paid 1,000,000 x 5% x 92/360 = 12,777.78 before the fix).
  const coupons = events(app, book, acct).filter((e) => e.type === 'bond.coupon');
  assert.equal(coupons.length, 2);
  for (const c of coupons) assert.match(c.summary, /: 15,333\.33 USD$/);
  // The new period runs at 5.00%.
  assert.equal(app.instruments.get(frn.id).terms.currentCoupon, 0.05);
  assert.deepEqual(ledgerImbalance(app), []);
});

const posLifecycle = (app, pos, body) => api(app, 'POST', `/api/positions/${pos.id}/lifecycle`, body);
const held = (app, unit, instId) => app.positions.list({ unitIds: [unit.id] }).filter((p) => p.instrument_id === instId);
const pv = (app, book, unit, inst, action, qty, extra = {}) => app.packages.preview({ bookId: book.id, unitId: unit.id, template: 'custom', legs: [{ kind: 'trade', action, instrumentId: inst.id, qty, ...extra }] });
const draftOf = (productId, symbol, terms) => ({ productId, name: `Test ${symbol}`, symbol, marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms });

test('servicing fee nets the coupon; sequential priority refuses a paydown until the senior class is retired; a PIK coupon is capitalised once for every holder', async () => {
  const { app, clock } = makeApp(); // Monday 2 March 2026
  const { book, acct } = makeBook(app, { cash: 10_000_000, account: 9_000_000 });
  // Servicing fee: gross 6.00% less 1.00%. Accrued to Tuesday 3 March (T+1) from 15 February, 30/360 18 days, at the NET 5.00%:
  // 1,000,000 x 5% x 18/360 = 2,500.00.
  assert.throws(() => app.instruments.create(draftOf('abs', 'ABSX', { couponType: 'fixed', couponRate: 0.06, servicingFeeRate: 0.06, frequency: 12, maturity: '2030-07-15', dayCount: '30/360' })), /below the gross coupon rate/);
  const abs = app.instruments.create(draftOf('abs', 'ABS30', { couponType: 'fixed', couponRate: 0.06, servicingFeeRate: 0.01, frequency: 12, maturity: '2030-07-15', dayCount: '30/360' }));
  pin(app, abs.id, 100);
  assert.equal((await pv(app, book, acct, abs, 'buy', 1_000_000)).legs[0].accrued, 2_500);

  // Sequential CMO class behind Class A1 (2,000,000 outstanding): no principal until A1 is retired.
  const cmo = app.instruments.create(draftOf('cmo', 'CMOA2', { couponType: 'fixed', couponRate: 0.05, frequency: 12, maturity: '2056-03-01', dayCount: '30/360', seniorTranche: 'Class A1', seniorBalance: 100_000_000, seniorRemaining: 2_000_000 }));
  pin(app, cmo.id, 100);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: cmo.id, qty: 1_000_000 }] });
  await assert.rejects(async () => lifecycle(app, cmo, { action: 'paydown', newFactor: 0.98 }), /only after Class A1 is retired/);
  await assert.rejects(async () => lifecycle(app, cmo, { action: 'senior_balance', remaining: 2_500_000 }), /only paid down/);
  await lifecycle(app, cmo, { action: 'senior_balance', remaining: 0 });
  await lifecycle(app, cmo, { action: 'paydown', newFactor: 0.98 }); // 1,000,000 x 2% = 20,000 paid at par
  assert.match(events(app, book, acct).find((e) => e.type === 'bond.paydown').summary, /20,000\.00 USD received$/);

  // A deferrable class: 8.00% fixed quarterly 30/360 (1 March, June, September, December), held in two positions (two strategies).
  // The 1 June coupon, 2.00% of face, is elected to be paid in kind: factor 1 to 1.02 ONCE (not 1.0404), each holder's cost rises by
  // its own coupon (1,000,000 x 2% = 20,000; 500,000 x 2% = 10,000) and no cash moves.
  const clo = app.instruments.create(draftOf('clo', 'CLOD', { couponType: 'fixed', couponRate: 0.08, frequency: 4, maturity: '2036-03-01', dayCount: '30/360', pikAllowed: true }));
  pin(app, clo.id, 100);
  for (const qty of [1_000_000, 500_000]) await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: clo.id, qty }] });
  await assert.rejects(async () => lifecycle(app, clo, { action: 'pik', couponDate: '2026-06-02' }), /not a coupon date/);
  await lifecycle(app, clo, { action: 'pik', couponDate: '2026-06-01' });
  await goTo(app, clock, '2026-05-04T14:00:00.000Z'); // the trades settled; the 1 May coupon of CMOA2 paid
  const cashBefore = app.ledger.cash(acct.id, 'USD').settled;
  await goTo(app, clock, '2026-06-01T14:00:00.000Z');
  assert.equal(app.instruments.get(clo.id).terms.factor, 1.02);
  const costs = held(app, acct, clo.id).map((p) => p.cost).sort((a, b) => a - b);
  assert.deepEqual(costs, [510_000, 1_020_000]);
  assert.equal(events(app, book, acct).filter((e) => e.type === 'bond.pik').length, 2);
  // The only cash on 1 June is CMOA2's coupon (its May interest on 1,000,000 x 0.98 x 5% / 12 = 4,083.33): the PIK coupon moves none.
  assert.equal(Math.round((app.ledger.cash(acct.id, 'USD').settled - cashBefore) * 100) / 100, 4_083.33);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('loans: no short sale, delayed compensation on a late par settlement, a draw only on a payment date, a repricing with its premium', async () => {
  const { app, clock } = makeApp(); // Monday 2 March 2026
  const { book, acct } = makeBook(app, { cash: 10_000_000, account: 9_000_000 });
  const tl = app.instruments.create({ ...draftOf('syndicated_loan', 'TLA', { couponType: 'float', referenceRate: 'TSOFR3M', spread: 0.02, currentCoupon: 0.06, frequency: 4, maturity: '2031-03-15', issueDate: '2026-03-15', dayCount: 'ACT/360', tradingDocs: 'par', undrawnCommitment: 1_000_000 }), conventions: { settleLag: 7 } });
  pin(app, tl.id, 100);
  const short = await pv(app, book, acct, tl, 'sell_short', 1_000_000);
  assert.ok(short.blocking && short.checks.some((c) => /cannot be traded with "sell short"/.test(c.message)));
  // Standard date T+7: Wednesday 11 March. Stated settlement Monday 16 March: 5 days of delayed compensation. Interest 1,000,000 x
  // 6% x 5/360 = 833.33; carry on the purchase price 1,000,000 x 4% (6% - 2%) x 5/360 = 555.56; net 277.77 to the buyer.
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: tl.id, qty: 1_000_000, settle: { date: '2026-03-16' } }] });
  const dc = events(app, book, acct).find((e) => e.type === 'loan.delayed_compensation');
  assert.match(dc.summary, /interest 833\.33 USD less cost of carry 555\.56 USD on the purchase price, 277\.77 USD receivable from the seller/);
  const [pos] = held(app, acct, tl.id);
  // A draw off a payment date is refused; on 15 March (the start of the next period... a Sunday: refused too), so on 15 June.
  await assert.rejects(async () => posLifecycle(app, pos, { action: 'draw', amount: 500_000 }), /start of an interest period/);
  await assert.rejects(async () => lifecycle(app, tl, { action: 'reprice', spread: 0.0175 }), /Today is not one/);
  api(app, 'POST', '/api/demo/fixtures/rate', { code: 'TSOFR3M', value: 4, date: '2026-06-15' });
  await goTo(app, clock, '2026-06-15T14:00:00.000Z'); // Monday 15 June: interest paid, rate reset to 4.00% + 2.00%
  await posLifecycle(app, pos, { action: 'draw', amount: 500_000 });
  assert.equal(held(app, acct, tl.id)[0].qty, 1_500_000);
  assert.equal(app.instruments.get(tl.id).terms.undrawnCommitment, 500_000);
  // Repricing to 1.75% with a 0.5% premium: the period's rate 4.00% + 1.75% = 5.75%; premium 1,500,000 x 0.5% = 7,500.00.
  await lifecycle(app, tl, { action: 'reprice', spread: 0.0175, premium: 0.5 });
  assert.equal(app.instruments.get(tl.id).terms.currentCoupon, 0.0575);
  assert.match(events(app, book, acct).find((e) => e.type === 'loan.repricing').summary, /7,500\.00 USD received$/);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('credit-linked note credit event, contingent coupon with a protected principal, cat-bond trigger, interim recovery above cost', async () => {
  const { app, clock } = makeApp({ at: '2026-03-02T15:00:00.000Z' });
  const { book, acct } = makeBook(app, { cash: 10_000_000, account: 9_000_000 });
  // CLN 6% quarterly 30/360 (20 Mar/Jun/Sep/Dec) on Calder Corp. Bought 1,000,000 at par (settles 3 March). Credit event on 4 March:
  // accrued forfeited, principal settled at 40.00: 400,000; realized 400,000 - 1,000,000 = -600,000.
  assert.throws(() => app.instruments.create(draftOf('credit_linked_note', 'CLN0', { couponType: 'fixed', couponRate: 0.06, frequency: 4, maturity: '2029-12-20', dayCount: '30/360' })), /needs its reference entity/);
  const cln = app.instruments.create(draftOf('credit_linked_note', 'CLN1', { couponType: 'fixed', couponRate: 0.06, frequency: 4, maturity: '2029-12-20', dayCount: '30/360', referenceEntity: 'Calder Corp' }));
  pin(app, cln.id, 100);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: cln.id, qty: 1_000_000 }] });
  await goTo(app, clock, '2026-03-04T15:00:00.000Z');
  await lifecycle(app, cln, { action: 'credit_event', recovery: 0.4 });
  assert.equal(held(app, acct, cln.id).length, 0);
  assert.equal(app.accounting.pnl(book.id, acct.id).categories.find((x) => x.key === 'realized').rc, -600_000);
  assert.equal(app.ledger.balance(acct.id, 'accrued.asset', 'USD'), 0);

  // A principal-protected contingent note (initial 100, coupon barrier 80%) maturing 15 June 2026 (quarterly 15 Mar/Jun/Sep/Dec,
  // 8% a year: 2% a quarter). The 15 June coupon waits for its observation; observed at 50: no coupon, and principal at par
  // (protected) although the underlying lost half: 1,000,000 bought at 99 redeems at 100: realized 10,000.
  const note = app.instruments.create(draftOf('structured_note', 'SN1', { couponType: 'fixed', couponRate: 0.08, frequency: 4, maturity: '2026-06-15', dayCount: '30/360', linkedTo: 'Test Index', initialLevel: 100, couponBarrier: 0.8, principalProtected: true }));
  pin(app, note.id, 99);
  assert.equal((await pv(app, book, acct, note, 'buy', 1_000_000)).legs[0].accrued, 0); // flat
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: note.id, qty: 1_000_000 }] });
  await goTo(app, clock, '2026-06-15T14:00:00.000Z');
  assert.equal(app.db.get(`SELECT status FROM tasks WHERE instrument_id = ? AND type = 'bond.coupon'`, note.id).status, 'blocked');
  await lifecycle(app, note, { action: 'observation', date: '2026-06-15', level: 50 });
  await app.engine.tick();
  assert.equal(held(app, acct, note.id).length, 0);
  assert.match(events(app, book, acct).find((e) => e.type === 'bond.contingent_coupon').summary, /below the coupon barrier 80/);
  assert.match(events(app, book, acct).find((e) => e.type === 'bond.redemption' && e.summary.includes('SN1')).summary, /principal protected: par/);

  // A cat bond with a 100,000,000 issue: a 25% principal loss releases 25,000,000 of collateral to the sponsor.
  const cat = app.instruments.create(draftOf('catastrophe_bond', 'CAT1', { couponType: 'fixed', couponRate: 0.09, frequency: 4, maturity: '2029-06-15', dayCount: '30/360', collateralAccount: 'Trust account, Treasury money-market funds', issueSize: 100_000_000, sponsor: 'Test Re' }));
  pin(app, cat.id, 100);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: cat.id, qty: 1_000_000 }] });
  await goTo(app, clock, '2026-06-17T14:00:00.000Z');
  await lifecycle(app, cat, { action: 'writedown', newFactor: 0.75, kind: 'trigger' });
  assert.match(events(app, book, acct).find((e) => e.type === 'bond.trigger').summary, /25,000,000\.00 USD of collateral released from the collateral account to Test Re/);

  // Distressed: an interim distribution larger than the cost left realizes the excess. Bought 1,000,000 at 30 (cost 300,000); default;
  // distribution 35 per 100 = 350,000: cost to 0 and 50,000 realized; the claim stays open.
  const dd = app.instruments.create(draftOf('distressed_debt', 'DD1', { couponType: 'fixed', couponRate: 0.07, frequency: 2, maturity: '2028-06-15', dayCount: '30/360' }));
  pin(app, dd.id, 30);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: dd.id, qty: 1_000_000 }] });
  await goTo(app, clock, '2026-06-19T14:00:00.000Z');
  await assert.rejects(async () => lifecycle(app, dd, { action: 'recovery', percent: 35 }), /not in default/);
  await lifecycle(app, dd, { action: 'suspend_coupon', suspended: true });
  const realizedBefore = app.accounting.pnl(book.id, acct.id).categories.find((x) => x.key === 'realized').rc;
  await lifecycle(app, dd, { action: 'recovery', percent: 35 });
  const [ddPos] = held(app, acct, dd.id);
  assert.equal(ddPos.cost, 0);
  assert.equal(ddPos.qty, 1_000_000);
  assert.equal(Math.round((app.accounting.pnl(book.id, acct.id).categories.find((x) => x.key === 'realized').rc - realizedBefore) * 100) / 100, 50_000);
  assert.deepEqual(ledgerImbalance(app), []);
});
