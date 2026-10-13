// OTC options (family "otcoption"): collateral only on the writer, Bermudan exercise dates, physical
// currency exchange only when funded, and the reporting-currency rate of a currency that has just
// appeared in a Book. Expected figures are worked out by hand in the comments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, goTo } from '../helpers.js';
import { createApi } from '../../server/api.js';

const USD = 'USD';
let serial = 0;
const option = (inst, terms, extra = {}) => ({
  productId: 'otc_option', name: `ALFA OTC option ${++serial}`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: USD, underlyingId: inst.ALFA.id,
  ...extra, terms: { right: 'C', strike: 200, expiration: '2026-06-19', counterparty: 'Dealer A', ...terms },
});
const leg = (contract, qty, action = 'buy', price = 5) => ({ kind: 'trade', action, qty, statedPrice: price, contract });
const POSITION_IA_10 = { type: 'position', independentAmount: { type: 'pct', pct: 0.1 }, variationMargin: false, threshold: 0, minimumTransfer: 0 };

test('an OTC option posts an independent amount only when written: quantity x strike x multiplier x the share', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  // Bought: 1,000 units, 10% terms. The buyer owes nothing more than the premium: no independent amount.
  const pvLong = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(option(inst, { collateralBasis: POSITION_IA_10 }), 1000)] });
  assert.equal(pvLong.blocking, 0);
  assert.equal(pvLong.totals.cash.USD.margin ?? 0, 0);
  const s1 = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(option(inst, { collateralBasis: POSITION_IA_10 }), 1000)] });
  assert.equal(app.ledger.positionBalance(s1.positions[0].positionId, 'cash.margin', USD), 0);
  // Written: 10% x 1,000 x 200 x 1 = 20,000.
  const s2 = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(option(inst, { collateralBasis: POSITION_IA_10 }), 1000, 'sell')] });
  assert.equal(app.ledger.positionBalance(s2.positions[0].positionId, 'cash.margin', USD), 20_000);
  // Quoted per 100 (multiplier 0.01), written on 100,000 units struck at 98: 10% x 100,000 x 98 x 0.01 = 9,800.
  const s3 = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(option(inst, { strike: 98, collateralBasis: POSITION_IA_10 }, { multiplier: 0.01 }), 100_000, 'sell', 0.5)] });
  assert.equal(app.ledger.positionBalance(s3.positions[0].positionId, 'cash.margin', USD), 9_800);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a Bermudan option needs its exercise dates, and is exercised on them (or at expiry) only', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  assert.throws(() => app.instruments.create(option(inst, { exercise: 'bermudan', collateralBasis: { type: 'uncollateralized' } })), /needs its exercise dates/);
  assert.throws(() => app.instruments.create(option(inst, { exercise: 'bermudan', exerciseDates: '2026-04-15, 2026-07-01', collateralBasis: { type: 'uncollateralized' } })), /cannot be after the expiration date/);
  const contract = option(inst, { exercise: 'bermudan', exerciseDates: '2026-04-15, 2026-05-15', settlement: 'cash', collateralBasis: { type: 'uncollateralized' } });
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(contract, 100)] });
  const p = s.positions[0];
  assert.deepEqual(app.instruments.get(p.instrument.id).terms.exerciseDates, ['2026-04-15', '2026-05-15']);
  const api = createApi(app);
  const exercise = () => { const m = api.match('POST', `/api/positions/${p.positionId}/lifecycle`); return m.handler({ params: m.params, query: {}, body: { action: 'exercise', contracts: 100 } }); };
  await goTo(app, clock, '2026-04-14T14:00:00.000Z');
  await assert.rejects(async () => exercise(), /This option is Bermudan: it can only be exercised on its exercise dates \(2026-04-15, 2026-05-15\) or at expiration \(2026-06-19\)\. Today is 2026-04-14\./);
  assert.equal(app.positions.get(p.positionId).qty, 100, 'nothing changed');
  await goTo(app, clock, '2026-04-15T14:00:00.000Z');
  await exercise();
  assert.equal(app.positions.get(p.positionId).qty, 0, 'exercised on an exercise date');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('physical exercise of an FX option exchanges both currencies only when the paying side holds the cash', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app); // Alpha holds 500,000 USD
  const contract = (n) => ({ productId: 'fx_option', name: `EUR call ${n}`, marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: USD, underlyingId: inst['EUR/USD'].id,
    terms: { right: 'C', strike: 1.10, expiration: '2026-06-03', exercise: 'american', settlement: 'physical', counterparty: 'Dealer D', collateralBasis: { type: 'uncollateralized' } } });
  const api = createApi(app);
  const exercise = (positionId) => { const m = api.match('POST', `/api/positions/${positionId}/lifecycle`); return m.handler({ params: m.params, query: {}, body: { action: 'exercise' } }); };
  // 1,000,000 EUR at 1.10 needs 1,100,000 USD; Alpha has 500,000 - 10,000 premium owed = 490,000 available.
  const big = (await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(contract(1), 1_000_000, 'buy', 0.01)] })).positions[0];
  const before = app.db.get('SELECT COUNT(*) AS n FROM events').n;
  await assert.rejects(async () => exercise(big.positionId), /needs 1,100,000\.00 USD to deliver against 1,000,000\.00 EUR, and Alpha has 490,000\.00 USD of USD available/);
  assert.equal(app.positions.get(big.positionId).qty, 1_000_000, 'the option is still held');
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM events').n, before, 'nothing was booked');
  // 100,000 EUR needs 110,000 USD: funded. Both currencies are due on the spot value date.
  const small = (await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(contract(2), 100_000, 'buy', 0.01)] })).positions[0];
  await exercise(small.positionId);
  assert.equal(app.positions.get(small.positionId).qty, 0);
  const due = app.db.all('SELECT ccy, amount FROM settlements WHERE unit_id = ? AND status = ? AND instrument_id = ? ORDER BY ccy', acct.id, 'pending', inst['EUR/USD'].id);
  assert.deepEqual(due.map((d) => [d.ccy, d.amount]), [['EUR', 100_000], ['USD', -110_000]]);
  const ev = app.db.get(`SELECT summary FROM events WHERE type = 'option.delivery' ORDER BY id DESC LIMIT 1`);
  assert.match(ev.summary, /^Simulated currency exchange on exercise of EUR call 2: bought 100,000\.00 EUR against 110,000\.00 USD at strike 1\.1/);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('the reporting-currency rate of a currency that has just appeared in a Book is fetched at once, not left stale', async () => {
  const { app, clock } = makeApp();
  const { book } = makeBook(app);
  const api = createApi(app);
  // Any Accounting tab refreshes the Book's prices and rates first (server/api.js, refreshBook); then the overview is read.
  const read = async () => { const m = api.match('GET', `/api/books/${book.id}/accounting/positions`); await m.handler({ params: m.params, query: {}, body: {} }); return app.accounting.overview(book.id); };
  await app.data.refresh({ pairs: ['EUR/USD'] }); // an EUR/USD observation cached now, at 2 March
  await goTo(app, clock, '2026-03-04T15:00:00.000Z'); // two days later: that observation is no longer current
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'JPY', amount: 15_000_000 });
  assert.equal((await read()).navProvisional, false, 'JPY is fetched for the Book');
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'EUR', amount: 100_000 });
  const ov = await read(); // the same instant: EUR has just appeared
  assert.equal(ov.navProvisional, false, `EUR is converted at a current rate: ${JSON.stringify(ov.navAffected)}`);
});

test('a price entered by hand today as the close of an earlier date is not taken as today\'s close', async () => {
  const { app, clock } = makeApp();
  const inst = app.instruments.create({ productId: 'precious_metal', name: 'Test gold bar', symbol: 'TGLD', marketView: 'US_CASH', venueType: 'otc', venueCountry: 'US', tradingCcy: USD, terms: { quantityUnit: 'troy ounces' } });
  await goTo(app, clock, '2026-05-29T22:30:00.000Z'); // Friday 29 May, after the close
  app.data.enterManual({ kind: 'price', subject: inst.id, value: 2440, forDate: '2026-05-27', units: 'USD per troy ounce' });
  assert.equal(app.data.closeFor(inst.id, '2026-05-27').value, 2440, 'it is the close of 27 May');
  assert.equal(app.data.closeFor(inst.id, '2026-05-29'), null, 'and not the close of 29 May, the day it was entered');
  app.data.enterManual({ kind: 'price', subject: inst.id, value: 2445, units: 'USD per troy ounce' });
  assert.equal(app.data.closeFor(inst.id, '2026-05-29').value, 2445, 'a price entered today with no other date stands for today');
});
