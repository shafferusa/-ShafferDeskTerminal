# Resume note: final correction and verification pass

This folder is working material for the pass requested on 2026-10-06 (the request is `briefs/OWNER_REQUEST.txt`).
It is removed when the pass is finished and replaced by the evidence report. If work stopped part-way, start here.

In these files `$SP` is a scratch directory that may no longer exist; the copies in this folder are what remains.

**Completeness: about 45.5% of the pass** (last milestone 2026-10-07T11:50Z, s8: isolation cases pass at engine and API level (all 89 routes classified and tested; demo and normal databases separate); two more Terminal fixes (cross-Book hedge request, other Books' contracts hidden))

`LOG.md` beside this file lists every milestone since, newest last; `progress/` holds each worker's own notes.

## Usage guard (owner rule, 2026-10-06): read this before doing anything heavy

Stop all background work when the owner's weekly **Fable** usage reaches 98%.

- Claude Code exposes only the 5-hour window and the all-models weekly percentage to scripts. The Fable figure
  exists only in `/usage` and on the claude.ai usage page, so it has to be estimated or reported by the owner.
- A terminal session on the owner's laptop writes the all-models figure to
  `C:\Users\logan\.claude\usage_state.json` (`seven_day_used_percentage`, `seven_day_resets_at`, `written_at`
  in Unix seconds). A cloud session can read it only while it is linked to that computer.
1. At the start of any long task ask the owner for the two numbers from `/usage` ("Current week (all models)"
   and "Current week (Fable)") and compute r = Fable% / all-models%. Re-ask whenever new numbers are given.
2. Before each heavy step, and at least hourly while work runs, read `usage_state.json`:
   estimated Fable% = r x `seven_day_used_percentage`. If the file cannot be read, or `written_at` is more than
   2 hours old, usage is unknown: ask the owner before continuing.
3. At an estimated 95%: refresh this note and tell the owner the estimate.
4. At an estimated 96%, or as soon as the owner reports Fable at 98% or says "pause": stop all running agents,
   delete the scheduled check-ins, commit and push, finalise this note, notify the owner, and do nothing until
   the owner says "resume".
5. Never estimate in the owner's favour. When unsure, pause.

Last known figures: 5:30 PM ET on 2026-10-06, Fable 14% against 10% for all models (r = 1.4), before this pass
started. The all-models figure was reported as 35% at about 9:57 PM ET.

## Owner's instruction at 05:46 AM ET on 2026-10-07

Weekly Fable usage is at about 87%. "Work until it hits its limit. Write notes so you can resume when usage is
back." So work continues on Fable until the limit ends the session; there will be no chance to tidy up when that
happens, which is why every milestone pushes a snapshot of the whole tree (`LOG.md` is the record). The owner
reported the weekly reset as Tuesday 2026-10-13, 11 AM ET. On resuming: read this file, `LOG.md`, `progress/`,
`BUGS.md` and `tasks/GROUPS.md` (how to restart each group of products), run `npm test`, then continue.

Restarted at 09:50 UTC with four workers continuing from their notes: b1 (bonds, government), l1 (loans), s1 (rate
swaps), s8 (failure and recovery). If the log's last entries are from these four, they were cut off mid-task: the
tree is as they left it at their last save, and files they were editing after that save are lost.

## State at the last update (2026-10-07 09:45 UTC)

**Holding since the 5-hour session limit was hit at about 02:47 UTC (10:47 PM ET).** Six of the eight workers of
wave 1 were cut off by it mid-task; their finished work is committed, their notes are in `progress/`, and none
left a half-edited file. The engine suite passes 299 of 299 on the tree as committed. No agents are running and
no check-in is scheduled. Under the usage guard the next heavy step waits for the owner's `/usage` numbers.

Wave 1, product by product (a product counts only when it passed at engine, API and browser level; see `LOG.md`):
- hedge follow-up (`progress/v1b.md`): finished. Collateral basis and stated fill price chosen in the hedge popup,
  the swap and FX-forward packages executed from it, was / now on a refused "Execute now", routes documented.
- listed options (`progress/o1.md`): 5 of 5 logged as passing. No final report was delivered.
- futures (`progress/fu1.md`): 11 of 11 logged as passing. No final report was delivered.
- bonds, government (`progress/b1.md`): 5 of 13 (treasury_note, treasury_bill, treasury_bond, strips,
  foreign_gov_bill); the bond browser driver exists.
- loans (`progress/l1.md`): 4 of 9 (unsecured_loan, term_deposit, certificate_of_deposit, bank_deposit); the loan
  browser driver exists.
- rate swaps (`progress/s1.md`): 3 of 12 (interest_rate_swap, ois, basis_swap); the swap browser driver exists.
- failure and recovery (`progress/s8.md`): refusal cases (21) pass at engine and API level with five Terminal
  fixes; stress, no-duplicates, history, isolation and hedge-reconnection areas and the whole browser level are open.
- collateral follow-up (task 2 under "Not started or unfinished" below): NOT started; its worker was stopped.
- The red test mentioned further down is fixed.

To continue: start a worker per unfinished group as `tasks/GROUPS.md` describes, telling it that
`progress/<id>.md` exists, so it resumes instead of starting over. Then waves 2 and 3 below.
Findings waiting for an owner are in `BUGS.md`.

## State of the work (written 2026-10-07 01:58 UTC)

**Committed**
- `27330e8`: hedge request states, source and freshness; Investment Strategy IDs; protection allocations;
  collateral agreements; per-leg confirmation checks with editable tolerances; per-instrument calendars and
  settlement conventions; balance sheet for many Accounts; the product test matrix harness (`test/matrix/`,
  read its README) with the equity family (12 products) passing at engine, API and browser level.
- The commit that adds this note: fee minimum once per order; orders wait on days closed in the trading calendar;
  close previews label returned collateral; pay date on the dividend form; demo clock persists both ways;
  transfer dialog currency fix.

**Known red test (1 of 181)**: `test/core/reconciliation.test.js`, "the TRS alternative is a complete swap". The
demo hedge fixture no longer states collateral terms for its swap (the desk chooses the basis); the popup and
`hedge.previewPackage` must let the user choose the collateral basis for an OTC leg, and the test must then choose
position-level terms of 10% and keep its hand-worked figures. This is item 3 of the hedge follow-up below.

**Not started or unfinished**
1. Hedge follow-up (`progress/v1.md`, "ROUND 2"): Strategy picker by ID on the Marketplace ticket; was/now panel in
   the popup when "Execute now" is refused; collateral basis choice for OTC legs in the popup, then the swap
   alternative executed end to end in the browser; routes into `docs/ARCHITECTURE.md`.
2. Collateral follow-up: basis and posted/held amounts on Accounting position rows; collateral cash on borrowings
   tables; calls based on a stale mark flagged as such; collateral screens at 1024 and 390 wide; the no-basis block
   checked from templates and "Add legs".
3. Product matrix fan-out (`briefs/BRIEF4.md`): 193 products and 28 templates still "not yet specified". Planned split:
   - wave 1: bonds, government (13: treasury_bill ... corporate_bond; builds the bond browser driver); fund,
     crypto, currency, FX spot, spot/full (10); manual family (16); listed options (5); futures (11); loans (9)
     with Treasury borrow / lend / convert flows; rate swaps (12: interest_rate_cap ... forward_starting_swap;
     builds the swap driver); failure, recovery and isolation (`tasks/S8-failure-recovery.md`).
   - wave 2: bonds, corporate (13: corporate_bond_ig ... bankers_acceptance); bonds, partial (12: tips ...
     non_agency_mbs); physical commodities (11); OTC options (8: otc_option ... swaption); forwards (8); repo and
     securities lending (15); swaps (13: amortizing_swap ... freight_swap); templates, first 14.
   - wave 3: bonds, partial (13: specified_pool ... loan_participation); OTC options (8: cds_swaption ...
     compound_option); swaps partial and CDS (16); templates, last 14, plus both trading paths (Strategy package
     with protection; Marketplace trade, Hedge popup, Execute now); independent accounting verification (owner
     section 7); whole-application check (owner section 9).
4. Final: update `docs/COVERAGE.md`, README and ARCHITECTURE for the new routes; clean clone of the final commit;
   run `npm test`, `npm run test:api`, `npm run test:browser`, the system suite, `npm run matrix`; write the
   evidence report (tested commit, commands, environment, matrix, failures fixed, what is blocked or unsupported,
   engine/API results separate from browser results); delete `docs/work/`; push.

## Decisions already made (do not reopen without a reason)
- An incomplete hedge request is stored but never sent or answered; the fixture behaves like the service would.
- `expected` on a confirmation is optional for API callers; without it the order is recorded as
  "priced at confirmation". The interface always sends it.
- A later fill of a working order beyond tolerance is recorded and flagged on the order, not blocked.
- Futures margin stays in the Book's paper-desk assumptions and is described as clearing terms.
- Expected values in tests are hand-worked literals; a Terminal figure is never adopted to make a test pass.
