// Manually valued holdings and contracts (engine family "manual", catalog support "manual").
//
// Sixteen catalog products have no market feed, no model and no automated lifecycle in the Terminal: every term,
// valuation, cash flow and settlement is entered by hand. This module gives each of them a complete, clearly
// labelled manual workflow on top of the security-like booking of the family (average cost, cash on a settlement
// date). Nothing here prices anything: a value is what the user enters, labelled "Manual" with its valuation date
// and source wherever it appears, and every event entered by hand is a history row that says so.
//
// Kinds of product and what is recorded for each (quantity / price units in brackets):
//   commitment      private equity, venture capital fund interests  (share of the interest, 1 = the whole commitment /
//                   value of the whole interest). Commitment is a contract term; capital calls (investment and fee
//                   parts) raise cost and reduce the uncalled amount; distributions are split into return of capital
//                   (lowers cost), realized gain and income, with carried interest withheld as entered; a secondary
//                   sale transfers the same share of the commitment and of what was called; a final wind-up realises
//                   what cost is left and releases what was never called.
//   fund_interest   hedge fund interest  (shares / NAV per share). Subscription on the ticket at the dealing NAV;
//                   redemption only by notice: the dealing date follows the notice period and the dealing frequency,
//                   the gate caps what one dealing date pays out (investor level), the rest is carried to the next
//                   dealing date, and proceeds are paid a stated number of business days later.
//   direct_asset    infrastructure, direct real estate  (share of the asset, 1 = 100% / value of the whole asset).
//                   Purchase and sales on the ticket at a stated price; income (rent, project dividends), operating
//                   expenses and capital expenditure (raises cost) by hand.
//   ils             insurance-linked security  (face amount / % of face). Coupons by hand; a loss event writes face
//                   down (a realized loss); redemption at maturity of what face is left, at a stated price.
//   OTC contracts   collateral swap, freight contract, credit-spread forward and option, variance, volatility,
//                   correlation and dispersion swaps, recovery swap, weather derivative  (contracts, 1 = the contract
//                   as registered; a freight contract in days or tonnes / mark per unit, signed). Entered on the
//                   ticket at a stated upfront (zero, or the premium); marks by hand; the final settlement is worked
//                   out from the realised value entered by hand with the product's formula, which is stated on the
//                   contract and repeated in the history row with the figures used. Each one carries counterparty
//                   exposure, so each must state a collateral basis (core/agreements.js), as swaps and OTC options do.
//
// Valuations: entered with their valuation date and source. A valuation older than the contract's
// `valuationMaxAgeDays` is stale (data/index.js `present`), which makes the net asset value provisional, as a missing
// valuation does. The per-unit price stored is the value entered for the holding divided by its quantity, where the
// product is valued as a whole (an LP interest, a building, an OTC contract).

import { fmt } from '../core/books.js';
import { MANUAL_OTC_PRODUCTS, normalizeBasis } from '../core/agreements.js';
import { AppError, ISO_DATE_RE, isZero, money, need, num, round } from '../core/util.js';
import { addDays, daysInMonth, diffDays, makeDate, ymd } from '../quant/dates.js';
import { addBusinessDays, isBusinessDay, onOrBefore } from '../quant/calendar.js';
import { bookSecurityFill, fmtPx, fmtQty, valueSecurity } from './common.js';

export const MANUAL_KIND = {
  private_equity: 'commitment', venture_capital: 'commitment', hedge_fund: 'fund_interest', infrastructure: 'direct_asset', direct_real_estate: 'direct_asset',
  insurance_linked_security: 'ils', collateral_swap: 'collateral_swap', freight_contract: 'freight', credit_spread_forward: 'spread_forward', credit_spread_option: 'spread_option',
  variance_swap: 'variance', volatility_swap: 'volatility', correlation_swap: 'correlation', dispersion_swap: 'dispersion', recovery_swap: 'recovery', weather_derivative: 'weather',
};
const OTC_KINDS = new Set(['collateral_swap', 'freight', 'spread_forward', 'spread_option', 'variance', 'volatility', 'correlation', 'dispersion', 'recovery', 'weather']);
export const kindOf = (inst) => MANUAL_KIND[inst?.product_id] || 'holding';
export const isManualOtc = (inst) => inst?.family === 'manual' && MANUAL_OTC_PRODUCTS.includes(inst.product_id);

