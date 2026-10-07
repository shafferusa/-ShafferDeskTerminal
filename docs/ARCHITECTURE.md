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
| `cash.restricted` | asset | short-sale proceeds, collateral held against borrowed securities, and cash collateral received from OTC counterparties |
| `cash.margin` | asset | futures margin, and independent amounts and variation margin posted on OTC positions |
| `recv.settle` / `pay.settle` | asset / liability | executed trades awaiting settlement |
| `accrued.asset` / `accrued.liab` | asset / liability | interest and fees earned or owed, not yet paid |
| `pos` | asset | positions at cost |
| `loan.asset` / `loan.liab` | asset / liability | principal lent / principal borrowed |
| `coll.received` | liability | cash collateral received: against securities lent, and from OTC counterparties under a collateral agreement |
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

### Collateral agreements and OTC collateral (`core/agreements.js`)

Collateral on a swap, credit default swap, forward or OTC option follows the basis the contract
states (`terms.collateralBasis`), fixed on the position when it opens (`position.data.collateralBasis`):

| Basis | Meaning |
|---|---|
| `agreement` | a paper agreement recorded in the Book (`agreements`, `agreement_units`): `bilateral` (CSA-style), `cleared`, or `uncollateralized` |
| `position` | terms entered on the contract itself; the older `terms.initialMarginPct` field is read as this |
| `uncollateralized` | an explicit paper assumption: nothing is posted, nothing is received |

No plugin carries a collateral rule. The OTC plugins only state the notional a percentage is taken
on (`collateralNotional`) and call `app.agreements`: `tradeRequirement` in the preview and at
execution (a contract with no basis, an agreement of another Book, a closed agreement, a unit the
agreement does not cover, or an independent amount that settled cash cannot cover all block), and
`onPositionChange` whenever a quantity changes. A position with no basis on record is flagged and
treated as uncollateralized; it can be reduced, not increased.

What is simulated: the independent amount (a share of notional or a fixed amount per position,
posted at the fill, trued up when notional changes, returned when the position ends); variation
margin in the end-of-day pass (`engine.runEod` calls `agreements.endOfDay`) from the mark of each
netting set, with the threshold and the minimum transfer amount applied in both directions; netting
per position, per Account, or shared across the Accounts an agreement lists; one eligible cash
currency per agreement, valued at its conversion rate less its haircut. Everything else an
agreement can carry (`RECORDED_ONLY`) is stored and shown as "recorded, not simulated".

Posted collateral moves `cash` to `cash.margin` in the posting unit. Collateral received is
`cash.restricted` against `coll.received`: it never reaches `cash`, and a settlement draws
restricted cash only from the position it belongs to, so it cannot be spent. Each movement is one
balanced ledger event (`<family>.collateral` for an independent amount, `collateral.variation` for
variation margin) whose data names the agreement, the positions of the netting set, the requirement
and the marks with their observations. The `collateral_movements` register mirrors it with the
unit whose ledger moved and the Account the amount is allocated to; `agreements.reconcile` checks
the register against the ledger. `collateral_state` keeps the latest valuation of each requirement.

A call that cannot be met from settled, uncommitted cash posts nothing: it is recorded once
(`collateral.call_failed`), raised as an alert and retried every engine cycle; a retry delivers the
difference between what is required and what is held, so it cannot post twice. A netting set with
a missing mark or conversion rate is not called at all and is flagged.

An agreement belongs to one Book and covers units of that Book only; netting sets are built Book by
Book. Sharing across Accounts exists only where an agreement lists them and names a posting unit;
the collateral is then on that unit's balance sheet, once, and the Accounts see it as an allocation.
Listed futures and options are cleared products whose margin follows the Book's paper-desk
assumptions (`core/defaults.js`) and each contract's own initial margin, not these agreements.

## Calendars (`quant/calendar.js`)

Holiday rules are built in for `US` (NYSE), `USBOND` (SIFMA), `USD` (Federal Reserve), `UK`,
`TARGET`, `JP` and `CA`; `A+B` is a joint calendar, open only when every member is.

