
## v1b (hedge follow-up), 2026-10-07: two findings outside my files, not fixed

1. **A currency forward's notional before a rate is labelled in the wrong currency** (server/core/packages.js,
   `estimateLegs`, the no-price branch: `row.notional = inst.family === 'forward' && ... ? l.qty : e0.notional`, with
   `row.currency = inst.trading_ccy`). For "Sell 2,924,000 JPY/USD forward" the preview row carries notional 2,924,000 and
   currency USD, so the preview dialog shows "2,924,000.00 USD" and the confirmation snapshot adds 2,924,000 to the USD
   gross notional. Once a rate is stated it becomes 19,818.33 USD (right). What is right: before a rate the figure is
   the JPY amount and should be labelled JPY (or left out of the USD gross notional). Reproduce: demo, buy KAIJ, hedge
   popup, "JPY currency forward", Inspect or edit: the "Notional, margin" column. The hedge popup's own leg card now
   labels that figure in the base currency (web/views/hedge.js); the preview dialog and the snapshot are unchanged.
2. **A swap floating-leg payment that is exactly half a cent rounds down** (server/products/swap.js `legAmount`, then
   `money()`). Equity TRS, notional 81,590, SIM-ON 4.00% + 0.50%, 2026-10-06 to 2027-01-06 (92 days, ACT/360):
   81,590 x 0.045 x 92 / 360 = 938.285 exactly; the Terminal paid 938.28 because the day-count fraction 92/360 is a
   binary float (the product is 938.28499...). Half-up gives 938.29. One cent; the convention for exact halves should be
   decided and the amount computed as notional x rate x days / 360 in that order (or in integer minor units).

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

2. **Two strategy instances with the same name are listed in an arbitrary order in Accounting, Positions** (cosmetic;
   `web/views/accounting.js`, the sort of the Positions table: owner, strategy name, then strategy id, which is random).
   Product corporate_bond, step second-lot onwards: two purchases of one bond are two instances both named
   "Long HALDEN-5.4-MAR32"; which lot is the first row changes from one database to the next, and nothing in the row
   says which instance it is. What is right: the older instance first (opened_at, as the API lists them). Not fixed:
   shared view. The browser check now tells two equal-sized lots apart by their average cost (drivers/browser.mjs).

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
2. **No catalog product for a published index, so an inflation leg's index is a stand-in** (same gap as o1's item
   above). zc_inflation_swap and yoy_inflation_swap register the CPI as a "Physical / spot commodity" that is never
   traded, and supply its fixings as instrument prices "for a date". The Terminal lists it as a tradable asset.
   Right: a reference index of its own kind (not tradable), or an index code on the leg served like a rate fixing.
   The Terminal also applies no publication lag and no interpolation: the fixing asked for is the index for the
   period's first and last day (last business day before, when that is not one).
3. **The OTC ticket of the Strategies page has no market view, calendar or symbol fields** (`web/views/strategy.js`,
   "New OTC contract"). constant_maturity_swap, step open. A contract entered there is always US Derivatives on the
   US market calendar (payments on it joined with each leg currency's calendar) and has no symbol, so it is shown by
   its full name everywhere. A euro contract entered there would settle on New York days. Right: the same
   "Calendars and settlement" group and Primary view as the registry form. Reproduce: Strategies, Custom, Add a leg.
4. **A swap whose last payment was released late matures one engine pass later** (`server/core/engine.js` runs due
   tasks once, in due-date then creation order; the maturity task is older than the last payment's). interest_rate_cap
   step fixing-entered-by-hand, constant_maturity_swap step cms-fixing-entered-by-hand: after the fixing is entered
   the payment is made and the maturity row still reads "blocked: Waiting for the final leg payments" until the next
   pass (a few seconds with the engine timer on; the scenarios use a `cycle` step). Right: blocked tasks of a
   position looked at again in the pass in which another of its tasks completed.
5. **"Close share %" cannot state an exact notional** (strategy instance, Close). 33.3333% of 30,000,000 gives
   9,999,999. The scenarios use exact percentages. Right: a notional field beside the percentage for contracts.
6. **A position's own margin figure is its independent amount only**; variation margin posted for it shows in the
   cash "margin" bucket and on Treasury, Collateral, not on the position row (interest_rate_collar, step
   variation-margin-call: position margin 0 while 30,000 is posted). By design (variation margin belongs to the
   netting set), but the row gives no hint. `server/core/agreements.js` area.
7. **Marks: nothing on the manual price form says what a swap's mark must contain.** The Terminal accrues nothing in
   the ledger between payment dates, so the mark has to include interest accrued; and for a cross-currency swap the
   principal exchanged is on the balance sheet (lent / owed, at the current rate), so the mark has to exclude it or it
   is counted twice. Both are stated in the spec header and asserted; a hint on the form (web/views/data.js) is due.
8. **Two rules for a notional that changes inside a period** (swap.js, left as it was and documented): an increase
   takes the whole current period on the added notional, while a position first opened inside a period pays from its
   trade date. Either is defensible with an all-in price; they are not the same rule.
9. **Balance sheet lines in a foreign currency can foot one cent off net assets** (`server/core/accounting.js`):
   each line is converted and rounded on its own, the NAV converts the currency's net total once.
   cross_currency_basis_swap, step second-quarter: cash 10,394,382.69 + lent 9,615,384.62 - 10,000 = 19,999,767.31,
   assets shown 19,999,767.30. Cosmetic; the totals are right.
10. **Fixing dates follow the contract's joint payment calendar, not each index's own** (swap.js `fixingDate`, a
    convention, documented): on the USD/JPY swap the term SOFR fixing for the period starting 23 September 2026 (a
    holiday in Tokyo, like the 21st and 22nd) is Friday 18 September's, though New York was open on all three days.
11. **Principal a forward-starting cross-currency swap will exchange is announced, not reserved.** The preview says
    what is due on the effective date and whether the cash is there today; nothing sets it aside, so if it is spent
    the exchange fails visibly on the day and waits (cross_currency_swap, step initial-exchange-unfunded). And the
    shortfall message of a trade that cannot pay its principal calls it "purchases" (generic text in packages.js).