// ---- contract terms -----------------------------------------------------------------------------------------
// type: number | int | date | text | enum. The web form (web/lib/manual.js) shows the same fields with the same labels.
const T = (key, label, type, o = {}) => ({ key, label, type, ...o });
const SIDE_BS = { buy: 'Buyer', sell: 'Seller' };
const SIDE_LS = { long: 'Long', short: 'Short' };
const COMMON = [T('valuationMaxAgeDays', 'Valuation goes stale after (calendar days)', 'int', { required: true, min: 1 })];
const OTC_COMMON = [T('counterparty', 'Counterparty', 'text')];
export const TERMS = {
  commitment: [T('commitment', 'Commitment', 'number', { required: true, positive: true }), T('vintage', 'Vintage year', 'int'), T('manager', 'General partner (manager)', 'text'), T('strategy', 'Fund strategy', 'text')],
  fund_interest: [T('manager', 'Investment manager', 'text'), T('dealingFrequency', 'Dealing (redemption) frequency', 'enum', { required: true, options: { monthly: 'Monthly', quarterly: 'Quarterly' } }),
    T('noticeDays', 'Redemption notice (calendar days)', 'int', { required: true, min: 0 }), T('gatePct', 'Gate (share of the holding per dealing date, decimal)', 'number', { min: 0.0001, max: 1 }),
    T('paymentDays', 'Redemption proceeds paid after (business days)', 'int', { required: true, min: 0, max: 30 }), T('lockupUntil', 'Lock-up until', 'date')],
  direct_asset: [T('assetDescription', 'Asset', 'text', { required: true }), T('location', 'Location', 'text')],
  ils: [T('peril', 'Peril covered', 'text', { required: true }), T('trigger', 'Trigger', 'enum', { options: { indemnity: 'Indemnity', industry_loss: 'Industry loss index', parametric: 'Parametric' } }),
    T('maturity', 'Maturity', 'date', { required: true }), T('couponRate', 'Coupon (decimal a year, for reference)', 'number', { min: 0 })],
  collateral_swap: [T('givenBasket', 'Basket we deliver', 'text', { required: true }), T('givenValue', 'Value of the basket we deliver', 'number', { required: true, positive: true }),
    T('receivedBasket', 'Basket we receive', 'text', { required: true }), T('receivedValue', 'Value of the basket we receive', 'number', { required: true, positive: true }),
    T('feeNotional', 'Fee notional', 'number', { required: true, positive: true }), T('feeBp', 'Fee (basis points a year)', 'number', { required: true, min: 0 }),
    T('feePayer', 'Fee paid by', 'enum', { required: true, options: { us: 'Us', counterparty: 'The counterparty' } }), T('dayCount', 'Fee day count', 'enum', { required: true, options: { 'ACT/360': 'ACT/360', 'ACT/365': 'ACT/365' } }),
    T('startDate', 'Start date', 'date', { required: true }), T('endDate', 'End date', 'date', { required: true })],
  freight: [T('route', 'Route or basket', 'text', { required: true }), T('settlementIndex', 'Settlement index', 'text', { required: true }),
    T('quantityUnit', 'Quantity unit', 'enum', { required: true, options: { days: 'Days (time charter)', tonnes: 'Tonnes (voyage)' } }), T('contractRate', 'Contract rate (per unit)', 'number', { required: true, positive: true }),
    T('side', 'Our side', 'enum', { required: true, options: SIDE_BS }), T('periodStart', 'Settlement period start', 'date', { required: true }), T('periodEnd', 'Settlement period end', 'date', { required: true })],
  spread_forward: [T('referenceEntity', 'Reference obligation', 'text', { required: true }), T('forwardSpreadBp', 'Forward spread (basis points)', 'number', { required: true, min: 0 }),
    T('notional', 'Notional', 'number', { required: true, positive: true }), T('riskyDuration', 'Risky duration (years)', 'number', { required: true, positive: true }),
    T('side', 'Our side', 'enum', { required: true, options: { buy: 'Spread buyer (gains if the spread widens)', sell: 'Spread seller (gains if the spread tightens)' } }), T('expiry', 'Expiry (fixing date)', 'date', { required: true })],
  spread_option: [T('referenceEntity', 'Reference obligation', 'text', { required: true }), T('strikeSpreadBp', 'Strike spread (basis points)', 'number', { required: true, min: 0 }),
    T('notional', 'Notional', 'number', { required: true, positive: true }), T('riskyDuration', 'Risky duration (years)', 'number', { required: true, positive: true }),
    T('optionType', 'Option', 'enum', { required: true, options: { payer: 'Payer (pays off if the spread widens above the strike)', receiver: 'Receiver (pays off if the spread tightens below the strike)' } }),
    T('side', 'Our side', 'enum', { required: true, options: { long: 'Holder', short: 'Writer' } }), T('expiry', 'Expiry', 'date', { required: true })],
  variance: [T('underlyingIndex', 'Underlying', 'text', { required: true }), T('strikeVol', 'Strike (volatility points)', 'number', { required: true, positive: true }),
    T('vegaNotional', 'Vega notional (per volatility point)', 'number', { required: true, positive: true }), T('capMultiple', 'Cap (multiple of the strike)', 'number', { min: 1 }),
    T('side', 'Our side', 'enum', { required: true, options: { long: 'Variance buyer (receives realised variance)', short: 'Variance seller (pays realised variance)' } }), T('expiry', 'Expiry', 'date', { required: true })],
  volatility: [T('underlyingIndex', 'Underlying', 'text', { required: true }), T('strikeVol', 'Strike (volatility points)', 'number', { required: true, positive: true }),
    T('vegaNotional', 'Vega notional (per volatility point)', 'number', { required: true, positive: true }),
    T('side', 'Our side', 'enum', { required: true, options: { long: 'Volatility buyer (receives realised volatility)', short: 'Volatility seller (pays realised volatility)' } }), T('expiry', 'Expiry', 'date', { required: true })],
  correlation: [T('basket', 'Basket', 'text', { required: true }), T('strikeCorr', 'Strike (correlation points, 0 to 100)', 'number', { required: true, min: -100, max: 100 }),
    T('notionalPerPoint', 'Notional per correlation point', 'number', { required: true, positive: true }),
    T('side', 'Our side', 'enum', { required: true, options: { long: 'Correlation buyer (receives realised correlation)', short: 'Correlation seller (pays realised correlation)' } }), T('expiry', 'Expiry', 'date', { required: true })],
  dispersion: [T('index', 'Index', 'text', { required: true }), T('constituents', 'Constituents and weights', 'text', { required: true }),
    T('strikeVol', 'Strike (dispersion, volatility points)', 'number', { required: true }), T('notionalPerPoint', 'Notional per volatility point', 'number', { required: true, positive: true }),
    T('side', 'Our side', 'enum', { required: true, options: { long: 'Dispersion buyer (long constituents, short the index)', short: 'Dispersion seller (short constituents, long the index)' } }), T('expiry', 'Expiry', 'date', { required: true })],
  recovery: [T('referenceEntity', 'Reference entity', 'text', { required: true }), T('recoveryStrikePct', 'Fixed recovery rate (%)', 'number', { required: true, min: 0, max: 100 }),
    T('notional', 'Notional', 'number', { required: true, positive: true }),
    T('side', 'Our side', 'enum', { required: true, options: { buy: 'Recovery buyer (gains if recovery is above the fixed rate)', sell: 'Recovery seller (gains if recovery is below the fixed rate)' } }), T('maturity', 'Maturity', 'date', { required: true })],
  weather: [T('station', 'Weather station', 'text', { required: true }), T('index', 'Index', 'enum', { required: true, options: { HDD: 'Heating degree days (HDD)', CDD: 'Cooling degree days (CDD)' } }),
    T('baseTemp', 'Base temperature', 'number', { required: true }), T('periodStart', 'Period start', 'date', { required: true }), T('periodEnd', 'Period end', 'date', { required: true }),
    T('strike', 'Strike (index points)', 'number', { required: true, min: 0 }), T('tick', 'Tick (amount per index point)', 'number', { required: true, positive: true }), T('cap', 'Cap (largest payment)', 'number', { required: true, positive: true }),
    T('optionType', 'Payoff', 'enum', { required: true, options: { call: 'Call', put: 'Put', swap: 'Swap' } }), T('side', 'Our side', 'enum', { required: true, options: { long: 'Holder (buyer)', short: 'Writer (seller)' } })],
  holding: [],
};
const termsOf = (kind) => [...(TERMS[kind] || []), ...COMMON, ...(OTC_KINDS.has(kind) ? OTC_COMMON : [])];

/** When the contract ends: the date a final settlement may be entered from. */
export function endDateOf(inst) {
  const t = inst.terms || {};
  return t.expiry || t.maturity || t.periodEnd || t.endDate || null;
}

const sideSign = (t) => (t.side === 'sell' || t.side === 'short' ? -1 : 1);
const f2 = (x) => Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** The settlement formula of a contract, in words (shown on the contract and in the history). */
export function formulaText(inst) {
  const t = inst.terms || {};
  const ccy = inst.trading_ccy;
  switch (kindOf(inst)) {
    case 'commitment': return 'Valued by hand at the NAV of the interest. Capital calls raise cost; distributions are return of capital (lowers cost), realized gain and income.';
    case 'fund_interest': return 'Valued by hand at the NAV per share. Redeemed by notice on dealing dates, subject to the notice period and the gate.';
    case 'direct_asset': return 'Valued by hand (appraisal). Capital expenditure raises cost; income and operating expenses go to P&L.';
    case 'ils': return 'Valued by hand in % of face. Coupons by hand; a loss event writes face down; what is left is redeemed at maturity.';
    case 'collateral_swap': return `Fee = fee notional x ${t.feeBp} bp / 10,000 x days / ${t.dayCount === 'ACT/365' ? 365 : 360}, paid by ${t.feePayer === 'us' ? 'us' : 'the counterparty'}. The baskets go back at the end.`;
    case 'freight': return `Settlement per period = (average of ${t.settlementIndex || 'the index'} - contract rate ${f2(t.contractRate)}) x quantity settled, ${t.side === 'sell' ? 'paid by us when positive (seller)' : 'received by us when positive (buyer)'}.`;
    case 'spread_forward': return `Settlement = notional x risky duration x (spread at expiry - ${f2(t.forwardSpreadBp)} bp) / 10,000, ${t.side === 'sell' ? 'with the opposite sign for the spread seller' : 'received by the spread buyer when positive'}.`;
    case 'spread_option': return `Payoff = notional x risky duration x max(${t.optionType === 'receiver' ? `${f2(t.strikeSpreadBp)} bp - spread at expiry` : `spread at expiry - ${f2(t.strikeSpreadBp)} bp`}, 0) / 10,000, ${t.side === 'short' ? 'paid by us (writer)' : 'received by us (holder)'}.`;
    case 'variance': return `Settlement = variance notional x (realised volatility² - ${f2(t.strikeVol)}²), variance notional = vega notional / (2 x ${f2(t.strikeVol)})${t.capMultiple ? `, realised volatility capped at ${f2(t.capMultiple)} x strike` : ''}; ${t.side === 'short' ? 'sign reversed for the variance seller' : 'received by the variance buyer when positive'}.`;
    case 'volatility': return `Settlement = vega notional x (realised volatility - ${f2(t.strikeVol)}); ${t.side === 'short' ? 'sign reversed for the volatility seller' : 'received by the volatility buyer when positive'}.`;
    case 'correlation': return `Settlement = notional per point x (realised correlation - ${f2(t.strikeCorr)}), correlation in points of 100; ${t.side === 'short' ? 'sign reversed for the correlation seller' : 'received by the correlation buyer when positive'}.`;
    case 'dispersion': return `Settlement = notional per point x ((weighted constituent volatility - index volatility) - ${f2(t.strikeVol)}), in volatility points; ${t.side === 'short' ? 'sign reversed for the dispersion seller' : 'received by the dispersion buyer when positive'}.`;
    case 'recovery': return `Settlement after a credit event = notional x (recovery rate - ${f2(t.recoveryStrikePct)}%) / 100; ${t.side === 'sell' ? 'sign reversed for the recovery seller' : 'received by the recovery buyer when positive'}. No credit event by maturity: nothing is paid.`;
    case 'weather': {
      const pay = t.optionType === 'put' ? `max(${f2(t.strike)} - ${t.index}, 0)` : t.optionType === 'swap' ? `(${t.index} - ${f2(t.strike)})` : `max(${t.index} - ${f2(t.strike)}, 0)`;
      return `Payment = ${t.optionType === 'swap' ? 'between -cap and cap: ' : 'the smaller of the cap and '}${fmt(t.tick, ccy)} x ${pay} over ${t.periodStart} to ${t.periodEnd}; cap ${fmt(t.cap, ccy)}; ${t.side === 'short' ? 'paid by us (writer)' : 'received by us (holder)'}.`;
    }
    default: return 'Valued and cash-flowed by hand.';
  }
}

