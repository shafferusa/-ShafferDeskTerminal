// The manual workflow of holdings and contracts valued by hand (server/products/manual.js).
// Expected figures are worked out by hand in the comments; nothing is copied from what the Terminal prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { goTo, ledgerImbalance, makeApp, makeBook, trade } from '../helpers.js';
import { collateralSwapFee, dealingDateAfter, payoffOf } from '../../server/products/manual.js';
import { createIntegrity } from '../../server/core/integrity.js';

const inst = (product_id, terms, ccy = 'USD') => ({ product_id, family: 'manual', trading_ccy: ccy, terms });

test('manual: settlement formulas from a realised value entered by hand', () => {
  // Credit-spread forward, buyer: 10,000,000 x 4.5 x (150 - 120) / 10,000 = 135,000.
  assert.equal(payoffOf(inst('credit_spread_forward', { notional: 10_000_000, riskyDuration: 4.5, forwardSpreadBp: 120, side: 'buy' }), { realised: 150 }).amount, 135_000);
  // Credit-spread option, payer held: 10,000,000 x 4.2 x max(260 - 200, 0) / 10,000 = 252,000; a receiver at 260 pays nothing.
  assert.equal(payoffOf(inst('credit_spread_option', { notional: 10_000_000, riskyDuration: 4.2, strikeSpreadBp: 200, optionType: 'payer', side: 'long' }), { realised: 260 }).amount, 252_000);
  assert.equal(payoffOf(inst('credit_spread_option', { notional: 10_000_000, riskyDuration: 4.2, strikeSpreadBp: 200, optionType: 'receiver', side: 'long' }), { realised: 260 }).amount, 0);
  // Variance swap: variance notional = 50,000 / (2 x 20) = 1,250. Realised 25: 1,250 x (625 - 400) = 281,250.
  const v = inst('variance_swap', { vegaNotional: 50_000, strikeVol: 20, capMultiple: 2.5, side: 'long' });
  assert.equal(payoffOf(v, { realised: 25 }).amount, 281_250);
  // Realised 60 is capped at 2.5 x 20 = 50: 1,250 x (2,500 - 400) = 2,625,000; the seller pays it.
  assert.equal(payoffOf(v, { realised: 60 }).amount, 2_625_000);
  assert.equal(payoffOf({ ...v, terms: { ...v.terms, side: 'short' } }, { realised: 60 }).amount, -2_625_000);
  // Volatility swap: 100,000 x (18 - 22) = -400,000 for the buyer.
  assert.equal(payoffOf(inst('volatility_swap', { vegaNotional: 100_000, strikeVol: 22, side: 'long' }), { realised: 18 }).amount, -400_000);
  // Correlation swap: 25,000 x (55 - 40) = 375,000.
  assert.equal(payoffOf(inst('correlation_swap', { notionalPerPoint: 25_000, strikeCorr: 40, side: 'long' }), { realised: 55 }).amount, 375_000);
  // Dispersion swap: dispersion 28 - 18 = 10; 40,000 x (10 - 6) = 160,000.
  assert.equal(payoffOf(inst('dispersion_swap', { notionalPerPoint: 40_000, strikeVol: 6, side: 'long' }), { constituentVol: 28, indexVol: 18 }).amount, 160_000);
  // Recovery swap, recovery buyer: 10,000,000 x (25 - 40) / 100 = -1,500,000.
  assert.equal(payoffOf(inst('recovery_swap', { notional: 10_000_000, recoveryStrikePct: 40, side: 'buy' }), { realised: 25 }).amount, -1_500_000);
  // Weather HDD call: 5,000 x (4,250 - 4,000) = 1,250,000; at 4,600 it would be 3,000,000, capped at 2,000,000. A put at 3,900: 500,000.
  const w = inst('weather_derivative', { strike: 4000, tick: 5000, cap: 2_000_000, optionType: 'call', index: 'HDD', side: 'long' });
  assert.equal(payoffOf(w, { realised: 4250 }).amount, 1_250_000);
  assert.equal(payoffOf(w, { realised: 4600 }).amount, 2_000_000);
  assert.equal(payoffOf({ ...w, terms: { ...w.terms, optionType: 'put' } }, { realised: 3900 }).amount, 500_000);
  // Collateral swap fee: 50,000,000 x 25 bp x 91 / 360 = 31,597.22, paid by us.
  assert.deepEqual(collateralSwapFee(inst('collateral_swap', { feeNotional: 50_000_000, feeBp: 25, dayCount: 'ACT/360', feePayer: 'us' }), '2026-04-01', '2026-07-01'), { days: 91, amount: -31_597.22, gross: 31_597.22 });
});

