// The integration boundary.
//
//   External sources -> Shaffer MarketData Database -> Analytics Lab / approved service API -> Desk Terminal
//
// The Terminal talks to the outside world through exactly two ports, and keeps its own paper
// ledger entirely separate from both:
//
//   MarketPort     facts owned by Shaffer MarketData: instrument reference data, prices, history,
//                  FX, rates, calendars, earnings, corporate actions, derivative contract data,
//                  borrow availability and financing rates.
//   AnalyticsPort  outputs owned by Shaffer Analytics Lab: model runs, strategy signals, scores,
//                  fair values, Shaffer Gaps, valuations, risk, sizing and hedge outputs.
//
// A port method returns either data in the Terminal's own shapes or "not available". It never
// fabricates a value. Until the real service contracts are supplied every method of the Shaffer
// implementation reports "awaiting", and the screens show "Awaiting Shaffer data connection".
//
// ---------------------------------------------------------------------------------------------
// MarketPort
//   state()                                   -> PortState (sync)
//   async testConnection()                    -> { ok, reachable, httpStatus?, detail }
//   async quotes(instruments[])               -> Map<instrumentId, Observation|null>
//   async fx(pairs[] e.g. 'EUR/USD')          -> Map<pair, Observation|null>          value = quote per 1 base
//   async rates(codes[], {from?, to?})        -> Map<code, Observation[]>             one per observation date
//   async closes([{instrument, date}])        -> Map<`${id}@${date}`, Observation|null>  official close / fixing
//   async borrow(instruments[])               -> Map<instrumentId, BorrowInfo|null>
//   async sessions(instruments[])             -> Map<instrumentId, {state:'open'|'closed'|'pre'|'post', nextOpen?}|null>
//   async history(instrument, {from,to,interval}) -> {available, bars:[{t,date,open,high,low,close,volume}], ...meta} | unavailable
//   async search(query, {limit, marketView})  -> {available, items:[ReferenceHit]} | unavailable
//   async reference(externalId)               -> {available, instrument} | unavailable
//   async optionChain(underlying, {expiration}) -> {available, chain} | unavailable
//   async contracts(underlying, {family})     -> {available, items:[contract reference]} | unavailable   (futures months etc.)
//   async corporateActions(instruments[], {from,to}) -> {available, items:[{instrumentId,type,exDate,payDate,amount,currency,ratioNum,ratioDen}]} | unavailable
//   async calendar({from,to,instruments})     -> {available, items:[earnings / economic events]} | unavailable
//
// AnalyticsPort
//   state()                                   -> PortState (sync)
//   async testConnection()
//   async instrumentAnalytics(instruments[])  -> Map<instrumentId, InstrumentAnalytics|null>
//   async signals({bookId?, strategy?, since?}) -> {available, items:[Signal]} | unavailable
//   async valuations(instruments[])           -> Map<instrumentId, Observation|null>   status 'model-derived'
//   async risk(request)                       -> {available, ...} | unavailable
//   async strategies()                        -> {available, items:[{id, name, hedgeObjective?, hedgeSettings?}]} | unavailable
//   async hedge(HedgeRequest)                 -> {available, response: HedgeResponse} | unavailable
//
// Shaffer Hedge lives in Analytics Lab. It evaluates exposures, selects hedge structures, sizes
// their legs and returns trade instructions. The Terminal only builds the request, shows the
// proposals, and runs confirmed paper execution. The request shape is built in core/hedge.js.
//
// HedgeResponse       { source, asOf, modelRun, recommendedId, packages: [HedgePackage] }
// HedgePackage        { id, label, recommended, riskAddressed[], intendedProtection, horizon: {days?, until?},
//                       exposure: [{ measure ('delta'|'beta'|'dv01'|'key-rate'|'fx'|'cs01'|'commodity'|…), unit, before, after, residual, basisRisk }],
//                       upsideSurrendered, costs: { currency, upfrontCash, premiums, expectedOngoing, margin, collateral, borrowing, funding },
//                       scenarios: [{ label, unhedged, hedged, unit }], valuation: { source, asOf, status, availability }, notes[], legs: [HedgeLeg] }
// HedgeLeg            { role: 'hedge'|'financing', hedgeFamily, kind ('trade'|'loan'|'repo_open'|'borrow_sec'|…), action,
//                       instrumentId | externalId | option: {...} | contract: {productId, name, marketView, tradingCcy, underlyingId, multiplier, terms},
//                       quantity, sizingBasis, hedgeRatio, riskAddressed, orderType?, limitPrice?,
//                       indicative: { value, status, source, asOf } (never an executable quote), dependsOn?: [leg index] }
//
// BorrowInfo          { available: boolean, quantity: number|null, feeRate: number (decimal p.a.), rebateRate?: number, obs: Observation }
// InstrumentAnalytics { asOf, modelRun, source, efs, sectorScore, equityScore,
//                       fundamentalFairValue, realisticFairValue, fairValueCurrency,
//                       fundamentalGap, realisticGap,            // the two Shaffer Gaps, shown side by side
//                       timingEligibility, outlierFlags[], sizing, hedge }
//                     Any field the service has not implemented is null and renders as missing.
// Signal              { id, asOf, modelRun, strategy, model, instrumentId, direction, template?,
//                       sizing: {quantity?, notional?, weight?}, hedge?, timingEligibility?, outlierFlags[], note? }
// PortState           { connection, message, address, lastChecked, lastSuccess, lastError, datasets: {name: DatasetState} }
// DatasetState        { state: 'awaiting'|'ready'|'partial'|'error'|'demo', coverage?, lastRefresh?, refreshSchedule?, note? }
// ---------------------------------------------------------------------------------------------