// ---- what is recorded for each kind, and the web labels of each event --------------------------------------------
const EVENTS = {
  commitment: ['valuation', 'capital_call', 'distribution', 'expense', 'wind_up'],
  fund_interest: ['valuation', 'redemption_notice', 'redemption', 'expense'],
  direct_asset: ['valuation', 'capex', 'income', 'expense'],
  ils: ['valuation', 'income', 'loss_event', 'settle'],
  collateral_swap: ['valuation', 'fee_payment', 'settle'],
  recovery: ['valuation', 'credit_event', 'settle'],
  holding: ['valuation'],
};
export const eventsFor = (inst) => EVENTS[kindOf(inst)] || (OTC_KINDS.has(kindOf(inst)) ? ['valuation', 'settle'] : ['valuation']);
const SETTLE_LABEL = { ils: 'Redemption at maturity', collateral_swap: 'Termination', freight: 'Period settlement' };
export const eventLabel = (inst, action) => ({
  valuation: 'Valuation by hand', capital_call: 'Capital call', distribution: 'Distribution', expense: 'Fee or expense', wind_up: 'Final realisation (wind-up)',
  redemption_notice: 'Redemption notice', redemption: 'Redemption at NAV', capex: 'Capital expenditure', income: 'Income received', loss_event: 'Loss event',
  fee_payment: 'Fee payment', credit_event: 'Credit event', settle: SETTLE_LABEL[kindOf(inst)] || 'Final settlement',
}[action] || action);

// ---- labels -------------------------------------------------------------------------------------------------------
const QTY_LABEL = { commitment: 'Share of the interest (1 = the whole commitment)', fund_interest: 'Shares', direct_asset: 'Share of the asset (1 = 100%)', ils: 'Face amount' };
const PRICE_UNITS = { commitment: 'value of the whole interest', fund_interest: 'NAV per share', direct_asset: 'value of the whole asset', ils: '% of face' };
const ACTION_LABELS = {
  commitment: { buy: 'Commit or acquire', sell: 'Sell (secondary)' },
  fund_interest: { buy: 'Subscribe', sell: 'Redeem' },
  direct_asset: { buy: 'Acquire', sell: 'Sell' },
  ils: { buy: 'Buy', sell: 'Sell' },
};
const unitWord = (inst) => (kindOf(inst) === 'freight' ? (inst.terms.quantityUnit || 'units') : 'contract');

/** Direction words for a manual holding or contract. */
export function directionOf(inst, pos) {
  if (isZero(pos.qty)) return 'flat';
  const t = inst.terms || {};
  const k = kindOf(inst);
  if (k === 'commitment') return 'committed';
  if (k === 'direct_asset') return 'owned';
  if (k === 'collateral_swap') return t.feePayer === 'us' ? 'fee payer' : 'fee receiver';
  if (k === 'freight') return t.side === 'sell' ? 'seller' : 'buyer';
  if (k === 'spread_forward') return t.side === 'sell' ? 'spread seller' : 'spread buyer';
  if (k === 'spread_option' || k === 'weather') return t.side === 'short' ? 'writer' : 'holder';
  if (['variance', 'volatility', 'correlation', 'dispersion'].includes(k)) return `${k} ${t.side === 'short' ? 'seller' : 'buyer'}`;
  if (k === 'recovery') return t.side === 'sell' ? 'recovery seller' : 'recovery buyer';
  return pos.qty > 0 ? 'long' : 'short';
}

// ---- normalisation of a draft ------------------------------------------------------------------------------------
function normalizeTerms(kind, raw, errors) {
  const out = {};
  for (const f of termsOf(kind)) {
    const v = raw[f.key];
    const empty = v === undefined || v === null || v === '';
    if (empty) { if (f.required) errors.push(`${f.label} is required.`); continue; }
    if (f.type === 'number' || f.type === 'int') {
      const n = num(v);
      if (n === null) { errors.push(`${f.label} must be a number.`); continue; }
      if (f.type === 'int' && !Number.isInteger(n)) { errors.push(`${f.label} must be a whole number.`); continue; }
      if (f.positive && !(n > 0)) { errors.push(`${f.label} must be more than zero.`); continue; }
      if (f.min !== undefined && n < f.min) { errors.push(`${f.label} cannot be less than ${f.min}.`); continue; }
      if (f.max !== undefined && n > f.max) { errors.push(`${f.label} cannot be more than ${f.max}.`); continue; }
      out[f.key] = n;
    } else if (f.type === 'date') {
      if (!ISO_DATE_RE.test(String(v))) { errors.push(`${f.label} must be a date (YYYY-MM-DD).`); continue; }
      out[f.key] = String(v);
    } else if (f.type === 'enum') {
      if (!(String(v) in f.options)) { errors.push(`${f.label}: choose one of ${Object.values(f.options).join(', ')}.`); continue; }
      out[f.key] = String(v);
    } else out[f.key] = String(v).trim().slice(0, 300);
  }
  const pairs = [['periodStart', 'periodEnd'], ['startDate', 'endDate']];
  for (const [a, b] of pairs) if (out[a] && out[b] && out[a] >= out[b]) errors.push(`${termsOf(kind).find((f) => f.key === b).label} must be after ${termsOf(kind).find((f) => f.key === a).label.toLowerCase()}.`);
  return out;
}

// ---- payoffs ------------------------------------------------------------------------------------------------------
/**
 * The settlement of one whole contract (quantity 1) from the realised inputs entered by hand.
 * Returns { amount (signed, + received by us), text (the formula with the figures), inputs }.
 */
