# hist: SB:history:reference-edits
## Done
- Cause: test race, not a Terminal regression. In the registry Edit form (web/views/registry.js) the "Contract terms are locked" notice depends on GET /api/instruments/:id, while the contract-terms fieldset (disabled when locked) renders only once /api/catalog has loaded. The case counted fieldset[disabled] right after the notice appeared. Reproduced by delaying /api/catalog 1.5 s: exact same failure (expected 1, got 0).
- Fix (test/system/lib/browser-cases.mjs, historyEdits): wait for the fieldset under "Contract terms (locked)" before counting; also checks every input/select in it is not editable and Name still is. Expectation unchanged. Passes with the delay in place (79 checks). Screenshot confirmed the terms are greyed out/disabled.
- npm test 811/811; npm run test:system:browser 38/38 (third full run). Earlier full runs each had one different flaky case: SB:refusals:fx-missing (reloadAt in navShown) and SB:hedge:reconnection (hedge popup not shown within 20 s); both pass alone. Not investigated.
## In progress
- nothing
## Next
- nothing
