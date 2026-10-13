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

## In progress
- Add refusal steps: cash-settled (equity_index_future), bond futures (treasury_future, gov_bond_future). Then API/browser
  for equity_future, treasury_future, gov_bond_future, equity_index_future; npm test; save 1 point.

## Next
1. Part 2: forwards family, 8 products, one at a time, save 0.2 each.
