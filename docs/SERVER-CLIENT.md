# Server client: routes, response envelope, client methods and data requirements

Owner: d1 (server integration layer). Consumers: the instrument-detail workspace (w1) and every screen that shows
Shaffer data. This file is the commitment: routes and fields listed here are what the server returns. It is kept
true as the code changes; anything marked *planned* is not built yet.

The catalogue (`SERVER_DATASETS` in `server/data/ports.js`) holds 25 remote datasets (16 market and analytics
datasets of the first wave, documents included, and 9 product-specific datasets) plus the ledger interface. The
Strategy list and Hedge keep their earlier contract slots (`analyticsContract.strategies`, `.hedge`).

The Terminal never calls an external provider. Every route below goes through one internal integration layer
(`server/data/server-client.js`) with three interfaces:

| Interface | Code | Origin of the data | Remote? |
|---|---|---|---|
| `market` | market, reference and historical data, company data (profile, statements, earnings facts, filings, documents, corporate actions, news) | Shaffer MarketData through the gateway | yes (awaiting until the contract is supplied) |
| `analytics` | analytics, valuations, Strategies, Hedge, earnings-window eligibility | Shaffer Analytics Lab through the gateway | yes (awaiting until the contract is supplied) |
| `ledger` | the Terminal's own paper ledger: holdings by Account, orders, fills, recorded corporate actions | the Terminal's database | never remote |

Both remote interfaces share one configured gateway address (`SHAFFER_GATEWAY_URL`, else `SHAFFER_MARKETDATA_URL` /
`SHAFFER_ANALYTICS_URL`) and one server-side credential (`SHAFFER_API_TOKEN`, header `SHAFFER_AUTH_HEADER`). The
credential never reaches the browser. The real endpoint mapping goes in `server/data/shaffer-contract.js` only; no
URL, path, auth scheme or payload schema is invented anywhere.

## 1. The response envelope (every `/api/server/*` data route)

```js
{
  state: 'awaiting' | 'loading' | 'available' | 'stale' | 'unavailable' | 'incomplete' | 'error',
  dataset: 'statements',              // dataset key (see section 3)
  operation: 'market.statements',     // interface.method; shown in "awaiting" messages
  interface: 'market' | 'analytics' | 'ledger',
  source: { kind: 'shaffer-marketdata' | 'shaffer-analytics' | 'demo-fixture' | 'test-fixture' | 'simulated-demo-feed' | 'terminal-ledger' | null,
            label: 'Demo fixture' | 'Test fixture' | 'Shaffer MarketData' | ... , fixture: boolean },
  asOf: ISO | null,                   // when the data refers to (server's timestamp)
  receivedAt: ISO | null,             // when the Terminal obtained it
  freshness: { ageSec: number | null, staleAfterSec: number | null },
  version: string | null,             // API / schema / model version the server stated
  schema: string | null,              // payload schema name the server stated (null until the contract says)
  coverage: { from: date | null, to: date | null, missing: [string] },  // missing periods / fields / instruments
  items: [...] | undefined,           // list datasets
  data: {...} | undefined,            // single-object datasets
  missingFields: [string],            // state 'incomplete' names them here (and in coverage.missing)
  nulls: { field: reason },           // why a value is null, where the server (or fixture) says
  related: { underlying: { terminalId, symbol, ids, note } } | undefined,  // e.g. an option's issuer data lives on its underlying
  error: { code, message, retryable, status?, attempts? } | null,   // code: unauthorized | forbidden | not-found | server-error | throttled | timeout | network | cancelled | superseded | bad-request
  requestId: string,                  // echo of ?requestId= (or a generated id)
  selection: string | null,           // echo of ?selection= (instrument selection token)
  pagination: { mode: 'cursor' | 'page' | null, cursor, nextCursor, page, pageSize, totalPages, totalItems } | null,
  duplicates: { dropped: [id], note } | undefined,  // records delivered more than once in this answer, listed once
  pointInTime: { requested: ISO | null, supported: boolean | null, note } ,  // "as of" handling
  cached: boolean,                    // served from the server-side cache
  message: string | null,             // human sentence for the screen ("Awaiting Shaffer data connection ...")
}
```

