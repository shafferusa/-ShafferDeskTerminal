# Implementation coverage

Generated from `server/core/catalog.js` by `npm run coverage`. The same list, with filters, is on the
Terminal's **Instruments > Coverage** tab.

Listing a product here is not a claim that market data exists for it. Coverage describes what the
paper engine does with an instrument once it is registered and priced. Prices, option chains,
borrow availability, repo rates and model marks come from Shaffer MarketData and Analytics Lab;
until those are connected every instrument is registered and priced by hand (always labelled as
manual), or exercised in the isolated demo environment.

| Level | Products | What it means |
|---|---:|---|
| Full lifecycle | 124 | Orders, fills, settlement, accounting and scheduled lifecycle events are simulated automatically from the contract terms. |
| Partly manual | 65 | Trading, settlement and accounting are automatic. Some lifecycle events or contract features are recorded by hand, as the note for each product says. |
| Manual inputs | 16 | The instrument can be held and accounted for, but its valuation and cash flows are entered by hand. |
| Not implemented | 0 | Listed for completeness; cannot be traded. |
| **Total** | **205** | |

## Equities

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Common stock (domestic and foreign) | Equity-like security | Full lifecycle | Cash dividends and splits are applied from supplied or manually recorded corporate actions. Mergers, spin-offs and tenders are recorded by hand. |
| Preferred stock | Equity-like security | Full lifecycle | Preferred dividends are booked as dividends from recorded corporate actions. |
| American depositary receipt (ADR) | Equity-like security | Full lifecycle | Listed in the US; issuer domicile stored separately. Depositary fees are recorded by hand. |
| Global depositary receipt (GDR) | Equity-like security | Full lifecycle | Depositary fees are recorded by hand. |
| Exchange-traded fund (ETF) | Equity-like security | Full lifecycle |  |
| Exchange-traded note (ETN) | Equity-like security | Full lifecycle | Issuer credit events are recorded by hand. |
| REIT | Equity-like security | Full lifecycle |  |
| Warrant | Equity-like security | Partly manual | Exercise and expiry are recorded by hand. |
| Subscription right | Equity-like security | Partly manual | Exercise and lapse are recorded by hand. |
| Convertible security (preferred) | Equity-like security | Partly manual | Conversion is recorded by hand. |

## Funds

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Mutual fund | Fund (NAV-priced) | Full lifecycle | Trades at the next supplied NAV; distributions from recorded corporate actions. |
| Closed-end fund | Equity-like security | Full lifecycle |  |

## Private markets

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Private equity interest | Manually valued holding | Manual inputs | Capital calls, distributions and valuations are entered by hand. |
| Venture capital interest | Manually valued holding | Manual inputs | Capital calls, distributions and valuations are entered by hand. |
| Hedge fund interest | Manually valued holding | Manual inputs | Subscriptions, redemptions and NAV are entered by hand. |
| Infrastructure investment | Manually valued holding | Manual inputs | Cash flows and valuations are entered by hand. |
| Direct real estate | Manually valued holding | Manual inputs | Cash flows and valuations are entered by hand. |

## Government debt

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| US Treasury bill | Debt security | Full lifecycle | Discount instrument; redeems at par. |
| US Treasury note | Debt security | Full lifecycle |  |
| US Treasury bond | Debt security | Full lifecycle |  |
| US TIPS | Debt security | Partly manual | Inflation accretion of principal is not automated; record index-ratio adjustments by hand. |
| US Treasury STRIPS | Debt security | Full lifecycle | Zero-coupon. |
| Foreign government bill | Debt security | Full lifecycle |  |
| Foreign government bond | Debt security | Full lifecycle |  |
| Foreign inflation-linked bond | Debt security | Partly manual | Inflation accretion of principal is recorded by hand. |
| Emerging-market local-currency debt | Debt security | Full lifecycle |  |
| Emerging-market hard-currency debt | Debt security | Full lifecycle |  |
| Agency debt | Debt security | Full lifecycle |  |
| Supranational bond | Debt security | Full lifecycle |  |
| Municipal bond (domestic and foreign) | Debt security | Full lifecycle | Tax treatment is not modelled. |
| Sovereign sukuk | Debt security | Full lifecycle | Periodic distributions are booked on the coupon schedule. |

