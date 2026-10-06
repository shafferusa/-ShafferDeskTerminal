// Product catalog: the full required instrument universe, mapped to the engine family that
// accounts for it and an honest statement of how complete the paper lifecycle is.
//
// Support levels (paper lifecycle inside the Terminal; data availability is tracked separately
// on the Data Connection page):
//   full     contract terms, cash flows and lifecycle events are automated
//   partial  tradable and fully accounted, but the events listed in `note` must be recorded by hand
//   manual   can be created, held, valued and cash-flowed only through explicit manual inputs
//   planned  represented in the registry; cannot be traded yet
//
// cls: 'cash' or 'deriv' decides which pair of market views (… Based / … Derivatives) a product
// belongs to. Geography (US vs Foreign) is a property of each instrument, not of the product.

export const FAMILIES = {
  equity: { label: 'Equity-like security', qty: 'shares', price: 'per share' },
  fund: { label: 'Fund (NAV-priced)', qty: 'shares', price: 'NAV per share' },
  spot: { label: 'Spot asset', qty: 'units', price: 'per unit' },
  crypto: { label: 'Digital asset', qty: 'units', price: 'per unit' },
  cash: { label: 'Currency balance', qty: 'amount', price: '' },
  fx: { label: 'Spot FX', qty: 'base currency amount', price: 'quote per base' },
  option: { label: 'Listed option', qty: 'contracts', price: 'premium per underlying unit' },
  future: { label: 'Future', qty: 'contracts', price: 'contract price' },
  forward: { label: 'Forward / FRA', qty: 'notional', price: 'forward price' },
  bond: { label: 'Debt security', qty: 'face amount', price: '% of par (clean)' },
  loan: { label: 'Cash loan / deposit', qty: 'principal', price: '' },
  repo: { label: 'Repo / reverse repo', qty: 'cash principal', price: '' },
  secloan: { label: 'Securities loan', qty: 'securities quantity', price: '' },
  otcoption: { label: 'OTC option', qty: 'underlying units', price: 'premium per unit' },
  swap: { label: 'Swap', qty: 'notional', price: 'NPV per 100 notional' },
  cds: { label: 'Credit default swap', qty: 'notional', price: 'upfront per 100 notional' },
  manual: { label: 'Manually valued holding', qty: 'units', price: 'per unit' },
};

const F = 'full', P = 'partial', M = 'manual';

