# System suite: failure, recovery and isolation

Proves that the Terminal fails safely and recovers cleanly: refusals and blocks, execution under stress, no
duplicates, history that survives, Book isolation and hedge reconnection. Every case runs against the real
engine, ledger and routes on a disposable database (the product matrix's sandboxes, `test/matrix/lib`); fixtures
stand in only for the Shaffer services and are labelled as fixtures. Nothing touches the repository's `data/`.

## Running it

| Level | Command | What runs | Results |
|---|---|---|---|
| Engine | `npm test` (all of it) or `node --test test/system/engine.test.js` | in-process app, frozen clock, explicit engine cycles | `test/matrix/results/system-engine.json` |
| API | `npm run test:system:api [-- --area=refusals --case=cash-trade]` | one disposable server process per case (more where a case kills, restarts or opens a second Terminal) | `system-api.json` |
| Browser | `npm run test:system:browser [-- --area=stress --case=double-click-confirm --headed --slow=150]` | one disposable server and one Chromium page per case | `system-browser.json` |

`SDT_MATRIX_RESULTS` moves the results directory, `SDT_MATRIX_TMP` the sandboxes, `SDT_MATRIX_SHOTS` the screens
saved when a browser case stops. Engine level subsets: `SDT_SYSTEM_AREA=refusals,stress SDT_SYSTEM_CASE=cash-trade`.
After a run, `node --disable-warning=ExperimentalWarning test/system/mapping.mjs` rewrites the table below from the
results files, and `npm run matrix` the "System behaviour" section of `docs/TEST-MATRIX.md`.

## Layout

```
cases/<area>.mjs        the cases of one area: { id, title, proves, expected, expectedBrowser?, world?, levels }
lib/kit.mjs             what a case is, loading (with the mapping check), running one case at one level, results
lib/mapping.mjs         the level mapping: its rules (checkMapping), counts and the Markdown table
lib/world.mjs           a disposable Terminal and the helpers a case uses (book, stock, trade, restart, integrity...)
lib/life.mjs            a fifteen-day Book with hand-worked figures (catch-up and history cases)
lib/browser-cases.mjs   the interface part of every case that runs in the browser
engine.test.js          engine level (part of npm test)
run-api.mjs             API level
run-browser.mjs         browser level
mapping.mjs             writes the table below
```

Test ids: `SE:<area>:<case>`, `SA:<area>:<case>`, `SB:<area>:<case>`. A case states its expected behaviour
(`expected`, and `expectedBrowser` where the browser form differs) before it was first run; a case passes when every
check held, no request ended in a server error, the page logged no console error, and (browser level) the integrity
read of every Book of the Terminal is clean at the end of the case. Nothing in a case adjusts its expectation to what
the Terminal did.

## The level mapping

Each case gives, for each level, either the function that runs it there or the precise reason it does not, naming
the tests that cover what a user sees instead. The rules are enforced by `loadCases` before any runner starts (and so
by `npm test`): a level with neither a test nor a reason, a reason shorter than a sentence, a reason that names a test
id that does not exist or does not run at that level, or a case that runs at engine or API level without naming a
browser counterpart in its browser reason, stops the run with the list of breaches.

Why a case does not run at a level is always one of: the condition is made by a program or by the server process,
not by anything done in the interface (a killed process, a repeated HTTP request, an engine cycle, time passing), so
the browser case named reads what the user then sees; the case is the screen side of a refusal whose server side is
the named engine and API case; or a click, a dialog or a page is a browser matter with no engine or HTTP form.

<!-- system-mapping:start -->
<!-- Written by test/system/mapping.mjs from the cases and the results files; do not edit by hand. -->

54 cases. Each declares, at each level, the test that runs there or the precise reason it does not; the runners refuse to start when a level has neither, when a reason names a test that does not exist or does not run at that level, or when a case that runs at engine or API level names no browser test covering what the user sees of it (test/system/lib/mapping.mjs).

| Level | Cases | Run at this level | Not applicable (reason given) | Passed | Failed | Not run | Results as of |
|---|---:|---:|---:|---:|---:|---:|---|
| Engine | 54 | 41 | 13 | 41 | 0 | 0 | 2026-10-13T17:26:26.103Z |
| API | 54 | 47 | 7 | 47 | 0 | 0 | 2026-10-13T17:17:26.802Z |
| Browser | 54 | 32 | 22 | 32 | 0 | 0 | 2026-10-13T17:26:01.745Z |

Each row adds up: run + not applicable = 54 at every level; passed + failed + not run = run. 22 of the 47 API cases have no browser run of their own; each names the browser test(s) that cover what the user sees of it (the Browser column below). 7 browser cases have no API run (a click, a dialog or a screen is a browser matter; the routes behind them are covered by the tests their API reason names).

### Hedge reconnection

| Case | What it proves | Engine | API | Browser |
|---|---|---|---|---|
| `hedge:reconnection` Hedge requests that waited while positions changed are refreshed against current exposure on reconnection | A request made while the hedge service is away waits; when the service returns it is asked in place for the exposure as it is then; a request whose position was closed is closed and not sent; no request is duplicated; and a recommendation that arrives executes nothing. | not applicable: the engine level of this workflow is test/core/hedge.test.js ("reconnection refreshes waiting requests against current exposure", "one request per primary") | `SA:hedge:reconnection` passed | `SB:hedge:reconnection` passed |

### History survives

| Case | What it proves | Engine | API | Browser |
|---|---|---|---|---|
| `history:data-refresh` History survives data refreshes and fixture changes | New prices, FX rates, reference rates, borrow data and closing prices change what things are worth now; they never touch a fill, a posting, a settlement, an accrual already booked or a snapshot already taken. | `SE:history:data-refresh` passed | `SA:history:data-refresh` passed | not applicable: a data refresh is made by the engine on its timer, not by anything done in the interface; the user's side of it (refresh timings changed on the Data connection page, then the Full history compared row by row, word for word) is SB:history:reference-edits |
| `history:service-reconnection` History survives a service going away and coming back, and a restart | Switching the hedge service off and on, loading and clearing a scripted service, changing the service addresses and restarting the Terminal leave the paper history exactly as it was. | `SE:history:service-reconnection` passed | `SA:history:service-reconnection` passed | not applicable: covered at browser level by SB:hedge:reconnection (the queue and the positions are read before and after) |
| `history:reference-edits` History survives instrument edits, calendar edits and settings changes | Editing an instrument, a market calendar or the Book's paper-desk assumptions applies from then on; it never re-dates, re-prices or re-fees what is already booked. | `SE:history:reference-edits` passed | `SA:history:reference-edits` passed | `SB:history:reference-edits` passed |

### Isolation

| Case | What it proves | Engine | API | Browser |
|---|---|---|---|---|
| `isolation:book-routes` Book isolation through every API route | An id of one Book used in a call scoped to another Book is refused; no read of one Book returns anything of another; a route that takes a single id acts only inside the Book that owns it. | `SE:isolation:book-routes` passed | `SA:isolation:book-routes` passed | `SB:isolation:book-routes` passed |
| `isolation:no-netting` Nothing nets or consolidates across Books | The same instrument held long in one Book and short in another stays two separate holdings with separate cash, collateral, events and totals; an event of the instrument is booked in each Book for that Book's own holding. | `SE:isolation:no-netting` passed | `SA:isolation:no-netting` passed | `SB:isolation:no-netting` passed |
| `isolation:normal-mode-refusals` Fixtures and the clock are refused in normal mode | The demo controls (moving the clock, test fixtures, the hedge fixture and scripted service) do not exist outside demo mode, and normal mode starts empty. | `SE:isolation:normal-mode-refusals` passed | `SA:isolation:normal-mode-refusals` passed | `SB:isolation:normal-mode-refusals` passed |
| `isolation:demo-normal-databases` Demo and normal paper databases are separate files | The demo environment and the normal paper books live in two database files chosen by the mode; a Terminal in one mode never opens, reads or writes the other's file. | not applicable: the choice of file is made by the server at start (server/config.js); the engine level opens a database it is given | `SA:isolation:demo-normal-databases` passed | `SB:isolation:demo-normal-databases` passed |

### No duplicates, ever

| Case | What it proves | Engine | API | Browser |
|---|---|---|---|---|
| `nodup:day-by-day` Fifteen days lived one day at a time: every recurring item exactly once | With the Terminal running through fifteen days, each accrual, payment, expiry, settlement, collateral movement and hedge request happens once, and the totals are the hand-calculated ones. | `SE:nodup:day-by-day` passed | `SA:nodup:day-by-day` passed | not applicable: time passing is not a user action; the screens are read after time was moved on with the demo band, across two server stops, in SB:nodup:catch-up |
| `nodup:catch-up` Catch-up over fifteen missed days in one engine cycle | A Terminal that was not running for fifteen days books, when it next runs, exactly what it would have booked day by day: nothing missed, nothing twice. | `SE:nodup:catch-up` passed | `SA:nodup:catch-up` passed | `SB:nodup:catch-up` passed |
| `nodup:catch-up-restarts` Catch-up in three stages with a restart between each | Stopping and starting the Terminal between catch-ups neither loses nor repeats what fell due. | `SE:nodup:catch-up-restarts` passed | `SA:nodup:catch-up-restarts` passed | not applicable: stopping and starting the server process is not something done in the interface (the server side is SE/SA:stress:restart-stages); what the user then sees, the screens after downtime across two server stops and after restarts at each stage of a trade, is SB:nodup:catch-up |
| `nodup:overlapping-cycles` Overlapping engine cycles and requests | Engine cycles that are asked for while one is already running do not run on top of it, and trades confirmed while a cycle runs are booked once. | `SE:nodup:overlapping-cycles` passed | `SA:nodup:overlapping-cycles` passed | not applicable: overlapping engine cycles are started by the engine timer and by programs, never from the interface; the screens after many cycles are read in SB:nodup:catch-up, and with the timer running in SB:stress:connection-loss and SB:hedge:reconnection |
| `nodup:concurrent-confirmations` The same confirmation sent three times at once, six of them, with engine cycles in between | Confirmations that arrive together, including the same one several times (a triple click, a client retry racing its first attempt), create one order each and fill once. | `SE:nodup:concurrent-confirmations` passed | `SA:nodup:concurrent-confirmations` passed | not applicable: the browser form of this is clicking a confirming button twice: SB:stress:double-click-* |
| `nodup:timer-on` The engine timer running, with manual cycles on top and a restart on the way | With the engine cycling by itself (as a user's Terminal does) while requests, manual cycles and clock moves arrive, and across a restart, nothing is booked twice. | not applicable: the engine level calls cycles explicitly; the timer exists only in a running server | `SA:nodup:timer-on` passed | not applicable: the browser level runs with the timer on in SB:stress:connection-loss and SB:hedge:reconnection; the books are compared here |

### Refusals and blocks

| Case | What it proves | Engine | API | Browser |
|---|---|---|---|---|
| `refusals:cash-trade` Insufficient cash: a purchase larger than the cash available | A trade the Account cannot pay for is blocked before anything is ordered. | `SE:refusals:cash-trade` passed | `SA:refusals:cash-trade` passed | not applicable: covered at browser level by SB:refusals:ticket-blocks (the same preview, read from the dialog) |
| `refusals:cash-transfer` Insufficient cash: a transfer larger than the settled cash that is free | A transfer cannot overdraw its source, cannot take cash that is committed to an unsettled purchase, and never converts currency. | `SE:refusals:cash-transfer` passed | `SA:refusals:cash-transfer` passed | `SB:refusals:cash-transfer` passed |
| `refusals:cash-withdrawal` Insufficient cash: a capital withdrawal larger than Treasury holds | Capital cannot be withdrawn beyond the settled cash Treasury has free. | `SE:refusals:cash-withdrawal` passed | `SA:refusals:cash-withdrawal` passed | `SB:refusals:cash-withdrawal` passed |
| `refusals:cash-repayment` Insufficient cash: repaying a loan early, and at maturity | A repayment the borrower cannot cover is not made in part and never overdraws; it stays visible until cash arrives, and is then made once. | `SE:refusals:cash-repayment` passed | `SA:refusals:cash-repayment` passed | `SB:refusals:cash-repayment` passed |
| `refusals:cash-settlement-day` Insufficient cash on settlement day | A purchase whose cash has not arrived by its settlement date fails visibly, is never funded silently, and settles exactly once when the cash is there. | `SE:refusals:cash-settlement-day` passed | `SA:refusals:cash-settlement-day` passed | not applicable: the failure is produced by time passing, not by a user action; the Failed tab row it leaves is read at browser level in SB:refusals:failed-tab |
| `refusals:borrow-unavailable` Securities borrow unavailable: the short sale is blocked | A short sale never executes without its borrow, whether the borrow is refused in the preview or at execution. | `SE:refusals:borrow-unavailable` passed | `SA:refusals:borrow-unavailable` passed | not applicable: covered at browser level by SB:refusals:ticket-blocks (short sale with the borrow unavailable) |
| `refusals:borrow-exhausted` Securities borrow exhausted: more than is available to borrow | A short sale cannot be larger than the quantity available to borrow. | `SE:refusals:borrow-exhausted` passed | `SA:refusals:borrow-exhausted` passed | not applicable: covered at browser level by SB:refusals:ticket-blocks (quantity above the borrow available) |
| `refusals:borrow-recalled` Securities borrow recalled by the lender | A recalled borrow is covered once, at the deadline, by one forced buy-in; recalling again does not double it. | `SE:refusals:borrow-recalled` passed | `SA:refusals:borrow-recalled` passed | not applicable: a lender recall is recorded by hand on the borrow position; the form is exercised with the other hand-recorded events in SB:stress:double-click-records, and the buy-in itself is produced by time passing |
| `refusals:collateral-repo` Insufficient collateral: repo | A repo cannot raise more cash than its collateral supports, pledge more than is held free, or pledge the same holding twice. | `SE:refusals:collateral-repo` passed | `SA:refusals:collateral-repo` passed | `SB:refusals:collateral-repo` passed |
| `refusals:collateral-pledged-position` Insufficient collateral: selling a pledged position | A holding pledged as repo collateral cannot be sold while it is pledged, and trying to does not disturb the holding. | `SE:refusals:collateral-pledged-position` passed | `SA:refusals:collateral-pledged-position` passed | `SB:refusals:collateral-pledged-position` passed |
| `refusals:collateral-independent-amount` Insufficient collateral: an OTC independent amount that cannot be posted | An OTC trade whose independent amount exceeds the settled cash that is free is blocked; collateral is never funded silently. | `SE:refusals:collateral-independent-amount` passed | `SA:refusals:collateral-independent-amount` passed | `SB:refusals:collateral-independent-amount` passed |
| `refusals:collateral-margin-call` Insufficient collateral: a variation-margin call that cannot be met | A margin call the Account cannot meet posts nothing, is recorded once, stays visible, and is delivered exactly once when cash arrives. | `SE:refusals:collateral-margin-call` passed | `SA:refusals:collateral-margin-call` passed | not applicable: the call is produced by the end-of-day pass, not by a user action; the alert it raises is read at browser level in SB:refusals:failed-tab |
| `refusals:quote-missing` Missing quote: trade preview, order and valuation | Without a price nothing is estimated, filled or valued at an invented figure; the net asset value says it is provisional and names the holding. | `SE:refusals:quote-missing` passed | `SA:refusals:quote-missing` passed | `SB:refusals:quote-missing` passed |
| `refusals:quote-stale` Stale quote: trade preview, order and valuation | A quote that is too old does not fill an order; a holding valued on it keeps its value but the net asset value is provisional and names it. | `SE:refusals:quote-stale` passed | `SA:refusals:quote-stale` passed | `SB:refusals:quote-stale` passed |
| `refusals:fx-missing` Missing FX rate: trade preview and valuation | Without a conversion rate nothing is converted at an invented rate: reporting-currency amounts are missing, the preview says so, and the net asset value is provisional and names the currency. | `SE:refusals:fx-missing` passed | `SA:refusals:fx-missing` passed | `SB:refusals:fx-missing` passed |
| `refusals:fx-stale` Stale FX rate: trade preview and valuation | A conversion rate that is no longer current still converts, but the result is provisional and says which rate is stale. | `SE:refusals:fx-stale` passed | `SA:refusals:fx-stale` passed | `SB:refusals:fx-stale` passed |
| `refusals:incomplete-terms` Incomplete contract terms | A contract missing a term its product needs cannot be registered or traded; the Terminal never fills the gap with a default. | `SE:refusals:incomplete-terms` passed | `SA:refusals:incomplete-terms` passed | `SB:refusals:incomplete-terms` passed |
| `refusals:invalid-quantity` Invalid quantities | A quantity that is zero, negative, not a number, fractional where shares are whole, more than is held, or more than is short is refused before anything is ordered. | `SE:refusals:invalid-quantity` passed | `SA:refusals:invalid-quantity` passed | not applicable: covered at browser level by SB:refusals:ticket-blocks (zero, fractional and more-than-held quantities typed into the ticket) |
| `refusals:expired-contract` Expired contracts | An expired contract cannot be traded, a working order in it never fills after expiry, and its expiry is processed exactly once. | `SE:refusals:expired-contract` passed | `SA:refusals:expired-contract` passed | not applicable: covered at browser level by SB:refusals:ticket-blocks (ticket on an expired option) |
| `refusals:calendar-settlement` Calendar conflicts: a stated settlement date that cannot be honoured | A settlement date stated for one trade is refused, not moved, when it is not a business day of the settlement calendar or is before the trade date. | `SE:refusals:calendar-settlement` passed | `SA:refusals:calendar-settlement` passed | not applicable: covered at browser level by SB:refusals:ticket-blocks (a settlement date on a Saturday typed into the ticket) |
| `refusals:calendar-closed-day` Calendar: an order on a day its market is closed waits, visibly, and fills once | An order does not fill on a day that is closed in its instrument's trading calendar; it waits with the reason and is matched once on the next trading day. | `SE:refusals:calendar-closed-day` passed | `SA:refusals:calendar-closed-day` passed | `SB:refusals:calendar-closed-day` passed |
| `refusals:failed-tab` What time refused is on the Failed tab and under "to review" | A settlement that failed for lack of cash and a margin call that could not be met are in front of the user with their reasons, once each, and disappear when they are made good. | not applicable: the failures themselves are SE:refusals:cash-settlement-day and SE:refusals:collateral-margin-call; this case reads the screen | not applicable: as at engine level: SA:refusals:cash-settlement-day and SA:refusals:collateral-margin-call | `SB:refusals:failed-tab` passed |
| `refusals:ticket-blocks` Refusals read from the trade ticket and the preview dialog | What the Terminal refuses, it refuses on the screen: the reason is shown, the Confirm button cannot be pressed, and nothing is stored. | not applicable: the same refusals without a screen are SE:refusals:cash-trade, borrow-unavailable, borrow-exhausted, invalid-quantity, expired-contract and calendar-settlement | not applicable: as at engine level: the SA: cases of the same names | `SB:refusals:ticket-blocks` passed |

### Execution under stress

| Case | What it proves | Engine | API | Browser |
|---|---|---|---|---|
| `stress:partial-fills` Partial fills: the remainder keeps working, a dependent leg follows, fees total once | An order larger than the displayed size fills in parts over engine cycles; a leg that depends on it is scaled to what filled and never exceeds it; the fee schedule and its minimum apply to the order once, however many fills it takes. | `SE:stress:partial-fills` passed | `SA:stress:partial-fills` passed | not applicable: partial fills are produced by the engine against displayed size, not by a user action; the partly filled order is read on the Pending tab and cancelled from there in SB:stress:cancellations |
| `stress:failed-leg-cancel` A failed dependent leg: cancelling the working leg | Cancelling the unfilled leg of a package whose other leg filled leaves a package that asks for attention, never one called complete; cancelling again does nothing. | `SE:stress:failed-leg-cancel` passed | `SA:stress:failed-leg-cancel` passed | `SB:stress:failed-leg-cancel` passed |
| `stress:failed-leg-retry` A failed dependent leg: retry | Retrying re-submits only the leg that failed, through a new preview and confirmation, and completes the package without duplicating anything. | `SE:stress:failed-leg-retry` passed | `SA:stress:failed-leg-retry` passed | `SB:stress:failed-leg-retry` passed |
| `stress:failed-leg-unwind` A failed dependent leg: unwind | Unwinding sells what did fill, through a preview and confirmation, and leaves the package closed with nothing held. | `SE:stress:failed-leg-unwind` passed | `SA:stress:failed-leg-unwind` passed | `SB:stress:failed-leg-unwind` passed |
| `stress:failed-leg-accept` A failed dependent leg: accept as it stands | Accepting records, once, that the position no longer matches its template; it moves no money. | `SE:stress:failed-leg-accept` passed | `SA:stress:failed-leg-accept` passed | `SB:stress:failed-leg-accept` passed |
| `stress:cancellations` Cancellations: a working order, a partly filled order, cancelling twice | A cancelled order never fills afterwards; what had filled stays; a second cancellation, or the cancellation of an order that is already complete, is refused and changes nothing. | `SE:stress:cancellations` passed | `SA:stress:cancellations` passed | `SB:stress:cancellations` passed |
| `stress:restart-stages` Application restart at each stage of a trade's life | Stopping and starting the Terminal at any stage loses nothing and repeats nothing: a working order is still working, a partly filled order resumes, an unsettled trade settles once, an open lifecycle item runs once. | `SE:stress:restart-stages` passed | `SA:stress:restart-stages` passed | not applicable: a restart is an operation on the server process; the product matrix restarts every scenario at browser level and reads the screens again, and SB:stress:connection-loss covers the browser across a restart |
| `stress:repeated-requests` Repeated identical requests to every mutating route | Sending the same mutating request twice has one effect, for every route that changes something: by its client token where the route takes one, by its own nature or state where it needs none. | `SE:stress:repeated-requests` passed | `SA:stress:repeated-requests` passed | not applicable: repeated requests are sent by a program, not typed; what a user can do twice (clicking a confirming button twice) is the browser case SB:stress:double-click-* |
| `stress:retries` Retries: a refused confirmation, an item waiting for a fixing | Trying again after a refusal or while something is missing never produces a second effect: the retry either does the one thing, or reports that it was already done. | `SE:stress:retries` passed | `SA:stress:retries` passed | not applicable: the refused confirmation and its second confirmation are read from the preview dialog in SB:stress:confirm-changed |
| `stress:kill-mid-confirmation` The server is killed while a twelve-leg package is being confirmed | An interrupted submission leaves the database consistent: every ledger event is whole or absent, the legs that had not executed resume, nothing is duplicated, and the client can find out what happened by sending the same confirmation again. | not applicable: killing a process needs a process: API level only | `SA:stress:kill-mid-confirmation` passed | not applicable: a killed server seen from the browser is SB:stress:connection-loss |
| `stress:kill-mid-cycle` The server is killed during an engine cycle that catches up fifteen days | An engine cycle interrupted at any point resumes after the restart without repeating what it had already booked and without losing what it had not. | not applicable: killing a process needs a process: API level only | `SA:stress:kill-mid-cycle` passed | not applicable: a killed server seen from the browser is SB:stress:connection-loss |
| `stress:service-stops-answering` A Shaffer service address that stops answering | When a configured service address stops answering, the Terminal says so within its timeout, keeps showing waiting states, and loses no paper history; when the address answers again nothing has changed. | not applicable: a service that stops answering is a network condition: API level only | `SA:stress:service-stops-answering` passed | `SB:stress:service-stops-answering` passed |
| `stress:double-click-confirm` Double click on "Confirm paper trade" | Double-clicking the confirmation of a trade preview submits the package once. | not applicable: a double click is a browser event: no engine call or HTTP request can make one; what a program can send twice is SE/SA:stress:repeated-requests and SE/SA:nodup:concurrent-confirmations | not applicable: a double click is a browser event: no engine call or HTTP request can make one; what a program can send twice is SE/SA:stress:repeated-requests and SE/SA:nodup:concurrent-confirmations | `SB:stress:double-click-confirm` passed |
| `stress:double-click-transfer` Double click on "Record transfer" and "Record deposit" | Double-clicking a button that records a cash movement records it once. | not applicable: a double click is a browser event: no engine call or HTTP request can make one; what a program can send twice is SE/SA:stress:repeated-requests and SE/SA:nodup:concurrent-confirmations | not applicable: a double click is a browser event: no engine call or HTTP request can make one; what a program can send twice is SE/SA:stress:repeated-requests and SE/SA:nodup:concurrent-confirmations | `SB:stress:double-click-transfer` passed |
| `stress:double-click-records` Double click on the other recording buttons: repayment, manual cash flow, lender recall, corporate action | Each button that records something by hand records it once when it is double-clicked. | not applicable: a double click is a browser event: no engine call or HTTP request can make one; what a program can send twice is SE/SA:stress:repeated-requests and SE/SA:nodup:concurrent-confirmations | not applicable: a double click is a browser event: no engine call or HTTP request can make one; what a program can send twice is SE/SA:stress:repeated-requests and SE/SA:nodup:concurrent-confirmations | `SB:stress:double-click-records` passed |
| `stress:confirm-changed` A confirmation refused because the price moved, then confirmed on the new figures | When the figures move between preview and confirmation nothing is submitted, the dialog shows what changed, and the second confirmation (even double-clicked) trades once at the new figures. | not applicable: the refusal itself is SE:stress:retries; the dialog is a browser matter | not applicable: the refusal itself is SA:stress:retries | `SB:stress:confirm-changed` passed |
| `stress:connection-loss` The browser loses the server mid-session and recovers | A lost answer, a server that goes away and a server that comes back never leave a stale screen that looks current, and never turn one instruction into two. | not applicable: a browser losing its server needs a browser and a server | not applicable: the server side of this (kill, restart, same token again) is SA:stress:kill-mid-confirmation and SA:stress:repeated-requests | `SB:stress:connection-loss` passed |

<!-- system-mapping:end -->
