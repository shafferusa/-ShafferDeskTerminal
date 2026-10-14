// Shaffer service contract mapping.
//
// THIS FILE IS INTENTIONALLY EMPTY OF ENDPOINTS.
//
// The Terminal does not invent service endpoints, payloads, authentication schemes or instrument
// IDs, and it does not treat a database table as an API. When the Shaffer MarketData and Analytics
// Lab services are built, obtain for each one:
//
//   - the API documentation and the service address (or the approved gateway/proxy address)
//   - authentication requirements
//   - the instrument ID scheme, with payload examples
//   - dataset coverage and refresh schedules
//
// and then fill in the operations below. Each operation receives a small HTTP helper bound to the
// configured address and server-side credentials, and must return data in the Terminal's shapes
// documented in ports.js. An operation left as `null` keeps reporting "awaiting" for its dataset;
// nothing else in the Terminal has to change.
//
//   http.get(path, {query})  / http.post(path, body)   -> parsed JSON (throws on HTTP error)
//   ctx.now()                -> ISO instant
//   ctx.extId(instrument)    -> the Shaffer instrument ID stored on the registry instrument, or null
//
// Recommended order of connection (each step is independent):
//   1. market.search / market.reference   instrument reference data
//   2. market.quotes                      available prices
//   3. market.history, market.closes      historical data and official closes
//   4. market.fx, market.rates            FX and reference rates
//   5. market.calendar, market.corporateActions
//   6. market.optionChain, market.contracts, market.borrow    derivative contract data, financing
//   7. analytics.*                        model runs, signals, valuations, risk outputs
//
// Historical coverage alone does not mean live prices are available: report each dataset's real
// state in `datasets` below.

export const marketContract = {
  /** Describes what the connected service actually covers. Shown on the Data Connection page. */
  datasets: null, // async ({http, ctx}) => ({ prices: {state:'ready', coverage:'US equities', refreshSchedule:'…'}, ... })
  health: null, // async ({http}) => ({ ok: true, detail: '…' })
  search: null, // async ({http, ctx}, query, opts) => [ReferenceHit]
  reference: null, // async ({http, ctx}, externalId) => instrument reference
  quotes: null, // async ({http, ctx}, instruments) => Map<instrumentId, Observation>
  fx: null, // async ({http, ctx}, pairs) => Map<pair, Observation>
  rates: null, // async ({http, ctx}, codes, range) => Map<code, Observation[]>
  closes: null, // async ({http, ctx}, requests) => Map<`${id}@${date}`, Observation>
  history: null, // async ({http, ctx}, instrument, range) => bars[]
  borrow: null, // async ({http, ctx}, instruments) => Map<instrumentId, BorrowInfo>
  sessions: null, // async ({http, ctx}, instruments) => Map<instrumentId, session>
  optionChain: null, // async ({http, ctx}, underlying, opts) => chain
  contracts: null, // async ({http, ctx}, underlying, opts) => contract references
  corporateActions: null, // async ({http, ctx}, instruments, range) => items
  calendar: null, // async ({http, ctx}, range) => items
};

export const analyticsContract = {
  datasets: null,
  health: null,
  instrumentAnalytics: null, // async ({http, ctx}, instruments) => Map<instrumentId, InstrumentAnalytics>
  signals: null, // async ({http, ctx}, filter) => [Signal]
  valuations: null, // async ({http, ctx}, instruments) => Map<instrumentId, Observation (status 'model-derived')>
  risk: null, // async ({http, ctx}, request) => risk output
  // Investment Strategies with the service's stable IDs. The Terminal stores and sends the id, never a typed name in its place.
  strategies: null, // async ({http, ctx}) => [{ id, name, version, hedgeObjective, hedgeSettings }]
  // The response may carry `version` (or `modelRun`) and a `protection` assessment: see HedgeResponse in ports.js.
  hedge: null, // async ({http, ctx}, hedgeRequest) => HedgeResponse (see ports.js); the request is built by core/hedge.js
};