Rules:
- `awaiting`: the contract operation is not mapped yet, or no gateway address is configured. `message` names the
  operation, e.g. `Awaiting Shaffer data connection (market.statements not yet mapped)`.
- `loading`: w1 shows it while its own request is in flight. The server also returns it when the request carried
  `?waitMs=N` and the gateway had not answered within N ms; the request carries on, and the next identical request
  receives the answer (joined or from the cache).
- `available`: complete and within `freshness.staleAfterSec`.
- `stale`: data present but `ageSec > staleAfterSec` (or a cached copy served after a failed refresh; then `error`
  is also set).
- `unavailable`: the server answered but has no data for this subject (empty), or "as of" is not supported.
- `incomplete`: data present but some fields the Terminal needs are missing: they are listed in `missingFields`;
  the values themselves are `null` with a reason in `nulls: { field: reason }` where the dataset gives one. In a
  list answer a required field absent from some records is named with a count, e.g. `source (missing in 1 of 2
  records)` (unless the list states it once in `data`, as history states `adjusted`, `currency`, `interval`).
- Duplicates: a record delivered twice in one answer (same server ID: news `id`, filings `id`, runs `runId`, search
  `ids.server`, earnings `fiscalPeriod`, quotes `instrumentId`, history `t`, curve months, tenors, marks by date and
  kind) is listed once and reported in `duplicates`. Corporate actions keep every delivery for their route, which
  lists each event once with `deliveries`.
- `error`: the request failed. `error.retryable` is false for 401/403 (never retried; the state says so) and for
  a superseded selection (`code: 'superseded'`).
- A missing value is `null`, never `0`.

## 2. Request controls (query parameters accepted by every data route)

