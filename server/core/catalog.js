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
  ['private_equity', 'Private equity interest', 'Private markets', 'manual', 'cash', M, 'Entered by hand: the commitment (registration), capital calls with their fee part, distributions split into return of capital, gain and income with carried interest withheld, valuations with date and source (stale after the contract\'s limit; rolled forward for later calls and distributions), secondary sales and the wind-up.'],
  ['venture_capital', 'Venture capital interest', 'Private markets', 'manual', 'cash', M, 'Entered by hand: the commitment (registration), capital calls with their fee part, distributions split into return of capital, gain and income with carried interest withheld, valuations with date and source (stale after the contract\'s limit; rolled forward for later calls and distributions), secondary sales and the wind-up.'],
  ['hedge_fund', 'Hedge fund interest', 'Private markets', 'manual', 'cash', M, 'Entered by hand: subscriptions at a stated NAV, NAV per share with date and source, redemption notices and each dealing date\'s NAV. The Terminal works out the dealing date (notice period, frequency), the investor-level gate and the payment date; each dealing date waits, visibly, for its NAV.'],
  ['infrastructure', 'Infrastructure investment', 'Private markets', 'manual', 'cash', M, 'Entered by hand: purchase and sale prices with their closing dates, income, operating expenses, capital expenditure (added to cost), appraisals with date and source (rolled forward for capex).'],
  ['direct_real_estate', 'Direct real estate', 'Private markets', 'manual', 'cash', M, 'Entered by hand: purchase and sale prices with their closing dates, income, operating expenses, capital expenditure (added to cost), appraisals with date and source (rolled forward for capex).'],

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
  ['tba_mortgage', 'TBA mortgage contract', 'Securitised debt', 'forward', 'deriv', P, 'Booked as a forward on the pass-through coupon. The pool the seller allocates is recorded by hand on the position before settlement (checked for good delivery) and delivered on paper (simulated) on the settlement date.'],
  ['specified_pool', 'Mortgage specified pool', 'Securitised debt', 'bond', 'cash', P, 'Registered with its stated pool characteristics (required). Coupons after the payment delay are automatic; the monthly factor and paydown (scheduled and prepaid) are recorded by hand; a loss allocation is refused for a guaranteed pool.'],
  ['abs', 'Asset-backed security', 'Securitised debt', 'bond', 'cash', P, 'Coupons net of a stated servicing fee are automatic (gross, fee and net in the history); the factor and principal paydowns from the servicer report are recorded by hand.'],
  ['cmo', 'Collateralised mortgage obligation (CMO)', 'Securitised debt', 'bond', 'cash', P, 'A sequential class receives no principal while its senior class is outstanding: the senior balance and the tranche factor are recorded by hand from each remittance report; coupons are automatic.'],
  ['clo', 'Collateralised loan obligation (CLO)', 'Securitised debt', 'bond', 'cash', P, 'Floating coupons on current face need fixings (a missing fixing blocks visibly); a coupon paid in kind (deferrable class), paydowns and loss allocations are recorded by hand.'],
  ['cdo', 'Collateralised debt obligation (CDO)', 'Securitised debt', 'bond', 'cash', P, 'Floating coupons on current face need fixings (a missing fixing blocks visibly); paydowns, loss allocations and, for a deferrable class, coupons paid in kind are recorded by hand.'],
  ['credit_linked_note', 'Credit-linked note', 'Securitised debt', 'bond', 'cash', P, 'Registered with its reference entity. Coupons are automatic; the credit event is recorded by hand with the auction recovery: the coupon ends (accrued forfeited) and principal settles at the recovery.'],
  ['structured_note', 'Structured note', 'Securitised debt', 'bond', 'cash', P, 'Contingent coupons and the principal at maturity (protected, or against a barrier) are worked out from observations of the linked underlying, each recorded by hand; a coupon or redemption waits visibly for its observation. Other payoff-linked amounts are recorded as manual cash flows.'],
  ['catastrophe_bond', 'Catastrophe bond', 'Insurance-linked', 'bond', 'cash', P, 'Registered with its collateral account. Coupons (collateral return plus spread, fixings needed) are automatic; a covered event and its principal loss are recorded by hand, releasing collateral to the sponsor.'],
  ['insurance_linked_security', 'Insurance-linked security', 'Insurance-linked', 'manual', 'cash', M, 'Entered by hand: coupons, valuations in % of face with date and source, loss events writing face down, and the redemption at maturity (the maturity waits for it).'],

  // ---- Money market ----
  ['commercial_paper', 'Commercial paper', 'Money market', 'bond', 'cash', F, 'Discount instrument; redeems at par.'],
  ['abcp', 'Asset-backed commercial paper', 'Money market', 'bond', 'cash', F, 'Discount instrument; redeems at par.'],
  ['certificate_of_deposit', 'Certificate of deposit', 'Money market', 'loan', 'cash', F, 'Booked as cash lent to the issuing bank at the stated rate.'],
  ['bankers_acceptance', "Bankers' acceptance", 'Money market', 'bond', 'cash', F, 'Discount instrument; redeems at par.'],
  ['money_market_fund', 'Money-market fund', 'Money market', 'fund', 'cash', F, 'Distributions from recorded corporate actions.'],
  ['bank_deposit', 'Bank deposit', 'Money market', 'loan', 'cash', F, 'Open-ended cash lent at a stated rate.'],
  ['term_deposit', 'Term deposit', 'Money market', 'loan', 'cash', F, ''],

  // ---- Loans and private credit ----
  ['syndicated_loan', 'Syndicated loan', 'Loans and credit', 'bond', 'cash', P, 'Held at a % of par price, traded by assignment (no short sale) on par or distressed documentation; delayed compensation after T+7 and floating coupons (fixings needed) are automatic; amortisation, prepayments, draws, repricings and fees are recorded by hand.'],
  ['leveraged_loan', 'Leveraged loan', 'Loans and credit', 'bond', 'cash', P, 'Traded by assignment (no short sale), floating coupons with fixings, delayed compensation on late par settlement; amortisation, prepayments and a repricing (new spread, soft-call premium) are recorded by hand.'],
  ['revolving_credit_facility', 'Revolving credit facility', 'Loans and credit', 'loan', 'cash', P, 'Each drawing is a loan; commitment fees are recorded by hand.'],
  ['private_credit', 'Private credit', 'Loans and credit', 'bond', 'cash', P, 'Valuation is manual (stated fill prices, marks by hand); a fixed PIK component is capitalised automatically; draws on the delayed-draw commitment, commitment fees, amortisation and repayments are recorded by hand.'],
  ['distressed_debt', 'Distressed debt', 'Loans and credit', 'bond', 'cash', P, 'The default is recorded by hand (non-accrual, trades flat, coupon dates listed unpaid); interim and final recovery distributions are recorded by hand; distributions in new securities are recorded as a sale and a purchase.'],
  ['loan_participation', 'Loan participation', 'Loans and credit', 'bond', 'cash', P, 'Registered with its grantor and the grantor\'s face; coupons are passed through as the participation\'s share after the payment delay; amortisation and prepayments are recorded by hand.'],

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
  ['bond_loan', 'Bond loan', 'Securities finance', 'secloan', 'cash', F, 'Cash collateral on the bonds\' dirty value; the fee accrues on clean market value.'],
  ['short_sale', 'Short sale', 'Securities finance', 'equity', 'cash', F, 'Always paired with a securities borrow; proceeds are held as restricted collateral.'],
  ['repo', 'Repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['reverse_repo', 'Reverse repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['overnight_repo', 'Overnight repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['term_repo', 'Term repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['open_repo', 'Open repo', 'Securities finance', 'repo', 'cash', F, 'Runs until terminated; the rate can be reset.'],
  ['bilateral_repo', 'Bilateral repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['triparty_repo', 'Tri-party repo', 'Securities finance', 'repo', 'cash', F, 'The tri-party agent is recorded as a term; otherwise simulated as a bilateral repo. Basket allocation and the agent\'s substitutions are not automated: collateral changes are recorded by hand.'],
  ['gc_repo', 'General-collateral repo', 'Securities finance', 'repo', 'cash', F, ''],
  ['special_repo', 'Special-collateral repo', 'Securities finance', 'repo', 'cash', F, 'The special rate is entered on the ticket (not derived); the named security cannot be substituted.'],
  ['buy_sell_back', 'Buy/sell-back', 'Securities finance', 'repo', 'cash', F, 'Two outright trades: bought spot, sold back at a forward price fixed at inception (net of the coupon falling in the term, which the buyer receives). Accounted as cash lent against the bond; no rate reset, margin or substitution.'],
  ['sell_buy_back', 'Sell/buy-back', 'Securities finance', 'repo', 'cash', F, 'Two outright trades: sold spot, bought back at a forward price fixed at inception (net of the coupon falling in the term, passed to the buyer). Accounted as a financing: the bond stays on the balance sheet, pledged; no rate reset, margin or substitution.'],
  ['collateral_swap', 'Securities collateral swap', 'Securities finance', 'manual', 'cash', M, 'Book the two securities loans separately to move the securities, or hold it as a manual arrangement: baskets recorded on the contract (not moved), fees per period worked out from its terms, marks and termination by hand. A collateral basis is required.'],

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
  ['freight_contract', 'Freight contract', 'Commodities', 'manual', 'deriv', M, 'Entered by hand: marks per unit with date and source, and each period\'s index average; each period settles (average - contract rate) x quantity. A collateral basis is required.'],

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
  ['commodity_future', 'Commodity future', 'Futures', 'future', 'deriv', F, 'Daily variation margin. A physically delivered contract with its deliverable set as Underlying is delivered on paper (simulated) at final settlement, or earlier on a short\'s delivery notice inside the delivery window: goods received or given up at the invoice amount. Cash-settled contracts, or physical ones without a deliverable, are closed out in cash.'],
  ['volatility_future', 'Volatility future', 'Futures', 'future', 'deriv', F, ''],
  ['dividend_future', 'Dividend future', 'Futures', 'future', 'deriv', F, ''],
  ['crypto_future', 'Cryptocurrency future', 'Futures', 'future', 'deriv', F, ''],
  ['perpetual_future', 'Perpetual future', 'Futures', 'future', 'deriv', P, 'Funding payments are recorded by hand; there is no expiry.'],

  // ---- Forwards ----
  ['equity_forward', 'Equity forward', 'Forwards', 'forward', 'deriv', F, 'Cash-settled against a supplied or entered fixing, or physically delivered (simulated, delivery against payment on the value date) from or into the underlying position. Early termination at a stated amount.'],
  ['bond_forward', 'Bond forward', 'Forwards', 'forward', 'deriv', F, 'In face amount and % of par. Physically delivered (simulated) on the value date at the clean price plus accrued interest, or cash-settled against the bond\'s close.'],
  ['fx_forward', 'FX forward', 'Forwards', 'forward', 'deriv', F, 'Deliverable: the two currency amounts are exchanged on the value date.'],
  ['ndf', 'Non-deliverable forward', 'Forwards', 'forward', 'deriv', F, 'Cash-settled against the fixing on the fixing date.'],
  ['commodity_forward', 'Commodity forward', 'Forwards', 'forward', 'deriv', F, 'In the commodity\'s own units. Cash-settled against its close on the value date (a missing fixing waits visibly), or delivered (simulated).'],
  ['fra', 'Forward-rate agreement', 'Forwards', 'forward', 'deriv', F, 'Settled at the start of the period, discounted at the fixing.'],
  ['fx_swap', 'FX swap', 'Forwards', 'forward', 'deriv', F, 'Booked as a near leg and a far leg (each a deliverable FX forward of its own value date) in one package on the Strategies page.'],
  ['credit_spread_forward', 'Credit-spread forward', 'Credit derivatives', 'manual', 'deriv', M, 'Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract\'s stated formula. A collateral basis is required.'],

  // ---- Listed and OTC options ----
  ['listed_option', 'Listed option', 'Options', 'option', 'deriv', F, 'Expiration, exercise and assignment are automated from the contract deliverable.'],
  ['equity_option', 'Equity call / put', 'Options', 'option', 'deriv', F, ''],
  ['etf_option', 'ETF option', 'Options', 'option', 'deriv', F, ''],
  ['index_option', 'Index option', 'Options', 'option', 'deriv', F, 'Cash-settled; AM-settled series need their settlement value as the fixing.'],
  ['option_on_future', 'Option on a future', 'Options', 'option', 'deriv', F, 'Exercise delivers the futures position at the strike. Contract data must be supplied or entered.'],
  ['otc_option', 'OTC option', 'Options', 'otcoption', 'deriv', F, 'Vanilla calls and puts, cash or physical settlement.'],
  ['bond_option', 'Bond option', 'Options', 'otcoption', 'deriv', F, ''],
  ['interest_rate_option', 'Interest-rate option', 'Options', 'otcoption', 'deriv', P, 'Booked on a rate fixing, cash-settled against it and paid on the stated payment date; convexity and the discounting of an in-arrears payment are not modelled.'],
  ['fx_option', 'FX option', 'Options', 'otcoption', 'deriv', F, ''],
  ['commodity_option', 'Commodity option', 'Options', 'otcoption', 'deriv', F, ''],
  ['crypto_option', 'Cryptocurrency option', 'Options', 'otcoption', 'deriv', F, ''],
  ['swaption', 'Swaption', 'Options', 'otcoption', 'deriv', P, 'Exercise is recorded by hand: into the registered swap at a stated entry price, or a cash settlement amount entered by hand. The swaption is not valued by the Terminal.'],
  ['cds_swaption', 'Credit-default swaption', 'Options', 'otcoption', 'deriv', P, 'Exercise is recorded by hand, into the registered credit default swap at a stated upfront; a credit event knocks it out (recorded by hand, or with the credit event on the swap).'],
  ['interest_rate_cap', 'Interest-rate cap', 'Options', 'swap', 'deriv', F, 'A capped floating leg: each caplet pays against its fixing.'],
  ['interest_rate_floor', 'Interest-rate floor', 'Options', 'swap', 'deriv', F, 'A floored floating leg: each floorlet pays against its fixing.'],
  ['interest_rate_collar', 'Interest-rate collar', 'Options', 'swap', 'deriv', F, 'A cap leg and a floor leg in one contract.'],
  ['digital_option', 'Digital option', 'Options', 'otcoption', 'deriv', F, 'Cash-or-nothing payout against the expiry fixing.'],
  ['barrier_option', 'Barrier option', 'Options', 'otcoption', 'deriv', P, 'Barrier events are recorded by hand on the position; prices are not monitored for the barrier, intraday or at the close.'],
  ['asian_option', 'Asian option', 'Options', 'otcoption', 'deriv', P, 'Settles on the average of the underlying closes on the averaging dates, each supplied or entered by hand; without averaging dates the averaged settlement amount is entered by hand.'],
  ['lookback_option', 'Lookback option', 'Options', 'otcoption', 'deriv', P, 'The observed extreme is recorded by hand on the position; the payoff is worked out from it (and from the expiry close for a floating strike).'],
  ['basket_option', 'Basket option', 'Options', 'otcoption', 'deriv', P, 'The basket value at expiry is entered by hand; the payoff is worked out from it.'],
  ['spread_option', 'Spread option', 'Options', 'otcoption', 'deriv', P, 'The spread value at expiry is entered by hand; the payoff is worked out from it.'],
  ['quanto_option', 'Quanto option', 'Options', 'otcoption', 'deriv', P, 'Settles against the underlying close converted at the contract\'s fixed rate; marks are entered by hand.'],
  ['compound_option', 'Compound option', 'Options', 'otcoption', 'deriv', P, 'Exercised into the underlying option, by hand or at expiry against that option\'s mark for the date, which is entered by hand.'],
  ['credit_spread_option', 'Credit-spread option', 'Credit derivatives', 'manual', 'deriv', M, 'Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract\'s stated formula. A collateral basis is required.'],

  // ---- Rate swaps ----
  ['interest_rate_swap', 'Interest-rate swap', 'Swaps', 'swap', 'deriv', F, 'Fixed and floating legs pay on their schedules; floating payments need their fixings.'],
  ['ois', 'Overnight-index swap', 'Swaps', 'swap', 'deriv', F, 'Compounds the supplied overnight fixings; a missing fixing blocks the payment visibly.'],
  ['basis_swap', 'Interest-rate basis swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['cross_currency_swap', 'Cross-currency swap', 'Swaps', 'swap', 'deriv', F, 'Notional exchanges at start and end are booked in each currency.'],
  ['cross_currency_basis_swap', 'Cross-currency basis swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['non_deliverable_swap', 'Non-deliverable swap', 'Swaps', 'swap', 'deriv', P, 'Legs are worked out in their own currencies and paid in the settlement currency at the FX fixing of the fixing date, entered by hand; payments wait for it.'],
  ['zc_inflation_swap', 'Zero-coupon inflation swap', 'Swaps', 'swap', 'deriv', F, 'Needs the index fixings at start and end.'],
  ['yoy_inflation_swap', 'Year-on-year inflation swap', 'Swaps', 'swap', 'deriv', F, 'Needs an index fixing for each period.'],
  ['constant_maturity_swap', 'Constant-maturity swap', 'Swaps', 'swap', 'deriv', F, 'The CMS rate is supplied as the fixing; no convexity adjustment is applied by the Terminal.'],
  ['cms_spread_swap', 'Constant-maturity spread swap', 'Swaps', 'swap', 'deriv', P, 'The leg pays the first index less a second index (Minus index) plus the spread, both fixed at the period start.'],
  ['forward_starting_swap', 'Forward-starting swap', 'Swaps', 'swap', 'deriv', F, ''],
  ['amortizing_swap', 'Amortizing swap', 'Swaps', 'swap', 'deriv', F, 'Notional schedule on the contract form: a factor for the first day of every period of each scheduled leg (a missing or misplaced step is refused). Amounts and a percentage independent amount follow the notional of each period.'],
  ['accreting_swap', 'Accreting swap', 'Swaps', 'swap', 'deriv', F, 'Notional schedule on the contract form: a factor for the first day of every period of each scheduled leg (a missing or misplaced step is refused). Amounts and a percentage independent amount follow the notional of each period.'],
  ['callable_swap', 'Callable swap', 'Swaps', 'swap', 'deriv', P, 'The call is exercised by hand on one of its dates by the side holding it: accrued amounts are settled and the swap ends at no cost.'],
  ['puttable_swap', 'Puttable swap', 'Swaps', 'swap', 'deriv', P, 'The put is exercised by hand on one of its dates by the side holding it: accrued amounts are settled and the swap ends at no cost.'],
  ['quanto_swap', 'Quanto swap', 'Swaps', 'swap', 'deriv', P, 'A quanto leg is worked out in its quanto currency and converted at the fixed rate of the contract; spot FX plays no part. No quanto convexity adjustment.'],
  ['asset_swap', 'Asset swap', 'Swaps', 'swap', 'deriv', P, 'Book the bond and the swap as two legs of one package; the swap upfront (100 less the dirty price for a par asset swap) is stated by hand.'],

  // ---- Equity, commodity and volatility swaps ----
  ['equity_swap', 'Equity swap', 'Swaps', 'swap', 'deriv', F, 'Return leg against a financing leg; the reference close of each reset date (supplied or entered by hand; a missing one blocks the payment). Optional notional reset, the financing then on the reset notional; optional payment lag.'],
  ['equity_index_swap', 'Equity-index swap', 'Swaps', 'swap', 'deriv', F, 'As the equity swap, on an index level carried by a reference instrument (the catalog has no index product).'],
  ['equity_basket_swap', 'Equity-basket swap', 'Swaps', 'swap', 'deriv', P, 'The basket (names and weights) is recorded on the leg; its level at each reset is entered by hand on the payment item.'],
  ['equity_trs', 'Equity total-return swap', 'Swaps', 'swap', 'deriv', F, 'A cash dividend recorded on the reference passes through on its ex-date, from the start fixing of its period (a missing fixing holds it visibly). The form has no separate dividend pay date.'],
  ['bond_trs', 'Bond total-return swap', 'Swaps', 'swap', 'deriv', F, 'Return on the bond closes (clean prices); the coupon pass-through is recorded by hand on the position (manual coupon cash flow): a swap does not follow the bond\'s coupons.'],
  ['loan_trs', 'Loan total-return swap', 'Swaps', 'swap', 'deriv', P, 'Interest pass-through and paydowns are recorded by hand.'],
  ['index_trs', 'Index total-return swap', 'Swaps', 'swap', 'deriv', F, 'Return on an index level carried by a reference instrument; index dividends recorded by hand on it pass through.'],
  ['commodity_swap', 'Commodity swap', 'Swaps', 'swap', 'deriv', F, 'Fixed price against the period-end fixing or the average of the daily fixings on a pricing calendar (a missing day blocks the payment, named); optional net settlement and payment lag.'],
  ['commodity_basis_swap', 'Commodity basis swap', 'Swaps', 'swap', 'deriv', F, 'Averaged price legs on two references and a fixed differential, net settled.'],
  ['commodity_index_swap', 'Commodity-index swap', 'Swaps', 'swap', 'deriv', F, 'Return on a commodity index level carried by a reference instrument, against a fee or financing leg; notional reset at each reset.'],
  ['energy_swap', 'Energy swap', 'Swaps', 'swap', 'deriv', F, 'Quantity per period or per calendar day (gas); averaged daily fixings on a pricing calendar; net settlement.'],
  ['electricity_swap', 'Electricity swap', 'Swaps', 'swap', 'deriv', F, 'MWh from delivery hours (base, peak, off-peak; peak hours a day, peak-day calendar); averaged daily fixings; net settlement. Clock changes are not counted (a 23- or 25-hour day is taken as 24).'],
  ['freight_swap', 'Freight swap', 'Swaps', 'swap', 'deriv', F, 'Route average of the daily assessments on a pricing calendar (the route carried by a reference instrument), net settled.'],
  ['dividend_swap', 'Dividend swap', 'Swaps', 'swap', 'deriv', P, 'The dividend leg pays the cash dividends going ex in each period, as recorded by hand on the stock.'],
  ['variance_swap', 'Variance swap', 'Swaps', 'manual', 'deriv', M, 'Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract\'s stated formula. A collateral basis is required.'],
  ['volatility_swap', 'Volatility swap', 'Swaps', 'manual', 'deriv', M, 'Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract\'s stated formula. A collateral basis is required.'],
  ['correlation_swap', 'Correlation swap', 'Swaps', 'manual', 'deriv', M, 'Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract\'s stated formula. A collateral basis is required.'],
  ['dispersion_swap', 'Dispersion swap', 'Swaps', 'manual', 'deriv', M, 'Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract\'s stated formula. A collateral basis is required.'],

  // ---- Credit derivatives ----
  ['cds_single_name', 'Single-name credit-default swap', 'Credit derivatives', 'cds', 'deriv', F, 'Premiums pay quarterly; a credit event is triggered by hand with the recovery rate.'],
  ['cds_sovereign', 'Sovereign credit-default swap', 'Credit derivatives', 'cds', 'deriv', F, 'Sovereign credit events only (no bankruptcy); a credit event is triggered by hand.'],
  ['cds_index', 'Credit-index swap', 'Credit derivatives', 'cds', 'deriv', F, 'Constituent defaults reduce the notional by hand (index factor).'],
  ['credit_basket_swap', 'Credit-basket swap', 'Credit derivatives', 'cds', 'deriv', P, 'Defaults are recorded by hand; nth-to-default settles in full at the nth default and ends.'],
  ['cds_index_tranche', 'Credit-index tranche swap', 'Credit derivatives', 'cds', 'deriv', P, 'Index defaults are recorded by hand; the loss is written down between the attachment and detachment points.'],
  ['loan_cds', 'Loan credit-default swap', 'Credit derivatives', 'cds', 'deriv', P, 'Credit events and cancellation on refinancing are recorded by hand.'],
  ['abs_cds', 'Asset-backed credit-default swap', 'Credit derivatives', 'cds', 'deriv', P, 'Monthly premium on the payment day; pay-as-you-go events (shortfall, writedown, reimbursement, amortization) are recorded by hand.'],
  ['recovery_swap', 'Recovery swap', 'Credit derivatives', 'manual', 'deriv', M, 'Entered by hand: marks with date and source, the credit event, and the recovery rate from the auction; settles notional x (recovery - fixed rate) only after a credit event. A collateral basis is required.'],

  // ---- Other ----
  ['weather_derivative', 'Weather derivative', 'Insurance-linked', 'manual', 'deriv', M, 'Entered by hand: marks with date and source, and the index for the period; the payment is worked out from the strike, tick and cap stated on the contract. A collateral basis is required.'],
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
  const products = PRODUCTS.map((p) => { const basis = PRICING_BASIS[p.family] || 'quoted'; pricing[basis]++; return { ...p, pricing: basis, tab: PRODUCT_TAB[p.id] || null, assetClass: PRODUCT_ASSET[p.id] || null }; });
  return { families: FAMILIES, products, counts, pricing, pricingLabels: PRICING_LABEL, total: PRODUCTS.length, marketTabs: MARKET_TABS, assetClasses: ASSET_CLASSES, routingBases: ROUTING_BASES };
}

export const MARKET_VIEWS = {
  US_CASH: { id: 'US_CASH', label: 'US Based', geo: 'US', cls: 'cash', description: 'US-listed cash securities, US government and corporate debt, and other US cash-market instruments.' },
  US_DERIV: { id: 'US_DERIV', label: 'US Derivatives', geo: 'US', cls: 'deriv', description: 'US-listed derivatives and OTC contracts assigned to US market exposure.' },
  FOREIGN_CASH: { id: 'FOREIGN_CASH', label: 'Foreign Based', geo: 'FOREIGN', cls: 'cash', description: 'Foreign-listed cash securities, foreign government and corporate debt, and other foreign cash-market instruments.' },
  FOREIGN_DERIV: { id: 'FOREIGN_DERIV', label: 'Foreign Derivatives', geo: 'FOREIGN', cls: 'deriv', description: 'Foreign-listed derivatives and OTC contracts assigned to foreign market exposure.' },
};

// ---- Marketplace product-family tabs (ui1) ----------------------------------------------------------------------
// Inside each of the four market views the instruments are split into product-family tabs. Every catalog product has
// exactly one tab (test/core/marketplaces.test.js checks it); docs/COVERAGE.md prints the mapping. A tab belongs to
// the cash views (US Based, Foreign Based) or the derivative views (US Derivatives, Foreign Derivatives), matching
// the product's `cls`.
export const MARKET_TABS = [
  { id: 'equities', cls: 'cash', label: 'Equities', holds: 'Common and preferred stock, ADRs and GDRs, REITs, warrants, subscription rights and convertible preferred shares. A short sale is placed from the stock\'s own ticket.' },
  { id: 'funds', cls: 'cash', label: 'Funds and ETFs', holds: 'Exchange-traded funds and notes, mutual funds, closed-end funds and hedge fund interests.' },
  { id: 'bonds', cls: 'cash', label: 'Bonds and Credit', holds: 'Government, agency, municipal and corporate bonds, securitised debt (MBS, ABS, CLOs), insurance-linked bonds and traded loans held at a price.' },
  { id: 'money', cls: 'cash', label: 'Money Market and Deposits', holds: 'Commercial paper, bankers\' acceptances and money-market funds. Deposits, loans, repo and securities lending are arranged on the Treasury and Account pages and listed here for reference.' },
  { id: 'fx', cls: 'cash', label: 'FX and Currencies', holds: 'Spot currency pairs. Currency balances themselves are ledger cash in Treasury and each Account.' },
  { id: 'commodities', cls: 'cash', label: 'Commodities', holds: 'Physical and spot commodities, metals, energy, agricultural products, emissions allowances and certificates.' },
  { id: 'crypto', cls: 'cash', label: 'Crypto and Digital Assets', holds: 'Cryptocurrencies, stablecoins and tokenized assets.' },
  { id: 'alternatives', cls: 'cash', label: 'Alternatives and Other', holds: 'Private equity and venture capital interests, infrastructure, direct real estate and insurance-linked securities, all valued by hand.' },
  { id: 'options', cls: 'deriv', label: 'Options', holds: 'Listed options, OTC options on any underlying, interest-rate caps, floors and collars, swaptions and exotic options.' },
  { id: 'futures', cls: 'deriv', label: 'Futures', holds: 'Equity, index, bond, rate, FX, commodity, volatility, dividend and crypto futures, and perpetual futures.' },
  { id: 'forwards', cls: 'deriv', label: 'Forwards', holds: 'Equity, bond, FX and commodity forwards, non-deliverable forwards, FRAs, FX swaps and TBA mortgage contracts.' },
  { id: 'swaps', cls: 'deriv', label: 'Swaps', holds: 'Interest-rate, cross-currency, inflation, equity, total-return, commodity and volatility swaps.' },
  { id: 'credit', cls: 'deriv', label: 'Credit Derivatives', holds: 'Credit-default swaps (single name, sovereign, index, tranche), credit-default swaptions, recovery swaps and credit-spread forwards and options.' },
  { id: 'structured', cls: 'deriv', label: 'Structured and Other Derivatives', holds: 'Weather derivatives, freight contracts and other contracts valued by hand.' },
];
const TAB_PRODUCTS = {
  equities: ['common_stock', 'preferred_stock', 'adr', 'gdr', 'reit', 'warrant', 'subscription_right', 'convertible_preferred', 'short_sale'],
  funds: ['etf', 'etn', 'mutual_fund', 'closed_end_fund', 'hedge_fund'],
  bonds: [
    'treasury_bill', 'treasury_note', 'treasury_bond', 'tips', 'strips', 'foreign_gov_bill', 'foreign_gov_bond', 'foreign_inflation_linked', 'em_local_debt', 'em_hard_debt',
    'agency_debt', 'supranational_bond', 'municipal_bond', 'sovereign_sukuk',
    'corporate_bond', 'corporate_bond_ig', 'high_yield_bond', 'eurobond', 'foreign_market_bond', 'corporate_sukuk', 'floating_rate_note', 'zero_coupon_bond', 'callable_bond',
    'puttable_bond', 'convertible_bond', 'exchangeable_bond', 'perpetual_bond', 'subordinated_debt', 'coco_bond', 'covered_bond',
    'mbs', 'rmbs', 'cmbs', 'agency_mbs', 'non_agency_mbs', 'specified_pool', 'abs', 'cmo', 'clo', 'cdo', 'credit_linked_note', 'structured_note', 'catastrophe_bond',
    'syndicated_loan', 'leveraged_loan', 'private_credit', 'distressed_debt', 'loan_participation',
  ],
  money: [
    'commercial_paper', 'abcp', 'bankers_acceptance', 'money_market_fund', 'certificate_of_deposit', 'bank_deposit', 'term_deposit',
    'cash_loan', 'secured_loan', 'unsecured_loan', 'margin_loan', 'securities_backed_loan', 'revolving_credit_facility',
    'repo', 'reverse_repo', 'overnight_repo', 'term_repo', 'open_repo', 'bilateral_repo', 'triparty_repo', 'gc_repo', 'special_repo', 'buy_sell_back', 'sell_buy_back',
    'securities_borrowing', 'securities_lending', 'stock_loan', 'bond_loan', 'collateral_swap',
  ],
  fx: ['currency', 'fx_spot'],
  commodities: ['physical_commodity', 'precious_metal', 'industrial_metal', 'crude_oil', 'refined_product', 'natural_gas', 'lng', 'coal', 'electricity', 'agricultural_commodity', 'livestock',
    'emissions_allowance', 'carbon_credit', 'renewable_energy_certificate'],
  crypto: ['cryptocurrency', 'stablecoin', 'tokenized_asset'],
  alternatives: ['private_equity', 'venture_capital', 'infrastructure', 'direct_real_estate', 'insurance_linked_security'],
  options: ['listed_option', 'equity_option', 'etf_option', 'index_option', 'option_on_future', 'otc_option', 'bond_option', 'interest_rate_option', 'fx_option', 'commodity_option',
    'crypto_option', 'swaption', 'interest_rate_cap', 'interest_rate_floor', 'interest_rate_collar', 'digital_option', 'barrier_option', 'asian_option', 'lookback_option',
    'basket_option', 'spread_option', 'quanto_option', 'compound_option'],
  futures: ['equity_future', 'equity_index_future', 'gov_bond_future', 'treasury_future', 'stir_future', 'fx_future', 'commodity_future', 'volatility_future', 'dividend_future',
    'crypto_future', 'perpetual_future'],
  forwards: ['equity_forward', 'bond_forward', 'fx_forward', 'ndf', 'commodity_forward', 'fra', 'fx_swap', 'tba_mortgage'],
  swaps: ['interest_rate_swap', 'ois', 'basis_swap', 'cross_currency_swap', 'cross_currency_basis_swap', 'non_deliverable_swap', 'zc_inflation_swap', 'yoy_inflation_swap',
    'constant_maturity_swap', 'cms_spread_swap', 'forward_starting_swap', 'amortizing_swap', 'accreting_swap', 'callable_swap', 'puttable_swap', 'quanto_swap', 'asset_swap',
    'equity_swap', 'equity_index_swap', 'equity_basket_swap', 'equity_trs', 'bond_trs', 'loan_trs', 'index_trs', 'commodity_swap', 'commodity_basis_swap', 'commodity_index_swap',
    'energy_swap', 'electricity_swap', 'freight_swap', 'dividend_swap', 'variance_swap', 'volatility_swap', 'correlation_swap', 'dispersion_swap'],
  credit: ['cds_single_name', 'cds_sovereign', 'cds_index', 'credit_basket_swap', 'cds_index_tranche', 'loan_cds', 'abs_cds', 'recovery_swap', 'cds_swaption',
    'credit_spread_forward', 'credit_spread_option'],
  structured: ['freight_contract', 'weather_derivative'],
};
/** Product id -> tab id. Built from TAB_PRODUCTS; a product listed twice is reported by the test, not silently kept. */
export const PRODUCT_TAB = {};
for (const [tab, ids] of Object.entries(TAB_PRODUCTS)) for (const id of ids) if (!(id in PRODUCT_TAB)) PRODUCT_TAB[id] = tab;
export const TAB_LISTS = TAB_PRODUCTS;
export const tabOf = (productId) => PRODUCT_TAB[productId] || null;
export const tabsFor = (view) => MARKET_TABS.filter((t) => t.cls === (MARKET_VIEWS[view]?.cls || 'cash'));

// Underlying asset class, for the filter on the derivative tabs. A product whose class depends on what it is written
// on (a listed option, an OTC or exotic option, an option on a future, a perpetual future) takes it from its
// underlying instrument's family; without an underlying it is "other".
export const ASSET_CLASSES = [
  { id: 'equity', label: 'Equity' }, { id: 'rates', label: 'Rates' }, { id: 'credit', label: 'Credit' }, { id: 'fx', label: 'FX' },
  { id: 'commodity', label: 'Commodity' }, { id: 'crypto', label: 'Crypto' }, { id: 'volatility', label: 'Volatility' }, { id: 'other', label: 'Other' },
];
const ASSET_PRODUCTS = {
  equity: ['equity_option', 'etf_option', 'index_option', 'equity_future', 'equity_index_future', 'dividend_future', 'equity_forward', 'equity_swap', 'equity_index_swap',
    'equity_basket_swap', 'equity_trs', 'index_trs', 'dividend_swap'],
  rates: ['bond_option', 'interest_rate_option', 'swaption', 'interest_rate_cap', 'interest_rate_floor', 'interest_rate_collar', 'gov_bond_future', 'treasury_future', 'stir_future',
    'bond_forward', 'fra', 'tba_mortgage', 'interest_rate_swap', 'ois', 'basis_swap', 'cross_currency_swap', 'cross_currency_basis_swap', 'non_deliverable_swap', 'zc_inflation_swap',
    'yoy_inflation_swap', 'constant_maturity_swap', 'cms_spread_swap', 'forward_starting_swap', 'amortizing_swap', 'accreting_swap', 'callable_swap', 'puttable_swap', 'quanto_swap', 'asset_swap'],
  credit: ['cds_single_name', 'cds_sovereign', 'cds_index', 'credit_basket_swap', 'cds_index_tranche', 'loan_cds', 'abs_cds', 'recovery_swap', 'cds_swaption', 'credit_spread_forward',
    'credit_spread_option', 'bond_trs', 'loan_trs'],
  fx: ['fx_future', 'fx_forward', 'ndf', 'fx_swap', 'fx_option'],
  commodity: ['commodity_future', 'commodity_forward', 'commodity_option', 'commodity_swap', 'commodity_basis_swap', 'commodity_index_swap', 'energy_swap', 'electricity_swap',
    'freight_swap', 'freight_contract'],
  crypto: ['crypto_future', 'crypto_option'],
  volatility: ['volatility_future', 'variance_swap', 'volatility_swap', 'correlation_swap', 'dispersion_swap'],
  other: ['weather_derivative'],
  underlying: ['listed_option', 'otc_option', 'digital_option', 'barrier_option', 'asian_option', 'lookback_option', 'basket_option', 'spread_option', 'quanto_option',
    'compound_option', 'option_on_future', 'perpetual_future'],
};
export const PRODUCT_ASSET = {};
for (const [cls, ids] of Object.entries(ASSET_PRODUCTS)) for (const id of ids) if (!(id in PRODUCT_ASSET)) PRODUCT_ASSET[id] = cls;
export const ASSET_LISTS = ASSET_PRODUCTS;
const FAMILY_ASSET = { equity: 'equity', fund: 'equity', bond: 'rates', fx: 'fx', spot: 'commodity', crypto: 'crypto' };
/** Asset class of a derivative instrument; `und` is its underlying registry row (or null), `undOfUnd` that one's. */
export function assetClassOf(productId, und, undOfUnd) {
  const c = PRODUCT_ASSET[productId];
  if (!c) return null;
  if (c !== 'underlying') return c;
  if (!und) return 'other';
  if (und.family === 'future' || und.family === 'option') return PRODUCT_ASSET[und.product_id] && PRODUCT_ASSET[und.product_id] !== 'underlying' ? PRODUCT_ASSET[und.product_id] : FAMILY_ASSET[undOfUnd?.family] || 'other';
  return FAMILY_ASSET[und.family] || 'other';
}

// ---- Marketplace routing convention (ui1) -----------------------------------------------------------------------
// Which market view an instrument sits in is decided from explicit metadata, never from its price currency:
//   1. listed     Exchange-listed with a listing-venue country: US venue -> US view, any other country -> Foreign.
//   2. financing  Loans, deposits, repo and securities loans are arrangements of one Book, held on the Treasury and
//                 Account pages; they never appear as Marketplace rows (their view is kept only as a record).
//   3. underlying A derivative with a registered underlying follows the underlying's view (US exposure -> US
//                 Derivatives).
//   4. jurisdiction An instrument with no listing country takes its stated jurisdiction (the governing law of an
//                 OTC contract), or, for an issued security (bond, private interest), its issuer's domicile.
//   5. convention Global FX and crypto, and OTC products with none of the above, have no US listing and no US
//                 jurisdiction. They are routed BY CONVENTION to Foreign Based / Foreign Derivatives: a US view is
//                 kept for instruments with a positive US connection, so it never implies a US listing that does
//                 not exist. The row and the instrument page say so.
//   6. manual     Set by hand. Any non-listed instrument can be moved by hand (the registry form offers it, and an
//                 explicit market view that differs from the convention is stored as set by hand). A listed product
//                 cannot: its listing venue decides.
// An exchange-listed product with no venue country recorded (and no other basis) needs its view chosen by hand.
export const ROUTING_BASES = {
  listed: 'Listing venue', financing: 'Financing arrangement', underlying: 'Follows its underlying', jurisdiction: 'Jurisdiction', convention: 'Routing convention', manual: 'Set by hand',
};
const GLOBAL_FAMILIES = new Set(['fx', 'crypto']);
const ISSUED_FAMILIES = new Set(['bond', 'manual', 'equity', 'fund', 'spot']);
const FINANCING = new Set(['loan', 'repo', 'secloan']);
const viewFor = (product, us) => `${us ? 'US' : 'FOREIGN'}_${product.cls === 'cash' ? 'CASH' : 'DERIV'}`;
const upper2 = (x) => (x ? String(x).trim().toUpperCase() : null);

/**
 * The view the convention gives an instrument, and why. `null` when nothing decides it (an exchange-listed product
 * with no venue country and no jurisdiction): the view must then be chosen by hand.
 *   facts: { product, venueType, venueCountry, jurisdiction, domicile, underlying (registry row or null), requestedView }
 */
export function conventionRoute({ product, venueType, venueCountry, jurisdiction, domicile, underlying, collateral, requestedView }) {
  const vc = upper2(venueCountry), jur = upper2(jurisdiction), dom = upper2(domicile);
  if (venueType === 'exchange' && vc) return { view: viewFor(product, vc === 'US'), basis: 'listed' };
  if (FINANCING.has(product.family)) {
    // Kept as a record only (arrangements are never Marketplace rows): its stated jurisdiction, else a view the caller
    // states, else the security it lends or takes as collateral, else the convention (Foreign). Never the currency.
    const sec = underlying || collateral || null;
    const keep = requestedView && MARKET_VIEWS[requestedView]?.cls === product.cls ? requestedView : null;
    return { view: jur ? viewFor(product, jur === 'US') : keep || (sec ? viewFor(product, MARKET_VIEWS[sec.market_view]?.geo === 'US') : viewFor(product, false)), basis: 'financing' };
  }
  if (product.cls === 'deriv' && underlying) return { view: viewFor(product, MARKET_VIEWS[underlying.market_view]?.geo === 'US'), basis: 'underlying' };
  if (jur) return { view: viewFor(product, jur === 'US'), basis: 'jurisdiction', via: 'stated' };
  if (dom && venueType !== 'exchange' && ISSUED_FAMILIES.has(product.family)) return { view: viewFor(product, dom === 'US'), basis: 'jurisdiction', via: 'issuer' };
  if (GLOBAL_FAMILIES.has(product.family) || venueType === 'global' || venueType === 'otc' || product.cls === 'deriv') return { view: viewFor(product, false), basis: 'convention' };
  return null;
}

/** A few words for a Marketplace row: what placed the instrument (the full sentence is routingText). */
export function routingShort({ basis, venue, venueCountry, jurisdiction, domicile, underlying, family, venueType }) {
  switch (basis) {
    case 'listed': return `Listed in ${upper2(venueCountry)}${venue ? ` (${venue})` : ''}`;
    case 'financing': return 'Financing arrangement';
    case 'underlying': return `Follows its underlying${underlying ? `, ${underlying.symbol || underlying.name}` : ''}`;
    case 'jurisdiction': return upper2(jurisdiction) ? `${upper2(jurisdiction)} jurisdiction, not listed` : `Issuer in ${upper2(domicile)}, not listed`;
    case 'convention': return `${GLOBAL_FAMILIES.has(family) || venueType === 'global' ? 'Global' : 'OTC'}, routed by convention`;
    case 'manual': return 'Set by hand';
    default: return '';
  }
}

/** The sentence for the instrument page and the row's hover: what decided the view. */
export function routingText({ basis, view, venue, venueCountry, jurisdiction, domicile, underlying, family, venueType, convention }) {
  const label = MARKET_VIEWS[view]?.label || view;
  const vc = upper2(venueCountry);
  switch (basis) {
    case 'listed': return `Listed in ${vc}${venue ? ` (${venue})` : ''}`;
    case 'financing': return 'Financing, arranged on the Treasury and Account pages';
    case 'underlying': return `Follows its underlying${underlying ? `, ${underlying.symbol || underlying.name}` : ''}`;
    case 'jurisdiction': return upper2(jurisdiction) ? `Jurisdiction ${upper2(jurisdiction)}, not listed` : `Issuer domiciled in ${upper2(domicile)}, not listed`;
    case 'convention': return `${GLOBAL_FAMILIES.has(family) || venueType === 'global' ? 'Global' : 'OTC'}, no US listing: routed by convention to ${label}`;
    case 'manual': return `Set by hand${convention && convention.view !== view ? ` (the convention gives ${MARKET_VIEWS[convention.view]?.label})` : ''}`;
    default: return '';
  }
}
