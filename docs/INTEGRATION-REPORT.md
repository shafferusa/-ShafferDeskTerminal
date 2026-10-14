# Server integration layer and instrument-detail workspace: report

**Tested commit: `0731c13`.** This report and the results files were added in the commit after it; nothing
under `server/`, `web/`, `test/` changed between the two.

## Acceptance points (the owner's, 2026-10-14)
1. The response envelope and dataset shapes in `docs/SERVER-CLIENT.md` are the Terminal's **proposed adapter
   contract**, not the backend's schema. When the backend builder supplies the real API contract it is mapped in
   `server/data/shaffer-contract.js`; until that mapping is run against a test environment, compatibility with
   the real server is **not verified**. "No schema invented" means the Terminal has guessed at no path, auth or
   payload of the backend.
2. **The local ledger stays local.** The `ledger` interface of the shared client reads the Terminal's own database
   only; paper balances, positions, fills and accounting never pass through the remote gateway.
   `test/core/ledger-stays-local.test.js` configures a gateway, intercepts every network call and asserts none
   from the ledger interface; it also fails if a network call is ever added to that interface's file.

## What was built
- `server/data/server-client.js`, `server-integration.js`, `server-fixtures.js`, `server/server-api.js`,
  additions to `ports.js` (`SERVER_DATASETS`: 25 remote datasets plus the ledger, each with inputs, required
  fields, units, timestamps, freshness, pagination, point-in-time and errors) and `shaffer-contract.js` (every
  operation a placeholder that reports "awaiting" with its name). One gateway, one server-side credential;
  timeouts, cancellation, bounded retries that never retry 401/403 and honour Retry-After, cache with TTL and
  invalidation, cursor and page pagination behind one iterator, per-dataset refresh, a subscription hook that is
  a no-op until the contract says what is supported, selection tokens so a late answer for a previous instrument
  is discarded. Envelope states: awaiting, loading, available, stale, unavailable, incomplete, error; missing
  values null with a reason, never 0; repeat records in one answer listed once and reported.
- Demo-only labelled fixtures for every dataset with controls (`POST /api/demo/fixtures/server`) for available,
  stale, unavailable, empty, error, slow, partial, forbidden, throttled, offline, revised, duplicate,
  currency-mismatch and unit-mismatch; refused with 403 in normal mode.
- The instrument-detail workspace: `web/views/workspace-model.js`, `workspace.js`, `instrument-page.js`
  (`#/instrument/<id>/<tab>[/asof/<date>]`), the drawer in `instrument.js`, tabs under `web/views/tabs/` and
  product pages under `web/views/tabs/product/`. One workspace from Marketplaces, search, watchlists, holdings,
  Accounting, Treasury, Strategies legs, hedge legs and the registry, preserving Book and trading owner; sticky
  header (IDs, product, venue, currency, price with provenance, Fair price and Gap % for one Strategy chosen by
  ID with Fundamental and Realistic kept apart, horizon and run, holdings long and short by Account, Trade /
  Build strategy / Hedge); Gap % withheld with the reason when units, currency or denominator differ or an
  input is missing; research date apart from the paper-trading clock and never changing the execution quote.
- Equity tabs: Overview (issuer apart from listing), Price history (ranges, intervals, OHLC, volume,
  annotations, adjusted vs unadjusted only where both exist, gaps and coverage stated, nothing manufactured),
  Earnings (confirmed vs estimated, reported / consensus / prior / surprise, documents, revision status, the
  Analytics Lab earnings window as a separate panel), Financial statements (three statements, quarterly and
  annual, periods side by side with pinned labels, every line, per-cell basis, restatements beside originals,
  YTD never shown as a quarter, a guarded labelled derivation, TTM apart, supplied metrics preferred), Filings
  (cursor pages, search, sandboxed document viewer through the proxy, never scraping), Corporate actions
  (informational apart from ledger-recorded, idempotent recording: a duplicate delivery posts once), News
  (facts, classification and interpretation apart), Analytics and risk (SP3E outputs with run, version,
  calculation time, input cutoff, horizon; historical runs marked, never shown as current), My positions and
  trades (local records only, labelled).
- Product pages for bonds, options, futures, funds, FX, swaps and credit, and the other families, with the
  owner's fields, correct issuer / underlying links, and nine further datasets (ratings and covenants, yield
  and spread, Greeks, futures curve, exchange margin, fund holdings and facts, OTC marks, FX curve) that are
  shown only when supplied; nothing computed in the Terminal.

## Results reproduced by the coordinator (clean clone of `0731c13`, disposable databases)
| Suite | Result |
|---|---|
| `npm test` | 883 of 883 (includes server-client, server-integration, ledger-stays-local, tab-model and product-dataset tests) |
| `npm run test:workspace` | 281 of 281 browser checks (navigation, request discipline, as-of, every tab and state, the owner's failure-mode list, open items) |
| `npm run test:api` | 235 scenarios, no failures |
| `npm run test:system:api` | 48 cases, no failures |
| `npm run test:browser` | 235 scenarios, no failures (205 products, 28 templates, 2 paths) |
| `npm run test:system:browser` | 39 cases, no failures |
| Ledger regression | hashes of 12 ledger tables and the accounting history unchanged by every route, fixture mode, reconnection, Strategy and research-date change; the deliberate corporate-action record posts once |

Phases 1 to 5 of the owner's order are built and tested with fixtures. Phase 6 (real-server acceptance) is
blocked until credentials and the contract exist; `docs/INTEGRATION-CHECKLIST.md` section E gives the procedure
per dataset (F1 to F27) from server response to screen to confirmed paper execution.

## Remaining items
- Whether a PDF draws inside the sandboxed frame (and in a new tab under the CSP sandbox header) cannot be seen
  in headless Chromium: a manual step in the checklist.
- The drawer's tabs have no server panels (its header is server-fed); recovery is tested through the header.
- The demo fixtures carry no corporate-action mergers, rights or spin-offs and no growth / margin / ratio
  metrics: those displays are covered by node tests only.
- The earnings `prior` basis and the news kind filter depend on the contract.
- Worker screenshot reviews (both themes, three widths) are worker-reported; the coordinator reproduced the
  scripted checks only.

## Backend dependencies (answer sheet in `docs/DATA-CONTRACT-REQUIREMENTS.md`, G1-G14, D1-D26)
1. Gateway address(es) and credential scheme; whether MarketData and Analytics Lab share them.
2. Instrument, issuer, contract and Strategy ID schemes; symbol and venue to ID lookup.
3. Request and response schema, examples and error codes for each of the 25 remote datasets and the Strategy
   and Hedge operations.
4. Pagination style and limits for the 10 paginated datasets.
5. Quote types, units, timestamp meaning per product; staleness limits per dataset.
6. History coverage and adjustment conventions; which intervals exist; point-in-time history.
7. Point-in-time support per dataset (profile, statements, earnings, ratings, holdings, marks).
8. Refresh limits and any push mechanism.
9. API, schema and model version identifiers; coverage limits per product family.
10. Corporate-action event IDs, the record ID that identifies a repeat in each list, how revisions are signalled.
11. Provider and conventions for the product datasets (yield type, Greek units, mark units, forward points).
12. Error bodies, retryable statuses, rate limits, Retry-After.
13. Document media types and size limits; an HTML rendition of PDFs if any.
14. A test environment with known data.