## Corporate debt

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Corporate bond (domestic and foreign) | Debt security | Full lifecycle |  |
| Investment-grade bond | Debt security | Full lifecycle |  |
| High-yield bond | Debt security | Full lifecycle | Defaults and restructurings are recorded by hand. |
| Eurobond | Debt security | Full lifecycle |  |
| Foreign-market bond (Yankee, Samurai, Bulldog …) | Debt security | Full lifecycle |  |
| Corporate sukuk | Debt security | Full lifecycle | Periodic distributions are booked on the coupon schedule. |
| Floating-rate note | Debt security | Full lifecycle | Each coupon needs its reference-rate fixing (supplied or entered); a missing fixing blocks that coupon visibly. |
| Zero-coupon bond | Debt security | Full lifecycle |  |
| Callable bond | Debt security | Partly manual | Issuer calls are recorded by hand as an early redemption. |
| Puttable bond | Debt security | Partly manual | Exercising the put is recorded by hand as an early redemption. |
| Convertible bond | Debt security | Partly manual | Conversion into shares is recorded by hand. |
| Exchangeable bond | Debt security | Partly manual | Exchange into shares is recorded by hand. |
| Perpetual bond | Debt security | Full lifecycle | No maturity; coupons continue until sold or called (call recorded by hand). |
| Subordinated debt | Debt security | Full lifecycle |  |
| Contingent convertible bond (CoCo) | Debt security | Partly manual | Trigger events, write-downs and coupon cancellations are recorded by hand. |
| Covered bond | Debt security | Full lifecycle |  |

## Securitised debt

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Mortgage-backed security | Debt security | Partly manual | Principal paydowns (pool factor) are recorded by hand; coupons follow the current face. |
| Residential MBS | Debt security | Partly manual | Principal paydowns (pool factor) are recorded by hand. |
| Commercial MBS | Debt security | Partly manual | Principal paydowns are recorded by hand. |
| Agency MBS | Debt security | Partly manual | Principal paydowns (pool factor) are recorded by hand. |
| Non-agency MBS | Debt security | Partly manual | Principal paydowns and losses are recorded by hand. |
| TBA mortgage contract | Forward / FRA | Partly manual | Booked as a forward on a pool; pool allocation and delivery are recorded by hand. |
| Mortgage specified pool | Debt security | Partly manual | Principal paydowns (pool factor) are recorded by hand. |
| Asset-backed security | Debt security | Partly manual | Principal paydowns are recorded by hand. |
| Collateralised mortgage obligation (CMO) | Debt security | Partly manual | Tranche paydowns are recorded by hand. |
| Collateralised loan obligation (CLO) | Debt security | Partly manual | Tranche paydowns are recorded by hand; floating coupons need fixings. |
| Collateralised debt obligation (CDO) | Debt security | Partly manual | Tranche paydowns and losses are recorded by hand. |
| Credit-linked note | Debt security | Partly manual | Credit events are recorded by hand. |
| Structured note | Debt security | Partly manual | Coupons follow the stated schedule; payoff-linked amounts are recorded by hand. |

## Insurance-linked

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Catastrophe bond | Debt security | Partly manual | Trigger events and principal losses are recorded by hand. |
| Insurance-linked security | Manually valued holding | Manual inputs | Cash flows and valuations are entered by hand. |
| Weather derivative | Manually valued holding | Manual inputs | Settlement amount and valuation are entered by hand. |

## Money market

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Commercial paper | Debt security | Full lifecycle | Discount instrument; redeems at par. |
| Asset-backed commercial paper | Debt security | Full lifecycle | Discount instrument; redeems at par. |
| Certificate of deposit | Cash loan / deposit | Full lifecycle | Booked as cash lent to the issuing bank at the stated rate. |
| Bankers' acceptance | Debt security | Full lifecycle | Discount instrument; redeems at par. |
| Money-market fund | Fund (NAV-priced) | Full lifecycle | Distributions from recorded corporate actions. |
| Bank deposit | Cash loan / deposit | Full lifecycle | Open-ended cash lent at a stated rate. |
| Term deposit | Cash loan / deposit | Full lifecycle |  |

## Loans and credit

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Syndicated loan | Debt security | Partly manual | Held at a % of par price with floating coupons (fixings needed); amortisation and prepayments are recorded by hand. |
| Leveraged loan | Debt security | Partly manual | Amortisation and prepayments are recorded by hand. |
| Revolving credit facility | Cash loan / deposit | Partly manual | Each drawing is a loan; commitment fees are recorded by hand. |
| Private credit | Debt security | Partly manual | Valuation is manual; amortisation and prepayments are recorded by hand. |
| Distressed debt | Debt security | Partly manual | Coupons can be suspended by hand; restructurings are recorded by hand. |
| Loan participation | Debt security | Partly manual | Amortisation and prepayments are recorded by hand. |

