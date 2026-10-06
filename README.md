# Shaffer Desk Terminal

The paper-trading front end of the Shaffer System.

```
External sources -> Shaffer MarketData Database -> Analytics Lab / approved service API -> Desk Terminal (this repository)
```

The Terminal shows prices and analytics, and runs persistent, simulated portfolio management:
Books, Treasury, Accounts, funding, paper execution, settlement, lifecycle events and accounting.

**Every order, borrow, loan, funding movement, collateral movement and settlement is simulated.
The Terminal does not connect to real-money execution.**

## Run it

Requires Node.js 22.13 or newer. There is nothing to install: the Terminal has no npm dependencies.

```
git clone https://github.com/shafferusa/-ShafferDeskTerminal.git
cd -ShafferDeskTerminal
npm start          # your paper books        http://127.0.0.1:8787
npm run demo       # isolated demo           http://127.0.0.1:8788
npm test           # engine test suite
```

`npm start` opens your real paper books in `data/terminal.db`. Until the Shaffer services are
connected, prices and analytics show **Awaiting Shaffer data connection**; you can register
instruments and enter prices by hand, and they are always labelled as manual.

`npm run demo` is a separate environment for trying things: a simulated feed, fictional
instruments, its own database (`data/demo.db`) and a clock you can move forward. Nothing in demo
mode touches your real paper books, and no demo price is ever shown as a market quote.

### Settings read from the environment

| Variable | Purpose | Default |
|---|---|---|
| `SDT_PORT` (or `--port=`) | Port to listen on | 8787, or 8788 in demo |
| `SDT_HOST` | Address to bind | `127.0.0.1` |
| `SDT_DATA_DIR` | Where the databases live | `./data` |
| `SDT_PASSWORD` | If set, the Terminal asks for this password (HTTP Basic). Set it before hosting anywhere but your own machine. | not set |
| `SHAFFER_MARKETDATA_URL`, `SHAFFER_ANALYTICS_URL`, `SHAFFER_GATEWAY_URL` | Service addresses (can also be saved on the Data connection page) | not set |
| `SHAFFER_API_TOKEN`, `SHAFFER_AUTH_HEADER` | Service credential and the header it is sent in. Kept on the server only: never stored in the database, never sent to the browser. | not set, `Authorization` |

## What is in it

| Screen | What it is for |
|---|---|
| **Book selector** and **Manage Books** | Each Book is a separate workspace with its own Treasury, Accounts, positions, liabilities, strategies and accounting history. One Book is selected at a time and every screen shows that Book only. There is no combined view, total or transfer across Books. |
| **Accounting** | P&L, balance sheet, open positions, pending trades, failed and cancelled trades, and full history, at four scopes inside the selected Book: the whole Book (consolidated), Treasury, one Account, or several Accounts together. Every row names the Treasury or Account that owns it. |
| **Treasury** | Treasury's own cash, borrowings, lending and collateral, kept visibly apart from the Accounts it funds. Account-originated borrowings are listed for oversight as the same records, with the same IDs, that sit on the Accounts. |
| **Accounts** (under Treasury in the sidebar) | One page per Account: its cash, balance sheet, its own borrowings, funding from Treasury, and transfers. Choosing an Account makes it the Account in use on trade tickets and the Strategies page. |
| **Strategies** | 28 execution templates (long, short, covered and protective structures, spreads, straddles, condors, butterflies, calendars, synthetics, pairs, futures hedges, custom multi-leg). Requests the hedge package from Shaffer Hedge automatically, and holds the hedge review queue. |
| **Marketplaces** (US Based, US Derivatives, Foreign Based, Foreign Derivatives) | Filters over the instrument registry, with watchlists, search, Current market price, Fair price and Gap %, what the Book already holds (gross: `Long 200 \| Short 100 \| Net +100`), and a product-appropriate trade ticket. A listed product is placed by its listing venue; issuer domicile and underlying geography are stored separately. |
| **Preview** | Every package goes through one editable preview and one confirmation: each leg with its estimated fill and the fill model used, cash, margin, collateral and funding needs, borrow availability, break-even, maximum gain and loss, and every check. All figures come from one price snapshot, and a confirmation is refused if prices have moved the cash by more than the Book's tolerance. |
| **Instruments** | The instrument registry and the coverage list. Lifecycle support (what the paper engine simulates) and pricing coverage (whether there is a price source, and a price now) are shown as two separate things. |
| **Data connection** | The state of the two Shaffer service ports, dataset readiness, service addresses, refresh settings and manual entries. |
| **Settings** | Light or dark mode, market calendars and hand-entered holidays, and the Book's paper-desk assumptions (fees, fill model, settlement lags, short collateral, margin). |

