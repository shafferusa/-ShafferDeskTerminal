
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
