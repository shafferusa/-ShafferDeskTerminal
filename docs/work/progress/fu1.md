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
- test/matrix/specs/future.mjs: header, helpers, equity_index_future (28 steps incl. 3 blocked).
- test/matrix/drivers/browser/future.mjs: contractTerms (incl. underlying picker, calendars, Quoted in), ticket,
  actions.roll, actions.close / resize for Treasury-owned positions.
- equity_index_future, equity_future (27 steps), gov_bond_future (18, EUR, 1 May holiday, FX 1.10 -> 1.08) and
  treasury_future (19, 1/64 tick, physical -> cash close-out) pass at engine, API and browser level.

## In progress
- Nothing half-edited.

## Next (designs are worked out; write each into specs/future.mjs, run engine, API, browser)
4. stir_future: SOFR-like, 100 minus rate, 25 USD a basis point; owner Treasury.
5. fx_future: EUR/JPY-like, JPY quote currency, USD/JPY 150 -> 160.
6. commodity_future: WTI-like, roll, Good Friday 3 April 2026 (US closed), delivery request refused.
7. volatility_future: VIX-like, short, spike -> cash deficit alert -> funded from Treasury by hand.
8. dividend_future, 9. crypto_future, 10. perpetual_future (funding by hand, 24/7 calendar, bps fee).
11. Engine regression tests in test/core/futures-lifecycle.test.js for the two Terminal fixes.
12. Full npm test; final report. Exploration scripts are in fu1/x (not tests).

## Product state (engine / API / browser)
equity_index_future: passed / passed / passed
equity_future: passed / passed / passed
gov_bond_future: passed / passed / passed
treasury_future: passed / passed / passed
others: not written yet
