# Implementation coverage

Generated from `server/core/catalog.js` by `npm run coverage`. The same list, with filters, is on the
Terminal's **Instruments > Coverage** tab.

Two separate things are stated for every product, and neither implies the other. **Lifecycle
support** is what the paper engine does with an instrument once it is registered and priced: orders,
fills, settlement, accounting and lifecycle events. **Pricing coverage** is where the product's
price comes from: a market quote from Shaffer MarketData, a dealer or model mark from Shaffer
Analytics Lab, no price at all (the position is carried at principal plus accrued), or a value
entered by hand. A product can have a fully simulated lifecycle and no price source yet, or a price
source and a lifecycle that is partly recorded by hand.

Listing a product here is not a claim that market data exists for it. The pricing column names the
source a price is expected from, not whether prices are arriving: that is reported dataset by
dataset on the Terminal's **Data connection** page, and instrument by instrument in the registry.
Until Shaffer MarketData and Analytics Lab are connected every instrument is registered and priced
by hand (always labelled as manual), or exercised in the isolated demo environment.

## Lifecycle support

| Level | Products | What it means |
|---|---:|---|
| Full lifecycle | 124 | Orders, fills, settlement, accounting and scheduled lifecycle events are simulated automatically from the contract terms. |
| Partly manual | 65 | Trading, settlement and accounting are automatic. Some lifecycle events or contract features are recorded by hand, as the note for each product says. |
| Manual inputs | 16 | The instrument can be held and accounted for, but its valuation and cash flows are entered by hand. |
| Not implemented | 0 | Listed for completeness; cannot be traded. |
| **Total** | **205** | |

## Pricing coverage

| Pricing basis | Products | What it means |
|---|---:|---|
| Market quote | 99 | Market quote from Shaffer MarketData; a manual price meanwhile. |
| Model mark | 65 | Dealer or model mark from Shaffer Analytics Lab; a manual mark meanwhile. |
| No price needed | 25 | No price needed: carried at principal plus accrued. |
| Valued by hand | 16 | Valued by hand. |
| **Total** | **205** | |

## Equities

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Common stock (domestic and foreign) | Equity-like security | Full lifecycle | Market quote | Cash dividends and splits are applied from supplied or manually recorded corporate actions. Mergers, spin-offs and tenders are recorded by hand. |
| Preferred stock | Equity-like security | Full lifecycle | Market quote | Preferred dividends are booked as dividends from recorded corporate actions. |
| American depositary receipt (ADR) | Equity-like security | Full lifecycle | Market quote | Listed in the US; issuer domicile stored separately. Depositary fees are recorded by hand. |
| Global depositary receipt (GDR) | Equity-like security | Full lifecycle | Market quote | Depositary fees are recorded by hand. |
| Exchange-traded fund (ETF) | Equity-like security | Full lifecycle | Market quote |  |
| Exchange-traded note (ETN) | Equity-like security | Full lifecycle | Market quote | Issuer credit events are recorded by hand. |
| REIT | Equity-like security | Full lifecycle | Market quote |  |
| Warrant | Equity-like security | Partly manual | Market quote | Exercise and expiry are recorded by hand. |
| Subscription right | Equity-like security | Partly manual | Market quote | Exercise and lapse are recorded by hand. |
| Convertible security (preferred) | Equity-like security | Partly manual | Market quote | Conversion is recorded by hand. |

## Funds

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Mutual fund | Fund (NAV-priced) | Full lifecycle | Market quote | Trades at the next supplied NAV; distributions from recorded corporate actions. |
| Closed-end fund | Equity-like security | Full lifecycle | Market quote |  |

