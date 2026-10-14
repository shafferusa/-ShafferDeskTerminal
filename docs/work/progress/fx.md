# fx progress: historical-FX regression test

## Done
- test/core/historical-fx.test.js (mine alone): one Book, Treasury + North + South, USD/EUR/JPY capital, 5 Treasury
  fundings, Account-to-Account EUR, EUR return, rates up (1.20/125) and down (1.05/160), EUR capital withdrawal at
  1.05, rates back (1.10/150), a transfer at 1.15. 625 checks, all pass. Hand figures in the header comment.
- Old behaviour proved: fix reverted in a scratch copy only ($SP/fx/repo, deleted after); 170 of 625 checks fail
  (capital, internal funding cells/totals, results, investment P&L = results, oversight funding, gross elimination
  sides, Accounts-combined funding/results). Output kept in $SP/fx/old.txt.
- npm test: 785/793; the 8 failures are template specs (test/matrix/specs/templates-a.mjs, being edited by another
  worker): matrix E cash_secured_put and spec audits protective_put/call, covered_call/put, long/short_collar, futures_hedge.
- No Terminal fault found; no shared file changed.

## In progress
- nothing.

## Next
- nothing (report sent).
