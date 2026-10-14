# Integration checklist (phase 6: real-server acceptance)

Run once credentials and contracts exist. Each step names the check that must pass before the next. Work in the
normal Terminal (`npm start`), never the demo, with a test credential, against the backend's test environment.
Record each result (date, who, pass/fail, evidence) in a copy of this file.

## A. Configuration

1. Set `SHAFFER_GATEWAY_URL` (or the two service addresses) and `SHAFFER_API_TOKEN` / `SHAFFER_AUTH_HEADER` in the
   server environment. Check: `GET /api/server/state` shows `gateway.configured: true`; no response anywhere contains
   the token (`grep` the JSON of `/api/status`, `/api/data`, `/api/server/state`).
2. `POST /api/server/test`. Check: both services reachable; a wrong token gives 401 on the first data request, the
   state shows `authBlocked` with "Not retried", and the gateway log shows one request, not several.
3. Fill `serverCapabilities.versions` with the contract's API/schema version. Check: envelopes carry `version`.

## B. Phase order (owner section 8); map one dataset at a time in `serverOperations`

For each dataset: write its function in `shaffer-contract.js`, restart, then run checks B0 to B4 on it.

- B0 Awaiting -> mapped: `GET /api/server/state` shows `mapped: true` for it and `awaiting` for the unmapped rest.
- B1 Available: a known instrument returns `state: 'available'`, `source.kind` `shaffer-marketdata` or
  `shaffer-analytics`, `asOf` and `receivedAt` set, `freshness.ageSec` plausible, every required field present
  (`missingFields` empty) and units/currency as the contract states.
- B2 Missing data: an instrument with partial coverage returns `incomplete` naming the fields; nulls are null, not 0.
- B3 Errors: a nonexistent ID gives `unavailable` (404) or the contract's error; a forced 5xx (test environment) is
  retried at most `server.retry.maxRetries` times; a 429 is retried after `Retry-After` (bounded by
  `server.retry.maxDelayMs`); a 403 subject is not retried.
- B4 Staleness: an old record shows `stale` at the contract's age limit (set it with `PUT /api/server/refresh`).

Order:
1. Client interfaces and connection states: B0 for all; state route correct per dataset.
2. Reference: `search`, `reference`. Extra checks: each registry instrument gets `external_ids.shaffer`; search hits
   map to registry instruments; issuer and contract IDs present; option and futures contracts link to the underlying.
3. Quotes, history, FX, rates. Extra checks: quote units equal the instrument's quote convention; history adjusted vs
   unadjusted flag is right; a gap is reported in `coverage.missing`, not filled; FX direction is quote per base.
4. Profile, statements, earnings, filings, documents, corporate actions, news. Extra checks: a restated period keeps
   its original values; YTD cash flows are flagged `ytd`; annual vs TTM distinct; an upcoming earnings date has its
   confirmed/estimated status; a document opens through `/api/server/documents/:id` only; the same corporate action
   delivered twice shows once and records once (`POST /api/server/corporate-actions/record` twice -> second
   `duplicate: true`, one `corporate_actions` row); news facts/classification/interpretation are separate.
5. SP3E analytics, runs, earnings window, then Strategies and Hedge (existing `analyticsContract`). Extra checks:
   fair value units equal quote units for the instrument; Gap % shown exactly as supplied (no Terminal arithmetic);
   a historical run is flagged historical; Fundamental and Realistic stay separate; the Strategy is chosen by ID.
5b. Product pages (p1): `ratingsCovenants`, `yieldSpread`, `optionGreeks`, `futuresCurve`, `exchangeMargin`,
   `fundHoldings`, `fundFacts`, `otcMarks`, `fxCurve`. Extra checks: each record names its provider and time; a
   yield states its type and compounding and the price it was struck on; Greek units are printed as the provider
   states them; a futures curve shows only the months supplied; an exchange margin is shown beside, never instead
   of, the margin registered on the contract (which the paper engine posts); fund weights are in percent of net
   assets with the report date; an OTC mark states dealer, clearing or model; a forward curve gives points with their
   units. None of these values is computed in the Terminal (search the network log: no derived request).
6. Point-in-time: for each dataset the contract says supports `asOf`, set `serverCapabilities.pointInTime[ds] = true`
   and check an as-of request returns as-filed data; for the rest check "Not supported by the contract".