## Cash and FX

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| USD and foreign currency balances | Currency balance | Full lifecycle | Held as ledger cash by currency in Treasury and each Account. |
| Spot FX / currency pair | Spot FX | Full lifecycle | A conversion between two currency balances; never implied by a transfer. |

## Funding

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Cash borrowing and lending (USD or foreign currency) | Cash loan / deposit | Full lifecycle |  |
| Secured loan | Cash loan / deposit | Full lifecycle | Pledges named positions as collateral. |
| Unsecured loan | Cash loan / deposit | Full lifecycle |  |
| Margin loan | Cash loan / deposit | Full lifecycle | Open-ended, floating or fixed rate. |
| Securities-backed loan | Cash loan / deposit | Full lifecycle | Pledges named positions as collateral. |

## Securities finance

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Securities borrowing | Securities loan | Full lifecycle | Borrow availability and fee come from supplied data or a stated assumption; recalls are triggered by hand or by supplied data. |
| Securities lending | Securities loan | Full lifecycle |  |
| Stock loan | Securities loan | Full lifecycle |  |
| Bond loan | Securities loan | Full lifecycle |  |
| Short sale | Equity-like security | Full lifecycle | Always paired with a securities borrow; proceeds are held as restricted collateral. |
| Repo | Repo / reverse repo | Full lifecycle |  |
| Reverse repo | Repo / reverse repo | Full lifecycle |  |
| Overnight repo | Repo / reverse repo | Full lifecycle |  |
| Term repo | Repo / reverse repo | Full lifecycle |  |
| Open repo | Repo / reverse repo | Full lifecycle | Runs until terminated; the rate can be reset. |
| Bilateral repo | Repo / reverse repo | Full lifecycle |  |
| Tri-party repo | Repo / reverse repo | Full lifecycle | The tri-party agent is recorded as an attribute; collateral substitution is not automated. |
| General-collateral repo | Repo / reverse repo | Full lifecycle |  |
| Special-collateral repo | Repo / reverse repo | Full lifecycle |  |
| Buy/sell-back | Repo / reverse repo | Full lifecycle | Accounted with the same cash flows as a reverse repo. |
| Sell/buy-back | Repo / reverse repo | Full lifecycle | Accounted with the same cash flows as a repo. |
| Securities collateral swap | Manually valued holding | Manual inputs | Book the two securities loans separately, or hold as a manual arrangement. |

## Commodities

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Physical / spot commodity | Spot asset | Partly manual | Storage, delivery and insurance costs are recorded by hand. |
| Precious metal | Spot asset | Partly manual | Storage costs are recorded by hand. |
| Industrial metal | Spot asset | Partly manual | Storage costs are recorded by hand. |
| Crude oil | Spot asset | Partly manual | Storage and delivery are recorded by hand. |
| Refined petroleum product | Spot asset | Partly manual | Storage and delivery are recorded by hand. |
| Natural gas | Spot asset | Partly manual | Storage and delivery are recorded by hand. |
| LNG | Spot asset | Partly manual | Cargo logistics are recorded by hand. |
| Coal | Spot asset | Partly manual | Storage and delivery are recorded by hand. |
| Electricity | Spot asset | Partly manual | Cannot be stored; delivery periods are recorded by hand. |
| Agricultural commodity | Spot asset | Partly manual | Storage and delivery are recorded by hand. |
| Livestock | Spot asset | Partly manual | Delivery is recorded by hand. |
| Freight contract | Manually valued holding | Manual inputs | Cash flows and valuations are entered by hand. |

## Environmental

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Emissions allowance | Spot asset | Full lifecycle | Surrender/retirement is recorded as a sale at zero by hand. |
| Carbon credit | Spot asset | Full lifecycle | Retirement is recorded by hand. |
| Renewable energy certificate | Spot asset | Full lifecycle | Retirement is recorded by hand. |

## Digital assets

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Cryptocurrency | Digital asset | Full lifecycle | Forks, airdrops and staking rewards are recorded by hand. |
| Stablecoin | Digital asset | Full lifecycle |  |
| Tokenized asset | Digital asset | Full lifecycle | Income on the underlying is recorded by hand. |

