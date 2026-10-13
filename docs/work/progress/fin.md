# fin: two last items before the verification freeze

## Done
- Item 1 (hedge request for option-only templates): server/core/hedge.js (optionOnlyLegs, optionPackageDirection,
  optionPackagePrimary; request() and rebuild() pass optionPrimary; brief() carries quantityUnit), server/data/demo-hedge.js
  (optionPackageNote), web/views/hedge.js (queue row says "contracts"), test/matrix/lib/actions.mjs (hedgeRequestView shows
  option-package fields), test/core/hedge.test.js (2 tests), templates-a.mjs long_call hedge-request step.
  Verified: templates family engine 30/30 and API 30/30 with no step result changed vs $SP/t1b/final/results (842 steps,
  compared by $SP/fin/cmp2.cjs); T:long_call engine/API/browser pass (32 passed, 1 blocked); npm test 810/810.

## In progress
- Item 2: failed settlement attempts counted per idle cycle (server/core/settlement.js).

## Next
1. Item 2: migration 9 (last_attempt_at, retry_basis), retry rule in settleOne, accounting.js + Failed tab, engine test,
   npm run test:system:api, npm test; save 0.5.
