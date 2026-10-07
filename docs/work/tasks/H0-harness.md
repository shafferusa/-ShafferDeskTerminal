# Task H0: the product test matrix harness (engine, API and browser levels) and its first family

Owner request sections **5** and **6** (and the method of **7**). You build the machinery and prove it on the
equity family. Other people will then add the remaining 16 families using what you build, so the format, the
drivers and the documentation you leave behind are the product.

Your workspace: `$SP/h0` (ports 8850 to 8859). No migration.

## The owner's standard
- Every one of the 205 catalog products, every ticket action and every one of the 28 execution templates gets a
  matrix row. A product is not "tested" because its ticket opens or because another product shares its engine:
  each supported variant is exercised with its own actual specifications.
- A browser test goes from the interface to the ledger: select Book, owner, instrument, action, amount; enter or
  retrieve terms; preview and independently check the figures; confirm and verify the result; check pending
  obligations, positions, cash, liabilities, collateral, history; advance time through settlement and lifecycle
  events; reduce / close / repay / return / terminate / mature; verify final balances and history; restart the
  application and verify persistence.
- Expected values are calculated independently (by hand, arithmetic shown), not copied from the implementation.
- Fixtures replace only the Shaffer services (quotes, analytics) and are labelled. Real routes, real engine, real
  ledger. Disposable databases only: the harness must create its own temporary data directory and refuse to run
  against anything else (never the repo's `data/`, never a path it did not create).

## Design to implement (improve it where you find a better way, but keep the three levels and the shared specs)

```
test/matrix/
  README.md            how to write a spec, how to run each level, what a result means
  specs/<family>.mjs   one file per engine family; exports an array of product specs (data, not code)
  lib/                 spec runner, independent calculators, disposable-server control, result recording
  drivers/engine.mjs   in-process app (test/helpers style, file-backed temp database so restart can be tested)
  drivers/api.mjs      HTTP against a disposable server process
  drivers/browser.mjs  Playwright against a disposable server process (+ drivers/browser/<family>.mjs per ticket)
  engine.test.js       runs every spec at engine level inside `npm test` (one node:test per product scenario)
  run-api.mjs          `npm run test:api`
  run-browser.mjs      `npm run test:browser [-- --family=equity --product=adr --workers=2]`
  results/             engine.json, api.json, browser.json written by the runs (the evidence the matrix cites)
scripts/test-matrix.js `npm run matrix`: catalog + specs + results -> docs/TEST-MATRIX.md and docs/test-matrix.json
```

**A product spec** is data that all three drivers can execute:
- `productId` (catalog id) and matrix metadata: the ticket used and its required fields; which inputs are
  automatic (from the feed / reference data) and which are manual; the actions that apply (open, increase, reduce,
  close, plus product-specific ones: borrow, return, exercise, assign, roll, repay, terminate, reset, ...); the
  settlement and lifecycle events; accounting and collateral behaviour in one or two sentences.
- `instrument`: the registration terms for a realistic, fictional instrument of exactly that product (an ADR is
  registered as an ADR with a US listing and a foreign issuer; a Treasury bill as a discount instrument with its
  day count; and so on), or the contract terms entered on the ticket for OTC / financing products.
- `quotes`: the controlled quote fixture (bid, ask, last, size, and later changes), plus FX and rate fixings needed.
- `steps`: an ordered list. Each step is an action (trade input as the user would give it), a clock move to an
  absolute instant, a fixture change, a restart, or a lifecycle input; each with `expect`: preview figures, the
  execution result, pending obligations, positions, cash by bucket, liabilities, collateral, history rows.
  Expected numbers are literals with the arithmetic in a comment beside them. Steps declare `status: 'unsupported'`
  or `'blocked'` with the reason where the Terminal does not support an action; the driver then asserts that the
  Terminal visibly blocks it (not that it silently works or silently does nothing).
- Every product scenario runs in a fresh disposable database starting at the same fixed instant (use a Monday
  10:00 New York in a week whose holidays you have checked by hand; all later instants are absolute), with its
  own fee schedule and assumptions set explicitly by the spec so expected fees come from the spec, not defaults.
- After every step the runner also checks invariants through an integrity read: every ledger event balances;
  assets minus liabilities equals net assets at every scope; Book balances equal the owners' balances after
  eliminations; no duplicate fills, accruals, payments or postings (define and document the duplicate keys).
  Add a read-only integrity route if none exists (`GET /api/books/:id/integrity`), and say so.
- After the final step: restart (reopen the database), re-read everything, compare with before the restart.

**Test identifiers** are stable strings: `E:<product>:<step>`, `A:<product>:<step>`, `B:<product>:<step>`; templates
`E:T:<template>:<step>` etc. Results files map id -> passed | failed | blocked | unsupported, with the message,
duration, commit hash and timestamp. A level that did not run for a product is absent, and the matrix shows it as
"not run", never as passed.

**Controlled fixtures.** In demo mode add what is needed (demo-only, labelled, rejected with 403 in normal mode):
a controlled quote fixture (set bid / ask / last / size for an instrument; observations carry a source that says
"Test fixture" and status simulated), FX and rate fixings the same way, and an absolute clock set (exists:
`POST /api/demo/advance { to }`). Check what already exists (`server/data/demo.js`, `POST /api/observations`,
engine tests pin the demo feed) before adding. Task V1 is adding a scripted analytics (hedge) fixture; use it when
it lands, do not build a second one.

**Browser driver.** Label-based locators (field labels, button text, table headers); the UI is being changed by
others during this round, so avoid brittle CSS paths and keep per-ticket logic in small functions. Where it is a
supported workflow, do it in the interface (registering an instrument in the registry form, entering a manual
price, the ticket, the preview, the confirmation, Accounting tabs to read the result); read back through the
screens AND cross-check against the API so a display error and a ledger error are both caught. One browser at a
time per worker; default 1 worker (this machine has 2 cores); every wait is on a condition, not a sleep.

**Matrix document.** `docs/TEST-MATRIX.md`: summary counts by level and status; then per family a table with one
row per product x action: ticket and required fields, automatic vs manual inputs, settlement / lifecycle events,
accounting and collateral behaviour, the engine / API / browser test ids, status per level. Plus the 28 templates.
Products without a spec yet are listed as "not yet specified" (so the fan-out is visible). `docs/test-matrix.json`
is the same as data.

## Your deliverable for now
1. The harness above, documented in `test/matrix/README.md` well enough that someone who has never seen it can add
   a family in a new `specs/<family>.mjs` plus a browser ticket driver.
2. The **equity family complete at all three levels**: the 12 products `common_stock preferred_stock adr gdr etf etn
   closed_end_fund reit short_sale warrant subscription_right convertible_preferred`, each with its own realistic
   specification and: buy (open), buy more (increase), partial sell (reduce), sell the rest (close), settlement
   of each trade on its calendar, a cash dividend where the product pays one, the manual events the catalog says
   are manual for that product (exercise, lapse, conversion, depositary fee: recorded by hand through the
   interface), and for shortable products borrow -> short -> borrow fee accrual -> cover -> return, with
   restricted proceeds not spendable. Restart and persistence at the end of each.
3. Fix the Terminal bugs you find on the way (minimal edits; shared-file rules in BRIEF3; list them in your report).
4. Run all three levels, write the results files, generate the matrix. Report the run time per product at each
   level so the fan-out can be planned.

## Files you own
Everything under `test/matrix/`, `scripts/test-matrix.js`, `docs/TEST-MATRIX.md`, `docs/test-matrix.json`, the
`scripts` block of `package.json`; `server/data/demo.js` (fixture controls); regions of `server/api.js` (demo
fixture routes, the integrity route). `server/products/security.js` for equity-family bug fixes (its `calendarInfo`
belongs to V3). Other files: minimal bug fixes only, reported.
