
## v1b (hedge follow-up), 2026-10-07: two findings outside my files, not fixed

1. **A currency forward's notional before a rate is labelled in the wrong currency** (server/core/packages.js,
   `estimateLegs`, the no-price branch: `row.notional = inst.family === 'forward' && ... ? l.qty : e0.notional`, with
   `row.currency = inst.trading_ccy`). For "Sell 2,924,000 JPY/USD forward" the preview row carries notional 2,924,000 and
   currency USD, so the preview dialog shows "2,924,000.00 USD" and the confirmation snapshot adds 2,924,000 to the USD
   gross notional. Once a rate is stated it becomes 19,818.33 USD (right). What is right: before a rate the figure is
   the JPY amount and should be labelled JPY (or left out of the USD gross notional). Reproduce: demo, buy KAIJ, hedge
   popup, "JPY currency forward", Inspect or edit: the "Notional, margin" column. The hedge popup's own leg card now
   labels that figure in the base currency (web/views/hedge.js); the preview dialog and the snapshot are unchanged.
   > **Status (fix, 2026-10-13):** FIXED. Before a rate, an FX/NDF forward's notional is the base amount, labelled in the base currency (`row.notionalCcy`, server/core/packages.js); the confirmation snapshot adds it to that currency's gross notional (confirmation.js); the preview labels it so (preview.js). An asset forward's notional without a price is now missing, not the quantity. Test: test/core/labels-conventions.test.js.
2. **A swap floating-leg payment that is exactly half a cent rounds down** (server/products/swap.js `legAmount`, then
   `money()`). Equity TRS, notional 81,590, SIM-ON 4.00% + 0.50%, 2026-10-06 to 2027-01-06 (92 days, ACT/360):
   81,590 x 0.045 x 92 / 360 = 938.285 exactly; the Terminal paid 938.28 because the day-count fraction 92/360 is a
   binary float (the product is 938.28499...). Half-up gives 938.29. One cent; the convention for exact halves should be
   decided and the amount computed as notional x rate x days / 360 in that order (or in integer minor units).

   > **Status (fix, 2026-10-13):** Already FIXED by s1 (swap.js, test/core/swap-rates.test.js); nothing left.
## b1 (bond family, government group), 2026-10-07: two findings outside my files, not fixed

