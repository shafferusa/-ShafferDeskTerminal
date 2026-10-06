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
| Private equity interest | Manually valued holding | Manual inputs | Valued by hand | Capital calls, distributions and valuations are entered by hand. |
| Venture capital interest | Manually valued holding | Manual inputs | Valued by hand | Capital calls, distributions and valuations are entered by hand. |
| Hedge fund interest | Manually valued holding | Manual inputs | Valued by hand | Subscriptions, redemptions and NAV are entered by hand. |
| Infrastructure investment | Manually valued holding | Manual inputs | Valued by hand | Cash flows and valuations are entered by hand. |
| Direct real estate | Manually valued holding | Manual inputs | Valued by hand | Cash flows and valuations are entered by hand. |

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
| TBA mortgage contract | Forward / FRA | Partly manual | Model mark | Booked as a forward on a pool; pool allocation and delivery are recorded by hand. |
| Mortgage specified pool | Debt security | Partly manual | Market quote | Principal paydowns (pool factor) are recorded by hand. |
| Asset-backed security | Debt security | Partly manual | Market quote | Principal paydowns are recorded by hand. |
| Collateralised mortgage obligation (CMO) | Debt security | Partly manual | Market quote | Tranche paydowns are recorded by hand. |
| Collateralised loan obligation (CLO) | Debt security | Partly manual | Market quote | Tranche paydowns are recorded by hand; floating coupons need fixings. |
| Collateralised debt obligation (CDO) | Debt security | Partly manual | Market quote | Tranche paydowns and losses are recorded by hand. |
| Credit-linked note | Debt security | Partly manual | Market quote | Credit events are recorded by hand. |
| Structured note | Debt security | Partly manual | Market quote | Coupons follow the stated schedule; payoff-linked amounts are recorded by hand. |

## Insurance-linked

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Catastrophe bond | Debt security | Partly manual | Market quote | Trigger events and principal losses are recorded by hand. |
| Insurance-linked security | Manually valued holding | Manual inputs | Valued by hand | Cash flows and valuations are entered by hand. |
| Weather derivative | Manually valued holding | Manual inputs | Valued by hand | Settlement amount and valuation are entered by hand. |

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
| Syndicated loan | Debt security | Partly manual | Market quote | Held at a % of par price with floating coupons (fixings needed); amortisation and prepayments are recorded by hand. |
| Leveraged loan | Debt security | Partly manual | Market quote | Amortisation and prepayments are recorded by hand. |
| Revolving credit facility | Cash loan / deposit | Partly manual | No price needed | Each drawing is a loan; commitment fees are recorded by hand. |
| Private credit | Debt security | Partly manual | Market quote | Valuation is manual; amortisation and prepayments are recorded by hand. |
| Distressed debt | Debt security | Partly manual | Market quote | Coupons can be suspended by hand; restructurings are recorded by hand. |
| Loan participation | Debt security | Partly manual | Market quote | Amortisation and prepayments are recorded by hand. |

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
| Bond loan | Securities loan | Full lifecycle | No price needed |  |
| Short sale | Equity-like security | Full lifecycle | Market quote | Always paired with a securities borrow; proceeds are held as restricted collateral. |
| Repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Reverse repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Overnight repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Term repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Open repo | Repo / reverse repo | Full lifecycle | No price needed | Runs until terminated; the rate can be reset. |
| Bilateral repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Tri-party repo | Repo / reverse repo | Full lifecycle | No price needed | The tri-party agent is recorded as an attribute; collateral substitution is not automated. |
| General-collateral repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Special-collateral repo | Repo / reverse repo | Full lifecycle | No price needed |  |
| Buy/sell-back | Repo / reverse repo | Full lifecycle | No price needed | Accounted with the same cash flows as a reverse repo. |
| Sell/buy-back | Repo / reverse repo | Full lifecycle | No price needed | Accounted with the same cash flows as a repo. |
| Securities collateral swap | Manually valued holding | Manual inputs | Valued by hand | Book the two securities loans separately, or hold as a manual arrangement. |

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
| Freight contract | Manually valued holding | Manual inputs | Valued by hand | Cash flows and valuations are entered by hand. |

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
| Commodity future | Future | Full lifecycle | Market quote | Closed out in cash at final settlement; physical delivery is not simulated. |
| Volatility future | Future | Full lifecycle | Market quote |  |
| Dividend future | Future | Full lifecycle | Market quote |  |
| Cryptocurrency future | Future | Full lifecycle | Market quote |  |
| Perpetual future | Future | Partly manual | Market quote | Funding payments are recorded by hand; there is no expiry. |

