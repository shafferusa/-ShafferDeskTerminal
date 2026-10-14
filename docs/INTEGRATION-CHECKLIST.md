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
  retried at most `server.retry.maxRetries` times; a 403 subject is not retried.
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
   shows zero for a missing value; reconnecting restores `available` without a page reload.
5. Every tab in light and dark, at 1440x900, 1024x768 and 390x844.

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
   (the automated version is `test/core/server-client.test.js`).
6. Run `npm test`, `npm run test:api`, `npm run test:browser` and the system suites; all green.

## E. Sign-off

List each dataset with: mapped (yes/no), contract version, checks passed, known coverage limits. Anything still
awaiting stays labelled "Awaiting Shaffer data connection" on screen.
