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
| `server-client.js` | The server client (round of 2026-10-14): one integration layer, three interfaces (`market`, `analytics`, `ledger`), one gateway. Request plumbing (timeout and AbortSignal to fetch, bounded retries that never retry 401/403, TTL cache with invalidation, cursor/page pagination, refresh settings, subscription hook, selection tokens) and the response envelope. `app.data.server`. |
| `server-fixtures.js` | Demo fixtures for every server-client dataset, labelled "Demo fixture", with per-dataset failure modes. Demo mode only. |
| `server-integration.js` | The ledger interface (local only) and the idempotent recording of a server corporate action; attached from `app.js`. |

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

### Server client: three interfaces, one gateway (`server-client.js`, `server/server-api.js`)

The instrument-detail workspace reads Shaffer data through `app.data.server`, separate from the ports above (which
feed the paper engine's price cache and stay as they are):

```
 screens ── /api/server/* (server-api.js) ── app.data.server ──┬── market    ─┐
                                                               ├── analytics ─┴─ one gateway (SHAFFER_GATEWAY_URL,
                                                               │                 SHAFFER_API_TOKEN, server side only)
                                                               └── ledger    ── this Terminal's database (never remote)
```

- Every dataset is declared in `ports.js` `SERVER_DATASETS` (inputs, required fields, units, timestamps, freshness,
  pagination, point-in-time, errors). Its real mapping is one entry of `serverOperations` in `shaffer-contract.js`;
  `null` answers `state: 'awaiting'` with the operation name. Legacy port mappings (search, reference, quotes,
  history, fx, rates, corporate actions) are adapted when only they are filled in, so nothing is mapped twice.
- Every route answers one envelope: `state` (awaiting | loading | available | stale | unavailable | incomplete |
  error), `source`, `asOf`, `receivedAt`, `freshness`, `version`, `schema`, `coverage`, `items`/`data`,
  `missingFields`, `error {code, message, retryable}`, `requestId`, `selection`, `pagination`, `pointInTime`.
  Missing values are `null` with a reason (`nulls`), never 0. See docs/SERVER-CLIENT.md.
- Retries: bounded (settings `server.retry`, default 2 retries, 250 ms doubling, at most 4 s, a gateway
  `Retry-After` honoured within that); 401 blocks the interface, 403 the dataset for that subject, neither is
  retried until the connection is tested or changed.
- A record delivered twice in one list answer (same server ID) is listed once and reported in `duplicates`; a
  required field missing from list records makes the answer `incomplete` and is named with a count.
- Selection tokens: a newer `selection` on a `channel` aborts the older gateway request; a late answer for the
  older one is returned as `error.code: 'superseded'` and never cached.
- The client passes analytics through (a grep test guards it): no fair value, gap, score or signal is computed.
  Refreshing server data never writes to the ledger (a table-hash test guards it). Recording a server corporate
  action is an explicit user action, keyed `srv:<eventId>` (settings `server.ca:<key>` -> corporate action id), so
  a second delivery or a second click posts nothing.

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
(Foreign Derivatives). Views are filters, not accounting Books. A product's class (`cls` in the
catalog) decides the pair: cash products sit in US Based or Foreign Based, derivatives in the two
Derivatives views.

