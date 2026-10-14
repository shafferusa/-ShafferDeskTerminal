# Data contract requirements (for the Shaffer backend builder)

What the Shaffer server must supply before the Terminal can leave fixture mode. The Terminal has not invented any
URL, path, authentication scheme or payload schema: each item below is a question the contract must answer, and the
Terminal's side is ready to receive the answer in one place (`server/data/shaffer-contract.js`, `serverOperations`).
The fields the Terminal needs back per dataset are also machine-readable in `server/data/ports.js` (`SERVER_DATASETS`)
and are exercised by the demo fixtures (`server/data/server-fixtures.js`), which show one possible shape and nothing
more.

## 1. Across all datasets (the owner's list, section 2)

| Requirement | What the contract must state | Where the Terminal uses it |
|---|---|---|
| Authentication and server addresses | The gateway address (or one address per service); the credential type (header name and token format, mutual TLS, or other); token lifetime and rotation; whether one credential covers MarketData and Analytics Lab. | `SHAFFER_GATEWAY_URL` (or `SHAFFER_MARKETDATA_URL` / `SHAFFER_ANALYTICS_URL`), `SHAFFER_API_TOKEN`, `SHAFFER_AUTH_HEADER`. Credentials stay on the Terminal server. |
| Stable IDs | The instrument ID scheme; issuer IDs; contract IDs for listed derivatives (option series, futures months); Strategy IDs (SP3E first); how an ID is retired or merged; whether IDs are reused. A lookup from symbol + venue to ID. | Stored on each registry instrument as `external_ids.shaffer`; the reference route returns `ids: { terminal, server, issuer, contract }`. |
| Request parameters, response schemas | For each dataset below: the request (path, method, query/body names), the response schema with field names, types and nullability, and an example payload. | One function per dataset in `serverOperations`. |
| Pagination | Cursor (`nextCursor`) or page (`page`, `totalPages`), the maximum page size, ordering, and whether a cursor survives new data arriving. | One iterator handles both (`paginate()`); `all=1` collects with a bound. |
| Error states | HTTP statuses used and their meaning; an error body schema with a machine code; which errors are retryable; rate limits and `Retry-After`. 401 vs 403 semantics (credential refused vs not permitted for this subject). | 401/403 are never retried; 408/425/429/5xx and network errors are retried with backoff (bounded). |
| Quote types, units, currencies, timestamps, freshness | Quote types supplied (last, bid/ask, mid, settlement, NAV, yield, indicative); price units per instrument type (per share, % of par clean/dirty, index points, quote currency per base); currency; timestamp meaning (exchange time vs publish time) and time zone; live / delayed (minutes) / indicative / end-of-day status; the age after which data must be shown as stale. | Envelope `freshness.staleAfterSec` (configurable per dataset); quote `status` and `timestamp`. |
| Historical ranges, availability, adjustments | Earliest date per dataset and instrument type; intervals supported; adjusted vs unadjusted series and the adjustment method (splits only, splits and dividends); how gaps are signalled. | History `data.adjusted`, `adjustmentBasis`, `coverage.missing`; no missing bar is ever manufactured. |
| Refresh or subscription mechanisms | Polling limits per dataset; any push mechanism (SSE, WebSocket, webhook) with its message schema; snapshot-then-delta rules. | Refresh interval per dataset (`PUT /api/server/refresh`); `serverCapabilities.subscriptions` (the hook is a no-op until filled). |
| API and schema versions, coverage limits | Version identifiers (API, schema, model); deprecation policy; coverage per dataset (markets, instrument types, issuers) and known limitations. | Envelope `version`, `schema`, `coverage`; the per-dataset state route. |
| Point-in-time | Per dataset: whether an `asOf` request returns what was known at that time (as filed, before revisions), and the parameter name. | `serverCapabilities.pointInTime`; otherwise the envelope says "Not supported by the contract" and no current data is substituted. |

## 2. Per dataset

Required fields must be present (or explicitly null with a reason); the Terminal names any missing required field
in `missingFields` and shows the record as incomplete. Optional fields are shown when supplied.

### Market interface (Shaffer MarketData)

**Reference search** (`market.search`). Input: free text (symbol, name, ID), limit, optional market filter.
Needs per hit: server instrument ID, symbol, name, product type, currency; optional issuer ID, contract ID, venue,
issuer name. Paginated.

**Instrument reference** (`market.reference`). Input: server instrument ID. Needs: IDs (instrument, issuer, contract),
symbol, name, product type, venue, trading currency, quote convention and units, multiplier; underlying IDs for
derivatives; listing details for listed securities; product terms (bond coupon/maturity/day count, option
strike/expiry/exercise/settlement, futures month/tick/settlement); last update time.

**Current quotes** (`market.quotes`). Input: a batch of instrument IDs (maximum batch size to be stated). Needs:
quote type, bid/ask (with sizes) or last, currency, units, quote timestamp, status (real-time / delayed with minutes
/ indicative / end-of-day). Optional: previous close, change and change % (if the server supplies them the Terminal
shows them; otherwise it leaves them missing).

**Price history** (`market.history`). Input: instrument, from, to, interval, adjusted flag. Needs: bar time and
business date, close, adjusted flag of the series, currency, interval; optional open, high, low, volume,
corporate-action annotations (date, type, amount or ratio), the adjustment basis. Gaps reported in coverage.

