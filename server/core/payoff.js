// Trade-preview arithmetic: expiry payoff, breakevens, maximum gain and loss.
//
// For a package on one underlying (the underlying itself plus options on it) the payoff at the
// first option expiration is exact contract arithmetic. Options that expire later are valued at
// that date with Black-Scholes only when a volatility is available, and the assumption is listed;
// without one they are shown at intrinsic value and flagged as a lower bound.
//
// Packages with no simple fixed result (pairs, futures hedges, calendar spreads in futures, OTC
// structures) get a linear scenario table with its assumptions instead. These are previews of the
// execution package, not risk analytics: exposure, hedge and scenario analysis belong to Shaffer
// Analytics Lab.

import { blackScholes, intrinsic } from '../quant/options.js';
import { diffDays } from '../quant/dates.js';
import { round } from './util.js';

const LINEAR = new Set(['equity', 'fund', 'spot', 'crypto', 'manual', 'future']);

/**
 * @param {Array} legs  [{ inst, signedQty, price (estimated fill, may be null), existing (bool), iv }]
 */
export function analyzePackage(app, legs, { today, assumedVol } = {}) {
  const trade = legs.filter((l) => l.inst && l.signedQty);
  if (!trade.length) return null;
  const optionLegs = trade.filter((l) => l.inst.family === 'option' || (l.inst.family === 'otcoption' && l.inst.terms.optionType === 'vanilla'));
  const linearLegs = trade.filter((l) => LINEAR.has(l.inst.family));
  const other = trade.filter((l) => !optionLegs.includes(l) && !linearLegs.includes(l));

  const underlyings = new Set();
  for (const l of optionLegs) underlyings.add(l.inst.underlying_id || `self:${l.inst.id}`);
  for (const l of linearLegs) underlyings.add(l.inst.id);

  if (optionLegs.length && underlyings.size === 1 && !other.length) return expiryPayoff(app, { optionLegs, linearLegs, underlyingId: [...underlyings][0], today, assumedVol });
  if (!optionLegs.length && linearLegs.length && !other.length) return linearScenarios(app, linearLegs);
  if (trade.length === 1 && linearLegs.length === 1) return linearScenarios(app, linearLegs);
  return {
    type: 'none',
    note: 'This package has no simple fixed payoff. Review each leg\'s cash flows and requirements below. Risk and scenario analysis for it is supplied by Shaffer Analytics Lab when connected.',
    assumptions: [],
  };
}

