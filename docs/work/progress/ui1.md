# ui1 progress (Marketplaces by product family, classification, columns, trading owner)

## Done
- catalog.js (appended, "Marketplace product-family tabs" and "Marketplace routing convention"): MARKET_TABS (14), TAB_LISTS/PRODUCT_TAB (205 products, one tab each), ASSET_CLASSES/PRODUCT_ASSET, assetClassOf, conventionRoute, routingShort, routingText; catalogSummary products carry tab/assetClass, plus marketTabs/assetClasses/routingBases.
- schema.js migration 8: instruments.jurisdiction, instruments.routing_basis.
- instruments.js: routeFor (listed > financing > underlying > jurisdiction/issuer domicile > convention(Foreign) ; explicit different view => manual; listed mismatch refused), routingPatch on update (routingBasis 'auto'), toView.classification {tab, tabLabel, assetClass, routing{basis, basisLabel, stored, convention, text, short}}, jurisdiction.
- demo-seed.js: views derived (no marketView passed); SIMCOIN venueType global -> FOREIGN_CASH convention; FX pairs global, no US_CASH tag; bonds jurisdiction US.
- api.js: analyticsFor(insts, strategyId); /api/quotes?strategyId; /api/instruments?marketplace=1 (bond accruedPer100) &tab=; GET /api/instruments/routing.
- web/lib/core.js fmtPriceUnits + PAR_UNITS; web/lib/ui.js Price uses units (obs.units) -> bond prices keep decimals (BUGS b1 #1, partly: preview/accounting still call fmtPrice).
- web/views/markets.js rewritten: tabs with counts in URL (#/markets/<view>/<tab>), search across view grouped by family, watchlist select + In this tab / Across families, asset-class filter (deriv), per-tab columns, Fair price for Strategy select, fair price checks (currency/units/strategy), FinancingPanel on money tab.
- app.css "marketplaces (ui1)" block.
- test/matrix/drivers/browser.mjs: openInstrument goes to view/tab (classification.tab or catalog tabOf); ui.field('Account') also matches "Trading owner"; ui.section('Account and intent') also matches "Trading owner and intent"; ui.chooseOwner.
- test/core/marketplaces.test.js (8 tests pass); scripts/coverage-report.js prints tab mapping; docs/COVERAGE.md regenerated; ARCHITECTURE.md + README routing convention.
- npm test 393/393. Browser 6 products: 5 match baseline; interest_rate_swap open step fails on "margin posted" screen vs API (looks like others' collateral work; re-check).

## In progress
- nothing half-edited.

## Next
1. Save milestone 1 (done above). 2. Registry form: Jurisdiction field + routing (By convention / set by hand) using /api/instruments/routing; instrument page Overview shows routing basis. Save (1 pt).
3. Product columns polish (done mostly) + preview/accounting bond price via fmtPriceUnits. Save (1 pt).
4. Trading owner: UnitSelect/defaultUnit in instrument.js (no Treasury fallback; optgroups Accounts / Treasury (the Book's own balance sheet)), label "Trading owner" on tickets + strategy.js panel "Trading owner and intent", prompt to create Account. Save (0.5).
5. Financing links from instrument drawer -> Treasury/Account ArrangementDialog with instrument; screens all states. Save (0.5). Report.