An instrument has three calendars: trading, settlement and payment. Each can be set on the
instrument (`instruments.conventions`: `tradingCalendar`, `settlementCalendar`, `paymentCalendar`,
and `settleLag`); what is not set comes from the venue country, then the currency.
`calendarInfo(inst)` (`products/security.js`) reports all three with their basis. Payment dates
(coupons, interest, maturities, resets) always also follow the payment calendar of each currency
paid. A role with no real calendar falls back to `WEEKEND`; `calendarInfo(inst).flag`
(`weekends-only` or `approximate`) and `flagText` carry that to the instrument, its ticket, the
Marketplaces row and the preview leg as a badge and a sentence. `fxValueDate` uses both
currencies' calendars (and US dollar days for crosses). Holidays entered by hand are stored as a
setting and applied on start. These are stand-ins until Shaffer MarketData supplies calendars.

Settlement of a trade (`core/settlement.js`, `resolveSettlement`): the lag set on the instrument,
else the Book's assumption for the product, counted on the settlement calendar; or a settlement
date or lag stated for that one transaction (`leg.settle = { date }` or `{ lag }`). A stated date
that is not a business day on the settlement calendar, or is before the trade date, is a calendar
conflict: the preview blocks with the reason and nothing is re-dated silently. Futures, forwards
and financing arrangements have their settlement fixed by the product.

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
   becomes its own order. A token can be used once. The confirmation carries the figures that
   were displayed (`expected`: the preview's `confirmation` snapshot of every leg and every package
   total). The legs are priced again as one snapshot and compared with it (`core/confirmation.js`)
   under the Book's tolerances (`settings.confirmation`: leg price, leg amounts, package totals,
   gross cash and notional, preview age). Each leg is checked alone and the gross measures add
   absolute amounts, so offsetting moves cannot hide in a net figure. A figure beyond its
   tolerance, or any changed term (settlement date, quote status, financing terms, borrow
   availability, a missing leg), refuses the confirmation with `preview_changed`; the response
   carries the new preview and the list of changes (was, now) for a new confirmation. Each order
   keeps what it was confirmed on (`order.data.confirmed`), each fill records how it differs and
   why (`fills.confirm`), and a difference is also posted to the history (`order.fill_variance`).
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

## Hedge and protection (`core/hedge.js`, `core/protection.js`)

Shaffer Hedge runs in Analytics Lab. It selects and sizes hedges and decides which existing hedges
apply to an exposure. The Terminal builds the request, says truthfully where it stands, validates
and stores what comes back, and runs confirmed paper execution through the normal preview. No hedge
selection or sizing logic exists in the Terminal, and nothing is executed because a recommendation
arrived.

**One state per request**, derived on every read and returned by every route that returns a request:

| State | Meaning |
|---|---|
| `incomplete` | Required context is missing (investment Strategy, holding period, objective, or the amount). Stored and shown; **not sent** to the service and not answered by a fixture. |
| `awaiting_connection` | Complete; the service cannot be reached. |
| `ready_for_analysis` | Complete and the service can be reached; not answered yet. |
| `recommendation_ready` | A response is stored (with its source and freshness). |
| `executing` / `executed` | A package was confirmed; legs still working / done. Confirmed with no leg executed reads as `error`. |
| `dismissed`, `closed`, `error` | Dismissed by the user; the position it was for no longer exists (with the reason); the service call failed. |

Completeness (`complete`, `missing`) and connection (`connection.reachable`, `kind`) are reported as
separate facts beside the state. `POST /api/hedge/requests/:id/complete` saves missing context under
the same request id and sends it when it is complete; the context is also written to the position's
strategy instance.

**Source and freshness.** Every stored response is stamped by the Terminal, from the channel it came
through, with `{ kind: 'shaffer-hedge' | 'demo-fixture' | 'test-fixture', label, version, receivedAt,
exposureAsOf, fingerprint }`. `version` is the service's version or run id, or null ("not supplied").
Freshness is never stored as a claim: each read compares the fingerprint (scope, primary amount, and
the hedges that are linked to the exposure or could still be allocated to it) with positions as they
are, and reports `current` or `stale` with what changed, and separately whether the source can be
reached now (a recommendation whose source is away is "cached"). A stale recommendation is refused by
the preview (`hedge-stale`) until `POST /api/hedge/requests/:id/refresh` re-asks in place.

