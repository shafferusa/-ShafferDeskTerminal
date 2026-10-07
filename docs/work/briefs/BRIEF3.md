# Shaffer Desk Terminal: final correction and verification round (shared brief)

Workspace root for this round (called `$SP` below):
`/tmp/claude-0/-home-claude--shafferdeskterminal/9fe505c4-25a7-5956-b73b-691c2f93387b/scratchpad`

Repo: `/home/claude/-shafferdeskterminal` (Node >= 22.13, ES modules, zero npm dependencies, `node:sqlite`; front end
is Preact + htm with no build step). Baseline commit `7e39c59`; `npm test` passes 74 tests there.

## Read first, in this order
1. `$SP/OWNER_REQUEST.txt`: the owner's request for this round, verbatim. It is the authority. Your task names the
   sections you own; read the whole file anyway so you know what the others are doing.
2. `$SP/BRIEF1.md` and `$SP/BRIEF2.md`: product rules, design system, interface copy rules, how to run a private
   server and take screenshots. All of it still applies (ignore their file-ownership lists; yours is in your task).
3. `README.md`, `docs/ARCHITECTURE.md` in the repo, then the code your task names.

## Things already true that must stay true (the owner listed these as "preserve")
- Books are separate workspaces. Nothing (screen, API, netting, collateral, transfer, total) ever spans two Books.
- Navigation: Book selector; sidebar Accounting, Treasury with its Accounts, Strategies, Marketplaces, Reference.
- Accounting scopes: whole Book, Treasury, one Account, several Accounts. Owner named on every row.
- A borrowing is one record owned by the unit that borrowed, counted once in the Book; internal funding is eliminated.
- Holdings are gross: `Long 200 | Short 100 | Net +100`.
- Hedge previews: one quote snapshot; every subtotal and total derived from its legs.
- No real-money execution. Hedge selection, sizing, valuation models and market-data ingestion are NOT built in the
  Terminal: they belong to Shaffer Analytics Lab / MarketData. Where a service is missing, the Terminal shows
  "Awaiting Shaffer data connection" or uses a fixture that is labelled as a fixture everywhere it appears.
- A value that is unavailable is shown as missing, never as zero and never fabricated.

## Rules for working in a shared tree
Several people are editing this repo at the same time, in the same directory.
- You own the files listed in your task. In files you share with others (`server/api.js`, `server/core/packages.js`,
  `server/core/orders.js`, `server/core/accounting.js`, `server/db/schema.js`, `web/app.css`, `web/lib/*`), change
  only the region your task names, with the Edit tool (never rewrite a whole shared file), and re-read the region
  right before you edit it. If an Edit fails because the file changed, re-read and retry; do not overwrite.
- Database migrations: append a new entry to `MIGRATIONS` in `server/db/schema.js` using the migration id your task
  assigns. Never edit an existing migration. Additive only (new tables, new nullable columns).
- CSS: append at the END of `web/app.css` under `/* ---- <your area> ---- */`, CSS variables only.
- Do not `git commit`, `git stash`, `git checkout` or `git reset`. The coordinator commits.
- Never touch the repo's `data/` directory or any database you did not create in your own workspace. Every server
  you start uses `SDT_DATA_DIR=<your workspace>/...`.
- Never run `pkill -f` / `pgrep -f`. Stop servers by PID: `ps -eo pid,args | grep "server/index.js" | grep -v grep`,
  then kill only the PIDs whose port is yours.
- If something fails in a way that looks like another person's half-finished edit (a syntax error in a file you did
  not touch, a test in another area failing), wait a minute and retry before investigating. Do not "fix" their area;
  report it.
- This machine has 2 CPU cores. Run at most one browser at a time, close it when done, and do not leave servers
  running that you are not using.
- Keep the tree working at all times: small steps, run your own test file often, run the full `npm test` before
  you finish. Your run can be interrupted; whatever is on disk ships.

## Progress log (required)
Keep `<your workspace>/PROGRESS.md` up to date: after each milestone, rewrite its three short sections: "Done"
(what is finished and verified, with file names), "In progress" (what you are in the middle of, and the state of
any half-edited file), "Next" (the remaining steps in order). Your run may be interrupted and resumed, by you or
by someone else, with only the files on disk and this log; write it so that works. Start it within your first
ten minutes. If `PROGRESS.md` already exists when you start, you are resuming: read it and continue from it
instead of starting over.

## Tests
- Engine tests live in `test/core/*.test.js` (`node:test`, helpers in `test/helpers.js`: in-memory app on the demo
  feed with a frozen clock). `npm test` must pass when you finish. Add tests for everything you build.
- Expected values in tests are worked out independently (by hand, shown in a comment as arithmetic), never copied
  from what the implementation prints.
- A test must exercise the real routes / engine / ledger. Do not mock those. Fixtures stand in only for the Shaffer
  services (quotes, analytics), and are labelled.

## Screens
Tools: `$SP/tools/shot.mjs` (usage in BRIEF1; `node shot.mjs <out.png> '<#/route>' [stepName] <port> [dark]`, steps in
a `steps/` folder beside it; copy the tools into your own workspace). Playwright is at
`/opt/npm-tools/node_modules/playwright/index.mjs`, Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Look at every screen you change, light and dark, at 1440x900 and at 1024x768 and 390x844 where your task says
"responsive". Fix clipping, overflow, console errors.

## Honesty
Report exactly what you did and did not verify. Do not describe something as working because its screen opens or
because similar code works elsewhere. If you leave something unfinished, say so plainly with the reason.

## Final report (keep it under 70 lines)
1. What you changed (files, routes, tables, settings) and what each change does.
2. Tests added (file, test names) and the result of the full `npm test` (count).
3. What you verified in the browser, and how.
4. Bugs found and fixed outside your own files (file, what, why).
5. Anything not done, not verified, or still wrong. Be specific.
