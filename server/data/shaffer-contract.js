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
  strategies: null, // async ({http, ctx}) => [{ id, name, hedgeObjective, hedgeSettings }]
  hedge: null, // async ({http, ctx}, hedgeRequest) => HedgeResponse (see ports.js); the request is built by core/hedge.js
};
