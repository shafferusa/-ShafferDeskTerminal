// Collateral follow-up: stale marks, collateral on Accounting position rows, collateral cash of a securities borrow.
//
// Expected figures are worked out by hand from the configured terms (arithmetic in the comments). The tests
// drive the real preview, order engine, end-of-day pass, ledger and accounting views. Marks are fixtures:
// either manual entries, or an observation placed in the data adapter's cache standing in for a valuation
// that Shaffer Analytics Lab would supply (labelled "Analytics fixture (test)").

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';
import { makeObservation } from '../../server/data/observation.js';

const USD = 'USD';
const eod = (app, clock, date) => goTo(app, clock, `${date}T22:30:00.000Z`); // 17:30 New York, after the end-of-day cutoff
const manualMark = (app, id, value) => app.data.enterManual({ kind: 'price', subject: id, value, units: 'per 100 notional' });
// A model valuation as the analytics service would supply it; past the 1-day freshness limit of a model-derived figure when asOf is old.
const modelMark = (app, id, value, asOf) => app.data._cache.set(`mark|${id}`, makeObservation({
  kind: 'price', subject: id, value, units: 'per 100 notional', source: 'Analytics fixture (test)', providerId: 'test-fixture', status: 'model-derived', asOf,
}));
const sound = (app, book) => { assert.deepEqual(ledgerImbalance(app), []); assert.deepEqual(app.agreements.reconcile(book.id), []); };

let serial = 0;
const irs = (basis) => ({ productId: 'interest_rate_swap', name: `IRS F${++serial}`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: USD,
  terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer A', collateralBasis: basis, legs: [
    { id: 'A', side: 'pay', type: 'fixed', ccy: USD, rate: 0.04, months: 6, dayCount: '30/360' },
    { id: 'B', side: 'receive', type: 'float', ccy: USD, index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } });
async function open(app, book, unit, contract, qty) {
  const s = await trade(app, { bookId: book.id, unitId: unit.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty, statedPrice: 0, contract }] });
  return { s, positionId: s.positions[0].positionId, instrumentId: s.positions[0].instrument.id };
}

test('a variation-margin call made on a stale mark says so on the movement, the netting set and the position, and is provisional', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const agr = app.agreements.create(book.id, { name: 'CSA stale', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [acct.id], terms: { variationMargin: true, nettingScope: 'position' } });
  const a = await open(app, book, acct, irs({ type: 'agreement', agreementId: agr.id }), 1_000_000);
  // Model mark -2 per 100, as of 28 Feb 21:00 UTC; at 2 Mar 22:30 UTC it is 2 days old, past the 1-day limit.
  // 1,000,000 x -2 / 100 = -20,000 out of the money, threshold 0  ->  post 20,000.
  modelMark(app, a.instrumentId, -2, '2026-02-28T21:00:00.000Z');
  await eod(app, clock, '2026-03-02');
  assert.equal(app.ledger.balance(acct.id, 'cash.margin', USD), 20_000, 'the call is still made on a stale mark');

  const ev = app.accounting.history(book.id, acct.id, { limit: 50 }).events.find((e) => e.type === 'collateral.variation');
  assert.match(ev.summary, /Based on a stale mark \(as of 2026-02-28 21:00 UTC\): the requirement is provisional until a current mark is supplied\./);

  const v = app.agreements.positionView(app.positions.get(a.positionId));
  assert.equal(v.variation.posted, 20_000);
  assert.equal(v.variation.provisional, true);
  assert.match(v.variation.staleNote, /based on a stale mark \(as of 2026-02-28 21:00 UTC\)/i);
  assert.equal(v.variation.level, 'position');

  const bv = app.agreements.bookView(book.id);
  const set = bv.sets.find((s) => s.key === `P:${a.positionId}`);
  assert.equal(set.provisional, true);
  assert.match(set.staleNote, /stale mark/);
  assert.equal(bv.movements[0].provisional, true);

  // A current mark the next day: -2.5 per 100 -> -25,000; 5,000 more is posted and the requirement is no longer provisional.
  modelMark(app, a.instrumentId, -2.5, '2026-03-03T21:00:00.000Z');
  await eod(app, clock, '2026-03-03');
  assert.equal(app.ledger.balance(acct.id, 'cash.margin', USD), 25_000);
  const v2 = app.agreements.positionView(app.positions.get(a.positionId));
  assert.equal(v2.variation.provisional, false);
  assert.equal(v2.variation.staleNote, null);
  sound(app, book);
});

