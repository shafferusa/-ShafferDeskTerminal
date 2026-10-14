# fin: two last items before the verification freeze

## Done
- Item 1 (hedge request for option-only templates): server/core/hedge.js (optionOnlyLegs, optionPackageDirection,
  optionPackagePrimary; request() and rebuild() pass optionPrimary; brief() carries quantityUnit), server/data/demo-hedge.js
  (optionPackageNote), web/views/hedge.js (queue row says "contracts"), test/matrix/lib/actions.mjs (hedgeRequestView shows
  option-package fields), test/core/hedge.test.js (2 tests), templates-a.mjs long_call hedge-request step.
  Verified: templates family engine 30/30 and API 30/30 with no step result changed vs $SP/t1b/final/results (842 steps,
  compared by $SP/fin/cmp2.cjs); T:long_call engine/API/browser pass (32 passed, 1 blocked); npm test 810/810.

- Item 2 (failed settlement attempts): server/db/schema.js migration 9 (settlements.last_attempt_at, retry_basis);
  server/core/settlement.js drawable() + retryDue(): retry only on new cash in the currency or a later business day;
  server/core/accounting.js settlementView lastAttemptAt; web/views/accounting.js Failed tab (attempts + last time, note).
  Test test/core/settlement-retry.test.js (fails with the rule disabled). test:system:api 48/48; npm test 811/811.

## In progress
- (none)

## Next
- Final report. Not done: screenshot of the Failed tab.
