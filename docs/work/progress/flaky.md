# flaky: two timing-sensitive browser steps from final2
## Done
- Cause 1 (B:cds_swaption:halloran-knocked-out): web/views/strategy-detail.js Positions built the Lifecycle menu before the per-instrument terms fetch returned, so terms-dependent items (knock-out, barrier, delivery, put...) were missing for a moment (user-visible). Fixed: disabled "Loading…" (or "Terms unavailable") menu until the row's terms are present. Drivers: new ui.lifecycleMenu(row) in test/matrix/drivers/browser.mjs waits for the row and for the disabled menu to go; used by browser.mjs and bond/forward/future/manual/option/otcoption/secloan/swap drivers.
- 5x cds_swaption with an otcoption-family browser run alongside: 5/5 passed 16/16; the load run (16 otcoption scenarios) also passed.
- Cause 2 (SB:history:reference-edits): isEditable does not wait for enabled (fieldset[disabled] descendants count as disabled); it timed out resolving nth(7), which vanished because the Underlying instrument picker swaps its text input for name+Change once its instrument loads. Fixed in test/system/lib/browser-cases.mjs: one evaluate snapshot, fieldset has disabled attr, every control matches :disabled.
- System browser run 1 (sys1.log): history passed, but SB:hedge:reconnection failed (hedge popup never opened after the fill; probable race in web/app.js prompt effect: ticks arriving while a prompts fetch is in flight are dropped). Not fixed, reported.
- 3 more system browser runs (sysB1-3.log): 38/38 each; history 80 checks every time (4/4 across all runs).
- Families with changed drivers, browser level: bond 51, forward 8, future 11, manual 16, option 5, secloan 4, swap 34 scenarios, no failures.
- npm test 811/811. test/matrix/results/*.json restored to HEAD content.
## In progress
- none
## Next
- save note (done after this), report.
