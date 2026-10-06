# Shaffer Desk Terminal: architecture

```
External sources -> Shaffer MarketData Database -> Analytics Lab / approved service API -> Desk Terminal
                                                                                          (this repository)
```

The Terminal displays market facts and analytical outputs, and runs persistent **simulated**
portfolio management, funding, execution and accounting. It never connects to real-money
execution, it does not rebuild MarketData, and it contains none of the investment algorithms:
Strategies, Models, fair values, signals and hedge selection belong to Shaffer Analytics Lab. The
Terminal owns *execution templates* (how the legs of a package are assembled) and the paper books.

## Ground rules

- Node.js 22.13 or newer, ES modules, **no npm dependencies** (`node:sqlite`, `node:http`,
  `node:test`, global `fetch`). `npm start` works straight after `git clone`.
- Front end: no build step. Native ES modules; Preact and htm are vendored in
  `web/vendor/preact-htm.js`. Screens are loaded on demand.
- All time goes through `server/core/clock.js`, so tests and demo mode can move the clock.
  Dates are `YYYY-MM-DD`; instants are ISO-8601 UTC; the business date is New York time.
- Money is rounded to the currency's minor unit when it is posted to the ledger.
- A value that is not available is `null` and is drawn as missing. It is never replaced by zero.

## Three separate concerns

| Concern | Where | Owns |
|---|---|---|
| Market facts | `app.data.market` (MarketPort) | reference data, prices, history, FX, rates, calendars, events, corporate actions, derivative contract data, borrow and financing data |
| Analytical outputs | `app.data.analytics` (AnalyticsPort) | model runs, signals, scores, fair values and gaps, valuations, timing, sizing, risk, Shaffer Hedge |
| Paper accounting | `app.ledger`, `books`, `positions`, `orders`, `packages`, `accounting` | everything the Terminal itself simulates and records |

Screens never call a service. They call the Terminal's own API (`server/api.js`), which reads
market facts and analytics only through the data adapter (`server/data/index.js`).

## The data adapter (`server/data/`)

| File | Role |
|---|---|
| `ports.js` | The two port interfaces and the shapes they return, plus "awaiting" implementations that return nothing. |
| `shaffer.js` | The Shaffer implementation: HTTP transport with server-side credentials, reachability test, and port methods that delegate to the contract file. |
| `shaffer-contract.js` | The mapping from real service calls to the Terminal's shapes. **Empty on purpose** until the real API documentation exists. An operation left `null` reports "awaiting". |
| `observation.js` | The one observation shape used for every market fact. |
| `index.js` | The adapter the rest of the server uses: refresh, synchronous reads (`price`, `fx`, `rate`, `borrowInfo`, `session`, `closeFor`), manual entries, connection and refresh settings, and the store of observations that were used. |
| `demo.js`, `demo-seed.js`, `demo-hedge.js` | The isolated demo environment: simulated feed, fictional instruments, a seeded Book, and a canned hedge fixture labelled as such. Only reachable with `--demo`. |

### Observations

Every price, FX rate, reference rate, fixing and borrow quote is an observation:

```
{ kind, subject, value, bid, ask, bidSize, askSize, prevClose, currency, units,
  source, providerId, status, delayMinutes, asOf, forDate, receivedAt, assumptions[], extra }
```

`status` is one of `real-time`, `delayed`, `end-of-day`, `indicative`, `model-derived`,
`reconstructed`, `manual`, `simulated`. The screens show it on every price, with source, time,
currency, units and freshness. Only `real-time`, `delayed` and (in demo) `simulated` observations
can fill an order by themselves; anything else needs an explicit stated price or the Book's
end-of-day setting.

When an observation is used for a fill or a valuation snapshot it is copied into the `observations`
table and referenced by id (`fills.price_obs_id`, `fills.fx_obs_id`, `entries.fx_obs_id`), so a
later data refresh can never change what a trade was booked against.

### Waiting states

Until a port is connected, its methods return "not available" and the API passes that through with
the message **Awaiting Shaffer data connection**. Market readiness and analytics readiness are
tracked per dataset and shown separately on the Data connection page.

## Instruments (`server/core/instruments.js`, `catalog.js`, `server/products/`)

Instruments are identified by Terminal IDs, not tickers, and can carry the Shaffer MarketData ID in
`external_ids.shaffer`. Each instrument has a catalog product (205 of them) which maps to an engine
family. The family plugin owns the product's conventions, so stock accounting is never applied to
a swap.

| Family | Covers |
|---|---|
| `equity`, `fund`, `spot`, `crypto`, `manual` | securities and other holdings priced per unit |
| `fx` | spot currency conversion between two cash balances |
| `option` | listed options, each with its own multiplier and deliverable |
| `otcoption` | OTC vanilla, digital and barrier options; other exotics with manual settlement |
| `future` | futures: initial margin, daily variation, final settlement |
| `forward` | FX forwards, NDFs, forwards on an asset, FRAs |
| `bond` | bills, notes, bonds, FRNs, securitised paper with a pool factor |
| `loan`, `repo`, `secloan` | cash borrowing and lending, repo and reverse repo, securities borrowing and lending |
| `swap` | a general leg engine: fixed, floating, compounded overnight, return on a reference asset, price of a reference asset, cap, floor |
| `cds` | single-name and index credit default swaps |

