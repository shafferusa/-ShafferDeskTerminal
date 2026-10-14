# Verification report: Shaffer Desk Terminal

**Tested commit: `97957d2`** (branch `main`). This report and the results files it cites were added in the
commit after it; nothing under `server/`, `web/`, `test/` changed between the two.

The Terminal is a paper-trading front end: every order, borrow, loan, funding movement, collateral movement and
settlement is simulated. Nothing here connects to real-money execution. Hedge selection, investment valuation,
model calculations and market-data ingestion stay in Shaffer Analytics Lab and Shaffer MarketData; where they are
needed they are "Awaiting Shaffer data connection" or stand-ins that are labelled fixtures.

## How the final results were produced

Coordinator-controlled, from a clean clone of `97957d2`, on disposable databases created by the harness (it refuses
any path it did not create, so existing paper books are never touched), one browser, each suite once, in this order:

```
git clone <repo> clone && cd clone
npm test                       # engine: 811 tests, including every product and template scenario and the
                               #   engine level of the failure, recovery and isolation suite
npm run test:api               # 235 scenarios (205 products, 28 templates, 2 trading paths) over HTTP
npm run test:system:api        # failure, recovery and isolation suite, API level
npm run test:browser           # the same 235 scenarios driven through the interface in Chromium
npm run test:system:browser    # failure, recovery and isolation suite, browser level
npm run matrix                 # docs/TEST-MATRIX.md and docs/test-matrix.json from the results files
```

Environment: Linux, 2 CPU cores, 7 GB memory, Node v22.22.0, Chromium 1194 through Playwright
(`/opt/npm-tools/node_modules/playwright`, not a dependency of the Terminal), demo mode with the labelled test
fixtures for quotes, closes, FX, rates, borrow data and the hedge service. Wall time: engine 1.7 min, API 4.3 min,
system API 1.1 min, browser 94 min, system browser 4.7 min.

This was the third full run. The first (commit `5a8d126`) had one failing system browser case, a test that read a
form before a second request had finished; the second (`629e51b`) had two timing failures, one of which was a real
interface race (a position's Lifecycle menu could be drawn before its contract terms loaded, so a user could briefly
see an incomplete menu) and, during the repair, a second real race was found (the hedge popup could be missed when
a refresh arrived while an earlier check was in flight). Both were fixed in the Terminal, with tests, and the full
run was repeated on `97957d2`.

## Results reproduced by the coordinator (commit `97957d2`)

| Suite | Result |
|---|---|
| Engine (`npm test`) | 811 of 811 pass |
| Products, engine level | 205 of 205 scenarios complete; 3,085 steps passed, 0 failed, 150 refusals asserted, 46 unsupported actions asserted, 0 not run |
| Products, API level | same: 3,085 / 0 / 150 / 46 / 0 |
| Products, browser level | same: 3,085 / 0 / 150 / 46 / 0 |
| Templates and trading paths (28 + 2), each level | 30 of 30 complete; 809 steps passed, 0 failed, 32 refusals asserted, 2 unsupported asserted |
| Failure, recovery and isolation, engine | 41 of 41 cases pass (18 not applicable at this level, each with its reason) |
| Failure, recovery and isolation, API | 48 of 48 (11 not applicable) |
| Failure, recovery and isolation, browser | 39 of 39 (20 not applicable) |
| Accounting verification (hand-worked ledger) | passes inside the engine suite and as system case `accounting:verification-book` at API (1,154 checks) and browser (1,405 checks) level |
| Integrity (every ledger event balanced, trial balance, assets minus liabilities, Book equals owners, no duplicate fills, settlements, payments, accruals, postings) | checked after every step of every scenario and case above |

"Refusal asserted" means the specification states that the Terminal must refuse the action in that state and the
test proved it refused visibly, with the stated reason, and changed nothing. "Unsupported asserted" means the
Terminal does not do the action at all and says so (the matrix row names what is recorded by hand instead).

Worker-only reports (not reproduced by the coordinator): the screen sweeps of the whole interface (about 1,100
screen combinations in demo and normal mode, three widths, both themes, no console errors, no overflow, provenance
on every price) and the screenshots the workers looked at. Those are in the workers' notes, not in a results file.

## Products: 205 of 205, by catalog support level

| Support level in the catalog | Products | Meaning |
|---|---:|---|
| full | 124 | contract terms, cash flows and lifecycle events automated by the paper engine |
| partial | 65 | traded and accounted automatically; the events the catalog note names are recorded by hand through a labelled manual workflow |
| manual | 16 | created, held, valued and cash-flowed only through explicit manual inputs (each with a complete manual workflow) |

Every product is tested on an instrument registered as exactly that product with its own conventions (quotation
unit, multiplier, day count, schedule, currency, venue country, calendar, settlement lag), through open, increase,
reduce, close, settlement, the lifecycle events it has, repayment / return / termination / maturity / expiry, and a
restart, with every expected figure worked out by hand in the specification. `docs/TEST-MATRIX.md` has one row per
product and action with the ticket, required fields, automatic versus manual inputs, settlement and lifecycle
events, accounting and collateral behaviour, the test ids and the status per level.

## Four categories

**Implemented and verified** (reproduced above): all 205 products and 28 templates at engine, API and browser
level; the two trading paths (a Strategy package with protection; a Marketplace trade, the Hedge popup, Execute
now); Book isolation, duplicate protection, interrupted execution, catch-up, stale and missing data, insufficient
funding / borrow / collateral, cancellations, persistence; the accounting identities of the owner's section 7;
historical-FX treatment of capital and internal funding (`test/core/historical-fx.test.js`, 625 checks).

