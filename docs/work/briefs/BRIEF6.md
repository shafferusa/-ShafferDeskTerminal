# Round of 2026-10-14: server integration layer and the instrument-detail workspace

$SP = /tmp/claude-0/-home-claude--shafferdeskterminal/9fe505c4-25a7-5956-b73b-691c2f93387b/scratchpad
The owner's request is `$SP/OWNER_REQUEST3.txt`: read it completely; it is the specification. Then `$SP/BRIEF3.md`
(rules for a shared tree, honesty, progress log, saving progress with `$SP/tools/save-note.sh <id> <points> "<one line>"`,
which snapshots and pushes the whole tree: save only with your files in a working state) and `$SP/BRIEF1.md`
(design system and interface copy rules). The verification pass of last week is finished: `npm test` is 811 of 811,
`npm run test:api`, `npm run test:browser` and the system suites are green on commit 97957d2; keep them so
(run `npm test` before every save; run the browser suite for a few products after touching shared screens).

## Boundaries (the owner's, and already true of the code)
- The Terminal requests and displays; it never collects external data, never calls Yahoo / FRED / SEC / exchanges,
  never implements valuation, signals, hedge selection or calibration. Fair values, gaps, scores, EFS, sizing,
  hedge packages come from Analytics Lab (first Strategy: SP3E); prices, history, reference data, financials,
  documents, corporate actions, news from MarketData; both through one approved gateway.
- No production URLs, endpoint paths, auth or payload schemas are invented: the integration layer declares what
  it needs (documented client methods and data requirements) and the real mapping is filled in when the contract
  arrives (`server/data/shaffer-contract.js` is that single place). Until then every method reports "awaiting"
  and the screens show "Awaiting Shaffer data connection"; demo mode uses labelled fixtures.
- Server data never overwrites paper trades, booked accounting or fills; receiving a recommendation never
  executes it; a corporate action received from the server never posts a second time in the ledger.
- Missing values stay missing (never zero). Every value shows its source, timestamp and status.

## Existing code you build on (read before designing)
server/data/ports.js (the two ports and their shapes), server/data/index.js (the adapter: manual entries, demo,
Shaffer skeleton, caching), server/data/shaffer.js and shaffer-contract.js, server/data/demo.js (fixtures,
`createFixtureControls`), server/api.js (routes), web/lib/core.js (api helpers, store, useLive), web/lib/ui.js
(Price, Prov, Missing, Awaiting, Table, Panel, Drawer, Modal), web/views/instrument.js (today's instrument drawer:
Overview, Trade ticket, History, Positions tabs), web/views/markets.js (the family tabs, openInstrument),
web/views/strategy.js, web/views/hedge.js, docs/ARCHITECTURE.md.

## Working arrangements
Several people edit the tree at once; BRIEF3's shared-file rules apply (small Edit calls, re-read first, additive
routes, never restructure a shared file). The shared browser driver (test/matrix/drivers/browser.mjs
`openInstrument`, `ui.*`) must keep working: the instrument drawer is being reworked this round, so whoever
changes it re-runs `npm run test:browser -- --product=common_stock,treasury_note,equity_option,interest_rate_swap`
before saving. Keep `PROGRESS.md` in your workspace current. Final report under 60 lines: what you built (files,
routes, client methods, fixture controls), tests added and counts, what you looked at in the browser, the data-
contract requirements you documented, what is not done or not verified, and the exact backend dependencies.
