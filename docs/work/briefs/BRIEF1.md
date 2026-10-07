# Shaffer Desk Terminal: front-end view brief (shared by all view builders)

Repo: `/home/claude/-shafferdeskterminal`. A paper-trading terminal (simulated execution only, never real money).
Server: Node 22, zero npm dependencies, `node:sqlite`. Front end: no build step, native ES modules,
Preact + htm from `web/vendor/preact-htm.js`. The server engine is finished and tested (`npm test`, 61 tests).
You are writing front-end views that are currently stubs. Other people are writing other views at the same
time, in the same repo. Stay inside your own files.

## Read these first (in this order)
1. `web/lib/core.js`  (api helpers `get/post/put/del`, `useLive`, store, `openOverlay`, `toast`, formatters)
2. `web/lib/ui.js`    (the whole UI kit; use these components, do not invent parallel ones)
3. `web/lib/contracts.js` (InstrumentPicker, PositionPicker, schema-driven ContractFields, newDraft, draftToContract)
4. `web/views/markets.js`, `web/views/instrument.js`, `web/views/preview.js`, `web/views/strategy.js`, `web/views/hedge.js`
   (finished views: copy their patterns, tone and density)
5. `web/app.js` (shell, routing: a page is a default-export component receiving `{ args, book, status }`;
   `book` = `{ id, name, reportingCcy, settings, settingsOverrides, units: [{id, name, kind: 'treasury'|'account'}] }`)
6. `web/app.css` (class names: panel, grid-form, stack, row, split, cols-2, cols-3, stats/stat, kv, ledger tables, notice, pill, awaiting, tabs, seg, toolbar, page-head, note, sub, muted, small, strong, gain, loss, r, c, wrap, clip, nowrap)
7. `server/api.js` (every route) and the server module(s) behind the routes you use, for exact response shapes.

htm syntax reminders: components are `<${Comp} prop=${x}>children<//>`; every dynamic attribute is `${...}`;
lists need no keys unless reordered; `class` not `className`; events `onClick`, `onInput`.

## Hard product rules (from the owner's spec; do not break these)
- Every price shown goes through `<Price obs=...>` / `<Prov obs=...>` so it carries source, timestamp, currency and
  status (real-time, delayed, end-of-day, indicative, model-derived, reconstructed, manual, simulated).
- A value that is not available is drawn as missing (`<Missing reason=.../>`, an em dash with a hover reason).
  NEVER show zero, a guess or a fabricated number in its place. `fmtMoney/fmtNum/fmtPrice` already return a dash for non-numbers.
- Where a Shaffer service is not connected, show the waiting state with `<Awaiting what="..."/>`
  (its headline is always "Awaiting Shaffer data connection"). Do not simulate analytics.
- Analytical fair values are never shown as executable quotes. Labels say "Current market price", "Fair price", "Gap %" (no "Shaffer" in those labels).
- All trading actions go through the preview: build an input, call `openPreview(input, { openOverlay, toastError, onDone })`
  from `web/views/preview.js` (or `openPreviewAction(strategyId, action, args, { onDone })` from `web/views/instrument.js`
  for close/resize/roll/retry/unwind). Nothing is submitted without the preview's single confirmation.
- A transfer never converts currency. Borrowed cash is a liability. Short-sale proceeds are restricted, not buying power.
  A short sale always needs a securities borrow leg. Financing legs are shown apart from price/risk legs.
- A swap or other OTC contract is never reduced to "buy/sell": show its legs and terms (use `inst.details` from the API, or ContractFields for entry).
- Do not invent endpoints, numbers, rates or defaults for rates. If the API lacks something you need, add a small
  additive route (see "Server changes") or leave the control out and report it.

## Design system (already built; follow it, do not restyle)
"Ledger paper": light and dark themes via CSS variables (`--paper`, `--sheet`, `--ink`, `--pen`, `--gain`, `--loss`,
`--amber`, `--rule`, `--rule-strong`, `--muted`). Both themes must look right: never hard-code colors, use the variables.
Dense, calm, tabular. Headings via h1/h2/h3/h4. Tables are `<Table>` (class `ledger`), numbers right-aligned (`align: 'r'`).
Panels via `<Panel title=... actions=... flush>`; forms via `<div class="grid-form">` + `<Field label hint>`.
No decorative elements, no gradients, no cards-in-cards, no icons beyond what the kit has.

