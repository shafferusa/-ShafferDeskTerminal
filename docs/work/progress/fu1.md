# fu1: futures family (11 products), progress

## Done
- Terminal fix 1 (server/products/future.js `eod`): no variation margin on a day the contract's own trading calendar
  is closed (found with a Bund-like future on 1 May 2026: the Terminal booked variation against the standing quote).
- Terminal fix 2 (server/core/engine.js, new `clearCoveredDeficits()` called in `tick`): a `margin.deficit` alert is
  resolved in the next cycle once the cash is non-negative again (it used to stay until the next end of day).
- Terminal addition (web/lib/contracts.js, F.future): a "Quoted in" field (terms.priceUnits) on the futures
  registration form, so the quotation unit of a contract can be recorded from the interface.
- Harness (additive): lib/normalize.mjs preview legs carry `notional` and `initialMargin`; drivers/browser.mjs reads
  the "notional" / "margin" lines of the Positions value cell (valueIsNotional, marginShown) and compares them with the
  API's and the spec's `notional` and `margin` instead of a market value.
- test/matrix/specs/future.mjs: all 11 products (equity_future, equity_index_future, gov_bond_future, treasury_future,
  stir_future, fx_future, commodity_future, volatility_future, dividend_future, crypto_future, perpetual_future).
- test/matrix/drivers/browser/future.mjs: contractTerms (underlying picker, calendars, Quoted in), ticket,
  actions.roll, actions.close / resize for Treasury-owned positions.
- ALL 11 products pass at engine, API and browser level (results in fu1/results/*.json).

## In progress
- Nothing half-edited.

## Next
1. Engine regression tests in test/core/futures-lifecycle.test.js for the two Terminal fixes (holiday variation,
   deficit alert clearing).
2. Look at the registration form with the new "Quoted in" field and the futures ticket, light and dark.
3. Append findings left open to $SP/BUGS.md (translated balance-sheet lines vs total by a cent; roll preview needs
   the new contract's margin in free cash; end-of-day pass on US business days only; gross margin across instances).
4. Optional: a limit order step for one future.
5. Full npm test; rerun the 11 at all three levels; final report. Exploration scripts are in fu1/x (not tests).

## Product state (engine / API / browser)
equity_future: passed / passed / passed
equity_index_future: passed / passed / passed
gov_bond_future: passed / passed / passed
treasury_future: passed / passed / passed
stir_future: passed / passed / passed
fx_future: passed / passed / passed
commodity_future: passed / passed / passed
volatility_future: passed / passed / passed
dividend_future: passed / passed / passed
crypto_future: passed / passed / passed
perpetual_future: passed / passed / passed