import { AWAITING_MESSAGE, unavailable } from './observation.js';

export const MARKET_DATASETS = {
  reference: 'Instrument reference data',
  prices: 'Prices and quotes',
  history: 'Historical prices',
  fx: 'FX rates',
  rates: 'Reference and funding rates',
  calendars: 'Market calendars and sessions',
  events: 'Earnings and economic calendar',
  corporateActions: 'Dividends and corporate actions',
  derivatives: 'Derivative contract data (option chains, futures months)',
  financing: 'Borrow availability and repo rates',
  fundamentals: 'Fundamentals',
};

export const ANALYTICS_DATASETS = {
  modelRuns: 'Model runs',
  signals: 'Strategy signals',
  scores: 'EFS, Sector Score, Equity Score',
  fairValues: 'Fundamental and Realistic Fair Value, Shaffer Gaps',
  valuations: 'Model valuations (OTC marks)',
  timing: 'Timing eligibility and outlier flags',
  sizing: 'Sizing suggestions',
  risk: 'Risk outputs',
  strategies: 'Investment Strategies and their hedge policies',
  hedge: 'Shaffer Hedge (hedge packages and instructions)',
};

function datasetStates(names, state, note) {
  const out = {};
  for (const k of Object.keys(names)) out[k] = { label: names[k], state, coverage: null, lastRefresh: null, refreshSchedule: null, note: note || null };
  return out;
}

const emptyMap = (keys) => new Map(keys.map((k) => [k, null]));

/** MarketPort that has nothing to offer yet. Used until the Shaffer MarketData service is connected. */
export function createAwaitingMarketPort({ message = AWAITING_MESSAGE, address = '' } = {}) {
  const none = () => unavailable('awaiting-connection', message);
  return {
    id: 'awaiting',
    state: () => ({
      connection: 'awaiting', message, address, lastChecked: null, lastSuccess: null, lastError: null,
      datasets: datasetStates(MARKET_DATASETS, 'awaiting'),
    }),
    testConnection: async () => ({ ok: false, reachable: false, detail: 'No Shaffer MarketData address is configured.' }),
    quotes: async (instruments) => emptyMap(instruments.map((i) => i.id)),
    fx: async (pairs) => emptyMap(pairs),
    rates: async (codes) => new Map(codes.map((c) => [c, []])),
    closes: async (reqs) => emptyMap(reqs.map((r) => `${r.instrument.id}@${r.date}`)),
    borrow: async (instruments) => emptyMap(instruments.map((i) => i.id)),
    sessions: async (instruments) => emptyMap(instruments.map((i) => i.id)),
    history: async () => none(),
    search: async () => none(),
    reference: async () => none(),
    optionChain: async () => none(),
    contracts: async () => none(),
    corporateActions: async () => none(),
    calendar: async () => none(),
  };
}

/** AnalyticsPort that has nothing to offer yet. */
export function createAwaitingAnalyticsPort({ message = AWAITING_MESSAGE, address = '' } = {}) {
  const none = () => unavailable('awaiting-connection', message);
  return {
    id: 'awaiting',
    state: () => ({
      connection: 'awaiting', message, address, lastChecked: null, lastSuccess: null, lastError: null,
      datasets: datasetStates(ANALYTICS_DATASETS, 'awaiting'),
    }),
    testConnection: async () => ({ ok: false, reachable: false, detail: 'No Shaffer Analytics Lab address is configured.' }),
    instrumentAnalytics: async (instruments) => emptyMap(instruments.map((i) => i.id)),
    signals: async () => none(),
    valuations: async (instruments) => emptyMap(instruments.map((i) => i.id)),
    risk: async () => none(),
    strategies: async () => none(),
    hedge: async () => none(),
  };
}

export { datasetStates };
