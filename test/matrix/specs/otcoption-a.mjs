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
      id: 'sell-delivered-shares', covers: 'close', action: 'ticket', ticketOf: 'equity', settlementCheck: false, // shares settle T+1 (Thursday 5 to Friday 6 March), not the option's T+2
      instrument: 'stock', side: 'sell', qty: 5_000, from: 'calls',
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
          { type: 'option.expired', summary: 'Expired worthless: 10,000 HALV-OTC-P48 (fixing 50.40)', owner: 'account', date: '2026-06-18' },
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

// ---------------------------------------------------------------------------------------------
// bond_option
// ---------------------------------------------------------------------------------------------
// Two OTC options on a US Treasury note, dealt by Treasury with Dealer C, quoted in points per 100 of face (multiplier
// 0.01, quantity in face amount):
//   - a Bermudan call struck at 99.50, exercisable on 15 April and 15 May 2026 and at expiry (15 June), physical
//     delivery; position-level terms with variation margin only (threshold 25,000, minimum transfer 5,000). The mark
//     rises and the dealer posts collateral to Treasury (restricted cash with a liability). Exercise on 14 April is
//     refused; on 15 April it delivers the note at the strike plus accrued interest (a simulated delivery, T+1), the
//     collateral received goes back to the dealer, and the note is sold the same day.
//   - a European put struck at 98.00, cash-settled, written; position-level terms: independent amount 2% of strike
//     notional, variation margin with no threshold (minimum transfer 5,000). It finishes in the money against the 15
//     June close of the note (97.40, the stated settlement price) and is cash-settled: 0.60 per 100 of face.
// Treasury owns every position; the Account is not used.
//
// The note: 4.25% semi-annual, ACT/ACT, coupons 15 May and 15 November, maturity 15 May 2031. Accrued interest to
// Thursday 16 April 2026 (settlement of the delivery and of the sale): 152 days of the 181-day period from 15 November
// 2025 to 15 May 2026: 10,000,000 x 4.25% / 2 x 152 / 181 = 178,453.04.
const BOND_NOTE = 'US Treasury Note 4.25% 15-May-2031';
const BCALL_NAME = 'UST 4.25% May-31 Bermudan call 99.50, 15 Jun 2026 (Dealer C)';
const BPUT_NAME = 'UST 4.25% May-31 European put 98.00, 15 Jun 2026, cash (Dealer C)';
const bondOption = {
  productId: 'bond_option',
  title: 'US Treasury note options owned by Treasury: Bermudan 99.50 call (physical, at the strike plus accrued) bought; European 98.00 put (cash) written',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['note price (quote fixture standing in for Shaffer MarketData) for the notional and the delivered note', 'accrued interest on the delivery and on the sale, from the note\'s registered coupon terms (ACT/ACT)', 'premium settlement date, T+2 on the US calendar; the note settles T+1 (settlement.bond = 1)', 'commission per unit of face from the Book fee schedule', 'variation margin and independent amount from the position-level terms', 'expiry item settled against the note\'s close for the expiration date (close fixture: the stated settlement price)'],
    manualInputs: ['premium agreed with the dealer, points per 100 of face (stated fill price)', 'marks of both options entered by hand (Manual entry), points per 100 of face', 'Bermudan exercise on an exercise date (Lifecycle, Exercise); exercise on another date refused'],
    settlement: 'Premium and commission T+2 on the US calendar; the note delivered on exercise, and its sale, T+1 at the clean price plus accrued interest to the settlement date; the cash settlement of the put T+1',
    lifecycle: 'Bermudan exercise refused off its dates and recorded by hand on one, with a simulated delivery of 10,000,000 face at 99.50 plus accrued interest; the note sold before its coupon; the put cash-settled in the money at expiry; nothing scheduled afterwards',
    accounting: 'Premium per 100 of face x face x 0.01; average premium; premium realized on exercise and at expiry; the note carried at the strike with its accrued interest in Accrued income; commission expensed; marks by hand drive unrealized P&L',
    collateral: 'Call (bought): position-level terms, variation margin only, threshold 25,000: collateral received from the dealer is restricted cash with a liability, returned when the call is exercised; no independent amount for a bought option. Put (written): independent amount 2% x 9,800,000 = 196,000, variation margin with no threshold, posted and returned at expiry',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] }, // option premium T+2 on the US calendar (bond legs, T+1, are exempted step by step)
  book: {
    name: 'Matrix bond option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 25_000_000 }],
    account: { name: 'Rates', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.00005, minimum: 0, bps: 0 }, bond: NO_FEE }, fill: FILL, settlement: { otcoption: 2, bond: 1 } }, // 50.00 per million of face
  },
  instruments: {
    bond: { productId: 'treasury_note', name: BOND_NOTE, symbol: 'UST-4.25-MAY31', marketView: 'US_CASH', venueType: 'otc', issuer: 'United States Treasury', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.0425, frequency: 2, maturity: '2031-05-15', issueDate: '2021-05-15', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 100 } },
    call: {
      productId: 'bond_option', name: BCALL_NAME, symbol: 'UST31-BC995', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'bond', multiplier: 0.01,
      terms: { right: 'C', strike: 99.5, expiration: '2026-06-15', optionType: 'vanilla', exercise: 'bermudan', exerciseDates: ['2026-04-15', '2026-05-15'], settlement: 'physical', counterparty: 'Dealer C',
        collateralBasis: { type: 'position', independentAmount: { type: 'none' }, variationMargin: true, threshold: 25_000, minimumTransfer: 5_000 } },
    },
    put: {
      productId: 'bond_option', name: BPUT_NAME, symbol: 'UST31-EP98', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'bond', multiplier: 0.01,
      terms: { right: 'P', strike: 98, expiration: '2026-06-15', optionType: 'vanilla', exercise: 'european', settlement: 'cash', counterparty: 'Dealer C',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: true, threshold: 0, minimumTransfer: 5_000 } },
    },
  },
  quotes: { bond: { bid: 99.50, ask: 99.55, last: 99.525, bidSize: 50_000_000, askSize: 50_000_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 1_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 1_000_000, availableToWithdraw: 1_000_000 } },
      treasury: { USD: { settled: 24_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 24_000_000, availableToWithdraw: 24_000_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 1_000_000, treasury: 24_000_000, book: 25_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    otcTicket({
      id: 'buy-call', covers: ['open', 'collateral'], owner: 'treasury', instrument: 'call', side: 'buy', qty: 10_000_000, premium: 0.80, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 10_000_000, estimate: 0.8, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US',
            cash: -80_000, // 10,000,000 x 0.80 x 0.01
            fees: 500, // 10,000,000 x 0.00005
            notional: 9_952_500 }], // 10,000,000 x 0.01 x 99.525 (note last)
          cash: { USD: { purchases: 80_000, fees: 500, margin: 0, required: 80_500, available: 24_000_000, shortfall: 0 } }, // a bought option posts no independent amount
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000_000, avgPrice: 0.8, fills: [{ qty: 10_000_000, price: 0.8, model: 'stated-price', settleDate: '2026-03-04' }] }] },
        events: [{ type: 'strategy.submitted', owner: 'treasury' }, { type: 'trade.fill', summary: 'Bought 10,000,000 UST31-BC995 @ 0.80 USD', owner: 'treasury', date: '2026-03-02' }],
        cash: { treasury: { USD: { settled: 24_000_000, unsettled: -80_500, availableToTrade: 23_919_500, availableToWithdraw: 23_919_500 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'treasury', direction: 'long', qty: 10_000_000, avgCost: 0.8, cost: 80_000, price: null, value: null, unrealized: null, provisional: true, notional: 9_952_500, margin: 0 }],
        holdings: { call: { long: 10_000_000, short: 0, net: 10_000_000 } },
        pending: [{ instrument: 'call', owner: 'treasury', dueDate: '2026-03-04', amount: -80_500, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-15', status: 'pending', owner: 'treasury' }],
        otc: [{ instrument: 'call', lot: 'calls', owner: 'treasury', qty: 10_000_000, basis: 'position', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: 0, unrealized: 0, total: 0 }, treasury: { realized: 0, commissions: -500, unrealized: 0, total: -500 }, book: { commissions: -500, total: -500 } },
        nav: { account: 1_000_000, treasury: 23_999_500, book: 24_999_500 }, // 24,000,000 - 80,500 + 80,000 (unpriced: at cost)
        provisional: { account: false, book: true },
        balance: {
          account: { cash: 1_000_000, assets: 1_000_000, liabilities: 0, netAssets: 1_000_000 },
          treasury: { cash: 24_000_000, payable: 80_500, positions: 80_000, assets: 24_080_000, liabilities: 80_500, netAssets: 23_999_500 },
        },
      },
    }),
    // Half an hour later (the netting sets are valued in the order their positions opened).
    { id: 'half-an-hour-later', action: 'clock', to: at('2026-03-02', '15:30'), expect: {} },
    otcTicket({
      // Written: independent amount 2% x 10,000,000 x 98 x 0.01 = 196,000, posted at the fill.
      id: 'write-put', covers: ['write', 'collateral'], owner: 'treasury', instrument: 'put', side: 'sell', qty: 10_000_000, premium: 0.45, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 10_000_000, estimate: 0.45, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US',
            cash: 45_000, fees: 500, notional: 9_952_500 }], // 10,000,000 x 0.45 x 0.01
          cash: { USD: { proceeds: 45_000, fees: 500, margin: 196_000, required: 196_500, available: 23_919_500, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000_000, avgPrice: 0.45 }] },
        events: [
          { type: 'strategy.submitted', owner: 'treasury' },
          { type: 'trade.fill', summary: 'Sold 10,000,000 UST31-EP98 @ 0.45 USD', owner: 'treasury' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${BPUT_NAME} under its position-level terms: 196,000.00 USD (independent amount, 2.00% of 9,800,000.00 USD notional)`, cash: { USD: -196_000 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 23_804_000, unsettled: -36_000, margin: 196_000, availableToTrade: 23_768_000, availableToWithdraw: 23_723_500 } } }, // -80,500 + 44,500; 23,804,000 - 80,500
        positions: [
          { instrument: 'call', lot: 'calls', qty: 10_000_000 },
          { instrument: 'put', lot: 'puts', owner: 'treasury', direction: 'short', qty: -10_000_000, avgCost: 0.45, cost: -45_000, price: null, value: null, unrealized: null, provisional: true, notional: 9_952_500, margin: 196_000 },
        ],
        holdings: { put: { long: 0, short: 10_000_000, net: -10_000_000 } },
        pending: [
          { instrument: 'call', owner: 'treasury', dueDate: '2026-03-04', amount: -80_500, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'treasury', dueDate: '2026-03-04', amount: 44_500, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-15', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-06-15', status: 'pending' }],
        otc: [{ instrument: 'call' }, { instrument: 'put', lot: 'puts', owner: 'treasury', qty: -10_000_000, basis: 'position', iaRequired: 196_000, iaPosted: 196_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { treasury: { commissions: -1_000, total: -1_000 }, book: { commissions: -1_000, total: -1_000 } },
        nav: { treasury: 23_999_000, book: 24_999_000 }, // 23,804,000 + 196,000 + 44,500 - 80,500 + 80,000 - 45,000
        balance: { treasury: { cash: 23_804_000, margin: 196_000, receivable: 44_500, payable: 80_500, positions: 35_000, assets: 24_079_500, liabilities: 80_500, netAssets: 23_999_000 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 1.10, note: 'Dealer C mark, by hand, per 100 of face',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 1.1, value: 110_000, unrealized: 30_000, provisional: false, priceSource: 'Manual entry' }, { instrument: 'put', lot: 'puts' }], // 10,000,000 x 1.10 x 0.01
        otc: [{ instrument: 'call', mark: 1.1, markValue: 110_000 }, { instrument: 'put' }],
        pnl: { treasury: { unrealized: 30_000, total: 29_000 }, book: { unrealized: 30_000, total: 29_000 } },
        nav: { treasury: 24_029_000, book: 25_029_000 },
        balance: { treasury: { positions: 65_000, assets: 24_109_500, netAssets: 24_029_000 } },
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 0.30, note: 'Dealer C mark, by hand, per 100 of face',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 0.3, value: -30_000, unrealized: 15_000, provisional: false, priceSource: 'Manual entry' }], // -10,000,000 x 0.30 x 0.01; + 45,000
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 0.3, markValue: -30_000 }],
        pnl: { treasury: { unrealized: 45_000, total: 44_000 }, book: { unrealized: 45_000, total: 44_000 } },
        nav: { treasury: 24_044_000, book: 25_044_000 },
        provisional: { book: false },
        balance: { treasury: { positions: 80_000, assets: 24_124_500, netAssets: 24_044_000 } },
      },
    },
    {
      // Call marked at +110,000: 85,000 beyond the 25,000 threshold, posted to Treasury by the dealer: restricted cash
      // with a liability, never spendable. Put marked at -30,000, no threshold: Treasury posts 30,000.
      id: 'variation-margin-both-ways', covers: 'variation margin', action: 'clock', to: eod('2026-03-02'),
      expect: {
        events: [
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 85,000.00 USD received. Netting set of 1 position marked at 110,000.00 USD; threshold 25,000.00 USD.', owner: 'treasury', date: '2026-03-02' },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 30,000.00 USD posted. Netting set of 1 position marked at -30,000.00 USD; threshold 0.00 USD.', cash: { USD: -30_000 }, owner: 'treasury', date: '2026-03-02' },
        ],
        cash: { treasury: { USD: { settled: 23_774_000, restricted: 85_000, margin: 226_000, availableToTrade: 23_738_000, availableToWithdraw: 23_693_500 } } },
        otc: [{ instrument: 'call', vmPosted: 0, vmHeld: 85_000, vmExposure: 110_000, vmStatus: 'ok' }, { instrument: 'put', vmPosted: 30_000, vmHeld: 0, vmExposure: -30_000, vmStatus: 'ok' }],
        balance: { treasury: { cash: 23_774_000, restricted: 85_000, margin: 226_000, collateralReceived: 85_000, assets: 24_209_500, liabilities: 165_500, netAssets: 24_044_000 } },
      },
    },
    { id: 'treasury-screens-collateral', covers: 'owner screens', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 44,500.00 USD into settled cash', cash: { USD: 44_500 }, owner: 'treasury' },
          { type: 'settlement.pay', summary: 'paid 80,500.00 USD from settled cash', cash: { USD: -80_500 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 23_738_000, unsettled: 0, availableToTrade: 23_738_000, availableToWithdraw: 23_738_000 } } },
        pending: [],
        balance: { treasury: { cash: 23_738_000, receivable: null, payable: null, assets: 24_129_000, liabilities: 85_000 } },
      },
    },
    // Held across Good Friday (3 April, closed on the US calendar).
    { id: 'tuesday-14-april', covers: 'holiday', action: 'clock', to: at('2026-04-14'), expect: {} },
    {
      id: 'exercise-off-date-refused', covers: 'exercise style', action: 'lifecycle', lot: 'calls', body: { action: 'exercise', contracts: 10_000_000 },
      status: 'blocked', reason: 'A Bermudan option is exercised only on its stated exercise dates (15 April, 15 May) or at expiration; 14 April is none of them.',
      expect: { refused: 'This option is Bermudan: it can only be exercised on its exercise dates (2026-04-15, 2026-05-15) or at expiration (2026-06-15). Today is 2026-04-14.' },
    },
    { id: 'wednesday-15-april', action: 'clock', to: at('2026-04-15'), expect: {} },
    {
      id: 'note-rallies', action: 'quote', instrument: 'bond', quote: { bid: 101.20, ask: 101.25, last: 101.225, bidSize: 50_000_000, askSize: 50_000_000 },
      expect: { positions: [{ instrument: 'call', lot: 'calls', notional: 10_122_500 }, { instrument: 'put', lot: 'puts', notional: 10_122_500 }] }, // 10,000,000 x 0.01 x 101.225
    },
    {
      // An exercise date. The call closes at zero (its 80,000 premium is realized); 10,000,000 face is delivered at 99.50
      // plus accrued interest to Thursday 16 April, T+1: 9,950,000 + 178,453.04 = 10,128,453.04. The 85,000 the dealer
      // posted against the call goes back to the dealer.
      id: 'exercise-on-date', covers: ['bermudan exercise', 'physical settlement', 'collateral'], action: 'lifecycle', lot: 'calls', body: { action: 'exercise', contracts: 10_000_000 },
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 10,000,000 UST31-BC995 at strike 99.5', owner: 'treasury', date: '2026-04-15' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 10,000,000 UST-4\.25-MAY31 at strike 99\.5 plus accrued interest on exercise of UST31-BC995/, owner: 'treasury', date: '2026-04-15' },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 85,000.00 USD returned to the counterparty. The last position of the netting set ended.', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { restricted: 0, unsettled: -10_128_453.04, availableToTrade: 13_609_546.96, availableToWithdraw: 13_609_546.96 } } }, // 23,738,000 - 10,128,453.04
        positions: [
          { instrument: 'bond', lot: 'calls', owner: 'treasury', direction: 'long', qty: 10_000_000, avgCost: 99.5, cost: 9_950_000, price: 101.225, value: 10_122_500, unrealized: 172_500, accrued: 178_453.04, provisional: false },
          { instrument: 'put', lot: 'puts', qty: -10_000_000 },
        ],
        holdings: { call: null, bond: { long: 10_000_000, short: 0, net: 10_000_000 } },
        pending: [{ instrument: 'bond', owner: 'treasury', dueDate: '2026-04-16', amount: -10_128_453.04, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'bond.coupon', instrument: 'bond', dueDate: '2026-05-15', status: 'pending' },
          { type: 'option.expiry', instrument: 'put', dueDate: '2026-06-15', status: 'pending' },
          { type: 'bond.maturity', instrument: 'bond', dueDate: '2031-05-15', status: 'pending' },
        ],
        otc: [{ instrument: 'put', lot: 'puts' }],
        pnl: { treasury: { realized: -80_000, unrealized: 187_500, total: 106_500 }, book: { realized: -80_000, unrealized: 187_500, total: 106_500 } }, // 172,500 + 15,000; -80,000 - 1,000 + 187,500
        nav: { treasury: 24_106_500, book: 25_106_500 }, // 23,738,000 + 226,000 + 10,122,500 + 178,453.04 - 10,128,453.04 - 30,000
        balance: { treasury: { restricted: null, collateralReceived: null, positions: 10_092_500, accruedIncome: 178_453.04, payable: 10_128_453.04, assets: 34_234_953.04, liabilities: 10_128_453.04, netAssets: 24_106_500 } },
      },
    },
    {
      // Sold the same day at the bid, 101.20, T+1: clean 10,120,000 plus the same accrued interest, 178,453.04. Realized
      // 10,120,000 - 9,950,000 = 170,000. Bought and sold for the same settlement date: no interest accrues to Treasury.
      id: 'sell-delivered-note', covers: 'close', action: 'ticket', ticketOf: 'bond', owner: 'treasury', settlementCheck: false, // the note settles T+1 (Wednesday 15 to Thursday 16 April)
      instrument: 'bond', side: 'sell', qty: 10_000_000, from: 'calls',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'bond', qty: 10_000_000, estimate: 101.2, model: 'quoted-bid-ask', settleDate: '2026-04-16', cash: 10_298_453.04, accrued: 178_453.04, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000_000, avgPrice: 101.2 }] },
        events: [{ type: 'strategy.legs_added', owner: 'treasury' }, { type: 'trade.fill', summary: 'Sold 10,000,000 UST-4.25-MAY31 @ 101.20 USD (realized 170,000.00 USD)', owner: 'treasury' }],
        cash: { treasury: { USD: { unsettled: 170_000, availableToTrade: 23_908_000, availableToWithdraw: 13_609_546.96 } } }, // 10,298,453.04 - 10,128,453.04
        positions: [{ instrument: 'put', lot: 'puts', qty: -10_000_000 }],
        holdings: { bond: null },
        pending: [
          { instrument: 'bond', owner: 'treasury', dueDate: '2026-04-16', amount: -10_128_453.04, ccy: 'USD', into: 'cash' },
          { instrument: 'bond', owner: 'treasury', dueDate: '2026-04-16', amount: 10_298_453.04, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'put', dueDate: '2026-06-15', status: 'pending' }],
        pnl: { treasury: { realized: 90_000, unrealized: 15_000, couponInterest: 0, total: 104_000 }, book: { realized: 90_000, unrealized: 15_000, total: 104_000 } },
        nav: { treasury: 24_104_000, book: 25_104_000 }, // 23,738,000 + 226,000 + 10,298,453.04 - 10,128,453.04 - 30,000
        balance: { treasury: { positions: -30_000, accruedIncome: null, receivable: 10_298_453.04, assets: 34_232_453.04, netAssets: 24_104_000 } },
      },
    },
    { id: 'treasury-screens-after-delivery', covers: 'owner screens', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      id: 'settle-delivery-and-sale', covers: 'settlement', action: 'clock', to: at('2026-04-16'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 10,298,453.04 USD into settled cash', owner: 'treasury' },
          { type: 'settlement.pay', summary: 'paid 10,128,453.04 USD from settled cash', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 23_908_000, unsettled: 0, availableToTrade: 23_908_000, availableToWithdraw: 23_908_000 } } },
        pending: [],
        balance: { treasury: { cash: 23_908_000, receivable: null, payable: null, assets: 24_104_000, liabilities: 0, netAssets: 24_104_000 } }, // 23,908,000 + 226,000 - 30,000
      },
    },
    { id: 'friday-12-june', action: 'clock', to: at('2026-06-12'), expect: {} },
    {
      id: 'mark-put-higher', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 0.62, note: 'Dealer C mark, by hand, per 100 of face',
      expect: {
        positions: [{ instrument: 'put', lot: 'puts', price: 0.62, value: -62_000, unrealized: -17_000 }], // -10,000,000 x 0.62 x 0.01; + 45,000
        otc: [{ instrument: 'put', mark: 0.62, markValue: -62_000 }],
        pnl: { treasury: { unrealized: -17_000, total: 72_000 }, book: { unrealized: -17_000, total: 72_000 } }, // 90,000 - 1,000 - 17,000
        nav: { treasury: 24_072_000, book: 25_072_000 },
        balance: { treasury: { positions: -62_000, assets: 24_072_000, netAssets: 24_072_000 } },
      },
    },
    {
      // -62,000 requires 62,000; 30,000 is posted: 32,000 more.
      id: 'variation-margin-call', covers: 'variation margin', action: 'clock', to: eod('2026-06-12'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 32,000.00 USD posted. Netting set of 1 position marked at -62,000.00 USD; threshold 0.00 USD.', cash: { USD: -32_000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 23_876_000, margin: 258_000, availableToTrade: 23_876_000, availableToWithdraw: 23_876_000 } } },
        otc: [{ instrument: 'put', vmPosted: 62_000, vmExposure: -62_000 }],
        balance: { treasury: { cash: 23_876_000, margin: 258_000 } },
      },
    },
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'bond', date: '2026-06-15', value: 97.40, expect: {} },
    {
      // The note closed at 97.40 on 15 June, below the 98.00 strike: the put is assigned for cash, 0.60 per 100 of face:
      // 10,000,000 x 0.60 x 0.01 = 60,000, paid T+1. Realized 45,000 - 60,000 = -15,000. The 196,000 independent amount
      // and the 62,000 of variation margin come back.
      id: 'expires-in-the-money', covers: ['expiry', 'cash settlement', 'collateral'], action: 'clock', to: eod('2026-06-15'),
      expect: {
        events: [
          { type: 'option.cash_settled', summary: 'Assigned (cash settlement): 10,000,000 UST31-EP98 at 0.60 USD per 100 of face (fixing 97.40)', owner: 'treasury', date: '2026-06-15' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${BPUT_NAME} under its position-level terms: 196,000.00 USD (independent amount, the position ended)`, cash: { USD: 196_000 }, owner: 'treasury' },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 62,000.00 USD returned to us. The last position of the netting set ended.', cash: { USD: 62_000 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 24_134_000, margin: 0, unsettled: -60_000, availableToTrade: 24_074_000, availableToWithdraw: 24_074_000 } } }, // 23,876,000 + 196,000 + 62,000
        positions: [], holdings: { put: null }, otc: [], lifecycle: [],
        pending: [{ instrument: 'put', owner: 'treasury', dueDate: '2026-06-16', amount: -60_000, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 75_000, unrealized: 0, total: 74_000 }, book: { realized: 75_000, unrealized: 0, total: 74_000 } }, // 90,000 - 15,000; - 1,000
        nav: { treasury: 24_074_000, book: 25_074_000 },
        balance: { treasury: { cash: 24_134_000, margin: null, positions: null, payable: 60_000, assets: 24_134_000, liabilities: 60_000, netAssets: 24_074_000 } },
      },
    },
    {
      id: 'settle-cash-settlement', covers: 'settlement', action: 'clock', to: at('2026-06-16'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 60,000.00 USD from settled cash', cash: { USD: -60_000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 24_074_000, unsettled: 0 } } },
        pending: [],
        balance: { treasury: { cash: 24_074_000, payable: null, assets: 24_074_000, liabilities: 0 } },
      },
    },
    { id: 'treasury-screens-closed', covers: 'owner screens', action: 'owner_screens', owner: 'treasury', expect: {} },
  ],
};

