import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook } from '../helpers.js';
import { createApi } from '../../server/api.js';
import { SERVER_DATASETS } from '../../server/data/ports.js';

// p1: the product-specific datasets of the server client (ratings and covenants, yield and spread, option Greeks,
// futures curve, exchange margin, fund holdings and facts, OTC marks, FX forward curve) and the Terminal's own
// contract facts route. Fixtures stand in for the Shaffer gateway only; the routes, the client and the paper engine
// are the real ones.

const P1 = ['ratingsCovenants', 'yieldSpread', 'optionGreeks', 'futuresCurve', 'exchangeMargin', 'fundHoldings', 'fundFacts', 'otcMarks', 'fxCurve'];
const ROUTE = { ratingsCovenants: 'ratings', yieldSpread: 'yield-spread', optionGreeks: 'option-greeks', futuresCurve: 'futures-curve', exchangeMargin: 'margin', fundHoldings: 'fund-holdings', fundFacts: 'fund-facts', otcMarks: 'marks', fxCurve: 'fx-curve' };
const route = (api, method, path, { query = {}, body = {} } = {}) => {
  const m = api.match(method, path);
  assert.ok(m && !m.methodNotAllowed, `route ${method} ${path}`);
  return m.handler({ params: m.params, query, body, req: { headers: {} } });
};
const fastRetries = (app) => app.data.setSetting('server.retry', { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 });

