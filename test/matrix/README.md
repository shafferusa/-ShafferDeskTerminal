# Product test matrix

One scenario per catalog product, written once as data and run at three levels:

| Level | What runs | Command | Results |
|---|---|---|---|
| Engine | The real engine and ledger in-process, on a disposable database file | `npm test` (all tests) or `node --disable-warning=ExperimentalWarning --test test/matrix/engine.test.js` | `results/engine.json` |
| API | The real HTTP routes of a disposable server process | `npm run test:api` | `results/api.json` |
| Browser | The real interface in Chromium (Playwright) against a disposable server process | `npm run test:browser` | `results/browser.json` |

`npm run matrix` then writes `docs/TEST-MATRIX.md` and `docs/test-matrix.json` from the catalog, the specs and
the results files.

Options for the API and browser runs: `-- --family=equity`, `-- --product=adr,etf`; browser only: `--workers=1`
(default; one browser per worker), `--headed`, `--slow=150`. For the engine level, set `SDT_MATRIX_FAMILY` or
`SDT_MATRIX_PRODUCT`.

Environment: `SDT_MATRIX_TMP` (base directory for the disposable databases, default the system temporary
directory; never inside the repository), `SDT_MATRIX_SHOTS` (where the browser level saves the screen of a step
whose screens could not be read), `SDT_MATRIX_VERBOSE=1` (print every step), `SDT_PLAYWRIGHT` and `SDT_CHROMIUM`
(where Playwright and Chromium are, when not in the default places; Playwright is not a dependency of the Terminal).

## What a scenario proves

A scenario is one fictional instrument of exactly one product, in its own new database, starting at a fixed
instant. Its steps are what a user does (register, trade, record an event by hand) and what happens outside the
Terminal (a quote changes, time passes). After **every** step the runner:

1. compares the step's own expectations: preview figures, execution result, the history rows the step added
   (exactly those, in order; a step that states none must add none);
2. merges the step's state expectations into the running expected state and compares the **whole** expected state
   with the Terminal: cash by bucket, positions, gross holdings, pending settlements, open orders, lifecycle items,
   P&L, net asset value, balance sheet, borrowings, failures. A step states only what it changes; everything stated
   earlier is checked again;