## C. Screen paths (instrument-detail workspace)

1. Open the same instrument from Marketplaces, search, a watchlist, a position, Accounting and a Strategy: the same
   workspace opens, with the originating Book and owner.
2. Header: name, symbol, stable ID, product type, venue, currency, market price with source/time/status, Fair Price
   and Gap % from the selected Strategy's run (or missing with the reason), holdings long and short by Account.
3. Switch instruments quickly (ten switches in under five seconds). Check: no value of one instrument appears on
   another (`requestId`/`selection` echo); the gateway log shows superseded requests cancelled.
4. Disconnect the gateway (stop the test service). Check: each tab shows its error or cached-stale state; nothing
   shows zero for a missing value; reconnecting restores `available` without a page reload (a panel in a retryable
   error asks again by itself every 5 s, `RECOVER_MS` in `web/views/workspace.js`). The fixture version of this step
   is `POST /api/demo/fixtures/server {"dataset":"all","mode":"offline"}` then `{"reset":true}`.
5. Every tab in light and dark, at 1440x900, 1024x768 and 390x844.
6. Product pages (one instrument per family: bond, listed option, OTC option, future, fund, FX pair, swap, credit
   default swap, forward, loan or repo, manually valued holding, spot asset): every tab opens; the issuer or underlying
   link opens its own workspace and its statements are never shown as the contract's; the bond's accrued interest
   equals the ticket's for the same settlement date; schedules match the contract; "Not covered for this product"
   lists what the contract does not supply. The browser checks are `test/workspace/checks/p1-product-pages.mjs`.

## D. Paper execution from a server response

1. From the detail page, Trade: the ticket carries the exact instrument, Book, owner and selected Strategy ID.
2. Preview: confirmation, borrow, funding, collateral and per-leg checks appear as before; the price used is the
   server quote shown in the header (same observation id on the fill after execution).
3. Confirm: the order fills on the paper engine only after explicit confirmation; the fill's `price_obs_id` points to
   the server observation.
4. After the fill, the Hedge workflow opens; the Hedge request is answered by Analytics Lab; the package preview uses
   one quote snapshot; nothing executes until confirmed.
5. Refresh quotes, statements and analytics (`fresh=1`) and invalidate the cache: hash the `events`, `entries`,
   `fills`, `orders`, `positions`, `settlements`, `corporate_actions` tables before and after; they must be equal
   (the automated versions are `test/core/server-client.test.js` and the regression test of
   `test/core/server-integration.test.js`, which also checks that recording the duplicated corporate action is the
   only change and that `GET /api/books/:id/integrity` stays clean).
6. Run `npm test`, `npm run test:api`, `npm run test:browser` and the system suites; all green.

## E. Phase-6 acceptance procedure, dataset by dataset (server response, screen, confirmed paper execution)

Run in the normal Terminal against the backend's test environment, after A. Set once in a shell:
`T=http://127.0.0.1:8080` (the Terminal), `I=<Terminal instrument ID of a covered equity>` (from
`curl -s "$T/api/instruments?q=<symbol>" | jq -r '.items[0].id'`), `B=<Book ID>` (from `curl -s $T/api/books | jq -r
'.items[0].id'`), and the equivalents `BOND`, `OPT`, `FUT`, `FUND`, `FX`, `SWAP` for one instrument per family. Each
row: (1) the command and what its JSON must show, (2) the click and what the screen must show, (3) where the dataset
feeds a paper execution, the execution step. "Envelope check" means: `state` is `available` (or the state the
backend says is right), `source.kind` is `shaffer-marketdata` or `shaffer-analytics`, `asOf` and `receivedAt` are set,
`missingFields` is empty, `requestId` echoes the one sent.