test('manual: hedge fund dealing dates follow the notice period and the dealing frequency', () => {
  // Notice 15 April + 45 days = 30 May; the quarter ends 30 June (a Tuesday).
  assert.equal(dealingDateAfter('2026-04-15', { noticeDays: 45, dealingFrequency: 'quarterly' }, 'US'), '2026-06-30');
  // Notice 20 May + 45 days = 4 July: the next quarter end, 30 September.
  assert.equal(dealingDateAfter('2026-05-20', { noticeDays: 45, dealingFrequency: 'quarterly' }, 'US'), '2026-09-30');
  // Monthly, 30 days from 15 April = 15 May; 31 May 2026 is a Sunday, so the last business day, Friday 29 May.
  assert.equal(dealingDateAfter('2026-04-15', { noticeDays: 30, dealingFrequency: 'monthly' }, 'US'), '2026-05-29');
});

test('manual: a fund interest called, valued, distributed and wound up by hand balances to its cash', async () => {
  const { app, clock } = makeApp({ demo: true });
  const { book, acct } = makeBook(app, { cash: 20_000_000, account: 12_000_000 });
  const pe = app.instruments.create({ productId: 'private_equity', name: 'Test buyout fund', symbol: 'TBF', venueType: 'otc', domicile: 'US', tradingCcy: 'USD', terms: { commitment: 5_000_000, valuationMaxAgeDays: 100 } });
  assert.throws(() => app.instruments.create({ productId: 'private_equity', name: 'No commitment', venueType: 'otc', domicile: 'US', tradingCcy: 'USD', terms: { valuationMaxAgeDays: 100 } }), /Commitment is required/);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: pe.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: pe.id, qty: 1, statedPrice: 0, orderType: 'market', tif: 'day' }], origin: 'marketplace' });
  const posId = s.positions[0].positionId;
  const ev = (body) => app.db.tx(() => app.products.get('manual').manualEvent(app, { book, unit: acct, inst: app.instruments.get(pe.id), pos: app.positions.get(posId) }, body));
  ev({ action: 'capital_call', amount: 1_000_000, feePortion: 25_000 }); // cost 975,000
  assert.throws(() => ev({ action: 'capital_call', amount: 4_500_000 }), /Only 4,000,000.00 USD of the commitment is uncalled/);
  ev({ action: 'valuation', value: 990_000, asOf: '2026-03-02', source: 'GP statement' });
  let v = app.valuation.position(app.positions.get(posId));
  assert.equal(v.mv, 990_000);
  assert.equal(v.unrealized, 15_000); // 990,000 - 975,000
  assert.equal(app.valuation.nav(book.id, [acct.id]).provisional, false);
  // 101 days later the valuation is stale: the value stands, the net asset value is provisional.
  await goTo(app, clock, '2026-06-11T14:00:00.000Z');
  assert.equal(app.valuation.position(app.positions.get(posId)).priceObs.freshness, 'stale');
  assert.equal(app.valuation.nav(book.id, [acct.id]).provisional, true);
  // Distribution: 300,000 capital + 50,000 gain, 10,000 carry withheld -> 340,000 received; value rolled forward 990,000 - 350,000 = 640,000.
  ev({ action: 'distribution', returnOfCapital: 300_000, realizedGain: 50_000, carry: 10_000 });
  v = app.valuation.position(app.positions.get(posId));
  assert.equal(v.cost, 675_000);
  assert.equal(v.mv, 640_000);
  assert.throws(() => ev({ action: 'distribution', returnOfCapital: 700_000 }), /Only 675,000.00 USD of cost is left/);
  ev({ action: 'wind_up' });
  assert.equal(app.positions.get(posId).qty, 0);
  // Cash: -1,000,000 + 340,000 = -660,000 = realized (50,000 - 675,000) + fees (-25,000 - 10,000).
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 12_000_000 - 660_000);
  assert.deepEqual(ledgerImbalance(app), []);
  assert.equal(createIntegrity(app).check(book.id).ok, true);
});

test('manual: an OTC contract valued by hand cannot be entered without a collateral basis', async () => {
  const { app } = makeApp({ demo: true });
  const { book, acct } = makeBook(app);
  const vs = app.instruments.create({ productId: 'variance_swap', name: 'Test variance swap', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'USD',
    terms: { underlyingIndex: 'Test index', strikeVol: 20, vegaNotional: 50_000, side: 'long', expiry: '2026-09-18', valuationMaxAgeDays: 7 } });
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', underlyingId: vs.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: vs.id, qty: 1, statedPrice: 0, orderType: 'market', tif: 'day' }] });
  assert.ok(pv.blocking > 0);
  assert.ok(pv.checks.some((c) => c.code === 'collateral-basis'));
});