// ---------------------------------------------------------------------------------------------
// fx_option
// ---------------------------------------------------------------------------------------------
// A European EUR call / JPY put on 1,000,000 EUR struck at 165.00 JPY per EUR, expiring Wednesday 3 June 2026, physical
// delivery (both currencies exchanged on the spot value date), bought by the Account from Dealer D. The premium is
// stated in the premium currency, JPY per EUR of notional: 2.40 x 1,000,000 = 2,400,000 JPY. Collateral: a CSA with
// Dealer D in US dollars (base and collateral currency USD; variation margin, no threshold, minimum transfer 10,000),
// so the JPY mark is converted to USD for every call. The Book reports in USD; every reporting figure below is the JPY
// amount at the USD/JPY fixture of 150 (EUR/USD 1.08, then 1.12 from 2 June: EUR/JPY 162.00, then 168.00).
//
// Early exercise is refused (European). At expiry the pair closes at 168.00: in the money, so the call is exercised
// automatically, which means paying 165,000,000 JPY for 1,000,000 EUR. The Account does not hold that much yen: the
// exchange is not made and the expiry item fails visibly; once Treasury transfers the yen it goes through on the next
// cycle, labelled as a simulated currency exchange, and settles on Friday 5 June (T+2 on the TARGET2 and Tokyo
// calendars). The option's 20,000 USD of intrinsic value arrives as currency: 1,000,000 EUR worth 1,120,000 USD for
// 165,000,000 JPY worth 1,100,000 USD.
const FX_PAIR = 'EUR/JPY spot';
const FX_CALL_NAME = 'EUR call / JPY put 165.00, 3 Jun 2026, European, physical (Dealer D)';
const fxOption = {
  productId: 'fx_option',
  title: 'EUR call / JPY put 165.00 on 1,000,000 EUR, premium in JPY, European, physical: exchanged at expiry once the yen is funded',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Trading currency = the premium currency (JPY); quantity = the base-currency notional (EUR)'],
    automaticInputs: ['EUR/JPY rate (pair quote fixture standing in for Shaffer MarketData) for the notional', 'USD/JPY and EUR/USD rates (FX fixtures) for every reporting-currency figure and for the variation margin in USD', 'premium settlement date, T+2 on the TARGET2 and Tokyo calendars', 'commission per EUR of notional (in JPY) from the Book fee schedule', 'variation margin from the CSA terms, the JPY mark converted to USD', 'expiry item settled against the EUR/JPY close for the expiration date (close fixture: the stated settlement price)', 'spot value date of the currency exchange on the TARGET2 and Tokyo calendars'],
    manualInputs: ['premium agreed with the dealer in JPY per EUR (stated fill price)', 'marks in JPY per EUR, entered by hand (Manual entry)', 'early exercise of a European option, refused', 'yen moved from Treasury to fund the exchange (Transfer cash)'],
    settlement: 'Premium in JPY T+2 on TARGET2 + Tokyo; on exercise 1,000,000 EUR is received and 165,000,000 JPY paid on the spot value date (T+2), only when the yen is held',
    lifecycle: 'Early exercise refused (European); expiry item on 3 June: in the money, automatic physical exercise; the exchange fails visibly while the Account lacks the yen and is retried each cycle; it goes through once funded; nothing scheduled afterwards',
    accounting: 'Premium in JPY on the EUR notional, realized on exercise; the exchange at the strike books EUR and JPY at their USD rates, the difference (the intrinsic value) reported as currency P&L; commission expensed in JPY; all reporting figures in USD at the FX fixtures',
    collateral: 'Agreement "CSA Dealer D" in USD: no independent amount for a bought option; variation margin on the JPY mark converted to USD, threshold 0, minimum transfer 10,000; received as restricted USD with a liability; part returned on a lower mark, the rest when the option is exercised',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] }, // TARGET2 and Tokyo: no holiday between 2 and 4 March 2026
  book: {
    name: 'Matrix FX option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'JPY', amount: 210_000_000 }],
    account: { name: 'Macro', funding: [{ ccy: 'USD', amount: 200_000 }, { ccy: 'JPY', amount: 15_000_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.03, minimum: 0, bps: 0 }, fx: NO_FEE }, fill: FILL, settlement: { otcoption: 2, fx: 2 } }, // 0.03 JPY per EUR of notional
  },
  fx: { 'USD/JPY': 150, 'EUR/USD': 1.08 },
  instruments: {
    pair: { productId: 'fx_spot', name: FX_PAIR, symbol: 'EURJPY', marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: 'JPY', terms: { base: 'EUR', quote: 'JPY', settleDays: 2 } },
  },
  quotes: { pair: { bid: 161.98, ask: 162.02, last: 162, bidSize: 50_000_000, askSize: 50_000_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 200_000, restricted: 0, margin: 0, availableToTrade: 200_000 }, JPY: { settled: 15_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 15_000_000, availableToWithdraw: 15_000_000 } },
      treasury: { USD: { settled: 800_000 }, JPY: { settled: 195_000_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 300_000, treasury: 2_100_000, book: 2_400_000 }, // 200,000 + 15,000,000 / 150; 800,000 + 195,000,000 / 150
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      id: 'agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer D', counterparty: 'Dealer D', kind: 'bilateral', baseCcy: 'USD', postingCcy: 'USD', independentAmount: { type: 'pct', pct: 0.05 }, variationMargin: true, threshold: 0, minimumTransfer: 10_000 },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer D with Dealer D (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    {
      id: 'register-call', action: 'register_instrument', as: 'call',
      draft: {
        productId: 'fx_option', name: FX_CALL_NAME, symbol: 'EURJPY-C165-JUN26', marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: 'JPY', underlying: 'pair', multiplier: 1,
        conventions: { settlementCalendar: 'TARGET+JP', paymentCalendar: 'TARGET+JP' },
        terms: { right: 'C', strike: 165, expiration: '2026-06-03', optionType: 'vanilla', exercise: 'european', settlement: 'physical', counterparty: 'Dealer D', collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' } },
      },
      expect: {},
    },
    otcTicket({
      id: 'buy-call', covers: ['open', 'collateral'], instrument: 'call', side: 'buy', qty: 1_000_000, premium: 2.40, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 1_000_000, estimate: 2.4, model: 'stated-price', settleDate: '2026-03-04', calendar: 'TARGET+JP',
            cash: -2_400_000, // 1,000,000 EUR x 2.40 JPY
            fees: 30_000, // 1,000,000 x 0.03 JPY
            notional: 162_000_000 }], // 1,000,000 x 162.00 JPY
          cash: { JPY: { purchases: 2_400_000, fees: 30_000, margin: 0, required: 2_430_000, available: 15_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 2.4, fills: [{ qty: 1_000_000, price: 2.4, model: 'stated-price', settleDate: '2026-03-04' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 EURJPY-C165-JUN26 @ 2.40 JPY', owner: 'account', date: '2026-03-02' }],
        cash: { account: { JPY: { settled: 15_000_000, unsettled: -2_430_000, availableToTrade: 12_570_000, availableToWithdraw: 12_570_000 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 2.4, cost: 2_400_000, price: null, value: null, unrealized: null, provisional: true, notional: 162_000_000, margin: 0 }],
        holdings: { call: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -2_430_000, ccy: 'JPY', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-03', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', owner: 'account', qty: 1_000_000, basis: 'agreement', agreement: 'CSA Dealer D', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -200, fx: 0, unrealized: 0, total: -200 }, book: { commissions: -200, total: -200 } }, // 30,000 JPY / 150
        nav: { account: 299_800, book: 2_399_800 }, // 200,000 + (15,000,000 - 2,430,000 + 2,400,000 at cost) / 150
        provisional: { account: true, book: true },
        balance: { account: { cash: 300_000, payable: 16_200, positions: 16_000, assets: 316_000, liabilities: 16_200, netAssets: 299_800, local: { JPY: { cash: 15_000_000, payable: 2_430_000, positions: 2_400_000 } } } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 4.50, note: 'Dealer D mark, JPY per EUR, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 4.5, value: 4_500_000, unrealized: 2_100_000, provisional: false, priceSource: 'Manual entry' }], // 1,000,000 x 4.50; - 2,400,000
        otc: [{ instrument: 'call', mark: 4.5, markValue: 4_500_000 }],
        pnl: { account: { unrealized: 14_000, total: 13_800 }, book: { unrealized: 14_000, total: 13_800 } }, // 2,100,000 / 150
        nav: { account: 313_800, book: 2_413_800 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 30_000, assets: 330_000, netAssets: 313_800, local: { JPY: { positions: 4_500_000 } } } }, // 4,500,000 / 150
      },
    },
    {
      // The mark, 4,500,000 JPY, is 30,000 USD at 150: no threshold, so Dealer D posts 30,000 USD (restricted, owed back).
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-03-02'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer D" (Dealer D): 30,000.00 USD received. Netting set of 1 position marked at 30,000.00 USD; threshold 0.00 USD.', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 200_000, restricted: 30_000, availableToTrade: 200_000 } } },
        otc: [{ instrument: 'call', vmHeld: 30_000, vmPosted: 0, vmExposure: 30_000, vmCcy: 'USD', vmStatus: 'ok' }],
        balance: { account: { cash: 300_000, restricted: 30_000, collateralReceived: 30_000, assets: 360_000, liabilities: 46_200, netAssets: 313_800 } },
      },
    },
    {
      id: 'settle-premium', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,430,000 JPY from settled cash', cash: { JPY: -2_430_000 } }],
        cash: { account: { JPY: { settled: 12_570_000, unsettled: 0, availableToTrade: 12_570_000, availableToWithdraw: 12_570_000 } } },
        pending: [],
        balance: { account: { cash: 283_800, payable: null, assets: 343_800, liabilities: 30_000, local: { JPY: { cash: 12_570_000, payable: null } } } }, // 200,000 + 12,570,000 / 150
      },
    },
    {
      id: 'early-exercise-refused', covers: 'exercise style', action: 'lifecycle', lot: 'calls', body: { action: 'exercise', contracts: 1_000_000 },
      status: 'blocked', reason: 'A European option is exercised at expiration only.',
      expect: { refused: 'This option is European: it can only be exercised at expiration.' },
    },
    // Held across Golden Week (29 April, 3 to 6 May: Tokyo holidays) and 1 May (a TARGET2 closing day).
    { id: 'after-golden-week', covers: 'holiday', action: 'clock', to: at('2026-05-07'), expect: {} },
    { id: 'tuesday-2-june', action: 'clock', to: at('2026-06-02'), expect: {} },
    {
      id: 'euro-rises', action: 'fx_rate', pair: 'EUR/USD', rate: 1.12,
      expect: {}, // nothing held in EUR yet
    },
    {
      id: 'pair-rises', action: 'quote', instrument: 'pair', quote: { bid: 167.98, ask: 168.02, last: 168, bidSize: 50_000_000, askSize: 50_000_000 },
      expect: { positions: [{ instrument: 'call', lot: 'calls', notional: 168_000_000 }] }, // 1,000,000 x 168.00
    },
    {
      id: 'mark-call-intrinsic', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 3.00, note: 'Dealer D mark, JPY per EUR, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 3, value: 3_000_000, unrealized: 600_000 }], // 1,000,000 x 3.00; - 2,400,000
        otc: [{ instrument: 'call', mark: 3, markValue: 3_000_000 }],
        pnl: { account: { unrealized: 4_000, total: 3_800 }, book: { unrealized: 4_000, total: 3_800 } }, // 600,000 / 150
        nav: { account: 303_800, book: 2_403_800 },
        balance: { account: { positions: 20_000, assets: 333_800, netAssets: 303_800, local: { JPY: { positions: 3_000_000 } } } },
      },
    },
    {
      // Marked at 20,000 USD; 30,000 is held: 10,000 goes back to Dealer D (not below the 10,000 minimum transfer).
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-06-02'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer D" (Dealer D): 10,000.00 USD returned to the counterparty. Netting set of 1 position marked at 20,000.00 USD; threshold 0.00 USD.', owner: 'account' }],
        cash: { account: { USD: { restricted: 20_000 } } },
        otc: [{ instrument: 'call', vmHeld: 20_000, vmExposure: 20_000 }],
        balance: { account: { restricted: 20_000, collateralReceived: 20_000, assets: 323_800, liabilities: 20_000 } },
      },
    },
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'pair', date: '2026-06-03', value: 168, expect: {} },
    {
      // In the money (168.00 > 165.00): the call is exercised automatically, which needs 165,000,000 JPY. The Account
      // holds 12,570,000 JPY: nothing is exchanged and the item fails, visibly, to be retried each cycle.
      id: 'exercise-unfunded', covers: ['expiry', 'physical settlement', 'funding'], action: 'clock', to: eod('2026-06-03'),
      expect: {
        events: [],
        // Listed with the failures (Accounting, Failed tab), with the reason, not among the pending items.
        lifecycle: [],
        lifecycleFailures: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-03', status: 'failed', reason: /needs 165,000,000 JPY to deliver against 1,000,000\.00 EUR, and Macro has 12,570,000 JPY of JPY available/ }],
        failed: { lifecycle: 1 },
      },
    },
    {
      // Treasury moves 165,000,000 JPY (1,100,000 USD) to the Account; on the next cycle the exercise goes through: the call
      // closes at zero (its 2,400,000 JPY premium, 16,000 USD, is realized) and the currencies are exchanged at the strike
      // for value Friday 5 June. The 20,000 USD Dealer D posted against the call goes back.
      id: 'fund-yen-then-exchange', covers: ['funding', 'physical settlement', 'collateral'], action: 'transfer', from: 'treasury', to: 'account', ccy: 'JPY', amount: 165_000_000,
      expect: {
        events: [
          { type: 'transfer.funding', summary: 'Treasury funding: 165,000,000 JPY from Treasury to Macro' },
          { type: 'option.exercised', summary: 'Exercised: 1,000,000 EURJPY-C165-JUN26 at strike 165', owner: 'account', date: '2026-06-03' },
          { type: 'option.delivery', summary: 'Simulated currency exchange on exercise of EURJPY-C165-JUN26: bought 1,000,000.00 EUR against 165,000,000 JPY at strike 165, value 2026-06-05', owner: 'account' },
          { type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer D" (Dealer D): 20,000.00 USD returned to the counterparty. The last position of the netting set ended.', owner: 'account' },
        ],
        cash: {
          account: { USD: { restricted: 0 }, JPY: { settled: 177_570_000, unsettled: -165_000_000, availableToTrade: 12_570_000, availableToWithdraw: 12_570_000 }, EUR: { settled: 0, unsettled: 1_000_000, availableToTrade: 1_000_000, availableToWithdraw: 0 } },
          treasury: { JPY: { settled: 30_000_000 } },
        },
        positions: [], holdings: { call: null }, otc: [], lifecycle: [], lifecycleFailures: [], failed: { lifecycle: 0 },
        pending: [
          { owner: 'account', dueDate: '2026-06-05', amount: -165_000_000, ccy: 'JPY', into: 'cash' },
          { owner: 'account', dueDate: '2026-06-05', amount: 1_000_000, ccy: 'EUR', into: 'cash' },
        ],
        // Realized -16,000 (premium); currency +20,000: 1,000,000 EUR at 1.12 = 1,120,000 for 165,000,000 JPY at 150 = 1,100,000.
        pnl: { account: { realized: -16_000, fx: 20_000, unrealized: 0, total: 3_800 }, book: { realized: -16_000, fx: 20_000, unrealized: 0, total: 3_800 } },
        nav: { account: 1_403_800, treasury: 1_000_000, book: 2_403_800 }, // 200,000 + (177,570,000 - 165,000,000) / 150 + 1,000,000 x 1.12; 800,000 + 30,000,000 / 150
        balance: { account: { cash: 1_383_800, receivable: 1_120_000, payable: 1_100_000, positions: null, restricted: null, collateralReceived: null, assets: 2_503_800, liabilities: 1_100_000, netAssets: 1_403_800, // 200,000 + 177,570,000 / 150
          local: { JPY: { cash: 177_570_000, payable: 165_000_000, positions: null }, EUR: { receivable: 1_000_000 } } } },
      },
    },
    {
      id: 'value-date', covers: 'settlement', action: 'clock', to: at('2026-06-05'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 1,000,000.00 EUR into settled cash', cash: { EUR: 1_000_000 } },
          { type: 'settlement.pay', summary: 'paid 165,000,000 JPY from settled cash', cash: { JPY: -165_000_000 } },
        ],
        cash: { account: { JPY: { settled: 12_570_000, unsettled: 0, availableToTrade: 12_570_000, availableToWithdraw: 12_570_000 }, EUR: { settled: 1_000_000, unsettled: 0, availableToTrade: 1_000_000, availableToWithdraw: 1_000_000 } } },
        pending: [],
        balance: { account: { cash: 1_403_800, receivable: null, payable: null, assets: 1_403_800, liabilities: 0, // 200,000 + 83,800 + 1,120,000
          local: { JPY: { cash: 12_570_000, payable: null }, EUR: { cash: 1_000_000, receivable: null } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// commodity_option
// ---------------------------------------------------------------------------------------------
// Two OTC options on WTI crude oil at Cushing (pipeline barrels, USD per barrel), quantity in barrels, dealt by the
// Account with Dealer E under one CSA whose netting set is the Account (both positions net against each other;
// independent amount 10% of strike notional on a written option; variation margin over a 100,000 threshold, minimum
// transfer 25,000):
//   - a European 75 call, cash-settled against the 28 May 2026 close (the stated settlement price), bought on 50,000
//     barrels; half terminated at a stated amount; the rest finishes in the money: 2.80 a barrel;
//   - an American 68 put, physical delivery of barrels, written on 50,000 barrels; crude falls, the netting set goes
//     beyond the threshold and variation margin is posted; the dealer exercises early (simulated assignment, recorded
//     by hand): 50,000 barrels are delivered to the Account at 68 (simulated, T+2) and then sold.
const OIL_NAME = 'WTI crude oil, Cushing, Oklahoma (pipeline barrels, Red River)';
const OIL_CALL = 'WTI Cushing 75 call, 28 May 2026, European, cash (Dealer E)';
const OIL_PUT = 'WTI Cushing 68 put, 28 May 2026, American, physical (Dealer E)';
const commodityOption = {
  productId: 'commodity_option',
  title: 'WTI crude OTC options netted under one CSA: 75 call (European, cash) bought; 68 put (American, physical barrels) written and assigned early',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['crude price per barrel (quote fixture standing in for Shaffer MarketData) for the notional and the barrels delivered', 'premium settlement date, T+2 on the US calendar; barrels delivered and sold settle T+2 (settlement.spot = 2)', 'commission per barrel from the Book fee schedule', 'independent amount on the written put and variation margin on the Account netting set, from the CSA terms', 'expiry item settled against the crude close for the expiration date (close fixture: the stated settlement price)'],
    manualInputs: ['premium per barrel agreed with the dealer (stated fill price)', 'marks per barrel entered by hand (Manual entry)', 'early assignment of the written American put, recorded by hand (Lifecycle, Early assignment)', 'termination of half the call at a stated amount per barrel'],
    settlement: 'Premium and commission T+2 on the US calendar; barrels delivered at the strike T+2, sold T+2; cash settlement of the call T+1',
    lifecycle: 'Early assignment of the American put with a simulated delivery of 50,000 barrels at 68; the call partly terminated, the rest cash-settled in the money at expiry; held across Good Friday and Memorial Day; nothing scheduled afterwards',
    accounting: 'Premium per barrel x barrels; average premium; premium realized on termination, assignment and expiry; barrels delivered carried at the strike and sold at the bid; commission expensed; marks by hand drive unrealized P&L',
    collateral: 'Agreement "CSA Dealer E", netting scope the Account: the two positions form one netting set; independent amount on the written put only, 10% x 50,000 x 68 = 340,000, returned on assignment; variation margin posted when the set fell 40,000 beyond its 100,000 threshold, returned when it came back inside',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] }, // US calendar, T+2 for the premium and for the barrels; no holiday in the trade weeks
  book: {
    name: 'Matrix commodity option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 8_000_000 }],
    account: { name: 'Energy', funding: [{ ccy: 'USD', amount: 5_000_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.01, minimum: 0, bps: 0 }, spot: { perUnit: 0.02, minimum: 0, bps: 0 } }, fill: FILL, settlement: { otcoption: 2, spot: 2 } }, // 0.01 a barrel; 0.02 a barrel of crude
  },
  instruments: {
    oil: { productId: 'crude_oil', name: OIL_NAME, symbol: 'WTI-CUSH-RR', marketView: 'US_CASH', venue: 'Red River Crude Marketing (OTC)', venueType: 'otc', venueCountry: 'US', issuer: 'Red River Crude Marketing LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: { quantityUnit: 'barrels', priceUnits: 'USD per barrel' } },
  },
  quotes: { oil: { bid: 71.38, ask: 71.42, last: 71.40, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 5_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 5_000_000, availableToWithdraw: 5_000_000 } },
      treasury: { USD: { settled: 3_000_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 5_000_000, treasury: 3_000_000, book: 8_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      id: 'agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer E', counterparty: 'Dealer E', kind: 'bilateral', independentAmount: { type: 'pct', pct: 0.10 }, variationMargin: true, threshold: 100_000, minimumTransfer: 25_000, nettingScope: 'account' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer E with Dealer E (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    {
      id: 'register-call', action: 'register_instrument', as: 'call',
      draft: { productId: 'commodity_option', name: OIL_CALL, symbol: 'WTI-C75-MAY26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'oil', multiplier: 1,
        terms: { right: 'C', strike: 75, expiration: '2026-05-28', optionType: 'vanilla', exercise: 'european', settlement: 'cash', counterparty: 'Dealer E', collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' } } },
      expect: {},
    },
    {
      id: 'register-put', action: 'register_instrument', as: 'put',
      draft: { productId: 'commodity_option', name: OIL_PUT, symbol: 'WTI-P68-MAY26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'oil', multiplier: 1,
        terms: { right: 'P', strike: 68, expiration: '2026-05-28', optionType: 'vanilla', exercise: 'american', settlement: 'physical', counterparty: 'Dealer E', collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' } } },
      expect: {},
    },
    otcTicket({
      id: 'buy-call', covers: ['open', 'collateral'], instrument: 'call', side: 'buy', qty: 50_000, premium: 3.10, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 50_000, estimate: 3.1, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US',
            cash: -155_000, fees: 500, notional: 3_570_000 }], // 50,000 x 3.10; 50,000 x 0.01; 50,000 x 71.40
          cash: { USD: { purchases: 155_000, fees: 500, margin: 0, required: 155_500, available: 5_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 50_000, avgPrice: 3.1 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 50,000 WTI-C75-MAY26 @ 3.10 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 5_000_000, unsettled: -155_500, availableToTrade: 4_844_500, availableToWithdraw: 4_844_500 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 50_000, avgCost: 3.1, cost: 155_000, price: null, value: null, unrealized: null, provisional: true, notional: 3_570_000, margin: 0 }],
        holdings: { call: { long: 50_000, short: 0, net: 50_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -155_500, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-05-28', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', owner: 'account', qty: 50_000, basis: 'agreement', agreement: 'CSA Dealer E', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -500, unrealized: 0, total: -500 } },
        nav: { account: 4_999_500, book: 7_999_500 }, // unpriced: at cost
        provisional: { account: true, book: true },
        balance: { account: { cash: 5_000_000, payable: 155_500, positions: 155_000, assets: 5_155_000, liabilities: 155_500, netAssets: 4_999_500 } },
      },
    }),
    { id: 'half-an-hour-later', action: 'clock', to: at('2026-03-02', '15:30'), expect: {} },
    otcTicket({
      // Written: independent amount 10% x 50,000 x 68 x 1 = 340,000, posted at the fill.
      id: 'write-put', covers: ['write', 'collateral'], instrument: 'put', side: 'sell', qty: 50_000, premium: 1.90, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 50_000, estimate: 1.9, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: 95_000, fees: 500, notional: 3_570_000 }],
          cash: { USD: { proceeds: 95_000, fees: 500, margin: 340_000, required: 340_500, available: 4_844_500, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 50_000, avgPrice: 1.9 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 50,000 WTI-P68-MAY26 @ 1.90 USD', owner: 'account' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${OIL_PUT} under "CSA Dealer E" (Dealer E): 340,000.00 USD (independent amount, 10.00% of 3,400,000.00 USD notional)`, cash: { USD: -340_000 } },
        ],
        cash: { account: { USD: { settled: 4_660_000, unsettled: -61_000, margin: 340_000, availableToTrade: 4_599_000, availableToWithdraw: 4_504_500 } } }, // -155,500 + 94,500; 4,660,000 - 155,500
        positions: [
          { instrument: 'call', lot: 'calls', qty: 50_000 },
          { instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -50_000, avgCost: 1.9, cost: -95_000, price: null, value: null, unrealized: null, provisional: true, notional: 3_570_000, margin: 340_000 },
        ],
        holdings: { put: { long: 0, short: 50_000, net: -50_000 } },
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -155_500, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-03-04', amount: 94_500, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-05-28', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-05-28', status: 'pending' }],
        otc: [{ instrument: 'call' }, { instrument: 'put', lot: 'puts', qty: -50_000, basis: 'agreement', agreement: 'CSA Dealer E', iaRequired: 340_000, iaPosted: 340_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { commissions: -1_000, total: -1_000 } },
        nav: { account: 4_999_000, book: 7_999_000 }, // 4,660,000 + 340,000 + 94,500 - 155,500 + 155,000 - 95,000
        balance: { account: { cash: 4_660_000, margin: 340_000, receivable: 94_500, positions: 60_000, assets: 5_154_500, netAssets: 4_999_000 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 3.50, note: 'Dealer E mark per barrel, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 3.5, value: 175_000, unrealized: 20_000, provisional: false }, { instrument: 'put', lot: 'puts' }], // 50,000 x 3.50; - 155,000
        otc: [{ instrument: 'call', mark: 3.5, markValue: 175_000 }, { instrument: 'put' }],
        pnl: { account: { unrealized: 20_000, total: 19_000 } },
        nav: { account: 5_019_000, book: 8_019_000 },
        balance: { account: { positions: 80_000, assets: 5_174_500, netAssets: 5_019_000 } }, // 175,000 - 95,000 (put at cost)
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 1.60, note: 'Dealer E mark per barrel, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 1.6, value: -80_000, unrealized: 15_000, provisional: false }], // -50,000 x 1.60; + 95,000
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 1.6, markValue: -80_000 }],
        pnl: { account: { unrealized: 35_000, total: 34_000 } },
        nav: { account: 5_034_000, book: 8_034_000 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 95_000, assets: 5_189_500, netAssets: 5_034_000 } },
      },
    },
    {
      // One netting set for the Account: 175,000 - 80,000 = +95,000, inside the 100,000 threshold. Nothing moves.
      id: 'netting-set-inside-threshold', covers: 'variation margin', action: 'clock', to: eod('2026-03-02'),
      expect: { events: [], otc: [{ instrument: 'call', vmExposure: 95_000, vmStatus: 'ok', vmPosted: 0, vmHeld: 0 }, { instrument: 'put', vmExposure: 95_000, vmStatus: 'ok', vmPosted: 0, vmHeld: 0 }] },
    },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 94,500.00 USD into settled cash', cash: { USD: 94_500 } },
          { type: 'settlement.pay', summary: 'paid 155,500.00 USD from settled cash', cash: { USD: -155_500 } },
        ],
        cash: { account: { USD: { settled: 4_599_000, unsettled: 0, availableToTrade: 4_599_000, availableToWithdraw: 4_599_000 } } },
        pending: [],
        balance: { account: { cash: 4_599_000, receivable: null, payable: null, assets: 5_034_000, liabilities: 0 } },
      },
    },
    { id: 'monday-16-march', action: 'clock', to: at('2026-03-16'), expect: {} },
    {
      id: 'crude-falls', action: 'quote', instrument: 'oil', quote: { bid: 66.48, ask: 66.52, last: 66.50, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: { positions: [{ instrument: 'call', lot: 'calls', notional: 3_325_000 }, { instrument: 'put', lot: 'puts', notional: 3_325_000 }] }, // 50,000 x 66.50
    },
    {
      id: 'mark-call-lower', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 0.40, note: 'Dealer E mark per barrel, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 0.4, value: 20_000, unrealized: -135_000 }, { instrument: 'put', lot: 'puts' }],
        otc: [{ instrument: 'call', mark: 0.4, markValue: 20_000 }, { instrument: 'put' }],
        pnl: { account: { unrealized: -120_000, total: -121_000 } }, // -135,000 + 15,000
        nav: { account: 4_879_000, book: 7_879_000 },
        balance: { account: { positions: -60_000, assets: 4_879_000, netAssets: 4_879_000 } },
      },
    },
    {
      id: 'mark-put-higher', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 3.20, note: 'Dealer E mark per barrel, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 3.2, value: -160_000, unrealized: -65_000 }],
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 3.2, markValue: -160_000 }],
        pnl: { account: { unrealized: -200_000, total: -201_000 } }, // -135,000 - 65,000
        nav: { account: 4_799_000, book: 7_799_000 }, // 4,599,000 + 340,000 + 20,000 - 160,000
        balance: { account: { positions: -140_000, assets: 4_799_000, netAssets: 4_799_000 } },
      },
    },
    {
      // The set: 20,000 - 160,000 = -140,000, 40,000 beyond the 100,000 threshold (and above the 25,000 minimum transfer).
      id: 'variation-margin-posted', covers: 'variation margin', action: 'clock', to: eod('2026-03-16'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer E" (Dealer E): 40,000.00 USD posted. Netting set of 2 positions marked at -140,000.00 USD; threshold 100,000.00 USD.', cash: { USD: -40_000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 4_559_000, margin: 380_000, availableToTrade: 4_559_000, availableToWithdraw: 4_559_000 } } },
        otc: [{ instrument: 'call', vmPosted: 40_000, vmExposure: -140_000 }, { instrument: 'put', vmPosted: 40_000, vmExposure: -140_000 }],
        balance: { account: { cash: 4_559_000, margin: 380_000 } },
      },
    },
    { id: 'tuesday-17-march', action: 'clock', to: at('2026-03-17'), expect: {} },
    {
      // The dealer exercises the American put early (simulated, recorded by hand). The put closes at zero: its 95,000
      // premium is realized. 50,000 barrels are delivered to the Account at 68: 3,400,000, T+2 (Thursday 19 March). The
      // 340,000 independent amount comes back; the 40,000 of variation margin stays with the set until the next valuation.
      id: 'early-assignment', covers: ['early assignment', 'physical settlement', 'collateral'], action: 'lifecycle', lot: 'puts', body: { action: 'assign', contracts: 50_000 },
      expect: {
        events: [
          { type: 'option.assigned', summary: 'Assigned: 50,000 WTI-P68-MAY26 at strike 68', owner: 'account', date: '2026-03-17' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 50,000 WTI-CUSH-RR at strike 68 on assignment of WTI-P68-MAY26/, owner: 'account' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${OIL_PUT} under "CSA Dealer E" (Dealer E): 340,000.00 USD (independent amount, the position ended)`, cash: { USD: 340_000 } },
        ],
        cash: { account: { USD: { settled: 4_899_000, margin: 40_000, unsettled: -3_400_000, availableToTrade: 1_499_000, availableToWithdraw: 1_499_000 } } },
        positions: [
          { instrument: 'call', lot: 'calls', qty: 50_000 },
          { instrument: 'oil', lot: 'puts', owner: 'account', direction: 'long', qty: 50_000, avgCost: 68, cost: 3_400_000, price: 66.5, value: 3_325_000, unrealized: -75_000 }, // 50,000 x 66.50 - 3,400,000
        ],
        holdings: { put: null, oil: { long: 50_000, short: 0, net: 50_000 } },
        pending: [{ instrument: 'oil', owner: 'account', dueDate: '2026-03-19', amount: -3_400_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-05-28', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', vmPosted: 40_000 }],
        pnl: { account: { realized: 95_000, unrealized: -210_000, total: -116_000 } }, // -135,000 - 75,000; 95,000 - 1,000 - 210,000
        nav: { account: 4_884_000, book: 7_884_000 }, // 4,899,000 + 40,000 + 20,000 + 3,325,000 - 3,400,000
        balance: { account: { cash: 4_899_000, margin: 40_000, payable: 3_400_000, positions: 3_345_000, assets: 8_284_000, liabilities: 3_400_000, netAssets: 4_884_000 } },
      },
    },
    {
      // The set is now the call alone, marked at +20,000: inside the threshold, so the 40,000 comes back.
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-03-17'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer E" (Dealer E): 40,000.00 USD returned to us. Netting set of 1 position marked at 20,000.00 USD; threshold 100,000.00 USD.', cash: { USD: 40_000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 4_939_000, margin: 0, availableToTrade: 1_539_000, availableToWithdraw: 1_539_000 } } },
        otc: [{ instrument: 'call', vmPosted: 0, vmExposure: 20_000 }],
        balance: { account: { cash: 4_939_000, margin: null, assets: 8_284_000 } },
      },
    },
    {
      id: 'settle-delivery', covers: 'settlement', action: 'clock', to: at('2026-03-19'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 3,400,000.00 USD from settled cash', cash: { USD: -3_400_000 } }],
        cash: { account: { USD: { settled: 1_539_000, unsettled: 0, availableToTrade: 1_539_000, availableToWithdraw: 1_539_000 } } },
        pending: [],
        balance: { account: { cash: 1_539_000, payable: null, assets: 4_884_000, liabilities: 0 } },
      },
    },
    {
      // The barrels sold at the bid, 66.48, T+2: 3,324,000 less 0.02 x 50,000 = 1,000. Realized 3,324,000 - 3,400,000.
      id: 'sell-delivered-barrels', covers: 'close', action: 'ticket', ticketOf: 'spot', instrument: 'oil', side: 'sell', qty: 50_000, from: 'puts',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'oil', qty: 50_000, estimate: 66.48, model: 'quoted-bid-ask', settleDate: '2026-03-23', cash: 3_324_000, fees: 1_000 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 50_000, avgPrice: 66.48 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 50,000 WTI-CUSH-RR @ 66.48 USD (realized -76,000.00 USD)' }],
        cash: { account: { USD: { unsettled: 3_323_000, availableToTrade: 4_862_000, availableToWithdraw: 1_539_000 } } },
        positions: [{ instrument: 'call', lot: 'calls', qty: 50_000 }],
        holdings: { oil: null },
        pending: [{ instrument: 'oil', owner: 'account', dueDate: '2026-03-23', amount: 3_323_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 19_000, commissions: -2_000, unrealized: -135_000, total: -118_000 } }, // 95,000 - 76,000
        nav: { account: 4_882_000, book: 7_882_000 }, // 1,539,000 + 3,323,000 + 20,000
        balance: { account: { receivable: 3_323_000, positions: 20_000, assets: 4_882_000, netAssets: 4_882_000 } },
      },
    },
    {
      id: 'settle-sale', covers: 'settlement', action: 'clock', to: at('2026-03-23'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 3,323,000.00 USD into settled cash', cash: { USD: 3_323_000 } }],
        cash: { account: { USD: { settled: 4_862_000, unsettled: 0, availableToTrade: 4_862_000, availableToWithdraw: 4_862_000 } } },
        pending: [],
        balance: { account: { cash: 4_862_000, receivable: null } },
      },
    },
    {
      // Half the call terminated with Dealer E at 0.25 a barrel: 25,000 x 0.25 = 6,250 less 250 commission. Realized
      // 25,000 x (0.25 - 3.10) = -71,250.
      id: 'terminate-half-call', covers: ['reduce', 'termination at a stated amount'], action: 'close', lot: 'calls', scope: 'strategy', percent: 50, order: { statedPrice: 0.25 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'call', qty: 25_000, estimate: 0.25, model: 'stated-price', settleDate: '2026-03-25', cash: 6_250, fees: 250 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 25_000, avgPrice: 0.25 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 25,000 WTI-C75-MAY26 @ 0.25 USD (realized -71,250.00 USD)' }],
        cash: { account: { USD: { unsettled: 6_000, availableToTrade: 4_868_000, availableToWithdraw: 4_862_000 } } },
        positions: [{ instrument: 'call', lot: 'calls', qty: 25_000, cost: 77_500, value: 10_000, unrealized: -67_500, notional: 1_662_500 }], // 25,000 x 0.40; 25,000 x 66.50
        holdings: { call: { long: 25_000, short: 0, net: 25_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-25', amount: 6_000, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'call', qty: 25_000, markValue: 10_000 }],
        pnl: { account: { realized: -52_250, commissions: -2_250, unrealized: -67_500, total: -122_000 } }, // 19,000 - 71,250
        nav: { account: 4_878_000, book: 7_878_000 }, // 4,862,000 + 6,000 + 10,000
        balance: { account: { receivable: 6_000, positions: 10_000, assets: 4_878_000, netAssets: 4_878_000 } },
      },
    },
    {
      id: 'settle-termination', covers: 'settlement', action: 'clock', to: at('2026-03-25'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 6,000.00 USD into settled cash', cash: { USD: 6_000 } }],
        cash: { account: { USD: { settled: 4_868_000, unsettled: 0, availableToTrade: 4_868_000, availableToWithdraw: 4_868_000 } } },
        pending: [],
        balance: { account: { cash: 4_868_000, receivable: null } },
      },
    },
    // Held across Good Friday (3 April) and Memorial Day (25 May).
    { id: 'wednesday-27-may', covers: 'holiday', action: 'clock', to: at('2026-05-27'), expect: {} },
    {
      id: 'mark-call-recovers', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 2.70, note: 'Dealer E mark per barrel, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 2.7, value: 67_500, unrealized: -10_000 }], // 25,000 x 2.70 - 77,500
        otc: [{ instrument: 'call', mark: 2.7, markValue: 67_500 }],
        pnl: { account: { unrealized: -10_000, total: -64_500 } },
        nav: { account: 4_935_500, book: 7_935_500 },
        balance: { account: { positions: 67_500, assets: 4_935_500, netAssets: 4_935_500 } },
      },
    },
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'oil', date: '2026-05-28', value: 77.80, expect: {} },
    {
      // Crude settled at 77.80 on 28 May: the call is in the money by 2.80 a barrel and is cash-settled: 25,000 x 2.80 =
      // 70,000, received T+1. Realized 70,000 - 77,500 = -7,500.
      id: 'expires-in-the-money', covers: ['expiry', 'cash settlement'], action: 'clock', to: eod('2026-05-28'),
      expect: {
        events: [{ type: 'option.cash_settled', summary: 'Exercised (cash settlement): 25,000 WTI-C75-MAY26 at 2.80 USD per unit (fixing 77.80)', owner: 'account', date: '2026-05-28' }],
        cash: { account: { USD: { unsettled: 70_000, availableToTrade: 4_938_000 } } },
        positions: [], holdings: { call: null }, otc: [], lifecycle: [],
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-05-29', amount: 70_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -59_750, unrealized: 0, total: -62_000 } }, // -52,250 - 7,500; - 2,250
        nav: { account: 4_938_000, book: 7_938_000 },
        balance: { account: { receivable: 70_000, positions: null, assets: 4_938_000, netAssets: 4_938_000 } },
      },
    },
    {
      id: 'settle-cash-settlement', covers: 'settlement', action: 'clock', to: at('2026-05-29'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 70,000.00 USD into settled cash', cash: { USD: 70_000 } }],
        cash: { account: { USD: { settled: 4_938_000, unsettled: 0, availableToTrade: 4_938_000, availableToWithdraw: 4_938_000 } } },
        pending: [],
        balance: { account: { cash: 4_938_000, receivable: null, assets: 4_938_000 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// crypto_option
// ---------------------------------------------------------------------------------------------
// Two OTC options on Meridian (MRD), a fictional cryptocurrency quoted in USD on a crypto trading platform, dealt with
// Dealer F on the 24x7 calendar (ALLDAYS): quantity in coins (fractional), premium in USD per coin, premium settled the
// next calendar day (settlement.otcoption = 1 on ALLDAYS). Both are traded on a Saturday; the put expires on a Sunday.
//   - an American 90,000 call, physical delivery of coins, bought on 1.5 MRD; position-level terms: variation margin
//     over a 10,000 threshold. Exercised early by hand when MRD trades at 96,000: 1.5 MRD delivered at 90,000 (a
//     simulated delivery that settles the same day, as coins do), then sold.
//   - a European 70,000 put, cash-settled against the MRD close of Sunday 31 May 2026, written on 2.5 MRD;
//     position-level terms: a fixed independent amount of 20,000 for the position, variation margin with no threshold
//     (minimum transfer 500). It lapses out of the money at expiry.
const MRD_CALL = 'MRD 90,000 call, 30 Apr 2026, American, physical (Dealer F)';
const MRD_PUT = 'MRD 70,000 put, Sun 31 May 2026, European, cash (Dealer F)';
const CRYPTO_CONVENTIONS = { tradingCalendar: 'ALLDAYS', settlementCalendar: 'ALLDAYS', paymentCalendar: 'ALLDAYS' };
const cryptoOption = {
  productId: 'crypto_option',
  title: 'Meridian (MRD) OTC options on the 24x7 calendar: American 90,000 call (physical coins) bought and exercised early; European 70,000 put (cash) written, expiring on a Sunday',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['MRD price (quote fixture standing in for Shaffer MarketData) for the notional and the coins delivered', 'premium settlement date, the next day on the 24x7 calendar (settlement.otcoption = 1); coins settle the same day (settlement.crypto = 0)', 'commission per coin from the Book fee schedule', 'independent amount and variation margin from the position-level terms', 'expiry item settled against the MRD close for the expiration date, a Sunday (close fixture: the stated settlement price)'],
    manualInputs: ['premium per coin agreed with the dealer (stated fill price)', 'marks per coin entered by hand (Manual entry)', 'early exercise of the American call (Lifecycle, Exercise)'],
    settlement: 'Premium and commission the next calendar day (ALLDAYS, Saturday to Sunday); coins delivered on exercise and coins sold settle the same day',
    lifecycle: 'Trades on a Saturday; early exercise by hand with a simulated delivery of 1.5 MRD at 90,000; the put lapses out of the money at its Sunday expiry; nothing scheduled afterwards',
    accounting: 'Premium per coin x coins (fractional); average premium; premium realized on exercise and on lapse; coins delivered carried at the strike; commission expensed; marks by hand drive unrealized P&L',
    collateral: 'Call (bought): position-level terms, variation margin over a 10,000 threshold (never reached); no independent amount for a bought option. Put (written): fixed independent amount 20,000, variation margin with no threshold and a 500 minimum transfer: posted on a Saturday, partly returned, the rest returned at expiry',
  },
  start: '2026-03-07T15:00:00.000Z', // Saturday 7 March 2026, 10:00 New York
  settlementCheck: { lag: 1, holidays: [] }, // the 24x7 calendar has no holiday and no weekend (crypto legs, same day, are exempted step by step)
  book: {
    name: 'Matrix crypto option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }],
    account: { name: 'Digital', funding: [{ ccy: 'USD', amount: 400_000 }] },
    settings: { fees: { otcoption: { perUnit: 5, minimum: 0, bps: 0 }, crypto: NO_FEE }, fill: FILL, settlement: { otcoption: 1, crypto: 0 } }, // 5.00 USD a coin
  },
  instruments: {
    mrd: { productId: 'cryptocurrency', name: 'Meridian', symbol: 'MRD', marketView: 'FOREIGN_CASH', venue: 'Aurora Digital (crypto trading platform)', venueType: 'otc', venueCountry: 'US', underlyingGeo: 'Global', tradingCcy: 'USD', terms: {} },
    call: {
      productId: 'crypto_option', name: MRD_CALL, symbol: 'MRD-C90K-30APR26', marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: 'USD', underlying: 'mrd', multiplier: 1, conventions: CRYPTO_CONVENTIONS,
      terms: { right: 'C', strike: 90_000, expiration: '2026-04-30', optionType: 'vanilla', exercise: 'american', settlement: 'physical', counterparty: 'Dealer F',
        collateralBasis: { type: 'position', independentAmount: { type: 'none' }, variationMargin: true, threshold: 10_000, minimumTransfer: 500 } },
    },
    put: {
      productId: 'crypto_option', name: MRD_PUT, symbol: 'MRD-P70K-31MAY26', marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: 'USD', underlying: 'mrd', multiplier: 1, conventions: CRYPTO_CONVENTIONS,
      terms: { right: 'P', strike: 70_000, expiration: '2026-05-31', optionType: 'vanilla', exercise: 'european', settlement: 'cash', counterparty: 'Dealer F',
        collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 20_000 }, variationMargin: true, threshold: 0, minimumTransfer: 500 } },
    },
  },
  quotes: { mrd: { bid: 79_990, ask: 80_010, last: 80_000, bidSize: 50, askSize: 50 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 400_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 400_000, availableToWithdraw: 400_000 } },
      treasury: { USD: { settled: 600_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 400_000, treasury: 600_000, book: 1_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    otcTicket({
      id: 'buy-call-on-saturday', covers: ['open', 'weekend trade'], instrument: 'call', side: 'buy', qty: 1.5, premium: 2_500, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 1.5, estimate: 2_500, model: 'stated-price', settleDate: '2026-03-08', calendar: 'ALLDAYS',
            cash: -3_750, fees: 7.5, notional: 120_000 }], // 1.5 x 2,500; 1.5 x 5.00; 1.5 x 80,000
          cash: { USD: { purchases: 3_750, fees: 7.5, margin: 0, required: 3_757.5, available: 400_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1.5, avgPrice: 2_500, fills: [{ qty: 1.5, price: 2_500, model: 'stated-price', settleDate: '2026-03-08', date: '2026-03-07' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1.5 MRD-C90K-30APR26 @ 2,500.00 USD', owner: 'account', date: '2026-03-07' }],
        cash: { account: { USD: { settled: 400_000, unsettled: -3_757.5, availableToTrade: 396_242.5, availableToWithdraw: 396_242.5 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 1.5, avgCost: 2_500, cost: 3_750, price: null, value: null, unrealized: null, provisional: true, notional: 120_000, margin: 0 }],
        holdings: { call: { long: 1.5, short: 0, net: 1.5 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-08', amount: -3_757.5, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-04-30', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', qty: 1.5, basis: 'position', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -7.5, unrealized: 0, total: -7.5 } },
        nav: { account: 399_992.5, book: 999_992.5 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 400_000, payable: 3_757.5, positions: 3_750, assets: 403_750, liabilities: 3_757.5, netAssets: 399_992.5 } },
      },
    }),
    { id: 'half-an-hour-later', action: 'clock', to: '2026-03-07T15:30:00.000Z', expect: {} },
    otcTicket({
      // Written: a fixed independent amount of 20,000 for the position, posted at the fill.
      id: 'write-put-on-saturday', covers: ['write', 'collateral'], instrument: 'put', side: 'sell', qty: 2.5, premium: 3_200, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 2.5, estimate: 3_200, model: 'stated-price', settleDate: '2026-03-08', calendar: 'ALLDAYS', cash: 8_000, fees: 12.5, notional: 200_000 }], // 2.5 x 3,200; 2.5 x 5.00; 2.5 x 80,000
          cash: { USD: { proceeds: 8_000, fees: 12.5, margin: 20_000, required: 20_012.5, available: 396_242.5, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 2.5, avgPrice: 3_200 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 2.5 MRD-P70K-31MAY26 @ 3,200.00 USD', owner: 'account' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${MRD_PUT} under its position-level terms: 20,000.00 USD (independent amount, fixed amount for the position)`, cash: { USD: -20_000 } },
        ],
        cash: { account: { USD: { settled: 380_000, unsettled: 4_230, margin: 20_000, availableToTrade: 384_230, availableToWithdraw: 376_242.5 } } }, // -3,757.50 + 7,987.50; 380,000 - 3,757.50
        positions: [
          { instrument: 'call', lot: 'calls', qty: 1.5 },
          { instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -2.5, avgCost: 3_200, cost: -8_000, price: null, value: null, unrealized: null, provisional: true, notional: 200_000, margin: 20_000 },
        ],
        holdings: { put: { long: 0, short: 2.5, net: -2.5 } },
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-03-08', amount: -3_757.5, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-03-08', amount: 7_987.5, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-04-30', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-05-31', status: 'pending' }],
        otc: [{ instrument: 'call' }, { instrument: 'put', lot: 'puts', qty: -2.5, basis: 'position', iaRequired: 20_000, iaPosted: 20_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { commissions: -20, total: -20 } },
        nav: { account: 399_980, book: 999_980 }, // 380,000 + 20,000 + 7,987.50 - 3,757.50 + 3,750 - 8,000
        balance: { account: { cash: 380_000, margin: 20_000, receivable: 7_987.5, payable: 3_757.5, positions: -4_250, assets: 403_737.5, liabilities: 3_757.5, netAssets: 399_980 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 2_900, note: 'Dealer F mark per coin, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 2_900, value: 4_350, unrealized: 600, provisional: false }, { instrument: 'put', lot: 'puts' }], // 1.5 x 2,900; - 3,750
        otc: [{ instrument: 'call', mark: 2_900, markValue: 4_350 }, { instrument: 'put' }],
        pnl: { account: { unrealized: 600, total: 580 } },
        nav: { account: 400_580, book: 1_000_580 },
        balance: { account: { positions: -3_650, assets: 404_337.5, netAssets: 400_580 } }, // 4,350 - 8,000 (put at cost)
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 3_000, note: 'Dealer F mark per coin, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 3_000, value: -7_500, unrealized: 500, provisional: false }], // -2.5 x 3,000; + 8,000
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 3_000, markValue: -7_500 }],
        pnl: { account: { unrealized: 1_100, total: 1_080 } },
        nav: { account: 401_080, book: 1_001_080 },
        provisional: { account: false, book: false },
        balance: { account: { positions: -3_150, assets: 404_837.5, netAssets: 401_080 } }, // 4,350 - 7,500
      },
    },
    {
      // Sunday, 10:00 New York (daylight time from today): the premiums settle on the 24x7 calendar.
      id: 'settle-premiums-on-sunday', covers: ['settlement', 'weekend'], action: 'clock', to: '2026-03-08T14:00:00.000Z',
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 7,987.50 USD into settled cash', cash: { USD: 7_987.5 }, date: '2026-03-08' },
          { type: 'settlement.pay', summary: 'paid 3,757.50 USD from settled cash', cash: { USD: -3_757.5 }, date: '2026-03-08' },
        ],
        cash: { account: { USD: { settled: 384_230, unsettled: 0, availableToTrade: 384_230, availableToWithdraw: 384_230 } } }, // 380,000 + 7,987.50 - 3,757.50
        pending: [],
        // Saturday's end of day made no collateral call: still nothing but the 20,000 independent amount is posted.
        otc: [{ instrument: 'call', vmPosted: 0, vmStatus: 'not_valued_yet' }, { instrument: 'put', vmPosted: 0, vmStatus: 'not_valued_yet' }],
        balance: { account: { cash: 384_230, receivable: null, payable: null, assets: 401_080, liabilities: 0 } },
      },
    },
    {
      // Collateral is valued in the end-of-day pass of New York business days, not at the weekend: the first valuation is
      // Monday's. Put marked at -7,500, no threshold: 7,500 posted. Call at +4,350: inside its 10,000 threshold.
      id: 'variation-margin-on-monday', covers: 'variation margin', action: 'clock', to: '2026-03-09T21:30:00.000Z',
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 7,500.00 USD posted. Netting set of 1 position marked at -7,500.00 USD; threshold 0.00 USD.', cash: { USD: -7_500 }, owner: 'account', date: '2026-03-09' }],
        cash: { account: { USD: { settled: 376_730, margin: 27_500, availableToTrade: 376_730, availableToWithdraw: 376_730 } } }, // 384,230 - 7,500
        otc: [{ instrument: 'call', vmPosted: 0, vmExposure: 4_350, vmStatus: 'ok' }, { instrument: 'put', vmPosted: 7_500, vmExposure: -7_500, vmStatus: 'ok' }],
        balance: { account: { cash: 376_730, margin: 27_500 } },
      },
    },
    { id: 'wednesday-8-april', action: 'clock', to: '2026-04-08T14:00:00.000Z', expect: {} },
    {
      id: 'mrd-rallies', action: 'quote', instrument: 'mrd', quote: { bid: 95_990, ask: 96_010, last: 96_000, bidSize: 50, askSize: 50 },
      expect: { positions: [{ instrument: 'call', lot: 'calls', notional: 144_000 }, { instrument: 'put', lot: 'puts', notional: 240_000 }] }, // 1.5 x 96,000; 2.5 x 96,000
    },
    {
      // American: exercised by hand. The call closes at zero (3,750 realized) and 1.5 MRD is delivered at 90,000:
      // 135,000, a simulated delivery that settles the same day, in this cycle.
      id: 'exercise-early', covers: ['early exercise', 'physical settlement'], action: 'lifecycle', lot: 'calls', body: { action: 'exercise', contracts: 1.5 },
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 1.5 MRD-C90K-30APR26 at strike 90000', owner: 'account', date: '2026-04-08' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 1\.5 MRD at strike 90000 on exercise of MRD-C90K-30APR26/, owner: 'account' },
          { type: 'settlement.pay', summary: 'paid 135,000.00 USD from settled cash', cash: { USD: -135_000 }, date: '2026-04-08' },
        ],
        cash: { account: { USD: { settled: 241_730, availableToTrade: 241_730, availableToWithdraw: 241_730 } } },
        positions: [
          { instrument: 'mrd', lot: 'calls', owner: 'account', direction: 'long', qty: 1.5, avgCost: 90_000, cost: 135_000, price: 96_000, value: 144_000, unrealized: 9_000 },
          { instrument: 'put', lot: 'puts', qty: -2.5 },
        ],
        holdings: { call: null, mrd: { long: 1.5, short: 0, net: 1.5 } },
        lifecycle: [{ type: 'option.expiry', instrument: 'put', dueDate: '2026-05-31', status: 'pending' }],
        otc: [{ instrument: 'put', lot: 'puts', qty: -2.5 }],
        pnl: { account: { realized: -3_750, unrealized: 9_500, total: 5_730 } }, // 9,000 + 500; -3,750 - 20 + 9,500
        nav: { account: 405_730, book: 1_005_730 }, // 241,730 + 27,500 + 144,000 - 7,500
        balance: { account: { cash: 241_730, positions: 136_500, assets: 405_730, netAssets: 405_730 } },
      },
    },
    {
      // Sold at the bid, 95,990: 1.5 x 95,990 = 143,985, settled in the cycle. Realized 143,985 - 135,000.
      id: 'sell-delivered-coins', covers: 'close', action: 'ticket', ticketOf: 'crypto', settlementCheck: false, // coins settle the same day
      instrument: 'mrd', side: 'sell', qty: 1.5, from: 'calls',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'mrd', qty: 1.5, estimate: 95_990, model: 'quoted-bid-ask', settleDate: '2026-04-08', cash: 143_985, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 1.5, avgPrice: 95_990 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 1.5 MRD @ 95,990.00 USD (realized 8,985.00 USD)' },
          { type: 'settlement.receive', summary: 'received 143,985.00 USD into settled cash', cash: { USD: 143_985 } },
        ],
        cash: { account: { USD: { settled: 385_715, availableToTrade: 385_715, availableToWithdraw: 385_715 } } },
        positions: [{ instrument: 'put', lot: 'puts', qty: -2.5 }],
        holdings: { mrd: null },
        pnl: { account: { realized: 5_235, unrealized: 500, total: 5_715 } }, // -3,750 + 8,985
        nav: { account: 405_715, book: 1_005_715 }, // 385,715 + 27,500 - 7,500
        balance: { account: { cash: 385_715, positions: -7_500, assets: 405_715, netAssets: 405_715 } },
      },
    },
    { id: 'friday-29-may', action: 'clock', to: '2026-05-29T14:00:00.000Z', expect: {} },
    {
      id: 'mark-put-lower', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 600, note: 'Dealer F mark per coin, by hand',
      expect: {
        positions: [{ instrument: 'put', lot: 'puts', price: 600, value: -1_500, unrealized: 6_500 }], // -2.5 x 600; + 8,000
        otc: [{ instrument: 'put', mark: 600, markValue: -1_500 }],
        pnl: { account: { unrealized: 6_500, total: 11_715 } },
        nav: { account: 411_715, book: 1_011_715 },
        balance: { account: { positions: -1_500, assets: 411_715, netAssets: 411_715 } },
      },
    },
    {
      // -1,500 requires 1,500; 7,500 is posted: 6,000 comes back.
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: '2026-05-29T21:30:00.000Z',
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 6,000.00 USD returned to us. Netting set of 1 position marked at -1,500.00 USD; threshold 0.00 USD.', cash: { USD: 6_000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 391_715, margin: 21_500, availableToTrade: 391_715, availableToWithdraw: 391_715 } } },
        otc: [{ instrument: 'put', vmPosted: 1_500, vmExposure: -1_500 }],
        balance: { account: { cash: 391_715, margin: 21_500 } },
      },
    },
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'mrd', date: '2026-05-31', value: 72_500, expect: {} },
    {
      // Sunday 31 May, after the day's close: MRD closed at 72,500, above the 70,000 strike. The put lapses; its 8,000
      // premium is realized; the 20,000 independent amount and the 1,500 of variation margin come back.
      id: 'expires-on-sunday', covers: ['expiry', 'lapse', 'weekend', 'collateral'], action: 'clock', to: '2026-05-31T21:30:00.000Z',
      expect: {
        events: [
          { type: 'option.expired', summary: 'Expired worthless: 2.5 MRD-P70K-31MAY26 (fixing 72,500.00)', owner: 'account', date: '2026-05-31' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${MRD_PUT} under its position-level terms: 20,000.00 USD (independent amount, the position ended)`, cash: { USD: 20_000 } },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 1,500.00 USD returned to us. The last position of the netting set ended.', cash: { USD: 1_500 } },
        ],
        cash: { account: { USD: { settled: 413_215, margin: 0, availableToTrade: 413_215, availableToWithdraw: 413_215 } } }, // 391,715 + 21,500
        positions: [], holdings: { put: null }, otc: [], lifecycle: [], pending: [],
        pnl: { account: { realized: 13_235, unrealized: 0, total: 13_215 } }, // 5,235 + 8,000; - 20
        nav: { account: 413_215, book: 1_013_215 },
        balance: { account: { cash: 413_215, margin: null, positions: null, assets: 413_215, liabilities: 0, netAssets: 413_215 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// digital_option
// ---------------------------------------------------------------------------------------------
// Two cash-or-nothing digital options on the Coastline Clean Energy ETF (CCEN, NYSE Arca), dealt with Dealer G, each
// paying a fixed 10.00 USD per unit if the ETF's close on Thursday 18 June 2026 is beyond the strike, nothing otherwise
// (a close exactly at the strike pays nothing):
//   - a digital call struck at 52 on 20,000 units, bought; position-level terms: variation margin over a 20,000
//     threshold (minimum transfer 5,000), so the dealer posts collateral to the Account; half terminated at a stated
//     amount. The ETF closes at 53.40: the call pays its fixed 10.00 a unit, received T+1 on the US calendar, which is
//     Monday 22 June (Friday 19 June is Juneteenth, a market holiday).
//   - a digital put struck at 45 on 20,000 units, written; position-level terms: a fixed independent amount of 200,000,
//     the most it can ever pay (20,000 x 10.00), and no variation margin. It lapses out of the money.
const DCALL = 'CCEN 52 digital call, pays 10.00, 18 Jun 2026 (Dealer G)';
const DPUT = 'CCEN 45 digital put, pays 10.00, 18 Jun 2026 (Dealer G)';
const digitalOption = {
  productId: 'digital_option',
  title: 'Cash-or-nothing digitals on a US ETF paying 10.00 a unit: 52 call bought (pays at expiry), 45 put written (lapses)',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Payoff: Digital (cash or nothing)', 'Digital payout per unit'],
    automaticInputs: ['ETF price (quote fixture standing in for Shaffer MarketData) for the notional', 'premium settlement date, T+2 on the US calendar', 'commission per unit from the Book fee schedule', 'variation margin and independent amount from the position-level terms', 'expiry item settled against the ETF close for the expiration date (close fixture: the stated settlement price): the fixed payout if beyond the strike, else nothing', 'payout date T+1 on the US calendar, across Juneteenth'],
    manualInputs: ['premium agreed with the dealer (stated fill price)', 'marks entered by hand (Manual entry)', 'termination of half the call at a stated amount per unit'],
    settlement: 'Premium and commission T+2 on the US calendar; the digital payout T+1 after expiry (Friday 19 June is Juneteenth: paid Monday 22 June)',
    lifecycle: 'Expiry item on 18 June: the call pays its fixed 10.00 a unit (not the distance from the strike); the put lapses and its premium is realized; nothing scheduled afterwards',
    accounting: 'Premium per unit x units; average premium; payout and lapse realized at expiry; commission expensed; marks by hand drive unrealized P&L',
    collateral: 'Call (bought): position-level terms, variation margin over a 20,000 threshold: received from the dealer as restricted cash with a liability, partly returned after the termination, the rest when the call settles. Put (written): fixed independent amount of 200,000, its maximum payout, posted at entry and returned at expiry',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix digital option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }],
    account: { name: 'Binary', funding: [{ ccy: 'USD', amount: 800_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.02, minimum: 0, bps: 0 }, equity: NO_FEE }, fill: FILL, settlement: { otcoption: 2, equity: 1 } }, // 0.02 a unit
  },
  instruments: {
    etf: { productId: 'etf', name: 'Coastline Clean Energy ETF', symbol: 'CCEN', marketView: 'US_CASH', venue: 'NYSE Arca', venueType: 'exchange', venueCountry: 'US', issuer: 'Coastline Funds Trust', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    dcall: {
      productId: 'digital_option', name: DCALL, symbol: 'CCEN-DC52', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'etf', multiplier: 1,
      terms: { right: 'C', strike: 52, expiration: '2026-06-18', optionType: 'digital', payout: 10, exercise: 'european', settlement: 'cash', counterparty: 'Dealer G',
        collateralBasis: { type: 'position', independentAmount: { type: 'none' }, variationMargin: true, threshold: 20_000, minimumTransfer: 5_000 } },
    },
    dput: {
      productId: 'digital_option', name: DPUT, symbol: 'CCEN-DP45', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'etf', multiplier: 1,
      terms: { right: 'P', strike: 45, expiration: '2026-06-18', optionType: 'digital', payout: 10, exercise: 'european', settlement: 'cash', counterparty: 'Dealer G',
        collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 200_000 }, variationMargin: false, threshold: 0, minimumTransfer: 0 } },
    },
  },
  quotes: { etf: { bid: 47.99, ask: 48.01, last: 48, bidSize: 500_000, askSize: 500_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 800_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 800_000, availableToWithdraw: 800_000 } },
      treasury: { USD: { settled: 1_200_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 800_000, treasury: 1_200_000, book: 2_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    otcTicket({
      id: 'buy-digital-call', covers: ['open', 'collateral'], instrument: 'dcall', side: 'buy', qty: 20_000, premium: 3.40, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'dcall', qty: 20_000, estimate: 3.4, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: -68_000, fees: 400, notional: 960_000 }], // 20,000 x 3.40; 20,000 x 0.02; 20,000 x 48.00
          cash: { USD: { purchases: 68_000, fees: 400, margin: 0, required: 68_400, available: 800_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20_000, avgPrice: 3.4 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 20,000 CCEN-DC52 @ 3.40 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 800_000, unsettled: -68_400, availableToTrade: 731_600, availableToWithdraw: 731_600 } } },
        positions: [{ instrument: 'dcall', lot: 'calls', owner: 'account', direction: 'long', qty: 20_000, avgCost: 3.4, cost: 68_000, price: null, value: null, unrealized: null, provisional: true, notional: 960_000, margin: 0 }],
        holdings: { dcall: { long: 20_000, short: 0, net: 20_000 } },
        pending: [{ instrument: 'dcall', owner: 'account', dueDate: '2026-03-04', amount: -68_400, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'dcall', dueDate: '2026-06-18', status: 'pending' }],
        otc: [{ instrument: 'dcall', lot: 'calls', qty: 20_000, basis: 'position', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -400, unrealized: 0, total: -400 } },
        nav: { account: 799_600, book: 1_999_600 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 800_000, payable: 68_400, positions: 68_000, assets: 868_000, liabilities: 68_400, netAssets: 799_600 } },
      },
    }),
    { id: 'half-an-hour-later', action: 'clock', to: at('2026-03-02', '15:30'), expect: {} },
    otcTicket({
      // Written: a fixed independent amount of 200,000 (20,000 x 10.00, the most the put can pay), posted at the fill.
      id: 'write-digital-put', covers: ['write', 'collateral'], instrument: 'dput', side: 'sell', qty: 20_000, premium: 2.10, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'dput', qty: 20_000, estimate: 2.1, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: 42_000, fees: 400, notional: 960_000 }],
          cash: { USD: { proceeds: 42_000, fees: 400, margin: 200_000, required: 200_400, available: 731_600, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 20_000, avgPrice: 2.1 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 20,000 CCEN-DP45 @ 2.10 USD', owner: 'account' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${DPUT} under its position-level terms: 200,000.00 USD (independent amount, fixed amount for the position)`, cash: { USD: -200_000 } },
        ],
        cash: { account: { USD: { settled: 600_000, unsettled: -26_800, margin: 200_000, availableToTrade: 573_200, availableToWithdraw: 531_600 } } }, // -68,400 + 41,600; 600,000 - 68,400
        positions: [
          { instrument: 'dcall', lot: 'calls', qty: 20_000 },
          { instrument: 'dput', lot: 'puts', owner: 'account', direction: 'short', qty: -20_000, avgCost: 2.1, cost: -42_000, price: null, value: null, unrealized: null, provisional: true, notional: 960_000, margin: 200_000 },
        ],
        holdings: { dput: { long: 0, short: 20_000, net: -20_000 } },
        pending: [
          { instrument: 'dcall', owner: 'account', dueDate: '2026-03-04', amount: -68_400, ccy: 'USD', into: 'cash' },
          { instrument: 'dput', owner: 'account', dueDate: '2026-03-04', amount: 41_600, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'dcall', dueDate: '2026-06-18', status: 'pending' }, { type: 'option.expiry', instrument: 'dput', dueDate: '2026-06-18', status: 'pending' }],
        otc: [{ instrument: 'dcall' }, { instrument: 'dput', lot: 'puts', qty: -20_000, basis: 'position', iaRequired: 200_000, iaPosted: 200_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { commissions: -800, total: -800 } },
        nav: { account: 799_200, book: 1_999_200 }, // 600,000 + 200,000 + 41,600 - 68,400 + 68,000 - 42,000
        balance: { account: { cash: 600_000, margin: 200_000, receivable: 41_600, payable: 68_400, positions: 26_000, assets: 867_600, liabilities: 68_400, netAssets: 799_200 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'dcall', value: 4.20, note: 'Dealer G mark, by hand',
      expect: {
        positions: [{ instrument: 'dcall', lot: 'calls', price: 4.2, value: 84_000, unrealized: 16_000, provisional: false }, { instrument: 'dput', lot: 'puts' }], // 20,000 x 4.20; - 68,000
        otc: [{ instrument: 'dcall', mark: 4.2, markValue: 84_000 }, { instrument: 'dput' }],
        pnl: { account: { unrealized: 16_000, total: 15_200 } },
        nav: { account: 815_200, book: 2_015_200 },
        balance: { account: { positions: 42_000, assets: 883_600, netAssets: 815_200 } }, // 84,000 - 42,000 (put at cost)
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'dput', value: 1.50, note: 'Dealer G mark, by hand',
      expect: {
        positions: [{ instrument: 'dcall', lot: 'calls' }, { instrument: 'dput', lot: 'puts', price: 1.5, value: -30_000, unrealized: 12_000, provisional: false }], // -20,000 x 1.50; + 42,000
        otc: [{ instrument: 'dcall' }, { instrument: 'dput', mark: 1.5, markValue: -30_000 }],
        pnl: { account: { unrealized: 28_000, total: 27_200 } },
        nav: { account: 827_200, book: 2_027_200 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 54_000, assets: 895_600, netAssets: 827_200 } },
      },
    },
    {
      // Call marked at +84,000: 64,000 beyond the 20,000 threshold, posted by Dealer G (restricted, owed back). The put has no variation margin.
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-03-02'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 64,000.00 USD received. Netting set of 1 position marked at 84,000.00 USD; threshold 20,000.00 USD.', owner: 'account' }],
        cash: { account: { USD: { restricted: 64_000 } } },
        otc: [{ instrument: 'dcall', vmHeld: 64_000, vmExposure: 84_000, vmStatus: 'ok' }, { instrument: 'dput', vmHeld: 0 }],
        balance: { account: { restricted: 64_000, collateralReceived: 64_000, assets: 959_600, liabilities: 132_400, netAssets: 827_200 } },
      },
    },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 41,600.00 USD into settled cash', cash: { USD: 41_600 } },
          { type: 'settlement.pay', summary: 'paid 68,400.00 USD from settled cash', cash: { USD: -68_400 } },
        ],
        cash: { account: { USD: { settled: 573_200, unsettled: 0, availableToTrade: 573_200, availableToWithdraw: 573_200 } } },
        pending: [],
        balance: { account: { cash: 573_200, receivable: null, payable: null, assets: 891_200, liabilities: 64_000 } },
      },
    },
    {
      // Half the call terminated with Dealer G at 4.80 a unit: 10,000 x 4.80 = 48,000 less 200. Realized 10,000 x (4.80 - 3.40).
      id: 'terminate-half-call', covers: ['reduce', 'termination at a stated amount'], action: 'close', lot: 'calls', scope: 'strategy', percent: 50, order: { statedPrice: 4.80 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'dcall', qty: 10_000, estimate: 4.8, model: 'stated-price', settleDate: '2026-03-06', cash: 48_000, fees: 200 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000, avgPrice: 4.8 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 10,000 CCEN-DC52 @ 4.80 USD (realized 14,000.00 USD)' }],
        cash: { account: { USD: { unsettled: 47_800, availableToTrade: 621_000, availableToWithdraw: 573_200 } } },
        positions: [{ instrument: 'dcall', lot: 'calls', qty: 10_000, cost: 34_000, value: 42_000, unrealized: 8_000, notional: 480_000 }, { instrument: 'dput', lot: 'puts' }],
        holdings: { dcall: { long: 10_000, short: 0, net: 10_000 } },
        pending: [{ instrument: 'dcall', owner: 'account', dueDate: '2026-03-06', amount: 47_800, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'dcall', qty: 10_000, markValue: 42_000 }, { instrument: 'dput' }],
        pnl: { account: { realized: 14_000, commissions: -1_000, unrealized: 20_000, total: 33_000 } }, // 8,000 + 12,000
        nav: { account: 833_000, book: 2_033_000 }, // 573,200 + 200,000 + 47,800 + 42,000 - 30,000
        balance: { account: { receivable: 47_800, positions: 12_000, assets: 897_000, liabilities: 64_000, netAssets: 833_000 } },
      },
    },
    {
      // Marked at 42,000: 22,000 beyond the threshold is held; 42,000 of the 64,000 goes back to Dealer G.
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-03-04'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 42,000.00 USD returned to the counterparty. Netting set of 1 position marked at 42,000.00 USD; threshold 20,000.00 USD.', owner: 'account' }],
        cash: { account: { USD: { restricted: 22_000 } } },
        otc: [{ instrument: 'dcall', vmHeld: 22_000, vmExposure: 42_000 }, { instrument: 'dput' }],
        balance: { account: { restricted: 22_000, collateralReceived: 22_000, assets: 855_000, liabilities: 22_000 } },
      },
    },
    {
      id: 'settle-termination', covers: 'settlement', action: 'clock', to: at('2026-03-06'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 47,800.00 USD into settled cash', cash: { USD: 47_800 } }],
        cash: { account: { USD: { settled: 621_000, unsettled: 0, availableToTrade: 621_000, availableToWithdraw: 621_000 } } },
        pending: [],
        balance: { account: { cash: 621_000, receivable: null, assets: 855_000 } },
      },
    },
    // Held across Good Friday and Memorial Day.
    { id: 'wednesday-17-june', covers: 'holiday', action: 'clock', to: at('2026-06-17'), expect: {} },
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'etf', date: '2026-06-18', value: 53.40, expect: {} },
    {
      // CCEN closed at 53.40. Call (52): beyond the strike, pays the fixed 10.00 a unit: 10,000 x 10.00 = 100,000, due
      // T+1 on the US calendar: Monday 22 June (19 June is Juneteenth). Realized 100,000 - 34,000 = 66,000. The 22,000 held
      // goes back to Dealer G. Put (45): not beyond the strike, lapses: 42,000 realized; the 200,000 comes back.
      id: 'expiry', covers: ['expiry', 'digital payout', 'lapse', 'collateral'], action: 'clock', to: eod('2026-06-18'),
      expect: {
        events: [
          { type: 'option.cash_settled', summary: 'Exercised (cash settlement): 10,000 CCEN-DC52 at 10.00 USD per unit (fixing 53.40)', owner: 'account', date: '2026-06-18' },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 22,000.00 USD returned to the counterparty. The last position of the netting set ended.', owner: 'account' },
          { type: 'option.expired', summary: 'Expired worthless: 20,000 CCEN-DP45 (fixing 53.40)', owner: 'account', date: '2026-06-18' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${DPUT} under its position-level terms: 200,000.00 USD (independent amount, the position ended)`, cash: { USD: 200_000 } },
        ],
        cash: { account: { USD: { settled: 821_000, restricted: 0, margin: 0, unsettled: 100_000, availableToTrade: 921_000, availableToWithdraw: 821_000 } } },
        positions: [], holdings: { dcall: null, dput: null }, otc: [], lifecycle: [],
        pending: [{ instrument: 'dcall', owner: 'account', dueDate: '2026-06-22', amount: 100_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 122_000, unrealized: 0, total: 121_000 } }, // 14,000 + 66,000 + 42,000; - 1,000
        nav: { account: 921_000, book: 2_121_000 },
        balance: { account: { cash: 821_000, receivable: 100_000, restricted: null, collateralReceived: null, margin: null, positions: null, assets: 921_000, liabilities: 0, netAssets: 921_000 } },
      },
    },
    {
      id: 'payout-after-juneteenth', covers: ['settlement', 'holiday'], action: 'clock', to: at('2026-06-22'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 100,000.00 USD into settled cash', cash: { USD: 100_000 }, date: '2026-06-22' }],
        cash: { account: { USD: { settled: 921_000, unsettled: 0, availableToTrade: 921_000, availableToWithdraw: 921_000 } } },
        pending: [],
        balance: { account: { cash: 921_000, receivable: null } },
      },
    },
  ],
};

export default [otcOption, bondOption, fxOption, commodityOption, cryptoOption, digitalOption];
