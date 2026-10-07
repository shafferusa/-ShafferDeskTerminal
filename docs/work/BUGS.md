
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

## b1 (bond family, government group), 2026-10-07: one finding outside my files, not fixed

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
