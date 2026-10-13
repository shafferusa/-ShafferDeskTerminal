# ui1 progress (Marketplaces by product family, classification, columns, trading owner)

## Done
- Read BRIEF3, BRIEF5, UI1 task, OWNER_REQUEST2 s1-3, BRIEF1. Read markets.js, catalog.js, instruments.js, demo-seed.js, driver openInstrument.

## In progress
- Design: tab mapping table in catalog.js (MARKET_TABS + PRODUCT_TAB), routing convention, driver aliases.

## Next
1. catalog.js tab mapping + test/core/marketplaces.test.js + COVERAGE.md generator; markets.js tabs (URL #/markets/<view>/<tab>); driver openInstrument goes to tab. Save (1 pt).
2. Routing convention (classification fields, basis on row + instrument page, hand override), demo seed fix, docs. Save (1 pt).
3. Product-specific columns + units-aware bond price formatter (BUGS.md). Save (1 pt).
4. Trading owner selector (strategy.js, ticket label), driver field alias. Save (0.5).
5. Financing links from instrument drawer; screen check all states. Save (0.5). Report.
