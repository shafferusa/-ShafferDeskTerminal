# v1b: hedge workflow follow-up (round 2 of V1) : progress log

Workspace: $SP/v1b (ports 8811 demo, 8812 normal). Task: items A to E in the prompt (see "Next").
Round 1 notes: $SP/v1/PROGRESS.md (docs/work/progress/v1.md in the repo).

## Done
- A (suite green again: `npm test` 183 pass, 0 fail at 2026-10-07 ~02:25 UTC).
  - server/core/hedge.js: `previewPackage(requestId, packageId, { legs, extraProtection, collateral, statedPrices })`.
    `collateral` = { [legNo]: basis } chosen for an OTC contract leg (agreement / position-level terms / uncollateralized),
    normalised with agreements.normalizeBasis, written onto the leg's contract terms, then validated by the normal preview
    (collateral-basis, -other-book, -closed, -not-covered checks). `statedPrices` = { [legNo]: price } for a leg with no
    executable quote. The result carries `hedge.completion` = { legs: [{ n, collateral: { origin: none|recommendation|
    chosen|contract, statedByService, replacesStated, basis, label, independent, needsChoice, canChoose, problem },
    price: { needsStatedPrice, statedPrice, canState, indicative } }], missing: [{ leg, what, text }] }.
  - server/api.js (one line, hedge preview route): passes body.collateral and body.statedPrices through.
  - test/core/reconciliation.test.js "the TRS alternative is a complete swap": chooses position-level terms of 10% of
    notional through that path, keeps 10,000 posted on 100,000 and returned on close; executes pv.legs with
    expected: pv.confirmation.
  - test/core/hedge.test.js: 2 new tests (no basis stated: every choice validated, executed under an agreement, links,
    resets scheduled; basis stated by the service: shown as stated, unusable one can be replaced).
- Found already in the tree (commit 9c992f7, not verified by anyone): web/views/instrument.js `HedgeContext` uses the
  StrategyPicker by ID (item B's ticket part). Still to verify in the browser.

## In progress
- C front end: web/views/hedge.js popup (collateral-basis chooser on an OTC leg, stated fill price on an unpriced leg,
  Execute now without the detour through the inspect dialog). Not started; file untouched so far.

## Next
- B Marketplace ticket hedge context verified in the browser (popup opens past "incomplete" when filled in; empty allowed)
- C popup + browser: TRS end to end (execute, clock through a reset on a trading day, close); FX-forward package (unpriced leg)
  -> save-note 0.5
- D popup 409 preview_changed: was / now with `Changes`, fresh confirmation; browser check with /api/demo/fixtures/quote
- E routes in docs/ARCHITECTURE.md -> save-note 0.5
- full npm test, stop servers, report under 40 lines.
