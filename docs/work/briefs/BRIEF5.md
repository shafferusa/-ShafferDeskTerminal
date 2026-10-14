# Round of 2026-10-13: read after BRIEF3.md (and BRIEF4.md if you test products)

$SP = /tmp/claude-0/-home-claude--shafferdeskterminal/9fe505c4-25a7-5956-b73b-691c2f93387b/scratchpad

The owner has asked for the whole Terminal to be finished and verified: `$SP/OWNER_REQUEST2.txt` (read it; it
adds to `$SP/OWNER_REQUEST.txt`, it does not replace it). "A product name, editable form, or 'full lifecycle'
badge is not evidence of implementation." Where a capability cannot be completed, the exact limitation and its
dependency are stated; nothing is quietly skipped or presented as supported.

## State of the tree (commit 271caaf)
- `npm test` 350 of 350. 57 products have a specification passing at engine, API and browser level (equity 12,
  options 5, futures 11, government bonds 13, rate swaps 12, loans 4). The harness is in `test/matrix/` (README
  there); the system suite for failure and recovery is in `test/system/`.
- Since the briefs were written: every mutating route accepts an optional `clientToken` and the web client sends
  one (`server/http/once.js`); previews warn on missing or stale FX and block the sale of a pledged or on-loan
  holding; orders wait on days closed in the instrument's trading calendar; the fee minimum applies once per
  order; OTC contracts need `terms.collateralBasis`; the hedge popup lets the desk choose a collateral basis and
  a stated fill price for an OTC leg; bonds accrue on settled face and pay coupons on face settled before the
  coupon date; swaps exchange cross-currency principal only when funded.
- Findings waiting for an owner: `$SP/BUGS.md`. Each group's earlier notes: `$SP/<id>/PROGRESS.md`.
- Product groups and what each must exercise: `$SP/tasks/GROUPS.md`.

## Rules that changed
- Saving: `$SP/tools/save-note.sh <your id> <points> "<one line>"` and nothing after the text. It snapshots and
  pushes the WHOLE working tree, yours and everyone else's, so run it only when the files you are editing are in a
  working state. Run it after every product that passes at all three levels (0.2 points) and after every Terminal
  fix or other piece of work you would not want to redo (0 points). The session can be cut off at any moment by a
  usage limit with no warning: what is not saved is lost. Keep PROGRESS.md current before each save.
- Finish one product completely (engine, API, browser, save) before starting the next.
- Someone is reworking the Marketplaces screen (product-family tabs) and the Strategies page's owner selector
  during this round. If a browser step that opens an instrument from a Marketplace or picks the owner on the
  Strategies page stops working, re-run once after a few minutes, then look at `test/matrix/drivers/browser.mjs`
  (`openInstrument`) before assuming your product is at fault; that person keeps the shared driver working.
- This machine has 2 cores and several browsers are running. A timeout can be load: re-run before investigating.
- Final report under 60 lines: the per-product table (steps; passed / failed / blocked / unsupported per level),
  Terminal faults fixed (file, what, which product and step found it), faults left open (also appended to
  `$SP/BUGS.md`), limitations you established with their exact dependency, what is not covered, `npm test` count.

## Update, 2026-10-13 17:15 UTC (read this last; it overrides the "State of the tree" above)
- 96 products now pass at all three levels: equity, listed options, futures, government and corporate bonds, rate
  swaps, loans, funds, crypto, currency, spot FX, emissions products and commodities. Spec files and browser
  drivers for those families exist under `test/matrix/`: read the one nearest to your products.
- The Marketplaces now have product-family tabs inside each view, instruments are routed by listing venue and a
  stored routing convention, and tickets and the Strategies page ask for a "Trading owner" (Accounts and Treasury
  distinguished). The shared browser driver opens instruments by tab. One person (ui1) is finishing that work.
- The app shell collapses the sidebar behind a Menu button below 820 px.
- OTC position rows in Accounting show their collateral basis; swaps are described as pay / receive in previews
  ("Enter as written: pay fixed ..."); a strategy can close an exact amount.
- `npm test` is 462 of 463: `matrix E: commodity_future` is red because a `deliver` lifecycle action was added
  and the futures spec still expects delivery to be refused. One person (id fw) is resolving it. Not yours unless
  you are fw.
- The owner's latest instruction: "Do not simply remove or weaken the assertion to make the suite green."
  "Worker results are useful" but the coordinator re-runs everything at the end against one commit, so a product
  you report as passing must pass again from a clean run: no reliance on leftover state, timing luck or a
  particular machine load.

## Update, 2026-10-13 19:15 UTC
- 163 products pass at all three levels; `npm test` 629 of 629. Finished families: equity, fund, crypto, cash, fx,
  spot, option, otcoption, future, forward, bond (government, corporate, structured A), loan, repo, secloan, manual,
  rate swaps. Drivers exist for all of them under test/matrix/drivers/browser/ (cds.mjs is minimal: extend it).
- The manual family now goes through collateral agreements; OTC options have Bermudan style, physical FX exercise
  only when funded, settlement-value entry on the Pending tab; futures and forwards simulate physical delivery.
- The system suite (test/system) enforces a mapping of every case to every level; its route classification lists
  every route in server/api.js: if you add a route, add it there too (test/system/cases/isolation.mjs or
  lib/mapping.mjs: read how) or `npm test` goes red.