function expiryPayoff(app, { optionLegs, linearLegs, underlyingId, today, assumedVol }) {
  const und = app.instruments.get(underlyingId);
  const undObs = und ? app.data.price(und.id) : null;
  const stockLeg = linearLegs[0];
  const S0 = stockLeg?.price ?? undObs?.value ?? null;
  const assumptions = [];
  const missingPrice = optionLegs.some((l) => l.price === null || l.price === undefined) || linearLegs.some((l) => l.price === null || l.price === undefined);
  if (missingPrice) {
    return { type: 'none', note: 'Breakeven and maximum gain/loss need an estimated price for every leg. Enter a manual price or state a fill price for the legs that have none.', assumptions };
  }
  const expiries = [...new Set(optionLegs.map((l) => l.inst.terms.expiration))].sort();
  const T0 = expiries[0];
  const strikes = [...new Set(optionLegs.map((l) => l.inst.terms.strike))].sort((a, b) => a - b);
  const later = optionLegs.filter((l) => l.inst.terms.expiration > T0);
  let laterLowerBound = false;
  if (later.length) {
    const haveVol = later.every((l) => (l.iv ?? assumedVol) > 0);
    if (haveVol) assumptions.push(`Options expiring after ${T0} are valued on that date with Black-Scholes at ${later.map((l) => `${Math.round((l.iv ?? assumedVol) * 1000) / 10}%`).join(' / ')} volatility, zero rates and no dividends. This is a preview approximation.`);
    else {
      laterLowerBound = true;
      assumptions.push(`No volatility is available, so options expiring after ${T0} are shown at intrinsic value only. Their remaining time value is not included: treat the result as a lower bound.`);
    }
  }
  assumptions.push(`Payoff at the close of ${T0}, before fees. Entry prices are the estimated fills shown for each leg.`);
  if (linearLegs.some((l) => l.existing)) assumptions.push('For positions already held, the entry price is the current price, so the payoff is measured from today.');

  // Underlying units of a leg, in units of the underlying's own price. A listed option delivers `deliverable.units`
  // of the underlying instrument; when that instrument is itself a contract with a multiplier (an option on a
  // future), each delivered contract stands for `multiplier` underlying units.
  const unitsOf = (l) => l.signedQty * (l.inst.family === 'option' ? l.inst.terms.deliverable.units * (und?.multiplier ?? 1) : l.inst.multiplier);
  const premium = (l) => l.signedQty * l.price * l.inst.multiplier;
  const valueAt = (S) => {
    let v = 0;
    for (const l of linearLegs) v += l.signedQty * l.inst.multiplier * (S - l.price);
    for (const l of optionLegs) {
      const t = l.inst.terms;
      let per;
      if (t.expiration === T0) per = intrinsic(t.right, S, t.strike);
      else {
        const sigma = l.iv ?? assumedVol;
        const T = diffDays(T0, t.expiration) / 365;
        per = sigma > 0 ? blackScholes({ S, K: t.strike, T, sigma, right: t.right }) : intrinsic(t.right, S, t.strike);
      }
      v += unitsOf(l) * per - premium(l);
    }
    return v;
  };

  const hi = Math.max(S0 || 0, ...strikes) * 2 || 100;
  const xs = new Set([0, hi]);
  for (const k of strikes) { xs.add(k); xs.add(k * 0.999); xs.add(k * 1.001); }
  if (S0) xs.add(S0);
  const lo = Math.min(S0 || strikes[0], strikes[0]) * 0.5;
  for (let i = 0; i <= 80; i++) xs.add(lo + ((hi * 0.75 - lo) * i) / 80);
  const grid = [...xs].filter((x) => x >= 0).sort((a, b) => a - b);
  const points = grid.map((s) => ({ s: round(s, 4), pnl: round(valueAt(s), 2) }));

  // Slope beyond the highest strike decides whether the upside is bounded.
  let slopeUp = 0;
  for (const l of linearLegs) slopeUp += l.signedQty * l.inst.multiplier;
  for (const l of optionLegs) if (l.inst.terms.right === 'C') slopeUp += unitsOf(l);
  const finite = [0, ...strikes, ...(later.length ? grid : [])].map((s) => valueAt(s));
  const atZero = valueAt(0);
  const maxFinite = Math.max(...finite), minFinite = Math.min(...finite);
  const eps = 1e-9;
  const maxGain = slopeUp > eps ? { unbounded: true, value: null, note: 'Unbounded as the underlying rises.' } : { unbounded: false, value: round(maxFinite, 2) };
  const maxLoss = slopeUp < -eps ? { unbounded: true, value: null, note: 'Unbounded as the underlying rises.' } : { unbounded: false, value: round(Math.min(minFinite, 0), 2) };
  if (laterLowerBound) { maxGain.approximate = true; maxLoss.approximate = true; }

  const breakevens = [];
  for (let i = 1; i < grid.length; i++) {
    const a = valueAt(grid[i - 1]), b = valueAt(grid[i]);
    if (a === 0) breakevens.push(grid[i - 1]);
    else if (a * b < 0) breakevens.push(grid[i - 1] + ((grid[i] - grid[i - 1]) * -a) / (b - a));
  }
  // A break-even above the plotted range exists when the payoff is still rising/falling through zero.
  const last = valueAt(hi);
  if (slopeUp !== 0 && last * slopeUp < 0) breakevens.push(hi - last / slopeUp);
  const uniq = [...new Set(breakevens.map((b) => round(b, 2)))].sort((a, b) => a - b);

  return {
    type: 'expiry-payoff',
    underlying: und ? { id: und.id, symbol: und.symbol, name: und.name } : null,
    currency: optionLegs[0].inst.trading_ccy,
    asOfExpiry: T0,
    referencePrice: S0,
    points,
    breakevens: uniq,
    maxGain, maxLoss,
    valueAtZero: round(atZero, 2),
    daysToExpiry: today ? diffDays(today, T0) : null,
    assumptions,
  };
}

