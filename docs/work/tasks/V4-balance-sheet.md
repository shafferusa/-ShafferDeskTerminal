# Task V4: balance sheets that stay usable with many Accounts

Owner request section **1**, last bullet: "Make balance sheets usable with many Accounts through filters, grouped
columns, and pinned row labels."

Your workspace: `$SP/v4` (port 8841 demo). No migration.

## Files you own
- The balance-sheet tab of `web/views/accounting.js` (the consolidation worksheet component and its helpers only;
  other people are editing other parts of this file: use Edit on your region, never rewrite the file).
- `web/views/account.js` and `web/views/treasury.js`: only if their small balance-sheet panels need the same fix.
- CSS appended at the end of `web/app.css` under `/* ---- balance sheet ---- */`.
- If the server response lacks something you need, you may add fields to `accounting.balanceSheet` in
  `server/core/accounting.js` (additive only) and say so in your report.

## Today
`GET /api/books/:id/accounting/balance?scope=` returns a consolidation worksheet: one column per unit (Treasury,
each Account), an Eliminations column and the total. With about seven owners the table scrolls sideways and the
line labels scroll away.

## What to build
1. Pinned row labels: the "Line" column stays in place while the columns scroll horizontally; the total column
   stays visible too (pinned on the right) so a line can always be read against its total. Header row stays visible
   when the page scrolls vertically.
2. Grouped columns: Treasury | Accounts | Eliminations | Book (or scope total). The Accounts group can be collapsed
   to one "Accounts, combined" column (the sum of its members, with internal balances between those Accounts
   eliminated exactly as the server reports for an Accounts-only scope) and expanded back to one column per Account.
   With many Accounts it starts collapsed; the count is shown.
3. Filters: choose which Accounts are shown as columns (search by name, select several, "only with balances on
   this line group", "only with borrowings"); the choice is reflected in the URL or kept for the session; hidden
   Accounts are still inside the totals and the screen says how many are hidden. Filtering columns never changes
   the Book total. Option to hide lines that are zero for every shown column.
4. Never show a combined figure the server did not supply or that you cannot derive exactly from its cells; if a
   cell is incomplete (missing conversion rate) the combined cell is incomplete too.
5. Numbers stay right-aligned and tabular; no wrapping in numeric cells; readable in light and dark.

## Check
Build a demo Book with 15 Accounts (API), several with funding, positions, an Account-originated borrowing in USD
and one in JPY, and an Account-to-Account transfer. Verify by API arithmetic (not by eye) that the collapsed
"Accounts, combined" column equals what `scope=accounts` reports and that every line still sums to the total.
Look at it at 1440x900, 1024x768 and 390x844, light and dark, at Book, Treasury, one-Account and several-Account
scopes, and with 2 Accounts (must still look as it does today). No console errors. `npm test` still passes.
