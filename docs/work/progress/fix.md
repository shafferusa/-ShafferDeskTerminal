# fix: collateral follow-up (v2b), BUGS.md, narrow shell, documentation debt

Work list: A collateral follow-up 1..5; B every BUGS.md finding except Marketplaces table and fmtPrice (ui1);
C shell fits 1024x768 / 390x844; D ARCHITECTURE.md + README. Ports 8891 demo (data $SP/fix/data), 8892 normal.
Tools: $SP/fix/shot2.mjs (out hash port theme w h step full), steps/env.mjs (STEP_CLICK, STEP_TEXT, STEP_JS), setup.mjs seeds demo.

## Done (engine tests in test/core/collateral-followup.test.js, all passing)
- A3 stale-mark VM call: server/core/agreements.js valueSet/applyVariation/positionView/bookView (staleMarks, provisional, staleNote); desk pills in web/views/agreements.js.
- A1 Accounting Open positions: accounting.openPositions otcCollateral (basis, IA, VM with level netting-set); web/views/accounting.js otcCollateralLines; looked at the screen.
- B b1-2 same-named instances: strategy.openedAt, sort by it, "opened ..., instance ID" when names repeat.
- B s1-6 position margin = IA only: covered by A1 (VM shown on row, labelled for netting set).
- A2 borrowings: compact BorrowingTable gets "Cash collateral" column; accounting balance-sheet borrowings show held cash. (cash stays null when 0: matrix specs expect missing.)
- A5 no-basis block: message keeps the three choices + where to fix; tradeRequirement basis.fix {draft|position|contract|locked}; preview.js BasisFix component (fix in place).
- B s1-1 swap labels: swap.js swapTradeLabel; packages.js legLabel/describeOrder; strategy.js describeLeg; harness regex in test/matrix/drivers/browser.mjs accepts "Enter as written/opposite side".
- B s1-3 Strategies OTC ticket: symbol, primary view, ConventionFields (exported from registry.js).

- Looked at: Accounting positions (light/dark), preview no-basis block for registered contract and new contract (fix applied in browser, block gone, confirm enabled), Strategies OTC ticket (symbol, view, calendars).
- B v1b-1 forward notional: packages.js row.notionalCcy (base ccy), confirmation.js grossNotional by notionalCcy, preview.js label. Test labels-conventions.test.js.
- B s1-5 exact close: strategy-detail.js Manage "Close an exact notional/amount". Test.
- B s1-7 swap mark hint: data.js SWAP_MARK_HINT + instrument.js ManualPrice hint.
- B s1-4 same-pass maturity: engine.js processTasks second look; test fails without fix; swap-rates.mjs cap and CMS steps updated (maturity in fixing step, cycle step expects nothing new).
- B s1-11 shortfall message names principal; swap-rates.mjs xccy regex updated. Principal "not set aside" already stated in preview note.
- B s1-8 convention note on increase (swap.js economics); s1-10 "Fixing dates" row in swap terms.
- B o1-1/s1-2: listed-option form accepts a named index + index level code (contracts.js); engine test settles an index option on the level. Catalog index kind NOT added (redesign).
- npm test 405/405 after these; test:api for 4 swap products passes.

## In progress
- Nothing half-edited.

## Next
- s1-9 balance-sheet cent note; mark BUGS.md entries; browser check of swap products + common set; A4 narrow collateral screens; C shell; D docs.
