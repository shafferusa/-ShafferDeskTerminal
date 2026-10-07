// DEMO FIXTURE for the Hedge workflow.
//
// This is NOT Shaffer Hedge and contains no hedge-selection or sizing logic worth the name. It
// returns a few canned packages for the fictional demo instruments so the Hedge popup, the
// product-specific tickets, Execute Now, leg linking and the lifecycle can be exercised in the
// isolated demo environment before Analytics Lab is connected. Every answer is stamped
// "demo fixture" by the Terminal (core/hedge.js) wherever it is shown; quantities are simple
// notional matches and are stated as illustrative.
//
// It also plays the service's part for the protection assessment, with one illustrative rule: a
// bought option on the same underlying, in the protecting direction, is allocated to the position
// up to the capacity it has left; every other hedge held in the Account is reported as unrelated.
// That rule is a stand-in. Applicability and sizing are Analytics Lab's decisions.
//
// It is only reachable when the Terminal runs in demo mode.

import { addMonths } from '../quant/dates.js';
import { adjust, CURRENCY_CALENDAR } from '../quant/calendar.js';
import { DEMO_FUTURES } from './demo.js';

const FIXTURE_NOTE = 'Demo fixture, not Shaffer Hedge output. Structure and sizing are illustrative only.';
export const DEMO_FIXTURE_VERSION = 'demo-fixture-2';

/** A small fictional list of investment Strategies with IDs, so choosing a Strategy by ID can be exercised in demo mode. */
export const DEMO_INVESTMENT_STRATEGIES = [
  { id: 'DEMO-IS-001', name: 'Quality Compounders', version: 'demo-1' },
  { id: 'DEMO-IS-002', name: 'Core Equity', version: 'demo-1' },
  { id: 'DEMO-IS-003', name: 'Global Macro Carry', version: 'demo-1' },
];

