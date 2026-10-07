# Shaffer Desk Terminal: correction round (read after AGENT_BRIEF.md)

First read `/tmp/claude-0/-home-claude--shafferdeskterminal/9fe505c4-25a7-5956-b73b-691c2f93387b/scratchpad/BRIEF1.md` in full: its
product rules, design system, copy rules, constraints and "running and checking your work" section all still apply.
This file adds what changed since, and the owner's new requirements that concern every screen.

## What changed in the app (already built; use it, do not rebuild it)
- **Books are separate workspaces.** One Book is selected at a time (top bar). Every screen shows that Book only.
  There is no "All Books" view and no cross-Book total anywhere. Book management lives at `#/books` (views/books.js).
- **Navigation** (web/app.js): within the Book the sidebar is Accounting, Treasury (with an expandable list of its
  Accounts, each linking to `#/account/<unitId>`), Strategies, Marketplaces, then Reference. Routes: `accounting`,
  `treasury` (views/treasury.js, formerly books.js), `account` (views/account.js), `strategy`, `markets`,
  `instruments`, `data`, `settings`, `books`.
- **Account in use** (web/lib/core.js): `useStore((s) => s.unitId)`, `setUnit(id)`, `currentUnit()`, `unitLabel(u)`.
  Choosing an Account in the sidebar or on any ticket sets it; tickets and the Strategies page default to it
  (`defaultUnit(book)` and `UnitSelect` in views/instrument.js already do this).
- **web/lib/ui.js additions**: `Holdings` (now draws `Long 200 | Short 100 | Net +100`, gross, never netted; `detail`
  lists each owning Account), `holdingsFromPositions(positions)`, `NavValue({ nav, ccy })` (a NAV with a "provisional"
  pill whose tooltip names the affected items), `NavAffected({ nav })` (the affected items as a notice list).
- **Server API additions** (read server/core/accounting.js and server/api.js for exact shapes):
  - Accounting scope is `book`, `treasury`, `accounts`, one unit id, or several unit ids joined by commas
    (`scope=AC-1,AC-2`): "selected Accounts together". A scope never leaves its Book.
  - `GET /api/books/:id/accounting/balance?scope=`: balance sheet as a consolidation worksheet:
    `{ columns: [{id,name,kind}], lines: [{key, section: 'assets'|'liabilities', label, note, cells: {unitId: cell}, total: cell}],
    assets, liabilities, netAssets: {cells, total}, representedBy: [capital, internal, results] (each {key,label,note,cells,elimination,total}; `internal`
    also has `residual`), consolidated, nav: {value, complete, provisional, affected}, borrowings: [...], fxRates, oversight }`
    where `cell = { rc, complete, byCurrency: [{ccy, amount}] }` (rc = reporting-currency amount at current FX).
    `oversight` is present only for the Treasury-alone scope: `{ note, accountBorrowings: [...], accounts: [{id, name, nav, fundingReceived: cell, cashBorrowed: cell}] }`.
  - `GET /api/books/:id/accounting/borrowings?scope=` -> `{ items }`: the borrowing register. One record per external
    borrowing: `{ id, contractId, name, owner: {id,name,kind}, originatedBy: 'account'|'treasury', accountOriginated, type, family,
    lender, ccy, principal, principalRc, securities: {instrument, qty, value}|null, rate: {type, rate, referenceRate, spread, text, dayCount},
    startDate, maturity, term, collateral: {kind, description, ...}, schedule: {interest, next: {date, type, blocked}|null}, accrued,
    interestToDate, interestToDateRc, feesToDate, strategy: {id,name}|null, terms: [[label, value], ...] }`.
  - `GET /api/books/:id/treasury` now also returns `borrowings: { direct: [...], accountOriginated: [...] }`, and
    `bookNav` / `treasuryNav` are now `{ value, complete, provisional, affected }`.
  - `GET /api/books/:id` overview: `navProvisional`, `navAffected` on the Book and `navProvisional` on each unit.
  - `accounting/positions`: `nav` now has `provisional` and `affected`; new `holdings: [{ instrument, long, short, net,
    owners: [{id, name, kind, long, short, net}] }]`; each position row has `hedgeRequest: {id, status, packages}|null`.
  - `accounting/pnl`: `nav.provisional`, `nav.affected`, `missing.stale`, `missing.fxStale`.
  - Instruments (`toView`): `venueCountry` (now stored), `calendar: {id, label, basis, fallback, approximate, note}`,
    `pricing: {basis, basisLabel, state: 'priced'|'unpriced'|'not-needed', current}`. Catalog products have `pricing`
    (basis) and the catalog payload has `pricing` counts and `pricingLabels`.
  - `GET /api/calendars`, `PUT /api/calendars/:id/holidays { dates: ['YYYY-MM-DD'] }` (hand-entered extra holidays).
  - `GET /api/hedge/queue?bookId=`; components `HedgeQueue`, `openHedgeFor`, `openHedgeRequest` in views/hedge.js.

## The owner's rules for this round (apply them in your screens)
1. Never combine Books. No control, column or total may span more than the selected Book.
2. Identify the owning Treasury or Account on every row of every accounting table, at every scope (not only in the
   whole-Book view).
3. Accounts may borrow cash or currencies directly; borrowing is not restricted to Treasury. An Account-originated
   borrowing must be visible on (a) the Account's balance sheet, (b) Treasury's balance-sheet / funding view, labelled
   as Account-originated, and (c) the consolidated Book balance sheet. These are views of ONE record with one ID. Never
   present it as an additional loan, and never add it to Treasury's direct liabilities. Treasury's direct balances and
   the Account balances it oversees must be visibly distinct.
4. At consolidated Book level external principal, liability, interest and fees count exactly once, and internal
   balances (funding between Treasury and Accounts) are eliminated. Show the elimination rather than hiding it.
5. Holdings are gross: `Long 200 | Short 100 | Net +100` with Account ownership. Never label a net quantity as the long holding.
6. A NAV that rests on a missing or stale mark or conversion rate is labelled **provisional**, and the affected items
   are named next to it (use `NavValue` / `NavAffected`). Do not use the word "incomplete" for this any more.
7. Pricing coverage (is there a price source, and a price now?) and lifecycle support (what the paper engine simulates)
   are two different things. Show and label them separately wherever either appears.

## Working rules for this round
- Other people are editing other files at the same time. Edit only the files named in your task. Do not edit
  `web/lib/*`, `web/app.js`, `web/views/hedge.js`, `web/views/preview.js`, `web/views/strategy.js`,
  `web/views/instrument.js`, `web/views/markets.js`, or anything under `server/` or `test/`.
  If the API is missing something you need, report it; do not change the server.
- Keep your files in a working state at all times: make changes in small steps and check the page still loads after
  each, because your run may be stopped at any moment and whatever is on disk is what ships.
- Start your own demo server on your own port and data dir as AGENT_BRIEF.md describes, and create the activity you
  need (see `test/core/reconciliation.test.js` and `test/core/fixed-income.test.js` for working inputs: an Account
  loan, a Treasury loan, a JPY loan, transfers both ways and Account to Account, a long and a short of the same
  instrument in one Account, an unpriced holding, a repo).
- Look at every screen you touch, light and dark, at 1440x900, in demo mode and once in real (awaiting) mode.
- When you finish, stop your servers and report: what each change does, anything you could not do and why, any bug
  you found (with a reproduction), and confirmation that `npm test` still passes (74 tests) and your screens show no
  console errors.