**FX** (`market.fx`). Input: pairs. Needs: rate as quote currency per 1 base, direction, timestamp, status;
optional bid/ask. Calendars and forward curves when FX detail pages need them (to be stated).

**Rates** (`market.rates`). Input: codes, from, to. Needs: code, fixing date, value in percent per annum; optional
tenor and curve membership.

**Company and issuer profile** (`market.profile`). Input: instrument (or issuer ID). Needs: issuer ID and name,
listing exchange and currency; optional description, sector and industry classifications (scheme named), country,
employees, market capitalisation (with its date and basis), shares outstanding (with its date), float, financial
highlights, next earnings date with confirmed/estimated status. Issuer facts and listing facts must be separable.

**Financial statements** (`market.statements`). Input: issuer or instrument, statement (income, balance sheet,
cash flow), period (quarterly, annual, TTM), number of periods, optional as-of date. Needs per period: key, fiscal
year and period, period type (quarter, year-to-date, annual, TTM, or instant for the balance sheet), start and end
dates, filing/publication date, source, basis (reported, normalized, restated, derived) and, for a restated period,
the originally reported values and the restatement date. Needs per line: key, label, hierarchy level, value per
period (null with a reason when not reported), units (statement currency and scale; per-share lines in currency per
share). Every available line item, not only summary ratios. Server-supplied growth, margins, ratios and normalized
metrics, when supplied, are shown as such. Point-in-time: as-filed values at a date versus current restated values.

**Earnings** (`market.earnings`). Input: issuer or instrument, date range. Needs per event: fiscal period, scheduled
release date-time, confirmed/estimated status, actual reporting time, metrics (key, label, reported value, units;
optional consensus, prior, surprise, surprise %), revision status with revision time, linked documents (IDs, title,
kind). Upcoming events with null reported values.

**Filings and reports** (`market.filings`). Input: issuer or instrument, optional kind, optional as-of. Needs: filing
ID, kind, title, filed time, source, document IDs; optional period, media type, page count. Paginated.

**Documents** (`market.document`). Input: document ID. Needs: the bytes streamed by the gateway with a media type
(PDF, HTML or plain text are displayed; others are refused); optional filename and length. The Terminal never
fetches a document from anywhere but the gateway.

**Corporate actions** (`market.corporateActions`). Input: instrument, date range. Needs: a stable event ID (used as
the idempotency key; required, because a hash of terms cannot tell a revision from a new event), type, ex-date,
status; optional record date, pay date, amount and currency, ratio, terms text, announcement time, revision of an
earlier event. Types: dividends, splits, buybacks, rights, mergers, spin-offs and others (the paper ledger records
cash dividends and splits; the rest are informational).

**News and events** (`market.news`). Input: instrument (company, its sector, relevant economy), from, optional as-of.
Needs: item ID, publication time, source, headline, scope (company, sector, economy); optional summary, facts,
classification (who classified, labels), interpretation (who interpreted, text), link. Facts, classifications and
interpretations must be separable. Paginated.

### Analytics interface (Shaffer Analytics Lab)

**Instrument analytics** (`analytics.instrumentAnalytics`), SP3E first. Input: instrument, Strategy ID, optional run ID,
optional as-of. Needs: Strategy ID, run ID, model version, calculation time, input-data cutoff, horizon, fair value
currency and units (must match the quote units of the instrument); optional EFS, Sector Score, Equity Score,
Fundamental and Realistic Fair Value with their Gap % (and the reference price the Gap was measured against),
uncertainty, timing eligibility, outlier flags, sizing, hedge outputs, availability. A field not produced is null
with a reason. Whether a run is current or historical must be stated, so a historical output is never shown as a
current recommendation.

**Analytics runs** (`analytics.runs`). Input: instrument, Strategy ID, optional as-of. Needs per run: run ID, version,
calculation time, input cutoff, horizon, whether it is the current run.

**Earnings-window eligibility** (`analytics.earningsWindow`). Input: instrument, Strategy ID. Needs: eligible
(true/false/null), run ID, calculation time; optional window dates and reason. Kept apart from the earnings calendar.

**Strategies and Hedge** already have their contract slots (`analyticsContract.strategies`, `analyticsContract.hedge`,
request built by `core/hedge.js`, shapes in `ports.js`). They are unchanged by this round.

### Ledger interface

Local only. Nothing is required from the backend.

## 3. Exact remaining backend dependencies

1. Gateway address(es) and the credential scheme; whether MarketData and Analytics Lab share them.
2. The instrument, issuer, contract and Strategy ID schemes, and a symbol/venue to ID lookup.
3. For each of the 16 remote datasets above: request, response schema, example payloads, error codes.
4. Pagination style and limits per paginated dataset (search, history if long, earnings, filings, corporate actions,
   news, runs).
5. Quote types, units and timestamp semantics per product type; staleness limits per dataset.
6. History coverage and adjustment conventions.
7. Point-in-time support per dataset (statements, profile, earnings consensus, filings, news, analytics).
8. Refresh limits and any push mechanism.
9. API, schema and model version identifiers; coverage limitations.
10. Corporate-action event IDs and revision semantics.
11. A test environment (address and credential) with known data, for the integration checklist.