function linearScenarios(app, legs) {
  const missing = legs.some((l) => l.price === null || l.price === undefined);
  if (missing) return { type: 'none', note: 'A scenario view needs an estimated price for every leg. Enter a manual price or state a fill price for the legs that have none.', assumptions: [] };
  const factors = legs.map((l) => ({ id: l.inst.id, label: l.inst.symbol || l.inst.name, price: l.price, exposure: l.signedQty * l.inst.multiplier * l.price, ccy: l.inst.trading_ccy }));
  const ccys = [...new Set(factors.map((f) => f.ccy))];
  const shocks = [-0.2, -0.1, -0.05, 0.05, 0.1, 0.2];
  const rows = [];
  if (factors.length === 1) {
    for (const s of shocks) rows.push({ label: `${factors[0].label} ${s > 0 ? '+' : ''}${s * 100}%`, pnl: { [factors[0].ccy]: round(factors[0].exposure * s, 2) } });
  } else {
    const sum = (moves) => {
      const out = {};
      factors.forEach((f, i) => { out[f.ccy] = round((out[f.ccy] || 0) + f.exposure * moves[i], 2); });
      return out;
    };
    for (const s of [-0.1, 0.1]) rows.push({ label: `All legs ${s > 0 ? '+' : ''}${s * 100}%`, pnl: sum(factors.map(() => s)) });
    factors.forEach((f, i) => {
      for (const s of [-0.1, 0.1]) rows.push({ label: `${f.label} ${s > 0 ? '+' : ''}${s * 100}%, others unchanged`, pnl: sum(factors.map((_, k) => (k === i ? s : 0))) });
    });
    if (factors.length === 2) {
      rows.push({ label: `${factors[0].label} +10%, ${factors[1].label} -10%`, pnl: sum([0.1, -0.1]) });
      rows.push({ label: `${factors[0].label} -10%, ${factors[1].label} +10%`, pnl: sum([-0.1, 0.1]) });
    }
  }
  const net = {};
  for (const f of factors) net[f.ccy] = round((net[f.ccy] || 0) + f.exposure, 2);
  const allLong = factors.every((f) => f.exposure > 0), allShort = factors.every((f) => f.exposure < 0);
  return {
    type: 'scenarios',
    currency: ccys.length === 1 ? ccys[0] : null,
    exposures: factors.map((f) => ({ label: f.label, exposure: round(f.exposure, 2), ccy: f.ccy })),
    netExposure: net,
    rows,
    maxGain: allShort ? { unbounded: false, value: round(-factors.reduce((a, f) => a + f.exposure, 0), 2), note: 'If every shorted price falls to zero.' } : { unbounded: true, value: null, note: allLong ? 'Unbounded as prices rise.' : 'No fixed maximum: depends on the relative move of the legs.' },
    maxLoss: allLong ? { unbounded: false, value: round(-factors.reduce((a, f) => a + f.exposure, 0), 2), note: 'If every price falls to zero.' } : { unbounded: true, value: null, note: allShort ? 'Unbounded as prices rise.' : 'No fixed maximum: depends on the relative move of the legs.' },
    assumptions: ['Linear revaluation of each leg at the estimated fill price, before fees and financing costs.', 'Scenarios move the stated legs only; no correlation or basis behaviour is assumed.'],
  };
}