test('a missing mark still stops the call, even beside a stale one', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const agr = app.agreements.create(book.id, { name: 'CSA net', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [acct.id], terms: { variationMargin: true, nettingScope: 'account' } });
  const a = await open(app, book, acct, irs({ type: 'agreement', agreementId: agr.id }), 1_000_000);
  const b = await open(app, book, acct, irs({ type: 'agreement', agreementId: agr.id }), 1_000_000);
  modelMark(app, a.instrumentId, -3, '2026-02-27T21:00:00.000Z'); // stale; b has no mark at all
  await eod(app, clock, '2026-03-02');
  assert.equal(app.ledger.balance(acct.id, 'cash.margin', USD), 0, 'no call on half a netting set');
  const v = app.agreements.positionView(app.positions.get(b.positionId));
  assert.equal(v.variation.status, 'cannot_value');
  assert.equal(v.variation.provisional, false);
  // Both marked, one stale: -30,000 + 1,000,000 x 1 / 100 = -20,000 net -> post 20,000, provisional, naming the stale one.
  manualMark(app, b.instrumentId, 1);
  await eod(app, clock, '2026-03-03');
  assert.equal(app.ledger.balance(acct.id, 'cash.margin', USD), 20_000);
  const va = app.agreements.positionView(app.positions.get(a.positionId));
  assert.equal(va.variation.level, 'netting-set');
  assert.equal(va.variation.positionsInSet, 2);
  assert.equal(va.variation.provisional, true);
  assert.match(va.variation.staleNote, /IRS F\d+ as of 2026-02-27 21:00 UTC/);
  sound(app, book);
});