A plugin provides: validation of contract terms, allowed actions, trade economics, settlement
date, booking of a fill, valuation, end-of-day accrual, scheduled lifecycle tasks, and hand-driven
lifecycle actions where the event cannot be scheduled. Each catalog product states its support
level (`full`, `partial`, `manual`) and a note; `docs/COVERAGE.md` is generated from it.

### Market views

`US_CASH` (US Based), `US_DERIV` (US Derivatives), `FOREIGN_CASH` (Foreign Based), `FOREIGN_DERIV`
(Foreign Derivatives). A listed product is placed by its listing venue. Issuer domicile and
underlying geography are stored separately. OTC, FX and global products need an explicit primary
view and may carry cross-market tags. Views are filters, not accounting Books.

## Books, Treasury, Accounts and the ledger

`Book -> Treasury + Accounts`. Each is a *unit*; every transaction belongs to a Book and exactly
one unit. A Book is a separate workspace: nothing is pooled, totalled or transferred across Books,
and no API or screen spans more than one. Capital enters and leaves through Treasury. A transfer
between units never converts currency.

An accounting scope (`books.scopeUnits`) is `book`, `treasury`, `accounts`, one unit id, or several
unit ids joined by commas. A scope that names a unit outside the Book is refused.

The ledger is double-entry. An event (`events`, the immutable audit trail) has balanced `entries`
per unit and currency. Each entry also stores its reporting-currency amount, the FX rate and the
FX observation used at posting time, which is what lets FX effects be separated from performance
without double counting. A correction posts a reversing or adjusting event that points at the
original.

| Account | Type | Meaning |
|---|---|---|
| `cash` | asset | settled, unrestricted cash |
| `cash.restricted` | asset | short-sale proceeds and collateral held against borrowed securities |
| `cash.margin` | asset | margin posted for futures and OTC contracts |
| `recv.settle` / `pay.settle` | asset / liability | executed trades awaiting settlement |
| `accrued.asset` / `accrued.liab` | asset / liability | interest and fees earned or owed, not yet paid |
| `pos` | asset | positions at cost |
| `loan.asset` / `loan.liab` | asset / liability | principal lent / principal borrowed |
| `coll.received` | liability | cash collateral received against securities lent |
| `internal` | equity | funding between Treasury and Accounts (nets to zero across a Book) |
| `capital` | equity | external contributions and withdrawals |
| `pnl.realized`, `pnl.dividend`, `pnl.coupon`, `pnl.interest`, `pnl.borrow`, `pnl.funding`, `pnl.lending`, `pnl.commission`, `pnl.fee`, `pnl.fx` | P&L | the P&L categories shown on the Accounting page |
| `fx.clearing` | clearing | bridges the two currencies of a conversion |

Reserved cash is not a ledger movement. It is a row in `holds` that reduces what is available.
`ledger.cash(unit, ccy)` gives the cash picture: settled, restricted, margin, receivable, payable,
reserved, available to trade (settled plus what is owed to the unit, less what it owes and what is
reserved) and available to withdraw (settled only).

### Borrowing, balance sheets and consolidation (`core/accounting.js`)

Treasury or any Account can borrow. The authoritative record of a borrowing is the position that
carries the liability, in the unit that borrowed. `accounting.borrowings(bookId, scope)` reads the
register from those positions: ID, owner, whether it is Account-originated, lender, currency,
principal, rate, maturity, collateral, next payment, accrued interest, interest and fees to date.
Nothing is copied into Treasury to make an Account's borrowing visible there: Treasury's page and
the Treasury-only balance sheet show it under oversight, outside Treasury's own liabilities.

`accounting.balanceSheet(bookId, scope)` is a consolidation worksheet: one column per unit in the
scope, an eliminations column and a total. Assets and liabilities come from the ledger accounts
below. Funding between Treasury and Accounts sits in `internal`; across the whole Book it nets to
zero and is shown as eliminated (any residual is reported, not hidden). External principal,
interest and fees therefore count once at Book level. Net assets are reconciled to capital,
internal funding and results to date.

`accounting.navStatus` marks a net asset value provisional when a position has no price, a mark is
stale, or a currency conversion is missing or stale, and lists each affected item with its owner.

`accounting.holdingsOf` reports holdings gross per instrument: long, short and net, with each
owning unit. No screen shows a net quantity as a long holding.

## Calendars (`quant/calendar.js`)

Holiday rules are built in for `US` (NYSE), `USBOND` (SIFMA), `USD` (Federal Reserve), `UK`,
`TARGET`, `JP` and `CA`; `A+B` is a joint calendar. `calendarInfo(inst)` picks a calendar from an
explicit term, the venue country or the currency, and reports the basis; a market with none falls
back to `WEEKEND` and is flagged in the instrument view and as a warning in the preview.
`fxValueDate` uses both currencies' calendars (and US dollar days for crosses). Holidays entered
by hand are stored as a setting and applied on start. These are stand-ins until Shaffer MarketData
supplies calendars.