**Implemented but unverified** (exists, not driven by a scenario; listed per family in the workers' "not covered"
notes in `docs/FINDINGS.md`): among others, short sales of most bond products other than Treasury bonds; stop-limit
orders on most families; Treasury as trading owner on most families (one Treasury-owned scenario per family); early
exercise by hand on the template scenarios; increase steps on several swap products; the writer side of the manual
OTC contracts; a repo whose collateral is in another currency than the cash; a borrower-side failure to return lent
securities; the "Add legs" path driven only through the engine; non-Chromium browsers, touch and screen readers.

**Incomplete** (known, documented, not built): a non-tradable "published index" product kind (indices and freight
routes are carried by stand-in instruments); bond-future physical delivery (the deliverable basket and conversion
factors are not modelled; such futures close in cash and say so); an FRA reduced by an opposite trade books the
locked-in amount undiscounted; a swap floating payment that is exactly half a cent and a trade amount that is exactly
half a cent round down; a position's margin figure in Accounting shows the independent amount only (variation
margin is per netting set on the Collateral screens); wide tables on Accounting, Treasury, Account, Strategies,
Books, Instruments and Settings scroll inside their panels at 1024 and 390 wide instead of reflowing (the
Marketplaces and the collateral desk reflow); balance-sheet column choices are kept per browser session only.
Each is in `docs/FINDINGS.md` with its reproduction.

**Blocked by an unavailable Shaffer service** (the Terminal keeps the waiting state or a labelled manual entry until
the service exists; nothing is modelled in its place): fair prices, gaps, option, swap and CDS valuations and every
model mark (Analytics Lab); hedge recommendations, protection assessment and the Investment Strategy list
(Shaffer Hedge in Analytics Lab; a labelled demo fixture stands in); reference data, prices, closes, FX, reference
rates and fixings, inflation indices, pool factors, trustee reports, agency factors, loan agent notices,
catastrophe-loss and index fixings, realised volatility and correlation series, auction recovery rates, dividend
forecasts, market calendars beyond the built-in US, UK, TARGET, Japan and Canada rules, and the Mumbai calendar
(MarketData). Every such input is entered by hand today and is labelled as manual wherever it appears.

## Faults corrected during the pass (selection; all with regression tests in `test/core/`)

Accounting and ledger: capital and internal funding translated at today's FX rate instead of the booked rate;
covering a short could spend collateral received from a counterparty; a securities borrow reported no collateral
cash; bond accrual trued down on trade date and re-accrued after a coupon; coupons paid on trade-date holdings
instead of settled face; a coupon payable twice after a trade on the coupon date; a floating coupon reset when
several holders held the instrument; commission charged on face instead of principal; the fee minimum applied per
fill instead of per order.

Execution and lifecycle: closing a short left its borrow open; a cash-secured put rejected when the Account held
exactly the exercise cash; a put reservation not trimmed after a partial cancel; resizing and rolling a spread sent
legs without their dependencies; same-day expiries settling in creation order so a spread could deliver shares it
did not hold; cross-currency swap principal exchanged with no funding check; a swap's trading currency replaced by
leg A's; dividends in the first period of a total-return swap dropped; a reverse repo lending more than its
collateral supports; buy/sell-backs behaving as classic repos; bond-loan collateral on clean value; a bought OTC
option posting an independent amount; options quoted per 100 with the wrong notional; a barrier event recordable
twice; a trade accepted for settlement after maturity; orders filling on days closed in the trading calendar;
failed settlements retried, and counted, on every idle engine cycle.

Interface: the Lifecycle menu drawn before a position's terms loaded; the hedge popup missed when a refresh arrived
during an in-flight check; Escape closing two overlays; the shell overflowing at 1024 and 390 wide; bond prices shown
to three decimals; swaps described as buy / sell; a forward's notional labelled in the wrong currency before a rate.

## What the pass built that did not exist before it

Product-family tabs in each Marketplace view with a documented routing convention (listed instruments by venue
country; financing on the Treasury and Account pages; derivatives follow their underlying; otherwise jurisdiction or
issuer domicile; global FX, crypto and OTC products route to the Foreign views by convention so a US view never
implies a US listing; any unlisted instrument can be set by hand); product-specific columns with Current market
price, Fair price and Gap % together and provenance on every price; a "Trading owner" selector that never substitutes
Treasury; hedge request states, source and freshness, completion in the popup, Investment Strategies by ID,
protection allocations without double counting; collateral agreements with independent amount, variation margin,
thresholds, netting scopes and recorded allocations; per-leg confirmation checks with editable tolerances and
was/now on refusal; per-instrument calendars and settlement conventions; manual workflows for every "partial" and
"manual" product (index ratios, calls, puts, conversions, write-downs, pool factors, paydowns, loss allocations,
credit events, recoveries, observations, repricings, draws, capital calls, distributions, valuations, redemption
gates, settlement values and formulas); physical delivery of futures and forwards; client tokens on every mutating
route; the integrity check; the three-level test harness and the failure, recovery and isolation suite.

## Where to look

- `docs/TEST-MATRIX.md`, `docs/test-matrix.json`: every product and template, action by action, with test ids.
- `test/matrix/results/*.json`: the results the matrix is generated from (the coordinator's final run).
- `test/system/README.md`: the failure, recovery and isolation cases with the mapping of every case to every level.
- `docs/ACCOUNTING-VERIFICATION.md`: the hand-worked ledger.
- `docs/FINDINGS.md`: every finding raised during the pass with what was done about it; the open ones are the
  "incomplete" and "unverified" items above.
- `docs/ARCHITECTURE.md`, `docs/COVERAGE.md`, `README.md`: how it works, what each product supports, how to run it.