## Futures

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Equity (single-stock) future | Future | Full lifecycle | Daily variation margin; closed out in cash at final settlement (physical delivery is not simulated). |
| Equity-index future | Future | Full lifecycle | Daily variation margin; cash settlement. |
| Government-bond future | Future | Full lifecycle | Closed out in cash at final settlement; delivery of the cheapest-to-deliver bond is not simulated. |
| Treasury future | Future | Full lifecycle | Closed out in cash at final settlement; delivery is not simulated. |
| Short-term interest-rate future | Future | Full lifecycle |  |
| FX future | Future | Full lifecycle | Closed out in cash at final settlement; currency delivery is not simulated. |
| Commodity future | Future | Full lifecycle | Closed out in cash at final settlement; physical delivery is not simulated. |
| Volatility future | Future | Full lifecycle |  |
| Dividend future | Future | Full lifecycle |  |
| Cryptocurrency future | Future | Full lifecycle |  |
| Perpetual future | Future | Partly manual | Funding payments are recorded by hand; there is no expiry. |

## Forwards

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Equity forward | Forward / FRA | Full lifecycle | Cash-settled against a supplied or entered fixing, or physically delivered into the underlying position. |
| Bond forward | Forward / FRA | Full lifecycle |  |
| FX forward | Forward / FRA | Full lifecycle | Deliverable: the two currency amounts are exchanged on the value date. |
| Non-deliverable forward | Forward / FRA | Full lifecycle | Cash-settled against the fixing on the fixing date. |
| Commodity forward | Forward / FRA | Full lifecycle |  |
| Forward-rate agreement | Forward / FRA | Full lifecycle | Settled at the start of the period, discounted at the fixing. |
| FX swap | Forward / FRA | Full lifecycle | Booked as a near leg and a far leg in one package. |

## Credit derivatives

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Credit-spread forward | Manually valued holding | Manual inputs | Settlement amount and valuation are entered by hand. |
| Credit-spread option | Manually valued holding | Manual inputs | Settlement amount and valuation are entered by hand. |
| Single-name credit-default swap | Credit default swap | Full lifecycle | Premiums pay quarterly; a credit event is triggered by hand with the recovery rate. |
| Sovereign credit-default swap | Credit default swap | Full lifecycle |  |
| Credit-index swap | Credit default swap | Full lifecycle | Constituent defaults reduce the notional by hand (index factor). |
| Credit-basket swap | Credit default swap | Partly manual | Basket defaults are recorded by hand. |
| Credit-index tranche swap | Credit default swap | Partly manual | Tranche losses are recorded by hand. |
| Loan credit-default swap | Credit default swap | Partly manual | Cancellation on refinancing is recorded by hand. |
| Asset-backed credit-default swap | Credit default swap | Partly manual | Pay-as-you-go amounts are recorded by hand. |
| Recovery swap | Manually valued holding | Manual inputs | Settlement amount and valuation are entered by hand. |

## Options

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Listed option | Listed option | Full lifecycle | Expiration, exercise and assignment are automated from the contract deliverable. |
| Equity call / put | Listed option | Full lifecycle |  |
| ETF option | Listed option | Full lifecycle |  |
| Index option | Listed option | Full lifecycle | Cash-settled; AM-settled series need their settlement value as the fixing. |
| Option on a future | Listed option | Full lifecycle | Exercise delivers the futures position at the strike. Contract data must be supplied or entered. |
| OTC option | OTC option | Full lifecycle | Vanilla calls and puts, cash or physical settlement. |
| Bond option | OTC option | Full lifecycle |  |
| Interest-rate option | OTC option | Partly manual | Booked on a rate underlying with cash settlement against a fixing; convexity conventions are not modelled. |
| FX option | OTC option | Full lifecycle |  |
| Commodity option | OTC option | Full lifecycle |  |
| Cryptocurrency option | OTC option | Full lifecycle |  |
| Swaption | OTC option | Partly manual | Exercise is recorded by hand: cash-settle the stated amount, or book the underlying swap. |
| Credit-default swaption | OTC option | Partly manual | Exercise is recorded by hand. |
| Interest-rate cap | Swap | Full lifecycle | A capped floating leg: each caplet pays against its fixing. |
| Interest-rate floor | Swap | Full lifecycle | A floored floating leg: each floorlet pays against its fixing. |
| Interest-rate collar | Swap | Full lifecycle | A cap leg and a floor leg in one contract. |
| Digital option | OTC option | Full lifecycle | Cash-or-nothing payout against the expiry fixing. |
| Barrier option | OTC option | Partly manual | Barrier events are recorded by hand (or checked against supplied closes); intraday monitoring is not simulated. |
| Asian option | OTC option | Partly manual | The averaged settlement amount is entered by hand at expiry. |
| Lookback option | OTC option | Partly manual | The settlement amount is entered by hand at expiry. |
| Basket option | OTC option | Partly manual | The settlement amount is entered by hand at expiry. |
| Spread option | OTC option | Partly manual | The settlement amount is entered by hand at expiry. |
| Quanto option | OTC option | Partly manual | The settlement amount is entered by hand at expiry. |
| Compound option | OTC option | Partly manual | Exercise into the underlying option is recorded by hand. |