## Private markets

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Private equity interest | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: the commitment (registration), capital calls with their fee part, distributions split into return of capital, gain and income with carried interest withheld, valuations with date and source (stale after the contract's limit; rolled forward for later calls and distributions), secondary sales and the wind-up. |
| Venture capital interest | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: the commitment (registration), capital calls with their fee part, distributions split into return of capital, gain and income with carried interest withheld, valuations with date and source (stale after the contract's limit; rolled forward for later calls and distributions), secondary sales and the wind-up. |
| Hedge fund interest | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: subscriptions at a stated NAV, NAV per share with date and source, redemption notices and each dealing date's NAV. The Terminal works out the dealing date (notice period, frequency), the investor-level gate and the payment date; each dealing date waits, visibly, for its NAV. |
| Infrastructure investment | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: purchase and sale prices with their closing dates, income, operating expenses, capital expenditure (added to cost), appraisals with date and source (rolled forward for capex). |
| Direct real estate | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: purchase and sale prices with their closing dates, income, operating expenses, capital expenditure (added to cost), appraisals with date and source (rolled forward for capex). |

## Government debt

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| US Treasury bill | Debt security | Full lifecycle | Market quote | Discount instrument; redeems at par. |
| US Treasury note | Debt security | Full lifecycle | Market quote |  |
| US Treasury bond | Debt security | Full lifecycle | Market quote |  |
| US TIPS | Debt security | Partly manual | Market quote | Inflation accretion of principal is not automated; record index-ratio adjustments by hand. |
| US Treasury STRIPS | Debt security | Full lifecycle | Market quote | Zero-coupon. |
| Foreign government bill | Debt security | Full lifecycle | Market quote |  |
| Foreign government bond | Debt security | Full lifecycle | Market quote |  |
| Foreign inflation-linked bond | Debt security | Partly manual | Market quote | Inflation accretion of principal is recorded by hand. |
| Emerging-market local-currency debt | Debt security | Full lifecycle | Market quote |  |
| Emerging-market hard-currency debt | Debt security | Full lifecycle | Market quote |  |
| Agency debt | Debt security | Full lifecycle | Market quote |  |
| Supranational bond | Debt security | Full lifecycle | Market quote |  |
| Municipal bond (domestic and foreign) | Debt security | Full lifecycle | Market quote | Tax treatment is not modelled. |
| Sovereign sukuk | Debt security | Full lifecycle | Market quote | Periodic distributions are booked on the coupon schedule. |

## Corporate debt

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Corporate bond (domestic and foreign) | Debt security | Full lifecycle | Market quote |  |
| Investment-grade bond | Debt security | Full lifecycle | Market quote |  |
| High-yield bond | Debt security | Full lifecycle | Market quote | Defaults and restructurings are recorded by hand. |
| Eurobond | Debt security | Full lifecycle | Market quote |  |
| Foreign-market bond (Yankee, Samurai, Bulldog …) | Debt security | Full lifecycle | Market quote |  |
| Corporate sukuk | Debt security | Full lifecycle | Market quote | Periodic distributions are booked on the coupon schedule. |
| Floating-rate note | Debt security | Full lifecycle | Market quote | Each coupon needs its reference-rate fixing (supplied or entered); a missing fixing blocks that coupon visibly. |
| Zero-coupon bond | Debt security | Full lifecycle | Market quote |  |
| Callable bond | Debt security | Partly manual | Market quote | Issuer calls are recorded by hand as an early redemption. |
| Puttable bond | Debt security | Partly manual | Market quote | Exercising the put is recorded by hand as an early redemption. |
| Convertible bond | Debt security | Partly manual | Market quote | Conversion into shares is recorded by hand. |
| Exchangeable bond | Debt security | Partly manual | Market quote | Exchange into shares is recorded by hand. |
| Perpetual bond | Debt security | Full lifecycle | Market quote | No maturity; coupons continue until sold or called (call recorded by hand). |
| Subordinated debt | Debt security | Full lifecycle | Market quote |  |
| Contingent convertible bond (CoCo) | Debt security | Partly manual | Market quote | Trigger events, write-downs and coupon cancellations are recorded by hand. |
| Covered bond | Debt security | Full lifecycle | Market quote |  |

## Securitised debt

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Mortgage-backed security | Debt security | Partly manual | Market quote | Principal paydowns (pool factor) are recorded by hand; coupons follow the current face. |
| Residential MBS | Debt security | Partly manual | Market quote | Principal paydowns (pool factor) are recorded by hand. |
| Commercial MBS | Debt security | Partly manual | Market quote | Principal paydowns are recorded by hand. |
| Agency MBS | Debt security | Partly manual | Market quote | Principal paydowns (pool factor) are recorded by hand. |
| Non-agency MBS | Debt security | Partly manual | Market quote | Principal paydowns and losses are recorded by hand. |
| TBA mortgage contract | Forward / FRA | Partly manual | Model mark | Booked as a forward on the pass-through coupon. The pool the seller allocates is recorded by hand on the position before settlement (checked for good delivery) and delivered on paper (simulated) on the settlement date. |
| Mortgage specified pool | Debt security | Partly manual | Market quote | Registered with its stated pool characteristics (required). Coupons after the payment delay are automatic; the monthly factor and paydown (scheduled and prepaid) are recorded by hand; a loss allocation is refused for a guaranteed pool. |
| Asset-backed security | Debt security | Partly manual | Market quote | Coupons net of a stated servicing fee are automatic (gross, fee and net in the history); the factor and principal paydowns from the servicer report are recorded by hand. |
| Collateralised mortgage obligation (CMO) | Debt security | Partly manual | Market quote | A sequential class receives no principal while its senior class is outstanding: the senior balance and the tranche factor are recorded by hand from each remittance report; coupons are automatic. |
| Collateralised loan obligation (CLO) | Debt security | Partly manual | Market quote | Floating coupons on current face need fixings (a missing fixing blocks visibly); a coupon paid in kind (deferrable class), paydowns and loss allocations are recorded by hand. |
| Collateralised debt obligation (CDO) | Debt security | Partly manual | Market quote | Floating coupons on current face need fixings (a missing fixing blocks visibly); paydowns, loss allocations and, for a deferrable class, coupons paid in kind are recorded by hand. |
| Credit-linked note | Debt security | Partly manual | Market quote | Registered with its reference entity. Coupons are automatic; the credit event is recorded by hand with the auction recovery: the coupon ends (accrued forfeited) and principal settles at the recovery. |
| Structured note | Debt security | Partly manual | Market quote | Contingent coupons and the principal at maturity (protected, or against a barrier) are worked out from observations of the linked underlying, each recorded by hand; a coupon or redemption waits visibly for its observation. Other payoff-linked amounts are recorded as manual cash flows. |

## Insurance-linked

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Catastrophe bond | Debt security | Partly manual | Market quote | Registered with its collateral account. Coupons (collateral return plus spread, fixings needed) are automatic; a covered event and its principal loss are recorded by hand, releasing collateral to the sponsor. |
| Insurance-linked security | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: coupons, valuations in % of face with date and source, loss events writing face down, and the redemption at maturity (the maturity waits for it). |
| Weather derivative | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: marks with date and source, and the index for the period; the payment is worked out from the strike, tick and cap stated on the contract. A collateral basis is required. |

## Money market

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Commercial paper | Debt security | Full lifecycle | Market quote | Discount instrument; redeems at par. |
| Asset-backed commercial paper | Debt security | Full lifecycle | Market quote | Discount instrument; redeems at par. |
| Certificate of deposit | Cash loan / deposit | Full lifecycle | No price needed | Booked as cash lent to the issuing bank at the stated rate. |
| Bankers' acceptance | Debt security | Full lifecycle | Market quote | Discount instrument; redeems at par. |
| Money-market fund | Fund (NAV-priced) | Full lifecycle | Market quote | Distributions from recorded corporate actions. |
| Bank deposit | Cash loan / deposit | Full lifecycle | No price needed | Open-ended cash lent at a stated rate. |
| Term deposit | Cash loan / deposit | Full lifecycle | No price needed |  |

## Loans and credit

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Syndicated loan | Debt security | Partly manual | Market quote | Held at a % of par price, traded by assignment (no short sale) on par or distressed documentation; delayed compensation after T+7 and floating coupons (fixings needed) are automatic; amortisation, prepayments, draws, repricings and fees are recorded by hand. |
| Leveraged loan | Debt security | Partly manual | Market quote | Traded by assignment (no short sale), floating coupons with fixings, delayed compensation on late par settlement; amortisation, prepayments and a repricing (new spread, soft-call premium) are recorded by hand. |
| Revolving credit facility | Cash loan / deposit | Partly manual | No price needed | Each drawing is a loan; commitment fees are recorded by hand. |
| Private credit | Debt security | Partly manual | Market quote | Valuation is manual (stated fill prices, marks by hand); a fixed PIK component is capitalised automatically; draws on the delayed-draw commitment, commitment fees, amortisation and repayments are recorded by hand. |
| Distressed debt | Debt security | Partly manual | Market quote | The default is recorded by hand (non-accrual, trades flat, coupon dates listed unpaid); interim and final recovery distributions are recorded by hand; distributions in new securities are recorded as a sale and a purchase. |
| Loan participation | Debt security | Partly manual | Market quote | Registered with its grantor and the grantor's face; coupons are passed through as the participation's share after the payment delay; amortisation and prepayments are recorded by hand. |

## Cash and FX

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| USD and foreign currency balances | Currency balance | Full lifecycle | No price needed | Held as ledger cash by currency in Treasury and each Account. |
| Spot FX / currency pair | Spot FX | Full lifecycle | Market quote | A conversion between two currency balances; never implied by a transfer. |

## Funding

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Cash borrowing and lending (USD or foreign currency) | Cash loan / deposit | Full lifecycle | No price needed |  |
| Secured loan | Cash loan / deposit | Full lifecycle | No price needed | Pledges named positions as collateral. |
| Unsecured loan | Cash loan / deposit | Full lifecycle | No price needed |  |
| Margin loan | Cash loan / deposit | Full lifecycle | No price needed | Open-ended, floating or fixed rate. |
| Securities-backed loan | Cash loan / deposit | Full lifecycle | No price needed | Pledges named positions as collateral. |

## Securities finance

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Securities borrowing | Securities loan | Full lifecycle | No price needed | Borrow availability and fee come from supplied data or a stated assumption; recalls are triggered by hand or by supplied data. |
| Securities lending | Securities loan | Full lifecycle | No price needed |  |
| Stock loan | Securities loan | Full lifecycle | No price needed |  |
| Bond loan | Securities loan | Full lifecycle | No price needed | Cash collateral on the bonds' dirty value; the fee accrues on clean market value. |
| Short sale | Equity-like security | Full lifecycle | Market quote | Always paired with a securities borrow; proceeds are held as restricted collateral. |
| Repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Reverse repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Overnight repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Term repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Open repo | Repo / reverse repo | Full lifecycle | No price needed | Runs until terminated; the rate can be reset. |
| Bilateral repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Tri-party repo | Repo / reverse repo | Full lifecycle | No price needed | The tri-party agent is recorded as a term; otherwise simulated as a bilateral repo. Basket allocation and the agent's substitutions are not automated: collateral changes are recorded by hand. |
| General-collateral repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Special-collateral repo | Repo / reverse repo | Full lifecycle | No price needed | The special rate is entered on the ticket (not derived); the named security cannot be substituted. |
| Buy/sell-back | Repo / reverse repo | Full lifecycle | No price needed | Two outright trades: bought spot, sold back at a forward price fixed at inception (net of the coupon falling in the term, which the buyer receives). Accounted as cash lent against the bond; no rate reset, margin or substitution. |
| Sell/buy-back | Repo / reverse repo | Full lifecycle | No price needed | Two outright trades: sold spot, bought back at a forward price fixed at inception (net of the coupon falling in the term, passed to the buyer). Accounted as a financing: the bond stays on the balance sheet, pledged; no rate reset, margin or substitution. |
| Securities collateral swap | Manually valued holding | Manual inputs | Valued by hand | Book the two securities loans separately to move the securities, or hold it as a manual arrangement: baskets recorded on the contract (not moved), fees per period worked out from its terms, marks and termination by hand. A collateral basis is required. |

## Commodities

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Physical / spot commodity | Spot asset | Partly manual | Market quote | Storage, delivery and insurance costs are recorded by hand. |
| Precious metal | Spot asset | Partly manual | Market quote | Storage costs are recorded by hand. |
| Industrial metal | Spot asset | Partly manual | Market quote | Storage costs are recorded by hand. |
| Crude oil | Spot asset | Partly manual | Market quote | Storage and delivery are recorded by hand. |
| Refined petroleum product | Spot asset | Partly manual | Market quote | Storage and delivery are recorded by hand. |
| Natural gas | Spot asset | Partly manual | Market quote | Storage and delivery are recorded by hand. |
| LNG | Spot asset | Partly manual | Market quote | Cargo logistics are recorded by hand. |
| Coal | Spot asset | Partly manual | Market quote | Storage and delivery are recorded by hand. |
| Electricity | Spot asset | Partly manual | Market quote | Cannot be stored; delivery periods are recorded by hand. |
| Agricultural commodity | Spot asset | Partly manual | Market quote | Storage and delivery are recorded by hand. |
| Livestock | Spot asset | Partly manual | Market quote | Delivery is recorded by hand. |
| Freight contract | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: marks per unit with date and source, and each period's index average; each period settles (average - contract rate) x quantity. A collateral basis is required. |

## Environmental

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Emissions allowance | Spot asset | Full lifecycle | Market quote | Surrender/retirement is recorded as a sale at zero by hand. |
| Carbon credit | Spot asset | Full lifecycle | Market quote | Retirement is recorded by hand. |
| Renewable energy certificate | Spot asset | Full lifecycle | Market quote | Retirement is recorded by hand. |

## Digital assets

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Cryptocurrency | Digital asset | Full lifecycle | Market quote | Forks, airdrops and staking rewards are recorded by hand. |
| Stablecoin | Digital asset | Full lifecycle | Market quote |  |
| Tokenized asset | Digital asset | Full lifecycle | Market quote | Income on the underlying is recorded by hand. |

## Futures

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Equity (single-stock) future | Future | Full lifecycle | Market quote | Daily variation margin; closed out in cash at final settlement (physical delivery is not simulated). |
| Equity-index future | Future | Full lifecycle | Market quote | Daily variation margin; cash settlement. |
| Government-bond future | Future | Full lifecycle | Market quote | Closed out in cash at final settlement; delivery of the cheapest-to-deliver bond is not simulated. |
| Treasury future | Future | Full lifecycle | Market quote | Closed out in cash at final settlement; delivery is not simulated. |
| Short-term interest-rate future | Future | Full lifecycle | Market quote |  |
| FX future | Future | Full lifecycle | Market quote | Closed out in cash at final settlement; currency delivery is not simulated. |
| Commodity future | Future | Full lifecycle | Market quote | Daily variation margin. A physically delivered contract with its deliverable set as Underlying is delivered on paper (simulated) at final settlement, or earlier on a short's delivery notice inside the delivery window: goods received or given up at the invoice amount. Cash-settled contracts, or physical ones without a deliverable, are closed out in cash. |
| Volatility future | Future | Full lifecycle | Market quote |  |
| Dividend future | Future | Full lifecycle | Market quote |  |
| Cryptocurrency future | Future | Full lifecycle | Market quote |  |
| Perpetual future | Future | Partly manual | Market quote | Funding payments are recorded by hand; there is no expiry. |

## Forwards

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Equity forward | Forward / FRA | Full lifecycle | Model mark | Cash-settled against a supplied or entered fixing, or physically delivered (simulated, delivery against payment on the value date) from or into the underlying position. Early termination at a stated amount. |
| Bond forward | Forward / FRA | Full lifecycle | Model mark | In face amount and % of par. Physically delivered (simulated) on the value date at the clean price plus accrued interest, or cash-settled against the bond's close. |
| FX forward | Forward / FRA | Full lifecycle | Model mark | Deliverable: the two currency amounts are exchanged on the value date. |
| Non-deliverable forward | Forward / FRA | Full lifecycle | Model mark | Cash-settled against the fixing on the fixing date. |
| Commodity forward | Forward / FRA | Full lifecycle | Model mark | In the commodity's own units. Cash-settled against its close on the value date (a missing fixing waits visibly), or delivered (simulated). |
| Forward-rate agreement | Forward / FRA | Full lifecycle | Model mark | Settled at the start of the period, discounted at the fixing. |
| FX swap | Forward / FRA | Full lifecycle | Model mark | Booked as a near leg and a far leg (each a deliverable FX forward of its own value date) in one package on the Strategies page. |

## Credit derivatives

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Credit-spread forward | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract's stated formula. A collateral basis is required. |
| Credit-spread option | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract's stated formula. A collateral basis is required. |
| Single-name credit-default swap | Credit default swap | Full lifecycle | Model mark | Premiums pay quarterly; a credit event is triggered by hand with the recovery rate. |
| Sovereign credit-default swap | Credit default swap | Full lifecycle | Model mark | Sovereign credit events only (no bankruptcy); a credit event is triggered by hand. |
| Credit-index swap | Credit default swap | Full lifecycle | Model mark | Constituent defaults reduce the notional by hand (index factor). |
| Credit-basket swap | Credit default swap | Partly manual | Model mark | Defaults are recorded by hand; nth-to-default settles in full at the nth default and ends. |
| Credit-index tranche swap | Credit default swap | Partly manual | Model mark | Index defaults are recorded by hand; the loss is written down between the attachment and detachment points. |
| Loan credit-default swap | Credit default swap | Partly manual | Model mark | Credit events and cancellation on refinancing are recorded by hand. |
| Asset-backed credit-default swap | Credit default swap | Partly manual | Model mark | Monthly premium on the payment day; pay-as-you-go events (shortfall, writedown, reimbursement, amortization) are recorded by hand. |
| Recovery swap | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: marks with date and source, the credit event, and the recovery rate from the auction; settles notional x (recovery - fixed rate) only after a credit event. A collateral basis is required. |

## Options

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Listed option | Listed option | Full lifecycle | Market quote | Expiration, exercise and assignment are automated from the contract deliverable. |
| Equity call / put | Listed option | Full lifecycle | Market quote |  |
| ETF option | Listed option | Full lifecycle | Market quote |  |
| Index option | Listed option | Full lifecycle | Market quote | Cash-settled; AM-settled series need their settlement value as the fixing. |
| Option on a future | Listed option | Full lifecycle | Market quote | Exercise delivers the futures position at the strike. Contract data must be supplied or entered. |
| OTC option | OTC option | Full lifecycle | Model mark | Vanilla calls and puts, cash or physical settlement. |
| Bond option | OTC option | Full lifecycle | Model mark |  |
| Interest-rate option | OTC option | Partly manual | Model mark | Booked on a rate fixing, cash-settled against it and paid on the stated payment date; convexity and the discounting of an in-arrears payment are not modelled. |
| FX option | OTC option | Full lifecycle | Model mark |  |
| Commodity option | OTC option | Full lifecycle | Model mark |  |
| Cryptocurrency option | OTC option | Full lifecycle | Model mark |  |
| Swaption | OTC option | Partly manual | Model mark | Exercise is recorded by hand: into the registered swap at a stated entry price, or a cash settlement amount entered by hand. The swaption is not valued by the Terminal. |
| Credit-default swaption | OTC option | Partly manual | Model mark | Exercise is recorded by hand, into the registered credit default swap at a stated upfront; a credit event knocks it out (recorded by hand, or with the credit event on the swap). |
| Interest-rate cap | Swap | Full lifecycle | Model mark | A capped floating leg: each caplet pays against its fixing. |
| Interest-rate floor | Swap | Full lifecycle | Model mark | A floored floating leg: each floorlet pays against its fixing. |
| Interest-rate collar | Swap | Full lifecycle | Model mark | A cap leg and a floor leg in one contract. |
| Digital option | OTC option | Full lifecycle | Model mark | Cash-or-nothing payout against the expiry fixing. |
| Barrier option | OTC option | Partly manual | Model mark | Barrier events are recorded by hand on the position; prices are not monitored for the barrier, intraday or at the close. |
| Asian option | OTC option | Partly manual | Model mark | Settles on the average of the underlying closes on the averaging dates, each supplied or entered by hand; without averaging dates the averaged settlement amount is entered by hand. |
| Lookback option | OTC option | Partly manual | Model mark | The observed extreme is recorded by hand on the position; the payoff is worked out from it (and from the expiry close for a floating strike). |
| Basket option | OTC option | Partly manual | Model mark | The basket value at expiry is entered by hand; the payoff is worked out from it. |
| Spread option | OTC option | Partly manual | Model mark | The spread value at expiry is entered by hand; the payoff is worked out from it. |
| Quanto option | OTC option | Partly manual | Model mark | Settles against the underlying close converted at the contract's fixed rate; marks are entered by hand. |
| Compound option | OTC option | Partly manual | Model mark | Exercised into the underlying option, by hand or at expiry against that option's mark for the date, which is entered by hand. |

## Swaps

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Interest-rate swap | Swap | Full lifecycle | Model mark | Fixed and floating legs pay on their schedules; floating payments need their fixings. |
| Overnight-index swap | Swap | Full lifecycle | Model mark | Compounds the supplied overnight fixings; a missing fixing blocks the payment visibly. |
| Interest-rate basis swap | Swap | Full lifecycle | Model mark |  |
| Cross-currency swap | Swap | Full lifecycle | Model mark | Notional exchanges at start and end are booked in each currency. |
| Cross-currency basis swap | Swap | Full lifecycle | Model mark |  |
| Non-deliverable swap | Swap | Partly manual | Model mark | Legs are worked out in their own currencies and paid in the settlement currency at the FX fixing of the fixing date, entered by hand; payments wait for it. |
| Zero-coupon inflation swap | Swap | Full lifecycle | Model mark | Needs the index fixings at start and end. |
| Year-on-year inflation swap | Swap | Full lifecycle | Model mark | Needs an index fixing for each period. |
| Constant-maturity swap | Swap | Full lifecycle | Model mark | The CMS rate is supplied as the fixing; no convexity adjustment is applied by the Terminal. |
| Constant-maturity spread swap | Swap | Partly manual | Model mark | The leg pays the first index less a second index (Minus index) plus the spread, both fixed at the period start. |
| Forward-starting swap | Swap | Full lifecycle | Model mark |  |
| Amortizing swap | Swap | Full lifecycle | Model mark | Notional schedule on the contract form: a factor for the first day of every period of each scheduled leg (a missing or misplaced step is refused). Amounts and a percentage independent amount follow the notional of each period. |
| Accreting swap | Swap | Full lifecycle | Model mark | Notional schedule on the contract form: a factor for the first day of every period of each scheduled leg (a missing or misplaced step is refused). Amounts and a percentage independent amount follow the notional of each period. |
| Callable swap | Swap | Partly manual | Model mark | The call is exercised by hand on one of its dates by the side holding it: accrued amounts are settled and the swap ends at no cost. |
| Puttable swap | Swap | Partly manual | Model mark | The put is exercised by hand on one of its dates by the side holding it: accrued amounts are settled and the swap ends at no cost. |
| Quanto swap | Swap | Partly manual | Model mark | A quanto leg is worked out in its quanto currency and converted at the fixed rate of the contract; spot FX plays no part. No quanto convexity adjustment. |
| Asset swap | Swap | Partly manual | Model mark | Book the bond and the swap as two legs of one package; the swap upfront (100 less the dirty price for a par asset swap) is stated by hand. |
| Equity swap | Swap | Full lifecycle | Model mark | Return leg against a financing leg; the reference close of each reset date (supplied or entered by hand; a missing one blocks the payment). Optional notional reset, the financing then on the reset notional; optional payment lag. |
| Equity-index swap | Swap | Full lifecycle | Model mark | As the equity swap, on an index level carried by a reference instrument (the catalog has no index product). |
| Equity-basket swap | Swap | Partly manual | Model mark | The basket (names and weights) is recorded on the leg; its level at each reset is entered by hand on the payment item. |
| Equity total-return swap | Swap | Full lifecycle | Model mark | A cash dividend recorded on the reference passes through on its ex-date, from the start fixing of its period (a missing fixing holds it visibly). The form has no separate dividend pay date. |
| Bond total-return swap | Swap | Full lifecycle | Model mark | Return on the bond closes (clean prices); the coupon pass-through is recorded by hand on the position (manual coupon cash flow): a swap does not follow the bond's coupons. |
| Loan total-return swap | Swap | Partly manual | Model mark | Interest pass-through and paydowns are recorded by hand. |
| Index total-return swap | Swap | Full lifecycle | Model mark | Return on an index level carried by a reference instrument; index dividends recorded by hand on it pass through. |
| Commodity swap | Swap | Full lifecycle | Model mark | Fixed price against the period-end fixing or the average of the daily fixings on a pricing calendar (a missing day blocks the payment, named); optional net settlement and payment lag. |
| Commodity basis swap | Swap | Full lifecycle | Model mark | Averaged price legs on two references and a fixed differential, net settled. |
| Commodity-index swap | Swap | Full lifecycle | Model mark | Return on a commodity index level carried by a reference instrument, against a fee or financing leg; notional reset at each reset. |
| Energy swap | Swap | Full lifecycle | Model mark | Quantity per period or per calendar day (gas); averaged daily fixings on a pricing calendar; net settlement. |
| Electricity swap | Swap | Full lifecycle | Model mark | MWh from delivery hours (base, peak, off-peak; peak hours a day, peak-day calendar); averaged daily fixings; net settlement. Clock changes are not counted (a 23- or 25-hour day is taken as 24). |
| Freight swap | Swap | Full lifecycle | Model mark | Route average of the daily assessments on a pricing calendar (the route carried by a reference instrument), net settled. |
| Dividend swap | Swap | Partly manual | Model mark | The dividend leg pays the cash dividends going ex in each period, as recorded by hand on the stock. |
| Variance swap | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract's stated formula. A collateral basis is required. |
| Volatility swap | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract's stated formula. A collateral basis is required. |
| Correlation swap | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract's stated formula. A collateral basis is required. |
| Dispersion swap | Manually valued holding | Manual inputs | Valued by hand | Entered by hand: marks with date and source, and the realised value at expiry; the settlement is worked out with the contract's stated formula. A collateral basis is required. |

## Settlement calendars

Settlement dates and payment dates are worked out on the Terminal's own rule-based calendars, listed
below from `server/quant/calendar.js`, until Shaffer MarketData supplies market calendars. An
instrument's calendar is the one named in its own terms, else the calendar of its listing-venue
country (an instrument in a US market view with no country recorded uses the US calendars), else
the payment calendar of its settlement or trading currency. For a euro-area venue the TARGET closing
days are used; any further closing days of its exchange are not included. A spot FX value date uses
the payment calendars of both currencies and must also be a US dollar banking day.

| Calendar | What it covers | Used for |
|---|---|---|
| US | US equity markets (NYSE rules) | Venues in US and instruments in a US market view, except debt securities |
| USBOND | US bond market (SIFMA rules) | Debt securities on a US venue or in a US market view |
| USD | US dollar payments (Federal Reserve holidays) | US dollar payments; every spot FX value date must also be a US dollar banking day |
| UK | London markets and sterling payments (England and Wales bank holidays) | Venues in GB; GBP payments |
| TARGET | Euro payments (TARGET2 closing days) | Venues in DE, FR, NL, BE, IT, ES, PT, IE, AT, FI, LU, GR; EUR payments |
| JP | Tokyo markets and yen payments (Japanese national holidays) | Venues in JP; JPY payments |
| CA | Toronto markets and Canadian dollar payments | Venues in CA; CAD payments |
| WEEKEND | Weekends only: no holiday calendar for this market | Any venue country or currency with no calendar in this table |
| ALLDAYS | Every calendar day (24/7 markets) | Digital assets |
| FX | Global FX market (Monday to Friday, around the clock) |  |

Payment calendar by currency: USD uses USD, EUR uses TARGET, GBP uses UK, JPY uses JP, CAD uses CA.

Any other market or currency has no calendar and falls back to weekends only (the WEEKEND calendar).
The fallback is never silent: the instrument states it, and every trade preview that works out a
date on it carries a warning. Rule-based calendars cannot know one-off closures; those, and local
holidays for a market on the fallback, are entered by hand under **Settings > Market calendars**.

## Marketplace product-family tabs

Each of the four Marketplaces (US Based, US Derivatives, Foreign Based, Foreign Derivatives) is split into
product-family tabs: the eight cash tabs in US Based and Foreign Based, the six derivative tabs in the two
Derivatives views. Every product has exactly one tab (checked by `test/core/marketplaces.test.js`, which also
places a US-listed and a foreign-listed instrument of every product in one tab of one view). Which of the two views
of its class an instrument sits in is decided per instrument, never from its price currency:

1. Listed: by the listing venue's country (US venue: a US view; any other country: a Foreign view).
2. Financing (deposits, loans, repo, securities loans): arranged on the Treasury and Account pages, never a
   Marketplace row; the Money Market and Deposits tab lists them for reference and links there.
3. A derivative with a registered underlying follows the underlying's view.
4. Not listed: its stated jurisdiction (an OTC contract's governing law), or an issued security's issuer domicile.
5. **Routing convention:** global FX, crypto and OTC products with none of the above have no US listing and no US
   jurisdiction, so they are routed to Foreign Based / Foreign Derivatives. A US view is kept for a positive US
   connection and never implies a US listing that does not exist.
6. Set by hand: any instrument that is not listed can be placed in the other view by hand; the row says so.

| Tab | Views | Products |
|---|---|---|
| Equities | US Based, Foreign Based | Common stock (domestic and foreign), Preferred stock, American depositary receipt (ADR), Global depositary receipt (GDR), REIT, Warrant, Subscription right, Convertible security (preferred), Short sale |
| Funds and ETFs | US Based, Foreign Based | Exchange-traded fund (ETF), Exchange-traded note (ETN), Mutual fund, Closed-end fund, Hedge fund interest |
| Bonds and Credit | US Based, Foreign Based | US Treasury bill, US Treasury note, US Treasury bond, US TIPS, US Treasury STRIPS, Foreign government bill, Foreign government bond, Foreign inflation-linked bond, Emerging-market local-currency debt, Emerging-market hard-currency debt, Agency debt, Supranational bond, Municipal bond (domestic and foreign), Sovereign sukuk, Corporate bond (domestic and foreign), Investment-grade bond, High-yield bond, Eurobond, Foreign-market bond (Yankee, Samurai, Bulldog …), Corporate sukuk, Floating-rate note, Zero-coupon bond, Callable bond, Puttable bond, Convertible bond, Exchangeable bond, Perpetual bond, Subordinated debt, Contingent convertible bond (CoCo), Covered bond, Mortgage-backed security, Residential MBS, Commercial MBS, Agency MBS, Non-agency MBS, Mortgage specified pool, Asset-backed security, Collateralised mortgage obligation (CMO), Collateralised loan obligation (CLO), Collateralised debt obligation (CDO), Credit-linked note, Structured note, Catastrophe bond, Syndicated loan, Leveraged loan, Private credit, Distressed debt, Loan participation |
| Money Market and Deposits | US Based, Foreign Based | Commercial paper, Asset-backed commercial paper, Bankers' acceptance, Money-market fund, Certificate of deposit, Bank deposit, Term deposit, Cash borrowing and lending (USD or foreign currency), Secured loan, Unsecured loan, Margin loan, Securities-backed loan, Revolving credit facility, Repo, Reverse repo, Overnight repo, Term repo, Open repo, Bilateral repo, Tri-party repo, General-collateral repo, Special-collateral repo, Buy/sell-back, Sell/buy-back, Securities borrowing, Securities lending, Stock loan, Bond loan, Securities collateral swap |
| FX and Currencies | US Based, Foreign Based | USD and foreign currency balances, Spot FX / currency pair |
| Commodities | US Based, Foreign Based | Physical / spot commodity, Precious metal, Industrial metal, Crude oil, Refined petroleum product, Natural gas, LNG, Coal, Electricity, Agricultural commodity, Livestock, Emissions allowance, Carbon credit, Renewable energy certificate |
| Crypto and Digital Assets | US Based, Foreign Based | Cryptocurrency, Stablecoin, Tokenized asset |
| Alternatives and Other | US Based, Foreign Based | Private equity interest, Venture capital interest, Infrastructure investment, Direct real estate, Insurance-linked security |
| Options | US Derivatives, Foreign Derivatives | Listed option, Equity call / put, ETF option, Index option, Option on a future, OTC option, Bond option, Interest-rate option, FX option, Commodity option, Cryptocurrency option, Swaption, Interest-rate cap, Interest-rate floor, Interest-rate collar, Digital option, Barrier option, Asian option, Lookback option, Basket option, Spread option, Quanto option, Compound option |
| Futures | US Derivatives, Foreign Derivatives | Equity (single-stock) future, Equity-index future, Government-bond future, Treasury future, Short-term interest-rate future, FX future, Commodity future, Volatility future, Dividend future, Cryptocurrency future, Perpetual future |
| Forwards | US Derivatives, Foreign Derivatives | Equity forward, Bond forward, FX forward, Non-deliverable forward, Commodity forward, Forward-rate agreement, FX swap, TBA mortgage contract |
| Swaps | US Derivatives, Foreign Derivatives | Interest-rate swap, Overnight-index swap, Interest-rate basis swap, Cross-currency swap, Cross-currency basis swap, Non-deliverable swap, Zero-coupon inflation swap, Year-on-year inflation swap, Constant-maturity swap, Constant-maturity spread swap, Forward-starting swap, Amortizing swap, Accreting swap, Callable swap, Puttable swap, Quanto swap, Asset swap, Equity swap, Equity-index swap, Equity-basket swap, Equity total-return swap, Bond total-return swap, Loan total-return swap, Index total-return swap, Commodity swap, Commodity basis swap, Commodity-index swap, Energy swap, Electricity swap, Freight swap, Dividend swap, Variance swap, Volatility swap, Correlation swap, Dispersion swap |
| Credit Derivatives | US Derivatives, Foreign Derivatives | Single-name credit-default swap, Sovereign credit-default swap, Credit-index swap, Credit-basket swap, Credit-index tranche swap, Loan credit-default swap, Asset-backed credit-default swap, Recovery swap, Credit-default swaption, Credit-spread forward, Credit-spread option |
| Structured and Other Derivatives | US Derivatives, Foreign Derivatives | Freight contract, Weather derivative |
