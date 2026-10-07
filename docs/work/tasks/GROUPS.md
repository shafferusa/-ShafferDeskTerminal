# Product groups for the matrix fan-out (how to start or restart a worker)

Every worker gets the same opening: read `briefs/BRIEF3.md` (shared-tree rules, progress log, saving progress), then
`briefs/BRIEF4.md` (the standard of "done" for a product, working arrangements, milestones), then its own lines
below. Tell it its id and that if `progress/<id>.md` exists it is resuming and must continue from it. One product
passing at engine, API and browser level is one milestone (0.2 points for the save script).

In these briefs `$SP` was a scratch directory. On a new machine: create a new scratch directory, copy
`docs/work/briefs/*` and `docs/work/tasks/*` into it, copy each `docs/work/progress/<id>.md` to `$SP/<id>/PROGRESS.md`,
fix the `$SP` path inside the briefs, and recreate `tools/save-note.sh` (it appends a line to `docs/work/LOG.md`,
updates the Completeness line of `RESUME.md`, runs `git add -A`, commits and pushes, under a lock).

## Wave 1 (started; state in RESUME.md)
- **b1**, family `bond`, spec `test/matrix/specs/bond-government.mjs`, built `drivers/browser/bond.mjs`. Products (13):
  treasury_bill, treasury_note, treasury_bond, strips, foreign_gov_bill, foreign_gov_bond, em_local_debt,
  em_hard_debt, agency_debt, supranational_bond, municipal_bond, sovereign_sukuk, corporate_bond. Exercise: % of par,
  clean versus dirty, accrued interest on each market's real day count, coupon schedules, settlement lag and
  calendar per market, foreign currency with FX fixtures, coupon received by moving the clock, discount instruments
  to par, zero coupon, redemption, partial sale and average cost, short sale with borrow where offered, a holding
  across a bond-market holiday, one scenario owned by Treasury.
- **o1**, family `option`, spec `specs/option.mjs`, built `drivers/browser/option.mjs`. Products (5): listed_option,
  equity_option, etf_option, index_option, option_on_future. All logged as passing.
- **fu1**, family `future`, spec `specs/future.mjs`, built `drivers/browser/future.mjs`. Products (11): equity_future,
  equity_index_future, gov_bond_future, treasury_future, stir_future, fx_future, commodity_future,
  volatility_future, dividend_future, crypto_future, perpetual_future. All logged as passing.
- **l1**, family `loan`, spec `specs/loan.mjs`, built `drivers/browser/loan.mjs` (Treasury and Account dialogs).
  Products (9): certificate_of_deposit, bank_deposit, term_deposit, cash_loan, secured_loan, unsecured_loan,
  margin_loan, securities_backed_loan, revolving_credit_facility. Inside those scenarios also: borrowing by Treasury
  and by an Account (one record, three views), lending, borrow and convert (spot at once, settles T+2 on the joint
  calendar), funding, returns, Account-to-Account transfers, partial and full repayment, floating resets with a
  missing fixing blocking visibly, pledged collateral not sellable, a non-USD loan, repayment failing visibly when
  cash is short.
- **s1**, family `swap`, spec `specs/swap-rates.mjs`, built `drivers/browser/swap.mjs`. Products (12):
  interest_rate_cap, interest_rate_floor, interest_rate_collar, interest_rate_swap, ois, basis_swap,
  cross_currency_swap, cross_currency_basis_swap, zc_inflation_swap, yoy_inflation_swap, constant_maturity_swap,
  forward_starting_swap. Exercise: both directions, each leg's terms, resets from fixtures (missing fixing blocks
  visibly), cash flows on payment dates, accruals between them, notional exchanges and both currencies for
  cross-currency, premiums and caplet / floorlet payoffs, inflation fixings, collateral under each basis with marks
  by hand driving a variation-margin call and its return, partial and full termination, maturity, nothing left
  posted or scheduled, one scenario owned by Treasury.
- **s8**, failure, recovery and isolation: `tasks/S8-failure-recovery.md`. One point per finished area (six areas).
- **collateral follow-up** (id v2b, about 1 point): basis and posted / held amounts on Accounting position rows;
  collateral cash on borrowings tables; a variation-margin call from a stale mark flagged as such and provisional;
  collateral screens usable at 1024 and 390 wide; the no-basis block checked from templates and "Add legs".

