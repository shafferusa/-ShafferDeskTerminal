# Product family testers: shared task (read after BRIEF3.md)

You take a list of catalog products and prove, product by product, that the Terminal handles each one from the
interface to the ledger: or find out that it does not, and fix it.

## Read, in this order
1. `$SP/BRIEF3.md` (rules for the shared tree, honesty, final report) and `$SP/OWNER_REQUEST.txt` sections 5, 6, 7.
2. `test/matrix/README.md` in the repo: the harness you will use. Read all of it.
3. `test/matrix/specs/equity.mjs`: read `common_stock` completely, then `short_sale` (financing, refusals) and one
   product with manual events (`warrant`). Then `test/matrix/drivers/browser/equity.mjs` and skim
   `test/matrix/drivers/browser.mjs`, `lib/actions.mjs`, `lib/normalize.mjs`.
4. The catalog rows of your products (`server/core/catalog.js`: support level and note), your family's plugin in
   `server/products/`, the ticket in `web/views/instrument.js` / `web/lib/contracts.js`, `docs/COVERAGE.md`.

## What "done" means for one product (the owner's standard, not negotiable)
- One spec, in a spec file you own, on a fictional instrument registered as **exactly that product** with the
  specifications a real instrument of that product has: quotation unit, multiplier / deliverable, day count,
  coupon or reset schedule, currency, venue and its country, settlement lag and calendar, expiry style, and so
  on. Two products of one family must not be the same scenario with a different name: exercise what makes each
  product that product (a Treasury bill is a discount instrument; an ADR is US-listed with a foreign issuer; a
  TIPS needs its index ratio recorded by hand).
- Steps for every action the product's ticket offers: open, increase, reduce, close where they apply, in both
  directions where the product has two (long and short, pay and receive, borrow and lend); the settlement of each;
  every lifecycle event the catalog says is automated (reach it by moving the clock) and every event it says is
  manual (record it by hand through the interface, to completion); margin, collateral and financing where they
  apply; restricted, reserved and pledged amounts not being spendable; final repayment / return / termination /
  maturity / expiry; zero balances and the right history at the end. The runner adds the restart check.
- Every expected figure is a literal you worked out by hand from the inputs stated in the same spec, with the
  arithmetic in a comment. When the Terminal disagrees, decide by hand who is right. Never adopt the Terminal's
  figure to make a step pass, never loosen an expectation, never delete a step that fails.
- An action the Terminal does not support is a step with `status: 'unsupported'` (or `'blocked'`) and the refusal
  asserted. It must be visibly refused; "nothing happens" is a failure. Physical settlement: where supported, the
  delivery obligation and its ledger effects are simulated and labelled simulated; never imply real delivery.
- The spec passes at **engine, API and browser** level. A product is not done at a level it has not passed at.
- At least one of your scenarios has Treasury as the owner, at least one is in a non-USD currency with the
  reporting-currency figures checked (FX rate from a fixture), and at least one holds a position across a market
  holiday of its calendar.
- `matrix` metadata filled in truthfully for each product (ticket, required fields, automatic vs manual inputs,
  settlement, lifecycle, accounting, collateral) and `covers` on each step, so the generated matrix has a row per
  product x action.

## Things that changed after the harness README was written
- OTC contracts (swap, cds, forward, otcoption) cannot be previewed without `terms.collateralBasis`
  (`agreement` with an agreement id, `position` with position-level terms, or `uncollateralized`): see
  `server/core/agreements.js`, `test/core/collateral.test.js` and the "Collateral terms" group on contract forms.
  Exercise collateral where your products have it.
- A confirmation sends the displayed figures; if they moved beyond the Book's tolerances the Terminal refuses and
  shows was / now (`server/core/confirmation.js`). Fixtures are static unless you change them, so this only bites
  if you change a quote between preview and confirm.
- Tickets have a per-trade Settlement field (date or lag); instruments have `conventions` (trading, settlement and
  payment calendars, settlement lag). Use them where your product's real convention differs from the default.
- Post-trade hedge prompts appear after Marketplace fills; the harness closes them. Hedge workflows are tested
  elsewhere.
- Being added right now by someone else: an order does not fill on a day that is closed in its instrument's
  trading calendar (it waits, visibly, for the next trading day). Place your trades on business days of the
  instrument's calendar.
- The demo clock now persists across restarts in both directions.

## Working arrangements
- Your workspace: `$SP/<your id>` (create it). Set `SDT_MATRIX_RESULTS=<your workspace>/results` and
  `SDT_MATRIX_TMP=<your workspace>/tmp` (create both) in every matrix command you run, so your results do not race
  other people's on the shared results files. Do not run `npm run matrix`; the coordinator generates the documents.
- Run only your own products: `SDT_MATRIX_PRODUCT=a,b node --disable-warning=ExperimentalWarning --test
  test/matrix/engine.test.js`, `npm run test:api -- --product=a,b`, `npm run test:browser -- --product=a,b`
  (one worker; this machine has 2 cores and other people are running browsers too, so a timeout can be load:
  re-run once before treating it as a failure, and raise a wait's timeout rather than adding sleeps).
- Order of work: get ONE product passing at all three levels first (this proves your spec style, the actions and
  the browser driver for your ticket), then the rest. Engine level first for each, then API, then browser.
- Files you own: your spec file(s) (named in your task), your family's browser driver
  `test/matrix/drivers/browser/<family>.mjs` if your task says you build it, and your family's plugin in
  `server/products/` for bug fixes. Shared harness files (`lib/actions.mjs`, `lib/normalize.mjs`,
  `drivers/browser.mjs`): additive edits with the Edit tool only, in small regions, re-reading first; do not
  restructure them and do not change how existing step actions behave (other families depend on them).
- Terminal bugs: fix them. Minimal edits; in shared core files follow BRIEF3; after a core fix run
  `node --disable-warning=ExperimentalWarning --test "test/core/*.test.js"` and your products again. Add an engine
  regression test in `test/core/` for any bug that is more than a typo. If a bug belongs to someone else's active
  area or is too large to fix safely, leave the step failing, and append it to `$SP/BUGS.md` (product, step, what
  the Terminal does, what is right and why, how to reproduce).
- Before you finish: full `npm test`. A failure inside another family's matrix scenario or spec file is someone
  else's work in progress: mention it, do not touch it. A failure in `test/core` or in your products is yours.
- Keep `PROGRESS.md` current (BRIEF3): the list of products with their state at each level.
- Milestone = one product passing at all three levels. At each one run the save script from BRIEF3 with 0.2 points:
  `/tmp/claude-0/-home-claude--shafferdeskterminal/9fe505c4-25a7-5956-b73b-691c2f93387b/scratchpad/tools/save-note.sh <your id> 0.2 "<product> passes at engine, API and browser" test/matrix/specs/<your file>.mjs [your browser driver]`.
  If a product passes at engine and API level but the browser level is still open after real effort, save with 0
  points and say so in the text.

## Final report (under 80 lines)
A table: product, steps, and passed / failed / blocked / unsupported at engine, API and browser level. Then:
Terminal bugs fixed (file, what was wrong, the product and step that found it); bugs left open (also in BUGS.md);
harness changes you made; what your scenarios do not cover (be specific: actions, events, order types, owners);
the `npm test` result.