**Product-family tabs.** Inside each view the Marketplace is split into tabs (`MARKET_TABS` in
`catalog.js`): Equities; Funds and ETFs; Bonds and Credit; Money Market and Deposits; FX and
Currencies; Commodities; Crypto and Digital Assets; Alternatives and Other in the cash views, and
Options; Futures; Forwards; Swaps; Credit Derivatives; Structured and Other Derivatives in the
derivative views. `TAB_LISTS` gives every catalog product exactly one tab (tested; printed in
`docs/COVERAGE.md`). Derivative rows also carry an underlying asset class (`PRODUCT_ASSET`, or the
underlying's family for generic and exotic options) for the tab's filter. The tab is in the URL
(`#/markets/<view>/<tab>`), so Back and reload restore it; `/find/<text>` after it opens a search and
`/show/<instrument id>` picks a row out (the instrument page's Market view and the registry link there).
A view opened without a tab shows the tab last used in it (kept in the browser), else its first
family with instruments. Tabs show their counts; an empty tab says what belongs there and how to add
one. A search looks through every tab of the view (one table per family, each titled with its tab)
and also lists the matches in the other three Marketplaces with their view and tab, linked there.
Each tab has its own columns; Current market price, Fair price and Gap % sit together on all of them.
Watchlists are a separate control: they filter within a tab or show the list across families, and
never replace the tabs.

**Financing links.** Deposits, loans, repo and securities loans are arrangements of one Book: they
are arranged on the Treasury and Account pages, and the Money Market and Deposits tab links there
(they are never Marketplace rows). The instrument page of a stock, fund or bond has a Financing
panel: Repo this holding, Lend this holding, Finance this position (a securities-backed loan pledging
it) and Reverse repo against it open the Treasury / Account `ArrangementDialog` with the trading owner,
the instrument and the holding filled in (`preset: { instrumentId, productId, positionId }`); Borrow
this security turns the ticket to Sell short, because a securities borrow is always a leg of a short
sale. Every holding row (the ticket's positions and the Positions tab, which lists every owner's
holdings) has Repo, Lend and Finance for that holding and its owner. A link that does not apply is
disabled with its reason: no long holding, everything pledged or on loan, a short (covered by its
borrow), a product that cannot be sold short, or a product that is not financed this way (derivatives
fund premium, margin and collateral from cash; other cash products are bought with cash or a loan).
No new engine path is involved: the dialog previews and confirms as it does on those pages.

**Trading owner.** Tickets and the Strategies page ask for a Trading owner: the Book's Accounts, and
apart from them Treasury, labelled "Treasury (the Book's own balance sheet)". The owner in use is the
one chosen (sidebar or last ticket) or the Book's first Account; a Book with no Account has no default
and the Strategies page offers Treasury or New Account explicitly. Treasury-owned trading is supported.

**Marketplace routing.** Which of the two views an instrument sits in is decided from explicit
metadata, never from its price currency (`conventionRoute` in `catalog.js`, applied by
`instruments.js` on every create and edit):

1. *Listed*: exchange-listed with a listing-venue country. A US venue gives a US view, any other
   country a Foreign one. An ADR of a Swiss issuer listed in New York is US Based; a USD-quoted
   stock listed in Tokyo is Foreign Based. A listed product cannot be moved by hand.
2. *Financing*: loans, deposits, repo and securities loans are held on the Treasury and Account
   pages and never appear as Marketplace rows. Their view is kept as a record only: a stated
   jurisdiction, else a view the caller states, else the view of the security lent or taken as
   collateral, else the convention (Foreign). The Treasury dialogs no longer send a view worked out
   from the currency.
3. *Underlying*: a derivative with a registered underlying follows the underlying's view.
4. *Jurisdiction*: an unlisted instrument with a stated jurisdiction (the governing law of an OTC
   contract), or an issued security with an issuer domicile, follows that country.
5. *Convention*: global FX, crypto, and OTC products with none of the above have no US listing and
   no US jurisdiction. **They are routed by convention to Foreign Based / Foreign Derivatives.** A
   US view is kept for instruments with a positive US connection, so it never implies a US listing
   that does not exist. A USD interest-rate swap with no jurisdiction stated is therefore in Foreign
   Derivatives until its jurisdiction (US) is entered or it is moved by hand.
6. *Set by hand*: any instrument that is not listed can be placed in the other view by hand (the
   registration form, or an explicit `marketView` that differs from the convention).

An exchange-listed product with no venue country and nothing else to decide it must have its view
chosen by hand. The basis is stored (`instruments.routing_basis`, with `jurisdiction`, migration 8)
and returned as `classification.routing` (`basis`, `short`, `text`); the Marketplace row and the
instrument page show it. `GET /api/instruments/routing` tells the registration form what the
convention gives a draft. Rows stored before migration 8 are read against the convention: a view
that agrees shows the convention's basis, one that differs shows as set by hand.

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

A mark past its freshness limit (a model-derived or end-of-day value older than the limits under
Data connection, Refresh and freshness) still values a netting set, but the call made on it is
provisional: the movement's summary, the netting set and the position say "based on a stale mark
(as of ...)" and carry `provisional: true` with the stale observations (`staleMarks`) until a
current mark replaces it. A missing mark still stops the call. Manual marks are never stale.

Where collateral is shown:
- Accounting, Open positions: each OTC row carries `otcCollateral` (`accounting.openPositions`): the
  basis on record (agreement name, position-level terms, uncollateralized assumption, or "no
  collateral terms recorded"), the independent amount posted for it, and the variation margin of
  its netting set. Variation margin belongs to the netting set; where the set has several positions
  the amount is the set's and the row says "for its netting set of N positions".
- Treasury, Collateral and an Account's OTC collateral section (`web/views/agreements.js`); below
  1100 px their tables turn into one labelled block per row.
- The borrowing register (`accounting.borrowings`) carries the cash collateral of a securities
  borrow (`collateral.cash`, null while none is held); the Treasury and Account borrowing tables
  show it.

The no-basis block (`collateral-basis`) names the three choices and says where the basis is
recorded, as `collateral.basis.fix` on the preview leg: `draft` (a new contract on the package: its
terms), `position` (a position opened before bases were required, typically met through "Add legs":
`PUT /api/books/:id/positions/:positionId/collateral-basis`), `contract` (a registered contract
not yet traded: its terms) or `locked` (a traded contract: a new contract is needed). The preview
dialog offers the fix in place for the first three, from a Strategies-page template, "Add legs",
or any other package.

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
`GET /api/calendars` lists the calendars, their holidays and the payment calendar of each currency;
`PUT /api/calendars/:id/holidays` stores hand-entered closures (Settings, Market calendars). An
instrument's own calendars and settlement lag are its `conventions` (`tradingCalendar`,
`settlementCalendar`, `paymentCalendar`, `settleLag`), set on the registry form or, for a new OTC
contract, on the Strategies page leg ticket (same "Calendars and settlement" group); they stay
editable after the instrument has traded and apply to dates worked out from then on.

Settlement of a trade (`core/settlement.js`, `resolveSettlement`): the lag set on the instrument,
else the Book's assumption for the product, counted on the settlement calendar; or a settlement
date or lag stated for that one transaction (`leg.settle = { date }` or `{ lag }`). A stated date
that is not a business day on the settlement calendar, or is before the trade date, is a calendar
conflict: the preview blocks with the reason and nothing is re-dated silently. Futures, forwards
and financing arrangements have their settlement fixed by the product.

The trading calendar gates matching (`tradingDay` in `core/settlement.js`, applied in
`orders.tryOrder`). An order is not filled on a day that is closed in its instrument's trading
calendar: it stays working with the reason ("Market closed today on calendar X (...); will be
matched on <date>"), which the ticket, the preview (a warning, not a block), the working-order row
and the strategy show. The trade date and the settlement run from the day it fills, and the
preview counts them from that day. A Day order is good for the day it was placed, or for the next
trading day of its instrument when that day is closed, and expires at the end-of-day run of that
day (a leg that waits for other legs stays good as long as they are). This applies to trades,
securities borrowing and lending, cash loans and repos and their closing legs; internal legs
(Treasury funding, reservations, linking a held position) are not held back, and neither are
settlements, lifecycle events or accruals. `ALLDAYS` instruments are never closed; the
weekends-only fallback closes at weekends only. The end-of-day run itself follows New York
business days, so a Day order whose good-for day is a New York holiday expires at the next run.

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
   is recorded as a manual input. The fee schedule, its minimum included, applies to the order and
   not to each fill (`feeForFill` in `core/fillmodel.js`): a fill pays what the schedule gives for
   everything the order has filled including it, less what its earlier fills were charged. The
   minimum is therefore carried by the first fill, and an order filled in parts costs exactly what
   the same order filled at once costs.
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
When that guard refuses (`409 preview_changed`) nothing is submitted: the popup takes the new
preview from the refusal, lists what changed, was and now, per leg and per package total (the
preview dialog's `Changes` component), and executing the new figures needs a fresh confirmation.

**What a recommendation leaves to the desk.** Two things can be missing from a hedge leg that only
the desk can supply, and both are completed on the package preview, leg by leg, before execution
(`hedge.previewPackage(requestId, packageId, { collateral, statedPrices })`):

- *Collateral basis of an OTC leg* (swap, credit default swap, forward, OTC option). The service
  may state one on the contract (`terms.collateralBasis`); it is then shown as stated and validated
  like any contract's basis (`core/agreements.js`: the agreement exists, belongs to this Book, is
  active and covers the unit). Where none is stated, or the stated one cannot be used, the desk
  chooses it: `collateral: { [legNo]: { type: 'agreement', agreementId } | { type: 'position',
  independentAmount, variationMargin, threshold, minimumTransfer } | { type: 'uncollateralized' } }`.
  Nothing is assumed from the product; a leg with no basis blocks the preview (`collateral-basis`).
- *Fill price of a leg with no executable quote.* Indicative terms are never a quote.
  `statedPrices: { [legNo]: price | null }` states the fill (a manual input); without one the leg
  can only be submitted as a working order.

The preview's `hedge.completion` reports, per leg, where the basis came from (`origin`: `none`,
`recommendation`, `chosen`, or `contract` for a registered instrument), whether a choice is still
needed and why, the independent amount it calls for, and whether a fill price is needed; `missing`
lists what stands between the package and execution. The popup disables Execute now and says why
in plain words while anything is missing or blocking; warnings are acknowledged in the popup.

**Routes** (all in `server/api.js`; a request or queue row always carries `state`, `complete`,
`missing`, `connection`, `source` and `freshness`):

| Route | What it does |
|---|---|
| `POST /api/hedge/requests` | Build and store a request (one per primary: an open one is rebuilt in place); sent only when complete and the service can be reached |
| `GET /api/hedge/requests?bookId=` , `GET /api/hedge/requests/:id` | Stored requests of a Book; one request |
| `POST /api/hedge/requests/:id/complete` | Save missing or changed context (investment Strategy, holding period, objective, scope) under the same id |
| `POST /api/hedge/requests/:id/refresh` | Ask again in place against exposure as it is now; never executes |
| `POST /api/hedge/requests/:id/preview` | Price and check one package: `{ packageId, legs?, extraProtection?, collateral?, statedPrices? }`; returns the normal preview plus `hedge` (state, source, freshness, `completion`) |
| `POST /api/hedge/requests/:id/dismiss` , `POST /api/hedge/requests/:id/seen` | Dismiss or withdraw a request; mark a post-trade prompt as shown |
| `GET /api/hedge/prompts?bookId=` | Post-trade requests the interface has not shown yet |
| `GET /api/hedge/queue?bookId=` | The hedge review queue of one Book, with who is answering |
| `POST /api/hedge/refresh` | Refresh every waiting request now |
| `GET /api/hedge/service` | Who would answer a request right now (Shaffer Hedge, or a labelled fixture) |
| `GET /api/books/:id/protection` | Hedges with capacity and allocations, and each position's protection, for one Book |
| `GET /api/analytics/strategies?bookId=` | The investment Strategy list (IDs) and every Strategy reference in use in the Book |
| `POST /api/analytics/strategies/resolve` | The user confirms that a typed name is a listed Strategy: `{ bookId, name, id }` |
| `POST /api/strategies/preview` , `POST /api/strategies` | The normal package preview and confirmation; a hedge package is confirmed here with `hedgeLinkId`, `hedgePackageId` and `expected` |
| `GET /api/strategies/:id` | A strategy instance with `hedge` (requests, relationship lines, protection) |
| `POST /api/demo/hedge-fixture` , `GET/POST /api/demo/hedge-script` | Demo only: switch the demo fixture; load or clear a scripted service |

## Repeated requests (`server/http/once.js`)

Every mutating route accepts an optional client token (body field `clientToken`, or the
`Idempotency-Key` header). The first request with a token runs and its answer is stored
(`request_tokens`, kept 14 days); the same request again returns the stored answer with
`duplicate: true` and does nothing; another body under the same token is refused (409
`token_reused`). For a synchronous handler the effect and the stored answer commit in one
transaction. A refused request stores nothing. The web client sends a token with every mutating
request (`web/lib/core.js`), so a double click, a retry after a lost connection or a restart cannot
record anything twice. Exempt: the package confirmation (its own one-time preview token), the
read-only previews and connection test, and engine cycles, which are idempotent by construction.

## Integrity check (`core/integrity.js`)

`GET /api/books/:id/integrity` re-reads one Book's events, entries, fills, settlements, positions and
tasks and reports whether they agree with each other and with the accounting views: Book isolation,
balanced events, trial balance, net assets, Book equals its owners, settlements against the ledger,
positions against the ledger, gross holdings, and no duplicate fills, settlements, payments,
accruals or postings (the keys are listed in the file). Nothing is written. The product matrix
calls it after every step of every scenario.

## Demo and test fixtures (`data/demo.js`, `api.js`)

Demo mode only (403 otherwise):

| Route | What it does |
|---|---|
| `POST /api/demo/advance` | moves the demo clock (`{ ms }` or `{ to }`) and runs one engine cycle; the offset persists |
| `GET /api/demo/fixtures`, `POST /api/demo/fixtures/:kind` | controlled values for `quote`, `close`, `fx`, `rate`, `borrow`, each labelled "Test fixture" wherever it appears; a null value removes one |
| `POST /api/demo/hedge-fixture` | switches the labelled demo hedge fixture on or off (on plays the service reconnecting) |
| `GET`/`POST /api/demo/hedge-script` | a scripted hedge "service" for tests: responses in order, an optional Strategy list, stamped test-fixture |

## Server client routes (d1, 2026-10-14)

`GET /api/server/state`, `/api/server/datasets`, `/api/server/refresh` (`PUT` to change), `POST /api/server/cache/invalidate`,
`POST /api/server/test`; `GET /api/server/reference/search`, `/reference/:id`, `/quotes`, `/history/:id`, `/fx`, `/rates`,
`/profile/:id`, `/statements/:id`, `/earnings/:id`, `/earnings-window/:id`, `/filings/:id`, `/documents/:docId` (streamed
proxy, sandboxed), `/corporate-actions/:id`, `POST /api/server/corporate-actions/record`, `/news/:id`, `/analytics/:id`,
`/analytics/:id/runs`, `/ledger/:id`; product datasets (p1): `/ratings/:id`, `/yield-spread/:id`, `/option-greeks/:id`,
`/futures-curve/:id`, `/margin/:id`, `/fund-holdings/:id`, `/fund-facts/:id`, `/marks/:id`, `/fx-curve/:id`; the Terminal's
own `GET /api/instruments/:id/contract-facts` (`server/product-facts.js`); demo only: `GET|POST /api/demo/fixtures/server`
(modes available, stale, unavailable, empty, error, slow, partial, forbidden, throttled, offline, revised, duplicate,
currency-mismatch, unit-mismatch). 25 remote datasets plus the ledger interface. Details in docs/SERVER-CLIENT.md;
what the backend must supply in docs/DATA-CONTRACT-REQUIREMENTS.md; the phase-6 steps in docs/INTEGRATION-CHECKLIST.md.

## Routes added since the first edition

| Route | Module |
|---|---|
| `GET/POST /api/books/:id/agreements`, `GET/PUT /api/books/:id/agreements/:agreementId`, `POST .../close` | agreements as records |
| `GET /api/books/:id/collateral?scope=` | the collateral desk of a Book or of Treasury / Accounts: agreements, positions, netting sets, movements, failures, totals |
| `POST /api/books/:id/collateral/retry` | retries failed calls now (they are retried every cycle anyway) |
| `PUT /api/books/:id/positions/:positionId/collateral-basis` | records the basis of a position that has none |
| `GET /api/books/:id/integrity` | integrity report (above) |
| `GET /api/calendars`, `PUT /api/calendars/:id/holidays` | calendars and hand-entered closures |
| `GET /api/instruments/:id/settlement` | the settlement convention and calendars that apply to an instrument |
| `GET /api/books/:id/protection` | hedges with capacity and allocations, and each position's protection |
| `GET /api/hedge/service`, hedge request routes | hedge requests (see Hedge and protection) |

Confirmation tolerances are Book settings (`settings.confirmation`, defaults in `core/defaults.js`:
leg price 0.5%, leg amounts 0.5%, package totals 0.5%, gross cash and notional 0.5%, preview age
300 s), changed under Settings (`PUT /api/books/:id` with `settings`) and shown on every preview.

## Conventions (stated where the user sees them)

- Swap trades are worded with their legs: "Enter as written: pay fixed 4.000%, receive SIM-3M on
  10,000,000 IRS-X", or "Enter the opposite side: ..." with every leg's pay and receive swapped. A
  swap is never "bought" or "sold" (preview, order rows, Strategies page legs).
- A notional that changes inside a period: an increase earns and pays the whole current period on
  the added notional (the stated price is all-in); a position first opened inside a period pays
  from its trade date. Stated on the preview of an increase.
- Fixing dates are business days of the contract's joint payment calendar, not of each index's own
  market. Stated in the swap's contract terms ("Fixing dates").
- Principal a forward-starting cross-currency swap will exchange is announced in the preview, not
  set aside; if it has been spent the exchange fails visibly on the day and waits. A shortfall at
  settlement names "principal exchanged when the trade settles" apart from purchases.
- A swap's mark is its value per 100 notional including interest accrued since the last payment
  (the ledger accrues nothing between payment dates) and excluding principal already exchanged on a
  cross-currency swap. Stated on both manual price forms.
- Balance-sheet lines in a foreign currency are converted and rounded one by one, net assets once per
  currency, so lines can differ from net assets by a cent. Stated on the balance sheet.
- An FX forward's notional before a rate is known is its base-currency amount, labelled in that
  currency and counted in that currency's gross notional.
- A blocked lifecycle task of a position is looked at again in the engine pass in which another task
  of the same position completed (a swap matures in the pass that makes its final payment).
- An option on a published index can name the index and an index level code instead of a registry
  underlying; it settles in cash on the level for its expiration date. A catalog kind for a
  non-tradable reference index does not exist: inflation legs still use a stand-in instrument.

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
| `app.js` | Shell, routing, Book selector, sidebar (Accounting, Treasury and its Accounts, Strategies, Marketplaces, Reference), Account in use, connection state, demo clock. Below 1100 px the top bar takes a second line; below 820 px the sidebar is a drawer behind a Menu button, with Manage Books, the connection chips, the clock and the theme control at its top |
| `lib/core.js` | API helpers, shared state, live reload, number formatting |
| `lib/ui.js` | The UI kit: prices with provenance, missing values, waiting states, tables, dialogs, charts |
| `lib/contracts.js` | Instrument picker (with the Book's holdings) and schema-driven contract forms per family |
| `views/*.js` | One file per screen, loaded on demand |

The server pushes a change event over `/api/stream` when the engine does something, and screens
reload their data; a slow poll covers a dropped stream.

### Instrument-detail workspace (`views/workspace-model.js`, `workspace.js`, `instrument-page.js`, `instrument.js`, `views/tabs/`)

```
 any screen ── openInstrument(id) ──> drawer (instrument.js): header + Trade / Overview / Positions / History tabs
                                         └── Open full page ──> #/instrument/<id>/<tab>[/asof/<date>] (instrument-page.js)
 header (workspace.js)  ── /api/instruments/:id/detail (execution quote, holdings; never "as of")
                        ── /api/server/analytics/:id?strategyId=  (Fair price, Gap % for the chosen Strategy)
                        ── /api/server/reference/:id              (stable server ID)
 tab contents (tabs/*.js, tabs/product/*.js, registered with registerTabContent) ── /api/server/<dataset>/:id
```

- `workspace-model.js` (pure, tested in `test/core/workspace-model.test.js`): the dataset routes, the tabs per
  family and the "not covered for this product" list, `gapOf()` (a supplied gap passed through only when the fair
  value is in the quote's currency and units; a gap worked out only for matching currency, units and a positive
  price), and `createSelection()`: one selection per instrument and screen area (`drawer` or `page`), every request
  carrying `requestId` and `selection`, superseded requests aborted, a late or foreign answer discarded
  (`window.__sdtWs.discards` for the tests).
- `workspace.js`: `useDataset()` turns each answer into one of the seven states and keeps an earlier selection's
  data from being drawn under a newer header; a panel in a retryable error (or holding a cached copy after a failed
  refresh) asks again with `fresh=1` every `RECOVER_MS` (5 s), so panels recover by themselves after a
  disconnection. `DatasetPanel` draws the state, source, timestamps, version, refresh interval, the request ID, the
  as-of line and a Refresh button.
- Per-browser-tab choices (sessionStorage): the investment Strategy chosen in the header (`sdt.ws.strategy`), the
  statement view and period counts (`sdt.ws.statements`), the page's origin for Back. The tab and research date are
  in the address. Nothing of the server's answers is stored in the database; the server keeps refresh settings,
  fixture modes (demo) and the links of recorded corporate actions.
- Trade from the page opens the ticket in the drawer with the instrument, Book, owner and Strategy; the package
  records `origin: 'instrument-detail'` and the Hedge workflow opens after the fill, as for a Marketplace trade.

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

`test/core/collateral-followup.test.js` covers calls on stale marks (provisional, named on the
movement, set and position; a missing mark still stops the call), collateral on Accounting position
rows, the cash collateral of a securities borrow, and where the no-basis block says the basis is
recorded. `test/core/labels-conventions.test.js` covers the conventions above with hand-worked
figures.

### Product test matrix (`test/matrix/`)

One scenario per catalog product, written once as data (`test/matrix/specs/*.mjs`) and run at three
levels against disposable databases: engine (`npm test`, or `node --disable-warning=ExperimentalWarning
--test test/matrix/engine.test.js`), API (`npm run test:api`) and browser (`npm run test:browser`,
Playwright and Chromium outside the repository). Options: `-- --family=equity`, `-- --product=adr,etf`,
browser `--workers=1 --headed --slow=150`. After every step the whole expected state is compared and
the integrity report must be clean; the browser level also reads the Accounting screens. `npm run
matrix` writes `docs/TEST-MATRIX.md` from the catalog, the specs and `test/matrix/results/*.json`.
Details in `test/matrix/README.md`.

### Instrument-detail workspace tests

`npm run test:workspace` (`test/workspace/run-browser.mjs`) starts a sandboxed demo server and drives Chromium
through navigation, request discipline, the as-of view and trading from the page, then every file in
`test/workspace/checks/` (e1, e2, e3 and p1 tabs; `i1-failure-modes.mjs` for the owner's failure-mode list:
empty and partial answers, stale data, revisions, pagination, errors and throttling, disconnection and recovery,
rapid switching in the drawer and on the page, duplicates, currency and unit mismatches, persistence across a reload
and a server restart; `i1-open-items.mjs`). Each check file also runs alone (`node test/workspace/checks/<file>`).
`test/core/server-integration.test.js` covers the same list at route level and hashes the paper ledger before and
after every route, fixture mode, reconnection, Strategy and research date.

### Failure and recovery suite (`test/system/`)

Cases in `test/system/cases/` (refusals, stress, no duplicates, history, Book isolation, hedge
reconnection) run at engine level inside `npm test` (`test/system/engine.test.js`), at API level
with `npm run test:system:api` and in the browser with `npm run test:system:browser` (options
`-- --area=refusals --case=cash-trade`, browser `--headed --slow=150`). Each case gets its own server
process and database; some kill and restart it. Results go to `test/matrix/results/system-*.json`.