/** The demo instruments plus one option, one fund, one swap and one CDS registered as a user would. */
function setup({ demo = true } = {}) {
  const { app, inst, clock } = makeApp({ demo });
  const reg = (d) => app.instruments.create(d);
  const out = { app, clock, inst, api: createApi(app) };
  if (!demo) {
    out.bond = reg({ productId: 'treasury_note', name: 'Test note 4% 2031', symbol: 'TN31', marketView: 'US_CASH', venueType: 'otc', venueCountry: 'US', issuer: 'Test Treasury', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2, maturity: '2031-05-15', issueDate: '2021-05-15', dayCount: 'ACT/ACT', redemption: 100 } });
    return out;
  }
  out.option = reg({ productId: 'equity_option', name: 'ALFA 2026-04-17 180 put (test)', symbol: 'ALFA260417P180', marketView: 'US_DERIV', venue: 'SIM Options', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', underlyingId: inst.ALFA.id, multiplier: 100, terms: { right: 'P', strike: 180, expiration: '2026-04-17', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
  out.fund = reg({ productId: 'mutual_fund', name: 'Lakemont Balanced Fund (test)', symbol: 'LKBIX', marketView: 'US_CASH', venue: 'Transfer agent', venueType: 'otc', venueCountry: 'US', issuer: 'Lakemont Funds Trust', tradingCcy: 'USD', terms: {} });
  // The interest-rate swap of test/matrix/specs/swap-rates.mjs (schedule worked out there by hand).
  out.swap = reg({ productId: 'interest_rate_swap', name: 'USD IRS 4.00% v TSFR3M 5 Mar 2027', symbol: 'IRS-TSFR-0327', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
    conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
    terms: { effective: '2026-03-05', maturity: '2027-03-05', counterparty: 'Dealer A', collateralBasis: { type: 'uncollateralized' },
      legs: [{ side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' }, { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } });
  out.fut = Object.values(inst).find((i) => i?.family === 'future' && i.terms.root === 'S5');
  out.fx = Object.values(inst).find((i) => i?.family === 'fx' && i.terms.base === 'EUR');
  return out;
}

test('product datasets: every one awaits with its operation name until the contract is supplied, nothing fabricated', async () => {
  const { app, api, bond } = setup({ demo: false });
  for (const ds of P1) {
    const def = SERVER_DATASETS[ds];
    assert.ok(def, `${ds} is in the data-requirements catalogue`);
    for (const f of ['label', 'interface', 'operation', 'inputs', 'requires', 'freshness', 'pagination', 'pointInTime', 'errors']) assert.ok(def[f] !== undefined, `${ds}.${f}`);
    const env = await route(api, 'GET', `/api/server/${ROUTE[ds]}/${bond.id}`, { query: { requestId: `r-${ds}` } });
    assert.equal(env.state, 'awaiting', ds);
    assert.equal(env.operation, `market.${ds}`);
    assert.ok(env.message.startsWith('Awaiting Shaffer data connection') && env.message.includes(`market.${ds}`), env.message);
    assert.equal(env.requestId, `r-${ds}`);
    assert.equal(env.items, undefined, `${ds}: no items fabricated`);
    assert.equal(env.data, undefined, `${ds}: no data fabricated`);
    assert.equal(app.data.server.state().datasets[ds].state, 'awaiting');
  }
});

test('product datasets: the demo fixtures answer each one for the right product, labelled, values passed through', async () => {
  const { app, api, inst, option, fund, swap, fut, fx } = setup();
  const get = (ds, id, query = {}) => route(api, 'GET', `/api/server/${ROUTE[ds]}/${id}`, { query });
  // Ratings and covenants: issue scope with three covenants; sovereign issuer scope with none (and the reason).
  const corp = await get('ratingsCovenants', inst.SIMCORP29.id);
  assert.equal(corp.state, 'available');
  assert.equal(corp.source.label, 'Demo fixture');
  assert.equal(corp.source.fixture, true);
  assert.equal(corp.data.scope, 'issue');
  assert.deepEqual(corp.data.ratings.map((r) => r.rating), ['BBB+', 'Baa1', 'BBB']);
  assert.equal(corp.data.covenants.length, 3);
  const gov = await get('ratingsCovenants', inst.SIMGOV31.id);
  assert.equal(gov.data.scope, 'issuer');
  assert.deepEqual(gov.data.covenants, []);
  assert.match(gov.data.covenantsNote, /no financial covenants/);
  // As of a date: only the ratings already in force then (fixture dates are clock-relative: 9, 30 and 300 days back).
  const pit = await get('ratingsCovenants', inst.SIMCORP29.id, { asOf: '2026-02-10' }); // 2026-03-02 minus 20 days
  assert.equal(pit.pointInTime.supported, true);
  assert.deepEqual(pit.data.ratings.map((r) => r.agency), ['Demo Ratings A', 'Demo Ratings C']);
  // Equities have no ratings record in the fixtures: unavailable, not empty values.
  assert.equal((await get('ratingsCovenants', inst.ALFA.id)).state, 'unavailable');
  // Yield and spread: literal values with the price they were struck on; a benchmark has no spread, with its reason.
  const ys = await get('yieldSpread', inst.SIMCORP29.id);
  assert.equal(ys.data.yield.value, 5.274);
  assert.equal(ys.data.spread.valueBps, 131);
  assert.equal(ys.data.priceUsed.value, 98.75);
  const ysg = await get('yieldSpread', inst.SIMGOV31.id);
  assert.equal(ysg.data.spread, null);
  assert.match(ysg.nulls.spread, /benchmark/);
  // Greeks: illustrative values for a put, rho missing with its reason (null, never 0).
  const g = await get('optionGreeks', option.id);
  assert.equal(g.state, 'available');
  assert.equal(g.data.delta, -0.47);
  assert.equal(g.data.impliedVol, 0.291);
  assert.equal(g.data.rho, null);
  assert.ok(g.nulls.rho);
  assert.equal((await get('optionGreeks', inst.ALFA.id)).state, 'unavailable', 'an equity has no Greeks');
  // Futures curve: one point per registered S5 month, each the demo feed's own price of that month (nothing interpolated).
  const months = app.instruments.list({ underlyingId: fut.underlying_id, family: 'future' });
  const curve = await get('futuresCurve', fut.id);
  assert.equal(curve.source.label, 'Simulated demo feed');
  assert.equal(curve.items.length, months.length);
  for (const m of curve.items) {
    const reg = months.find((x) => x.terms.expiration === m.expiration);
    assert.equal(m.price, app.data.price(reg.id).value, `${m.contractMonth}: the feed's price, as it is`);
  }
  assert.deepEqual(curve.items.map((x) => x.expiration), [...curve.items.map((x) => x.expiration)].sort());
  assert.equal(curve.items[0].openInterest, null);
  // Exchange margin: the clearing house's figure, apart from the 12,000 registered on the contract (the Book's terms).
  const mg = await get('exchangeMargin', fut.id);
  assert.equal(mg.data.initial, 12650);
  assert.equal(fut.terms.initialMargin, 12000);
  // Fund holdings and facts: weights as listed; NAV is the demo feed's price of the fund.
  const h = await get('fundHoldings', fund.id);
  assert.equal(h.items.length, 10);
  assert.equal(h.items[0].weightPct, 6.8);
  assert.equal(h.data.coveragePct, 46.3);
  assert.equal((await get('fundHoldings', inst.ALFA.id)).state, 'unavailable');
  const ff = await get('fundFacts', fund.id);
  assert.equal(ff.data.fees.ongoingChargePct, 0.62);
  assert.equal(ff.data.netAssets, null);
  const navObs = app.data.price(fund.id);
  assert.equal(ff.data.nav, navObs ? navObs.value : null, 'NAV as the feed has it (missing stays missing)');
  // OTC marks: dealer, clearing and model marks with their providers; an as-of request keeps marks up to that date.
  const mk = await get('otcMarks', swap.id);
  assert.deepEqual([...new Set(mk.items.map((x) => x.kind))].sort(), ['clearing', 'dealer', 'model']);
  assert.ok(mk.items.every((x) => x.provider && x.timestamp && x.units === 'NPV per 100 notional'));
  const mkPit = await get('otcMarks', swap.id, { asOf: '2026-02-26' }); // 4 days back: marks 4 and 6 days old remain
  assert.deepEqual(mkPit.items.map((x) => x.value), [-0.42, -0.35]);
  assert.equal((await get('otcMarks', inst.ALFA.id)).state, 'unavailable');
  // FX forward curve: points with their units; the outright is not supplied and stays null with a reason.
  const fc = await get('fxCurve', fx.id);
  assert.deepEqual(fc.items.map((x) => x.tenor), ['1W', '1M', '3M', '6M', '1Y']);
  assert.equal(fc.items[1].forwardPoints, 9.2);
  assert.equal(fc.items[1].outright, null);
  assert.ok(fc.nulls.outright);
});

test('product datasets: the fixture controls drive every state (stale, unavailable, error, forbidden, partial)', async () => {
  const { app, api, inst, fund } = setup();
  fastRetries(app);
  const set = (dataset, mode) => route(api, 'POST', '/api/demo/fixtures/server', { body: { dataset, mode } });
  const get = (ds, id) => route(api, 'GET', `/api/server/${ROUTE[ds]}/${id}`, { query: { fresh: '1' } });
  set('ratingsCovenants', 'stale');
  assert.equal((await get('ratingsCovenants', inst.SIMCORP29.id)).state, 'stale');
  set('ratingsCovenants', 'unavailable');
  const un = await get('ratingsCovenants', inst.SIMCORP29.id);
  assert.equal(un.state, 'unavailable');
  assert.equal(un.data, null);
  set('yieldSpread', 'error');
  const er = await get('yieldSpread', inst.SIMCORP29.id);
  assert.equal(er.state, 'error');
  assert.equal(er.error.retryable, true);
  set('fundFacts', 'forbidden');
  const fb = await get('fundFacts', fund.id);
  assert.equal(fb.state, 'error');
  assert.equal(fb.error.retryable, false);
  assert.equal(fb.error.status, 403);
  set('yieldSpread', 'partial');
  const pa = await get('yieldSpread', inst.SIMCORP29.id);
  assert.equal(pa.state, 'incomplete');
  assert.ok(pa.missingFields.length >= 1);
  for (const f of pa.missingFields) assert.ok(pa.nulls[f], `${f} carries a reason`);
  set('fundHoldings', 'partial');
  const hp = await get('fundHoldings', fund.id);
  assert.equal(hp.state, 'incomplete');
  assert.equal(hp.items.length, 5, 'half of the ten listed holdings');
  route(api, 'POST', '/api/demo/fixtures/server', { body: { reset: true } });
  assert.equal((await get('yieldSpread', inst.SIMCORP29.id)).state, 'available');
});

test('contract facts: a bond\'s accrued interest is the paper engine\'s and its coupon schedule comes from the terms', async () => {
  const { app, api, inst } = setup();
  const { book } = makeBook(app);
  const f = await route(api, 'GET', `/api/instruments/${inst.SIMCORP29.id}/contract-facts`, { query: { bookId: book.id } });
  // 5.50% 30/360 semi-annual, last coupon Sunday 1 March 2026 (accrual dates unadjusted), today Monday 2 March:
  // 1 day of 30/360 -> 100 x 0.055 x 1/360 = 0.0152777...
  assert.ok(Math.abs(f.accrued.per100 - (100 * 0.055) / 360) < 1e-12, String(f.accrued.per100));
  assert.equal(f.accrued.per100, app.products.get('bond').accruedAmount(inst.SIMCORP29, 100, '2026-03-02'), 'the same figure trades use');
  // Coupons left: 1 Sep 2026, 1 Mar and 1 Sep 2027, 1 Mar and 1 Sep 2028, 1 Mar 2029 = 6, each 5.50 / 2 = 2.75 per 100.
  assert.equal(f.coupons.remaining, 6);
  assert.deepEqual(f.coupons.rows.map((r) => r.accrualEnd), ['2026-09-01', '2027-03-01', '2027-09-01', '2028-03-01', '2028-09-01', '2029-03-01']);
  assert.ok(f.coupons.rows.every((r) => r.per100 === 2.75));
  assert.deepEqual(f.coupons.redemption, { date: '2029-03-01', payDate: '2029-03-01', pricePct: 100, factor: 1 });
  assert.deepEqual(f.scheduled, [], 'nothing held, nothing scheduled');
});

test('contract facts: a swap\'s legs give their next payment on the payment calendar; nothing for an equity', async () => {
  const { app, api, inst, swap } = setup();
  const { book } = makeBook(app);
  const f = await route(api, 'GET', `/api/instruments/${swap.id}/contract-facts`, { query: { bookId: book.id } });
  const [fixed, float] = f.legs;
  // From test/matrix/specs/swap-rates.mjs: fixed 5 Mar to 5 Sep 2026 paid Tuesday 8 September (the 5th is a Saturday,
  // Monday the 7th Labor Day); floating 5 Mar to 5 Jun 2026 paid Friday 5 June; then 7 December (the 5th a Saturday).
  assert.deepEqual(fixed.next, { start: '2026-03-05', end: '2026-09-05', payDate: '2026-09-08' });
  assert.equal(fixed.remaining, 2);
  assert.deepEqual(float.next, { start: '2026-03-05', end: '2026-06-05', payDate: '2026-06-05' });
  assert.equal(float.periods[2].payDate, '2026-12-07');
  assert.equal(float.remaining, 4);
  const eq = await route(api, 'GET', `/api/instruments/${inst.ALFA.id}/contract-facts`, { query: { bookId: book.id } });
  assert.equal(eq.accrued, null);
  assert.equal(eq.legs, null);
});
