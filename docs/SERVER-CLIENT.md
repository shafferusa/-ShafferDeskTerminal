# Server client: routes, response envelope, client methods and data requirements

Owner: d1 (server integration layer). Consumers: the instrument-detail workspace (w1) and every screen that shows
Shaffer data. This file is the commitment: routes and fields listed here are what the server returns. It is kept
true as the code changes; anything marked *planned* is not built yet.

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
  the values themselves are `null` with a reason in `nulls: { field: reason }` where the dataset gives one.
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
| `fresh=1` | bypass the cache for this request (on-demand refresh). |
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
| `GET /api/server/ledger/:id?bookId=` | ledger | ledger.instrument | `data: { holdings: [{ unitId, owner, long, short, net }], orders, fills, recordedCorporateActions }` (local paper records, source "Terminal paper ledger") |
| `POST /api/server/cache/invalidate` body `{ dataset?, instrumentId? }` | | | `{ invalidated: n }` |
| `GET /api/server/refresh`, `PUT /api/server/refresh` body `{ dataset: { intervalSec, ttlSec, staleAfterSec, mode: 'interval'|'on-demand' } }` | | | refresh settings per dataset; `subscription` reported as `{ supported: false, note: 'Not supported by the contract' }` until the contract says otherwise |

The Gap % is passed through as the server states it. The Terminal never computes a fair value, gap, score or signal.

## 4. Fixture controls (demo mode only; 403 in the normal Terminal)

- `GET /api/demo/fixtures/server` -> `{ source: 'Demo fixture', modes: { dataset: mode }, delays: {...}, datasets: [...] }`
- `POST /api/demo/fixtures/server` body `{ dataset: '<key>'|'all', mode: 'available'|'stale'|'unavailable'|'error'|'slow'|'empty'|'partial'|'forbidden', delayMs? }` or `{ reset: true }`.
  - `stale`: `asOf` pushed back past `staleAfterSec`; state `stale`.
  - `unavailable` / `empty`: state `unavailable`, no items.
  - `error`: a server error (HTTP 500 equivalent), retried with backoff, then `error.retryable: true`.
  - `forbidden`: a 403; not retried; `error.retryable: false`; the dataset is blocked for that instrument until the
    fixture is reset or the connection is tested (`POST /api/server/test`). A 401 blocks every dataset of the interface.
  - `slow`: answered after `delayMs` (default 2500 ms), so loading states and superseded selections can be seen.
  - `partial`: some fields or periods missing; state `incomplete` with `missingFields`.
- Built-in fixture cases that need no control: pagination (ALFA filings: cursor, 23 items in pages of 10; ALFA news:
  page shape, 25 items; search: page shape, 8 per page), a restatement with the original kept and a YTD cash-flow
  case (ALFA statements; `asOf` before the restatement date returns the as-filed value), annual-only statements
  (BRVO), an upcoming estimated earnings date (ALFA) and a confirmed one (BRVO), one revised earnings quarter, a
  duplicate delivery of one corporate action (ALFA dividend), two SP3E runs for ALFA (one historical), a partial
  analytics record (BRVO), JPY analytics (KAIJ), a coverage gap in KAIJ history, issuer-only profile (SIMGOV31,
  state `incomplete`), a 403 (KAIJ filings), a server error (KAIJ corporate actions, retried then error), a slow
  response (BRVO news, 1.5 s), an empty list (KAIJ news), and options/futures answering issuer datasets with
  `unavailable` plus `related.underlying`.
- Point-in-time in the fixtures: supported for statements, earnings, filings, news, analytics and runs; quotes,
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
| analytics | instrumentAnalytics | analytics | 300 / 259200 | none | historical runs |
| analytics | runs | analyticsRuns | 300 / 259200 | cursor or page | runs at or before asOf |
| analytics | earningsWindow | earningsWindow | 900 / 259200 | none | optional |
| ledger | instrument | ledger | none (always fresh) | none | n/a |

Inputs, the fields the Terminal needs back (`requires`), optional fields, units, timestamps and errors per dataset
are in `server/data/ports.js` (`SERVER_DATASETS`) and in prose in `docs/DATA-CONTRACT-REQUIREMENTS.md`. All settings
above are changeable with `PUT /api/server/refresh`.

## 6. Ledger and corporate actions

- `GET /api/server/ledger/:id?bookId=` reads the Book's own records (holdings by Account with long and short apart,
  orders, fills, recorded corporate actions). Source `Terminal paper ledger`. Never remote.
- `GET /api/server/corporate-actions/:id` lists each server event once (`deliveries` counts repeats), with
  `idempotencyKey` (`srv:<eventId>`, or a hash of the terms when the server gives no event ID), `recordable` (cash
  dividends and splits only) and `recorded` (`{ caId, status, at }` once the user has recorded it).
- `POST /api/server/corporate-actions/record { instrumentId, eventId }` records it in the paper ledger once; a
  second call answers `{ duplicate: true, caId }` and posts nothing. Receiving or refreshing events never posts.
