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
- Nothing half-edited. test/core/forwards.test.js now 7 tests (adds delivery from holdings, bond forward, TBA).
- Final checks 19:10 UTC: all 8 forwards pass E/A/B (rerun); commodity_future, equity_future, equity_index_future,
  gov_bond_future, treasury_future pass E/A/B (rerun); npm test 620/623, the 3 failures are others' (convertible_preferred
  'convert' action; system route lists missing POST /api/tasks/:id/settlement-value), logged in BUGS.md.
- Screens checked: $SP/fw/screens (delivery notice, early termination, pool allocation dialogs, futures form; light/dark,
  1440 and 390), no console errors.

## Next
- Part 1's 1-point save waits for a fully green npm test (others' failures). Final report delivered.
