# fw: commodity-future delivery (part 1) and forwards family (part 2)

## Done
- Engine: server/products/future.js: simulated physical delivery (deliveryTerms, simulateDelivery, plugin.deliver);
  expiry of a physical contract with a deliverable Underlying delivers on paper; refusal reasons with codes
  (delivery_position_closed, _cash_settled, _bond_future, _not_configured, _contracts, _more_than_held,
  _before_window, _after_window, _wrong_side, _awaiting_price, _goods_short). terms.delivery {units, grade, location, firstNotice}.
- server/api.js lifecycle 'deliver' delegates to plugin.deliver when present (spot message kept).
- web/lib/contracts.js futures form: delivery fields; web/views/strategy-detail.js: "Delivery notice" lifecycle dialog.
- server/core/catalog.js commodity_future note.
- test/core/futures-delivery.test.js (3 tests) passes.
- test/matrix/specs/future.mjs: commodity_future rewritten (deliverable WTI-CUSH, invalid requests x4, partial close,
  delivery at expiry, invoice paid, barrels sold). equity_future updated: shares now delivered on paper at final settlement.
- harness: lib/actions.mjs positionIn allowClosed (refused requests on a closed position); drivers/browser/future.mjs
  delivery fields + actions.lifecycle (deliver).
- commodity_future passes engine, API, browser. All 11 futures pass engine.
- NOTE: commit f3c20ac (ui1 save) captured a half-edited future.mjs; restored from c81ccae and re-edited.

- Refusal steps added: equity_index_future request-delivery-cash-settled; gov_bond_future and treasury_future
  request-delivery-bond-future. All 11 futures pass engine and API; equity_future, equity_index_future, gov_bond_future,
  treasury_future, commodity_future pass browser (fw/results).
- npm test 281/283 at 17:50: failures are others' WIP (private_equity spec audit; convertible_preferred 'convert' action,
  logged in BUGS.md). The 1-point save waits for a green npm test.

## Part 2 (forwards): test/matrix/specs/forward.mjs, test/matrix/drivers/browser/forward.mjs
- Terminal additions in server/products/fx.js (forward plugin): FX/NDF value date must be a business day of both
  currencies' calendars; `terminate` (early termination at a stated amount, lifecycle action, api.js case 'terminate');
  asset-forward physical delivery labelled "Simulated forward delivery (paper entry ...)". UI: strategy-detail.js
  "Early termination" dialog (amount, notional terminated, settlement date).
- fx_forward: passed engine / API / browser (saved 0.2).

## In progress
- Part 1 done apart from the 1-point save (retry npm test).
- ndf: passed engine / API / browser (saved 0.2).
- fra: passed E/A/B. Terminal fixes for it: contracts.js shows Fixing date for an FRA; api.js refreshBook also refreshes
  FX pairs of open positions' currencies (and the engine driver mirror) - NAV was provisional on a stale EUR rate.
  FRA offset discounting logged in BUGS.md (not fixed).
- Next: core regression tests test/core/forwards.test.js (terminate, value-date check, position-currency FX refresh);
  then equity_forward (agreement basis? physical delivery), bond_forward, commodity_forward, fx_swap, tba_mortgage.

## Next
1. Part 2: forwards family, 8 products, one at a time, save 0.2 each.