export function payoffOf(inst, body) {
  const t = inst.terms;
  const ccy = inst.trading_ccy;
  const s = sideSign(t);
  const req = (key, label) => { const v = num(body[key]); need(v !== null, `Enter ${label}.`); return v; };
  const signed = (x) => money(s * x, ccy);
  switch (kindOf(inst)) {
    case 'spread_forward': {
      const S = req('realised', 'the spread at expiry in basis points');
      const amt = signed(t.notional * t.riskyDuration * (S - t.forwardSpreadBp) / 10000);
      return { amount: amt, inputs: { spreadBp: S }, text: `spread at expiry ${f2(S)} bp against ${f2(t.forwardSpreadBp)} bp: ${fmt(t.notional, ccy)} x ${f2(t.riskyDuration)} x (${f2(S)} - ${f2(t.forwardSpreadBp)}) / 10,000${s < 0 ? ', sign reversed (spread seller)' : ''}` };
    }
    case 'spread_option': {
      const S = req('realised', 'the spread at expiry in basis points');
      const intrinsic = t.optionType === 'receiver' ? Math.max(t.strikeSpreadBp - S, 0) : Math.max(S - t.strikeSpreadBp, 0);
      const amt = signed(t.notional * t.riskyDuration * intrinsic / 10000);
      return { amount: amt, inputs: { spreadBp: S }, text: `spread at expiry ${f2(S)} bp, strike ${f2(t.strikeSpreadBp)} bp (${t.optionType}): ${fmt(t.notional, ccy)} x ${f2(t.riskyDuration)} x ${f2(intrinsic)} / 10,000${s < 0 ? ', paid by us (writer)' : ''}` };
    }
    case 'variance': {
      const vol = req('realised', 'the realised volatility in volatility points');
      const K = t.strikeVol;
      const used = t.capMultiple ? Math.min(vol, t.capMultiple * K) : vol;
      const varN = t.vegaNotional / (2 * K);
      const amt = signed(varN * (used * used - K * K));
      return { amount: amt, inputs: { realisedVol: vol, usedVol: used, varianceNotional: round(varN, 6) }, text: `realised volatility ${f2(vol)}${used !== vol ? `, capped at ${f2(used)}` : ''}, strike ${f2(K)}: variance notional ${f2(round(varN, 6))} (${fmt(t.vegaNotional, ccy)} / (2 x ${f2(K)})) x (${f2(used)}² - ${f2(K)}²)${s < 0 ? ', sign reversed (variance seller)' : ''}` };
    }
    case 'volatility': {
      const vol = req('realised', 'the realised volatility in volatility points');
      const amt = signed(t.vegaNotional * (vol - t.strikeVol));
      return { amount: amt, inputs: { realisedVol: vol }, text: `realised volatility ${f2(vol)}, strike ${f2(t.strikeVol)}: ${fmt(t.vegaNotional, ccy)} x (${f2(vol)} - ${f2(t.strikeVol)})${s < 0 ? ', sign reversed (volatility seller)' : ''}` };
    }
    case 'correlation': {
      const rho = req('realised', 'the realised correlation in points of 100');
      need(rho >= -100 && rho <= 100, 'Realised correlation is between -100 and 100 points.');
      const amt = signed(t.notionalPerPoint * (rho - t.strikeCorr));
      return { amount: amt, inputs: { realisedCorr: rho }, text: `realised correlation ${f2(rho)}, strike ${f2(t.strikeCorr)}: ${fmt(t.notionalPerPoint, ccy)} x (${f2(rho)} - ${f2(t.strikeCorr)})${s < 0 ? ', sign reversed (correlation seller)' : ''}` };
    }
    case 'dispersion': {
      const cv = req('constituentVol', 'the weighted average realised volatility of the constituents');
      const iv = req('indexVol', 'the realised volatility of the index');
      const D = round(cv - iv, 8);
      const amt = signed(t.notionalPerPoint * (D - t.strikeVol));
      return { amount: amt, inputs: { constituentVol: cv, indexVol: iv, dispersion: D }, text: `constituents ${f2(cv)} less index ${f2(iv)} = dispersion ${f2(D)}, strike ${f2(t.strikeVol)}: ${fmt(t.notionalPerPoint, ccy)} x (${f2(D)} - ${f2(t.strikeVol)})${s < 0 ? ', sign reversed (dispersion seller)' : ''}` };
    }
    case 'recovery': {
      if (body.noCreditEvent) return { amount: 0, inputs: { noCreditEvent: true }, text: 'no credit event before maturity: nothing is paid' };
      const R = req('realised', 'the recovery rate in % (the auction final price)');
      need(R >= 0 && R <= 100, 'The recovery rate is between 0 and 100%.');
      const amt = signed(t.notional * (R - t.recoveryStrikePct) / 100);
      return { amount: amt, inputs: { recoveryPct: R }, text: `recovery ${f2(R)}% against the fixed ${f2(t.recoveryStrikePct)}%: ${fmt(t.notional, ccy)} x (${f2(R)} - ${f2(t.recoveryStrikePct)}) / 100${s < 0 ? ', sign reversed (recovery seller)' : ''}` };
    }
    case 'weather': {
      const I = req('realised', `the ${t.index} index for the period`);
      need(I >= 0, `The ${t.index} index cannot be negative.`);
      const raw = t.optionType === 'put' ? Math.max(t.strike - I, 0) : t.optionType === 'swap' ? I - t.strike : Math.max(I - t.strike, 0);
      const unc = t.tick * raw;
      const capped = Math.max(-t.cap, Math.min(t.cap, unc));
      const amt = signed(capped);
      return { amount: amt, inputs: { index: I }, text: `${t.index} ${f2(I)} against the strike ${f2(t.strike)} (${t.optionType}): ${fmt(t.tick, ccy)} x ${f2(raw)} = ${fmt(unc, ccy)}${capped !== unc ? `, capped at ${fmt(capped, ccy)}` : ''}${s < 0 ? ', paid by us (writer)' : ''}` };
    }
    default: throw new AppError('A final settlement from a realised value does not apply to this product.');
  }
}

/** Fee of a collateral swap for [from, to). + received by us. */
export function collateralSwapFee(inst, from, to) {
  const t = inst.terms;
  const days = diffDays(from, to);
  const fee = money(t.feeNotional * t.feeBp / 10000 * days / (t.dayCount === 'ACT/365' ? 365 : 360), inst.trading_ccy);
  return { days, amount: t.feePayer === 'us' ? -fee : fee, gross: fee };
}

// ---- hedge fund dealing dates ------------------------------------------------------------------------------------
const periodEndOf = (date, freq) => { const { y, m } = ymd(date); const qm = freq === 'quarterly' ? Math.ceil(m / 3) * 3 : m; return makeDate(y, qm, daysInMonth(y, qm)); };
/** The first dealing date (last business day of a dealing period) at least `noticeDays` after the notice. */
export function dealingDateAfter(date, terms, cal) {
  const earliest = addDays(date, terms.noticeDays || 0);
  let d = onOrBefore(periodEndOf(earliest, terms.dealingFrequency), cal);
  if (d < earliest) d = onOrBefore(periodEndOf(addDays(periodEndOf(earliest, terms.dealingFrequency), 1), terms.dealingFrequency), cal);
  return d;
}
const nextDealingDate = (date, terms, cal) => onOrBefore(periodEndOf(addDays(periodEndOf(date, terms.dealingFrequency), 1), terms.dealingFrequency), cal);