export async function demoHedgeResponse(app, request) {
  const now = app.clock.now().toISOString();
  const today = app.clock.today();
  const p = request.primary;
  const packages = [];
  const response = { source: 'Demo fixture (not Shaffer Hedge)', version: DEMO_FIXTURE_VERSION, asOf: now, modelRun: null, fixture: true, recommendedId: null, packages };
  if (!p?.instrument?.terminalId) return response;
  const inst = app.instruments.get(p.instrument.terminalId);
  if (!inst || !['equity', 'fund'].includes(inst.family)) {
    response.note = 'The demo fixture only has canned proposals for the fictional demo equities.';
    return response;
  }
  const long = p.direction !== 'short';
  const fullQty = Math.abs(p.quantity || 0);
  const px = app.data.price(inst.id)?.value ?? p.averagePrice ?? null;
  if (!(fullQty > 0) || px === null) return response;
  const ccy = inst.trading_ccy;

  // Protection the template already contains, or that is explicitly linked to the position, is taken
  // off first: the fixture only proposes cover for what is left. (Real sizing is Shaffer Hedge's job.)
  const right = long ? 'P' : 'C';
  const optUnits = (terms, q) => q * (terms?.deliverableUnits ?? terms?.deliverable?.units ?? terms?.multiplier ?? 0);
  const proposed = (request.proposedLegs || []).filter((l) => l.isProtection);
  const primaryId = p.positionId || null;
  let protectedUnits = 0, otherProtection = false;
  const already = [];
  for (const l of proposed) {
    if (l.instrument?.family === 'option' && l.action === 'buy' && l.instrument.terms?.right === right) { protectedUnits += optUnits(l.instrument.terms, l.quantity); already.push(`${l.quantity} ${right === 'P' ? 'puts' : 'calls'} in the template`); }
    else if (l.instrument?.family !== 'option') { otherProtection = true; already.push('a hedge leg in the template'); }
  }
  for (const h of request.linkedProtection || []) {
    const mine = (h.allocations || []).filter((a) => a.protectedPositionId === primaryId);
    if (!mine.length) continue; // linked to the strategy instance but not counted (a written option, or the wrong direction)
    const units = mine.reduce((a, x) => a + (x.units || 0), 0);
    if (mine.some((a) => a.units === null)) { otherProtection = true; already.push(`${h.instrument.symbol || h.instrument.name} linked as a hedge`); }
    else { protectedUnits += units; already.push(`${units} units covered by ${h.instrument.symbol || h.instrument.name}, linked to this position`); }
  }
  // Illustrative protection assessment for the other hedges held in the Account (see the header).
  if (primaryId) {
    const allocations = [], unrelated = [];
    for (const h of request.hedgesHeld || []) {
      if (h.relation === 'linked') continue;
      const sameName = h.instrument.family === 'option' && h.instrument.underlying?.terminalId === inst.id && h.instrument.terms?.right === right && h.quantity > 0;
      const prior = (h.allocations || []).filter((a) => a.protectedPositionId === primaryId).reduce((a, x) => a + (x.units || 0), 0);
      const room = (h.capacityLeft || 0) + prior;
      const want = Math.max(0, fullQty - protectedUnits);
      const units = sameName ? Math.min(room, want) : 0;
      if (units > 0) {
        allocations.push({ hedgePositionId: h.positionId, protectedPositionId: primaryId, units, basis: 'shared', note: 'Illustrative demo rule: a bought option on the same underlying, in the protecting direction, up to the capacity it has left.' });
        protectedUnits += units;
        already.push(`${units} units covered by ${h.instrument.symbol || h.instrument.name}, held in the Account`);
      } else {
        unrelated.push({ hedgePositionId: h.positionId, protectedPositionId: primaryId, note: sameName ? (room > 0 ? 'Illustrative demo rule: nothing is left to cover on this position.' : 'Illustrative demo rule: this hedge has no capacity left; it is allocated elsewhere.') : 'Illustrative demo rule: only bought options on the same underlying, in the protecting direction, are related.' });
      }
    }
    if (allocations.length || unrelated.length) response.protection = { allocations, unrelated, illustrative: true, note: 'Illustrative assessment from the demo fixture. Applicability and sizing are decided by Analytics Lab in real use.' };
  }
  const qty = otherProtection ? 0 : Math.max(0, fullQty - protectedUnits);
  const sizedNote = already.length ? `Sized against the unprotected remainder: ${qty} of ${fullQty} units (${already.join('; ')}).` : null;
  const priceRiskCovered = qty <= 0;
  if (priceRiskCovered) response.note = `Nothing further is proposed for price risk: the position is already protected (${already.join('; ')}). The demo fixture does not layer a second hedge on top.`;
  const notional = qty * px * inst.multiplier;
  const valuation = { source: 'Simulated demo feed', asOf: now, status: 'simulated', availability: 'Demo instruments only' };
  const exposure = [{ measure: 'notional', unit: ccy, before: Math.round(notional * (long ? 1 : -1)), after: null, residual: null, basisRisk: null }];
  const horizon = request.holdingPeriod?.days ? { days: request.holdingPeriod.days } : { days: 30 };

  // ---- options ---------------------------------------------------------------------------------
  const chainRes = priceRiskCovered ? null : await app.data.market.optionChain(inst, {});
  const notes = [FIXTURE_NOTE, ...(sizedNote ? [sizedNote] : [])];
  const r2 = (x) => Math.round(x * 100) / 100;
  if (chainRes?.available) {
    const exps = chainRes.chain.expirations;
    const exp = exps[Math.min(2, exps.length - 1)];
    const chain = (await app.data.market.optionChain(inst, { expiration: exp })).chain;
    const pick = (right, target) => {
      const list = right === 'C' ? chain.calls : chain.puts;
      return list.reduce((best, c) => (Math.abs(c.strike - target) < Math.abs(best.strike - target) ? c : best), list[0]);
    };
    const spec = (c) => ({ underlyingId: inst.id, expiration: exp, strike: c.strike, right: c.right, multiplier: c.multiplier, deliverableUnits: c.deliverable?.shares ?? c.multiplier, exercise: c.exercise, settlement: c.settlement });
    const ind = (c) => ({ value: (c.bid + c.ask) / 2, status: 'simulated', source: 'Simulated demo feed', asOf: now });
    const protect = long ? pick('P', px * 0.95) : pick('C', px * 1.05);
    const contracts = Math.floor(qty / (protect.deliverable?.shares ?? protect.multiplier));
    if (contracts >= 1) {
      packages.push({
        id: 'demo-protective', label: long ? 'Protective put' : 'Protective call', recommended: true,
        riskAddressed: [long ? 'Downside price risk' : 'Upside price risk on the short'], intendedProtection: `${long ? 'Floor' : 'Cap'} near ${protect.strike} until ${exp}`,
        horizon: { until: exp }, exposure, upsideSurrendered: 'None beyond the premium paid',
        // An estimate at the executable side of the quote seen when the fixture answered. The Terminal re-prices the legs itself.
        costs: { currency: ccy, upfrontCash: r2(contracts * protect.multiplier * protect.ask), premiums: r2(contracts * protect.multiplier * protect.ask), expectedOngoing: 0, margin: 0, collateral: 0, borrowing: 0, funding: 0, basis: 'premium at the ask when proposed, before fees' },
        scenarios: [], valuation, notes,
        legs: [{ role: 'hedge', hedgeFamily: 'Options', kind: 'trade', action: 'buy', option: spec(protect), quantity: contracts, sizingBasis: 'contract deliverable (illustrative 1:1)', hedgeRatio: 1, riskAddressed: 'Price', indicative: ind(protect) }],
      });
      if (long) {
        const call = pick('C', px * 1.07);
        packages.push({
          id: 'demo-collar', label: 'Collar', recommended: false,
          riskAddressed: ['Downside price risk'], intendedProtection: `Floor near ${protect.strike}, upside capped near ${call.strike}, until ${exp}`,
          horizon: { until: exp }, exposure, upsideSurrendered: `Gains above ${call.strike}`,
          costs: { currency: ccy, upfrontCash: r2(contracts * protect.multiplier * (protect.ask - call.bid)), premiums: r2(contracts * protect.multiplier * (protect.ask - call.bid)), expectedOngoing: 0, margin: 0, collateral: 0, borrowing: 0, funding: 0, basis: 'put at the ask less call at the bid when proposed, before fees' },
          scenarios: [], valuation, notes,
          legs: [
            { role: 'hedge', hedgeFamily: 'Options', kind: 'trade', action: 'buy', option: spec(protect), quantity: contracts, sizingBasis: 'contract deliverable (illustrative 1:1)', hedgeRatio: 1, riskAddressed: 'Price', indicative: ind(protect) },
            { role: 'hedge', hedgeFamily: 'Options', kind: 'trade', action: 'sell', option: spec(call), quantity: contracts, sizingBasis: 'contract deliverable (illustrative 1:1)', hedgeRatio: 1, riskAddressed: 'Price (financing the put)', indicative: ind(call) },
          ],
        });
      }
    }
  }

  // ---- index future ------------------------------------------------------------------------------
  const root = ccy === 'JPY' ? 'SKJ' : ccy === 'USD' ? 'S5' : null;
  if (root && !priceRiskCovered) {
    const fut = app.instruments.list({ family: 'future' }).filter((f) => f.terms.root === root && f.terms.expiration > today).sort((a, b) => (a.terms.expiration < b.terms.expiration ? -1 : 1))[0];
    if (fut) await app.data.refresh({ instruments: [fut] });
    const fpx = fut ? app.data.price(fut.id)?.value ?? null : null;
    if (fut && fpx) {
      const contracts = Math.max(1, Math.round(notional / (fpx * fut.multiplier)));
      packages.push({
        id: 'demo-future', label: `${DEMO_FUTURES[root].name.replace(' (demo)', '')} overlay`, recommended: packages.length === 0,
        riskAddressed: ['Market exposure'], intendedProtection: 'Offsets broad-market moves; stock-specific risk remains',
        horizon, exposure, upsideSurrendered: 'Market-driven gains while the overlay is on',
        costs: { currency: fut.trading_ccy, upfrontCash: 0, premiums: 0, expectedOngoing: null, margin: contracts * (fut.terms.initialMargin || 0), collateral: 0, borrowing: 0, funding: 0 },
        scenarios: [], valuation, notes: [...notes, 'Sized to equal notional, not to beta.'],
        legs: [{ role: 'hedge', hedgeFamily: 'Futures and forwards', kind: 'trade', action: long ? 'sell' : 'buy', instrumentId: fut.id, quantity: contracts, sizingBasis: 'notional (illustrative; not beta-adjusted)', hedgeRatio: 1, riskAddressed: 'Market', indicative: { value: fpx, status: 'simulated', source: 'Simulated demo feed', asOf: now } }],
      });
    }
  }

  // ---- total-return swap ---------------------------------------------------------------------------
  if (ccy === 'USD' && !priceRiskCovered) {
    const maturity = adjust(addMonths(today, 6), 'modified-following', 'US');
    packages.push({
      id: 'demo-trs', label: 'Equity total-return swap', recommended: false,
      riskAddressed: [long ? 'Price and dividend exposure' : 'Short exposure'], intendedProtection: `Transfers the total return on ${inst.symbol} for six months`,
      horizon: { until: maturity }, exposure, upsideSurrendered: long ? 'All of the reference return while the swap is on' : 'None',
      costs: { currency: ccy, upfrontCash: 0, premiums: 0, expectedOngoing: null, margin: null, collateral: Math.round(notional) * 0.1, borrowing: 0, funding: null, basis: 'independent amount of 10% of notional, posted in cash' },
      scenarios: [], valuation: { source: 'Demo fixture', asOf: now, status: 'indicative', availability: 'Indicative terms; not an executable dealer quote' }, notes,
      legs: [{
        role: 'hedge', hedgeFamily: 'Total-return and equity swaps', kind: 'trade', action: 'buy', quantity: Math.round(notional), sizingBasis: 'notional (illustrative)', hedgeRatio: 1, riskAddressed: 'Price and dividends',
        contract: {
          productId: 'equity_trs', name: `TRS on ${inst.symbol} ${today} to ${maturity} (demo)`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: ccy, underlyingId: inst.id,
          terms: {
            effective: today, maturity, counterparty: 'Simulated dealer', initialMarginPct: 0.1, collateral: 'Cash, returned at maturity or close (demo terms)', initialPrices: { A: px },
            legs: [
              { id: 'A', side: long ? 'pay' : 'receive', type: 'return', ccy, months: 3, underlyingId: inst.id, passDividends: true, resetNotional: false },
              { id: 'B', side: long ? 'receive' : 'pay', type: 'float', ccy, index: 'SIM-ON', spread: 0.005, months: 3, dayCount: 'ACT/360' },
            ],
          },
        },
        indicative: { value: 0, status: 'indicative', source: 'Demo fixture', asOf: now },
      }],
    });
  }

  // ---- currency forward for foreign-currency exposure ------------------------------------------------
  if (ccy !== request.book.reportingCurrency) {
    const rc = request.book.reportingCurrency;
    const fxNotional = fullQty * px * inst.multiplier; // currency exposure is the whole market value
    await app.data.refresh({ pairs: [`${ccy}/${rc}`] });
    const fx = app.data.fx(ccy, rc);
    const valueDate = adjust(addMonths(today, 3), 'modified-following', `${CURRENCY_CALENDAR[ccy] || 'WEEKEND'}+${CURRENCY_CALENDAR[rc] || 'WEEKEND'}`);
    if (fx) {
      const fwdLeg = {
        role: 'hedge', hedgeFamily: 'Currency derivatives', kind: 'trade', action: long ? 'sell' : 'buy', quantity: Math.round(fxNotional), sizingBasis: 'currency exposure (illustrative: full market value)', hedgeRatio: 1, riskAddressed: 'Currency',
        contract: { productId: 'fx_forward', name: `${ccy}/${rc} forward ${valueDate} (demo)`, marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: rc, terms: { forwardType: 'fx', base: ccy, quote: rc, valueDate, counterparty: 'Simulated dealer', collateralBasis: { type: 'uncollateralized' } } }, // demo terms: an OTC leg must state its collateral basis
        indicative: { value: fx.rate, status: 'indicative', source: 'Demo fixture (spot level, no forward points)', asOf: now },
      };
      packages.push({
        id: 'demo-fx', label: `${ccy} currency forward`, recommended: false,
        riskAddressed: ['Currency exposure'], intendedProtection: `Locks the ${ccy}/${rc} rate on the position's market value to ${valueDate}`,
        horizon: { until: valueDate }, exposure: [{ measure: 'fx', unit: ccy, before: Math.round(fxNotional), after: null, residual: null, basisRisk: null }], upsideSurrendered: `Gains from ${ccy} strength`,
        costs: { currency: rc, upfrontCash: 0, premiums: 0, expectedOngoing: null, margin: null, collateral: null, borrowing: 0, funding: 0 },
        scenarios: [], valuation: { source: 'Demo fixture', asOf: now, status: 'indicative', availability: 'Indicative rate; not an executable dealer quote' }, notes: [FIXTURE_NOTE],
        legs: [fwdLeg],
      });
      const futPkg = packages.find((k) => k.id === 'demo-future');
      if (futPkg) {
        packages.push({
          ...futPkg, id: 'demo-combined', label: 'Market overlay plus currency forward', recommended: true,
          riskAddressed: ['Market exposure', 'Currency exposure'], intendedProtection: 'Two hedges addressing two separate risks in one package',
          exposure: [...exposure, { measure: 'fx', unit: ccy, before: Math.round(fxNotional), after: null, residual: null, basisRisk: null }],
          legs: [...futPkg.legs, fwdLeg], notes: [FIXTURE_NOTE, 'Combines hedges from two families.'],
        });
        futPkg.recommended = false;
      }
    }
  }
  response.recommendedId = packages.find((k) => k.recommended)?.id || packages[0]?.id || null;
  for (const k of packages) k.recommended = k.id === response.recommendedId;
  return response;
}