// [id, name, group, family, cls, support, note]
const ROWS = [
  // ---- Equities and funds ----
  ['common_stock', 'Common stock (domestic and foreign)', 'Equities', 'equity', 'cash', F, 'Cash dividends and splits are applied from supplied or manually recorded corporate actions. Mergers, spin-offs and tenders are recorded by hand.'],
  ['preferred_stock', 'Preferred stock', 'Equities', 'equity', 'cash', F, 'Preferred dividends are booked as dividends from recorded corporate actions.'],
  ['adr', 'American depositary receipt (ADR)', 'Equities', 'equity', 'cash', F, 'Listed in the US; issuer domicile stored separately. Depositary fees are recorded by hand.'],
  ['gdr', 'Global depositary receipt (GDR)', 'Equities', 'equity', 'cash', F, 'Depositary fees are recorded by hand.'],
  ['etf', 'Exchange-traded fund (ETF)', 'Equities', 'equity', 'cash', F, ''],
  ['etn', 'Exchange-traded note (ETN)', 'Equities', 'equity', 'cash', F, 'Issuer credit events are recorded by hand.'],
  ['mutual_fund', 'Mutual fund', 'Funds', 'fund', 'cash', F, 'Trades at the next supplied NAV; distributions from recorded corporate actions.'],
  ['closed_end_fund', 'Closed-end fund', 'Funds', 'equity', 'cash', F, ''],
  ['reit', 'REIT', 'Equities', 'equity', 'cash', F, ''],
  ['warrant', 'Warrant', 'Equities', 'equity', 'cash', P, 'Exercise and expiry are recorded by hand.'],
  ['subscription_right', 'Subscription right', 'Equities', 'equity', 'cash', P, 'Exercise and lapse are recorded by hand.'],
  ['convertible_preferred', 'Convertible security (preferred)', 'Equities', 'equity', 'cash', P, 'Conversion is recorded by hand.'],
  ['private_equity', 'Private equity interest', 'Private markets', 'manual', 'cash', M, 'Capital calls, distributions and valuations are entered by hand.'],
  ['venture_capital', 'Venture capital interest', 'Private markets', 'manual', 'cash', M, 'Capital calls, distributions and valuations are entered by hand.'],
  ['hedge_fund', 'Hedge fund interest', 'Private markets', 'manual', 'cash', M, 'Subscriptions, redemptions and NAV are entered by hand.'],
  ['infrastructure', 'Infrastructure investment', 'Private markets', 'manual', 'cash', M, 'Cash flows and valuations are entered by hand.'],
  ['direct_real_estate', 'Direct real estate', 'Private markets', 'manual', 'cash', M, 'Cash flows and valuations are entered by hand.'],

  // ---- Government and agency debt ----
  ['treasury_bill', 'US Treasury bill', 'Government debt', 'bond', 'cash', F, 'Discount instrument; redeems at par.'],
  ['treasury_note', 'US Treasury note', 'Government debt', 'bond', 'cash', F, ''],
  ['treasury_bond', 'US Treasury bond', 'Government debt', 'bond', 'cash', F, ''],
  ['tips', 'US TIPS', 'Government debt', 'bond', 'cash', P, 'Inflation accretion of principal is not automated; record index-ratio adjustments by hand.'],
  ['strips', 'US Treasury STRIPS', 'Government debt', 'bond', 'cash', F, 'Zero-coupon.'],
  ['foreign_gov_bill', 'Foreign government bill', 'Government debt', 'bond', 'cash', F, ''],
  ['foreign_gov_bond', 'Foreign government bond', 'Government debt', 'bond', 'cash', F, ''],
  ['foreign_inflation_linked', 'Foreign inflation-linked bond', 'Government debt', 'bond', 'cash', P, 'Inflation accretion of principal is recorded by hand.'],
  ['em_local_debt', 'Emerging-market local-currency debt', 'Government debt', 'bond', 'cash', F, ''],
  ['em_hard_debt', 'Emerging-market hard-currency debt', 'Government debt', 'bond', 'cash', F, ''],
  ['agency_debt', 'Agency debt', 'Government debt', 'bond', 'cash', F, ''],
  ['supranational_bond', 'Supranational bond', 'Government debt', 'bond', 'cash', F, ''],
  ['municipal_bond', 'Municipal bond (domestic and foreign)', 'Government debt', 'bond', 'cash', F, 'Tax treatment is not modelled.'],
  ['sovereign_sukuk', 'Sovereign sukuk', 'Government debt', 'bond', 'cash', F, 'Periodic distributions are booked on the coupon schedule.'],

  // ---- Corporate and structured debt ----
  ['corporate_bond', 'Corporate bond (domestic and foreign)', 'Corporate debt', 'bond', 'cash', F, ''],
  ['corporate_bond_ig', 'Investment-grade bond', 'Corporate debt', 'bond', 'cash', F, ''],
  ['high_yield_bond', 'High-yield bond', 'Corporate debt', 'bond', 'cash', F, 'Defaults and restructurings are recorded by hand.'],
  ['eurobond', 'Eurobond', 'Corporate debt', 'bond', 'cash', F, ''],
  ['foreign_market_bond', 'Foreign-market bond (Yankee, Samurai, Bulldog …)', 'Corporate debt', 'bond', 'cash', F, ''],
  ['corporate_sukuk', 'Corporate sukuk', 'Corporate debt', 'bond', 'cash', F, 'Periodic distributions are booked on the coupon schedule.'],
  ['floating_rate_note', 'Floating-rate note', 'Corporate debt', 'bond', 'cash', F, 'Each coupon needs its reference-rate fixing (supplied or entered); a missing fixing blocks that coupon visibly.'],
  ['zero_coupon_bond', 'Zero-coupon bond', 'Corporate debt', 'bond', 'cash', F, ''],
  ['callable_bond', 'Callable bond', 'Corporate debt', 'bond', 'cash', P, 'Issuer calls are recorded by hand as an early redemption.'],
  ['puttable_bond', 'Puttable bond', 'Corporate debt', 'bond', 'cash', P, 'Exercising the put is recorded by hand as an early redemption.'],
  ['convertible_bond', 'Convertible bond', 'Corporate debt', 'bond', 'cash', P, 'Conversion into shares is recorded by hand.'],
  ['exchangeable_bond', 'Exchangeable bond', 'Corporate debt', 'bond', 'cash', P, 'Exchange into shares is recorded by hand.'],
  ['perpetual_bond', 'Perpetual bond', 'Corporate debt', 'bond', 'cash', F, 'No maturity; coupons continue until sold or called (call recorded by hand).'],
  ['subordinated_debt', 'Subordinated debt', 'Corporate debt', 'bond', 'cash', F, ''],
  ['coco_bond', 'Contingent convertible bond (CoCo)', 'Corporate debt', 'bond', 'cash', P, 'Trigger events, write-downs and coupon cancellations are recorded by hand.'],
  ['covered_bond', 'Covered bond', 'Corporate debt', 'bond', 'cash', F, ''],
  ['mbs', 'Mortgage-backed security', 'Securitised debt', 'bond', 'cash', P, 'Principal paydowns (pool factor) are recorded by hand; coupons follow the current face.'],
  ['rmbs', 'Residential MBS', 'Securitised debt', 'bond', 'cash', P, 'Principal paydowns (pool factor) are recorded by hand.'],
  ['cmbs', 'Commercial MBS', 'Securitised debt', 'bond', 'cash', P, 'Principal paydowns are recorded by hand.'],
  ['agency_mbs', 'Agency MBS', 'Securitised debt', 'bond', 'cash', P, 'Principal paydowns (pool factor) are recorded by hand.'],
  ['non_agency_mbs', 'Non-agency MBS', 'Securitised debt', 'bond', 'cash', P, 'Principal paydowns and losses are recorded by hand.'],
  ['tba_mortgage', 'TBA mortgage contract', 'Securitised debt', 'forward', 'deriv', P, 'Booked as a forward on a pool; pool allocation and delivery are recorded by hand.'],
  ['specified_pool', 'Mortgage specified pool', 'Securitised debt', 'bond', 'cash', P, 'Principal paydowns (pool factor) are recorded by hand.'],
  ['abs', 'Asset-backed security', 'Securitised debt', 'bond', 'cash', P, 'Principal paydowns are recorded by hand.'],
  ['cmo', 'Collateralised mortgage obligation (CMO)', 'Securitised debt', 'bond', 'cash', P, 'Tranche paydowns are recorded by hand.'],
  ['clo', 'Collateralised loan obligation (CLO)', 'Securitised debt', 'bond', 'cash', P, 'Tranche paydowns are recorded by hand; floating coupons need fixings.'],
  ['cdo', 'Collateralised debt obligation (CDO)', 'Securitised debt', 'bond', 'cash', P, 'Tranche paydowns and losses are recorded by hand.'],
  ['credit_linked_note', 'Credit-linked note', 'Securitised debt', 'bond', 'cash', P, 'Credit events are recorded by hand.'],
  ['structured_note', 'Structured note', 'Securitised debt', 'bond', 'cash', P, 'Coupons follow the stated schedule; payoff-linked amounts are recorded by hand.'],
  ['catastrophe_bond', 'Catastrophe bond', 'Insurance-linked', 'bond', 'cash', P, 'Trigger events and principal losses are recorded by hand.'],
  ['insurance_linked_security', 'Insurance-linked security', 'Insurance-linked', 'manual', 'cash', M, 'Cash flows and valuations are entered by hand.'],

  // ---- Money market ----
  ['commercial_paper', 'Commercial paper', 'Money market', 'bond', 'cash', F, 'Discount instrument; redeems at par.'],
  ['abcp', 'Asset-backed commercial paper', 'Money market', 'bond', 'cash', F, 'Discount instrument; redeems at par.'],
  ['certificate_of_deposit', 'Certificate of deposit', 'Money market', 'loan', 'cash', F, 'Booked as cash lent to the issuing bank at the stated rate.'],
  ['bankers_acceptance', "Bankers' acceptance", 'Money market', 'bond', 'cash', F, 'Discount instrument; redeems at par.'],
  ['money_market_fund', 'Money-market fund', 'Money market', 'fund', 'cash', F, 'Distributions from recorded corporate actions.'],
  ['bank_deposit', 'Bank deposit', 'Money market', 'loan', 'cash', F, 'Open-ended cash lent at a stated rate.'],
  ['term_deposit', 'Term deposit', 'Money market', 'loan', 'cash', F, ''],

  // ---- Loans and private credit ----
  ['syndicated_loan', 'Syndicated loan', 'Loans and credit', 'bond', 'cash', P, 'Held at a % of par price with floating coupons (fixings needed); amortisation and prepayments are recorded by hand.'],
  ['leveraged_loan', 'Leveraged loan', 'Loans and credit', 'bond', 'cash', P, 'Amortisation and prepayments are recorded by hand.'],
  ['revolving_credit_facility', 'Revolving credit facility', 'Loans and credit', 'loan', 'cash', P, 'Each drawing is a loan; commitment fees are recorded by hand.'],
  ['private_credit', 'Private credit', 'Loans and credit', 'bond', 'cash', P, 'Valuation is manual; amortisation and prepayments are recorded by hand.'],
  ['distressed_debt', 'Distressed debt', 'Loans and credit', 'bond', 'cash', P, 'Coupons can be suspended by hand; restructurings are recorded by hand.'],
  ['loan_participation', 'Loan participation', 'Loans and credit', 'bond', 'cash', P, 'Amortisation and prepayments are recorded by hand.'],

  // ---- Cash, FX and funding ----
  ['currency', 'USD and foreign currency balances', 'Cash and FX', 'cash', 'cash', F, 'Held as ledger cash by currency in Treasury and each Account.'],
  ['fx_spot', 'Spot FX / currency pair', 'Cash and FX', 'fx', 'cash', F, 'A conversion between two currency balances; never implied by a transfer.'],
  ['cash_loan', 'Cash borrowing and lending (USD or foreign currency)', 'Funding', 'loan', 'cash', F, ''],
  ['secured_loan', 'Secured loan', 'Funding', 'loan', 'cash', F, 'Pledges named positions as collateral.'],
  ['unsecured_loan', 'Unsecured loan', 'Funding', 'loan', 'cash', F, ''],
  ['margin_loan', 'Margin loan', 'Funding', 'loan', 'cash', F, 'Open-ended, floating or fixed rate.'],
  ['securities_backed_loan', 'Securities-backed loan', 'Funding', 'loan', 'cash', F, 'Pledges named positions as collateral.'],
  ['securities_borrowing', 'Securities borrowing', 'Securities finance', 'secloan', 'cash', F, 'Borrow availability and fee come from supplied data or a stated assumption; recalls are triggered by hand or by supplied data.'],
  ['securities_lending', 'Securities lending', 'Securities finance', 'secloan', 'cash', F, ''],
  ['stock_loan', 'Stock loan', 'Securities finance', 'secloan', 'cash', F, ''],
  ['bond_loan', 'Bond loan', 'Securities finance', 'secloan', 'cash', F, ''],
  ['short_sale', 'Short sale', 'Securities finance', 'equity', 'cash', F, 'Always paired with a securities borrow; proceeds are held as restricted collateral.'],
  ['repo', 'Repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['reverse_repo', 'Reverse repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['overnight_repo', 'Overnight repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['term_repo', 'Term repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['open_repo', 'Open repo', 'Securities finance', 'repo', 'cash', F, 'Runs until terminated; the rate can be reset.'],
  ['bilateral_repo', 'Bilateral repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['triparty_repo', 'Tri-party repo', 'Securities finance', 'repo', 'cash', F, 'The tri-party agent is recorded as an attribute; collateral substitution is not automated.'],
  ['gc_repo', 'General-collateral repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['special_repo', 'Special-collateral repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['buy_sell_back', 'Buy/sell-back', 'Securities finance', 'repo', 'cash', F, 'Accounted with the same cash flows as a reverse repo.'],
  ['sell_buy_back', 'Sell/buy-back', 'Securities finance', 'repo', 'cash', F, 'Accounted with the same cash flows as a repo.'],
  ['collateral_swap', 'Securities collateral swap', 'Securities finance', 'manual', 'cash', M, 'Book the two securities loans separately, or hold as a manual arrangement.'],

  // ---- Commodities and environmental ----
  ['physical_commodity', 'Physical / spot commodity', 'Commodities', 'spot', 'cash', P, 'Storage, delivery and insurance costs are recorded by hand.'],
  ['precious_metal', 'Precious metal', 'Commodities', 'spot', 'cash', P, 'Storage costs are recorded by hand.'],
  ['industrial_metal', 'Industrial metal', 'Commodities', 'spot', 'cash', P, 'Storage costs are recorded by hand.'],
  ['crude_oil', 'Crude oil', 'Commodities', 'spot', 'cash', P, 'Storage and delivery are recorded by hand.'],
  ['refined_product', 'Refined petroleum product', 'Commodities', 'spot', 'cash', P, 'Storage and delivery are recorded by hand.'],
  ['natural_gas', 'Natural gas', 'Commodities', 'spot', 'cash', P, 'Storage and delivery are recorded by hand.'],
  ['lng', 'LNG', 'Commodities', 'spot', 'cash', P, 'Cargo logistics are recorded by hand.'],
  ['coal', 'Coal', 'Commodities', 'spot', 'cash', P, 'Storage and delivery are recorded by hand.'],
  ['electricity', 'Electricity', 'Commodities', 'spot', 'cash', P, 'Cannot be stored; delivery periods are recorded by hand.'],
  ['agricultural_commodity', 'Agricultural commodity', 'Commodities', 'spot', 'cash', P, 'Storage and delivery are recorded by hand.'],
  ['livestock', 'Livestock', 'Commodities', 'spot', 'cash', P, 'Delivery is recorded by hand.'],
  ['emissions_allowance', 'Emissions allowance', 'Environmental', 'spot', 'cash', F, 'Surrender/retirement is recorded as a sale at zero by hand.'],
  ['carbon_credit', 'Carbon credit', 'Environmental', 'spot', 'cash', F, 'Retirement is recorded by hand.'],
  ['renewable_energy_certificate', 'Renewable energy certificate', 'Environmental', 'spot', 'cash', F, 'Retirement is recorded by hand.'],
  ['freight_contract', 'Freight contract', 'Commodities', 'manual', 'deriv', M, 'Cash flows and valuations are entered by hand.'],

  // ---- Digital assets ----
  ['cryptocurrency', 'Cryptocurrency', 'Digital assets', 'crypto', 'cash', F, 'Forks, airdrops and staking rewards are recorded by hand.'],
  ['stablecoin', 'Stablecoin', 'Digital assets', 'crypto', 'cash', F, ''],
  ['tokenized_asset', 'Tokenized asset', 'Digital assets', 'crypto', 'cash', F, 'Income on the underlying is recorded by hand.'],

  // ---- Futures ----
  ['equity_future', 'Equity (single-stock) future', 'Futures', 'future', 'deriv', F, 'Daily variation margin; closed out in cash at final settlement (physical delivery is not simulated).'],
  ['equity_index_future', 'Equity-index future', 'Futures', 'future', 'deriv', F, 'Daily variation margin; cash settlement.'],
  ['gov_bond_future', 'Government-bond future', 'Futures', 'future', 'deriv', F, 'Closed out in cash at final settlement; delivery of the cheapest-to-deliver bond is not simulated.'],
  ['treasury_future', 'Treasury future', 'Futures', 'future', 'deriv', F, 'Closed out in cash at final settlement; delivery is not simulated.'],
  ['stir_future', 'Short-term interest-rate future', 'Futures', 'future', 'deriv', F, ''],
  ['fx_future', 'FX future', 'Futures', 'future', 'deriv', F, 'Closed out in cash at final settlement; currency delivery is not simulated.'],
  ['commodity_future', 'Commodity future', 'Futures', 'future', 'deriv', F, 'Closed out in cash at final settlement; physical delivery is not simulated.'],
  ['volatility_future', 'Volatility future', 'Futures', 'future', 'deriv', F, ''],
  ['dividend_future', 'Dividend future', 'Futures', 'future', 'deriv', F, ''],
  ['crypto_future', 'Cryptocurrency future', 'Futures', 'future', 'deriv', F, ''],
  ['perpetual_future', 'Perpetual future', 'Futures', 'future', 'deriv', P, 'Funding payments are recorded by hand; there is no expiry.'],

  // ---- Forwards ----
  ['equity_forward', 'Equity forward', 'Forwards', 'forward', 'deriv', F, 'Cash-settled against a supplied or entered fixing, or physically delivered into the underlying position.'],
  ['bond_forward', 'Bond forward', 'Forwards', 'forward', 'deriv', F, ''],
  ['fx_forward', 'FX forward', 'Forwards', 'forward', 'deriv', F, 'Deliverable: the two currency amounts are exchanged on the value date.'],
  ['ndf', 'Non-deliverable forward', 'Forwards', 'forward', 'deriv', F, 'Cash-settled against the fixing on the fixing date.'],
  ['commodity_forward', 'Commodity forward', 'Forwards', 'forward', 'deriv', F, ''],
  ['fra', 'Forward-rate agreement', 'Forwards', 'forward', 'deriv', F, 'Settled at the start of the period, discounted at the fixing.'],
  ['fx_swap', 'FX swap', 'Forwards', 'forward', 'deriv', F, 'Booked as a near leg and a far leg in one package.'],
  ['credit_spread_forward', 'Credit-spread forward', 'Credit derivatives', 'manual', 'deriv', M, 'Settlement amount and valuation are entered by hand.'],

  // ---- Listed and OTC options ----
  ['listed_option', 'Listed option', 'Options', 'option', 'deriv', F, 'Expiration, exercise and assignment are automated from the contract deliverable.'],
  ['equity_option', 'Equity call / put', 'Options', 'option', 'deriv', F, ''],
  ['etf_option', 'ETF option', 'Options', 'option', 'deriv', F, ''],
  ['index_option', 'Index option', 'Options', 'option', 'deriv', F, 'Cash-settled; AM-settled series need their settlement value as the fixing.'],
  ['option_on_future', 'Option on a future', 'Options', 'option', 'deriv', F, 'Exercise delivers the futures position at the strike. Contract data must be supplied or entered.'],
  ['otc_option', 'OTC option', 'Options', 'otcoption', 'deriv', F, 'Vanilla calls and puts, cash or physical settlement.'],
  ['bond_option', 'Bond option', 'Options', 'otcoption', 'deriv', F, ''],
  ['interest_rate_option', 'Interest-rate option', 'Options', 'otcoption', 'deriv', P, 'Booked on a rate underlying with cash settlement against a fixing; convexity conventions are not modelled.'],
  ['fx_option', 'FX option', 'Options', 'otcoption', 'deriv', F, ''],
  ['commodity_option', 'Commodity option', 'Options', 'otcoption', 'deriv', F, ''],
  ['crypto_option', 'Cryptocurrency option', 'Options', 'otcoption', 'deriv', F, ''],
  ['swaption', 'Swaption', 'Options', 'otcoption', 'deriv', P, 'Exercise is recorded by hand: cash-settle the stated amount, or book the underlying swap.'],
  ['cds_swaption', 'Credit-default swaption', 'Options', 'otcoption', 'deriv', P, 'Exercise is recorded by hand.'],
  ['interest_rate_cap', 'Interest-rate cap', 'Options', 'swap', 'deriv', F, 'A capped floating leg: each caplet pays against its fixing.'],
  ['interest_rate_floor', 'Interest-rate floor', 'Options', 'swap', 'deriv', F, 'A floored floating leg: each floorlet pays against its fixing.'],
  ['interest_rate_collar', 'Interest-rate collar', 'Options', 'swap', 'deriv', F, 'A cap leg and a floor leg in one contract.'],
  ['digital_option', 'Digital option', 'Options', 'otcoption', 'deriv', F, 'Cash-or-nothing payout against the expiry fixing.'],
  ['barrier_option', 'Barrier option', 'Options', 'otcoption', 'deriv', P, 'Barrier events are recorded by hand (or checked against supplied closes); intraday monitoring is not simulated.'],
  ['asian_option', 'Asian option', 'Options', 'otcoption', 'deriv', P, 'The averaged settlement amount is entered by hand at expiry.'],
  ['lookback_option', 'Lookback option', 'Options', 'otcoption', 'deriv', P, 'The settlement amount is entered by hand at expiry.'],
  ['basket_option', 'Basket option', 'Options', 'otcoption', 'deriv', P, 'The settlement amount is entered by hand at expiry.'],
  ['spread_option', 'Spread option', 'Options', 'otcoption', 'deriv', P, 'The settlement amount is entered by hand at expiry.'],
  ['quanto_option', 'Quanto option', 'Options', 'otcoption', 'deriv', P, 'The settlement amount is entered by hand at expiry.'],
  ['compound_option', 'Compound option', 'Options', 'otcoption', 'deriv', P, 'Exercise into the underlying option is recorded by hand.'],
  ['credit_spread_option', 'Credit-spread option', 'Credit derivatives', 'manual', 'deriv', M, 'Settlement amount and valuation are entered by hand.'],

  // ---- Rate swaps ----
  ['interest_rate_swap', 'Interest-rate swap', 'Swaps', 'swap', 'deriv', F, 'Fixed and floating legs pay on their schedules; floating payments need their fixings.'],
  ['ois', 'Overnight-index swap', 'Swaps', 'swap', 'deriv', F, 'Compounds the supplied overnight fixings; a missing fixing blocks the payment visibly.'],
  ['basis_swap', 'Interest-rate basis swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['cross_currency_swap', 'Cross-currency swap', 'Swaps', 'swap', 'deriv', F, 'Notional exchanges at start and end are booked in each currency.'],
  ['cross_currency_basis_swap', 'Cross-currency basis swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['non_deliverable_swap', 'Non-deliverable swap', 'Swaps', 'swap', 'deriv', P, 'Legs are computed in their own currencies; the net USD settlement conversion is recorded by hand.'],
  ['zc_inflation_swap', 'Zero-coupon inflation swap', 'Swaps', 'swap', 'deriv', F, 'Needs the index fixings at start and end.'],
  ['yoy_inflation_swap', 'Year-on-year inflation swap', 'Swaps', 'swap', 'deriv', F, 'Needs an index fixing for each period.'],
  ['constant_maturity_swap', 'Constant-maturity swap', 'Swaps', 'swap', 'deriv', F, 'The CMS rate is supplied as the fixing; no convexity adjustment is applied by the Terminal.'],
  ['cms_spread_swap', 'Constant-maturity spread swap', 'Swaps', 'swap', 'deriv', P, 'The spread fixing is supplied as a single rate code.'],
  ['forward_starting_swap', 'Forward-starting swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['amortizing_swap', 'Amortizing swap', 'Swaps', 'swap', 'deriv', F, 'Uses the notional schedule in the contract terms.'],
  ['accreting_swap', 'Accreting swap', 'Swaps', 'swap', 'deriv', F, 'Uses the notional schedule in the contract terms.'],
  ['callable_swap', 'Callable swap', 'Swaps', 'swap', 'deriv', P, 'Early termination is recorded by hand as an unwind at a stated amount.'],
  ['puttable_swap', 'Puttable swap', 'Swaps', 'swap', 'deriv', P, 'Early termination is recorded by hand as an unwind at a stated amount.'],
  ['quanto_swap', 'Quanto swap', 'Swaps', 'swap', 'deriv', P, 'Legs pay in the settlement currency on the stated notional; quanto adjustments are not modelled.'],
  ['asset_swap', 'Asset swap', 'Swaps', 'swap', 'deriv', P, 'Book the bond and the swap as two legs of one package.'],

  // ---- Equity, commodity and volatility swaps ----
  ['equity_swap', 'Equity swap', 'Swaps', 'swap', 'deriv', F, 'Return leg against a financing leg; needs the underlying fixing at each reset.'],
  ['equity_index_swap', 'Equity-index swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['equity_basket_swap', 'Equity-basket swap', 'Swaps', 'swap', 'deriv', P, 'The basket level is supplied as a single fixing.'],
  ['equity_trs', 'Equity total-return swap', 'Swaps', 'swap', 'deriv', F, 'Dividend pass-through is recorded from corporate actions on the underlying or by hand.'],
  ['bond_trs', 'Bond total-return swap', 'Swaps', 'swap', 'deriv', F, 'Coupon pass-through is recorded by hand.'],
  ['loan_trs', 'Loan total-return swap', 'Swaps', 'swap', 'deriv', P, 'Interest pass-through and paydowns are recorded by hand.'],
  ['index_trs', 'Index total-return swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['commodity_swap', 'Commodity swap', 'Swaps', 'swap', 'deriv', F, 'Fixed price against a floating price fixing per period (single fixing; averaging is entered as the fixing).'],
  ['commodity_basis_swap', 'Commodity basis swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['commodity_index_swap', 'Commodity-index swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['energy_swap', 'Energy swap', 'Swaps', 'swap', 'deriv', F, 'Averaged prices are entered as the period fixing.'],
  ['electricity_swap', 'Electricity swap', 'Swaps', 'swap', 'deriv', F, 'Averaged prices are entered as the period fixing.'],
  ['freight_swap', 'Freight swap', 'Swaps', 'swap', 'deriv', F, 'Averaged route assessments are entered as the period fixing.'],
  ['dividend_swap', 'Dividend swap', 'Swaps', 'swap', 'deriv', P, 'Realised dividends are entered as the period fixing.'],
  ['variance_swap', 'Variance swap', 'Swaps', 'manual', 'deriv', M, 'Realised variance and the settlement amount are entered by hand.'],
  ['volatility_swap', 'Volatility swap', 'Swaps', 'manual', 'deriv', M, 'Realised volatility and the settlement amount are entered by hand.'],
  ['correlation_swap', 'Correlation swap', 'Swaps', 'manual', 'deriv', M, 'Settlement amount and valuation are entered by hand.'],
  ['dispersion_swap', 'Dispersion swap', 'Swaps', 'manual', 'deriv', M, 'Settlement amount and valuation are entered by hand.'],

  // ---- Credit derivatives ----
  ['cds_single_name', 'Single-name credit-default swap', 'Credit derivatives', 'cds', 'deriv', F, 'Premiums pay quarterly; a credit event is triggered by hand with the recovery rate.'],
  ['cds_sovereign', 'Sovereign credit-default swap', 'Credit derivatives', 'cds', 'deriv', F, ''],
  ['cds_index', 'Credit-index swap', 'Credit derivatives', 'cds', 'deriv', F, 'Constituent defaults reduce the notional by hand (index factor).'],
  ['credit_basket_swap', 'Credit-basket swap', 'Credit derivatives', 'cds', 'deriv', P, 'Basket defaults are recorded by hand.'],
  ['cds_index_tranche', 'Credit-index tranche swap', 'Credit derivatives', 'cds', 'deriv', P, 'Tranche losses are recorded by hand.'],
  ['loan_cds', 'Loan credit-default swap', 'Credit derivatives', 'cds', 'deriv', P, 'Cancellation on refinancing is recorded by hand.'],
  ['abs_cds', 'Asset-backed credit-default swap', 'Credit derivatives', 'cds', 'deriv', P, 'Pay-as-you-go amounts are recorded by hand.'],
  ['recovery_swap', 'Recovery swap', 'Credit derivatives', 'manual', 'deriv', M, 'Settlement amount and valuation are entered by hand.'],

  // ---- Other ----
  ['weather_derivative', 'Weather derivative', 'Insurance-linked', 'manual', 'deriv', M, 'Settlement amount and valuation are entered by hand.'],
];

export const PRODUCTS = ROWS.map(([id, name, group, family, cls, support, note]) => ({ id, name, group, family, cls, support, note }));
const BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));

export const getProduct = (id) => BY_ID.get(id) || null;

/**
 * Pricing coverage, by engine family: where a value for the instrument comes from. This is a
 * separate question from lifecycle support. A product can have a fully simulated lifecycle and no
 * price source yet, or a price and a lifecycle that is partly recorded by hand.
 */
export const PRICING_BASIS = {
  equity: 'quoted', fund: 'quoted', spot: 'quoted', crypto: 'quoted', fx: 'quoted', option: 'quoted', future: 'quoted', bond: 'quoted',
  forward: 'model', otcoption: 'model', swap: 'model', cds: 'model',
  loan: 'contractual', repo: 'contractual', secloan: 'contractual', manual: 'manual', cash: 'contractual',
};
export const PRICING_LABEL = {
  quoted: 'Market quote from Shaffer MarketData; a manual price meanwhile',
  model: 'Dealer or model mark from Shaffer Analytics Lab; a manual mark meanwhile',
  contractual: 'No price needed: carried at principal plus accrued',
  manual: 'Valued by hand',
};

/** Catalog grouped for display, with counts by lifecycle support level. */
export function catalogSummary() {
  const counts = { full: 0, partial: 0, manual: 0, planned: 0 };
  for (const p of PRODUCTS) counts[p.support]++;
  const pricing = { quoted: 0, model: 0, contractual: 0, manual: 0 };
  const products = PRODUCTS.map((p) => { const basis = PRICING_BASIS[p.family] || 'quoted'; pricing[basis]++; return { ...p, pricing: basis }; });
  return { families: FAMILIES, products, counts, pricing, pricingLabels: PRICING_LABEL, total: PRODUCTS.length };
}

export const MARKET_VIEWS = {
  US_CASH: { id: 'US_CASH', label: 'US Based', geo: 'US', cls: 'cash', description: 'US-listed cash securities, US government and corporate debt, and other US cash-market instruments.' },
  US_DERIV: { id: 'US_DERIV', label: 'US Derivatives', geo: 'US', cls: 'deriv', description: 'US-listed derivatives and OTC contracts assigned to US market exposure.' },
  FOREIGN_CASH: { id: 'FOREIGN_CASH', label: 'Foreign Based', geo: 'FOREIGN', cls: 'cash', description: 'Foreign-listed cash securities, foreign government and corporate debt, and other foreign cash-market instruments.' },
  FOREIGN_DERIV: { id: 'FOREIGN_DERIV', label: 'Foreign Derivatives', geo: 'FOREIGN', cls: 'deriv', description: 'Foreign-listed derivatives and OTC contracts assigned to foreign market exposure.' },
};
