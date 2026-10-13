// OTC options (engine family "otcoption"), the products the catalog marks as fully supported:
// otc_option, bond_option, fx_option, commodity_option, crypto_option, digital_option. One scenario per
// product, each on its own fictional contract registered as exactly that product, with the terms a
// real contract of it has (underlying, quotation unit, multiplier, strike, expiry, style, settlement,
// counterparty and the mandatory collateral basis).
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The
// arithmetic is in the comment beside it. Nothing here is copied from what the Terminal prints.
//
// The Terminal's rules these scenarios rely on, restated so the arithmetic can be followed:
//   - Quantity is in units of the underlying in the option's own quotation (shares, barrels, base
//     currency, coins; face amount for a bond option). The premium is quoted per unit (per 100 of face
//     for a bond option, whose multiplier is therefore 0.01). Premium cash = quantity x premium x
//     multiplier, in the trading currency, which is the premium currency.
//   - There is no executable quote for an OTC contract: the premium agreed with the dealer is stated
//     on the ticket (stated fill price), and a termination is at a stated amount per unit in the preview.
//   - The mark is never computed by the Terminal (valuation models belong to Analytics Lab): it is
//     entered by hand (Manual entry) or supplied by a labelled fixture. Without one the position is
//     unpriced and every total that rests on it is provisional.
//   - Commission is the Book's fee schedule for OTC options: an amount per unit of quantity.
//   - The premium settles on the stated settlement lag (Book setting settlement.otcoption) on the
//     contract's calendar.
//   - Collateral follows the basis the contract states, and nothing else. Only the writer secures an
//     obligation: the independent amount of a written option is a share of quantity x strike x
//     multiplier, posted in cash when it opens and returned when it ends; a bought option posts none.
//     Variation margin moves in the end-of-day pass (17:00 New York) on the mark: posted when the
//     mark is below minus the threshold, received (restricted cash with a liability) above it; a
//     transfer smaller than the minimum transfer amount is not made.
//   - Exercise: an American option any day by hand, a European one at expiration only (refused
//     before), a Bermudan one on its stated exercise dates. Physical settlement closes the option at
//     zero (so the premium is realized) and delivers the underlying at the strike as a simulated,
//     labelled delivery that settles on the underlying's own convention. Cash settlement pays
//     quantity x intrinsic value x multiplier, against the underlying's close for the expiration
//     date (the stated settlement price); until that close exists the expiry item waits, visibly.
//     Out of the money the option lapses and its premium is realized.

export const family = 'otcoption';

// ---- instants (New York time; US clocks move to daylight time on 8 March 2026) ---------------------------------
const dst = (date) => date >= '2026-03-08' && date < '2026-11-01';
/** 10:00 New York as a UTC instant. */
const at = (date, hhmm) => `${date}T${hhmm || (dst(date) ? '14:00' : '15:00')}:00.000Z`;
/** 17:30 New York: after the 17:00 end-of-day pass. */
const eod = (date) => `${date}T${dst(date) ? '21:30' : '22:30'}:00.000Z`;