| # | Dataset | (1) Server response: command | (2) Screen: click | (3) Confirmed paper execution |
|---|---|---|---|---|
| F1 | search | `curl -s "$T/api/server/reference/search?q=<symbol>&requestId=f1" \| jq '{state,source,items:[.items[]\|{ids,symbol}]}'`: envelope check; each hit has `ids.server` | Marketplaces, type the symbol in the filter; on a detail page, "Open another instrument" box: the hit opens `#/instrument/<id>` | none |
| F2 | reference | `curl -s "$T/api/server/reference/$I?requestId=f2" \| jq '{state,ids:.data.ids,quoteConvention:.data.quoteConvention}'`: IDs present, units stated | `#/instrument/$I`: header line "Terminal ID ..., server ID <id>" | the ticket names the same instrument (D below) |
| F3 | quotes | `curl -s "$T/api/server/quotes?ids=$I" \| jq '.items[0]\|{quoteType,bid,ask,last,currency,units,timestamp,status}'`: units equal the instrument's quote convention | header "Current market price" with source, time and status; "Bid / ask" | Trade, Preview buy, Confirm: the fill's price observation is the quote shown (`GET /api/books/$B/accounting/history` lists the fill) |
| F4 | history | `curl -s "$T/api/server/history/$I?from=<d1>&to=<d2>" \| jq '{state,adjusted:.data.adjusted,missing:.coverage.missing,n:(.items\|length)}'` | tab Price history: chart and table; adjusted/unadjusted named; gaps listed, not filled | none |
| F5 | fx | `curl -s "$T/api/server/fx?pairs=EUR/USD" \| jq '.items[0]\|{rate,direction,timestamp}'`: direction is quote per base | `#/instrument/$FX/fx-rates`: rate with direction | an FX ticket on the pair uses that rate |
| F6 | rates | `curl -s "$T/api/server/rates?codes=<code>&from=<d1>&to=<d2>" \| jq '.items[0]'`: percent p.a. | `#/instrument/$FX/fx-rates` (and the Rates tab where shown) | none |
| F7 | profile | `curl -s "$T/api/server/profile/$I" \| jq '{state,issuer:.data.issuer.name,listing:.data.listing.exchange}'` | tab Overview: issuer panel apart from listing panel; units, as of and source per figure | none |
| F8 | statements | `curl -s "$T/api/server/statements/$I?statement=income&period=quarterly&periods=8" \| jq '{state,units:.data.units,periods:[.data.periods[]\|{key,periodType,basis}]}'`; then `&statement=cashflow` (YTD flagged) and `&period=ttm` | tab Financial statements: Income / Balance sheet / Cash flow, Quarterly / Annual, 4-8-12 side by side; a restated column has its original beside it; YTD columns say year to date | none |
| F9 | earnings | `curl -s "$T/api/server/earnings/$I" \| jq '[.items[]\|{fiscalPeriod,releaseAt,dateStatus,revision}]'` | tab Earnings: upcoming with confirmed/estimated (and revised when so); reported metrics with consensus, prior, surprise | none |
| F10 | filings | `curl -s "$T/api/server/filings/$I?all=1" \| jq '{n:(.items\|length),pages:.pagination.pagesRead}'` | tab Filings and reports: Next page; search over all pages | none |
| F11 | documents | `curl -sI "$T/api/server/documents/<docId>"`: 200, the media type, `Content-Security-Policy: ... sandbox` | tab Filings and reports, View: the document in the frame; "Open in a new tab" (PDF: see the note on Chrome below) | none |
| F12 | corporateActions | `curl -s "$T/api/server/corporate-actions/$I" \| jq '[.items[]\|{eventId,type,exDate,deliveries,recordable,recorded}]'` | tab Corporate actions: processed apart from informational; "Record in the paper ledger", confirm | the record: `curl -s -X POST $T/api/server/corporate-actions/record -H 'content-type: application/json' -d "{\"instrumentId\":\"$I\",\"eventId\":\"<id>\"}"` twice: second `duplicate: true`; `GET /api/books/$B/integrity` -> `ok: true` |
| F13 | news | `curl -s "$T/api/server/news/$I?page=1&pageSize=10" \| jq '{state,pagination,first:.items[0]\|{publishedAt,source,classification,interpretation}}'` | tab News and events: facts, classification and interpretation apart; pages | none |
| F14 | ratingsCovenants | `curl -s "$T/api/server/ratings/$BOND" \| jq '.data\|{scope,ratings,covenants}'` | `#/instrument/$BOND/bond-credit` | none |
| F15 | yieldSpread | `curl -s "$T/api/server/yield-spread/$BOND" \| jq '.data\|{yield,spread,priceUsed}'` | `#/instrument/$BOND/bond-terms`: yield type and compounding, the price it was struck on | a bond ticket shows the accrued interest of `GET /api/instruments/$BOND/contract-facts` (Terminal's own) |
| F16 | optionGreeks | `curl -s "$T/api/server/option-greeks/$OPT" \| jq '.data\|{impliedVol,delta,units,provider}'` | `#/instrument/$OPT/opt-greeks`: units as the provider states | none |
| F17 | futuresCurve | `curl -s "$T/api/server/futures-curve/$FUT" \| jq '[.items[]\|{contractMonth,price,priceType}]'` | `#/instrument/$FUT/fut-curve`: only the months supplied | none |
| F18 | exchangeMargin | `curl -s "$T/api/server/margin/$FUT" \| jq '.data'` | `#/instrument/$FUT/fut-terms`: beside the Book's clearing terms | a futures fill posts the Book's clearing margin, not the supplied figure (`GET /api/books/$B/accounting/history`) |
| F19 | fundFacts | `curl -s "$T/api/server/fund-facts/$FUND" \| jq '.data\|{nav,navDate,fees}'` | `#/instrument/$FUND/fund-overview` | none |
| F20 | fundHoldings | `curl -s "$T/api/server/fund-holdings/$FUND?all=1" \| jq '{n:(.items\|length),date:.data.holdingsDate}'` | `#/instrument/$FUND/fund-holdings`: weights in percent of net assets, report date | none |
| F21 | fxCurve | `curl -s "$T/api/server/fx-curve/$FX" \| jq '[.items[]\|{tenor,forwardPoints,pointsUnits}]'` | `#/instrument/$FX/fx-rates` | none |
| F22 | otcMarks | `curl -s "$T/api/server/marks/$SWAP" \| jq '[.items[]\|{date,value,units,kind,provider}]'` | `#/instrument/$SWAP/otc-marks`: dealer, clearing or model named; a model mark is never shown as a quote | none |
| F23 | analytics | `curl -s "$T/api/server/analytics/$I?strategyId=<SP3E id>" \| jq '.data\|{strategyId,runId,fairValueCurrency,fairValueUnits,fundamentalGapPct,realisticGapPct,historical}'`: fair value units equal the quote's | header: choose the Strategy; Fair price and Gap % fundamental / realistic as supplied (withheld with the reason if currency or units differ); tab Analytics and risk | Trade from the page: the ticket says "Investment Strategy: <name> (<id>), as chosen in the header"; Confirm; the package carries that Strategy ID |
| F24 | analyticsRuns | `curl -s "$T/api/server/analytics/$I/runs?strategyId=<id>" \| jq '[.items[]\|{runId,current,historical}]'` | tab Analytics and risk, Runs: historical marked; "Show this run" never changes the header's current figures | none |
| F25 | earningsWindow | `curl -s "$T/api/server/earnings-window/$I?strategyId=<id>" \| jq '.data'` | tab Earnings, eligibility panel apart from the calendar facts | none |
| F26 | Strategies and Hedge | `curl -s $T/api/analytics/strategies \| jq '.items[]\|{id,name}'`; `curl -s $T/api/hedge/service` | header Strategy chooser lists them; after a fill from the page (origin `instrument-detail`) the "Hedge for" dialog opens; on the Strategies page the package preview includes the hedge legs | choose a hedge package, Preview, Confirm: executes only after confirmation, one quote snapshot; `GET /api/books/$B/integrity` -> `ok: true` |
| F27 | ledger (local) | `curl -s "$T/api/server/ledger/$I?bookId=$B" \| jq '.data\|{holdings,fills:(.fills\|length)}'` | tab My positions and trades: equals Accounting, positions | the fill of F3 appears here and in Accounting |

After the table: run the regression (D5) and the suites (D6) once more against the connected Terminal. PDF note:
Chromium-based browsers may not run their PDF viewer inside a sandboxed frame, and the proxy's
`Content-Security-Policy: sandbox` header also applies when the PDF is opened in a new tab. The automated checks
verify the bytes, headers, frame and link (`test/workspace/checks/i1-open-items.mjs`) but cannot see a PDF drawn in
headless Chromium: open a real PDF both ways in the browser the desk uses and record the result here.

## F. Sign-off

List each dataset with: mapped (yes/no), contract version, checks passed, known coverage limits. Anything still
awaiting stays labelled "Awaiting Shaffer data connection" on screen.
