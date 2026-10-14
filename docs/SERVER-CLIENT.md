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
  error: { code, message, retryable, status?, attempts? } | null,
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
| `GET /api/server/state` | (all) | | per-dataset connection state: `{ mode, gateway, credentialsConfigured, datasets: { key: { interface, operation, mapped, state, lastSuccess, lastError, authBlocked, refresh, pointInTime, fixture } } }` |
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
  - `forbidden`: a 403; not retried; `error.retryable: false`; the dataset is blocked until the fixture is reset.
  - `slow`: answered after `delayMs` (default 2500 ms), so loading states and superseded selections can be seen.
  - `partial`: some fields or periods missing; state `incomplete` with `missingFields`.
- Built-in fixture cases that need no control: a pagination case (news and filings for ALFA span several pages), a
  restatement and a YTD cash-flow case (ALFA statements), an upcoming estimated earnings date, a duplicate delivery
  of one corporate action (ALFA dividend), two SP3E runs for ALFA (one historical), a partial analytics record
  (BRVO), an empty profile (SIMGOV31 has issuer data only).

Every fixture value carries `source.label: 'Demo fixture'` (or `'Test fixture'` when set by a test) and `fixture: true`.

## 5. Client methods and data requirements

See section 3 for routes; the method list with inputs, required fields, units, timestamps, freshness, pagination and
errors per dataset is in `server/data/ports.js` (SERVER CLIENT section) and in `docs/DATA-CONTRACT-REQUIREMENTS.md`.