/**
 * Cash that must be reserved against the short options of one strategy instance on one underlying.
 * positions: [{ inst, qty }] of the strategy bucket (underlying and its options).
 * Rules (rule-based paper-desk assumptions, not a risk model):
 *   - the largest loss of the option structure at any strike or at zero is reserved in full
 *     (a short put is therefore fully cash-secured, a credit spread reserves its width);
 *   - long stock covers short calls and short stock covers short puts, unit for unit;
 *   - each uncovered short call unit reserves nakedCallPct of the underlying's value.
 */
export function optionRequirement(app, positions, { nakedCallPct }) {
  const groups = new Map();
  for (const p of positions) {
    if (p.inst.family !== 'option') continue;
    const key = p.inst.underlying_id || p.inst.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const out = [];
  for (const [underlyingId, opts] of groups) {
    const shorts = opts.filter((p) => p.qty < 0);
    if (!shorts.length) continue;
    const lastShortExpiry = shorts.map((p) => p.inst.terms.expiration).sort().pop();
    // Units of the underlying's own price per position: contracts x what one contract delivers x the multiplier of
    // the instrument delivered (1 for shares; 1,000 barrels for a crude oil future). Measured this way, a written
    // put on a future is secured on its whole contract value, and one future covers one option, unit for unit.
    const perDelivered = app.instruments.get(underlyingId)?.multiplier ?? 1;
    const units = (p) => p.qty * p.inst.terms.deliverable.units * perDelivered;
    // A long option only covers if it lives at least as long as the shorts.
    const live = opts.filter((p) => p.qty < 0 || p.inst.terms.expiration >= lastShortExpiry);
    const stock = positions.find((p) => p.inst.id === underlyingId);
    const stockUnits = stock ? stock.qty * stock.inst.multiplier : 0;
    const netShortCalls = -live.filter((p) => p.inst.terms.right === 'C').reduce((a, p) => a + units(p), 0);
    const netShortPuts = -live.filter((p) => p.inst.terms.right === 'P').reduce((a, p) => a + units(p), 0);
    const legs = live.map((p) => ({ right: p.inst.terms.right, K: p.inst.terms.strike, u: units(p) }));
    const shortCallStrikes = shorts.filter((p) => p.inst.terms.right === 'C').map((p) => p.inst.terms.strike);
    const shortPutStrikes = shorts.filter((p) => p.inst.terms.right === 'P').map((p) => p.inst.terms.strike);
    let coveredCalls = 0, coveredPuts = 0;
    if (stockUnits > 0 && netShortCalls > 0) { coveredCalls = Math.min(stockUnits, netShortCalls); legs.push({ right: 'C', K: Math.min(...shortCallStrikes), u: coveredCalls }); }
    if (stockUnits < 0 && netShortPuts > 0) { coveredPuts = Math.min(-stockUnits, netShortPuts); legs.push({ right: 'P', K: Math.max(...shortPutStrikes), u: coveredPuts }); }
    const value = (S) => legs.reduce((a, l) => a + l.u * intrinsic(l.right, S, l.K), 0);
    const pts = [0, ...new Set(legs.map((l) => l.K))];
    const worst = Math.min(0, ...pts.map(value));
    const uncoveredCalls = Math.max(0, netShortCalls - coveredCalls);
    const und = app.instruments.get(underlyingId);
    const px = und ? app.data.price(underlyingId)?.value ?? null : null;
    const ref = px ?? Math.max(...opts.map((p) => p.inst.terms.strike));
    const naked = uncoveredCalls * nakedCallPct * ref;
    const ccy = opts[0].inst.trading_ccy;
    out.push({
      underlyingId, ccy, amount: round(-worst + naked, 2), finite: round(-worst, 2), naked: round(naked, 2), uncoveredCallUnits: uncoveredCalls,
      coveredCallUnits: coveredCalls, coveredPutUnits: coveredPuts, lockedStockUnits: coveredCalls > 0 ? coveredCalls : coveredPuts > 0 ? -coveredPuts : 0,
      priceBasis: uncoveredCalls > 0 ? (px !== null ? 'underlying price' : 'highest strike (no underlying price available)') : null,
    });
  }
  return out;
}