| Parameter | Meaning |
|---|---|
| `requestId` | echoed back unchanged. w1 compares it with the latest request and discards anything older. |
| `selection` | instrument-selection token (e.g. `drawer:ALFA:7`). Server side, a newer request on the same `channel` with a different `selection` aborts the older in-flight gateway request; the older response is returned as `state:'error', error.code:'superseded'`. |
| `channel` | the screen area issuing requests (default `default`), scope of `selection`. |
| `asOf` | point-in-time request (ISO date or instant). If the contract does not support it for this dataset: `state:'unavailable'`, `pointInTime.supported:false`, `pointInTime.note:'Not supported by the contract'`. Never silently answered with current data. |
| `fresh=1` | bypass the cache for this request (on-demand refresh, and the screens' own recovery retries). |
| `waitMs` | answer `state:'loading'` if the gateway has not answered within this many ms (max 30000); see above. |
| `cursor` / `page` / `pageSize` | pagination (whichever the contract uses; both accepted). `all=1` collects every page (bounded). |

## 3. Routes

All `GET` unless stated. `:id` accepts the Terminal's instrument id or a server instrument id; the reference record
maps one to the other.

| Route | Dataset | Interface.method | Returns (`data` or `items`) |
|---|---|---|---|
| `GET /api/server/state` | (all) | | per-dataset connection state: `{ mode: 'demo'|'shaffer', gateway: { configured, shared, timeoutMs }, credentialsConfigured, retry, versions, datasets: { key: { label, interface, operation, mapped, addressConfigured, state, source, lastSuccess, lastError, requests, retries, authBlocked: { code, status, scope, retrying: false, note } | null, refresh, pointInTime: { supported }, pagination, fixture, message } } }`. Dataset `state` is the last envelope state, `awaiting` when unmapped, or `not-requested` before the first request. |
| `GET /api/server/datasets` | (all) | | the data-requirements catalogue (`SERVER_DATASETS` of ports.js) |
| `POST /api/server/test` | (all) | | tests both services and clears 401/403 blocks |
| `GET /api/server/reference/search?q=` | reference | market.search | `items: [{ ids: { terminal, server, issuer, contract }, symbol, name, productType, venue, currency, issuerName, registered }]`, paginated |
| `GET /api/server/reference/:id` | reference | market.reference | `data: { ids: {terminal, server, issuer, contract, strategyIds?}, symbol, name, productType, family, venue, currency, quoteConvention, units, multiplier, underlying: {ids, symbol}, listing: {...}, issuer: {id, name} }` |
| `GET /api/server/quotes?ids=a,b` | quotes | market.quotes | `items: [{ instrumentId, ids, quoteType: 'last'|'mid'|'bid-ask'|'settlement'|'nav'|'yield'|'indicative', bid, ask, last, mid, change, changePct, prevClose, currency, units, quoteConvention, timestamp, status: 'live'|'delayed'|'indicative'|'manual'|'simulated', delayMinutes, source, freshness }]` |
| `GET /api/server/history/:id?from&to&interval=1d&adjusted=1` | history | market.history | `items: [{ t, date, open, high, low, close, volume }]`, `data: { adjusted: bool, adjustmentBasis, currency, units, interval, annotations: [{date, type, label, ratio?, amount?}] }`, `coverage.missing` lists gaps |
| `GET /api/server/fx?pairs=EUR/USD` | fx | market.fx | `items: [{ pair, base, quote, rate, bid, ask, direction: 'quote per 1 base', timestamp, status }]` |
| `GET /api/server/rates?codes=&from&to` | rates | market.rates | `items: [{ code, date, value, units: 'percent p.a.' }]` |
| `GET /api/server/profile/:id` | profile | market.profile | `data: { issuer: { id, name, description, sector, industry, classifications[], country, website?, employees? }, listing: { exchange, symbol, currency, marketCap, sharesOutstanding, floatShares?, listedSince? }, highlights: {...}, nextEarnings: {date, confirmed} }` |
| `GET /api/server/statements/:id?statement=income|balance|cashflow&period=quarterly|annual|ttm&periods=12` | statements | market.statements | `data: { statement, period, currency, units, periods: [{ key, fiscalYear, fiscalPeriod, periodType: 'quarter'|'ytd'|'annual'|'ttm'|'instant', start, end, filingDate, source, basis: 'reported'|'normalized'|'restated'|'derived', restates?: key, original?: {...} }], lines: [{ key, label, level, values: { periodKey: number|null }, nulls: { periodKey: reason } }] }` |
| `GET /api/server/earnings/:id` | earnings | market.earnings | `items: [{ fiscalPeriod, releaseAt, dateStatus: 'confirmed'|'estimated', reportedAt, metrics: [{ key, label, reported, consensus, prior, surprise, surprisePct, units, currency }], revision: 'original'|'revised', documents: [{ id, title, kind }] }]`, upcoming entries have `reported: null` |
| `GET /api/server/earnings-window/:id` | earningsWindow | analytics.earningsWindow | `data: { eligible: bool|null, window: {from,to}, reason, runId, calculatedAt }` (Analytics Lab, separate from calendar facts) |
| `GET /api/server/filings/:id` | filings | market.filings | `items: [{ id, kind, title, filedAt, period, source, documents: [{ id, title, mediaType, pages? }] }]`, paginated |
| `GET /api/server/documents/:docId` | documents | market.document | the document bytes, streamed from the gateway only (fixture text in demo). Non-200 answers are an envelope. |
| `GET /api/server/corporate-actions/:id` | corporateActions | market.corporateActions | `items: [{ eventId, idempotencyKey, type, exDate, recordDate, payDate, amount, currency, ratio: {num, den}, terms, status, recorded: { caId, status } | null }]` |
| `POST /api/server/corporate-actions/record` body `{ instrumentId, eventId }` | (ledger) | ledger.recordCorporateAction | `{ recorded: bool, duplicate: bool, caId, idempotencyKey }`. The same event (same key) never posts twice. Only cash dividends and splits can be recorded (the ledger's types). |
| `GET /api/server/news/:id` | news | market.news | `items: [{ id, publishedAt, source, headline, summary, scope: 'company'|'sector'|'economy', facts, classification: { by, labels[] }, interpretation: { by, text } | null }]`, paginated |
| `GET /api/server/analytics/:id?strategyId=SP3E&runId=&asOf=` | analytics | analytics.instrumentAnalytics | `data: { strategyId, runId, version, calculatedAt, inputCutoff, horizon, historical: bool, efs, sectorScore, equityScore, fundamentalFairValue, realisticFairValue, fairValueCurrency, fairValueUnits, fundamentalGapPct, realisticGapPct, uncertainty, timingEligibility, outlierFlags[], sizing, hedge }`; fields the server does not supply are null and listed in `missingFields` |
| `GET /api/server/analytics/:id/runs?strategyId=` | analyticsRuns | analytics.runs | `items: [{ runId, version, calculatedAt, inputCutoff, horizon, historical, current }]` |
| `GET /api/server/ratings/:id` | ratingsCovenants | market.ratingsCovenants | `data: { scope: 'issue'|'issuer', ratedEntity: { id, name }, ratings: [{ agency, scale, rating, outlook, watch, action, ratedAt }], covenants: [{ key, label, text, threshold, status, asOf }], covenantsNote }` (p1, bond pages) |
| `GET /api/server/yield-spread/:id` | yieldSpread | market.yieldSpread | `data: { yield: { value, type, convention, units }, spread: { valueBps, type, benchmark: { name, symbol } } | null, priceUsed: { value, units, side, timestamp }, calculatedAt, provider }` (p1; supplied only, never computed) |
| `GET /api/server/option-greeks/:id` | optionGreeks | market.optionGreeks | `data: { impliedVol, delta, gamma, theta, vega, rho, units: { measure: text }, model, underlyingPrice, optionPrice, calculatedAt, provider }` (p1; supplied only) |
| `GET /api/server/futures-curve/:id` | futuresCurve | market.futuresCurve | `items: [{ contractMonth, expiration, symbol, ids, price, priceType, units, currency, timestamp, openInterest, volume }]` (p1; the points supplied, nothing interpolated) |
| `GET /api/server/margin/:id` | exchangeMargin | market.exchangeMargin | `data: { initial, maintenance, currency, perContract, clearingHouse, effectiveDate, notes }` (p1; shown beside the Book's clearing terms) |
| `GET /api/server/fund-holdings/:id` | fundHoldings | market.fundHoldings | `items: [{ name, ids, symbol, assetClass, weightPct, quantity, marketValue, currency, holdingsDate }]`, `data: { holdingsDate, holdingsCount, coveragePct, currency, note }` (p1) |
| `GET /api/server/fund-facts/:id` | fundFacts | market.fundFacts | `data: { nav, navCurrency, navDate, shareClass, fees: { ongoingChargePct, managementFeePct, entryChargePct, exitChargePct, performanceFee, asOf }, distributionPolicy, netAssets }` (p1) |
| `GET /api/server/marks/:id?from&to` | otcMarks | market.otcMarks | `items: [{ date, value, units, kind: 'dealer'|'clearing'|'model', provider, method, timestamp }]` (p1; swaps, CDS, forwards, OTC options) |
| `GET /api/server/fx-curve/:id` | fxCurve | market.fxCurve | `items: [{ tenor, valueDate, forwardPoints, pointsUnits, outright, timestamp }]`, `data: { pair, spotReference, note }` (p1) |
| `GET /api/server/ledger/:id?bookId=` | ledger | ledger.instrument | `data: { holdings: [{ unitId, owner, long, short, net }], orders, fills, recordedCorporateActions, positions: [valued as Accounting, Positions, with relationships / protection / hedgeOf], strategies: [{ id, name, status, owner, legs: [{ instrument, qty, purpose, financing }], hedgeRequests }], allocations (hedge allocations), history (this instrument's accounting events, latest 50), historyMore }` (local paper records, source "Terminal paper ledger") |
| `POST /api/server/cache/invalidate` body `{ dataset?, instrumentId? }` | | | `{ invalidated: n }` |
| `GET /api/server/refresh`, `PUT /api/server/refresh` body `{ dataset: { intervalSec, ttlSec, staleAfterSec, mode: 'interval'|'on-demand' } }` | | | refresh settings per dataset; `subscription` reported as `{ supported: false, note: 'Not supported by the contract' }` until the contract says otherwise |

The Gap % is passed through as the server states it (the header withholds it, with the reason, when the fair value's
currency or units differ from the market price's). The Terminal never computes a fair value, gap, score or signal.

The workspace also reads two Terminal routes that are not server datasets: `GET /api/instruments/:id/detail?bookId=`
(the execution quote context, holdings and positions shown in the header; never asked "as of") and
`GET /api/instruments/:id/contract-facts?bookId=` (section 6).

## 4. Fixture controls (demo mode only; 403 in the normal Terminal)

- `GET /api/demo/fixtures/server` -> `{ source: 'Demo fixture', modes: { dataset: mode }, delays: {...}, datasets: [...] }`
- `POST /api/demo/fixtures/server` body `{ dataset: '<key>'|'all', mode: '<mode>', delayMs? }` or `{ reset: true }`.
  Modes: `available`, `stale`, `unavailable`, `empty`, `error`, `slow`, `partial`, `forbidden`, and the acceptance
  modes `throttled`, `offline`, `revised`, `duplicate`, `currency-mismatch`, `unit-mismatch`. A mode is kept in the
  settings (`demo.serverFixtures`), so it survives a restart until reset.
  - `stale`: `asOf` pushed back past `staleAfterSec`; state `stale`.
  - `unavailable` / `empty`: state `unavailable`, no items.
  - `error`: a server error (HTTP 500 equivalent), retried with backoff, then `error.retryable: true`.
  - `forbidden`: a 403; not retried; `error.retryable: false`; the dataset is blocked for that instrument until the
    fixture is reset or the connection is tested (`POST /api/server/test`). A 401 blocks every dataset of the interface.
  - `slow`: answered after `delayMs` (default 2500 ms), so loading states and superseded selections can be seen.
  - `partial`: some fields or periods missing; state `incomplete` with `missingFields`.
  - `throttled`: HTTP 429 with `Retry-After: 1 s`; retried within the bound (`error.code: 'throttled'`, 3 attempts).
  - `offline`: the gateway cannot be reached (network error, `error.code: 'network'`, retryable). With `dataset:
    'all'` it plays a disconnection of the gateway; `reset` plays the reconnection.
  - `revised`: a later delivery revises what was shown first: statements restate the latest reported period
    (revenue and cost of revenue x 1.02, gross profit recomputed from them, the originals kept with `restatedAt`);
    earnings move the upcoming release date one week later and mark it confirmed and `revised`; corporate actions
    raise the latest completed dividend by 0.05 under the same event ID with `previous` terms and `revision`;
    analytics deliver a newer run (`<runId>-r2`). An `asOf` request before today does not see the revision.
  - `duplicate`: the first record of a list answer delivered twice (same ID).
  - `currency-mismatch` / `unit-mismatch`: analytics with the fair value in EUR (or USD when it was EUR) / per 100
    shares (values x 100); statements: only the TTM answer, in EUR / in thousands (values x 1000, per-share and
    share-count lines unchanged), so it is drawn beside annual figures in the statement's own currency and scale.
- Built-in fixture cases that need no control: pagination (ALFA filings: cursor, 23 items in pages of 10; ALFA news:
  page shape, 25 items; search: page shape, 8 per page), a restatement with the original kept and a YTD cash-flow
  case (ALFA statements; `asOf` before the restatement date returns the as-filed value), annual-only statements
  (BRVO), an upcoming estimated earnings date (ALFA) and a confirmed one (BRVO), one revised earnings quarter, a
  duplicate delivery of one corporate action (ALFA dividend), two SP3E runs for ALFA (one historical), a partial
  analytics record (BRVO), JPY analytics (KAIJ), a coverage gap in KAIJ history, issuer-only profile (SIMGOV31,
  state `incomplete`), a 403 (KAIJ filings), a server error (KAIJ corporate actions, retried then error), a slow
  response (BRVO news, 1.5 s), an empty list (KAIJ news), a PDF document (ALFA's second filing,
  `fixture-doc-alfa-1-pdf`, a one-page PDF served `application/pdf`), and options/futures answering issuer datasets
  with `unavailable` plus `related.underlying`.
- Product-page fixtures (p1, built in): ratings with one agency on review and three covenants (SIMCORP29), issuer
  ratings and no covenants (SIMGOV31); yield and spread (SIMCORP29; SIMGOV31 has a yield and a null spread with its
  reason); illustrative Greeks for any demo option (the same values for every call or put, said so; rho not
  supplied); the futures curve of the registered months from the demo feed and exchange margin for the S5 and SKJ
  roots; top-10 holdings and fees for any fund (NAV from the demo feed); dealer, clearing and model marks for any
  swap, CDS, forward or OTC option; forward points for EUR/USD and USD/JPY. Every mode control applies to them.
- Point-in-time in the fixtures: supported for statements, earnings, filings, news, analytics, runs, ratings, fund
  holdings and OTC marks; quotes,
  profile and the rest answer "Not supported by the contract" for an `asOf` request.
- Quotes, history, FX and rates in demo come from the simulated demo feed (`source.label: 'Simulated demo feed'`),
  so the header and the ticket see the same price. History is unadjusted; `adjusted=1` is `unavailable` (no
  adjusted series is manufactured); intervals other than `1d` are `unavailable`.
- The fixture Strategy is `fixture-strat-sp3e` ("SP3E (demo fixture)"); another `strategyId` gives `unavailable`.

Every fixture value carries `source.label: 'Demo fixture'` (or `'Test fixture'` when set by a test) and `fixture: true`.

## 5. Client methods and data requirements

Server side, every route calls `app.data.server.<interface>.<method>(params, opts)` (or `app.data.server.call(dataset,
params, opts)`), which resolves to the envelope. `opts`: `{ requestId, selection, channel, asOf, fresh, signal, cursor,
page, pageSize, waitMs }`. Other members: `collect()` (all pages), `invalidate({ dataset, instrumentId })`,
`subscribe()` (no-op until the contract supports push), `watch()` / `tick()` (interval refresh), `state()`,
`refreshSettings()` / `saveRefresh()`, `clearAuthBlocks()`, `document(docId)`.

| Interface | Method | Dataset | Default TTL / stale after (s) | Pagination | Point-in-time |
|---|---|---|---|---|---|
| market | search | search | 300 / 86400 | cursor or page | no |
| market | reference | reference | 3600 / 604800 | none | optional |
| market | quotes | quotes | 5 / 60 (interval 5 s) | none | no |
| market | history | history | 900 / 172800 | cursor or page | dated |
| market | fx | fx | 15 / 120 (interval 15 s) | none | optional |
| market | rates | rates | 900 / 172800 | none | dated |
| market | profile | profile | 3600 / 604800 | none | needed |
| market | statements | statements | 3600 / 2592000 | page by periods | needed |
| market | earnings | earnings | 1800 / 86400 | cursor or page | optional |
| market | filings | filings | 1800 / 604800 | cursor or page | by filedAt |
| market | document | documents | none (streamed) | none | n/a |
| market | corporateActions | corporateActions | 3600 / 172800 | cursor or page | optional |
| market | news | news | 120 / 3600 (interval 120 s) | cursor or page | by publishedAt |
| market | ratingsCovenants | ratingsCovenants | 3600 / 604800 | none | optional |
| market | yieldSpread | yieldSpread | 300 / 86400 | none | optional |
| market | optionGreeks | optionGreeks | 60 / 3600 | none | optional |
| market | futuresCurve | futuresCurve | 60 / 86400 | none | optional |
| market | exchangeMargin | exchangeMargin | 3600 / 604800 | none | optional |
| market | fundHoldings | fundHoldings | 3600 / 10368000 | page when long | optional |
| market | fundFacts | fundFacts | 900 / 345600 | none | optional |
| market | otcMarks | otcMarks | 900 / 259200 | cursor or page | marks up to asOf |
| market | fxCurve | fxCurve | 60 / 86400 | none | optional |
| analytics | instrumentAnalytics | analytics | 300 / 259200 | none | historical runs |
| analytics | runs | analyticsRuns | 300 / 259200 | cursor or page | runs at or before asOf |
| analytics | earningsWindow | earningsWindow | 900 / 259200 | none | optional |
| ledger | instrument | ledger | none (always fresh) | none | n/a |

Inputs, the fields the Terminal needs back (`requires`), optional fields, units, timestamps and errors per dataset
are in `server/data/ports.js` (`SERVER_DATASETS`) and in prose in `docs/DATA-CONTRACT-REQUIREMENTS.md`. All settings
above are changeable with `PUT /api/server/refresh`.

Retries honour a gateway `Retry-After` header (seconds or an HTTP date) within `server.retry.maxDelayMs`.

On the screens (`web/views/workspace.js`): every panel request carries `requestId` and `selection`; a panel in a
retryable error, or showing a cached copy after a failed refresh, asks again with `fresh=1` every 5 s
(`RECOVER_MS`), so every panel recovers on its own after a reconnection; 401/403 are never asked again from there.
The header's Gap % is shown only when the fair value is in the market price's currency and quotation units; a
supplied gap whose fair value is in another currency or unit is withheld with the reason (`gapOf()`,
`workspace-model.js`).

## 6. Contract facts of the product pages (the Terminal's own, not a server dataset)

`GET /api/instruments/:id/contract-facts?bookId=` (p1, `server/product-facts.js`) returns what the Terminal knows from
the contract terms and its paper engine: `accrued` (bond: accrued interest per 100 face to today, the paper engine's
figure, null with a reason when a floating coupon has no fixing), `coupons` (the coupon dates still to come with
payment dates on the payment calendar, the amount per 100 face only where the contract fixes it, redemption, call
and put schedules as registered), `legs` (swap: each leg's periods still to come and its next payment), `premium`
(credit default swap: premium periods), and `scheduled` (the lifecycle work the paper engine has scheduled on this
instrument in this Book, with its status). Contract arithmetic only; no yield, spread, Greek, curve or mark.

## 7. Ledger and corporate actions

- `GET /api/server/ledger/:id?bookId=` reads the Book's own records (holdings by Account with long and short apart,
  orders, fills, recorded corporate actions). Source `Terminal paper ledger`. Never remote.
- `GET /api/server/corporate-actions/:id` lists each server event once (`deliveries` counts repeats), with
  `idempotencyKey` (`srv:<eventId>`, or a hash of the terms when the server gives no event ID), `recordable` (cash
  dividends and splits only) and `recorded` (`{ caId, status, at }` once the user has recorded it).
- `POST /api/server/corporate-actions/record { instrumentId, eventId }` records it in the paper ledger once; a
  second call answers `{ duplicate: true, caId }` and posts nothing. Receiving or refreshing events never posts.
  A revision delivered after recording is shown beside the record ("The ledger recorded ...; the server now states
  ...") and changes nothing in the ledger; the link survives a restart (setting `server.ca:<key>`).

## 8. Trading from the workspace

The workspace's Trade action opens the existing ticket with the instrument, the Book, the trading owner in use and
the Strategy chosen in the header. A package placed from the full detail page records `origin: 'instrument-detail'`
(the drawer opened elsewhere records `marketplace`); both open the Hedge workflow after the actual fill
(`core/hedge.js`, `onStrategyChange`). The Strategies page (origin `strategy`) includes the hedge legs in its
package preview instead. Nothing executes without the preview's explicit confirmation.

## 9. Tests of this layer

`test/core/server-client.test.js` (transport, envelope, retries, cache, pagination, fixtures, ledger hash),
`test/core/server-integration.test.js` (the owner's failure-mode list on every remote dataset, the paper-ledger
regression and persistence across a restart), `test/core/product-datasets.test.js`, and the browser checks
`test/workspace/checks/*.mjs` run by `npm run test:workspace` (`i1-failure-modes.mjs` drives the same list on the
screens).
