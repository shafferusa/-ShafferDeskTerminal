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
//   supports(op)                              -> boolean (sync): the operation is mapped and an address is configured
//   async strategies()                        -> {available, items:[{id, name, version?, hedgeObjective?, hedgeSettings?}]} | unavailable
//                                                Investment Strategies, identified by the service's stable `id`. The Terminal
//                                                stores and sends that id; a name typed while the list is unavailable is kept
//                                                as { id: null, name, resolved: false } until the user confirms a match.
//                                                (Execution templates such as collars and spreads are the Terminal's own.)
//   async hedge(HedgeRequest)                 -> {available, response: HedgeResponse} | unavailable
//
// Shaffer Hedge lives in Analytics Lab. It evaluates exposures, selects hedge structures, sizes
// their legs, decides which existing hedges apply to an exposure, and returns trade instructions.
// The Terminal only builds the request, shows the proposals, validates and stores the protection
// allocations, and runs confirmed paper execution. The request shape is built in core/hedge.js.
//
// HedgeRequest (draft-2), the protection-related parts:
//   primary             { positionId|null, instrument, direction, quantity, status: 'filled'|'proposed', ... }
//   proposedLegs[]      legs of the execution template being built; isProtection + relation 'template' on its hedge legs
//   linkedProtection[]  hedges the Terminal KNOWS protect this primary (executed from its hedge request, or a hedge leg
//                       in the same strategy instance)
//   hedgesHeld[]        every hedge in the Account (or Book, for Book scope) as context, each with
//                       relation: 'linked' | 'shared' | 'allocated_elsewhere' | 'unassessed',
//                       capacity {units, rule}, allocatedUnits, capacityLeft, allocations[]
//   exposures.positions every open position in scope (facts only)
//
// HedgeResponse       { source?, version?, asOf, modelRun, recommendedId, packages: [HedgePackage], protection?: ProtectionAssessment }
//                     The Terminal stamps the stored response with its own source record
//                     { kind: 'shaffer-hedge'|'demo-fixture'|'test-fixture', label, version (version ?? modelRun ?? null),
//                       receivedAt, exposureAsOf, fingerprint } and derives freshness from positions as they are later.
// ProtectionAssessment { allocations: [{ hedgePositionId, protectedPositionId? (default: the request's primary position),
//                       units, capacity? (required when the hedge has no unit measure in the Terminal), basis: 'shared', note? }],
//                       unrelated: [{ hedgePositionId, protectedPositionId?, note? }] }
//                     Validated in core/protection.js: capacity is never exceeded across positions, nothing crosses a Book,
//                     and an expired or closed hedge cannot be allocated. A failing allocation is stored as rejected.
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
    supports: () => false,
    instrumentAnalytics: async (instruments) => emptyMap(instruments.map((i) => i.id)),
    signals: async () => none(),
    valuations: async (instruments) => emptyMap(instruments.map((i) => i.id)),
    risk: async () => none(),
    strategies: async () => none(),
    hedge: async () => none(),
  };
}

export { datasetStates };

// =============================================================================================
// SERVER CLIENT (round of 2026-10-14): one integration layer, three interfaces, one gateway
// =============================================================================================
//
//   market     market, reference and historical data, company data      Shaffer MarketData  (remote, via gateway)
//   analytics  analytics, valuations, Strategies, Hedge, earnings window Shaffer Analytics Lab (remote, via gateway)
//   ledger     the Terminal's own paper ledger                          local database, NEVER remote
//
// Both remote interfaces may share one gateway address and one server-side credential (SHAFFER_GATEWAY_URL /
// SHAFFER_API_TOKEN). Every method is `client.<interface>.<method>(params, { signal, requestId, selection,
// channel, asOf, fresh })` and resolves to the response Envelope (docs/SERVER-CLIENT.md, section 1). The real
// mapping of each method lives in shaffer-contract.js (`serverOperations`); a method with no mapping answers
// state 'awaiting' with its operation name. The plumbing (timeouts, cancellation, bounded retries with no
// retry on 401/403, TTL cache with invalidation, cursor/page pagination, refresh intervals, a subscription hook,
// selection tokens) is in server-client.js.
//
// A contract operation is `async ({ http, ctx, signal, cursor, page, pageSize }, params) => ContractResult`:
//   ContractResult { items? | data?, asOf?, version?, schema?, coverage?: {from, to, missing[]},
//                    missingFields?: [field], nulls?: {field: reason},
//                    nextCursor? | page?, totalPages?, totalItems?, pageSize? }
//   Errors: throw an Error with `status` (HTTP status) so 401/403 are classified as not retryable.
//
// SERVER_DATASETS below is the data-requirements catalogue: for each dataset, the inputs, the fields the
// Terminal needs back (`requires`), units and timestamps, default freshness (seconds), pagination and point-in-time
// expectations, and the errors the screen distinguishes. docs/DATA-CONTRACT-REQUIREMENTS.md expands it in prose.