## Wave 2 (not started)
- **b2**, `specs/bond-corporate.mjs` (family `bond`, reuse the bond driver), 13: corporate_bond_ig, high_yield_bond,
  eurobond, foreign_market_bond, corporate_sukuk, floating_rate_note, zero_coupon_bond, perpetual_bond,
  subordinated_debt, covered_bond, commercial_paper, abcp, bankers_acceptance.
- **b3**, `specs/bond-structured-a.mjs`, 12 (catalog "partial": the manual events are recorded by hand through the
  interface): tips, foreign_inflation_linked, callable_bond, puttable_bond, convertible_bond, exchangeable_bond,
  coco_bond, mbs, rmbs, cmbs, agency_mbs, non_agency_mbs.
- **c1**, families `fund`, `crypto`, `cash`, `fx`, `spot`; one spec file and one small driver per family; 10:
  mutual_fund, money_market_fund, cryptocurrency, stablecoin, tokenized_asset, currency (deposit, withdraw, convert,
  transfers), fx_spot, emissions_allowance, carbon_credit, renewable_energy_certificate.
- **c2**, family `spot`, `specs/spot-commodities.mjs`, 11: physical_commodity, precious_metal, industrial_metal,
  crude_oil, refined_product, natural_gas, lng, coal, electricity, agricultural_commodity, livestock.
- **m1**, family `manual`, 16: private_equity, venture_capital, hedge_fund, infrastructure, direct_real_estate,
  insurance_linked_security, collateral_swap, freight_contract, credit_spread_forward, credit_spread_option,
  variance_swap, volatility_swap, correlation_swap, dispersion_swap, recovery_swap, weather_derivative. Everything
  by hand through the interface: valuations, capital calls, distributions, cash flows, to completion.
- **o2**, family `otcoption`, `specs/otcoption-a.mjs` plus the driver, 8: otc_option, bond_option, fx_option,
  commodity_option, crypto_option, digital_option, interest_rate_option, swaption. Collateral basis is mandatory.
- **fw1**, family `forward`, 8: equity_forward, bond_forward, fx_forward, ndf, commodity_forward, fra, fx_swap,
  tba_mortgage. Collateral basis is mandatory.
- **r1**, families `repo` and `secloan`, 15: repo, reverse_repo, overnight_repo, term_repo, open_repo, bilateral_repo,
  triparty_repo, gc_repo, special_repo, buy_sell_back, sell_buy_back, securities_borrowing, securities_lending,
  stock_loan, bond_loan. Repo proceeds against collateral value, haircut and buffer; collateral changes; termination.
- **s2**, `specs/swap-other.mjs` (family `swap`, reuse the swap driver), 13: amortizing_swap, accreting_swap,
  equity_swap, equity_index_swap, equity_trs, bond_trs, index_trs, commodity_swap, commodity_basis_swap,
  commodity_index_swap, energy_swap, electricity_swap, freight_swap.
- **t1**, `specs/templates.mjs` (family `templates`), the first 14 execution templates in `server/core/templates.js`.

## Wave 3 (not started)
- **b4**, `specs/bond-structured-b.mjs`, 13: specified_pool, abs, cmo, clo, cdo, credit_linked_note,
  structured_note, catastrophe_bond, syndicated_loan, leveraged_loan, private_credit, distressed_debt,
  loan_participation.
- **o3**, `specs/otcoption-b.mjs`, 8: cds_swaption, barrier_option, asian_option, lookback_option, basket_option,
  spread_option, quanto_option, compound_option.
- **s3**, swaps "partial" and credit, 16: non_deliverable_swap, cms_spread_swap, callable_swap, puttable_swap,
  quanto_swap, asset_swap, equity_basket_swap, loan_trs, dividend_swap; cds_single_name, cds_sovereign, cds_index,
  credit_basket_swap, cds_index_tranche, loan_cds, abs_cds (credit events where supported).
- **t2**, the last 14 templates, plus both trading paths end to end: a Strategy package with protection included;
  a Marketplace trade, the Hedge popup, "Execute now".
- **s7**, independent accounting verification (owner section 7): hand-worked examples for each of its eleven
  checks, at engine level and cross-checked through the API and the screens.
- **s9**, whole-application check (owner section 9): every screen, tab and scope; light and dark; normal and demo;
  awaiting and reconnected; 1440, 1024 and 390 wide; settings that persist after a restart.

## Final (coordinator)
Fix what `BUGS.md` lists; update `docs/COVERAGE.md`, README and ARCHITECTURE; clean clone of the final commit; run
`npm test`, `npm run test:api`, `npm run test:browser`, the system suite, `npm run matrix`; write the evidence
report; delete `docs/work/`; push.
