# Data contract requirements (for the Shaffer backend builder)

What the Shaffer server must supply before the Terminal can leave fixture mode. The Terminal has not invented any
URL, path, authentication scheme or payload schema: each item below is a question the contract must answer, and the
Terminal's side is ready to receive the answer in one place (`server/data/shaffer-contract.js`, `serverOperations`).
The fields the Terminal needs back per dataset are also machine-readable in `server/data/ports.js` (`SERVER_DATASETS`)
and are exercised by the demo fixtures (`server/data/server-fixtures.js`), which show one possible shape and nothing
more.

## 0. Answer sheet (one line per requirement; the backend builder fills the last column)

Every line is one question. "Terminal side" says where the answer lands, so a line can be closed by writing the
answer and, where it applies, the function in `serverOperations`. The demo fixtures show one possible shape per
dataset and are not a proposal. 25 remote datasets (16 market and analytics datasets of the first wave, documents
included, and 9 product-specific datasets) plus the ledger interface, which is local and needs nothing.

| # | Area | Question for the backend builder | Terminal side (where the answer goes) | Answer |
|---|---|---|---|---|
| G1 | Addresses | One gateway address, or one per service (MarketData, Analytics Lab)? Test and production addresses? | `SHAFFER_GATEWAY_URL` or `SHAFFER_MARKETDATA_URL` / `SHAFFER_ANALYTICS_URL`; Data connection page | |
| G2 | Authentication | Credential type (header name and token format, mutual TLS, other), lifetime, rotation; one credential for both services? 401 vs 403 meaning? | `SHAFFER_API_TOKEN`, `SHAFFER_AUTH_HEADER` (server side only); 401 blocks the interface, 403 the dataset for that subject | |
| G3 | Instrument IDs | The instrument ID scheme; are IDs ever reused, retired or merged; a lookup from symbol + venue to ID? | `external_ids.shaffer` on each registry instrument; reference `ids.server` | |
| G4 | Issuer and contract IDs | Issuer IDs; contract IDs for option series and futures months; how a derivative names its underlying | reference `ids.issuer`, `ids.contract`, `underlying.ids` | |
| G5 | Strategy IDs | Strategy ID scheme (SP3E first), names, versions; how a Strategy is retired | header Strategy chooser (by ID), `analytics?strategyId=` | |
| G6 | Request and response | For each dataset D1 to D25 (and the D26 slots): method, path, parameter names, response schema with types and nullability, one example payload | one function per dataset in `serverOperations` (`server/data/shaffer-contract.js`) | |
| G7 | Pagination | Cursor or page per paginated dataset (D1, D4, D9, D10, D12, D13, D20, D22, D24, and D8 by periods); maximum page size; ordering; does a cursor survive new data? | `paginate()` / `collect()`, `all=1` (bounded at 20 pages) | |
| G8 | Errors | Status codes and an error body with a machine code; which are retryable; rate limits; is `Retry-After` sent (seconds or date)? | 408/425/429/5xx and network errors retried (2 retries, backoff 250 ms doubling, at most 4 s, `Retry-After` honoured within that); 401/403 never retried | |
| G9 | Freshness | Per dataset: the age after which data must be shown as stale; timestamp meaning (exchange time or publish time) and time zone | `freshness.staleAfterSec` per dataset (`PUT /api/server/refresh`) | |
| G10 | Refresh and push | Polling limits per dataset; any push mechanism (SSE, WebSocket, webhook) with its message schema and snapshot-then-delta rules | refresh interval per dataset; `serverCapabilities.subscriptions` (no-op until filled) | |
| G11 | Versions and coverage | API, schema and model version identifiers in each response; deprecation policy; coverage per dataset (markets, product types, issuers) and known limits | envelope `version`, `schema`, `coverage`; `serverCapabilities.versions` | |
| G12 | Point in time | Per dataset: does an `asOf` request return what was known then (as filed, before revisions)? Parameter name? | `serverCapabilities.pointInTime[dataset]`; otherwise "Not supported by the contract" and nothing substituted | |
| G13 | Duplicates and revisions | Is a record delivered twice ever possible (same ID)? How is a revision signalled (same ID with `revision`/`revisedAt`, or a new ID with `supersedes`)? | repeats dropped by ID and reported in `duplicates`; revisions shown beside the original | |
| G14 | Test environment | An address and a credential with known data for the phase-6 procedure (INTEGRATION-CHECKLIST.md, section E) | the normal Terminal with that environment | |
| D1 | Reference search (`market.search`) | Parameters (text, limit, market filter); per hit: server ID, symbol, name, product type, currency; optional issuer and contract IDs, venue, issuer name | registry search, page search | |
| D2 | Instrument reference (`market.reference`) | IDs, symbol, name, product type, venue, trading currency, quote convention and units, multiplier, underlying, listing details, product terms, last update | header identity line (server ID), Overview | |
| D3 | Current quotes (`market.quotes`) | Maximum batch size; quote type; bid/ask with sizes or last; currency; units; timestamp; status (real-time / delayed with minutes / indicative / end of day); optional previous close and change | header market price and bid/ask; the ticket's price | |
| D4 | Price history (`market.history`) | Range and interval parameters; bar fields (time, business date, OHLC, volume); adjusted flag and method; earliest date; how gaps are signalled; annotations | Price history tab (chart, table, gaps, annotations) | |
| D5 | FX (`market.fx`) | Rate as quote currency per 1 base; direction; timestamp; status; optional bid/ask | FX pages, Rates tab | |
| D6 | Rates (`market.rates`) | Codes; fixing date; value in percent per annum; optional tenor and curve membership | Rates tab | |
| D7 | Company and issuer profile (`market.profile`) | Issuer ID and name, listing exchange and currency (required); description, sector and industry with the scheme named, country, employees, market capitalisation with date and basis, shares outstanding with date, float, highlights, next earnings date with confirmed/estimated; issuer and listing facts separable | Overview tab (issuer apart from listing) |  |
| D8 | Financial statements (`market.statements`) | Statement, period (quarterly, annual, TTM) and count parameters; per period: key, fiscal year and period, period type (quarter, YTD, annual, TTM, instant), dates, filing date, source, basis, original values of a restated period with the restatement date; per line: key, label, level, value per period (null with reason), units and scale; supplied ratios and growth | Financial statements tab | |
| D9 | Earnings (`market.earnings`) | Per event: fiscal period, release date-time, confirmed or estimated, reporting time, metrics (reported, consensus, prior, surprise, units), revision status and time, documents | Earnings tab | |
| D10 | Filings (`market.filings`) | Filters; per filing: ID, kind, title, filed time, source, documents (ID, media type, pages) | Filings and reports tab | |
| D11 | Documents (`market.document`) | Bytes streamed with a media type (PDF, HTML, plain text); filename; length; may a document be fetched only through the gateway? | `/api/server/documents/:docId` proxy, sandboxed frame and new tab | |
| D12 | Corporate actions (`market.corporateActions`) | A stable event ID (the idempotency key); type, ex-date, status; record and pay dates, amount and currency, ratio, terms, announcement time; revision of an earlier event | Corporate actions tab; Record in the paper ledger (once per event ID) | |
| D13 | News and events (`market.news`) | Per item: ID, publication time, source, headline, scope (company, sector, economy); facts, classification (by whom), interpretation (by whom), link | News and events tab | |
| D14 | Ratings and covenants (`market.ratingsCovenants`) | Scope (issue or issuer), ratings (agency, scale, rating, outlook, watch, action, date), covenants (label, text, threshold, status, as of) | bond Ratings and covenants tab | |
| D15 | Yield and spread (`market.yieldSpread`) | Yield (value, type, compounding), price used (value, units, side, time), calculation time, provider; spread (bps, type, benchmark) or null with reason | bond Overview and terms | |
| D16 | Option Greeks (`market.optionGreeks`) | Implied volatility, delta (required); gamma, theta, vega, rho with units per measure; model; prices used; time; provider | option Greeks and volatility tab | |
| D17 | Futures curve (`market.futuresCurve`) | Per month: contract month, expiration, price, price type, time; optional IDs, open interest, volume | future Curve tab (points only, nothing interpolated) | |
| D18 | Exchange margin (`market.exchangeMargin`) | Initial margin per contract, currency, effective date, clearing house; optional maintenance and notes | future Contract terms and margin (beside the Book's clearing terms) | |
| D19 | Fund facts (`market.fundFacts`) | NAV, NAV currency and date; share class, fees with document date, distribution policy, net assets | fund Overview, NAV and fees | |
| D20 | Fund holdings (`market.fundHoldings`) | Per holding: name, weight in percent of net assets, holdings date; optional IDs, asset class, quantity, value | fund Holdings tab | |
| D21 | FX forward curve (`market.fxCurve`) | Per tenor: tenor, forward points, points units, time; optional value date, outright, spot reference | FX Rates and curves | |
| D22 | OTC marks (`market.otcMarks`) | Per mark: date, value, units (NPV per 100 notional unless stated), kind (dealer, clearing, model), provider, time; method | swap / CDS / forward / OTC option Marks and history | |
| D23 | Instrument analytics (`analytics.instrumentAnalytics`) | Strategy ID, run ID, model version, calculation time, input cutoff, horizon, fair value currency and units (must equal the quote's), EFS, scores, Fundamental and Realistic Fair Value and Gap % with the reference price, uncertainty, timing, outlier flags, sizing, hedge outputs; current or historical | header Fair price and Gap %; Analytics and risk tab | |
| D24 | Analytics runs (`analytics.runs`) | Per run: run ID, version, calculation time, input cutoff, horizon, current or historical | Analytics and risk tab (Runs) | |
| D25 | Earnings-window eligibility (`analytics.earningsWindow`) | Eligible (true/false/null), window, reason, run ID, calculation time | Earnings tab (eligibility panel, apart from calendar facts) | |
| D26 | Strategies and Hedge (`analyticsContract.strategies`, `analyticsContract.hedge`) | The Strategy list; the hedge request and response schemas (`core/hedge.js` builds the request; shapes in `ports.js`) | Strategy chooser; Strategies page; hedge popup and package preview | |
| L1 | Ledger interface | Nothing: holdings, orders, fills, packages, hedges, financing and recorded corporate actions are the Terminal's own records | `/api/server/ledger/:id` | not needed |

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
optional bid/ask. Forward curves: `market.fxCurve` below. Calendars are the Terminal's own (holiday calendars per
currency, Settings).

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

### Product-specific datasets (Shaffer MarketData; detail pages of non-equity products)

These are shown only when supplied. The Terminal computes none of them: no yield, spread, Greek, implied volatility,
curve or mark is worked out in the Terminal. Contract terms, coupon and payment schedules and the paper engine's
accrued interest are the Terminal's own (`GET /api/instruments/:id/contract-facts`) and need nothing from the backend.
The contract may map any of these to MarketData or to Analytics Lab; each record names its `provider`.

**Ratings and covenants** (`market.ratingsCovenants`). Input: debt instrument (or its issuer), optional as-of.
Needs: `scope` (`issue` or `issuer`: the screen says which), `ratings` (list: agency, scale named, rating, date of
the last action; optional outlook, watch, action) and `covenants` (list, empty when none: label, text; optional
threshold, status as reported, as-of). Point-in-time: ratings in force on a date, if supported.

**Yield and spread** (`market.yieldSpread`). Input: debt instrument. Needs: `yield` (value in percent, type: to
maturity or to worst, compounding convention), `priceUsed` (the price it was struck on, units, side, timestamp),
`calculatedAt`, `provider`; optional `spread` (basis points, type such as G-spread, Z-spread or OAS, the benchmark
named with its ID). A spread that does not apply (a benchmark issue) is null with a reason.

**Option Greeks and implied volatility** (`market.optionGreeks`). Input: option contract. Needs: `impliedVol`
(decimal per annum), `delta`, `calculatedAt`, `provider`; optional gamma, theta, vega, rho, `model`, the underlying
and option prices used, and `units` per measure (theta per calendar day or per trading day, vega per volatility
point, and so on: the screen prints what the provider states).

**Futures curve** (`market.futuresCurve`). Input: futures contract (its root or underlying selects the curve).
Needs per month: contract month, expiration, price, price type (settlement or last), timestamp; optional contract
IDs, symbol, open interest, volume, units, currency. The Terminal draws the points supplied and interpolates nothing.

**Exchange margin** (`market.exchangeMargin`). Input: futures contract. Needs: initial margin per contract,
currency, effective date, clearing house; optional maintenance margin and notes (rate class). Shown beside, never in
place of, the margin the paper engine posts (the Book's clearing terms registered on the contract).

**Fund holdings and weights** (`market.fundHoldings`). Input: fund share class, optional as-of. Needs per holding:
name and weight in percent of net assets, and the holdings report date; optional holding IDs (so a holding can be
linked to its own workspace), asset class, quantity, market value, currency, and for the list the number of holdings
and the share of net assets listed. Paginated when long.

**Fund NAV, fees and facts** (`market.fundFacts`). Input: fund share class. Needs: NAV, NAV currency, NAV date;
optional share class, fees (ongoing charge, management fee, entry and exit charges, performance fee, the date of the
fee document), distribution policy, net assets. Distributions themselves are corporate actions; fund reports are
filings and documents.

**Supplied marks for OTC contracts** (`market.otcMarks`). Input: OTC contract (swap, credit default swap, forward,
OTC option), date range, optional as-of. Needs per mark: mark date, value, units (net present value per 100
notional unless stated), kind (dealer, clearing or model), provider, timestamp; optional method and note. A model
mark from Analytics Lab is a valuation and is never shown as a quote. Manual marks are the Terminal's own records.

**FX forward curve** (`market.fxCurve`). Input: currency pair. Needs per tenor: tenor, forward points, points units,
timestamp; optional value date, outright rate, the spot reference the curve was struck on.

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
3. For each of the 25 remote datasets above (16 of the first wave, documents included, and the 9 product-specific
   datasets), and for the Strategy list and Hedge slots: request, response schema, example payloads, error codes
   (answer sheet lines D1 to D26).
4. Pagination style and limits per paginated dataset (search, history if long, earnings, filings, corporate actions,
   news, runs).
5. Quote types, units and timestamp semantics per product type; staleness limits per dataset.
6. History coverage and adjustment conventions.
7. Point-in-time support per dataset (statements, profile, earnings consensus, filings, news, analytics).
8. Refresh limits and any push mechanism.
9. API, schema and model version identifiers; coverage limitations.
10. Corporate-action event IDs and revision semantics.
11. A test environment (address and credential) with known data, for the integration checklist.
12. For the product pages: which provider supplies ratings, yields and spreads, Greeks, futures curves and margins,
    fund holdings and facts, OTC marks and FX forward points (MarketData or Analytics Lab), the conventions each
    states (yield type and compounding, Greek units, mark units), and point-in-time support for ratings, fund
    holdings and marks.