const FILL = { halfSpreadBps: { equity: 0, otcoption: 0, bond: 0, crypto: 0, spot: 0, fx: 0 }, optionHalfSpreadPct: 0, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const NO_FEE = { perUnit: 0, minimum: 0, bps: 0 };

const OTC_TICKET = {
  ticket: 'Registry form (Instruments, New instrument) for the contract: underlying, Type, Strike, Expiration, Payoff, Exercise style, Settlement, Multiplier, Counterparty and the required Collateral terms group; then the instrument drawer, Trade tab (Buy / Sell, quantity, State a fill price); the strategy instance for partial close, termination and the Lifecycle menu (Exercise, Early assignment)',
  requiredFields: ['Underlying instrument (or a fixing rate code)', 'Type', 'Strike', 'Expiration', 'Collateral basis', 'Account', 'Action', 'Quantity in underlying units', 'State a fill price (the premium agreed with the dealer: no executable quote exists for an OTC option)'],
};

/** A step on the instrument drawer's ticket at a stated premium. */
const otcTicket = ({ instrument, side, qty, premium, ...rest }) => ({ action: 'ticket', instrument, side, qty, order: { statedPrice: premium }, ...rest });

// ---------------------------------------------------------------------------------------------
// otc_option
// ---------------------------------------------------------------------------------------------
// Two vanilla OTC options on Halvorsen Robotics (HALV, NYSE), dealt with Dealer B:
//   - an American call struck at 52, physical delivery of shares, uncollateralized by explicit paper
//     assumption: bought, half terminated at a stated amount, the other half exercised early by hand
//     (5,000 shares delivered at the strike, then sold);
//   - a European put struck at 48, cash-settled against the close of 18 June 2026, written under a
//     bilateral CSA with Dealer B (independent amount 10% of strike notional, variation margin with no
//     threshold and a 1,000 minimum transfer): early assignment refused, marks by hand drive the
//     variation margin out and back, held across Good Friday and Memorial Day, and it lapses out of
//     the money at expiry, the premium realized and every collateral amount returned.
const otcOption = {
  productId: 'otc_option',
  title: 'Halvorsen Robotics OTC options with Dealer B: American 52 call (physical, uncollateralized) bought; European 48 put (cash, under a CSA) written',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['underlying price (quote fixture standing in for Shaffer MarketData) for the notional', 'premium settlement date, T+2 on the US calendar (settlement.otcoption = 2)', 'commission per underlying unit from the Book fee schedule', 'independent amount and variation margin from the agreement terms', 'expiry item on the expiration date, settled against the underlying close for that date (close fixture: the stated settlement price)'],
    manualInputs: ['premium agreed with the dealer (stated fill price)', 'marks of both options, entered by hand (Manual entry)', 'termination of part of the call at a stated amount per unit (stated fill price in the preview)', 'early exercise of the American call (Lifecycle, Exercise)', 'early assignment of the European put, refused'],
    settlement: 'Premium and commission settle T+2 on the US calendar; shares delivered on exercise settle T+1 at the strike (settlement.equity = 1); a cash settlement at expiry is paid T+1',
    lifecycle: 'Early exercise by hand of an American call with a simulated delivery of the shares at the strike; early assignment of a European put refused; expiry item on 18 June 2026: out of the money, the put lapses and its premium is realized; nothing is scheduled afterwards',
    accounting: 'Average premium; commission expensed; premium realized on termination, on exercise and on lapse; shares delivered carried at the strike; marks by hand drive unrealized P&L; unpriced and provisional until a mark is entered',
    collateral: 'Call: uncollateralized (explicit paper assumption): nothing posted or received. Put (written): agreement "CSA Dealer B", independent amount 10% of 10,000 x 48 = 48,000 posted at entry and returned at expiry; variation margin each end of day against the mark, threshold 0, minimum transfer 1,000, posted and returned',
  },
  start: at('2026-03-02'),
  // US (NYSE / Federal Reserve) calendar: no holiday between 2 and 6 March 2026; Good Friday 3 April and Memorial Day
  // 25 May fall while the put is held.
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix OTC option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }],
    account: { name: 'Vega', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.01, minimum: 0, bps: 0 }, equity: NO_FEE }, fill: FILL, settlement: { otcoption: 2, equity: 1 } }, // 0.01 an underlying unit
  },
  instruments: {
    stock: { productId: 'common_stock', name: 'Halvorsen Robotics Inc.', symbol: 'HALV', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Halvorsen Robotics Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    call: {
      productId: 'otc_option', name: 'HALV 18 Jun 2026 52 call, American, physical (Dealer B)', symbol: 'HALV-OTC-C52', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 1,
      terms: { right: 'C', strike: 52, expiration: '2026-06-18', optionType: 'vanilla', exercise: 'american', settlement: 'physical', counterparty: 'Dealer B', collateralBasis: { type: 'uncollateralized' } },
    },
  },
  quotes: { stock: { bid: 49.98, ask: 50.02, last: 50, bidSize: 100_000, askSize: 100_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 1_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 1_000_000, availableToWithdraw: 1_000_000 } },
      treasury: { USD: { settled: 1_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 1_000_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 1_000_000, treasury: 1_000_000, book: 2_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    otcTicket({
      id: 'buy-call', covers: ['open', 'collateral'], instrument: 'call', side: 'buy', qty: 10_000, premium: 3.20, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 10_000, estimate: 3.2, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US',
            cash: -32_000, // 10,000 x 3.20 x 1
            fees: 100, // 10,000 x 0.01
            notional: 500_000 }], // 10,000 x 1 x 50.00 (HALV last)
          cash: { USD: { purchases: 32_000, fees: 100, margin: 0, required: 32_100, available: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000, avgPrice: 3.2, fills: [{ qty: 10_000, price: 3.2, model: 'stated-price', settleDate: '2026-03-04' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 10,000 HALV-OTC-C52 @ 3.20 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -32_100, availableToTrade: 967_900, availableToWithdraw: 967_900 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 10_000, avgCost: 3.2, cost: 32_000, price: null, value: null, unrealized: null, provisional: true, notional: 500_000, margin: 0 }],
        holdings: { call: { long: 10_000, short: 0, net: 10_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -32_100, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-18', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', owner: 'account', qty: 10_000, basis: 'uncollateralized', mark: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -100, fees: 0, unrealized: 0, total: -100 } },
        // Unpriced, the option is carried at its cost (32,000) and every total resting on it is provisional.
        nav: { account: 999_900, book: 1_999_900 }, // 1,000,000 - 32,100 payable + 32,000 at cost
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_000_000, payable: 32_100, positions: 32_000, assets: 1_032_000, liabilities: 32_100, netAssets: 999_900 } },
      },
    }),
    {
      id: 'agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer B', counterparty: 'Dealer B', kind: 'bilateral', independentAmount: { type: 'pct', pct: 0.10 }, variationMargin: true, threshold: 0, minimumTransfer: 1_000 },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer B with Dealer B (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    {
      id: 'register-put', action: 'register_instrument', as: 'put',
      draft: {
        productId: 'otc_option', name: 'HALV 18 Jun 2026 48 put, European, cash (Dealer B, CSA)', symbol: 'HALV-OTC-P48', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 1,
        terms: { right: 'P', strike: 48, expiration: '2026-06-18', optionType: 'vanilla', exercise: 'european', settlement: 'cash', counterparty: 'Dealer B', collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' } },
      },
      expect: {},
    },
    otcTicket({
      // Writing the put. Independent amount: 10% x 10,000 x 48 x 1 = 48,000, posted from settled cash at the fill.
      id: 'write-put', covers: ['write', 'collateral'], instrument: 'put', side: 'sell', qty: 10_000, premium: 1.50, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 10_000, estimate: 1.5, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US',
            cash: 15_000, // 10,000 x 1.50 x 1
            fees: 100, // 10,000 x 0.01
            notional: 500_000 }], // 10,000 x 1 x 50.00
          cash: { USD: { proceeds: 15_000, fees: 100, margin: 48_000, required: 48_100, available: 967_900, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000, avgPrice: 1.5, fills: [{ qty: 10_000, price: 1.5, model: 'stated-price', settleDate: '2026-03-04' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 10,000 HALV-OTC-P48 @ 1.50 USD', owner: 'account', date: '2026-03-02' }, // opening a written position realizes nothing
          { type: 'otcoption.collateral', summary: 'Collateral posted on HALV 18 Jun 2026 48 put, European, cash (Dealer B, CSA) under "CSA Dealer B" (Dealer B): 48,000.00 USD (independent amount, 10.00% of 480,000.00 USD notional)', cash: { USD: -48_000 }, owner: 'account' },
        ],
        // settled 1,000,000 - 48,000; owed 32,100 and due 14,900 until settlement.
        cash: { account: { USD: { settled: 952_000, unsettled: -17_200, margin: 48_000, availableToTrade: 934_800, availableToWithdraw: 919_900 } } }, // 952,000 - 17,200; 952,000 - 32,100
        positions: [
          { instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 10_000, avgCost: 3.2, cost: 32_000, price: null, value: null, unrealized: null, provisional: true, notional: 500_000, margin: 0 },
          { instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -10_000, avgCost: 1.5, cost: -15_000, price: null, value: null, unrealized: null, provisional: true, notional: 500_000, margin: 48_000 },
        ],
        holdings: { call: { long: 10_000, short: 0, net: 10_000 }, put: { long: 0, short: 10_000, net: -10_000 } },
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -32_100, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-03-04', amount: 14_900, ccy: 'USD', into: 'cash' }, // 15,000 - 100
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-18', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-06-18', status: 'pending' }],
        otc: [
          { instrument: 'call', lot: 'calls', owner: 'account', qty: 10_000, basis: 'uncollateralized', mark: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 },
          { instrument: 'put', lot: 'puts', owner: 'account', qty: -10_000, basis: 'agreement', agreement: 'CSA Dealer B', mark: null, iaRequired: 48_000, iaPosted: 48_000, vmPosted: 0, vmHeld: 0 },
        ],
        pnl: { account: { realized: 0, commissions: -200, unrealized: 0, total: -200 } },
        nav: { account: 999_800, book: 1_999_800 }, // 952,000 + 48,000 + 14,900 - 32,100 + 32,000 - 15,000 (both options at cost, unpriced)
        balance: { account: { cash: 952_000, margin: 48_000, receivable: 14_900, payable: 32_100, positions: 17_000, assets: 1_031_900, liabilities: 32_100, netAssets: 999_800 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 3.60, note: 'Dealer B mark, by hand',
      expect: {
        positions: [
          { instrument: 'call', lot: 'calls', qty: 10_000, price: 3.6, value: 36_000, unrealized: 4_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }, // 10,000 x 3.60; 36,000 - 32,000
          { instrument: 'put', lot: 'puts', qty: -10_000 },
        ],
        otc: [{ instrument: 'call', mark: 3.6, markValue: 36_000 }, { instrument: 'put', mark: null }],
        pnl: { account: { unrealized: 4_000, total: 3_800 } },
        nav: { account: 1_003_800, book: 2_003_800 },
        balance: { account: { positions: 21_000, assets: 1_035_900, netAssets: 1_003_800 } }, // 36,000 - 15,000 (put still at cost)
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 1.80, note: 'Dealer B mark, by hand',
      expect: {
        positions: [
          { instrument: 'call', lot: 'calls', qty: 10_000 },
          { instrument: 'put', lot: 'puts', qty: -10_000, price: 1.8, value: -18_000, unrealized: -3_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }, // -10,000 x 1.80; -18,000 + 15,000
        ],
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 1.8, markValue: -18_000 }],
        pnl: { account: { unrealized: 1_000, total: 800 } }, // 4,000 - 3,000; - 200 commission
        nav: { account: 1_000_800, book: 2_000_800 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 18_000, assets: 1_032_900, netAssets: 1_000_800 } }, // 36,000 - 18,000
      },
    },
    {
      // The put's netting set is marked at -18,000; no threshold: 18,000 is posted (above the 1,000 minimum transfer).
      // The call is uncollateralized: no call either way.
      id: 'variation-margin-posted', covers: 'variation margin', action: 'clock', to: eod('2026-03-02'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer B" (Dealer B): 18,000.00 USD posted. Netting set of 1 position marked at -18,000.00 USD; threshold 0.00 USD.', cash: { USD: -18_000 }, owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 934_000, margin: 66_000, availableToTrade: 916_800, availableToWithdraw: 901_900 } } },
        otc: [{ instrument: 'call', vmPosted: 0 }, { instrument: 'put', vmPosted: 18_000, vmHeld: 0, vmExposure: -18_000, vmStatus: 'ok' }],
        balance: { account: { cash: 934_000, margin: 66_000 } },
      },
    },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 14,900.00 USD into settled cash', cash: { USD: 14_900 }, date: '2026-03-04' },
          { type: 'settlement.pay', summary: 'paid 32,100.00 USD from settled cash', cash: { USD: -32_100 }, date: '2026-03-04' },
        ],
        cash: { account: { USD: { settled: 916_800, unsettled: 0, availableToTrade: 916_800, availableToWithdraw: 916_800 } } }, // 934,000 + 14,900 - 32,100
        pending: [],
        balance: { account: { cash: 916_800, receivable: null, payable: null, assets: 1_000_800, liabilities: 0 } },
      },
    },
    {
      id: 'early-assignment-refused', covers: 'exercise style', action: 'lifecycle', lot: 'puts', body: { action: 'assign', contracts: 10_000 },
      status: 'blocked', reason: 'The put is European: it cannot be assigned (or exercised) before its expiration date.',
      expect: { refused: 'A European option cannot be assigned before expiration.' },
    },
    {
      // Half the call terminated with Dealer B at 4.00 a unit, stated in the preview. Realized 5,000 x (4.00 - 3.20).
      id: 'terminate-half-call', covers: ['reduce', 'termination at a stated amount'], action: 'close', lot: 'calls', scope: 'strategy', percent: 50, order: { statedPrice: 4.00 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'call', qty: 5_000, estimate: 4, model: 'stated-price', settleDate: '2026-03-06', calendar: 'US', cash: 20_000, fees: 50 }], // 5,000 x 4.00; 5,000 x 0.01
          cash: { USD: { proceeds: 20_000, fees: 50 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 5_000, avgPrice: 4 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 5,000 HALV-OTC-C52 @ 4.00 USD (realized 4,000.00 USD)', owner: 'account', date: '2026-03-04' }],
        cash: { account: { USD: { unsettled: 19_950, availableToTrade: 936_750, availableToWithdraw: 916_800 } } }, // 20,000 - 50
        positions: [
          { instrument: 'call', lot: 'calls', qty: 5_000, avgCost: 3.2, cost: 16_000, price: 3.6, value: 18_000, unrealized: 2_000, notional: 250_000 }, // 5,000 x 50
          { instrument: 'put', lot: 'puts', qty: -10_000 },
        ],
        holdings: { call: { long: 5_000, short: 0, net: 5_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-06', amount: 19_950, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'call', qty: 5_000, markValue: 18_000 }, { instrument: 'put' }],
        pnl: { account: { realized: 4_000, commissions: -250, unrealized: -1_000, total: 2_750 } }, // 2,000 - 3,000
        nav: { account: 1_002_750, book: 2_002_750 }, // 916,800 + 66,000 + 19,950 + 18,000 - 18,000
        balance: { account: { receivable: 19_950, positions: null, assets: 1_002_750, netAssets: 1_002_750 } }, // 18,000 - 18,000: no line
      },
    },
    {
      id: 'stock-rallies', action: 'quote', instrument: 'stock', quote: { bid: 55.98, ask: 56.02, last: 56, bidSize: 100_000, askSize: 100_000 },
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', qty: 5_000, notional: 280_000 }, { instrument: 'put', lot: 'puts', qty: -10_000, notional: 560_000 }], // 5,000 x 56; 10,000 x 56
      },
    },
    {
      // American: exercised by hand. The option closes at zero (its 16,000 cost is realized) and 5,000 shares are
      // delivered at 52, a simulated delivery that settles T+1 (Thursday 5 March): 5,000 x 52 = 260,000.
      id: 'exercise-early', covers: ['early exercise', 'physical settlement'], action: 'lifecycle', lot: 'calls', body: { action: 'exercise', contracts: 5_000 },
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 5,000 HALV-OTC-C52 at strike 52', owner: 'account', date: '2026-03-04' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 5,000 HALV at strike 52 on exercise of HALV-OTC-C52/, owner: 'account', date: '2026-03-04' },
        ],
        cash: { account: { USD: { unsettled: -240_050, availableToTrade: 676_750, availableToWithdraw: 656_800 } } }, // 19,950 - 260,000; 916,800 - 240,050; 916,800 - 260,000
        positions: [
          { instrument: 'put', lot: 'puts', qty: -10_000 },
          { instrument: 'stock', lot: 'calls', owner: 'account', direction: 'long', qty: 5_000, avgCost: 52, cost: 260_000, price: 56, value: 280_000, unrealized: 20_000, provisional: false }, // 5,000 x 56 - 260,000
        ],
        holdings: { call: null, stock: { long: 5_000, short: 0, net: 5_000 } },
        pending: [
          { instrument: 'stock', owner: 'account', dueDate: '2026-03-05', amount: -260_000, ccy: 'USD', into: 'cash' },
          { instrument: 'call', owner: 'account', dueDate: '2026-03-06', amount: 19_950, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'put', dueDate: '2026-06-18', status: 'pending' }],
        otc: [{ instrument: 'put', lot: 'puts', qty: -10_000 }],
        pnl: { account: { realized: -12_000, unrealized: 17_000, total: 4_750 } }, // 4,000 - 16,000; 20,000 - 3,000; -12,000 - 250 + 17,000
        nav: { account: 1_004_750, book: 2_004_750 }, // 916,800 + 66,000 + 19,950 - 260,000 + 280,000 - 18,000
        balance: { account: { payable: 260_000, positions: 262_000, assets: 1_264_750, liabilities: 260_000, netAssets: 1_004_750 } }, // 280,000 - 18,000
      },
    },
    {
      id: 'settle-delivery', covers: 'settlement', action: 'clock', to: at('2026-03-05'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 260,000.00 USD from settled cash', cash: { USD: -260_000 }, date: '2026-03-05' }],
        cash: { account: { USD: { settled: 656_800, unsettled: 19_950, availableToTrade: 676_750, availableToWithdraw: 656_800 } } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-06', amount: 19_950, ccy: 'USD', into: 'cash' }],
        balance: { account: { cash: 656_800, payable: null, assets: 1_004_750, liabilities: 0 } },
      },
    },
    {
      // The shares delivered are sold at the bid, 55.98: 5,000 x 55.98 = 279,900; realized 279,900 - 260,000.
      id: 'sell-delivered-shares', covers: 'close', action: 'ticket', instrument: 'stock', side: 'sell', qty: 5_000, from: 'calls',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'stock', qty: 5_000, estimate: 55.98, model: 'quoted-bid-ask', settleDate: '2026-03-06', cash: 279_900, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 5_000, avgPrice: 55.98 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 5,000 HALV @ 55.98 USD (realized 19,900.00 USD)', owner: 'account', date: '2026-03-05' }],
        cash: { account: { USD: { unsettled: 299_850, availableToTrade: 956_650, availableToWithdraw: 656_800 } } }, // 19,950 + 279,900
        positions: [{ instrument: 'put', lot: 'puts', qty: -10_000 }],
        holdings: { stock: null },
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-03-06', amount: 19_950, ccy: 'USD', into: 'cash' },
          { instrument: 'stock', owner: 'account', dueDate: '2026-03-06', amount: 279_900, ccy: 'USD', into: 'cash' },
        ],
        pnl: { account: { realized: 7_900, unrealized: -3_000, total: 4_650 } }, // -12,000 + 19,900; 7,900 - 250 - 3,000
        nav: { account: 1_004_650, book: 2_004_650 }, // 656,800 + 66,000 + 299,850 - 18,000
        balance: { account: { receivable: 299_850, positions: -18_000, assets: 1_004_650, netAssets: 1_004_650 } },
      },
    },
    {
      id: 'settle-sales', covers: 'settlement', action: 'clock', to: at('2026-03-06'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 19,950.00 USD into settled cash', cash: { USD: 19_950 } },
          { type: 'settlement.receive', summary: 'received 279,900.00 USD into settled cash', cash: { USD: 279_900 } },
        ],
        cash: { account: { USD: { settled: 956_650, unsettled: 0, availableToTrade: 956_650, availableToWithdraw: 956_650 } } },
        pending: [],
        balance: { account: { cash: 956_650, receivable: null } },
      },
    },
    { id: 'thursday-before-good-friday', action: 'clock', to: at('2026-04-02'), expect: {} },
    {
      id: 'mark-put-lower', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 0.40, note: 'Dealer B mark, by hand',
      expect: {
        positions: [{ instrument: 'put', lot: 'puts', qty: -10_000, price: 0.4, value: -4_000, unrealized: 11_000 }], // -10,000 x 0.40; -4,000 + 15,000
        otc: [{ instrument: 'put', mark: 0.4, markValue: -4_000 }],
        pnl: { account: { unrealized: 11_000, total: 18_650 } }, // 7,900 - 250 + 11,000
        nav: { account: 1_018_650, book: 2_018_650 }, // 956,650 + 66,000 - 4,000
        balance: { account: { positions: -4_000, assets: 1_018_650, netAssets: 1_018_650 } },
      },
    },
    {
      // Marked at -4,000: 4,000 is required, 18,000 is posted, 14,000 comes back (above the 1,000 minimum transfer).
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-04-02'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer B" (Dealer B): 14,000.00 USD returned to us. Netting set of 1 position marked at -4,000.00 USD; threshold 0.00 USD.', cash: { USD: 14_000 }, owner: 'account', date: '2026-04-02' }],
        cash: { account: { USD: { settled: 970_650, margin: 52_000, availableToTrade: 970_650, availableToWithdraw: 970_650 } } },
        otc: [{ instrument: 'put', vmPosted: 4_000, vmExposure: -4_000, vmStatus: 'ok' }],
        balance: { account: { cash: 970_650, margin: 52_000 } },
      },
    },
    {
      // 52,000 is posted as collateral: it is still the Account's asset, but it is not cash it can move.
      id: 'posted-collateral-not-spendable', covers: 'collateral', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 1_000_000,
      status: 'blocked', reason: 'Collateral posted (independent amount and variation margin) is not settled cash: it cannot be transferred.',
      expect: { refused: 'Vega has 970,650.00 USD of settled USD available; 1,000,000.00 USD requested' },
    },
    // Held across Good Friday (3 April) and Memorial Day (25 May), both closed on the US calendar.
    { id: 'after-memorial-day', covers: 'holiday', action: 'clock', to: at('2026-05-26'), expect: {} },
    // The settlement price, HALV's official close for 18 June (50.40), is supplied by the close fixture; it counts only once
    // that day's close has happened.
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'stock', date: '2026-06-18', value: 50.40, expect: {} },
    {
      // Expiration day, before the close: the item is due but the 18 June close of HALV does not exist yet. It waits, visibly.
      id: 'expiry-awaits-fixing', covers: 'expiry', action: 'clock', to: at('2026-06-18'),
      expect: { lifecycle: [{ type: 'option.expiry', instrument: 'put', dueDate: '2026-06-18', status: 'blocked', reason: /Awaiting the 2026-06-18 fixing for HALV/ }] },
    },
    {
      // After the close: HALV settled at 50.40, above the 48 strike. The put lapses; its 15,000 premium is realized; the
      // 48,000 independent amount and the 4,000 of variation margin come back.
      id: 'expires-out-of-the-money', covers: ['expiry', 'lapse', 'collateral'], action: 'clock', to: eod('2026-06-18'),
      expect: {
        events: [
          { type: 'option.expired', summary: 'Expired worthless: 10,000 HALV-OTC-P48 (fixing 50.4)', owner: 'account', date: '2026-06-18' },
          { type: 'otcoption.collateral', summary: 'Collateral returned on HALV 18 Jun 2026 48 put, European, cash (Dealer B, CSA) under "CSA Dealer B" (Dealer B): 48,000.00 USD (independent amount, the position ended)', cash: { USD: 48_000 }, owner: 'account' },
          { type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer B" (Dealer B): 4,000.00 USD returned to us. The last position of the netting set ended.', cash: { USD: 4_000 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 1_022_650, margin: 0, availableToTrade: 1_022_650, availableToWithdraw: 1_022_650 } } }, // 970,650 + 52,000
        positions: [], holdings: { put: null }, lifecycle: [], otc: [], pending: [],
        pnl: { account: { realized: 22_900, commissions: -250, unrealized: 0, total: 22_650 } }, // 7,900 + 15,000
        nav: { account: 1_022_650, book: 2_022_650 },
        balance: { account: { cash: 1_022_650, margin: null, positions: null, assets: 1_022_650, liabilities: 0, netAssets: 1_022_650 } },
      },
    },
  ],
};

export default [otcOption];