test('Accounting, Open positions: each OTC row carries its collateral basis and what is posted or held, variation margin labelled at netting-set level', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  // Agreement: IA 5% of notional, VM netted inside the Account, no threshold.
  const agr = app.agreements.create(book.id, { name: 'CSA rows', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [acct.id],
    terms: { independentAmount: { type: 'pct', pct: 0.05 }, variationMargin: true, nettingScope: 'account' } });
  const a = await open(app, book, acct, irs({ type: 'agreement', agreementId: agr.id }), 1_000_000); // IA 5% x 1,000,000 = 50,000
  const b = await open(app, book, acct, irs({ type: 'agreement', agreementId: agr.id }), 400_000); //  IA 5% x   400,000 = 20,000
  const c = await open(app, book, acct, irs({ type: 'position', independentAmount: { type: 'fixed', amount: 7_500 }, variationMargin: false }), 200_000);
  const d = await open(app, book, acct, irs({ type: 'uncollateralized' }), 300_000);
  const e = await open(app, book, acct, irs({ type: 'uncollateralized' }), 100_000);
  // e: in the state of a position opened before bases existed.
  const ie = app.instruments.get(e.instrumentId);
  const { collateralBasis: _gone, ...terms } = ie.terms;
  app.instruments.update(ie.id, { terms }, { system: true });
  app.db.run(`UPDATE positions SET data = json_remove(data, '$.collateralBasis') WHERE id = ?`, e.positionId);
  // Marks: a -4 per 100 on 1,000,000 = -40,000; b +2.5 per 100 on 400,000 = +10,000; net -30,000 -> the set posts 30,000.
  manualMark(app, a.instrumentId, -4);
  manualMark(app, b.instrumentId, 2.5);
  await eod(app, clock, '2026-03-02');
  const rows = app.accounting.openPositions(book.id, acct.id).positions;
  const row = (o) => rows.find((r) => r.positionId === o.positionId).otcCollateral;

  const ra = row(a);
  assert.equal(ra.basis.type, 'agreement');
  assert.equal(ra.basis.agreement.name, 'CSA rows');
  assert.equal(ra.independent.held, 50_000);
  assert.equal(ra.independent.required, 50_000);
  assert.equal(ra.variation.level, 'netting-set');
  assert.equal(ra.variation.positionsInSet, 2);
  assert.equal(ra.variation.posted, 30_000, 'the set\'s amount, shown on each of its positions and labelled as the set\'s');
  assert.equal(row(b).independent.held, 20_000);
  assert.equal(row(b).variation.posted, 30_000);

  const rc = row(c);
  assert.equal(rc.basis.type, 'position');
  assert.equal(rc.basis.label, 'Position-level terms');
  assert.equal(rc.independent.held, 7_500);
  assert.equal(rc.variation, null, 'no variation margin under these terms');

  assert.equal(row(d).basis.type, 'uncollateralized');
  assert.equal(row(d).basis.label, 'Uncollateralized (paper assumption)');
  assert.equal(row(d).independent, null);

  assert.equal(row(e).basis.type, 'none');
  assert.equal(row(e).basis.flagged, true);
  assert.equal(row(e).basis.label, 'No collateral terms recorded (treated as uncollateralized)');

  // Cash margin bucket: 50,000 + 20,000 + 7,500 + 30,000 = 107,500, every part of it attributed above.
  assert.equal(app.ledger.balance(acct.id, 'cash.margin', USD), 107_500);
  sound(app, book);
});

test('Accounting, Open positions: same-named strategy instances carry when they were opened, so the older lists first', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const input = { bookId: book.id, unitId: acct.id, template: 'custom', name: 'Long ALFA', legs: [{ kind: 'trade', action: 'buy', qty: 10, instrumentId: app.instruments.list().find((i) => i.symbol === 'ALFA').id }] };
  const first = await trade(app, input);
  clock.advance(60_000);
  const second = await trade(app, input);
  const rows = app.accounting.openPositions(book.id, acct.id).positions.filter((r) => r.strategy?.name === first.name);
  const opened = new Map(rows.map((r) => [r.strategy.id, r.strategy.openedAt]));
  assert.ok(opened.get(first.id) && opened.get(second.id));
  assert.ok(opened.get(first.id) < opened.get(second.id), 'the first instance was opened a minute before the second');
});

test('the borrowing register carries the cash collateral of a securities borrow, as a figure', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  app.data.market.set(inst.ALFA.id, { bid: 200, ask: 200.04, value: 200.02, bidSize: 1e6, askSize: 1e6 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  await goTo(app, clock, '2026-03-03T22:30:00.000Z');
  assert.equal(app.data.price(inst.ALFA.id).value, 200.02);
  // Collateral 102% of market value: 1.02 x 100 x 200.02 = 20,402.04, held as restricted cash.
  const b = app.accounting.borrowings(book.id, acct.id).find((x) => x.family === 'secloan');
  assert.equal(b.collateral.kind, 'cash');
  assert.equal(b.collateral.cash, 20_402.04);
  assert.equal(app.ledger.cash(acct.id, USD).restricted, 20_402.04);
  // The same record on the Account's balance sheet and in Treasury's oversight register.
  assert.equal(app.accounting.balanceSheet(book.id, acct.id).borrowings.find((x) => x.family === 'secloan').collateral.cash, 20_402.04);
  assert.equal(app.accounting.treasury(book.id).borrowings.accountOriginated.find((x) => x.family === 'secloan').collateral.cash, 20_402.04);
});