const COMMON_ERRORS = ['401/403: not retried, dataset blocked until credentials are re-tested', '404: unavailable (no data for this subject)', '408/429/5xx/network/timeout: retried with backoff (bounded), then error (retryable)'];

export const SERVER_DATASETS = {
  // ---- market interface ------------------------------------------------------------------------------
  search: {
    label: 'Reference search', interface: 'market', method: 'search', operation: 'market.search', shape: 'items',
    inputs: { q: 'text (symbol, name, server ID)', limit: 'int', marketView: 'optional filter' },
    requires: ['ids.server', 'symbol', 'name', 'productType', 'currency'],
    optional: ['ids.issuer', 'ids.contract', 'venue', 'issuerName'],
    units: null, timestamps: [], freshness: { ttlSec: 300, staleAfterSec: 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'cursor or page', pointInTime: 'not needed', errors: COMMON_ERRORS,
  },
  reference: {
    label: 'Instrument reference and stable IDs', interface: 'market', method: 'reference', operation: 'market.reference', shape: 'data',
    inputs: { id: 'server instrument ID (or the Terminal ID, mapped through external_ids.shaffer)' },
    requires: ['ids.server', 'symbol', 'name', 'productType', 'currency', 'venue', 'quoteConvention', 'units'],
    optional: ['ids.issuer', 'ids.contract', 'multiplier', 'underlying.ids', 'listing', 'issuer.name'],
    units: 'quoteConvention and units state how a price of this instrument is quoted (per share, % of par clean, index points, quote per base)',
    timestamps: ['updatedAt'], freshness: { ttlSec: 3600, staleAfterSec: 7 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'optional (reference as of a date)', errors: COMMON_ERRORS,
  },
  quotes: {
    label: 'Current quotes', interface: 'market', method: 'quotes', operation: 'market.quotes', shape: 'items',
    inputs: { ids: 'instrument IDs (batch)' },
    requires: ['instrumentId', 'quoteType', 'currency', 'units', 'timestamp', 'status'],
    optional: ['bid', 'ask', 'last', 'mid', 'prevClose', 'change', 'changePct', 'bidSize', 'askSize', 'delayMinutes', 'quoteConvention'],
    units: 'price in `units` of `currency` (per share, % of par, index points, quote currency per 1 base)',
    timestamps: ['timestamp (quote time, ISO with offset)'], freshness: { ttlSec: 5, staleAfterSec: 60, intervalSec: 5, mode: 'interval' },
    pagination: 'none (batch)', pointInTime: 'not applicable (use history)', errors: COMMON_ERRORS,
  },
  history: {
    label: 'Price history', interface: 'market', method: 'history', operation: 'market.history', shape: 'items',
    inputs: { id: 'instrument', from: 'date', to: 'date', interval: '1d | 1wk | 1mo | intraday as supported', adjusted: 'bool' },
    requires: ['t', 'close', 'adjusted', 'currency', 'interval'],
    optional: ['open', 'high', 'low', 'volume', 'annotations (corporate actions)', 'adjustmentBasis'],
    units: 'same units as quotes; volume in the instrument quantity unit', timestamps: ['t (bar end, ISO)', 'date (business date)'],
    freshness: { ttlSec: 900, staleAfterSec: 2 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'cursor or page for long ranges', pointInTime: 'n/a (history is dated)', errors: [...COMMON_ERRORS, 'unsupported interval: unavailable with coverage.missing'],
  },
  fx: {
    label: 'FX rates', interface: 'market', method: 'fx', operation: 'market.fx', shape: 'items',
    inputs: { pairs: 'BASE/QUOTE list' }, requires: ['pair', 'rate', 'timestamp', 'direction'], optional: ['bid', 'ask', 'status'],
    units: 'quote currency per 1 unit of base', timestamps: ['timestamp'], freshness: { ttlSec: 15, staleAfterSec: 120, intervalSec: 15, mode: 'interval' },
    pagination: 'none', pointInTime: 'optional (rate as of a date)', errors: COMMON_ERRORS,
  },
  rates: {
    label: 'Reference and funding rates', interface: 'market', method: 'rates', operation: 'market.rates', shape: 'items',
    inputs: { codes: 'rate codes', from: 'date', to: 'date' }, requires: ['code', 'date', 'value', 'units'], optional: ['tenor', 'curve'],
    units: 'percent per annum', timestamps: ['date (fixing date)'], freshness: { ttlSec: 900, staleAfterSec: 2 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'n/a (dated)', errors: COMMON_ERRORS,
  },
  profile: {
    label: 'Company and issuer profile', interface: 'market', method: 'profile', operation: 'market.profile', shape: 'data',
    inputs: { id: 'instrument (the issuer is resolved by the server)' },
    requires: ['issuer.id', 'issuer.name', 'listing.exchange', 'listing.currency'],
    optional: ['issuer.description', 'issuer.sector', 'issuer.industry', 'issuer.classifications', 'listing.marketCap', 'listing.sharesOutstanding', 'highlights', 'nextEarnings'],
    units: 'marketCap in listing currency; sharesOutstanding in shares', timestamps: ['asOf', 'sharesOutstandingAsOf'],
    freshness: { ttlSec: 3600, staleAfterSec: 7 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'needed for the historical view (constituents, classifications as of a date)', errors: COMMON_ERRORS,
  },
  statements: {
    label: 'Financial statements', interface: 'market', method: 'statements', operation: 'market.statements', shape: 'data',
    inputs: { id: 'instrument or issuer', statement: 'income | balance | cashflow', period: 'quarterly | annual | ttm', periods: 'int' },
    requires: ['periods[].key', 'periods[].fiscalYear', 'periods[].fiscalPeriod', 'periods[].periodType', 'periods[].end', 'periods[].filingDate', 'periods[].basis', 'currency', 'units', 'lines[].key', 'lines[].label', 'lines[].values'],
    optional: ['periods[].start', 'periods[].restates', 'periods[].original', 'periods[].source', 'lines[].level', 'lines[].nulls'],
    units: 'statement currency and scale (units: 1 | thousands | millions); per-share lines in currency per share',
    timestamps: ['period end (instant for balance sheet)', 'filingDate', 'restatedAt'],
    freshness: { ttlSec: 3600, staleAfterSec: 30 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'page by periods when long', pointInTime: 'needed: as-filed values at a date vs current restated values', errors: COMMON_ERRORS,
  },
  earnings: {
    label: 'Earnings calendar and results', interface: 'market', method: 'earnings', operation: 'market.earnings', shape: 'items',
    inputs: { id: 'instrument or issuer', from: 'date', to: 'date' },
    requires: ['fiscalPeriod', 'releaseAt', 'dateStatus', 'metrics[].key', 'metrics[].reported', 'metrics[].units'],
    optional: ['reportedAt', 'metrics[].consensus', 'metrics[].prior', 'metrics[].surprise', 'metrics[].surprisePct', 'revision', 'documents'],
    units: 'per metric (currency, currency per share, percent)', timestamps: ['releaseAt (scheduled)', 'reportedAt (actual)', 'revisedAt'],
    freshness: { ttlSec: 1800, staleAfterSec: 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'cursor or page', pointInTime: 'optional (consensus as of a date)', errors: COMMON_ERRORS,
  },
  filings: {
    label: 'Filings and reports', interface: 'market', method: 'filings', operation: 'market.filings', shape: 'items',
    inputs: { id: 'instrument or issuer', kind: 'optional filter' },
    requires: ['id', 'kind', 'title', 'filedAt', 'source', 'documents[].id'], optional: ['period', 'documents[].mediaType', 'documents[].pages'],
    units: null, timestamps: ['filedAt'], freshness: { ttlSec: 1800, staleAfterSec: 7 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'cursor or page', pointInTime: 'filter by filedAt <= asOf', errors: COMMON_ERRORS,
  },
  documents: {
    label: 'Documents (proxied from the gateway)', interface: 'market', method: 'document', operation: 'market.document', shape: 'stream',
    inputs: { docId: 'document ID from filings / earnings' }, requires: ['bytes', 'mediaType'], optional: ['filename', 'length'],
    units: null, timestamps: [], freshness: { ttlSec: 0, staleAfterSec: null, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'n/a', errors: [...COMMON_ERRORS, 'media types other than pdf/html/text are refused'],
  },
  corporateActions: {
    label: 'Corporate actions (informational)', interface: 'market', method: 'corporateActions', operation: 'market.corporateActions', shape: 'items',
    inputs: { id: 'instrument', from: 'date', to: 'date' },
    requires: ['eventId', 'type', 'exDate', 'status'], optional: ['recordDate', 'payDate', 'amount', 'currency', 'ratio', 'terms', 'revision'],
    units: 'amount in currency per unit; ratio as new:old', timestamps: ['announcedAt', 'exDate', 'payDate'],
    freshness: { ttlSec: 3600, staleAfterSec: 2 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'cursor or page', pointInTime: 'optional', errors: COMMON_ERRORS,
  },
  news: {
    label: 'News and events', interface: 'market', method: 'news', operation: 'market.news', shape: 'items',
    inputs: { id: 'instrument (company, its sector, relevant economy)', from: 'instant' },
    requires: ['id', 'publishedAt', 'source', 'headline', 'scope'], optional: ['summary', 'facts', 'classification', 'interpretation', 'url'],
    units: null, timestamps: ['publishedAt', 'receivedAt'], freshness: { ttlSec: 120, staleAfterSec: 3600, intervalSec: 120, mode: 'interval' },
    pagination: 'cursor or page', pointInTime: 'filter by publishedAt <= asOf', errors: COMMON_ERRORS,
  },
  // ---- product-specific datasets (p1: bond, option, future, fund, FX, swap and credit detail pages) ------------
  // Each is shown only when supplied. The Terminal never computes a yield, spread, Greek, implied volatility, curve or
  // mark: these fields are passed through with their provider and timestamp. Contract terms, schedules and the paper
  // engine's accrued interest are the Terminal's own (GET /api/instruments/:id/contract-facts), not server data.
  ratingsCovenants: {
    label: 'Credit ratings and covenants', interface: 'market', method: 'ratingsCovenants', operation: 'market.ratingsCovenants', shape: 'data',
    inputs: { id: 'debt instrument (issue) or its issuer' },
    requires: ['ratings', 'covenants', 'scope'],
    optional: ['ratings[].outlook', 'ratings[].watch', 'ratings[].action', 'covenants[].threshold', 'covenants[].status', 'ratedEntity'],
    units: 'ratings on each agency\'s own scale (named per rating); covenant thresholds in the units the covenant states',
    timestamps: ['ratings[].ratedAt', 'covenants[].asOf'], freshness: { ttlSec: 3600, staleAfterSec: 7 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'optional (ratings in force at a date)', errors: COMMON_ERRORS,
  },
  yieldSpread: {
    label: 'Yield and spread (supplied)', interface: 'market', method: 'yieldSpread', operation: 'market.yieldSpread', shape: 'data',
    inputs: { id: 'debt instrument' },
    requires: ['yield', 'priceUsed', 'calculatedAt', 'provider'],
    optional: ['spread', 'spread.benchmark'],
    units: 'yield in percent per annum with its type (to maturity, to worst) and compounding convention; spread in basis points against a named benchmark; priceUsed in the quote units (% of par, clean)',
    timestamps: ['calculatedAt', 'priceUsed.timestamp'], freshness: { ttlSec: 300, staleAfterSec: 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'optional', errors: COMMON_ERRORS,
  },
  optionGreeks: {
    label: 'Option Greeks and implied volatility (supplied)', interface: 'market', method: 'optionGreeks', operation: 'market.optionGreeks', shape: 'data',
    inputs: { id: 'option contract' },
    requires: ['impliedVol', 'delta', 'calculatedAt', 'provider'],
    optional: ['gamma', 'theta', 'vega', 'rho', 'model', 'underlyingPrice', 'optionPrice', 'units'],
    units: 'impliedVol as a decimal per annum; delta per unit of underlying; theta per calendar day; vega per 1 volatility point; rho per 1 percentage point (the provider states its units in `units`)',
    timestamps: ['calculatedAt'], freshness: { ttlSec: 60, staleAfterSec: 3600, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'optional', errors: COMMON_ERRORS,
  },
  futuresCurve: {
    label: 'Futures curve across contract months (supplied)', interface: 'market', method: 'futuresCurve', operation: 'market.futuresCurve', shape: 'items',
    inputs: { id: 'futures contract (its root / underlying selects the curve)' },
    requires: ['contractMonth', 'expiration', 'price', 'priceType', 'timestamp'],
    optional: ['ids', 'symbol', 'openInterest', 'volume', 'units', 'currency'],
    units: 'price in the contract\'s quote units (index points, currency per unit); openInterest and volume in contracts',
    timestamps: ['timestamp (per month)'], freshness: { ttlSec: 60, staleAfterSec: 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'optional (settlement curve of a date)', errors: COMMON_ERRORS,
  },
  exchangeMargin: {
    label: 'Exchange margin requirements (supplied)', interface: 'market', method: 'exchangeMargin', operation: 'market.exchangeMargin', shape: 'data',
    inputs: { id: 'futures contract' },
    requires: ['initial', 'currency', 'effectiveDate', 'clearingHouse'],
    optional: ['maintenance', 'perContract', 'notes'],
    units: 'amount per contract in `currency`', timestamps: ['effectiveDate'],
    freshness: { ttlSec: 3600, staleAfterSec: 7 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'optional (requirement in force at a date)', errors: COMMON_ERRORS,
  },
  fundHoldings: {
    label: 'Fund holdings and weights', interface: 'market', method: 'fundHoldings', operation: 'market.fundHoldings', shape: 'items',
    inputs: { id: 'fund share class' },
    requires: ['name', 'weightPct', 'holdingsDate'],
    optional: ['ids', 'assetClass', 'quantity', 'marketValue', 'currency', 'coveragePct', 'holdingsCount'],
    units: 'weightPct in percent of net assets; marketValue in `currency`; quantity in the holding\'s own units',
    timestamps: ['holdingsDate (date the portfolio is reported as of)'], freshness: { ttlSec: 3600, staleAfterSec: 120 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'page for long holdings lists', pointInTime: 'optional (holdings reported as of a date)', errors: COMMON_ERRORS,
  },
  fundFacts: {
    label: 'Fund NAV, fees and facts', interface: 'market', method: 'fundFacts', operation: 'market.fundFacts', shape: 'data',
    inputs: { id: 'fund share class' },
    requires: ['nav', 'navDate', 'navCurrency'],
    optional: ['shareClass', 'fees.ongoingChargePct', 'fees.managementFeePct', 'fees.entryChargePct', 'fees.exitChargePct', 'fees.performanceFee', 'fees.asOf', 'distributionPolicy', 'netAssets'],
    units: 'nav in navCurrency per share; fees in percent per annum (charges in percent of the amount dealt)',
    timestamps: ['navDate', 'fees.asOf'], freshness: { ttlSec: 900, staleAfterSec: 4 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'optional', errors: COMMON_ERRORS,
  },
  otcMarks: {
    label: 'Supplied marks for OTC contracts', interface: 'market', method: 'otcMarks', operation: 'market.otcMarks', shape: 'items',
    inputs: { id: 'OTC contract (swap, credit default swap, forward, OTC option)', from: 'date', to: 'date' },
    requires: ['date', 'value', 'units', 'kind', 'provider', 'timestamp'],
    optional: ['method', 'side', 'note'],
    units: 'value in the contract\'s mark units (net present value per 100 notional unless `units` says otherwise); kind dealer | clearing | model (a model mark from Analytics Lab is a valuation, never a quote)',
    timestamps: ['date (mark date)', 'timestamp (when the provider struck it)'], freshness: { ttlSec: 900, staleAfterSec: 3 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'cursor or page for long histories', pointInTime: 'optional (marks up to a date)', errors: COMMON_ERRORS,
  },
  fxCurve: {
    label: 'FX forward curve (supplied)', interface: 'market', method: 'fxCurve', operation: 'market.fxCurve', shape: 'items',
    inputs: { id: 'currency pair' },
    requires: ['tenor', 'forwardPoints', 'pointsUnits', 'timestamp'],
    optional: ['valueDate', 'outright', 'spotReference'],
    units: 'forward points in pointsUnits (for example pips of 0.0001); outright in quote currency per 1 base',
    timestamps: ['timestamp'], freshness: { ttlSec: 60, staleAfterSec: 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'optional', errors: COMMON_ERRORS,
  },
  // ---- analytics interface --------------------------------------------------------------------------
  analytics: {
    label: 'Instrument analytics (SP3E)', interface: 'analytics', method: 'instrumentAnalytics', operation: 'analytics.instrumentAnalytics', shape: 'data',
    inputs: { id: 'instrument', strategyId: 'Strategy ID (SP3E first)', runId: 'optional', asOf: 'optional' },
    requires: ['strategyId', 'runId', 'version', 'calculatedAt', 'inputCutoff', 'horizon', 'fairValueCurrency', 'fairValueUnits'],
    optional: ['efs', 'sectorScore', 'equityScore', 'fundamentalFairValue', 'realisticFairValue', 'fundamentalGapPct', 'realisticGapPct', 'uncertainty', 'timingEligibility', 'outlierFlags', 'sizing', 'hedge'],
    units: 'fair values in fairValueCurrency and fairValueUnits (must match the quote units); gaps in percent as the server states them',
    timestamps: ['calculatedAt', 'inputCutoff'], freshness: { ttlSec: 300, staleAfterSec: 3 * 86400, intervalSec: 300, mode: 'interval' },
    pagination: 'none', pointInTime: 'historical runs (flagged historical, never a current recommendation)', errors: COMMON_ERRORS,
  },
  analyticsRuns: {
    label: 'Analytics runs', interface: 'analytics', method: 'runs', operation: 'analytics.runs', shape: 'items',
    inputs: { id: 'instrument', strategyId: 'Strategy ID' }, requires: ['runId', 'version', 'calculatedAt', 'inputCutoff', 'horizon'], optional: ['current'],
    units: null, timestamps: ['calculatedAt', 'inputCutoff'], freshness: { ttlSec: 300, staleAfterSec: 3 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'cursor or page', pointInTime: 'runs at or before asOf', errors: COMMON_ERRORS,
  },
  earningsWindow: {
    label: 'Earnings-window eligibility (Analytics Lab)', interface: 'analytics', method: 'earningsWindow', operation: 'analytics.earningsWindow', shape: 'data',
    inputs: { id: 'instrument', strategyId: 'Strategy ID' }, requires: ['eligible', 'runId', 'calculatedAt'], optional: ['window', 'reason'],
    units: null, timestamps: ['calculatedAt'], freshness: { ttlSec: 900, staleAfterSec: 3 * 86400, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'optional', errors: COMMON_ERRORS,
  },
  // ---- ledger interface (local; never remote) -----------------------------------------------------
  ledger: {
    label: 'Paper ledger (this Terminal)', interface: 'ledger', method: 'instrument', operation: 'ledger.instrument', shape: 'data',
    inputs: { id: 'instrument', bookId: 'Book' }, requires: ['holdings'], optional: ['orders', 'fills', 'recordedCorporateActions'],
    units: 'instrument quantity units', timestamps: ['fills[].ts'], freshness: { ttlSec: 0, staleAfterSec: null, intervalSec: null, mode: 'on-demand' },
    pagination: 'none', pointInTime: 'n/a', errors: ['404: unknown Book or instrument'],
  },
};

/** The datasets of one interface. */
export const datasetsOf = (iface) => Object.entries(SERVER_DATASETS).filter(([, d]) => d.interface === iface).map(([k]) => k);
