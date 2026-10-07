# v1b: hedge workflow follow-up (round 2 of V1) : progress log

Workspace: $SP/v1b (ports 8811 demo, 8812 normal). Task: items A to E in the prompt.
Round 1 notes: $SP/v1/PROGRESS.md (docs/work/progress/v1.md in the repo).

## Done
- A. Suite green again. server/core/hedge.js `previewPackage(requestId, packageId, { legs, extraProtection, collateral,
  statedPrices })`: `collateral` = { [legNo]: basis } chosen for an OTC contract leg (agreement / position-level terms /
  uncollateralized; normalised with agreements.normalizeBasis, written onto the leg's contract, validated by the normal
  preview), `statedPrices` = { [legNo]: price | null } for a leg with no executable quote. Result carries
  `hedge.completion` = { legs: [{ n, collateral: { origin: none|recommendation|chosen|contract, statedByService,
  replacesStated, basis, label, independent, needsChoice, canChoose, problem }, price: { needsStatedPrice, statedPrice,
  canState, indicative } }], missing: [{ leg, what, text }] }. server/api.js: the hedge preview route passes
  body.collateral and body.statedPrices (one line). test/core/reconciliation.test.js TRS test chooses position-level
  terms of 10% through that path (10,000 on 100,000, returned on close).
- C, front end (web/views/hedge.js): LegCollateral (basis shown with its origin; chooser = contracts.js
  CollateralBasisFields; "Use these terms"), LegStatedPrice ("Use this fill price" / "Use the indicative x"),
  usePackagePreview keeps what was completed and re-prices; popup footer: Execute now is disabled with a plain reason
  line (`[data-testid=hedge-why]`) while something is missing or blocking; warnings are ticked in the popup instead of
  bouncing to the inspect dialog.
- D (web/views/hedge.js): on 409 preview_changed the popup shows the refusal's new figures, `Changes` (was / now per leg
  and per package total), a "changed" pill on the leg, and needs "I have checked the new figures" before
  "Execute the new figures".
- Engine tests in test/core/hedge.test.js (17 tests, 3 new): no basis stated (every choice validated, executed under an
  agreement, links, resets scheduled); basis stated by the service (shown, unusable one replaced); unpriced leg
  (FX forward) completed with a stated price and executed.
- Browser, my demo server 8811, no console errors (scripts in v1b/: flow_trs.mjs, flow_trs2.mjs, flow_close.mjs,
  flow_fx.mjs, flow_refusal.mjs, flow_normal.mjs; shots in v1b/shots):
  - B: ticket picker lists DEMO-IS-001..003 by ID; filled in -> popup opens at recommendation ready with the ID
    (ALFA, DLTA, BRVO, CHRL); left empty -> popup opens incomplete and asks (KAIJ); normal mode 8812 -> typed name,
    hint says unresolved, popup awaiting connection with "unresolved name".
  - C TRS (ALFA 500, 1440 light; BRVO 200, 390 dark): basis none -> chose position-level 10% -> stated price 0 ->
    Execute now -> swap 81,590 notional, 8,159.00 posted, linked both ways to HDG request and Long 500 ALFA; Pending tab
    shows both leg payments 2027-01-06 and maturity; clock to Wed 2027-01-06 10:00 ET: financing leg received 938.28,
    dividend pass-through paid 275.00, return leg waited for the close ("Awaiting the 2027-01-06 fixing"); after the
    close (17:30 ET same day) return leg paid 4,079.50 (5% of 81,590, close fixture 171.339 vs 163.18); next resets
    2027-04-06 scheduled; closed from the strategy drawer (stated 0): collateral returned 8,159.00, no swap tasks left.
  - C unpriced leg (KAIJ 1,000, combined package future + JPY/USD forward): forward basis shown "Uncollateralized, stated
    in the recommendation", replaced by agreement "CSA Dealer A (v1b check)" (2,500 USD fixed), fill price = indicative,
    Execute now -> both legs filled, 900,000 JPY margin and 2,500 USD independent amount, linked.
  - D (DLTA 1440, CHRL 1024): S5 future quote fixture moved 3% down / 2% up after the popup priced; Execute now refused,
    was / now for the leg (estimated fill, notional) and the package (gross notional), button disabled until ticked,
    then filled at the new price.

## In progress
- Nothing half-edited. web/views/hedge.js is in a working state.

## Next
- 390 px check of the refusal view; light/dark screenshots review.
- E: routes into docs/ARCHITECTURE.md (hedge / protection / strategy routes, incl. the new preview body fields).
- BUGS.md notes for others: forward notional before a rate is labelled in the trading currency (packages.js); the swap
  float leg rounds an exact half cent down (938.285 -> 938.28).
- full npm test, stop server 8811 (PID in v1b/server-8811.pid), save-note 0.5, report under 40 lines.