1. **Bond prices are displayed to three decimals, so a price in 32nds or 64ths is not shown as quoted**
   (`web/lib/core.js` `fmtPrice`: at most 3 decimals for a value of 10 or more; used by the trade preview's "Estimated
   fill" and "reference", the ticket's bid / ask, the Positions table's average cost and price, the instrument drawer).
   A Treasury note filled at 99.53125 (99-17) shows "99.531" in the preview and in Positions; 99.515625 shows "99.516".
   Every cash figure beside it is right (995,312.50 for 1,000,000 face), and the history line prints the full price
   ("Bought 1,000,000 UST-4-NOV30 @ 99.53125 USD"), so nothing is mis-booked; but the displayed price times the face
   does not reproduce the displayed principal (1,000,000 x 99.531% = 995,310.00). What is right: a price in % of par
   shown with the decimals it has (up to 6, as the server's `fmtPx` does). Not fixed because `fmtPrice` has no
   instrument context and is called from the preview, Accounting, the Marketplaces and the instrument drawer, all in
   other people's areas: it needs a units-aware variant (the leg and the position both carry `priceUnits`).
   Reproduce: `npm run test:browser -- --product=treasury_note --headed`, or register any bond, quote it at 99.53125
   and open the buy preview. The matrix compares a displayed figure to the decimals shown, so this does not fail a step.

   > **Status (fix, 2026-10-13):** NOT TOUCHED: owned by ui1 (web/lib/core.js bond price format), per the coordinator.
2. **Two strategy instances with the same name are listed in an arbitrary order in Accounting, Positions** (cosmetic;
   `web/views/accounting.js`, the sort of the Positions table: owner, strategy name, then strategy id, which is random).
   Product corporate_bond, step second-lot onwards: two purchases of one bond are two instances both named
   "Long HALDEN-5.4-MAR32"; which lot is the first row changes from one database to the next, and nothing in the row
   says which instance it is. What is right: the older instance first (opened_at, as the API lists them). Not fixed:
   shared view. The browser check now tells two equal-sized lots apart by their average cost (drivers/browser.mjs).

   > **Status (fix, 2026-10-13):** FIXED. Accounting rows carry `strategy.openedAt`; Positions sort by owner, name, opened time; the group heading shows when it was opened and, when names repeat, the instance ID (web/views/accounting.js, server/core/accounting.js). Test: test/core/collateral-followup.test.js.
## o1 (listed options), 2026-10-07: one gap outside my files, not fixed

1. **No catalog product for an index, so an index option's underlying is a stand-in** (server/core/catalog.js; the
   option registration form in web/lib/contracts.js requires an underlying instrument of family equity, fund, future,
   spot, crypto or bond). Product index_option, every step. What the Terminal does: an index option cannot be
   registered through the form without a registry underlying, and no catalog product represents a published index
   level. The scenario registers the level as a reference instrument of product "ETF" (named "... Index (reference
   level)", quoted with a last value only); the Terminal then treats it as a tradable ETF everywhere. What is right:
   an index level is not tradable and should be a reference instrument of its own kind (or the listed-option form
   should accept a named index with a fixing code, which `normalizeOption` already allows through the API with
   `terms.underlyingDescription` / `terms.fixingRate`, but the form has no field for either). Not fixed because it
   changes the catalog inventory or the shared form. Also note: an AM-settled series settles against whatever fixing
   exists for its expiration date; if the settlement value is not entered by hand before that day's close of the
   reference instrument is supplied, the engine settles on the close. Reproduce: Instruments, New instrument, Index
   option: "Underlying (required)" lists registry instruments only.

   > **Status (fix, 2026-10-13):** PARTLY FIXED. The listed-option form now takes a named published index and its index level code when no registry underlying is chosen (web/lib/contracts.js); settlement reads the level under that code, like a rate fixing (engine test: labels-conventions.test.js, index option settled in cash). NOT done: a catalog kind for a non-tradable reference index. That changes the catalog inventory (205 products), the registry form, Marketplaces classification (ui1) and valuation of every instrument that can name an underlying: a redesign, not a fix. The index_option spec's ETF stand-in is left as its author wrote it.
## s1 (swap family, rate products), 2026-10-07: findings outside my files or left as they are, not fixed

(Fixed in my own file and covered by test/core/swap-rates.test.js, so not listed below: v1b's item 2 above, the half
cent on a floating payment; the 7-day fixing look-back; OIS on a 360 basis whatever the day count; cross-currency
principal paid from cash that was not there; a swap's stated trading currency replaced by leg A's; a return leg's
start fixing never asked of the data service; a return or price fixing asked for a weekend date.)

1. **Preview and strategy leg labels say "Buy 10,000,000 IRS-..." / "Sell ..." for a swap** (`server/core/packages.js`
   `legLabel`, `describeOrder`; the preview table and the strategy instance's order rows). Every swap product, every
   trade step. The ticket itself says "Enter as written" / "Enter the opposite side" and the history now says
   "Entered as written", "Increased", "Terminated in part", "Terminated" (swap.js), but the leg rows between the two
   still say Buy and Sell. Right: the same words as the ticket. Not fixed: shared core, and the browser harness
   matches trade rows with `/^(Buy|Sell)/` (drivers/browser.mjs `previewDisplayProblems`), so both change together.
   > **Status (fix, 2026-10-13):** FIXED. A swap trade reads "Enter as written: pay fixed 4.000%, receive SIM-3M + 0.25% on 10,000,000 IRS-X" (or "Enter the opposite side: ..." with the sides swapped) in the preview, on the order rows and on the Strategies page legs (swap.js swapTradeLabel, packages.js legLabel/describeOrder, strategy.js describeLeg); a CDS uses its own action labels. Browser harness regex widened (drivers/browser.mjs). Test: labels-conventions.test.js.
2. **No catalog product for a published index, so an inflation leg's index is a stand-in** (same gap as o1's item
   above). zc_inflation_swap and yoy_inflation_swap register the CPI as a "Physical / spot commodity" that is never
   traded, and supply its fixings as instrument prices "for a date". The Terminal lists it as a tradable asset.
   Right: a reference index of its own kind (not tradable), or an index code on the leg served like a rate fixing.
   The Terminal also applies no publication lag and no interpolation: the fixing asked for is the index for the
   period's first and last day (last business day before, when that is not one).
   > **Status (fix, 2026-10-13):** NOT FIXED, redesign (same reason as o1 item 1): an index code on a swap leg served like a rate fixing, with publication lag and interpolation, is new swap mechanics plus a reference-index kind; the stand-in stays and is labelled in the spec.
3. **The OTC ticket of the Strategies page has no market view, calendar or symbol fields** (`web/views/strategy.js`,
   "New OTC contract"). constant_maturity_swap, step open. A contract entered there is always US Derivatives on the
   US market calendar (payments on it joined with each leg currency's calendar) and has no symbol, so it is shown by
   its full name everywhere. A euro contract entered there would settle on New York days. Right: the same
   "Calendars and settlement" group and Primary view as the registry form. Reproduce: Strategies, Custom, Add a leg.
   > **Status (fix, 2026-10-13):** FIXED. The Strategies page "New OTC contract" leg now has Symbol, Primary view (US / Foreign Derivatives) and the registry's Calendars and settlement group (ConventionFields exported from web/views/registry.js; conventions sent with the contract). Looked at on screen; constant_maturity_swap (entered on the Strategies page) passes at browser level.
4. **A swap whose last payment was released late matures one engine pass later** (`server/core/engine.js` runs due
   tasks once, in due-date then creation order; the maturity task is older than the last payment's). interest_rate_cap
   step fixing-entered-by-hand, constant_maturity_swap step cms-fixing-entered-by-hand: after the fixing is entered
   the payment is made and the maturity row still reads "blocked: Waiting for the final leg payments" until the next
   pass (a few seconds with the engine timer on; the scenarios use a `cycle` step). Right: blocked tasks of a
   position looked at again in the pass in which another of its tasks completed.
   > **Status (fix, 2026-10-13):** FIXED. server/core/engine.js processTasks looks again, in the same pass, at the blocked tasks of a position where another task has just completed. Test (fails without the fix): labels-conventions.test.js. The cap and CMS specs now expect maturity in the fixing step (test/matrix/specs/swap-rates.mjs); both pass at engine, API and browser level.
5. **"Close share %" cannot state an exact notional** (strategy instance, Close). 33.3333% of 30,000,000 gives
   9,999,999. The scenarios use exact percentages. Right: a notional field beside the percentage for contracts.
   > **Status (fix, 2026-10-13):** FIXED. Strategy instance, Manage: "Close an exact notional" (position and amount) beside the share, button "Preview close of this amount" (strategy-detail.js). Engine path tested: 10,000,000 of 30,000,000 leaves 20,000,000 (labels-conventions.test.js).
6. **A position's own margin figure is its independent amount only**; variation margin posted for it shows in the
   cash "margin" bucket and on Treasury, Collateral, not on the position row (interest_rate_collar, step
   variation-margin-call: position margin 0 while 30,000 is posted). By design (variation margin belongs to the
   netting set), but the row gives no hint. `server/core/agreements.js` area.
   > **Status (fix, 2026-10-13):** FIXED. Accounting, Open positions: every OTC row shows its collateral basis, the independent amount posted, and the variation margin of its netting set, labelled "for its netting set of N positions" when it is the set's (accounting.openPositions `otcCollateral`; accounting.js view). Test: collateral-followup.test.js.
7. **Marks: nothing on the manual price form says what a swap's mark must contain.** The Terminal accrues nothing in
   the ledger between payment dates, so the mark has to include interest accrued; and for a cross-currency swap the
   principal exchanged is on the balance sheet (lent / owed, at the current rate), so the mark has to exclude it or it
   is counted twice. Both are stated in the spec header and asserted; a hint on the form (web/views/data.js) is due.
   > **Status (fix, 2026-10-13):** FIXED. Both manual price forms (Data connection, Manual entries; instrument page) state, for a swap, that the mark includes interest accrued since the last payment and excludes principal already exchanged on a cross-currency swap.
8. **Two rules for a notional that changes inside a period** (swap.js, left as it was and documented): an increase
   takes the whole current period on the added notional, while a position first opened inside a period pays from its
   trade date. Either is defensible with an all-in price; they are not the same rule.
   > **Status (fix, 2026-10-13):** CONVENTION, now stated where it applies: the preview of an increase to a running swap carries the note (swap.js economics) and docs/ARCHITECTURE.md describes both rules.
9. **Balance sheet lines in a foreign currency can foot one cent off net assets** (`server/core/accounting.js`):
   each line is converted and rounded on its own, the NAV converts the currency's net total once.
   cross_currency_basis_swap, step second-quarter: cash 10,394,382.69 + lent 9,615,384.62 - 10,000 = 19,999,767.31,
   assets shown 19,999,767.30. Cosmetic; the totals are right.
   > **Status (fix, 2026-10-13):** CONVENTION, now stated on the balance sheet note (each line converted and rounded on its own; net assets convert each currency's net once) and in docs/ARCHITECTURE.md.
10. **Fixing dates follow the contract's joint payment calendar, not each index's own** (swap.js `fixingDate`, a
    convention, documented): on the USD/JPY swap the term SOFR fixing for the period starting 23 September 2026 (a
    holiday in Tokyo, like the 21st and 22nd) is Friday 18 September's, though New York was open on all three days.
   > **Status (fix, 2026-10-13):** CONVENTION, now stated in the swap's contract terms (a "Fixing dates" row naming the calendar) and in docs/ARCHITECTURE.md.
11. **Principal a forward-starting cross-currency swap will exchange is announced, not reserved.** The preview says
    what is due on the effective date and whether the cash is there today; nothing sets it aside, so if it is spent
    the exchange fails visibly on the day and waits (cross_currency_swap, step initial-exchange-unfunded). And the
    shortfall message of a trade that cannot pay its principal calls it "purchases" (generic text in packages.js).

   > **Status (fix, 2026-10-13):** Message FIXED: a shortfall now names "principal exchanged when the trade settles" apart from purchases (packages.js; xccy spec regex updated). Not reserving is a CONVENTION already stated in the preview note ("it is not set aside now") and now in docs/ARCHITECTURE.md; reserving it would hold cash for months ahead, a design change the owner has not asked for.
## b2 (2026-10-13): two "Preview close" buttons in the strategy Manage panel break browser close steps
- Since commit 008a80d the Manage panel of a strategy instance (web/views/strategy-detail.js) has a second "Preview close"
  button ("Close an exact amount"). `ui.button(drawer, 'Preview close')` then matches two elements (Playwright strict mode)
  and every browser `close` step with `scope: 'strategy'` fails with "strict mode violation" (found by foreign_market_bond, close).
- Fixed in the shared driver (test/matrix/drivers/browser.mjs, close path): the button is taken inside the field
  "Close, share of every position". NOT fixed (other people's drivers, same pattern): test/matrix/drivers/browser/future.mjs:139
  and test/matrix/drivers/browser/swap.mjs:244 still call `ui.button(drawer, 'Preview close')`; scope them the same way.
   > **Status (fix, 2026-10-13):** FIXED at the source: the exact-amount button is now "Preview close of this amount", so "Preview close" names one button again; interest_rate_swap, interest_rate_cap and cross_currency_swap pass at browser level.

## fix (2026-10-13): red engine test in another area, not investigated
- `npm test`: "matrix E: commodity_future" fails at its delivery-refusal step: the spec expects `Unknown lifecycle action "deliver"`,
  the Terminal now answers "Physical delivery does not apply to this position." Someone has added a `deliver` lifecycle action
  (server/api.js or a plugin); the futures spec (test/matrix/specs/future*.mjs) needs its expected refusal updated by its owner.

## ui1 (Marketplaces, classification, trading owner), 2026-10-13

- **b1 #1 (bond prices shown to three decimals): fixed.** `web/lib/core.js` `fmtPriceUnits(x, units)` keeps every
  decimal (up to 6) of a price in % of par or per 100 notional; `Price` uses the observation's units; the trade
  preview (estimate, reference, indicative, linked average cost), Accounting positions (average cost, price) and the
  instrument drawer (bid / ask, price, average cost) use it. Checked in the browser: 99.53125 and 99.515625 are shown
  in full. Order and fill tables in Accounting (limit, stop and average fill prices) still use `fmtPrice`: not changed.
- **Open, not mine: `equity_option` browser setup fails** at "Underlying (required)": commit d955ccf made the option
  underlying optional (index options), so the label no longer carries "(required)" and
  `test/matrix/drivers/browser/option.mjs` (registration of the option) times out. Every option and option-template
  browser scenario stops at setup until the driver matches `/^\s*Underlying/`. Reproduce:
  `npm run test:browser -- --product=equity_option`.
- **Open, not mine: the shell overflows at 390 px** on some screens (top bar and demo band 416 px wide, seen on
  Accounting and the Marketplaces on 2026-10-13 earlier in the day; later runs measured 390). `web/app.js` / `web/app.css` shell.
- **Note for treasury.js (fixer):** `ArrangementDialog` still sends `marketView: viewFor(ccy)`, a view chosen by
  currency. It is harmless now (a financing arrangement is stored with routing basis "financing" and is never a
  Marketplace row), but the currency-based `viewFor` could be dropped.

## s8 (failure, recovery and isolation), 2026-10-13, browser level and level mapping

- **Open, not mine (routing, ui1): an exchange-listed derivative with no venue country is routed by the "OTC"
  convention.** `server/core/catalog.js` `conventionRoute`, last line: `... || product.cls === 'deriv'` gives an
  `equity_option` with `venueType: 'exchange'`, no venue country, no underlying and no jurisdiction the view Foreign
  Derivatives, basis "convention", and `routingText` describes it as "OTC, no US listing: routed by convention to
  Foreign Derivatives" although it is marked exchange-traded. The route `GET /api/instruments/routing` has a reason
  for exactly this case ("... is exchange-listed but no listing-venue country is recorded ... choose the view by hand")
  that this line makes unreachable for derivatives. Reproduce: `GET /api/instruments/routing?productId=equity_option&venueType=exchange`.
  Found by SB:refusals:incomplete-terms (its first step, "nothing decides the market view", now uses a Treasury note
  marked exchange-traded, for which nothing decides the view; the option's own incomplete terms are still refused).

- (fw, 2026-10-13) `matrix E: convertible_preferred` (test/matrix/specs/equity.mjs, step automatic-conversion) is red:
  a `put` / `convert` position lifecycle action was added to server/api.js (bond structured work) and now answers
  "This event applies to debt securities." where the equity spec asserts `Unknown lifecycle action "convert"`. Same
  pattern as the commodity-future `deliver` case: the spec owner should decide what a conversion request on a
  convertible preferred must do (refuse with a specific reason, or convert) and change the step with hand-worked
  figures rather than loosen it. Reproduce: `SDT_MATRIX_PRODUCT=convertible_preferred node --test test/matrix/engine.test.js`.

- (fw, 2026-10-13) FRA reduced by an opposite trade books the locked-in difference undiscounted. server/products/fx.js
  `forward.fill`: closing part of an FRA realizes closing x (price - dealt) x d/100 and creates a settlement for it on
  the value date (the period start). Two offsetting FRAs with the same dealer settle at the period start for
  N x (K2 - K1) x d / (1 + L x d): the locked-in amount must be discounted at the fixing L, which is not known at the
  time of the offset. Effect: overstated by the factor (1 + L x d), about 0.6% for a 3-month period at 2.4%. Not fixed
  (needs the closed part's amount held until the fixing, and the maturity task kept alive when the position is flat).
  The forwards spec avoids it: FRA reductions there use early termination at a stated amount. Reproduce: buy an FRA,
  sell part of it from the strategy instance, then supply the fixing: the settlement of the closed part equals the
  undiscounted figure.

- (fw, 2026-10-13 ~19:00 UTC) `npm test`: system cases SE:isolation:book-routes and SE:stress:repeated-requests fail
  because a new route `POST /api/tasks/:id/settlement-value` (server/api.js, basket / spread option settlement value by
  hand; OTC options work, test/matrix/drivers/browser/otcoption.mjs) is not classified in either system case's route
  list (test/system). The route's owner should add it to both lists with its repeat-safety rule.

- (b3, 2026-10-13) RESOLVED: the `convertible_preferred` entry above (fw). server/api.js now routes `put` / `convert`
  to the bond plugin only for debt securities; any other family answers `Unknown lifecycle action "<action>"` as before.
  convertible_preferred passes again at engine and API level.

- (b3, 2026-10-13) Structured bonds, limitations established while testing structured group A (bond-structured-a.mjs).
  None is presented as supported; each is stated in the spec headers and matrix metadata.
  1. Inflation index: the index ratio is entered by hand and stays constant until the next entry; the Terminal does not
     interpolate a daily reference CPI (needs an inflation-index feed from Shaffer MarketData). Recording a new ratio while
     a trade is unsettled re-values that trade's accrued at the new ratio (the cash already agreed is not changed).
  2. Gilt (and old Bulldog) ex-dividend periods are not modelled: a coupon belongs to the face settled before the coupon
     date. A trade settling in the seven business days before a gilt coupon would book accrued wrongly.
  3. Call and put notice periods are not modelled: a call or put is recorded on its redemption date. A make-whole call
     price is not computed (needs a Treasury curve from Shaffer Analytics Lab); only the scheduled call prices are accepted.
  4. A paydown (or loss) must be recorded before trades that settle in its month are booked: a factor recorded after such
     a trade does not re-price it, and a position that was sold out before the factor is recorded but was entitled at the
     record date is not paid the principal (record it as a manual cash flow). A full fix needs the monthly factor
     schedule from Shaffer MarketData (factor feed) ahead of trading, or re-pricing of booked trades.
  5. Yield maintenance / prepayment premiums are not computed (need loan terms and a Treasury curve: Shaffer Analytics
     Lab); they are recorded by hand as a manual cash flow (category Coupon).
  6. Contingent convertibles: the trigger is recorded as a write-down (partial, permanent). A conversion-type trigger
     into shares at an instrument-wide forced conversion is not built (a holder conversion exists for convertibles only);
     a full write-down (factor 0) is recorded on each position as an early redemption at 0. Write-up of a temporary
     write-down is not built.
  7. Conversion and exchange into shares in another currency are refused. Cash in lieu uses a share price entered by
     hand. Accrued interest is always forfeited on conversion (US practice); a market that pays accrued on conversion is
     not supported.
  8. Cosmetic: after a delayed MBS coupon paid at a rounded amount, a 0.01 accrual event can appear (the rounding cent
     returns as income). The minimum-denomination refusal prints the step without a thousands separator
     ("multiple of 200000", server/core/packages.js); other specs assert that text, so it was left.
  9. Not exercised for these products: short sales, Treasury-owned linkers or convertibles, partial calls of a short.

## o2 (OTC options), 2026-10-13
- Harness, test/matrix/drivers/browser.mjs readScreens (history): once, on B:commodity_option:settle-termination, the screen
  check reported "history event #31 (settlement.receive) is not in the audit trail"; an immediate re-run passed and the
  later clean runs passed. The Audit trail table appears to be read as soon as its heading is drawn, possibly before its
  rows for the latest events are loaded. Not fixed (shared harness). Reproduce: run `npm run test:browser -- --product=commodity_option`
  under load; look for the message above.

## r1 (repo and secloan families), 2026-10-13
- secloan plugin, `secloan.fee` task (server/products/financing.js, runTask): when the engine reaches a monthly fee date for
  the first time after the day itself (the Terminal not running that day, or the clock moved past it), the fee is accrued
  and paid to the day the task runs, not as of its due date (loans and repos settle as of the due date). The matrix
  scenarios step onto each fee date, so no expectation depends on it. Not changed because the equity and bond short-sale
  scenarios of other families also carry secloan fee tasks. Reproduce: lend a security on 2 March, move the clock straight to
  10 April: the fee paid on 10 April includes 1 to 10 April.
- Not mine, seen in `npm test`: system cases SE:isolation:book-routes and SE:stress:repeated-requests fail because the route
  POST /api/tasks/:id/settlement-value (added by someone else) is not classified in those cases; matrix spec audit of
  cds_swaption fails (o3's spec in progress).

## b4 (bond family, structured group B), 2026-10-13
- server/core/positions.js `tradeMath` (shared core, not changed): the cost removed by a partial sale is
  `money(avg * closedSigned)` with `avg = cost / qty` computed in binary floating point. When the exact cost removed is a
  half cent the product lands just below it and rounds DOWN, against the half-away-from-zero rule `money()` applies
  everywhere else. Found by specified_pool (first draft): cost 4,857,652.35 on 5,000,000 face, 1,500,000 sold: exact cost
  out 4,857,652.35 x 1.5 / 5 = 1,457,295.705 -> 1,457,295.71 by hand; the Terminal removes 1,457,295.70 (JS gives
  1,457,295.7049999998), so realized differs by 0.01. Fix: pre-round
  the product to 9 decimals. Left open because every family's partial sale goes through it; the spec now sells 1,600,000.

## t1 (templates): a pending cover's payable is counted against free cash although it settles from restricted cash
- Where: server/core/ledger.js `cash()` (availableToTrade / availableToWithdraw count every pay.settle balance, including a
  buy-to-cover whose settlement row goes `into cash.restricted`).
- Found by: T:short (templates-a.mjs), steps close-share .. close-kept: after covering one short, availableToTrade drops by the
  cover's cost although the order engine pays it from the short's restricted collateral (orders.js tryTrade adds the position's
  restricted cash) and settlement takes it from restricted cash (then releases the surplus).
- Effect: with little free cash, the cover of a second short the same day is refused by the preview ("Alpha is short ...") while
  the order engine would accept it; availability can even go negative. The preview now counts the package's OWN cover against
  its short's collateral (packages.js, coverCollateral, t1), but not other covers still settling.
- Right: a payable settling into cash.restricted should reduce free cash only by what exceeds that position's restricted cash.
- Not fixed by t1: the equity short_sale spec (equity.mjs, cover-part) states the current figures (availableToTrade 450,383 counts
  the cover payable); changing ledger.cash changes that finished family's expectations. Needs the equity owner's decision.
- Reproduce: T:short with the Treasury top-up step removed: close-exact is refused at the preview.

## s7 (accounting verification), 2026-10-13
- FIXED (not open): balance sheet retranslated capital and internal funding at today's FX rate, so "Results to date"
  differed from the P&L by the FX on foreign capital/funding (server/core/accounting.js balanceSheet; proved by
  test/core/accounting-verification.test.js). Listed here for the record only.
- OPEN, owner decision: short positions, written options and negative-value contracts reduce the "Positions at market
  value" asset line instead of appearing as liabilities (GAAP: securities sold short are a liability). Net assets are
  right and gross long/short are in Holdings; changing it alters the balance-sheet layout 160+ specs assert.
- OPEN, test fixtures: POST /api/demo/fixtures/quote refuses negative prices, so an out-of-the-money swap/CDS mark
  cannot be a (stale-able) fixture; manual marks can be negative but never go stale.
- Convention noted: a cash dividend posts on its pay date; no receivable between ex-date and pay date.

## t1 (templates A), protective put / protective call, 2026-10-13
- FIXED (not open): a protective call exercised (or a covered put assigned) delivered shares that covered the short, but
  the securities borrow stayed open, its fee accruing against nothing sold short, and the strategy never closed
  (server/products/option.js settleOption now returns the freed borrow; test/core/templates-t1.test.js).
- FIXED (not open): resizing a protective/covered package added option legs that did not wait for the added underlying
  (server/core/packages.js growLegs); protective/collar template option legs did not wait for the stock leg (templates.js).
- OPEN, minor: linking an existing short into a new strategy (protective call on an existing short) moves the position
  and its borrow, but its restricted collateral stays booked to the old strategy instance: the next mark releases it
  there and posts the same amount again for the new one (net cash effect nil; the audit trail shows release + post
  instead of a transfer). Reproduce: T:protective_call, step next-day (released 4,999 / posted 5,100).
- OPEN, wording (t1, covered call): the interim-cash refusal (server/core/packages.js, "short ... while the legs
  execute") always explains "(the cash reserved against a written option is needed before the premium of a later leg
  arrives)". For a covered call the deficit is the share purchase (leg 1) paid before the written call's premium; no
  cash is reserved. Reproduce: T:covered_call, cash-short-not-financed. The figure (3,164.50) is right; the reason is not.

## s2 (other swaps): findings, 2026-10-13
Fixed by s2 (for the record; regression tests in test/core/swap-other.test.js):
- server/products/swap.js: "Notional resets" paid the financing of the period just ended on the NEW reset notional when the return leg
  was paid first (equity_swap, first-reset: 65,216.67 instead of 60,666.67). Now the reset applies from the next period (scaleSteps).
- server/products/swap.js: a dividend on a total-return reference in the FIRST period (before any reset) was silently not passed through
  (start fixing taken from the last reset paid, null -> skipped). Now a swap.dividend task uses the period's start close, blocks visibly
  while it is missing, and the maturity waits for it (equity_trs, dividend-passed-through). server/core/engine.js: tasks created by
  corporate actions run in the same pass.
- server/products/swap.js: a notional schedule entry that could not be read was silently dropped; now refused by name.
- server/core/tasks.js: tasks due the same day and created at the same instant (frozen clock) were taken in the order of their random ids,
  so the order of two same-day leg payments differed between engine and API/browser runs (commodity_index_swap). Tie-break by rowid.
- test/matrix/drivers/browser.mjs: the positions reader took an independent amount posted in another currency (USD collateral on the GBP
  OIS) as the position's margin and reported a screen/API mismatch (ois, open). Now only same-currency amounts are compared there.
Open (not s2's to fix, seen while running npm test at the end):
- test/core/failure-recovery.test.js "a number of contracts stated for an exercise must be whole for a listed option" fails (Missing
  expected exception) with or without s2's changes.
- test/matrix/specs/templates-a.mjs: covered_put has no matrix.ticket, so specs.test.js and engine.test.js fail to load (t1 in progress).
Limitations established by s2 (stated in the specs' matrix metadata and the catalog notes):
- The catalog has no index product: equity, commodity and freight indices are reference instruments of another product (ETF, physical
  commodity), never traded. A Shaffer reference-data index type would remove this.
- Bond TRS coupon pass-through is by hand (manual coupon cash flow): a swap does not follow its reference bond's coupon schedule.
- Dividend pass-through is paid on the ex-date (the corporate-action form has no separate pay date).
- Electricity delivery hours ignore clock changes (23/25-hour days counted as 24). Scenarios avoid DST months.
- An independent amount that follows a notional schedule is trued up when the payment ending a period is made, not on the period's
  first day (they differ when the payment date is adjusted or lagged).
- Legs are paid gross unless the contract states Net settlement (which is refused with return, overnight-index or exchanged-notional legs).
- FIXED (t1, covered put): the interim-cash check skipped packages with a short sale, so a covered put funded to the
  preview's netted figure (which counted the written puts' premium) was rejected at execution: the short sale needs its
  top-up, margin and commission before the premium arrives (Treasury funding executed, borrow filled, package in
  attention). server/core/packages.js interimNeeds now sequences sell_short/borrow_sec legs; the refusal's reason now
  names the short sale or the purchase (the covered-call wording above is fixed by the same change).
  test/core/templates-t1.test.js.
- OPEN, not t1's: test/core/failure-recovery.test.js "a number of contracts stated for an exercise must be whole" fails
  since the lifecycle route became async (s3, server/api.js line ~367): the test uses assert.throws on a promise.
