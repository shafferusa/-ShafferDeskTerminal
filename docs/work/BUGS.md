
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