## Swaps

| Product | Engine family | Level | What is simulated, and what is not |
|---|---|---|---|
| Interest-rate swap | Swap | Full lifecycle | Fixed and floating legs pay on their schedules; floating payments need their fixings. |
| Overnight-index swap | Swap | Full lifecycle | Compounds the supplied overnight fixings; a missing fixing blocks the payment visibly. |
| Interest-rate basis swap | Swap | Full lifecycle |  |
| Cross-currency swap | Swap | Full lifecycle | Notional exchanges at start and end are booked in each currency. |
| Cross-currency basis swap | Swap | Full lifecycle |  |
| Non-deliverable swap | Swap | Partly manual | Legs are computed in their own currencies; the net USD settlement conversion is recorded by hand. |
| Zero-coupon inflation swap | Swap | Full lifecycle | Needs the index fixings at start and end. |
| Year-on-year inflation swap | Swap | Full lifecycle | Needs an index fixing for each period. |
| Constant-maturity swap | Swap | Full lifecycle | The CMS rate is supplied as the fixing; no convexity adjustment is applied by the Terminal. |
| Constant-maturity spread swap | Swap | Partly manual | The spread fixing is supplied as a single rate code. |
| Forward-starting swap | Swap | Full lifecycle |  |
| Amortizing swap | Swap | Full lifecycle | Uses the notional schedule in the contract terms. |
| Accreting swap | Swap | Full lifecycle | Uses the notional schedule in the contract terms. |
| Callable swap | Swap | Partly manual | Early termination is recorded by hand as an unwind at a stated amount. |
| Puttable swap | Swap | Partly manual | Early termination is recorded by hand as an unwind at a stated amount. |
| Quanto swap | Swap | Partly manual | Legs pay in the settlement currency on the stated notional; quanto adjustments are not modelled. |
| Asset swap | Swap | Partly manual | Book the bond and the swap as two legs of one package. |
| Equity swap | Swap | Full lifecycle | Return leg against a financing leg; needs the underlying fixing at each reset. |
| Equity-index swap | Swap | Full lifecycle |  |
| Equity-basket swap | Swap | Partly manual | The basket level is supplied as a single fixing. |
| Equity total-return swap | Swap | Full lifecycle | Dividend pass-through is recorded from corporate actions on the underlying or by hand. |
| Bond total-return swap | Swap | Full lifecycle | Coupon pass-through is recorded by hand. |
| Loan total-return swap | Swap | Partly manual | Interest pass-through and paydowns are recorded by hand. |
| Index total-return swap | Swap | Full lifecycle |  |
| Commodity swap | Swap | Full lifecycle | Fixed price against a floating price fixing per period (single fixing; averaging is entered as the fixing). |
| Commodity basis swap | Swap | Full lifecycle |  |
| Commodity-index swap | Swap | Full lifecycle |  |
| Energy swap | Swap | Full lifecycle | Averaged prices are entered as the period fixing. |
| Electricity swap | Swap | Full lifecycle | Averaged prices are entered as the period fixing. |
| Freight swap | Swap | Full lifecycle | Averaged route assessments are entered as the period fixing. |
| Dividend swap | Swap | Partly manual | Realised dividends are entered as the period fixing. |
| Variance swap | Manually valued holding | Manual inputs | Realised variance and the settlement amount are entered by hand. |
| Volatility swap | Manually valued holding | Manual inputs | Realised volatility and the settlement amount are entered by hand. |
| Correlation swap | Manually valued holding | Manual inputs | Settlement amount and valuation are entered by hand. |
| Dispersion swap | Manually valued holding | Manual inputs | Settlement amount and valuation are entered by hand. |