// ---- the plugin ---------------------------------------------------------------------------------------------------
export function manualPlugin(base, { standardSettleDate, paymentCalendarFor }) {
  const label = (inst) => inst.symbol || inst.name;
  const priceUnitsOf = (inst) => inst.terms?.priceUnits || PRICE_UNITS[kindOf(inst)] || (OTC_KINDS.has(kindOf(inst)) ? `mark per ${unitWord(inst)}, signed` : 'per unit');
  const collateralNotional = (app, inst, { qtyAfter }) => {
    const t = inst.terms || {};
    const per = { collateral_swap: t.feeNotional, freight: t.contractRate, spread_forward: t.notional, spread_option: t.notional, variance: t.vegaNotional, volatility: t.vegaNotional,
      correlation: (t.notionalPerPoint || 0) * 100, dispersion: (t.notionalPerPoint || 0) * 100, recovery: t.notional, weather: t.cap }[kindOf(inst)];
    return per ? money(Math.abs(qtyAfter) * per, inst.trading_ccy) : null;
  };

  function manualOf(pos) { return { ...(pos.data.manual || {}) }; }
  const setManual = (app, pos, patch) => app.positions.setData(app.positions.get(pos.id), { manual: { ...manualOf(app.positions.get(pos.id)), ...patch } });

  /** What the screens show about the manual workflow of a position. */
  function summary(inst, pos, obs) {
    const t = inst.terms || {};
    const m = manualOf(pos);
    const ccy = inst.trading_ccy;
    const k = kindOf(inst);
    const out = { kind: k };
    if (k === 'commitment') {
      const committed = money((t.commitment || 0) * pos.qty, ccy);
      const called = money(m.called || 0, ccy);
      Object.assign(out, { committed, called, uncalled: money(committed - called, ccy), feesCalled: money(m.feesCalled || 0, ccy), returnOfCapital: money(m.returnOfCapital || 0, ccy),
        realizedGain: money(m.realizedGain || 0, ccy), income: money(m.income || 0, ccy), carry: money(m.carry || 0, ccy), expenses: money(m.expenses || 0, ccy) });
    } else if (k === 'fund_interest') {
      Object.assign(out, { redemptions: (m.redemptions || []).map((r) => ({ noticeDate: r.noticeDate, dealingDate: r.dealingDate, shares: r.shares })), noticed: round((m.redemptions || []).reduce((a, r) => a + r.shares, 0), 8), expenses: money(m.expenses || 0, ccy) });
    } else if (k === 'direct_asset') {
      Object.assign(out, { capex: money(m.capex || 0, ccy), income: money(m.income || 0, ccy), expenses: money(m.expenses || 0, ccy) });
    } else if (k === 'ils') {
      Object.assign(out, { faceLost: money(m.faceLost || 0, ccy), coupons: money(m.income || 0, ccy) });
    } else if (k === 'collateral_swap') {
      Object.assign(out, { feePaidThrough: m.feePaidThrough || t.startDate || null, fees: money(m.fees || 0, ccy) });
    } else if (k === 'recovery') {
      Object.assign(out, { creditEvent: m.creditEvent || null });
    }
    if (k === 'freight') Object.assign(out, { settled: money(m.settled || 0, ccy), settledQty: round(m.settledQty || 0, 8) });
    if (OTC_KINDS.has(k)) out.endDate = endDateOf(inst);
    if (obs) out.valuation = { date: obs.forDate || String(obs.asOf || '').slice(0, 10), source: obs.extra?.valuationSource || obs.extra?.note || obs.source, stale: obs.freshness === 'stale' };
    else out.valuation = null;
    return out;
  }

  function requireOpen(pos) { need(!isZero(pos.qty), 'This position is closed.'); }
  const amountOf = (v, label2, { allowZero = false } = {}) => {
    const n = num(v);
    if (allowZero && (v === undefined || v === null || v === '')) return 0;
    need(n !== null && Number.isFinite(n), `Enter ${label2} as a number.`);
    need(allowZero ? n >= 0 : n > 0, `${label2[0].toUpperCase()}${label2.slice(1)} must be ${allowZero ? 'zero or more' : 'more than zero'}.`);
    return n;
  };
  const dateOf = (app, v, label2, { notAfterToday = true } = {}) => {
    const d = v ? String(v) : app.clock.today();
    need(ISO_DATE_RE.test(d), `${label2} must be a date (YYYY-MM-DD).`);
    if (notAfterToday) need(d <= app.clock.today(), `${label2} cannot be after today (${app.clock.today()}).`);
    return d;
  };
  function pay(app, unit, ccy, amount) {
    if (amount >= 0) return;
    const have = app.ledger.cash(unit.id, ccy).availableToWithdraw;
    need(have >= -amount - 0.004, `${unit.kind === 'treasury' ? 'Treasury' : unit.name} has ${fmt(have, ccy)} available; ${fmt(-amount, ccy)} is needed.`, { code: 'insufficient_cash' });
  }
  /** One balanced event: cash against the named accounts. lines: [{ account, amount }] where amount is the ledger amount. */
  function post(app, { book, unit, inst, pos, type, summary: text, data, cash, lines }) {
    const ccy = inst.trading_ccy;
    const entries = [];
    if (cash) entries.push({ account: 'cash', ccy, amount: money(cash, ccy), positionId: pos.id });
    for (const l of lines || []) if (money(l.amount, ccy) !== 0) entries.push({ account: l.account, ccy, amount: money(l.amount, ccy), positionId: pos.id });
    return app.ledger.post({ bookId: book.id, unitId: unit.id, type, instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'user', summary: text, data: { ...data, enteredByHand: true }, entries });
  }
  const noteText = (b) => (b.note ? `. ${String(b.note).trim()}` : '');

  /** Store a valuation as a manual price observation of the instrument, as of its valuation date. */
  function storeValuation(app, inst, { perUnit, date, source, kind = 'valuation' }) {
    return app.data.enterManual({
      kind: 'price', subject: inst.id, value: perUnit, currency: inst.trading_ccy, units: priceUnitsOf(inst), asOf: `${date}T12:00:00.000Z`, forDate: date,
      note: source, extra: { valuationSource: source, valuationDate: date, enteredAs: kind }, assumptions: [`Valuation date ${date}; source: ${source}.`],
    });
  }

  /** A closing fill of `qty` at `price` per unit (or `unitCost` per unit of quantity), booked as a manual event. */
  function closeBy(app, ctx, { qty, price, unitCost, settleDate, type, text, data }) {
    const { book, unit, inst, pos } = ctx;
    return bookSecurityFill(app, { book, unit, inst, action: 'sell', qty, price, fees: [], strategyId: pos.strategy_id, tradeDate: app.clock.today(), settleDate, eventType: type, summary: text, data: { ...data, enteredByHand: true }, actor: 'user' },
      { unitCost: unitCost ?? price * inst.multiplier });
  }
  const payDateFor = (app, ctx, stated) => {
    const today = app.clock.today();
    if (stated) {
      need(ISO_DATE_RE.test(String(stated)), 'The payment date must be a date (YYYY-MM-DD).');
      need(stated >= today, `The payment date cannot be before today (${today}).`);
      need(isBusinessDay(stated, paymentCalendarFor(ctx.inst)), `${stated} is not a business day on the payment calendar of ${label(ctx.inst)} (${paymentCalendarFor(ctx.inst)}).`);
      return String(stated);
    }
    return standardSettleDate(ctx.inst, today, ctx.book);
  };
  const openTasks = (app, pos, type) => app.tasks.open([pos.unit_id]).filter((x) => x.position_id === pos.id && (!type || x.type === type));

  // ---- the events ----------------------------------------------------------------------------------------------
  const handlers = {
    valuation(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const k = kindOf(inst);
      const date = dateOf(app, b.asOf, 'The valuation date');
      const source = String(b.source || '').trim();
      need(source, 'Name the source of the valuation (for example, the manager\'s quarterly statement or an appraisal).');
      const v = num(b.value);
      need(v !== null && Number.isFinite(v), 'Enter the valuation as a number.');
      const perUnitKind = k === 'fund_interest' || k === 'ils' || k === 'holding';
      need(OTC_KINDS.has(k) || v >= 0, 'A valuation of this holding cannot be negative.');
      const perUnit = perUnitKind ? v : v / (pos.qty * inst.multiplier);
      const obs = storeValuation(app, inst, { perUnit, date, source });
      const ccy = inst.trading_ccy;
      const what = perUnitKind ? `${fmtPx(v)} ${priceUnitsOf(inst)}` : `${fmt(v, ccy)} for the ${fmtQty(pos.qty)} held${!isZero(pos.qty - 1) ? ` (${fmtPx(round(perUnit, 6))} ${priceUnitsOf(inst)})` : ''}`;
      const eventId = post(app, { book, unit, inst, pos, type: 'manual.valuation', summary: `Valuation of ${label(inst)} entered by hand: ${what}, as of ${date}, source: ${source}. A manual input, not a market quote`, data: { value: v, perUnit, valuationDate: date, source, observationId: obs.id } });
      return { eventId, observationId: obs.id };
    },

    capital_call(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const ccy = inst.trading_ccy;
      const amount = money(amountOf(b.amount, 'the amount called'), ccy);
      const fee = money(amountOf(b.feePortion, 'the management-fee part', { allowZero: true }), ccy);
      need(fee <= amount, 'The management-fee part cannot be more than the amount called.');
      const s = summary(inst, pos);
      need(amount <= s.uncalled + 0.004, `Only ${fmt(s.uncalled, ccy)} of the commitment is uncalled; a call of ${fmt(amount, ccy)} cannot be recorded.`);
      pay(app, unit, ccy, -amount);
      const invested = money(amount - fee, ccy);
      const m = manualOf(pos);
      const called = money((m.called || 0) + amount, ccy);
      const eventId = post(app, { book, unit, inst, pos, type: 'manual.capital_call', cash: -amount, lines: [{ account: 'pos', amount: invested }, { account: 'pnl.fee', amount: fee }],
        summary: `Capital call on ${label(inst)} entered by hand: paid ${fmt(amount, ccy)}${fee ? ` (${fmt(invested, ccy)} invested, ${fmt(fee, ccy)} management fee)` : ''}; called ${fmt(called, ccy)} of ${fmt(s.committed, ccy)}, uncalled ${fmt(money(s.committed - called, ccy), ccy)}${noteText(b)}`,
        data: { amount, invested, fee } });
      app.positions.change(app.positions.get(pos.id), { dCost: invested });
      setManual(app, pos, { called, feesCalled: money((m.feesCalled || 0) + fee, ccy) });
      return { eventId };
    },

    distribution(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const ccy = inst.trading_ccy;
      const roc = money(amountOf(b.returnOfCapital, 'the return of capital', { allowZero: true }), ccy);
      const gain = money(amountOf(b.realizedGain, 'the realized gain', { allowZero: true }), ccy);
      const income = money(amountOf(b.income, 'the income', { allowZero: true }), ccy);
      const carry = money(amountOf(b.carry, 'the carried interest withheld', { allowZero: true }), ccy);
      const gross = money(roc + gain + income, ccy);
      need(gross > 0, 'Enter at least one part of the distribution: return of capital, realized gain or income.');
      need(carry <= gross, 'The carried interest withheld cannot be more than the distribution.');
      const fresh = app.positions.get(pos.id);
      need(roc <= fresh.cost + 0.004, `Only ${fmt(Math.max(fresh.cost, 0), ccy)} of cost is left to return; enter the rest of the distribution as a realized gain.`);
      const cash = money(gross - carry, ccy);
      const m = manualOf(fresh);
      const parts = [roc && `${fmt(roc, ccy)} return of capital`, gain && `${fmt(gain, ccy)} realized gain`, income && `${fmt(income, ccy)} income`].filter(Boolean).join(', ');
      const eventId = post(app, { book, unit, inst, pos, type: 'manual.distribution', cash, lines: [{ account: 'pos', amount: -roc }, { account: 'pnl.realized', amount: -gain }, { account: 'pnl.dividend', amount: -income }, { account: 'pnl.fee', amount: carry }],
        summary: `Distribution from ${label(inst)} entered by hand: ${parts}${carry ? `, less ${fmt(carry, ccy)} carried interest withheld` : ''}; received ${fmt(cash, ccy)}${noteText(b)}`,
        data: { returnOfCapital: roc, realizedGain: gain, income, carry, cash } });
      if (roc) app.positions.change(app.positions.get(pos.id), { dCost: -roc });
      setManual(app, pos, { returnOfCapital: money((m.returnOfCapital || 0) + roc, ccy), realizedGain: money((m.realizedGain || 0) + gain, ccy), income: money((m.income || 0) + income, ccy), carry: money((m.carry || 0) + carry, ccy) });
      return { eventId };
    },

    expense(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const ccy = inst.trading_ccy;
      const amount = money(amountOf(b.amount, 'the amount'), ccy);
      const KINDS = { management_fee: 'management fee', performance_fee: 'performance fee', carried_interest: 'carried interest', operating: 'operating expense', other: 'expense' };
      const what = KINDS[b.kind] || null;
      need(what, `Choose the kind of fee or expense: ${Object.values(KINDS).join(', ')}.`);
      pay(app, unit, ccy, -amount);
      const m = manualOf(pos);
      const eventId = post(app, { book, unit, inst, pos, type: 'manual.expense', cash: -amount, lines: [{ account: 'pnl.fee', amount }], summary: `${what[0].toUpperCase()}${what.slice(1)} on ${label(inst)} entered by hand: paid ${fmt(amount, ccy)}${noteText(b)}`, data: { amount, kind: b.kind } });
      setManual(app, pos, { expenses: money((m.expenses || 0) + amount, ccy) });
      return { eventId };
    },

    income(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const ccy = inst.trading_ccy;
      const amount = money(amountOf(b.amount, 'the amount received'), ccy);
      const KINDS = { rent: ['rent', 'pnl.dividend'], dividend: ['dividend', 'pnl.dividend'], distribution: ['income distribution', 'pnl.dividend'], coupon: ['coupon', 'pnl.coupon'], interest: ['interest', 'pnl.coupon'] };
      const k = KINDS[b.kind];
      need(k, 'Choose the kind of income: rent, dividend, income distribution, coupon or interest.');
      const m = manualOf(pos);
      const eventId = post(app, { book, unit, inst, pos, type: 'manual.income', cash: amount, lines: [{ account: k[1], amount: -amount }], summary: `${k[0][0].toUpperCase()}${k[0].slice(1)} from ${label(inst)} entered by hand: received ${fmt(amount, ccy)}${noteText(b)}`, data: { amount, kind: b.kind } });
      setManual(app, pos, { income: money((m.income || 0) + amount, ccy) });
      return { eventId };
    },

    capex(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const ccy = inst.trading_ccy;
      const amount = money(amountOf(b.amount, 'the capital expenditure'), ccy);
      pay(app, unit, ccy, -amount);
      const m = manualOf(pos);
      const eventId = post(app, { book, unit, inst, pos, type: 'manual.capex', cash: -amount, lines: [{ account: 'pos', amount }], summary: `Capital expenditure on ${label(inst)} entered by hand: paid ${fmt(amount, ccy)}, added to cost${noteText(b)}`, data: { amount } });
      app.positions.change(app.positions.get(pos.id), { dCost: amount });
      setManual(app, pos, { capex: money((m.capex || 0) + amount, ccy) });
      return { eventId };
    },

    wind_up(app, ctx, b) {
      const { inst, pos } = ctx;
      requireOpen(pos);
      const ccy = inst.trading_ccy;
      const s = summary(inst, pos);
      const fresh = app.positions.get(pos.id);
      const r = closeBy(app, ctx, { qty: fresh.qty, price: 0, unitCost: 0, settleDate: app.clock.today(), type: 'manual.wind_up',
        text: `Final realisation of ${label(inst)} entered by hand: the fund is wound up; remaining cost ${fmt(fresh.cost, ccy)} realized${s.uncalled ? `, uncalled commitment of ${fmt(s.uncalled, ccy)} released` : ''}${noteText(b)}`, data: { uncalledReleased: s.uncalled } });
      setManual(app, pos, { released: s.uncalled, called: 0 });
      return { eventId: r.eventId };
    },

    redemption_notice(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const t = inst.terms;
      const shares = amountOf(b.shares, 'the number of shares to redeem');
      const m = manualOf(pos);
      const noticed = (m.redemptions || []).reduce((a, r) => a + r.shares, 0);
      need(shares <= pos.qty - noticed + 1e-9, `${fmtQty(pos.qty)} shares are held and ${fmtQty(noticed)} are already under notice; ${fmtQty(shares)} more cannot be noticed.`);
      const date = app.clock.today();
      if (t.lockupUntil) need(date >= t.lockupUntil || false, `The interest is locked up until ${t.lockupUntil}; no redemption notice can be given before then.`);
      const dealing = dealingDateAfter(date, t, paymentCalendarFor(inst));
      const id = `R${(m.seq || 0) + 1}`;
      const redemptions = [...(m.redemptions || []), { id, noticeDate: date, dealingDate: dealing, shares }];
      const eventId = post(app, { book, unit, inst, pos, type: 'manual.redemption_notice', summary: `Redemption notice for ${fmtQty(shares)} shares of ${label(inst)} entered by hand on ${date}: ${t.noticeDays} days' notice, ${t.dealingFrequency} dealing, so it is dealt on ${dealing}${t.gatePct ? ` (gate ${round(t.gatePct * 100, 4)}% of the holding per dealing date)` : ''}${noteText(b)}`, data: { shares, dealingDate: dealing, requestId: id } });
      setManual(app, pos, { redemptions, seq: (m.seq || 0) + 1 });
      app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'manual.redemption', dueDate: dealing, data: { key: id } });
      return { eventId, dealingDate: dealing };
    },

    redemption(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const t = inst.terms;
      const ccy = inst.trading_ccy;
      const today = app.clock.today();
      const m = manualOf(pos);
      const due = (m.redemptions || []).filter((r) => r.dealingDate <= today).sort((a, z) => (a.dealingDate < z.dealingDate ? -1 : 1));
      need(due.length, (m.redemptions || []).length ? `No redemption is due yet: the next dealing date is ${(m.redemptions || []).map((r) => r.dealingDate).sort()[0]}.` : 'No redemption notice is outstanding. Give a redemption notice first.');
      const req = due[0];
      const nav = num(b.nav);
      need(nav !== null && nav > 0, `Enter the NAV per share struck for the dealing date ${req.dealingDate}.`);
      const held = app.positions.get(pos.id).qty;
      const cap = t.gatePct ? round(held * t.gatePct, 8) : held;
      const shares = round(Math.min(req.shares, cap, held), 8);
      const left = round(req.shares - shares, 8);
      const cal = paymentCalendarFor(inst);
      const payDate = addBusinessDays(req.dealingDate, t.paymentDays || 0, cal);
      const next = left > 0 ? nextDealingDate(req.dealingDate, t, cal) : null;
      storeValuation(app, inst, { perUnit: nav, date: req.dealingDate, source: `NAV per share struck for the dealing date ${req.dealingDate} (redemption)`, kind: 'redemption-nav' });
      const proceeds = money(shares * nav * inst.multiplier, ccy);
      const r = closeBy(app, ctx, { qty: shares, price: nav, settleDate: payDate < today ? today : payDate, type: 'manual.redemption',
        text: `Redemption of ${fmtQty(shares)} shares of ${label(inst)} at the NAV of ${req.dealingDate}, ${fmtPx(nav)} per share (entered by hand): ${fmt(proceeds, ccy)} paid ${payDate}${t.gatePct ? `; gate ${round(t.gatePct * 100, 4)}% of ${fmtQty(held)} held = ${fmtQty(cap)}` : ''}${left > 0 ? `; ${fmtQty(left)} carried to the dealing date ${next}` : ''}`,
        data: { requestId: req.id, dealingDate: req.dealingDate, nav, gateCap: cap, carried: left, payDate } });
      const redemptions = (m.redemptions || []).map((x) => (x.id === req.id ? (left > 0 ? { ...x, shares: left, dealingDate: next } : null) : x)).filter(Boolean);
      setManual(app, pos, { redemptions });
      for (const task of openTasks(app, pos, 'manual.redemption').filter((x) => x.data?.key === req.id && x.due_date === req.dealingDate)) app.tasks.done(task.id, r.eventId);
      if (left > 0) app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'manual.redemption', dueDate: next, data: { key: req.id } });
      return { eventId: r.eventId, shares, carried: left, payDate };
    },

    loss_event(app, ctx, b) {
      const { inst, pos } = ctx;
      requireOpen(pos);
      const ccy = inst.trading_ccy;
      const face = amountOf(b.face, 'the face amount written down');
      const fresh = app.positions.get(pos.id);
      need(face <= fresh.qty + 1e-9, `${fmtQty(fresh.qty)} of face is held; ${fmtQty(face)} cannot be written down.`);
      const cost = money(fresh.cost * face / fresh.qty, ccy);
      const m = manualOf(fresh);
      const r = closeBy(app, ctx, { qty: face, price: 0, unitCost: 0, settleDate: app.clock.today(), type: 'manual.loss_event',
        text: `Loss event on ${label(inst)} entered by hand: ${fmt(face, ccy)} of face written down (principal lost), cost ${fmt(cost, ccy)} realized${noteText(b)}`, data: { face } });
      setManual(app, pos, { faceLost: money((m.faceLost || 0) + face, ccy) });
      return { eventId: r.eventId };
    },

    credit_event(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const m = manualOf(pos);
      need(!m.creditEvent, `A credit event is already recorded on ${m.creditEvent?.date}.`);
      const date = dateOf(app, b.eventDate, 'The credit event date');
      need(date <= inst.terms.maturity, `The contract matured on ${inst.terms.maturity}; a later credit event does not trigger it.`);
      const eventId = post(app, { book, unit, inst, pos, type: 'manual.credit_event', summary: `Credit event of ${inst.terms.referenceEntity} on ${date} recorded by hand for ${label(inst)}; settled when the recovery rate is known${noteText(b)}`, data: { date } });
      setManual(app, pos, { creditEvent: { date, note: b.note || null } });
      return { eventId };
    },

    fee_payment(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const t = inst.terms;
      const ccy = inst.trading_ccy;
      const m = manualOf(pos);
      const from = m.feePaidThrough || t.startDate;
      const to = dateOf(app, b.periodEnd, 'The end of the fee period');
      need(to > from, `Fees are paid through ${from}; the period must end after that.`);
      need(to <= t.endDate, `The swap ends on ${t.endDate}.`);
      const fee = collateralSwapFee(inst, from, to);
      pay(app, unit, ccy, fee.amount);
      const account = fee.amount < 0 ? 'pnl.borrow' : 'pnl.lending';
      const eventId = post(app, { book, unit, inst, pos, type: 'manual.fee', cash: fee.amount, lines: [{ account, amount: -fee.amount }],
        summary: `Collateral swap fee on ${label(inst)}, ${from} to ${to} (${fee.days} days), entered by hand: ${fmt(t.feeNotional, ccy)} x ${t.feeBp} bp x ${fee.days} / ${t.dayCount === 'ACT/365' ? 365 : 360} = ${fmt(fee.gross, ccy)} ${fee.amount < 0 ? 'paid' : 'received'}${noteText(b)}`, data: { from, to, days: fee.days, amount: fee.amount } });
      setManual(app, pos, { feePaidThrough: to, fees: money((m.fees || 0) + fee.amount, ccy) });
      return { eventId };
    },

    settle(app, ctx, b) {
      const { inst, pos, book, unit } = ctx;
      requireOpen(pos);
      const k = kindOf(inst);
      const t = inst.terms;
      const ccy = inst.trading_ccy;
      const today = app.clock.today();
      const fresh = app.positions.get(pos.id);
      const m = manualOf(fresh);
      const finish = (eventId) => { for (const task of openTasks(app, pos)) if (task.type === 'manual.settlement' || task.type === 'manual.maturity') app.tasks.done(task.id, eventId); };
      if (k === 'ils') {
        need(today >= t.maturity, `${label(inst)} matures on ${t.maturity}.`);
        const price = b.redemptionPrice === undefined || b.redemptionPrice === null || b.redemptionPrice === '' ? 100 : num(b.redemptionPrice);
        need(price !== null && price >= 0, 'Enter the redemption price in % of face.');
        const payDate = payDateFor(app, ctx, b.payDate);
        const proceeds = money(fresh.qty * price * inst.multiplier, ccy);
        const r = closeBy(app, ctx, { qty: fresh.qty, price, settleDate: payDate, type: 'manual.settlement', text: `Redemption at maturity of ${label(inst)} entered by hand: ${fmt(fresh.qty, ccy)} of face at ${fmtPx(price)}% = ${fmt(proceeds, ccy)}, paid ${payDate}`, data: { price, payDate } });
        finish(r.eventId);
        return { eventId: r.eventId, payDate };
      }
      if (k === 'collateral_swap') {
        const from = m.feePaidThrough || t.startDate;
        const fee = today > from ? collateralSwapFee(inst, from, today) : { days: 0, amount: 0, gross: 0 };
        pay(app, unit, ccy, fee.amount);
        let feeEvent = null;
        if (fee.amount) {
          feeEvent = post(app, { book, unit, inst, pos, type: 'manual.fee', cash: fee.amount, lines: [{ account: fee.amount < 0 ? 'pnl.borrow' : 'pnl.lending', amount: -fee.amount }],
            summary: `Collateral swap fee on ${label(inst)}, ${from} to ${today} (${fee.days} days), at termination: ${fmt(t.feeNotional, ccy)} x ${t.feeBp} bp x ${fee.days} / ${t.dayCount === 'ACT/365' ? 365 : 360} = ${fmt(fee.gross, ccy)} ${fee.amount < 0 ? 'paid' : 'received'}`, data: { from, to: today, days: fee.days, amount: fee.amount } });
        }
        const r = closeBy(app, ctx, { qty: fresh.qty, price: 0, unitCost: 0, settleDate: today, type: 'manual.settlement',
          text: `Termination of ${label(inst)} entered by hand: ${t.receivedBasket} returned to the counterparty and ${t.givenBasket} returned to us (recorded only: the Terminal moves no securities)${fresh.cost ? `; cost ${fmt(fresh.cost, ccy)} realized` : ''}${noteText(b)}`, data: { feeEventId: feeEvent } });
        setManual(app, pos, { feePaidThrough: today, fees: money((m.fees || 0) + fee.amount, ccy) });
        finish(r.eventId);
        return { eventId: r.eventId };
      }
      if (k === 'freight') {
        const avg = num(b.average);
        need(avg !== null && avg >= 0, `Enter the average of ${t.settlementIndex} for the period settled.`);
        const qty = b.qty === undefined || b.qty === null || b.qty === '' ? fresh.qty : num(b.qty);
        need(qty !== null && qty > 0 && qty <= fresh.qty + 1e-9, `Enter the quantity settled for this period, up to the ${fmtQty(fresh.qty)} ${t.quantityUnit} open.`);
        const period = String(b.period || '').trim();
        need(period, 'Name the period settled (for example, March 2026).');
        need(today >= t.periodStart, `The settlement period starts on ${t.periodStart}.`);
        const perUnit = round(sideSign(t) * (avg - t.contractRate), 8);
        const amount = money(perUnit * qty, ccy);
        const payDate = payDateFor(app, ctx, b.payDate);
        const r = closeBy(app, ctx, { qty, price: perUnit / inst.multiplier, unitCost: perUnit, settleDate: payDate, type: 'manual.settlement',
          text: `Settlement of ${label(inst)} for ${period} entered by hand: average ${fmtPx(avg)} against the contract rate ${fmtPx(t.contractRate)}, ${fmtQty(qty)} ${t.quantityUnit} x ${fmtPx(avg)} - ${fmtPx(t.contractRate)}${sideSign(t) < 0 ? ', sign reversed (seller)' : ''} = ${fmt(amount, ccy)} ${amount >= 0 ? 'received' : 'paid'} ${payDate}`,
          data: { period, average: avg, qty, amount, payDate } });
        setManual(app, pos, { settled: money((m.settled || 0) + amount, ccy), settledQty: round((m.settledQty || 0) + qty, 8) });
        if (isZero(app.positions.get(pos.id).qty)) finish(r.eventId);
        return { eventId: r.eventId, amount, payDate };
      }
      // Contracts settled from a realised value entered by hand.
      if (k === 'recovery') {
        if (!b.noCreditEvent) need(m.creditEvent, 'Record the credit event first (Lifecycle, Credit event); without one the contract ends at maturity with nothing paid.');
        else need(!m.creditEvent && today >= t.maturity, m.creditEvent ? 'A credit event is recorded: enter the recovery rate.' : `${label(inst)} matures on ${t.maturity}; before then it can only settle after a credit event.`);
      } else {
        need(today >= endDateOf(inst), `${label(inst)} settles from ${endDateOf(inst)}; enter the realised value then.`);
      }
      const p = payoffOf(inst, b);
      const amount = money(p.amount * fresh.qty, ccy);
      const payDate = payDateFor(app, ctx, b.payDate);
      const r = closeBy(app, ctx, { qty: fresh.qty, price: p.amount / inst.multiplier, unitCost: p.amount, settleDate: payDate, type: 'manual.settlement',
        text: `Final settlement of ${label(inst)} entered by hand: ${p.text}${isZero(fresh.qty - 1) ? '' : `, x ${fmtQty(fresh.qty)} held`} = ${fmt(amount, ccy)} ${amount >= 0 ? 'received' : 'paid'}${amount ? ` ${payDate}` : ''}`,
        data: { inputs: p.inputs, perContract: p.amount, amount, payDate } });
      finish(r.eventId);
      return { eventId: r.eventId, amount, payDate };
    },
  };

  function manualEvent(app, ctx, body) {
    const action = body.action;
    need(eventsFor(ctx.inst).includes(action), `${eventLabel(ctx.inst, action)} does not apply to ${label(ctx.inst)}. It records: ${eventsFor(ctx.inst).map((a) => eventLabel(ctx.inst, a)).join(', ')}.`);
    return handlers[action](app, ctx, body);
  }

  return {
    ...base,
    label: 'Manually valued holding',
    manualEvents: (inst) => eventsFor(inst),
    manualEvent,
    normalize(app, draft) {
      const out = base.normalize(app, draft);
      const kind = MANUAL_KIND[draft.product_id] || 'holding';
      const errors = [...out.errors];
      const raw = draft.terms || {};
      const terms = { ...normalizeTerms(kind, raw, errors) };
      for (const k of ['lotSize', 'tickSize', 'settleDays']) if (out.terms[k] !== undefined) terms[k] = out.terms[k];
      if (raw.settleDays !== undefined && raw.settleDays !== null && raw.settleDays !== '') terms.settleDays = num(raw.settleDays);
      if (OTC_KINDS.has(kind)) {
        const basis = normalizeBasis(raw.collateralBasis, errors);
        if (basis) terms.collateralBasis = basis;
        if (raw.collateral) terms.collateral = String(raw.collateral).slice(0, 300);
      }
      // An insurance-linked security is priced in % of face: the multiplier is 0.01 whatever is entered.
      const multiplier = kind === 'ils' ? 0.01 : out.multiplier;
      return { terms, multiplier, errors };
    },
    describe(inst, app) {
      const rows = [];
      const k = kindOf(inst);
      const t = inst.terms || {};
      const ccy = inst.trading_ccy;
      for (const f of TERMS[k] || []) {
        const v = t[f.key];
        if (v === undefined || v === null || v === '') continue;
        rows.push([f.label, f.type === 'enum' ? f.options[v] || v : f.type === 'number' && ['commitment', 'givenValue', 'receivedValue', 'feeNotional', 'notional', 'vegaNotional', 'notionalPerPoint', 'tick', 'cap'].includes(f.key) ? fmt(v, ccy) : v]);
      }
      rows.push(['Valuation goes stale after', t.valuationMaxAgeDays ? `${t.valuationMaxAgeDays} days` : 'Not set']);
      rows.push(['Settlement or valuation rule', formulaText(inst)]);
      rows.push(['Workflow', `Entered by hand: ${eventsFor(inst).map((a) => eventLabel(inst, a).toLowerCase()).join(', ')}. Nothing is priced or generated automatically.`]);
      if (t.counterparty) rows.push(['Counterparty', t.counterparty]);
      if (OTC_KINDS.has(k) && app?.agreements) rows.push(...app.agreements.describeRows(inst));
      if (inst.terms.lotSize) rows.push(['Lot size', inst.terms.lotSize]);
      return rows;
    },
    qtyLabelFor: (inst) => QTY_LABEL[kindOf(inst)] || (kindOf(inst) === 'freight' ? `Quantity (${inst.terms?.quantityUnit || 'units'})` : OTC_KINDS.has(kindOf(inst)) ? 'Contracts (1 = the contract as registered)' : 'Units'),
    priceUnits: priceUnitsOf,
    actionLabelsFor: (inst) => ACTION_LABELS[kindOf(inst)] || (OTC_KINDS.has(kindOf(inst)) ? { buy: 'Enter the contract', sell: 'Terminate (agreed amount)' } : null),
    direction: directionOf,
    /** A hedge fund interest leaves only by notice; a contract cannot be entered after it ends. */
    tradeRefusal(app, { inst, action, tradeDate }) {
      const k = kindOf(inst);
      if (k === 'fund_interest' && action === 'sell') return { code: 'redeem-by-notice', message: `${label(inst)} is redeemed through a redemption notice (Lifecycle, Redemption notice), dealt on the fund's dealing dates subject to its ${inst.terms.noticeDays}-day notice period${inst.terms.gatePct ? ' and its gate' : ''}. It is not sold on a ticket.` };
      const end = endDateOf(inst);
      if (OTC_KINDS.has(k) && action === 'buy' && end && tradeDate > end) return { code: 'expired', message: `${label(inst)} ended on ${end}; it cannot be entered.` };
      return null;
    },
    collateralNotional,
    economics(app, args) {
      const out = base.economics(app, args);
      const { inst } = args;
      if (!OTC_KINDS.has(kindOf(inst))) return out;
      const buy = args.action === 'buy';
      const upfront = args.qty * args.price * inst.multiplier;
      const coll = app.agreements.tradeRequirement({ book: args.book, unit: args.unit, inst, action: args.action, qty: args.qty, price: args.price, strategyId: args.strategyId, cashOut: Math.max(0, buy ? upfront : -upfront) });
      return { ...out, notional: collateralNotional(app, inst, { qtyAfter: args.qty }), initialMargin: coll.initialMargin, collateral: coll, notes: [...(out.notes || []), formulaText(inst), ...coll.notes] };
    },
    fill(app, c) {
      const before = app.positions.find(c.unit.id, c.inst.id, c.strategyId || '');
      const qBefore = before?.qty || 0;
      const r = base.fill(app, c);
      const k = kindOf(c.inst);
      // A secondary sale of part of a fund interest takes the same share of what was called with it.
      if (k === 'commitment' && c.action === 'sell' && qBefore > 0) {
        const after = app.positions.get(r.position.id);
        const m = manualOf(after);
        const factor = after.qty / qBefore;
        app.positions.setData(after, { manual: { ...m, called: money((m.called || 0) * factor, c.inst.trading_ccy), feesCalled: money((m.feesCalled || 0) * factor, c.inst.trading_ccy) } });
      }
      return { ...r, position: app.positions.get(r.position.id) };
    },
    value(app, inst, pos, obs, mark) {
      const v = valueSecurity(inst, pos, obs, mark);
      const presented = obs ? app.data.present(obs) : null;
      return { ...v, manual: summary(inst, pos, presented), valuationNote: presented?.freshness === 'stale' ? `The last valuation (${presented.forDate || String(presented.asOf).slice(0, 10)}) is older than ${inst.terms.valuationMaxAgeDays} days: the value is provisional.` : null };
    },
    onPositionChange(app, { book, unit, inst, pos }) {
      const k = kindOf(inst);
      if (OTC_KINDS.has(k)) app.agreements.onPositionChange({ book, unit, inst, pos });
      if (isZero(pos.qty)) { app.tasks.cancelFor(pos.id); return; }
      const end = endDateOf(inst);
      if (end && (OTC_KINDS.has(k) || k === 'ils')) {
        app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: k === 'ils' ? 'manual.maturity' : 'manual.settlement', dueDate: end });
      }
    },
    runTask(app, task, { inst }) {
      if (task.type === 'manual.redemption') return { blocked: `Waiting for the NAV per share of the dealing date ${task.due_date}, entered by hand (Lifecycle, Redemption at NAV).` };
      if (task.type === 'manual.maturity') return { blocked: `Waiting for the redemption of ${label(inst)}, entered by hand (Lifecycle, Redemption at maturity).` };
      if (task.type === 'manual.settlement') return { blocked: `Waiting for the realised value, entered by hand (Lifecycle, ${eventLabel(inst, 'settle')}). ${formulaText(inst)}` };
      return { failed: `No lifecycle handler for ${task.type}.` };
    },
  };
}