Rules the engine holds to:

- A short sale needs a securities borrow. If the borrow fails, the short sale is rejected with it. Short-sale proceeds are restricted collateral, not buying power.
- Borrowed cash is a liability. It is settled cash at once, so a borrowed currency can be converted at spot immediately; the conversion still settles T+2.
- Treasury or any Account can borrow. A borrowing is one record with one ID, owned by the unit that borrowed. It appears on that unit's balance sheet, in Treasury's oversight view (labelled Account-originated, outside Treasury's own liabilities) and once in the consolidated Book. Funding between Treasury and Accounts is recorded as internal transfers and eliminated in consolidation.
- Holdings are shown gross. A long and a short in the same instrument are separate positions; the net is shown beside them, never in their place.
- A net asset value that rests on a missing or stale mark, or on a missing or stale conversion rate, is labelled provisional and names the items affected.
- A hedge recommendation is never executed by itself. Protection already in the template or the Account is recognised; adding more has to be acknowledged and is sized against the unprotected remainder. "Execute now" submits only the package that is displayed and checked.
- Legs of one package are separate orders with their own status. A leg that depends on another is scaled to what actually filled. A package is never called complete while a required leg is unfilled.
- An order is never filled silently at the last price: each fill names the fill model and keeps the price and FX observations it used. Data refreshes never rewrite fills, balances or history.
- A value that is not available is shown as missing, never as zero.
- Analytical fair values are never treated as executable quotes.
- Corrections add an adjustment and keep the original entry.

See [docs/COVERAGE.md](docs/COVERAGE.md) for what is simulated automatically, what needs manual
inputs, and what is not implemented, product by product.

## Connecting the Shaffer services

The Terminal talks to the outside world through one data adapter with two ports:

- **MarketData**: reference data, prices, history, FX, rates, calendars, earnings, corporate actions, derivative contract data, borrow and financing data.
- **Analytics Lab**: model runs, signals, EFS, Sector Score, Equity Score, Fundamental and Realistic Fair Value, both Gaps, valuations, timing, sizing, risk, and Shaffer Hedge.

The paper ledger is separate from both. Neither port is connected yet, by design: the Terminal does
not invent endpoints or assume a database table is an API. When the services exist:

1. Get the API documentation for each service: address (or the approved gateway), authentication, instrument ID scheme, payload examples, dataset coverage and refresh schedules.
2. Set the addresses on the **Data connection** page (or in the environment) and the credential in `SHAFFER_API_TOKEN` on the server.
3. Fill in the operations in [`server/data/shaffer-contract.js`](server/data/shaffer-contract.js). Each one maps a service call to the Terminal's own shapes, which are documented in [`server/data/ports.js`](server/data/ports.js). An operation left empty keeps showing "Awaiting Shaffer data connection" for its dataset; nothing else has to change.
4. Connect in this order: reference data, then prices, history, FX, rates, events, derivative contract data, financing data, then the Analytics Lab outputs.

Nothing in the screens, the ledger or the stored history needs to be redesigned for this.

## Layout

```
server/
  index.js, api.js, app.js, config.js   HTTP server, API routes, wiring, configuration
  core/        ledger, Books, positions, orders, packages (strategy instances), templates,
               payoff, valuation, accounting, hedge requests, lifecycle tasks, engine
  products/    one plugin per product family: economics, settlement, valuation, lifecycle
  data/        the data adapter: ports, Shaffer skeleton + contract file, manual entries, demo feed
  quant/       calendars, day counts, schedules, bond maths, option payoff helpers
  db/          SQLite schema and migrations
web/           the front end: no build step, native ES modules (Preact + htm, vendored)
test/          engine tests on a controllable clock
docs/          ARCHITECTURE.md, COVERAGE.md
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Things to know

- Positions use average cost.
- Capital enters and leaves a Book through its Treasury.
- Margin and holds are rule-based paper-desk assumptions that you can edit per Book. They are not a risk model.
- Settlement and payment dates use rule-based holiday calendars for US equities, US bonds, US dollar payments, the UK, the euro payment system (TARGET), Japan and Canada; FX value dates use both currencies' calendars. One-off closures can be entered by hand in Settings. Any other market falls back to weekends only, and the preview and the instrument say so. Euro-area exchanges use TARGET days, which is an approximation. Shaffer MarketData calendars replace all of this when connected.
- The demo clock can be moved forward; it stays where it was left when the demo is restarted.
- If the Terminal was not running when something fell due, it catches up in date order when it next starts, and books the events on the day it processes them.
- The demo environment includes a canned hedge fixture so the Hedge workflow can be exercised. It is labelled "demo fixture" everywhere, it is not Shaffer Hedge output, and it can be switched off on the Data connection page.