// ---------------------------------------------------------------------------------------------
// Server client operations (docs/SERVER-CLIENT.md, server/data/server-client.js)
// ---------------------------------------------------------------------------------------------
//
// One entry per dataset of SERVER_DATASETS (ports.js). Each is null until the backend builder supplies the
// contract; a null operation makes its dataset answer state 'awaiting' with the operation name (for example
// "Awaiting Shaffer data connection (market.statements not yet mapped)"). Fill one in as
//
//   statements: async ({ http, ctx, signal, cursor, page, pageSize }, params) => ContractResult
//
// where `http.get(path, { query, signal })` / `http.post(path, body, { signal })` call the ONE configured gateway
// with the server-side credential, a timeout and the caller's cancellation signal, and throw an Error carrying
// `status` on an HTTP error (so 401/403 are never retried). ContractResult is documented in ports.js. The paths,
// query names, auth scheme and payload mapping all come from the supplied contract: none is assumed here.
//
// Where an operation below is null but the matching legacy operation in marketContract above is mapped
// (search, reference, quotes, history, fx, rates, corporateActions), the server client adapts the legacy one, so
// a mapping is never written twice.

export const serverOperations = {
  market: {
    search: null,           // ({...}, { q, limit, marketView }) => { items: [ReferenceHit], nextCursor? | page?, totalPages? }
    reference: null,        // ({...}, { serverId }) => { data: InstrumentReference, asOf? }
    quotes: null,           // ({...}, { instruments }) => { items: [Quote], asOf? }
    history: null,          // ({...}, { instrument, from, to, interval, adjusted }) => { items: [Bar], data: { adjusted, adjustmentBasis, annotations }, coverage }
    fx: null,               // ({...}, { pairs }) => { items: [FxRate] }
    rates: null,            // ({...}, { codes, from, to }) => { items: [RateObservation] }
    profile: null,          // ({...}, { instrument }) => { data: { issuer, listing, highlights, nextEarnings } }
    statements: null,       // ({...}, { instrument, statement, period, periods, asOf }) => { data: { periods, lines, currency, units } }
    earnings: null,         // ({...}, { instrument, from, to }) => { items: [EarningsEvent] }
    filings: null,          // ({...}, { instrument, kind, asOf }) => { items: [Filing], nextCursor? | page? }
    document: null,         // ({...}, { docId }) => { mediaType, filename?, body: ReadableStream | Buffer | string }
    corporateActions: null, // ({...}, { instrument, from, to }) => { items: [CorporateActionEvent] }
    news: null,             // ({...}, { instrument, from, asOf }) => { items: [NewsItem], nextCursor? | page? }
    // p1: product-specific detail pages (supplied values only; the Terminal computes none of them)
    ratingsCovenants: null, // ({...}, { instrument, asOf }) => { data: { scope, ratedEntity, ratings: [...], covenants: [...] } }
    yieldSpread: null,      // ({...}, { instrument }) => { data: { yield, spread, priceUsed, calculatedAt, provider } }
    optionGreeks: null,     // ({...}, { instrument }) => { data: { impliedVol, delta, gamma, theta, vega, rho, units, model, calculatedAt, provider } }
    futuresCurve: null,     // ({...}, { instrument }) => { items: [{ contractMonth, expiration, price, priceType, timestamp, openInterest?, volume? }] }
    exchangeMargin: null,   // ({...}, { instrument }) => { data: { initial, maintenance, currency, effectiveDate, clearingHouse } }
    fundHoldings: null,     // ({...}, { instrument, asOf }) => { items: [{ name, weightPct, ... }], data: { holdingsDate, coveragePct } }
    fundFacts: null,        // ({...}, { instrument }) => { data: { nav, navDate, navCurrency, shareClass, fees, distributionPolicy } }
    otcMarks: null,         // ({...}, { instrument, from, to, asOf }) => { items: [{ date, value, units, kind, provider, timestamp }] }
    fxCurve: null,          // ({...}, { instrument }) => { items: [{ tenor, valueDate, forwardPoints, pointsUnits, outright?, timestamp }] }
  },
  analytics: {
    instrumentAnalytics: null, // ({...}, { instrument, strategyId, runId, asOf }) => { data: AnalyticsRecord }
    runs: null,                // ({...}, { instrument, strategyId, asOf }) => { items: [RunSummary] }
    earningsWindow: null,      // ({...}, { instrument, strategyId }) => { data: { eligible, window, reason, runId, calculatedAt } }
  },
};

/**
 * What the contract says it supports, per dataset. Empty until the contract is supplied, which means:
 *   pointInTime[dataset]   true when the server answers an `asOf` request with what was known then
 *   pagination[dataset]    'cursor' | 'page' | null
 *   subscriptions[dataset] ({ ctx, params, onData, onError }) => unsubscribe   (push updates, if any are supported)
 *   versions               { api, schema } the contract is written against
 */
export const serverCapabilities = {
  pointInTime: {},
  pagination: {},
  subscriptions: {},
  versions: { api: null, schema: null },
};
