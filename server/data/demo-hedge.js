// DEMO FIXTURE for the Hedge workflow.
//
// This is NOT Shaffer Hedge and contains no hedge-selection or sizing logic worth the name. It
// returns a few canned packages for the fictional demo instruments so the Hedge popup, the
// product-specific tickets, Execute Now, leg linking and the lifecycle can be exercised in the
// isolated demo environment before Analytics Lab is connected. Every package is labelled as a
// demo fixture; quantities are simple notional matches and are stated as illustrative.
//
// It is only reachable when the Terminal runs in demo mode.

import { addMonths } from '../quant/dates.js';
import { adjust } from '../quant/calendar.js';
import { DEMO_FUTURES } from './demo.js';

const FIXTURE_NOTE = 'Demo fixture, not Shaffer Hedge output. Structure and sizing are illustrative only.';

export async function demoHedgeResponse(app, request) {
  const now = app.clock.now().toISOString();
  const today = app.clock.today();
  const p = request.primary;
  const packages = [];
  const response = { source: 'Demo fixture (not Shaffer Hedge)', asOf: now, modelRun: null, fixture: true, recommendedId: null, packages };
  if (!p?.instrument?.terminalId) return response;
  const inst = app.instruments.get(p.instrument.terminalId);
  if (!inst || !['equity', 'fund'].includes(inst.family)) {
    response.note = 'The demo fixture only has canned proposals for the fictional demo equities.';
    return response;
  }
  const long = p.direction !== 'short';
  const qty = Math.abs(p.quantity || 0);
  const px = app.data.price(inst.id)?.value ?? p.averagePrice ?? null;
  if (!(qty > 0) || px === null) return response;
  const ccy = inst.trading_ccy;
  const notional = qty * px * inst.multiplier;
  const valuation = { source: 'Simulated demo feed', asOf: now, status: 'simulated', availability: 'Demo instruments only' };
  const exposure = [{ measure: 'notional', unit: ccy, before: Math.round(notional * (long ? 1 : -1)), after: null, residual: null, basisRisk: null }];
  const horizon = request.holdingPeriod?.days ? { days: request.holdingPeriod.days } : { days: 30 };

  // ---- options ---------------------------------------------------------------------------------
  const chainRes = await app.data.market.optionChain(inst, {});
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
        costs: { currency: ccy, upfrontCash: null, premiums: Math.round(contracts * protect.multiplier * ((protect.bid + protect.ask) / 2) * 100) / 100, expectedOngoing: 0, margin: 0, collateral: 0, borrowing: 0, funding: 0 },
        scenarios: [], valuation, notes: [FIXTURE_NOTE],
        legs: [{ role: 'hedge', hedgeFamily: 'Options', kind: 'trade', action: 'buy', option: spec(protect), quantity: contracts, sizingBasis: 'contract deliverable (illustrative 1:1)', hedgeRatio: 1, riskAddressed: 'Price', indicative: ind(protect) }],
      });
      if (long) {
        const call = pick('C', px * 1.07);
        packages.push({
          id: 'demo-collar', label: 'Collar', recommended: false,
          riskAddressed: ['Downside price risk'], intendedProtection: `Floor near ${protect.strike}, upside capped near ${call.strike}, until ${exp}`,
          horizon: { until: exp }, exposure, upsideSurrendered: `Gains above ${call.strike}`,
          costs: { currency: ccy, upfrontCash: null, premiums: Math.round(contracts * protect.multiplier * (((protect.bid + protect.ask) - (call.bid + call.ask)) / 2) * 100) / 100, expectedOngoing: 0, margin: 0, collateral: 0, borrowing: 0, funding: 0 },
          scenarios: [], valuation, notes: [FIXTURE_NOTE],
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
  if (root) {
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
        scenarios: [], valuation, notes: [FIXTURE_NOTE, 'Sized to equal notional, not to beta.'],
        legs: [{ role: 'hedge', hedgeFamily: 'Futures and forwards', kind: 'trade', action: long ? 'sell' : 'buy', instrumentId: fut.id, quantity: contracts, sizingBasis: 'notional (illustrative; not beta-adjusted)', hedgeRatio: 1, riskAddressed: 'Market', indicative: { value: fpx, status: 'simulated', source: 'Simulated demo feed', asOf: now } }],
      });
    }
  }

  // ---- total-return swap ---------------------------------------------------------------------------
  if (ccy === 'USD') {
    const maturity = adjust(addMonths(today, 6), 'modified-following', 'US');
    packages.push({
      id: 'demo-trs', label: 'Equity total-return swap', recommended: false,
      riskAddressed: [long ? 'Price and dividend exposure' : 'Short exposure'], intendedProtection: `Transfers the total return on ${inst.symbol} for six months`,
      horizon: { until: maturity }, exposure, upsideSurrendered: long ? 'All of the reference return while the swap is on' : 'None',
      costs: { currency: ccy, upfrontCash: 0, premiums: 0, expectedOngoing: null, margin: null, collateral: null, borrowing: 0, funding: null },
      scenarios: [], valuation: { source: 'Demo fixture', asOf: now, status: 'indicative', availability: 'Indicative terms; not an executable dealer quote' }, notes: [FIXTURE_NOTE],
      legs: [{
        role: 'hedge', hedgeFamily: 'Total-return and equity swaps', kind: 'trade', action: 'buy', quantity: Math.round(notional), sizingBasis: 'notional (illustrative)', hedgeRatio: 1, riskAddressed: 'Price and dividends',
        contract: {
          productId: 'equity_trs', name: `TRS on ${inst.symbol} ${today} to ${maturity} (demo)`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: ccy, underlyingId: inst.id,
          terms: {
            effective: today, maturity, counterparty: 'Simulated dealer', collateral: 'None stated (demo)', initialPrices: { A: px },
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
    await app.data.refresh({ pairs: [`${ccy}/${rc}`] });
    const fx = app.data.fx(ccy, rc);
    const valueDate = adjust(addMonths(today, 3), 'modified-following', 'WEEKEND');
    if (fx) {
      const fwdLeg = {
        role: 'hedge', hedgeFamily: 'Currency derivatives', kind: 'trade', action: long ? 'sell' : 'buy', quantity: Math.round(notional), sizingBasis: 'currency exposure (illustrative: full market value)', hedgeRatio: 1, riskAddressed: 'Currency',
        contract: { productId: 'fx_forward', name: `${ccy}/${rc} forward ${valueDate} (demo)`, marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: rc, terms: { forwardType: 'fx', base: ccy, quote: rc, valueDate, counterparty: 'Simulated dealer' } },
        indicative: { value: fx.rate, status: 'indicative', source: 'Demo fixture (spot level, no forward points)', asOf: now },
      };
      packages.push({
        id: 'demo-fx', label: `${ccy} currency forward`, recommended: false,
        riskAddressed: ['Currency exposure'], intendedProtection: `Locks the ${ccy}/${rc} rate on the position's market value to ${valueDate}`,
        horizon: { until: valueDate }, exposure: [{ measure: 'fx', unit: ccy, before: Math.round(notional), after: null, residual: null, basisRisk: null }], upsideSurrendered: `Gains from ${ccy} strength`,
        costs: { currency: rc, upfrontCash: 0, premiums: 0, expectedOngoing: null, margin: null, collateral: null, borrowing: 0, funding: 0 },
        scenarios: [], valuation: { source: 'Demo fixture', asOf: now, status: 'indicative', availability: 'Indicative rate; not an executable dealer quote' }, notes: [FIXTURE_NOTE],
        legs: [fwdLeg],
      });
      const futPkg = packages.find((k) => k.id === 'demo-future');
      if (futPkg) {
        packages.push({
          ...futPkg, id: 'demo-combined', label: 'Market overlay plus currency forward', recommended: true,
          riskAddressed: ['Market exposure', 'Currency exposure'], intendedProtection: 'Two hedges addressing two separate risks in one package',
          exposure: [...exposure, { measure: 'fx', unit: ccy, before: Math.round(notional), after: null, residual: null, basisRisk: null }],
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