3. requires a clean integrity report (`GET /api/books/:id/integrity`, below);
4. at browser level, reads the Accounting screens (positions with the cash strip, holdings, pending trades, P&L,
   balance sheet with the borrowing register, history, and the Book's net asset value) and compares them with the
   API's figures (a display error) and with the spec's figures (to the decimals shown).

After the last step the application is restarted on the same database, everything is read again, and it must equal
what was read before the restart, row counts included. This is the automatic `restart` test of every scenario.

Expected values are literals worked out by hand from the inputs in the same spec, with the arithmetic in a comment
beside them. They are never copied from what the Terminal prints. `specs.test.js` rechecks the ones that follow
directly from stated inputs (trade cash, fee, settlement date) with the independent calculators in `lib/calc.mjs`,
which import nothing from `server/`.

## What a result means

Test ids are `E:<product>:<step>`, `A:<product>:<step>`, `B:<product>:<step>` (`E:T:<template>:<step>` for an
execution template). Every scenario also has the steps `setup` and `restart`. A results file maps id to:

- `passed`: the step ran and everything above matched.
- `blocked` / `unsupported`: the spec declares that the Terminal does not allow the action (`blocked`: not in this
  state, such as selling more than is held; `unsupported`: not at all, the event is recorded by hand instead). The
  step passes only if the Terminal **visibly refuses** with the stated reason and nothing changes. If the Terminal
  performs the action, or refuses for another reason, the step fails.
- `failed`: something did not match. The message lists every mismatch. The scenario stops; later steps get no entry.
- no entry: not run. The matrix shows "not run". Running a product again first removes all of its earlier entries
  at that level, and the matrix looks results up by id from the current spec, so a changed or new step cannot keep
  or inherit a result. Nothing is marked tested because another product, level or step passed.

Each entry also carries the message, duration, commit (`<sha>+changes` when the tree differs from it) and time.

## Layout

```
specs/<family>.mjs       the scenarios of one engine family (data)
lib/specs.mjs            loads and validates specs            lib/runner.mjs    runs one scenario against one driver
lib/actions.mjs          what each step action does through a client (engine and API levels)
lib/normalize.mjs        Terminal answers -> the shapes specs state expectations in
lib/compare.mjs          comparison rules                      lib/calc.mjs      independent calculators
lib/sandbox.mjs          disposable directories and the guard  lib/server.mjs    disposable server process
lib/results.mjs          results files                         lib/cli.mjs       command line
drivers/engine.mjs       client on an in-process app           drivers/api.mjs   the same client over HTTP
drivers/browser.mjs      the interface: setup, shared screens, preview and confirmation, Accounting readers
drivers/browser/<family>.mjs   what differs by family: contract fields of the registration form, the ticket
engine.test.js  run-api.mjs  run-browser.mjs      the three runners
specs.test.js   harness.test.js                   spec audit; tests of the harness itself
```

## Disposable databases only

Everything that opens a database takes a sandbox object from `createSandbox()`; there is no way to pass a path.
`assertSandbox()` runs again immediately before each open and refuses a directory this process did not create (it
keeps the directory's random marker in memory), anything inside the repository (so never `data/`), and anything
outside the temporary base. The server is started with `SDT_DATA_DIR` and `SDT_DB_FILE` pointing into the sandbox
and every other `SDT_*` / `SHAFFER_*` variable removed, and the harness stops it if the database path it prints is
not the sandbox's. Servers are stopped by PID. `harness.test.js` tests all of this.

## Controlled fixtures (demo mode only)

Fixtures stand in for the Shaffer services only. They exist in demo mode; in normal mode every call is refused
with 403. Each observation they produce has source `Test fixture` and status `simulated`. They are stored in the
database, so they survive a restart.

| Route | Body |
|---|---|
| `POST /api/demo/fixtures/quote` | `{ instrumentId, bid, ask, last, bidSize, askSize, asOf? }`; `{ instrumentId, clear: true }` stops the quote |
| `POST /api/demo/fixtures/close` | `{ instrumentId, date, value }` end-of-day close |
| `POST /api/demo/fixtures/fx` | `{ pair: 'USD/JPY', rate }` (the inverse pair is answered too) |
| `POST /api/demo/fixtures/rate` | `{ code, value, date?, currency? }` reference rate, percent per annum |
| `POST /api/demo/fixtures/borrow` | `{ instrumentId, available, quantity, feeRate }` securities-borrow data |
| `GET /api/demo/fixtures` | what is in force |
| `POST /api/demo/advance` | `{ to: '<ISO instant>' }` absolute clock (existed before) |

The scripted hedge fixture (`POST /api/demo/hedge-script`, added by the hedge work) is separate and is not driven
by this harness yet.

`GET /api/books/:id/integrity` (any mode, read-only) returns `{ ok, checks, problems, counts }`. The checks and
the keys that define a duplicate fill, settlement, payment, accrual or posting are listed at the top of
`server/core/integrity.js`.

## Writing a spec

`specs/<family>.mjs` exports `family` (the catalog's engine family id) and a default array of specs. A spec:

```js
{
  productId: 'adr',                      // catalog id (or `template: '<id>'` for an execution template)
  title: 'Kobori Precision Instruments ADR, NASDAQ-listed, Japanese issuer',
  matrix: {                              // all eight are required; they become the matrix columns
    ticket, requiredFields: [], automaticInputs: [], manualInputs: [],
    settlement, lifecycle, accounting, collateral,
  },
  tradedOn: '...',                       // only when no instrument of exactly this product can be registered: say why
  start: '2026-03-02T15:00:00.000Z',     // absolute; a Monday 10:00 New York whose week you have checked for holidays
  settlementCheck: { lag: 1, holidays: [] },   // for the spec audit: the lag and the holidays you checked by hand
  book: {
    name, reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }],                      // deposited into Treasury
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] },
    settings: { fees: {...}, fill: {...}, settlement: {...}, ... },    // stated in full: no figure rests on a default
  },
  instruments: { main: { productId, name, symbol, marketView, venue, venueType, venueCountry, tradingCcy, terms, ... } },
  quotes: { main: { bid, ask, last, bidSize, askSize } },              // fixtures in force at the start
  borrow: { main: { available, quantity, feeRate } },  fx: { 'USD/JPY': 150 },  rates: { SOFR: 4.3 },  closes: { main: { '2026-03-02': 50 } },
  expectAtStart: { cash, positions: [], pending: [], nav, ... },       // state after setup, before any step
  steps: [ ... ],
}
```

Instruments are referred to by their key (`main`), owners as `account` or `treasury`, and what a step opens by the
name it gives it (`as: 'lot'`); the securities borrow of `main` is `borrow:main`.

### Steps

Every step has `id` (lower-case, digits, dashes; unique; it is the test id), `action`, optionally `covers` (the
matrix action or actions it exercises: `open`, `increase`, `reduce`, `close`, `settlement`, `dividend`, `borrow`,
... one matrix row per distinct name; a step with none is listed as a market data or clock move), and `expect`.

| `action` | Fields | Engine / API | Browser |
|---|---|---|---|
| `ticket` | `instrument`, `side` (`buy`, `sell`, `sell_short`, `buy_to_cover`), `qty`, `as` (opens) or `from` (reduces), `owner?`, `order?: { orderType, limitPrice, stopPrice, tif, statedPrice }`, `borrow?`, `financing?`; a ticket that is not the security ticket states its request as `input` (see below) plus whatever its browser driver fills in | the request the ticket sends | the family's `ticket()` then the shared preview and confirmation |
| `close` | `lot`, `scope: 'strategy' \| 'position'`, `percent?`, `instrument?` | strategy close preview | strategy instance: Close, or Close on the position row |
| `resize` | `lot`, `factor` | resize preview | strategy instance: Resize |
| `package` | `input` (a raw package request; `'$inst:key'`, `'$unit:account'`, `'$lot:name'` are replaced by ids), `as`, `instrument` | preview and confirm | needs the family's `actions.package` |
| `corporate_action` | `instrument`, `type`, `exDate`, `amount` or `ratioNum`/`ratioDen` | route | Instrument drawer form |
| `cashflow` | `lot`, `category`, `amount`, `note` | position lifecycle route | position: manual cash flow |
| `lifecycle` | `lot`, `body` (`{ action: 'exercise' \| 'redeem' \| 'convert' ... }`) | position lifecycle route | position's Lifecycle menu: asserts a refusal when the event is not offered; recording an offered event other than a cash flow needs the family's `actions.lifecycle` |
| `manual_price` | `instrument`, `value` or `bid`/`ask`, `note` | route | Instrument drawer: enter a price by hand |
| `register_instrument` | `draft`, `as?` | route | registry form |
| `transfer` | `from`, `to`, `ccy`, `amount` | route | Transfer cash dialog |
| `quote`, `close_price`, `fx_rate`, `rate`, `borrow` | fixture bodies (`quote: {...}` or `quote: { clear: true }`, `pair`/`rate`, ...) | fixture route | fixture route |
| `clock` | `to` (absolute instant) | demo clock, then one engine cycle | same |
| `cycle` | none | one more engine cycle (working orders, partial fills) | same |
| `deposit`, `instrument_lifecycle` | see `lib/actions.mjs` | route | not implemented in the browser driver yet |

A step the Terminal should refuse adds `status: 'blocked'` or `'unsupported'`, a `reason`, and
`expect: { refused: 'text the refusal contains' }` (or a RegExp, or `{ engine, api, browser }` when a screen words
it differently).

### Expectations

`expect.preview`, `expect.result` and `expect.events` belong to the step. Everything else in `expect` is state and
persists: objects merge key by key, arrays and numbers replace, and `null` means "must be missing" (use it to take
an earlier expectation away; `undefined` is ignored). State what the step changes, including values that go back
to zero. The shapes (all figures in the owner's currency unless the name says otherwise) are built in
`lib/normalize.mjs`:

- `cash.<owner>.<CCY>`: `settled`, `unsettled`, `receivable`, `payable`, `reserved`, `restricted`, `margin`,
  `availableToTrade`, `availableToWithdraw`, `borrowed`, `lent`
- `positions[]` (sorted by instrument key, lot, quantity): `instrument`, `lot`, `owner`, `direction`, `qty`,
  `avgCost`, `cost`, `price`, `value`, `unrealized`, `restrictedCash`, `accrued`, `provisional`, `priceSource`
- `holdings.<instrument>`: `long`, `short`, `net`
- `pending[]` (sorted by due date, instrument, amount): `instrument`, `lot`, `owner`, `dueDate`, `amount`, `ccy`, `into`
- `openOrders[]`, `lifecycle[]`, `failed: { orders, settlements, lifecycle }`, `alerts[]`
- `pnl.account` / `pnl.book`: `realized`, `dividends`, `couponInterest`, `borrowFunding`, `lendingIncome`,
  `commissions`, `fees`, `unrealized`, `fx`, `total`, `navEnd`
- `nav`: `account`, `treasury`, `book`; `provisional`: `account`, `book`
- `balance.account` / `balance.book`: the balance sheet lines by key (`cash`, `positions`, `payable`, ...),
  `assets`, `liabilities`, `netAssets`, and `local.<CCY>` for the same lines in a foreign currency
- `borrowings[]`: `owner`, `family`, `instrument`, `lot`, `qty`, `value`, `principal`, `rate`, `accrued`,
  `costToDate`, `collateralCash`, `nextPayment`
- `preview`: `blocking`, `errors`, `warnings`, `legs[]` (`kind`, `action`, `instrument`, `qty`, `estimate`, `model`,
  `priceSource`, `settleDate`, `calendar`, `cash`, `fees`, `borrow`, `shortCollateral`, ...), `cash.<CCY>`
  (`purchases`, `proceeds`, `fees`, `margin`, `collateral`, `required`, `available`, `shortfall`, ...)
- `result`: `status`, `orders[]` (`action`, `status`, `filledQty`, `avgPrice`, `fills[]`)
- `events[]`: `type`, `summary` (text contained, or RegExp), `cash`, `owner`, `date`

By its first trade a scenario must have stated `cash`, `positions`, `pending`, `pnl`, `nav` and `balance`; the
runner fails it otherwise. Comparison is partial by key and exact by value (0.000001; a figure read from a screen
must agree to the decimals shown). Arrays are compared whole.

## Adding a family

1. Read `specs/equity.mjs` (start with `common_stock`, then `short_sale` for financing and refusals).
2. Write `specs/<family>.mjs`: one spec per catalog product of the family, each on an instrument registered as
   exactly that product with realistic terms, each with its own Book settings, and steps for every action its
   ticket offers, its settlement and lifecycle events, the events the catalog says are manual (recorded by hand
   through the interface), restricted or reserved cash where it applies. Work every figure out by hand. For an
   action the Terminal does not support, write the step with `status` and assert the refusal.
3. Run the engine level for one product until it passes:
   `SDT_MATRIX_PRODUCT=<id> node --disable-warning=ExperimentalWarning --test test/matrix/engine.test.js`.
   A mismatch is either your arithmetic or a Terminal bug; decide which by hand, never by adopting the Terminal's
   figure. Then `npm run test:api -- --product=<id>`.
4. Write `drivers/browser/<family>.mjs` (model: `drivers/browser/equity.mjs`, about 70 lines). It exports
   `contractTerms(ui, dialog, draft, ctx)` to fill the family's contract fields on the registration form, and
   `ticket(ui, t, ctx, step)` to fill the family's ticket and return `{ preview }` (a function that presses the
   button opening the trade preview) or `{ refusal }`. Optionally `actions`, a map from step action to a function
   that performs it in the interface; it is consulted before the shared paths, and returning nothing falls through.
   The registration form's contract fields are filled by the driver of each instrument's own family, so a scenario
   that also registers a stock reuses `equity.mjs`; a step can borrow another family's ticket with `ticketOf`.
   Use the label-based helpers of `ui` (`field`, `input`, `select`, `option`, `button`, `section`, `dialog`); no
   CSS paths. Setup, preview and confirmation, closing and resizing, events by hand and all reading back are shared.
   Then `npm run test:browser -- --product=<id>` (add `--headed --slow=150` to watch).
5. If a step action has no path yet at some level, add it to `lib/actions.mjs` (engine and API) and to
   `sharedAction` in `drivers/browser.mjs` or your family's `actions`. If the Accounting screens show something
   for your family that `readScreens` does not read yet, add it there with its comparison in `screenProblems`.
6. `npm test`, `npm run test:api`, `npm run test:browser`, `npm run matrix`.

Execution templates go in `specs/templates.mjs` (`family = 'templates'`, each spec with `template: '<id>'` and
`package` steps); `harness.test.js` proves that path at engine level. No template spec exists yet.

## Things to know

- The API and browser servers run with the engine timer off (`SDT_ENGINE=off`); the runner calls one engine cycle
  after every step, as the timer would. Timer-driven concurrency is therefore not exercised.
- The clock is set to absolute instants. The demo clock does not persist when it is moved back before the real
  time, so the harness sets it again after each restart.
- At browser level the Book's paper-desk settings, the fixtures and the clock are set through the API (they stand
  in for the outside world or have no bearing on the product); everything else in setup and every user action goes
  through the interface. The post-trade Hedge prompt is closed whenever it appears.
- Measured on a 2-core machine: about 0.3 s per product at engine level, 1 s at API level and 15 to 22 s at
  browser level (one worker).
