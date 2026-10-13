# t1b progress (repair and finish templates-a: cash_secured_put + long_call, long_put, bull_call_spread, bear_put_spread, bull_put_spread)
Continues t1's work ($SP/t1/PROGRESS.md). Spec file: test/matrix/specs/templates-a.mjs. Driver: test/matrix/drivers/browser/templates.mjs (shared with t2).
Results/tmp: SDT_MATRIX_RESULTS=$SP/t1b/results SDT_MATRIX_TMP=$SP/t1b/tmp. Probe: node $SP/t1/tools/probe.mjs templates-a.mjs <template> [lastStep].

## Done
- Step 1: cash_secured_put matrix metadata completed (all 8 fields) -> loadSpecs works again; engine.test.js and specs.test.js load in npm test.
  npm test after the repair: 793 tests, 785 pass, 8 fail:
  - matrix E: template cash_secured_put (mine, in progress: steps have no expectations yet).
  - matrix spec audit (specs.test.js, never ran while loading failed): protective_put, protective_call, covered_call, covered_put,
    long_collar, short_collar (templates-a, t1's, now mine): step limit-never-reached preview legs lack `action`.
  - matrix spec audit: futures_hedge (templates-b, t2's): a futures leg settles same day, audit expects T+1.

## In progress
- cash_secured_put expectations (templates-a.mjs, end of file; steps listed with empty expect).

## Next
1. cash_secured_put engine -> API -> browser -> save 0.2
2. long_call, long_put, bull_call_spread, bear_put_spread, bull_put_spread: each engine -> API -> browser -> save 0.2
3. Fix audit failures (add leg actions; futures_hedge settlementCheck), full family run at 3 levels, npm test green, save 0.5
