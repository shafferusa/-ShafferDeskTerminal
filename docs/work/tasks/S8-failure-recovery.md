# Task S8: failure, recovery and isolation

Owner request section **8** (all of it). Read `$SP/BRIEF3.md` first, then `$SP/OWNER_REQUEST.txt`, then
`test/matrix/README.md` (the harness: disposable sandboxes, disposable server processes, labelled fixtures, the
integrity route, the browser helpers). Reuse its libraries; do not build a second way of starting servers.

Your workspace: `$SP/s8` (ports 8860 to 8869).

## What to produce
A system test suite that proves the Terminal fails safely and recovers cleanly, at three levels, with results
recorded the same way the product matrix records them:

```
test/system/
  README.md                what each case proves and how to run it
  cases/*.mjs              the cases (one file per area)
  engine.test.js           engine-level cases, part of `npm test`
  run-api.mjs              `npm run test:system:api`      real HTTP routes, disposable server process
  run-browser.mjs          `npm run test:system:browser`  real interface in Chromium
```
Test ids `SE:<area>:<case>`, `SA:...`, `SB:...`; results in `test/matrix/results/system-{engine,api,browser}.json`
(honour `SDT_MATRIX_RESULTS`). Add a "System behaviour" section to `scripts/test-matrix.js` output listing each
case, what it proves, its ids and status per level (additive edit; the script belongs to the harness).

Not every case makes sense at every level: say which level(s) each case runs at and why. Anything a user can
trigger from the interface must be triggered from the interface at browser level, not only through the API.

## Cases the owner listed (each must exist, with the expected behaviour stated before you run it)
**Refusals and blocks**: insufficient cash (trade, transfer, withdrawal, repayment, settlement day); unavailable
securities borrow (short blocked; borrow recalled or exhausted); insufficient collateral (repo, pledged position,
an OTC independent amount, a failed variation-margin call); missing quote, stale quote, missing FX rate, stale FX
rate (trade preview, valuation: provisional NAV naming the item, nothing fabricated); incomplete contract terms;
invalid quantities (zero, negative, fractional where not allowed, above what is held, above borrow); expired
contracts (trade refused after expiry, expiry processing happens once); calendar conflicts (stated settlement date
on a holiday, before trade date).

**Execution under stress**: partial fills (remainder keeps working, dependent legs scaled, fees total once);
a failed dependent leg (package goes to attention, recovery actions retry / unwind / accept / cancel each leave
the books consistent); cancellations (working order, partially filled order, cancel twice); duplicate clicks on
every confirming button (confirm trade, Execute now, record transfer, repay, record event: exactly one effect);
repeated identical requests to every mutating route (idempotent on the client token where there is one; where
there is none, decide whether one is needed and add it); connection loss (browser loses the server mid-session
and recovers without a stale screen or a double submit; a Shaffer service address that stops answering: waiting
states, no lost history); retries; application restart at each stage of a trade's life (working, partly filled,
filled unsettled, settled, with open lifecycle items); recovery after an interrupted submission (kill the server
process during a multi-leg confirmation and during an engine cycle, restart, prove the database is in a consistent
state: all-or-nothing per ledger event, orders resume, nothing duplicated, the client can find out what happened).

**No duplicates, ever**: fills, hedge requests, accruals, payments, ledger postings, collateral movements, after
any of the above, after catch-up over several missed days, and with the engine timer running (the product
harness runs with the timer off; you must run with it on, including overlapping manual `tick` calls).

**History survives**: existing paper history is unchanged by data refreshes, fixture changes, service
reconnection, instrument edits, calendar edits and settings changes (hash the relevant tables before and after).

**Isolation**: Book isolation through the interface and through every API route that takes an id (a unit,
position, strategy, order, agreement, hedge request or instrument position of Book A used in a call scoped to
Book B must be refused; no list leaks another Book's rows; nothing nets or consolidates across Books). Enumerate
the routes from `server/api.js` and test them all; list any you could not test. Demo and normal paper databases
are separate files and neither mode can read or write the other's; fixtures and the clock are refused in normal
mode.

**Hedge reconnection** (API and browser level; engine level exists in `test/core/hedge.test.js`): requests waiting
while the service is away, with positions increased, reduced and closed meanwhile; reconnect; the request reflects
current exposure, closed positions' requests close, no duplicates; receiving a recommendation never executes it.

## Rules
- Disposable databases only, through the harness sandbox. Never the repo's `data/`.
- When a case fails because the Terminal is wrong, fix the Terminal (BRIEF3 shared-file rules; you may edit
  `server/core/orders.js`, `packages.js`, `settlement.js`, `engine.js`, `ledger.js`, `api.js` and the HTTP layer
  for such fixes, minimally, with an engine regression test) and re-run. Record each fix. If a fix would be a
  redesign, stop, describe it in `$SP/BUGS.md`, and leave the case failing.
- Expected outcomes are decided before running and written in the case. Do not adjust them to what happens.

## Final report (under 80 lines)
Cases by area with status per level; Terminal defects found and fixed (file, what, which case); defects left open;
routes or behaviours you could not test and why; `npm test` result.