**One request per primary.** A position's open request is reused and rebuilt in place by any later
call; the automatic post-trade request is made once per position; a strategy instance that holds
only hedge legs or financing never gets a request. On each engine cycle waiting requests are
refreshed against exposure as it is then (`refreshWaiting`), and a request whose position was closed
becomes `closed` and is not sent.

**Investment Strategies** are identified by the IDs Analytics Lab supplies (`analytics.strategies()`).
A reference is `{ id, name, resolved: true, source, version }` when chosen from that list and
`{ id: null, name, resolved: false }` when typed while the list is unavailable. An unresolved name is
labelled as such everywhere; an exact-name match is suggested and applied only when the user confirms
it (`POST /api/analytics/strategies/resolve`). Execution templates are a separate concept.

**Protection** (`core/protection.js`, tables `protection_allocations` and `protection_verdicts`). A
hedge counts as protection for a position only through an active allocation:

| Basis | Created when | By |
|---|---|---|
| `explicit_link` | a hedge leg executed from that position's hedge request fills | the Terminal, from the stored request id |
| `template` | a hedge leg of the execution template that built the position fills | the Terminal, from the strategy instance id |
| `service` | a hedge response carries a protection assessment | Analytics Lab; validated and stored by the Terminal |

The request sends the Account's positions and hedges as context, each hedge tagged `linked`, `shared`,
`allocated_elsewhere` (with the capacity left) or `unassessed`; only `linked` hedges and the template's
own protection are stated to protect the exposure. Capacity is never counted twice: bought options
have a capacity of contracts x deliverable units (a put covers long units, a call short units, a
written option none); futures, forwards, swaps and other contracts have no unit measure in the
Terminal, so an explicit link is recorded without units and a service allocation must state the
capacity it is working from. An allocation that would exceed capacity, crosses a Book, or refers to
an expired or closed hedge is stored as `rejected` with the reason. Allocations are released when the
hedge or the protected position closes, and marked `expired` when the hedge expires. A position's
remaining exposure is computed only from allocations that exist; while hedges are held in the
Account that nobody has assessed, it says "Protection assessment unavailable." The preview's
duplicate-protection check (`analyzeProtection`) works from the template's own legs and these
allocations: adding more than the exposure still unprotected has to be confirmed as deliberate.

**Shared identifiers.** Orders store the hedge request id on hedge legs (`hedgeLinkId`), the legs a
financing leg funds (`fundsLegs`) and the legs a hedge leg protects (`protectsLegs`); positions carry
the strategy instance id. `accounting.openPositions` and `packages.strategyView().hedge.links` turn
these into relationship lines ("Financing for Long 300 BRVO", "Hedge leg of request HDG-...,
protects Long 300 BRVO").

**Fixtures (demo mode only).** The demo fixture (`data/demo-hedge.js`) answers complete requests with
canned packages, an illustrative protection assessment and a small fictional Strategy list; it is
labelled "demo fixture, not Shaffer Hedge" wherever its output appears, and the top bar shows
"Hedge: demo fixture" beside "Analytics Lab: awaiting". `POST /api/demo/hedge-script` loads a scripted
"service" (responses with packages and a protection assessment, optionally a Strategy list) for
tests and the browser harness; everything it returns is labelled `test-fixture`.

The popup's cost table and the totals that stay in view are built only from the Terminal's own
priced legs in one snapshot; the service's estimate is shown beside them for comparison. "Execute
now" submits the displayed preview with its expected figures, under the same confirmation guard.

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

`test/core/collateral.test.js` checks collateral against hand-worked figures: a total-return swap
and a credit default swap each under an agreement, position-level terms and an explicit
uncollateralized assumption; threshold and minimum transfer; per-position against per-Account
netting; collateral received that cannot be spent; release on reduction, close, maturity and credit
event; a shared agreement and its allocations; Book isolation; a failed call retried without double
posting; a missing mark; and each amount once on Account, Treasury and Book balance sheets.