## Packages, orders and fills

1. **Build.** An execution template (`core/templates.js`) or a custom list turns into legs.
   Contract quantities come from each contract's own deliverable and multiplier.
2. **Preview** (`packages.preview`). Every leg is resolved, priced with the fill model, and
   checked: borrow availability, cash by currency, margin, collateral, reservations, existing
   positions, settlement timing. The result carries blocking errors, warnings, a payoff view and a
   one-time confirmation token. The preview is editable; edited legs are re-checked from scratch.
   Every subtotal and total is derived from the legs of one price snapshot. The preview also
   reports protection already present in the template or the Account (`analyzeProtection`);
   adding more is an error unless the request says it is deliberate.
3. **Confirm** (`packages.submit`). One confirmation creates one strategy instance; each leg
   becomes its own order. A token can be used once. The browser sends back the cash total it
   displayed; if re-pricing moves it by more than `fill.maxPreviewDriftPct`, the confirmation is
   refused with `preview_changed` and the new preview is returned for review.
4. **Match** (`core/orders.js`). Legs are not assumed to execute together. A leg waits for its
   dependencies, is rejected if a dependency fails, and is scaled down if a dependency only partly
   fills. Fills use quoted bid/ask where there is one, otherwise a named fill model; a stated price
   is recorded as a manual input.
5. **Settle** (`core/settlement.js`). Cash moves on the settlement date. A payment that cannot be
   covered fails visibly and is retried; it is never funded silently.

Strategy status: `working`, `partial`, `open`, `attention` (a required leg failed while others
filled, so residual exposure remains), `failed`, `closed`. Recovery actions are retry, unwind,
accept as it stands, and cancel working legs. Close, resize and roll are new packages attached to
the same strategy instance.

## Hedge (`core/hedge.js`)

Shaffer Hedge runs in Analytics Lab. The Terminal builds a complete request (instrument, direction,
amount, Book, Account, investment Strategy, holding period, objective, scope, existing position,
hedges already held, the template's own protection, and position facts for the Account or Book),
stores it, and shows what comes back. Proposed legs run through the same preview, confirmation and
per-leg checks as any other package, and stay linked to the primary position. When a hedged
exposure changes, the strategy is flagged for review; nothing is traded without confirmation.
No hedge selection or sizing logic exists in the Terminal.

A request made while Analytics Lab is unavailable is stored as waiting. It stays on the position
(Accounting, open positions) and in the review queue (`hedge.queue`). Each engine cycle calls
`hedge.refreshWaiting`, which re-asks for the same request, in place, against the exposure as it
is then; it never creates a second request and never trades. The popup's cost table is built only
from the Terminal's own priced legs; the service's estimate is shown beside it for comparison.
"Execute now" submits the displayed preview with its expected cash, under the same drift guard.

## Engine (`core/engine.js`)

One cycle: refresh what working orders need, match orders, settle what is due, run due lifecycle
tasks and corporate actions in date order, run the end-of-day pass once per business day (accrual
true-ups, futures variation, short collateral marks, holds, day-order expiry, valuation snapshots),
then send any queued post-trade hedge requests. After downtime the same cycle catches up day by
day. A lifecycle task that needs a fixing which is not available is marked blocked and says which
observation it is waiting for.

## Front end (`web/`)

| File | Role |
|---|---|
| `app.js` | Shell, routing, Book selector, sidebar (Accounting, Treasury and its Accounts, Strategies, Marketplaces, Reference), Account in use, connection state, demo clock |
| `lib/core.js` | API helpers, shared state, live reload, number formatting |
| `lib/ui.js` | The UI kit: prices with provenance, missing values, waiting states, tables, dialogs, charts |
| `lib/contracts.js` | Instrument picker (with the Book's holdings) and schema-driven contract forms per family |
| `views/*.js` | One file per screen, loaded on demand |

The server pushes a change event over `/api/stream` when the engine does something, and screens
reload their data; a slow poll covers a dropped stream.

## Tests

`npm test` runs the engine against the demo feed with a controllable clock: Books and transfers,
equities and shorts, partial fills, options and expiry, futures, FX and multi-currency P&L, fixed
income, financing, swaps and other OTC products, lifecycle events and recovery actions, the
awaiting state with manual prices, the hedge workflows, and catalog coverage.

`test/core/reconciliation.test.js` checks the books rather than the screens: calendars and value
dates, an Account-originated borrowing as one record counted once, two-currency consolidation,
internal transfers and their elimination, hedge preview totals against the entries posted on
execution, a refused confirmation after a price move, duplicate protection, gross holdings, a
failed then completed settlement, provisional NAV, a waiting hedge request refreshed in place, and
a total-return swap with collateral, resets, financing and close-out.