## Forwards

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Equity forward | Forward / FRA | Full lifecycle | Model mark | Cash-settled against a supplied or entered fixing, or physically delivered into the underlying position. |
| Bond forward | Forward / FRA | Full lifecycle | Model mark |  |
| FX forward | Forward / FRA | Full lifecycle | Model mark | Deliverable: the two currency amounts are exchanged on the value date. |
| Non-deliverable forward | Forward / FRA | Full lifecycle | Model mark | Cash-settled against the fixing on the fixing date. |
| Commodity forward | Forward / FRA | Full lifecycle | Model mark |  |
| Forward-rate agreement | Forward / FRA | Full lifecycle | Model mark | Settled at the start of the period, discounted at the fixing. |
| FX swap | Forward / FRA | Full lifecycle | Model mark | Booked as a near leg and a far leg in one package. |

## Credit derivatives

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Credit-spread forward | Manually valued holding | Manual inputs | Valued by hand | Settlement amount and valuation are entered by hand. |
| Credit-spread option | Manually valued holding | Manual inputs | Valued by hand | Settlement amount and valuation are entered by hand. |
| Single-name credit-default swap | Credit default swap | Full lifecycle | Model mark | Premiums pay quarterly; a credit event is triggered by hand with the recovery rate. |
| Sovereign credit-default swap | Credit default swap | Full lifecycle | Model mark |  |
| Credit-index swap | Credit default swap | Full lifecycle | Model mark | Constituent defaults reduce the notional by hand (index factor). |
| Credit-basket swap | Credit default swap | Partly manual | Model mark | Basket defaults are recorded by hand. |
| Credit-index tranche swap | Credit default swap | Partly manual | Model mark | Tranche losses are recorded by hand. |
| Loan credit-default swap | Credit default swap | Partly manual | Model mark | Cancellation on refinancing is recorded by hand. |
| Asset-backed credit-default swap | Credit default swap | Partly manual | Model mark | Pay-as-you-go amounts are recorded by hand. |
| Recovery swap | Manually valued holding | Manual inputs | Valued by hand | Settlement amount and valuation are entered by hand. |

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
| Interest-rate option | OTC option | Partly manual | Model mark | Booked on a rate underlying with cash settlement against a fixing; convexity conventions are not modelled. |
| FX option | OTC option | Full lifecycle | Model mark |  |
| Commodity option | OTC option | Full lifecycle | Model mark |  |
| Cryptocurrency option | OTC option | Full lifecycle | Model mark |  |
| Swaption | OTC option | Partly manual | Model mark | Exercise is recorded by hand: cash-settle the stated amount, or book the underlying swap. |
| Credit-default swaption | OTC option | Partly manual | Model mark | Exercise is recorded by hand. |
| Interest-rate cap | Swap | Full lifecycle | Model mark | A capped floating leg: each caplet pays against its fixing. |
| Interest-rate floor | Swap | Full lifecycle | Model mark | A floored floating leg: each floorlet pays against its fixing. |
| Interest-rate collar | Swap | Full lifecycle | Model mark | A cap leg and a floor leg in one contract. |
| Digital option | OTC option | Full lifecycle | Model mark | Cash-or-nothing payout against the expiry fixing. |
| Barrier option | OTC option | Partly manual | Model mark | Barrier events are recorded by hand (or checked against supplied closes); intraday monitoring is not simulated. |
| Asian option | OTC option | Partly manual | Model mark | The averaged settlement amount is entered by hand at expiry. |
| Lookback option | OTC option | Partly manual | Model mark | The settlement amount is entered by hand at expiry. |
| Basket option | OTC option | Partly manual | Model mark | The settlement amount is entered by hand at expiry. |
| Spread option | OTC option | Partly manual | Model mark | The settlement amount is entered by hand at expiry. |
| Quanto option | OTC option | Partly manual | Model mark | The settlement amount is entered by hand at expiry. |
| Compound option | OTC option | Partly manual | Model mark | Exercise into the underlying option is recorded by hand. |

## Swaps

| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |
|---|---|---|---|---|
| Interest-rate swap | Swap | Full lifecycle | Model mark | Fixed and floating legs pay on their schedules; floating payments need their fixings. |
| Overnight-index swap | Swap | Full lifecycle | Model mark | Compounds the supplied overnight fixings; a missing fixing blocks the payment visibly. |
| Interest-rate basis swap | Swap | Full lifecycle | Model mark |  |
| Cross-currency swap | Swap | Full lifecycle | Model mark | Notional exchanges at start and end are booked in each currency. |
| Cross-currency basis swap | Swap | Full lifecycle | Model mark |  |
| Non-deliverable swap | Swap | Partly manual | Model mark | Legs are computed in their own currencies; the net USD settlement conversion is recorded by hand. |
| Zero-coupon inflation swap | Swap | Full lifecycle | Model mark | Needs the index fixings at start and end. |
| Year-on-year inflation swap | Swap | Full lifecycle | Model mark | Needs an index fixing for each period. |
| Constant-maturity swap | Swap | Full lifecycle | Model mark | The CMS rate is supplied as the fixing; no convexity adjustment is applied by the Terminal. |
| Constant-maturity spread swap | Swap | Partly manual | Model mark | The spread fixing is supplied as a single rate code. |
| Forward-starting swap | Swap | Full lifecycle | Model mark |  |
| Amortizing swap | Swap | Full lifecycle | Model mark | Uses the notional schedule in the contract terms. |
| Accreting swap | Swap | Full lifecycle | Model mark | Uses the notional schedule in the contract terms. |
| Callable swap | Swap | Partly manual | Model mark | Early termination is recorded by hand as an unwind at a stated amount. |
| Puttable swap | Swap | Partly manual | Model mark | Early termination is recorded by hand as an unwind at a stated amount. |
| Quanto swap | Swap | Partly manual | Model mark | Legs pay in the settlement currency on the stated notional; quanto adjustments are not modelled. |
| Asset swap | Swap | Partly manual | Model mark | Book the bond and the swap as two legs of one package. |
| Equity swap | Swap | Full lifecycle | Model mark | Return leg against a financing leg; needs the underlying fixing at each reset. |
| Equity-index swap | Swap | Full lifecycle | Model mark |  |
| Equity-basket swap | Swap | Partly manual | Model mark | The basket level is supplied as a single fixing. |
| Equity total-return swap | Swap | Full lifecycle | Model mark | Dividend pass-through is recorded from corporate actions on the underlying or by hand. |
| Bond total-return swap | Swap | Full lifecycle | Model mark | Coupon pass-through is recorded by hand. |
| Loan total-return swap | Swap | Partly manual | Model mark | Interest pass-through and paydowns are recorded by hand. |
| Index total-return swap | Swap | Full lifecycle | Model mark |  |
| Commodity swap | Swap | Full lifecycle | Model mark | Fixed price against a floating price fixing per period (single fixing; averaging is entered as the fixing). |
| Commodity basis swap | Swap | Full lifecycle | Model mark |  |
| Commodity-index swap | Swap | Full lifecycle | Model mark |  |
| Energy swap | Swap | Full lifecycle | Model mark | Averaged prices are entered as the period fixing. |
| Electricity swap | Swap | Full lifecycle | Model mark | Averaged prices are entered as the period fixing. |
| Freight swap | Swap | Full lifecycle | Model mark | Averaged route assessments are entered as the period fixing. |
| Dividend swap | Swap | Partly manual | Model mark | Realised dividends are entered as the period fixing. |
| Variance swap | Manually valued holding | Manual inputs | Valued by hand | Realised variance and the settlement amount are entered by hand. |
| Volatility swap | Manually valued holding | Manual inputs | Valued by hand | Realised volatility and the settlement amount are entered by hand. |
| Correlation swap | Manually valued holding | Manual inputs | Valued by hand | Settlement amount and valuation are entered by hand. |
| Dispersion swap | Manually valued holding | Manual inputs | Valued by hand | Settlement amount and valuation are entered by hand. |

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

Payment calendar by currency: USD uses USD, EUR uses TARGET, GBP uses UK, JPY uses JP, CAD uses CA.

Any other market or currency has no calendar and falls back to weekends only (the WEEKEND calendar).
The fallback is never silent: the instrument states it, and every trade preview that works out a
date on it carries a warning. Rule-based calendars cannot know one-off closures; those, and local
holidays for a market on the fallback, are entered by hand under **Settings > Market calendars**.
