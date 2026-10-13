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

## In progress
- Screens for A5 and the OTC ticket not yet looked at.

## Next
- Screens A5/OTC ticket; A4 narrow collateral screens; rest of B (v1b-1 forward notional ccy, s1-5 close notional, s1-7 mark hint, s1-4, s1-8..11, o1-1, v1b-2 already fixed by s1); C shell; D docs.