## Writing (interface copy)
- Sentence case everywhere. No ALL-CAPS labels. No labels built as "WORD — fragment". No "→" in links or buttons.
  Avoid strings joined with middle dots; use commas or separate lines.
- Plain verbs; a button says exactly what happens ("Record deposit", "Preview repo", "Save assumptions").
  Keep the same verb through the flow (button "Record deposit" then toast "Deposit recorded.").
- Errors state what went wrong and what to do; no apologies. Empty states say what belongs there and how to add it.
- Name things as the user does: Book, Treasury, Account, strategy instance, leg, hold, reserved, restricted.
- Do not use the words "genuinely", "honestly", "simply", "just".

## Constraints
- Create/replace ONLY your own view files (listed in your task). Do not edit `web/lib/*`, `web/app.js`, other views,
  or tests. If you need a small shared helper, define it locally in your view.
- CSS: prefer existing classes and small inline styles. If you truly need new rules, append them at the END of
  `web/app.css` under a comment `/* ---- <your view name> ---- */`, using CSS variables only.
- Server changes: avoid. If a view cannot be built without data the API does not return, you may add a small,
  additive, read-only route or field in `server/api.js` (never change an existing response shape, never touch
  `server/core/*` logic). Re-read the file right before editing (others may be editing it), run `npm test` after,
  and list every server change in your final report.
- No new dependencies. No build step. Keep each view file self-contained and under ~700 lines; dense but readable,
  with a short header comment saying what the screen is for.
- Keep exports exactly as specified in your task: other views already import them.

## Running and checking your work
Start YOUR OWN demo server (own port and data directory, so you do not disturb others):

    cd /home/claude/-shafferdeskterminal
    SDT_DATA_DIR=<your workspace>/data setsid nohup node --disable-warning=ExperimentalWarning --watch server/index.js --demo --port=<your port> > <your workspace>/server.log 2>&1 < /dev/null &

Demo mode seeds a "Demo Book" (5,000,000 USD in Treasury; Accounts "Equity Long/Short" and "Global Macro"),
fictional instruments (ALFA, BRVO, CHRL, DLTA, ECHO, SIM500, KAIJ (JPY), ROSE (GBP), ALPN (EUR), SIMCOIN, futures
"S5 …", bonds SIMGOV31 / SIMCORP29, FX pairs EUR/USD GBP/USD USD/JPY, rate codes SIM-ON / SIM-3M) with a simulated feed,
and a clock you can move: `curl -s -XPOST localhost:<port>/api/demo/advance -H 'content-type: application/json' -d '{"ms":86400000}'`.
Create activity with curl against the API (preview then submit: POST /api/strategies/preview, then POST /api/strategies
with `{ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true }`), or by driving the UI with Playwright.
You need real activity on screen (trades, a short with a borrow, an option, a transfer, a loan, a failed leg) to judge your views.

Screenshots (Chromium + Playwright are installed; do NOT run `playwright install`):

    cd <your workspace> && node shot.mjs shots/name.png '#/route' [stepName] <your port> [dark]

`shot.mjs` loads the page at 1440x900, optionally runs `steps/<stepName>.mjs` (default export `async (page) => {...}`
to click around), saves the PNG and prints any browser console errors. View the PNG with the Read tool.
You MUST look at your screens (light AND dark) and fix what looks wrong: clipped text, cramped or wrapping controls,
misaligned numbers, empty panels, console errors. Check an empty Book too (create one with POST /api/books).
Also run the real (non-demo) mode once to see the waiting states: start a second server WITHOUT `--demo` on another
port with another data dir, create a Book via POST /api/books, and screenshot your views there.

When you finish, stop the servers you started (kill by your port) and report:
1. what each screen does, 2. server/CSS changes you made (exact routes/fields), 3. anything in the spec you could
not support and why, 4. any server bug you found (with a reproduction), 5. confirmation that `npm test` passes
and there are no console errors on your screens in demo and real mode.
