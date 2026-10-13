# Task UI1: Marketplaces by product family, correct classification, product-specific displays, trading owner

Owner request (`$SP/OWNER_REQUEST2.txt`) sections **1, 2, 3**. Read them first; they are the specification. Then
`$SP/BRIEF1.md` (design system, interface copy rules, product rules) and `$SP/BRIEF3.md`, `$SP/BRIEF5.md`.
Your id: ui1. Workspace `$SP/ui1` (ports 8881 demo, 8882 normal).

## Files you own
`web/views/markets.js`, `web/views/strategy.js` (the owner selector and what depends on it), the Marketplace
grouping in `server/core/catalog.js` and `server/core/instruments.js` (classification fields and the instrument
view), `server/data/demo-seed.js`, the instruments / catalog / watchlist routes in `server/api.js`,
`web/views/registry.js` (classification fields), `test/matrix/drivers/browser.mjs` function `openInstrument` and any
shared helper that navigates the Marketplaces or picks the trading owner (other people's browser tests run through
them all day: keep them working at every save, and re-run `npm run test:browser -- --product=common_stock,treasury_note,
equity_option,equity_index_future,interest_rate_swap,unsecured_loan` after each change to those screens).
New tests: `test/core/marketplaces.test.js`. CSS appended to `web/app.css`.

## What to build
1. **Product-family tabs inside each of the four Marketplace views** (the four views stay). Cash views: Equities;
   Funds and ETFs; Bonds and Credit; Money Market and Deposits; FX and Currencies; Commodities; Crypto and Digital
   Assets; Alternatives and Other. Derivative views: Options; Futures; Forwards; Swaps; Credit Derivatives;
   Structured and Other Derivatives. Every one of the 205 catalog products maps to exactly one tab (a table in
   `catalog.js`, tested: no product unmapped, none in two tabs, the mapping printed in `docs/COVERAGE.md` by its
   generator). A tab with no instruments says what belongs there and how to add one. Tabs show counts. The tab is
   in the URL. Underlying asset-class filter where useful (derivative tabs: equity, rates, credit, FX, commodity,
   crypto, volatility, other). Search within the view. No undifferentiated table anywhere.
2. **Watchlists stay separate from product tabs**: a watchlist control that filters within the current tab or
   shows the watchlist across families, never replacing the tabs.
3. **Borrowing, lending, repo, collateral and funding stay on the Treasury and Account pages**, with links from the
   relevant instruments (instrument drawer: "Borrow this security", "Repo this holding", "Lend", "Finance this
   position" lead to the existing Treasury / Account dialogs with the instrument pre-filled; no new engine paths).
4. **Classification from explicit metadata, never from the price currency**: listing venue and its country,
   venue type (exchange, OTC, global), instrument jurisdiction, contract terms. US Based versus Foreign Based is
   decided by the listing venue's country for listed products. Global FX, crypto and OTC products have no US
   exchange listing: decide and DOCUMENT the routing convention (in the view's own text, in `docs/ARCHITECTURE.md`
   and README), store the basis of each instrument's routing ("listed in US", "OTC, routed by convention to ...",
   "set by hand"), show it on the row and the instrument page, and let it be set by hand where the convention
   needs a choice. Fix the demo seed and registration so nothing is "US" merely for being quoted in USD. Tests.
5. **Columns that fit the product**: stocks (price, bid/ask, change, held), bonds (clean price in % of par with the
   decimals it has, coupon, maturity, accrued, yield only if supplied, never computed here), options (underlying,
   strike, right, expiry, premium, deliverable), futures (underlying, expiry, contract value, initial margin per
   contract), FX (pair, rate, value date convention), swaps and credit (legs summary, notional, maturity, mark and
   its kind), funds (NAV and its date), deposits and loans (rate, term). Current market price, Fair price and
   Gap % sit together; fair price and gap are for the same contract, currency and units and for the selected
   investment Strategy, and stay "Awaiting Shaffer data connection" until Analytics Lab supplies them (no
   valuation models in the Terminal). Every price shows whether it is an observed quote, indicative terms, a model
   mark, a manual input or simulated (the existing `Price` / `Prov` components). The bond price display fault in
   `$SP/BUGS.md` (three decimals) is yours to fix with a units-aware formatter.
6. **Strategies page owner selector**: it is labelled "Trading owner"; it lists the Book's Accounts and,
   explicitly distinguished, Treasury ("Treasury (the Book's own balance sheet)"). In a Book with no Accounts it
   does not silently fall back to Treasury: it shows Treasury as an explicit choice plus a prompt to create an
   Account, and nothing is pre-selected by substitution. Same wording on tickets ("Trading owner"). Treasury-owned
   trading remains supported. Investment Strategy (by stable ID, typed names unresolved) stays separate from the
   execution template.
7. Look at every state: each view and tab, light and dark, demo and normal mode, 1440, 1024 and 390 wide, an empty
   Book, a Book with no Accounts. No console errors. `npm test` passes.

Milestones for the save script: tabs and mapping with tests (1 point); classification and routing convention
(1 point); product-specific columns (1 point); trading owner (0.5 point); financing links and final screen check
(0.5 point). Report under 60 lines, including the routing convention you chose and why.
