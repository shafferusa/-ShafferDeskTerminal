// Listed options (engine family "option"): the 5 catalog products accounted as listed option
// contracts. One scenario per product, each on its own fictional contract registered as exactly
// that product, with the specifications a real contract of that product has.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec (quotes,
// quantities, the contract's multiplier and deliverable, the Book's fee schedule and assumptions).
// The arithmetic is in the comment beside it. Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic
// can be followed):
//   - A premium is quoted per unit of the underlying. One contract costs premium x the contract's
//     premium multiplier (100 for a standard equity option). Quantity is in contracts.
//   - A market buy fills at the ask, a market sell at the bid, of the quote in force.
//   - Commission is per contract, from the Book's fee schedule, and is expensed (not added to cost).
//   - Positions carry average premium. Closing part removes cost at the average.
//   - A fill books the position on trade date and leaves a payable or receivable; the premium moves
//     on the settlement date (T+1 on the listing venue's calendar).
//   - Buying opens or adds to a long position. The ticket's "Sell / write" always opens a written
//     (short) position of its own: a long is sold with Close on the position or on its strategy
//     instance, so a long and a short of one contract are held side by side, gross.
//   - A written option reserves cash in its strategy instance: a written put the full strike value
//     of its deliverable (cash-secured); an uncovered written call 20% (the Book's nakedCallPct) of
//     the current value of the underlying units; a call written against the underlying held in the
//     same strategy instance reserves nothing. The reserve is marked again at each end of day.
//   - Exercise and assignment, physical settlement: the option position is closed at zero, so the
//     premium paid (or received) is realized at that moment, and the deliverable changes hands at
//     the strike, as a simulated delivery that settles on the underlying's own convention. The
//     position delivered is carried at the strike.
//   - Expiration is settled against the underlying's close for the expiration date. Until that
//     close exists the expiry item is blocked and visible; it is never guessed. In the money by
//     0.01 or more is exercised (long) or assigned (short) automatically; otherwise the option
//     lapses and its premium is realized.

export const family = 'option';

// ---- instants (New York time; US clocks move to daylight time on Sunday 8 March 2026) ----------
const at = (month, d, t, offset) => {
  const [h, m] = t.split(':').map(Number);
  return `2026-${month}-${String(d).padStart(2, '0')}T${String(h + offset).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
};
const MAR = (d, t = '10:00') => at('03', d, t, d < 8 ? 5 : 4); // 5 hours behind UTC up to 7 March, then 4
const APR = (d, t = '10:00') => at('04', d, t, 4);
const MAY = (d, t = '10:00') => at('05', d, t, 4);

/** The Book every option scenario starts from, stated in full so no figure rests on a default. */
const book = (name, over = {}) => ({
  name,
  reportingCcy: 'USD',
  capital: over.capital || [{ ccy: 'USD', amount: 1_000_000 }],
  account: { name: 'Alpha', funding: over.funding || [{ ccy: 'USD', amount: 500_000 }] },
  settings: {
    fees: { option: { perUnit: 0.65, minimum: 0, bps: 0 }, equity: { perUnit: 0.005, minimum: 1, bps: 0 }, future: { perUnit: 2.25, minimum: 0, bps: 0 }, ...(over.fees || {}) }, // 0.65 a contract; 0.005 a share, at least 1.00 an order
    fill: { halfSpreadBps: { equity: 2 }, optionHalfSpreadPct: 1, futureHalfSpreadTicks: 0.5, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 },
    settlement: { equity: 1, option: 1, future: 0, foreignCash: 2, ...(over.settlement || {}) }, // T+1 for US shares and for option premium
    short: { collateralPct: 1.02, marginPct: 0.3 },
    margin: { nakedCallPct: 0.2 }, // an uncovered written call reserves 20% of the value of the underlying units
    dividends: { withholdingPct: 0 },
  },
});

/** State before any trade: 1,000,000 deposited in Treasury, 500,000 of it funded to the Account. */
const START_STATE = {
  cash: {
    account: { USD: { settled: 500_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 } },
    treasury: { USD: { settled: 500_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 500_000 } },
  },
  positions: [],
  pending: [],
  openOrders: [],
  lifecycle: [],
  borrowings: [],
  nav: { account: 500_000, treasury: 500_000, book: 1_000_000 },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
  alerts: [],
};

/**
 * A step on the option ticket (the Trade tab of the contract, reached from the underlying's
 * "Options and futures" tab or from the Marketplace). `input` is the request that ticket sends.
 */
const optionTicket = ({ instrument, side, qty, symbol, ...rest }) => ({
  action: 'ticket', instrument, side, qty,
  input: {
    template: 'custom', underlyingId: `$inst:${instrument}`, origin: 'marketplace', name: `${side === 'buy' ? 'Buy' : 'Sell / write'} ${symbol}`,
    legs: [{ kind: 'trade', action: side, instrumentId: `$inst:${instrument}`, qty, role: 'underlying', orderType: 'market', limitPrice: null, stopPrice: null, tif: 'day', statedPrice: null }],
    financing: null, investmentStrategy: null, holdingPeriod: null, hedgeObjective: null,
  },
  ...rest,
});

const OPTION_TICKET = {
  ticket: 'Underlying drawer, Options and futures tab, registered contract (or the contract in its Marketplace); its Trade tab (option ticket), then the trade preview. Close, Resize, Roll and the Lifecycle menu are on the strategy instance',
  requiredFields: ['Account', 'Action (Buy, Sell / write)', 'Contracts'],
  automaticInputs: ['premium bid, ask, last and size (quote fixture standing in for Shaffer MarketData)', 'underlying price for the notional and for the reserve of an uncovered call (quote fixture)', 'fill price and fill model', 'premium settlement date from the listing venue calendar', 'commission per contract from the Book fee schedule', 'cash reserved against written options from the Book margin assumption', 'underlying close for the expiration date (close fixture)'],
};

// ---------------------------------------------------------------------------------------------
// equity_option
// ---------------------------------------------------------------------------------------------
// An American call on a NYSE-listed stock, 100 shares a contract, physical delivery, third-Friday
// expiry (20 March 2026). Bought, added to, part sold, part exercised early by hand, written in a
// second strategy instance while still held long (gross), bought back, and the rest exercised
// automatically at expiry. The 600 shares delivered at the strike are then sold.
const equityOption = {
  productId: 'equity_option',
  title: 'Halden Rail Systems 20 March 2026 50 call, Cboe-listed, American, 100 shares, physical delivery',
  matrix: {
    ...OPTION_TICKET,
    manualInputs: ['early exercise of a long American option (contracts), recorded by hand from the position Lifecycle menu'],
    settlement: 'Premium T+1 on the US calendar (Book setting settlement.option = 1); shares delivered on exercise settle T+1 at the strike (settlement.equity = 1)',
    lifecycle: 'Expiry item on the expiration date, blocked until the underlying close exists; in the money: exercised automatically with a simulated delivery of 100 shares a contract at the strike; early exercise by hand; trades refused after expiration',
    accounting: 'Average premium; commission expensed; premium realized on sale, on exercise and on lapse; shares delivered are carried at the strike; long and written positions of one contract held gross',
    collateral: 'An uncovered written call reserves 20% of the value of the underlying shares in its strategy instance, marked at each end of day and released when it is bought back',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: [] }, // US: no market holiday between 2 and 24 March 2026 (Good Friday is 3 April)
  book: book('Matrix equity option'),
  instruments: {
    stock: { productId: 'common_stock', name: 'Halden Rail Systems Inc.', symbol: 'HRSI', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Halden Rail Systems Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    main: { productId: 'equity_option', name: 'HRSI 20 March 2026 50 call', symbol: 'HRSI260320C50', marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 100,
      terms: { right: 'C', strike: 50, expiration: '2026-03-20', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } },
  },
  quotes: {
    stock: { bid: 52.00, ask: 52.04, last: 52.02, bidSize: 20000, askSize: 20000 },
    main: { bid: 3.10, ask: 3.20, last: 3.15, bidSize: 500, askSize: 500 },
  },
  expectAtStart: START_STATE,
  steps: [
    optionTicket({
      id: 'buy-to-open', covers: 'open', instrument: 'main', side: 'buy', qty: 5, symbol: 'HRSI260320C50', as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5, estimate: 3.20, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US',
            cash: -1_600, // 5 contracts x 3.20 (the ask) x 100
            fees: 3.25 }], // 5 x 0.65
          cash: { USD: { purchases: 1_600, fees: 3.25, reserved: 0, required: 1_603.25, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5, avgPrice: 3.20, fills: [{ qty: 5, price: 3.20, model: 'quoted-bid-ask', settleDate: '2026-03-03', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 5 HRSI260320C50 @ 3.20 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -1_603.25, availableToTrade: 498_396.75, availableToWithdraw: 498_396.75 } } }, // 1,600 + 3.25 owed until settlement
        positions: [{ instrument: 'main', lot: 'calls', owner: 'account', direction: 'long', qty: 5, avgCost: 3.20, cost: 1_600, price: 3.15,
          value: 1_575, // 5 x 3.15 (last) x 100
          unrealized: -25, priceSource: 'Test fixture' }],
        holdings: { main: { long: 5, short: 0, net: 5 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-03-03', amount: -1_603.25, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -3.25, fees: 0, borrowFunding: 0, unrealized: -25, total: -28.25 } },
        nav: { account: 499_971.75, book: 999_971.75 }, // 500,000 - 3.25 commission - 25 unrealized
        balance: { account: { cash: 500_000, positions: 1_575, payable: 1_603.25, assets: 501_575, liabilities: 1_603.25, netAssets: 499_971.75 } },
      },
    }),
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR(3),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,603.25 USD from settled cash', cash: { USD: -1_603.25 }, date: '2026-03-03' }],
        cash: { account: { USD: { settled: 498_396.75, unsettled: 0, availableToTrade: 498_396.75, availableToWithdraw: 498_396.75 } } },
        pending: [],
        balance: { account: { cash: 498_396.75, payable: null, assets: 499_971.75, liabilities: 0 } },
      },
    },
    { id: 'stock-up', action: 'quote', instrument: 'stock', quote: { bid: 53.00, ask: 53.04, last: 53.02, bidSize: 20000, askSize: 20000 }, expect: {} }, // no shares are held yet
    {
      id: 'premium-up', action: 'quote', instrument: 'main', quote: { bid: 3.90, ask: 4.00, last: 3.95, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'calls', qty: 5, avgCost: 3.20, price: 3.95, value: 1_975, unrealized: 375 }], // 5 x 3.95 x 100 = 1,975; less cost 1,600
        pnl: { account: { unrealized: 375, total: 371.75 } },
        nav: { account: 500_371.75, book: 1_000_371.75 },
        balance: { account: { positions: 1_975, assets: 500_371.75, netAssets: 500_371.75 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'calls', factor: 1.6, // 5 -> 8 contracts: buys 3 more in the same strategy instance
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy', qty: 3, estimate: 4.00, settleDate: '2026-03-04', cash: -1_200, fees: 1.95 }], // 3 x 4.00 x 100; 3 x 0.65
          cash: { USD: { purchases: 1_200, fees: 1.95, required: 1_201.95, available: 498_396.75, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 3, avgPrice: 4.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 3 HRSI260320C50 @ 4.00 USD' }],
        cash: { account: { USD: { settled: 498_396.75, unsettled: -1_201.95, availableToTrade: 497_194.80, availableToWithdraw: 497_194.80 } } },
        positions: [{ instrument: 'main', lot: 'calls', qty: 8,
          cost: 2_800, // 1,600 + 1,200
          avgCost: 3.50, // 2,800 / (8 x 100): the average premium
          price: 3.95, value: 3_160, // 8 x 3.95 x 100
          unrealized: 360 }],
        holdings: { main: { long: 8, short: 0, net: 8 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-04', amount: -1_201.95, into: 'cash' }],
        pnl: { account: { commissions: -5.20, unrealized: 360, total: 354.80 } },
        nav: { account: 500_354.80, book: 1_000_354.80 },
        balance: { account: { cash: 498_396.75, positions: 3_160, payable: 1_201.95, assets: 501_556.75, liabilities: 1_201.95, netAssets: 500_354.80 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: MAR(4),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,201.95 USD from settled cash', cash: { USD: -1_201.95 } }],
        cash: { account: { USD: { settled: 497_194.80, unsettled: 0, availableToTrade: 497_194.80, availableToWithdraw: 497_194.80 } } },
        pending: [],
        balance: { account: { cash: 497_194.80, payable: null, assets: 500_354.80, liabilities: 0 } },
      },
    },
    {
      id: 'premium-up-2', action: 'quote', instrument: 'main', quote: { bid: 4.40, ask: 4.50, last: 4.45, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'calls', qty: 8, price: 4.45, value: 3_560, unrealized: 760 }], // 8 x 4.45 x 100 - 2,800
        pnl: { account: { unrealized: 760, total: 754.80 } },
        nav: { account: 500_754.80, book: 1_000_754.80 },
        balance: { account: { positions: 3_560, assets: 500_754.80, netAssets: 500_754.80 } },
      },
    },
    {
      id: 'sell-to-close-part', covers: 'reduce', action: 'close', lot: 'calls', scope: 'strategy', percent: 25, // a quarter of 8 contracts: sells 2
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 2, estimate: 4.40, model: 'quoted-bid-ask', settleDate: '2026-03-05', cash: 880, fees: 1.30 }], // 2 x 4.40 (the bid) x 100; 2 x 0.65
          cash: { USD: { proceeds: 880, fees: 1.30, reserved: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2, avgPrice: 4.40 }] },
        // Cost removed at the average premium: 2 x 3.50 x 100 = 700. Realized 880 - 700 = 180.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2 HRSI260320C50 @ 4.40 USD (realized 180.00 USD)' }],
        cash: { account: { USD: { settled: 497_194.80, unsettled: 878.70, reserved: 0, availableToTrade: 498_073.50, availableToWithdraw: 497_194.80 } } }, // 880 - 1.30 owed to the Account
        positions: [{ instrument: 'main', lot: 'calls', qty: 6, cost: 2_100, avgCost: 3.50, price: 4.45, value: 2_670, unrealized: 570 }], // 6 x 4.45 x 100 - 2,100
        holdings: { main: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-05', amount: 878.70, into: 'cash' }],
        pnl: { account: { realized: 180, commissions: -6.50, unrealized: 570, total: 743.50 } },
        nav: { account: 500_743.50, book: 1_000_743.50 },
        balance: { account: { cash: 497_194.80, receivable: 878.70, positions: 2_670, assets: 500_743.50, liabilities: 0, netAssets: 500_743.50 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: MAR(5),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 878.70 USD into settled cash', cash: { USD: 878.70 } }],
        cash: { account: { USD: { settled: 498_073.50, unsettled: 0, availableToTrade: 498_073.50, availableToWithdraw: 498_073.50 } } },
        pending: [],
        balance: { account: { cash: 498_073.50, receivable: null } },
      },
    },
    {
      // Early exercise of 2 of the 6 contracts, by hand. The 2 contracts are closed at zero: their premium,
      // 2 x 3.50 x 100 = 700, is realized as a loss. 200 shares are delivered at the strike: 200 x 50 = 10,000,
      // due T+1 like any share purchase. The shares are worth 200 x 53.02 = 10,604.
      id: 'exercise-early', covers: 'exercise', action: 'lifecycle', lot: 'calls', body: { action: 'exercise', contracts: 2 },
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 2 HRSI260320C50 at strike 50', owner: 'account', date: '2026-03-05' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 200 HRSI at strike 50 on exercise of HRSI260320C50/, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 498_073.50, unsettled: -10_000, availableToTrade: 488_073.50, availableToWithdraw: 488_073.50 } } },
        positions: [
          { instrument: 'main', lot: 'calls', qty: 4, cost: 1_400, avgCost: 3.50, price: 4.45, value: 1_780, unrealized: 380 }, // 4 x 4.45 x 100 - 1,400
          { instrument: 'stock', lot: 'calls', owner: 'account', direction: 'long', qty: 200, cost: 10_000, avgCost: 50, price: 53.02, value: 10_604, unrealized: 604 },
        ],
        holdings: { main: { long: 4, short: 0, net: 4 }, stock: { long: 200, short: 0, net: 200 } },
        pending: [{ instrument: 'stock', dueDate: '2026-03-06', amount: -10_000, into: 'cash' }],
        pnl: { account: { realized: -520, unrealized: 984, total: 457.50 } }, // 180 - 700; 380 + 604; -520 - 6.50 + 984
        nav: { account: 500_457.50, book: 1_000_457.50 }, // 286 lower: the time value of the 2 contracts (2 x 4.45 x 100 = 890 against 604 of intrinsic value)
        balance: { account: { cash: 498_073.50, positions: 12_384, payable: 10_000, assets: 510_457.50, liabilities: 10_000, netAssets: 500_457.50 } },
      },
    },
    {
      id: 'settle-exercise', covers: 'settlement', action: 'clock', to: MAR(6),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 10,000.00 USD from settled cash', cash: { USD: -10_000 } }],
        cash: { account: { USD: { settled: 488_073.50, unsettled: 0, availableToTrade: 488_073.50, availableToWithdraw: 488_073.50 } } },
        pending: [],
        balance: { account: { cash: 488_073.50, payable: null, assets: 500_457.50, liabilities: 0 } },
      },
    },
    optionTicket({
      // Writing 2 of the same call while 4 are held long. The ticket's Sell / write opens a written position in a
      // strategy instance of its own; the shares and the long calls sit in the other one, so these calls are uncovered.
      // Reserve: 2 contracts x 100 shares x 53.02 (last) x 20% = 2,120.80.
      id: 'write-uncovered', covers: ['write', 'gross long and short'], instrument: 'main', side: 'sell', qty: 2, symbol: 'HRSI260320C50', as: 'written',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: ['naked-call', 'unbounded'],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2, estimate: 4.40, model: 'quoted-bid-ask', settleDate: '2026-03-09', calendar: 'US', cash: 880, fees: 1.30 }], // Friday's trade settles Monday
          cash: { USD: { purchases: 0, proceeds: 880, fees: 1.30, reserved: 2_120.80, required: 2_122.10, available: 488_073.50, shortfall: 0 } }, // 1.30 + 2,120.80
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 2, avgPrice: 4.40 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: /^Sold 2 HRSI260320C50 @ 4\.40 USD$/, owner: 'account', date: '2026-03-06' }], // opening a written position realizes nothing
        cash: { account: { USD: { settled: 488_073.50, unsettled: 878.70, reserved: 2_120.80, availableToTrade: 486_831.40, availableToWithdraw: 485_952.70 } } }, // 488,073.50 + 878.70 - 2,120.80; 488,073.50 - 2,120.80
        positions: [
          { instrument: 'main', lot: 'calls', qty: 4, cost: 1_400, value: 1_780, unrealized: 380 },
          { instrument: 'main', lot: 'written', owner: 'account', direction: 'short', qty: -2, cost: -880, avgCost: 4.40, price: 4.45, value: -890, unrealized: -10 }, // -2 x 4.45 x 100; -890 + 880
          { instrument: 'stock', lot: 'calls', qty: 200, cost: 10_000, value: 10_604, unrealized: 604 },
        ],
        holdings: { main: { long: 4, short: 2, net: 2 }, stock: { long: 200, short: 0, net: 200 } },
        pending: [{ instrument: 'main', lot: 'written', dueDate: '2026-03-09', amount: 878.70, into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }, { type: 'option.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }],
        pnl: { account: { commissions: -7.80, unrealized: 974, total: 446.20 } }, // 380 + 604 - 10; -520 - 7.80 + 974
        nav: { account: 500_446.20, book: 1_000_446.20 },
        balance: { account: { cash: 488_073.50, receivable: 878.70, positions: 11_494, assets: 500_446.20, liabilities: 0, netAssets: 500_446.20 } }, // 1,780 - 890 + 10,604
      },
    }),
    {
      id: 'stock-up-2', action: 'quote', instrument: 'stock', quote: { bid: 54.00, ask: 54.04, last: 54.02, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'calls', qty: 4 }, { instrument: 'main', lot: 'written', qty: -2 }, { instrument: 'stock', lot: 'calls', qty: 200, price: 54.02, value: 10_804, unrealized: 804 }], // 200 x 54.02
        pnl: { account: { unrealized: 1_174, total: 646.20 } }, // 380 - 10 + 804
        nav: { account: 500_646.20, book: 1_000_646.20 },
        balance: { account: { positions: 11_694, assets: 500_646.20, netAssets: 500_646.20 } },
      },
    },
    {
      // Monday: the written calls' premium settles, and Friday's end of day marks the reserve to the new share
      // price: 2 x 100 x 54.02 x 20% = 2,160.80.
      id: 'settle-write', covers: ['settlement', 'reserve mark'], action: 'clock', to: MAR(9),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 878.70 USD into settled cash', cash: { USD: 878.70 } }],
        cash: { account: { USD: { settled: 488_952.20, unsettled: 0, reserved: 2_160.80, availableToTrade: 486_791.40, availableToWithdraw: 486_791.40 } } }, // 488,952.20 - 2,160.80
        pending: [],
        balance: { account: { cash: 488_952.20, receivable: null } },
      },
    },
    {
      id: 'premium-up-3', action: 'quote', instrument: 'main', quote: { bid: 5.10, ask: 5.20, last: 5.15, bidSize: 500, askSize: 500 },
      expect: {
        positions: [
          { instrument: 'main', lot: 'calls', qty: 4, price: 5.15, value: 2_060, unrealized: 660 }, // 4 x 5.15 x 100 - 1,400
          { instrument: 'main', lot: 'written', qty: -2, price: 5.15, value: -1_030, unrealized: -150 }, // -1,030 + 880
          { instrument: 'stock', lot: 'calls', qty: 200, value: 10_804, unrealized: 804 },
        ],
        pnl: { account: { unrealized: 1_314, total: 786.20 } }, // 660 - 150 + 804; -520 - 7.80 + 1,314
        nav: { account: 500_786.20, book: 1_000_786.20 },
        balance: { account: { positions: 11_834, assets: 500_786.20, netAssets: 500_786.20 } },
      },
    },
    {
      id: 'withdraw-reserved-cash', covers: 'reserve', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 487_000,
      status: 'blocked', reason: 'Cash reserved against the written calls cannot leave the Account: 488,952.20 is settled but only 486,791.40 is free.',
      expect: { refused: 'Alpha has 486,791.40 USD of settled USD available; 487,000.00 USD requested' },
    },
    {
      id: 'buy-to-close', covers: ['close', 'reserve release'], action: 'close', lot: 'written', scope: 'position', percent: 100, // the Close button on the written position
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy', qty: 2, estimate: 5.20, model: 'quoted-bid-ask', settleDate: '2026-03-10', cash: -1_040, fees: 1.30 }], // 2 x 5.20 (the ask) x 100
          cash: { USD: { purchases: 1_040, fees: 1.30, reserved: 0, required: 1_041.30 } } },
        result: { status: 'closed', orders: [{ action: 'buy', status: 'filled', filledQty: 2, avgPrice: 5.20 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 2 HRSI260320C50 @ 5.20 USD (realized -160.00 USD)' }], // 880 received - 1,040 paid
        cash: { account: { USD: { settled: 488_952.20, unsettled: -1_041.30, reserved: 0, availableToTrade: 487_910.90, availableToWithdraw: 487_910.90 } } }, // the reserve is released with the position
        positions: [{ instrument: 'main', lot: 'calls', qty: 4, value: 2_060, unrealized: 660 }, { instrument: 'stock', lot: 'calls', qty: 200, value: 10_804, unrealized: 804 }],
        holdings: { main: { long: 4, short: 0, net: 4 }, stock: { long: 200, short: 0, net: 200 } },
        pending: [{ instrument: 'main', lot: 'written', dueDate: '2026-03-10', amount: -1_041.30, into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }],
        pnl: { account: { realized: -680, commissions: -9.10, unrealized: 1_464, total: 774.90 } }, // -520 - 160; 660 + 804
        nav: { account: 500_774.90, book: 1_000_774.90 },
        balance: { account: { cash: 488_952.20, positions: 12_864, payable: 1_041.30, assets: 501_816.20, liabilities: 1_041.30, netAssets: 500_774.90 } },
      },
    },
    {
      id: 'settle-close-written', covers: 'settlement', action: 'clock', to: MAR(10),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,041.30 USD from settled cash', cash: { USD: -1_041.30 } }],
        cash: { account: { USD: { settled: 487_910.90, unsettled: 0, availableToTrade: 487_910.90, availableToWithdraw: 487_910.90 } } },
        pending: [],
        balance: { account: { cash: 487_910.90, payable: null, assets: 500_774.90, liabilities: 0 } },
      },
    },
    // The close of the underlying on the expiration date, as the data source will report it once the day is over.
    { id: 'expiry-close-known-later', action: 'close_price', instrument: 'stock', date: '2026-03-20', value: 55.40, expect: {} },
    {
      id: 'expiry-morning-stock', action: 'quote', instrument: 'stock', quote: { bid: 55.30, ask: 55.34, last: 55.32, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'calls', qty: 4 }, { instrument: 'stock', lot: 'calls', qty: 200, price: 55.32, value: 11_064, unrealized: 1_064 }], // 200 x 55.32
        pnl: { account: { unrealized: 1_724, total: 1_034.90 } }, // 660 + 1,064
        nav: { account: 501_034.90, book: 1_001_034.90 },
        balance: { account: { positions: 13_124, assets: 501_034.90, netAssets: 501_034.90 } },
      },
    },
    {
      id: 'expiry-morning-premium', action: 'quote', instrument: 'main', quote: { bid: 5.28, ask: 5.36, last: 5.32, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'calls', qty: 4, price: 5.32, value: 2_128, unrealized: 728 }, { instrument: 'stock', lot: 'calls', qty: 200 }], // 4 x 5.32 x 100 - 1,400
        pnl: { account: { unrealized: 1_792, total: 1_102.90 } },
        nav: { account: 501_102.90, book: 1_001_102.90 },
        balance: { account: { positions: 13_192, assets: 501_102.90, netAssets: 501_102.90 } },
      },
    },
    {
      // 10:00 on the expiration date: the close does not exist yet, so the expiry item waits, visibly.
      id: 'expiry-day-before-the-close', covers: 'expiry', action: 'clock', to: MAR(20),
      expect: { lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'blocked' }] },
    },
    {
      // 17:30: the close is 55.40, above the strike of 50. The 4 calls are exercised automatically. Their premium,
      // 4 x 3.50 x 100 = 1,400, is realized as a loss and 400 shares are delivered at 50 = 20,000, due Monday.
      // 600 shares at a cost of 30,000 are worth 600 x 55.32 = 33,192.
      id: 'expiry-in-the-money', covers: ['expiry', 'exercise'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 4 HRSI260320C50 at strike 50', owner: 'account', date: '2026-03-20' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 400 HRSI at strike 50 on exercise of HRSI260320C50/, owner: 'account', date: '2026-03-20' },
        ],
        cash: { account: { USD: { settled: 487_910.90, unsettled: -20_000, availableToTrade: 467_910.90, availableToWithdraw: 467_910.90 } } },
        positions: [{ instrument: 'stock', lot: 'calls', owner: 'account', direction: 'long', qty: 600, cost: 30_000, avgCost: 50, price: 55.32, value: 33_192, unrealized: 3_192 }],
        holdings: { main: null, stock: { long: 600, short: 0, net: 600 } },
        pending: [{ instrument: 'stock', dueDate: '2026-03-23', amount: -20_000, into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -2_080, unrealized: 3_192, total: 1_102.90 } }, // -680 - 1,400; -2,080 - 9.10 + 3,192
        nav: { account: 501_102.90, book: 1_001_102.90 }, // unchanged: 2,128 of option value became 2,128 of share gain (4 x 100 x (55.32 - 50))
        balance: { account: { cash: 487_910.90, positions: 33_192, payable: 20_000, assets: 521_102.90, liabilities: 20_000, netAssets: 501_102.90 } },
      },
    },
    {
      id: 'settle-delivery', covers: 'settlement', action: 'clock', to: MAR(23),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 20,000.00 USD from settled cash', cash: { USD: -20_000 } }],
        cash: { account: { USD: { settled: 467_910.90, unsettled: 0, availableToTrade: 467_910.90, availableToWithdraw: 467_910.90 } } },
        pending: [],
        balance: { account: { cash: 467_910.90, payable: null, assets: 501_102.90, liabilities: 0 } },
      },
    },
    optionTicket({
      id: 'trade-after-expiry', covers: 'expired contract', instrument: 'main', side: 'buy', qty: 1, symbol: 'HRSI260320C50',
      status: 'blocked', reason: 'The contract expired on 20 March 2026; nothing can be traded in it.',
      expect: { refused: 'HRSI260320C50 expired on 2026-03-20' },
    }),
    {
      id: 'sell-shares', covers: 'close', action: 'ticket', ticketOf: 'equity', instrument: 'stock', side: 'sell', qty: 600, from: 'calls',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', instrument: 'stock', qty: 600, estimate: 55.30, model: 'quoted-bid-ask', settleDate: '2026-03-24', cash: 33_180, fees: 3 }] }, // 600 x 55.30 (the bid); 600 x 0.005
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 600, avgPrice: 55.30 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 600 HRSI @ 55.30 USD (realized 3,180.00 USD)' }], // 33,180 - 30,000
        cash: { account: { USD: { settled: 467_910.90, unsettled: 33_177, availableToTrade: 501_087.90, availableToWithdraw: 467_910.90 } } },
        positions: [],
        holdings: { stock: null },
        pending: [{ instrument: 'stock', dueDate: '2026-03-24', amount: 33_177, into: 'cash' }],
        // Whole scenario: calls bought for 2,800 and 2 sold for 880; 600 shares taken at 50 and sold at 55.30 (+3,180);
        // written calls -160; commissions 9.10 + 3.00. 880 - 2,800 + 3,180 - 160 - 12.10 = 1,087.90.
        pnl: { account: { realized: 1_100, commissions: -12.10, unrealized: 0, total: 1_087.90 } },
        nav: { account: 501_087.90, book: 1_001_087.90 },
        balance: { account: { cash: 467_910.90, receivable: 33_177, positions: null, assets: 501_087.90, liabilities: 0, netAssets: 501_087.90 } },
      },
    },
    {
      id: 'settle-shares', covers: 'settlement', action: 'clock', to: MAR(24),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 33,177.00 USD into settled cash', cash: { USD: 33_177 } }],
        cash: { account: { USD: { settled: 501_087.90, unsettled: 0, reserved: 0, availableToTrade: 501_087.90, availableToWithdraw: 501_087.90 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 501_087.90, receivable: null, assets: 501_087.90, liabilities: 0, netAssets: 501_087.90 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// etf_option
// ---------------------------------------------------------------------------------------------
// American options on a NYSE Arca-listed ETF, 100 shares a contract, physical delivery. This
// scenario is the writer's side: cash-secured puts, a covered call (bought and written in one
// package on the Strategies page), an early assignment recorded by hand, a roll of the written puts
// to a later expiry and a lower strike, automatic assignment of the calls at the April expiry, and
// the rolled puts lapsing in May. The position is carried over Good Friday, 3 April 2026, when US
// markets are closed.
const ETF_PUT = 'CVTM260417P80', ETF_CALL = 'CVTM260417C86', ETF_PUT2 = 'CVTM260515P78';
const etfOptionDraft = (name, symbol, right, strike, expiration) => ({
  productId: 'etf_option', name, symbol, marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlying: 'etf', multiplier: 100,
  terms: { right, strike, expiration, exercise: 'american', settlement: 'physical', deliverable: { units: 100 } },
});
const etfOption = {
  productId: 'etf_option',
  title: 'Corvane Total Market ETF options (17 April 80 put, 17 April 86 call, 15 May 78 put), Cboe-listed, American, 100 shares, physical delivery',
  matrix: {
    ticket: `${OPTION_TICKET.ticket}. The covered call is assembled on the Strategies page (execution template Covered Call)`,
    requiredFields: [...OPTION_TICKET.requiredFields, 'Strategies page: Account, execution template, instrument, shares, expiration, call strike', 'Roll dialog: new expiration, new strike'],
    automaticInputs: OPTION_TICKET.automaticInputs,
    manualInputs: ['early assignment of a written American option (contracts), recorded by hand from the position Lifecycle menu'],
    settlement: 'Premium T+1 on the US calendar: a trade on Thursday 2 April settles Monday 6 April, Good Friday being a market holiday; shares delivered on assignment settle T+1 at the strike',
    lifecycle: 'Expiry item on each expiration date; written call in the money: assigned automatically, the shares held against it are delivered at the strike (simulated delivery); written put out of the money: lapses; early assignment by hand; roll to a later expiry in one package',
    accounting: 'Premium received is a negative cost until the option is bought back, assigned or lapses, when it is realized; shares delivered are carried at the strike; a roll realizes the difference on the contract it closes',
    collateral: 'A written put reserves its full strike value (cash-secured: contracts x 100 x strike), re-sized when contracts are assigned or rolled and released when the put is gone; a call written against shares in the same strategy instance reserves nothing; reserved cash is not buying power',
  },
  start: MAR(30),
  settlementCheck: { lag: 1, holidays: ['2026-04-03'] }, // US markets are closed on Good Friday, 3 April 2026; Memorial Day is 25 May
  book: book('Matrix ETF option'),
  instruments: {
    etf: { productId: 'etf', name: 'Corvane Total Market ETF', symbol: 'CVTM', marketView: 'US_CASH', venue: 'NYSE Arca', venueType: 'exchange', venueCountry: 'US', issuer: 'Corvane Funds Trust', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    put: etfOptionDraft('CVTM 17 April 2026 80 put', ETF_PUT, 'P', 80, '2026-04-17'),
    call: etfOptionDraft('CVTM 17 April 2026 86 call', ETF_CALL, 'C', 86, '2026-04-17'),
    put2: etfOptionDraft('CVTM 15 May 2026 78 put', ETF_PUT2, 'P', 78, '2026-05-15'),
  },
  quotes: {
    etf: { bid: 84.00, ask: 84.04, last: 84.02, bidSize: 20000, askSize: 20000 },
    put: { bid: 1.40, ask: 1.50, last: 1.45, bidSize: 500, askSize: 500 },
    call: { bid: 1.10, ask: 1.20, last: 1.15, bidSize: 500, askSize: 500 },
    put2: { bid: 1.60, ask: 1.70, last: 1.65, bidSize: 500, askSize: 500 },
  },
  expectAtStart: START_STATE,
  steps: [
    optionTicket({
      // Writing 4 puts. Cash-secured: the whole strike value is reserved, 4 x 100 x 80 = 32,000.
      id: 'write-puts', covers: ['write', 'reserve'], instrument: 'put', side: 'sell', qty: 4, symbol: ETF_PUT, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 4, estimate: 1.40, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-31', calendar: 'US',
            cash: 560, // 4 contracts x 1.40 (the bid) x 100
            fees: 2.60 }], // 4 x 0.65
          cash: { USD: { purchases: 0, proceeds: 560, fees: 2.60, reserved: 32_000, required: 32_002.60, available: 500_000, shortfall: 0, netCash: 557.40 } },
          netPremium: { amount: -560, ccy: 'USD', type: 'credit' },
          optionRequirement: [{ ccy: 'USD', amount: 32_000, finite: 32_000, naked: 0, uncoveredCallUnits: 0 }],
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 4, avgPrice: 1.40, fills: [{ qty: 4, price: 1.40, model: 'quoted-bid-ask', settleDate: '2026-03-31', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: /^Sold 4 CVTM260417P80 @ 1\.40 USD$/, owner: 'account', date: '2026-03-30' }],
        cash: { account: { USD: { settled: 500_000, unsettled: 557.40, reserved: 32_000, availableToTrade: 468_557.40, availableToWithdraw: 468_000 } } }, // 500,000 + 557.40 - 32,000; 500,000 - 32,000
        positions: [{ instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -4, avgCost: 1.40, cost: -560, price: 1.45,
          value: -580, // -4 x 1.45 (last) x 100
          unrealized: -20, priceSource: 'Test fixture' }],
        holdings: { put: { long: 0, short: 4, net: -4 } },
        pending: [{ instrument: 'put', owner: 'account', dueDate: '2026-03-31', amount: 557.40, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'put', dueDate: '2026-04-17', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -2.60, fees: 0, borrowFunding: 0, unrealized: -20, total: -22.60 } },
        nav: { account: 499_977.40, book: 999_977.40 },
        balance: { account: { cash: 500_000, receivable: 557.40, positions: -580, assets: 499_977.40, liabilities: 0, netAssets: 499_977.40 } },
      },
    }),
    {
      // 500,000 is settled, but 32,000 of it is reserved: 5,600 shares at 84.04 = 470,624.00 plus 28.00 commission
      // needs 470,652.00 and only 468,557.40 can be committed. Shortfall 2,094.60.
      id: 'buy-with-reserved-cash', covers: 'reserve', action: 'ticket', ticketOf: 'equity', instrument: 'etf', side: 'buy', qty: 5600,
      status: 'blocked', reason: 'Cash reserved against the written puts is not buying power.',
      expect: { refused: /is short 2,094\.60 USD.*468,557\.40 USD is available/s },
    },
    {
      id: 'settle-put-premium', covers: 'settlement', action: 'clock', to: MAR(31),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 557.40 USD into settled cash', cash: { USD: 557.40 }, date: '2026-03-31' }],
        cash: { account: { USD: { settled: 500_557.40, unsettled: 0, reserved: 32_000, availableToTrade: 468_557.40, availableToWithdraw: 468_557.40 } } },
        pending: [],
        balance: { account: { cash: 500_557.40, receivable: null } },
      },
    },
    {
      // Covered call, as the Strategies page sends it: buy 300 shares and write 3 calls against them (300 / 100 a
      // contract), in one package. The call leg waits for the share leg. Shares in the same strategy instance cover
      // the calls unit for unit, so nothing is reserved for them.
      id: 'covered-call', covers: ['covered write', 'open'], action: 'package', as: 'covered', instrument: 'etf',
      input: {
        template: 'covered_call', underlyingId: '$inst:etf', origin: 'strategy_page', investmentStrategy: null, holdingPeriod: null, hedgeObjective: null,
        mode: 'new', quantity: 300, hedgeRatio: 1, options: { expiration: '2026-04-17', strikes: { call: 86 }, contracts: null },
        borrow: null, orderType: 'market', limitPrice: null, stopPrice: null, tif: 'day', financing: null,
      },
      strategyPage: { template: 'Covered Call', underlying: 'etf', quantity: 300, expiration: '2026-04-17', strikes: { 'Call strike': 86 } },
      expect: {
        preview: {
          blocking: 0, errors: [], template: 'covered_call',
          legs: [
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'etf', qty: 300, estimate: 84.04, model: 'quoted-bid-ask', settleDate: '2026-04-01', cash: -25_212, fees: 1.50 }, // 300 x 84.04 (the ask); 300 x 0.005
            { kind: 'trade', action: 'sell', purpose: 'hedge', instrument: 'call', qty: 3, estimate: 1.10, model: 'quoted-bid-ask', settleDate: '2026-04-01', cash: 330, fees: 1.95, dependsOn: [1] }, // 3 x 1.10 (the bid) x 100; 3 x 0.65
          ],
          cash: { USD: { purchases: 25_212, proceeds: 330, fees: 3.45, reserved: 0, required: 25_215.45, available: 468_557.40, shortfall: 0, netCash: -24_885.45 } },
          netPremium: { amount: -330, ccy: 'USD', type: 'credit' },
          optionRequirement: [{ ccy: 'USD', amount: 0, finite: 0, naked: 0, uncoveredCallUnits: 0, coveredCallUnits: 300 }],
        },
        result: { status: 'open', orders: [
          { kind: 'trade', action: 'buy', instrument: 'etf', status: 'filled', filledQty: 300, avgPrice: 84.04 },
          { kind: 'trade', action: 'sell', instrument: 'call', status: 'filled', filledQty: 3, avgPrice: 1.10 },
        ] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 300 CVTM @ 84.04 USD' }, { type: 'trade.fill', summary: /^Sold 3 CVTM260417C86 @ 1\.10 USD$/ }],
        // Owed: 25,212 + 1.50 = 25,213.50. Due to the Account: 330 - 1.95 = 328.05. Reserve unchanged at 32,000 (the puts).
        cash: { account: { USD: { settled: 500_557.40, unsettled: -24_885.45, reserved: 32_000, availableToTrade: 443_671.95, availableToWithdraw: 443_343.90 } } }, // 500,557.40 + 328.05 - 25,213.50 - 32,000; 500,557.40 - 25,213.50 - 32,000
        positions: [
          { instrument: 'call', lot: 'covered', owner: 'account', direction: 'short', qty: -3, cost: -330, avgCost: 1.10, price: 1.15, value: -345, unrealized: -15 },
          { instrument: 'etf', lot: 'covered', owner: 'account', direction: 'long', qty: 300, cost: 25_212, avgCost: 84.04, price: 84.02, value: 25_206, unrealized: -6 }, // 300 x 84.02
          { instrument: 'put', lot: 'puts', qty: -4, cost: -560, value: -580, unrealized: -20 },
        ],
        holdings: { call: { long: 0, short: 3, net: -3 }, etf: { long: 300, short: 0, net: 300 }, put: { long: 0, short: 4, net: -4 } },
        pending: [{ instrument: 'call', lot: 'covered', dueDate: '2026-04-01', amount: 328.05, into: 'cash' }, { instrument: 'etf', lot: 'covered', dueDate: '2026-04-01', amount: -25_213.50, into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-04-17', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-04-17', status: 'pending' }],
        pnl: { account: { commissions: -6.05, unrealized: -41, total: -47.05 } }, // -15 - 6 - 20
        nav: { account: 499_952.95, book: 999_952.95 },
        balance: { account: { cash: 500_557.40, receivable: 328.05, positions: 24_281, payable: 25_213.50, assets: 525_166.45, liabilities: 25_213.50, netAssets: 499_952.95 } }, // -345 + 25,206 - 580
      },
    },
    {
      id: 'settle-covered-call', covers: 'settlement', action: 'clock', to: APR(1),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 328.05 USD into settled cash' }, { type: 'settlement.pay', summary: 'paid 25,213.50 USD from settled cash' }],
        cash: { account: { USD: { settled: 475_671.95, unsettled: 0, reserved: 32_000, availableToTrade: 443_671.95, availableToWithdraw: 443_671.95 } } }, // 500,557.40 + 328.05 - 25,213.50
        pending: [],
        balance: { account: { cash: 475_671.95, receivable: null, payable: null, assets: 499_952.95, liabilities: 0 } },
      },
    },
    { id: 'thursday-2-april', action: 'clock', to: APR(2), expect: {} },
    {
      id: 'etf-dips', action: 'quote', instrument: 'etf', quote: { bid: 79.48, ask: 79.52, last: 79.50, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [{ instrument: 'call', qty: -3 }, { instrument: 'etf', lot: 'covered', qty: 300, price: 79.50, value: 23_850, unrealized: -1_362 }, { instrument: 'put', qty: -4 }], // 300 x 79.50 - 25,212
        pnl: { account: { unrealized: -1_397, total: -1_403.05 } }, // -15 - 1,362 - 20
        nav: { account: 498_596.95, book: 998_596.95 },
        balance: { account: { positions: 22_925, assets: 498_596.95, netAssets: 498_596.95 } },
      },
    },
    {
      id: 'put-premium-up', action: 'quote', instrument: 'put', quote: { bid: 1.95, ask: 2.05, last: 2.00, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'call', qty: -3 }, { instrument: 'etf', qty: 300 }, { instrument: 'put', lot: 'puts', qty: -4, price: 2.00, value: -800, unrealized: -240 }], // -4 x 2.00 x 100; -800 + 560
        pnl: { account: { unrealized: -1_617, total: -1_623.05 } },
        nav: { account: 498_376.95, book: 998_376.95 },
        balance: { account: { positions: 22_705, assets: 498_376.95, netAssets: 498_376.95 } },
      },
    },
    {
      id: 'call-premium-down', action: 'quote', instrument: 'call', quote: { bid: 0.20, ask: 0.26, last: 0.23, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'call', lot: 'covered', qty: -3, price: 0.23, value: -69, unrealized: 261 }, { instrument: 'etf', qty: 300 }, { instrument: 'put', qty: -4 }], // -3 x 0.23 x 100; -69 + 330
        pnl: { account: { unrealized: -1_341, total: -1_347.05 } }, // 261 - 1,362 - 240
        nav: { account: 498_652.95, book: 998_652.95 },
        balance: { account: { positions: 22_981, assets: 498_652.95, netAssets: 498_652.95 } },
      },
    },
    {
      id: 'exercise-a-written-option', covers: 'exercise', action: 'lifecycle', lot: 'puts', body: { action: 'exercise', contracts: 1 },
      status: 'blocked', reason: 'Exercise belongs to the holder. A written option can only be assigned.',
      expect: { refused: { engine: 'Only a long option can be exercised', api: 'Only a long option can be exercised', browser: 'offers only: Early assignment, Manual cash flow' } },
    },
    {
      // The holder exercises 1 of the 4 puts early: recorded by hand as an early assignment. That contract is closed
      // at zero, so its premium, 1.40 x 100 = 140, is realized. 100 shares are delivered to the Account at the strike:
      // 8,000, due on the next business day, which is Monday 6 April (Friday is Good Friday). The shares are worth
      // 100 x 79.50 = 7,950. The reserve falls to 3 x 100 x 80 = 24,000.
      id: 'assigned-early', covers: ['assignment', 'reserve'], action: 'lifecycle', lot: 'puts', body: { action: 'assign', contracts: 1 },
      expect: {
        events: [
          { type: 'option.assigned', summary: 'Assigned: 1 CVTM260417P80 at strike 80', owner: 'account', date: '2026-04-02' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 100 CVTM at strike 80 on assignment of CVTM260417P80/, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 475_671.95, unsettled: -8_000, reserved: 24_000, availableToTrade: 443_671.95, availableToWithdraw: 443_671.95 } } }, // 475,671.95 - 8,000 - 24,000
        positions: [
          { instrument: 'call', lot: 'covered', qty: -3, value: -69, unrealized: 261 },
          { instrument: 'etf', lot: 'covered', qty: 300, value: 23_850, unrealized: -1_362 },
          { instrument: 'etf', lot: 'puts', owner: 'account', direction: 'long', qty: 100, cost: 8_000, avgCost: 80, price: 79.50, value: 7_950, unrealized: -50 },
          { instrument: 'put', lot: 'puts', qty: -3, cost: -420, avgCost: 1.40, price: 2.00, value: -600, unrealized: -180 }, // -3 x 2.00 x 100; -600 + 420
        ],
        holdings: { etf: { long: 400, short: 0, net: 400 }, put: { long: 0, short: 3, net: -3 } },
        pending: [{ instrument: 'etf', lot: 'puts', dueDate: '2026-04-06', amount: -8_000, into: 'cash' }],
        pnl: { account: { realized: 140, unrealized: -1_331, total: -1_197.05 } }, // 261 - 1,362 - 50 - 180; 140 - 6.05 - 1,331
        nav: { account: 498_802.95, book: 998_802.95 }, // 150 higher: the time value of the assigned put (2.00 x 100 = 200 against 50 of intrinsic value)
        balance: { account: { cash: 475_671.95, positions: 31_131, payable: 8_000, assets: 506_802.95, liabilities: 8_000, netAssets: 498_802.95 } }, // -69 + 23,850 + 7,950 - 600
      },
    },
    {
      // Good Friday: the market and the settlement system are closed. Nothing settles and nothing changes.
      id: 'good-friday', covers: 'holiday', action: 'clock', to: APR(3),
      expect: {},
    },
    {
      id: 'settle-assignment', covers: ['settlement', 'holiday'], action: 'clock', to: APR(6),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 8,000.00 USD from settled cash', cash: { USD: -8_000 }, date: '2026-04-06' }],
        cash: { account: { USD: { settled: 467_671.95, unsettled: 0, reserved: 24_000, availableToTrade: 443_671.95, availableToWithdraw: 443_671.95 } } },
        pending: [],
        balance: { account: { cash: 467_671.95, payable: null, assets: 498_802.95, liabilities: 0 } },
      },
    },
    {
      id: 'etf-recovers', action: 'quote', instrument: 'etf', quote: { bid: 82.00, ask: 82.04, last: 82.02, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [
          { instrument: 'call', qty: -3 },
          { instrument: 'etf', lot: 'covered', qty: 300, price: 82.02, value: 24_606, unrealized: -606 }, // 300 x 82.02 - 25,212
          { instrument: 'etf', lot: 'puts', qty: 100, price: 82.02, value: 8_202, unrealized: 202 },
          { instrument: 'put', qty: -3 },
        ],
        pnl: { account: { unrealized: -323, total: -189.05 } }, // 261 - 606 + 202 - 180
        nav: { account: 499_810.95, book: 999_810.95 },
        balance: { account: { positions: 32_139, assets: 499_810.95, netAssets: 499_810.95 } },
      },
    },
    {
      id: 'put-premium-down', action: 'quote', instrument: 'put', quote: { bid: 0.60, ask: 0.70, last: 0.65, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'call', qty: -3 }, { instrument: 'etf', qty: 300 }, { instrument: 'etf', qty: 100 }, { instrument: 'put', lot: 'puts', qty: -3, price: 0.65, value: -195, unrealized: 225 }], // -195 + 420
        pnl: { account: { unrealized: 82, total: 215.95 } }, // 261 - 606 + 202 + 225
        nav: { account: 500_215.95, book: 1_000_215.95 },
        balance: { account: { positions: 32_544, assets: 500_215.95, netAssets: 500_215.95 } },
      },
    },
    { id: 'may-put-quote', action: 'quote', instrument: 'put2', quote: { bid: 0.95, ask: 1.05, last: 1.00, bidSize: 500, askSize: 500 }, expect: {} }, // not held yet
    {
      id: 'call-premium', action: 'quote', instrument: 'call', quote: { bid: 0.40, ask: 0.46, last: 0.43, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'call', lot: 'covered', qty: -3, price: 0.43, value: -129, unrealized: 201 }, { instrument: 'etf', qty: 300 }, { instrument: 'etf', qty: 100 }, { instrument: 'put', qty: -3 }],
        pnl: { account: { unrealized: 22, total: 155.95 } }, // 201 - 606 + 202 + 225
        nav: { account: 500_155.95, book: 1_000_155.95 },
        balance: { account: { positions: 32_484, assets: 500_155.95, netAssets: 500_155.95 } },
      },
    },
    {
      // Roll the 3 written April 80 puts to the May 78 put: buy the April puts back at the ask, 3 x 0.70 x 100 = 210,
      // and write the May puts at the bid, 3 x 0.95 x 100 = 285. Net credit 75 before 3.90 of commission.
      // Closing the April puts realizes 420 received - 210 paid = 210. The reserve becomes 3 x 100 x 78 = 23,400.
      id: 'roll-puts', covers: 'roll', action: 'roll', lot: 'puts', newExpiration: '2026-05-15', newStrike: 78,
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'roll',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'put', qty: 3, estimate: 0.70, model: 'quoted-bid-ask', settleDate: '2026-04-07', cash: -210, fees: 1.95 },
            { kind: 'trade', action: 'sell', instrument: 'put2', qty: 3, estimate: 0.95, model: 'quoted-bid-ask', settleDate: '2026-04-07', cash: 285, fees: 1.95 },
          ],
          cash: { USD: { purchases: 210, proceeds: 285, fees: 3.90, reserved: 0, required: 213.90, shortfall: 0, netCash: 71.10 } }, // no more is reserved: 23,400 is needed and 24,000 is held
          netPremium: { amount: -75, ccy: 'USD', type: 'credit', complete: true },
          optionRequirement: [{ ccy: 'USD', amount: 23_400, finite: 23_400, naked: 0 }],
        },
        result: { status: 'open', orders: [
          { kind: 'trade', action: 'buy', instrument: 'put', status: 'filled', filledQty: 3, avgPrice: 0.70 },
          { kind: 'trade', action: 'sell', instrument: 'put2', status: 'filled', filledQty: 3, avgPrice: 0.95 },
        ] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 3 CVTM260417P80 @ 0.70 USD (realized 210.00 USD)' }, { type: 'trade.fill', summary: /^Sold 3 CVTM260515P78 @ 0\.95 USD$/ }],
        cash: { account: { USD: { settled: 467_671.95, unsettled: 71.10, reserved: 23_400, availableToTrade: 444_343.05, availableToWithdraw: 444_060 } } }, // 467,671.95 + 283.05 - 211.95 - 23,400; 467,671.95 - 211.95 - 23,400
        positions: [
          { instrument: 'call', lot: 'covered', qty: -3, value: -129, unrealized: 201 },
          { instrument: 'etf', lot: 'covered', qty: 300, value: 24_606, unrealized: -606 },
          { instrument: 'etf', lot: 'puts', qty: 100, value: 8_202, unrealized: 202 },
          { instrument: 'put2', lot: 'puts', owner: 'account', direction: 'short', qty: -3, cost: -285, avgCost: 0.95, price: 1.00, value: -300, unrealized: -15 },
        ],
        holdings: { put: null, put2: { long: 0, short: 3, net: -3 } },
        pending: [{ instrument: 'put', lot: 'puts', dueDate: '2026-04-07', amount: -211.95, into: 'cash' }, { instrument: 'put2', lot: 'puts', dueDate: '2026-04-07', amount: 283.05, into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-04-17', status: 'pending' }, { type: 'option.expiry', instrument: 'put2', dueDate: '2026-05-15', status: 'pending' }],
        pnl: { account: { realized: 350, commissions: -9.95, unrealized: -218, total: 122.05 } }, // 140 + 210; 201 - 606 + 202 - 15
        nav: { account: 500_122.05, book: 1_000_122.05 },
        balance: { account: { cash: 467_671.95, receivable: 283.05, positions: 32_379, payable: 211.95, assets: 500_334, liabilities: 211.95, netAssets: 500_122.05 } }, // -129 + 24,606 + 8,202 - 300
      },
    },
    {
      id: 'settle-roll', covers: 'settlement', action: 'clock', to: APR(7),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 283.05 USD into settled cash' }, { type: 'settlement.pay', summary: 'paid 211.95 USD from settled cash' }],
        cash: { account: { USD: { settled: 467_743.05, unsettled: 0, reserved: 23_400, availableToTrade: 444_343.05, availableToWithdraw: 444_343.05 } } },
        pending: [],
        balance: { account: { cash: 467_743.05, receivable: null, payable: null, assets: 500_122.05, liabilities: 0 } },
      },
    },
    { id: 'april-close-known-later', action: 'close_price', instrument: 'etf', date: '2026-04-17', value: 87.20, expect: {} },
    {
      id: 'april-expiry-morning', covers: 'expiry', action: 'clock', to: APR(17),
      expect: { lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-04-17', status: 'blocked' }, { type: 'option.expiry', instrument: 'put2', dueDate: '2026-05-15', status: 'pending' }] },
    },
    {
      id: 'etf-rallies', action: 'quote', instrument: 'etf', quote: { bid: 87.10, ask: 87.14, last: 87.12, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [
          { instrument: 'call', qty: -3 },
          { instrument: 'etf', lot: 'covered', qty: 300, price: 87.12, value: 26_136, unrealized: 924 }, // 300 x 87.12 - 25,212
          { instrument: 'etf', lot: 'puts', qty: 100, price: 87.12, value: 8_712, unrealized: 712 },
          { instrument: 'put2', qty: -3 },
        ],
        pnl: { account: { unrealized: 1_822, total: 2_162.05 } }, // 201 + 924 + 712 - 15; 350 - 9.95 + 1,822
        nav: { account: 502_162.05, book: 1_002_162.05 },
        balance: { account: { positions: 34_419, assets: 502_162.05, netAssets: 502_162.05 } },
      },
    },
    {
      id: 'call-in-the-money', action: 'quote', instrument: 'call', quote: { bid: 1.10, ask: 1.20, last: 1.15, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'call', lot: 'covered', qty: -3, price: 1.15, value: -345, unrealized: -15 }, { instrument: 'etf', qty: 300 }, { instrument: 'etf', qty: 100 }, { instrument: 'put2', qty: -3 }],
        pnl: { account: { unrealized: 1_606, total: 1_946.05 } },
        nav: { account: 501_946.05, book: 1_001_946.05 },
        balance: { account: { positions: 34_203, assets: 501_946.05, netAssets: 501_946.05 } },
      },
    },
    {
      id: 'may-put-decays', action: 'quote', instrument: 'put2', quote: { bid: 0.10, ask: 0.16, last: 0.13, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'call', qty: -3 }, { instrument: 'etf', qty: 300 }, { instrument: 'etf', qty: 100 }, { instrument: 'put2', lot: 'puts', qty: -3, price: 0.13, value: -39, unrealized: 246 }], // -39 + 285
        pnl: { account: { unrealized: 1_867, total: 2_207.05 } }, // -15 + 924 + 712 + 246
        nav: { account: 502_207.05, book: 1_002_207.05 },
        balance: { account: { positions: 34_464, assets: 502_207.05, netAssets: 502_207.05 } },
      },
    },
    {
      // April expiry, 17:30: the ETF closed at 87.20, above the call strike of 86. The 3 written calls are assigned
      // automatically. Their premium, 330, is realized, and the 300 shares held against them are delivered at 86:
      // 25,800 due Monday, 588 more than their cost of 25,212.
      id: 'april-expiry-calls-assigned', covers: ['expiry', 'assignment'], action: 'clock', to: APR(17, '17:30'),
      expect: {
        events: [
          { type: 'option.assigned', summary: 'Assigned: 3 CVTM260417C86 at strike 86', owner: 'account', date: '2026-04-17' },
          { type: 'option.delivery', summary: /^Simulated delivery: delivered 300 CVTM at strike 86 on assignment of CVTM260417C86/, owner: 'account', date: '2026-04-17' },
        ],
        cash: { account: { USD: { settled: 467_743.05, unsettled: 25_800, reserved: 23_400, availableToTrade: 470_143.05, availableToWithdraw: 444_343.05 } } },
        positions: [{ instrument: 'etf', lot: 'puts', qty: 100, value: 8_712, unrealized: 712 }, { instrument: 'put2', lot: 'puts', qty: -3, value: -39, unrealized: 246 }],
        holdings: { call: null, etf: { long: 100, short: 0, net: 100 } },
        pending: [{ instrument: 'etf', lot: 'covered', dueDate: '2026-04-20', amount: 25_800, into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'put2', dueDate: '2026-05-15', status: 'pending' }],
        pnl: { account: { realized: 1_268, unrealized: 958, total: 2_216.05 } }, // 350 + 330 + 588; 712 + 246
        nav: { account: 502_216.05, book: 1_002_216.05 },
        balance: { account: { cash: 467_743.05, receivable: 25_800, positions: 8_673, assets: 502_216.05, liabilities: 0, netAssets: 502_216.05 } },
      },
    },
    {
      id: 'settle-called-away', covers: 'settlement', action: 'clock', to: APR(20),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 25,800.00 USD into settled cash', cash: { USD: 25_800 } }],
        cash: { account: { USD: { settled: 493_543.05, unsettled: 0, reserved: 23_400, availableToTrade: 470_143.05, availableToWithdraw: 470_143.05 } } },
        pending: [],
        balance: { account: { cash: 493_543.05, receivable: null } },
      },
    },
    {
      id: 'sell-assigned-shares', covers: 'close', action: 'ticket', ticketOf: 'equity', instrument: 'etf', side: 'sell', qty: 100, from: 'puts',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', instrument: 'etf', qty: 100, estimate: 87.10, model: 'quoted-bid-ask', settleDate: '2026-04-21', cash: 8_710, fees: 1 }] }, // 100 x 87.10; 0.50 raised to the 1.00 minimum
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 100, avgPrice: 87.10 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 100 CVTM @ 87.10 USD (realized 710.00 USD)' }], // 8,710 - 8,000
        cash: { account: { USD: { settled: 493_543.05, unsettled: 8_709, reserved: 23_400, availableToTrade: 478_852.05, availableToWithdraw: 470_143.05 } } },
        positions: [{ instrument: 'put2', lot: 'puts', qty: -3, value: -39, unrealized: 246 }],
        holdings: { etf: null },
        pending: [{ instrument: 'etf', lot: 'puts', dueDate: '2026-04-21', amount: 8_709, into: 'cash' }],
        pnl: { account: { realized: 1_978, commissions: -10.95, unrealized: 246, total: 2_213.05 } },
        nav: { account: 502_213.05, book: 1_002_213.05 },
        balance: { account: { cash: 493_543.05, receivable: 8_709, positions: -39, assets: 502_213.05, liabilities: 0, netAssets: 502_213.05 } },
      },
    },
    {
      id: 'settle-shares', covers: 'settlement', action: 'clock', to: APR(21),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 8,709.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 502_252.05, unsettled: 0, reserved: 23_400, availableToTrade: 478_852.05, availableToWithdraw: 478_852.05 } } },
        pending: [],
        balance: { account: { cash: 502_252.05, receivable: null } },
      },
    },
    { id: 'may-close-known-later', action: 'close_price', instrument: 'etf', date: '2026-05-15', value: 85.60, expect: {} },
    {
      id: 'may-expiry-morning', covers: 'expiry', action: 'clock', to: MAY(15),
      expect: { lifecycle: [{ type: 'option.expiry', instrument: 'put2', dueDate: '2026-05-15', status: 'blocked' }] },
    },
    {
      // May expiry, 17:30: the ETF closed at 85.60, above the put strike of 78. The 3 written puts lapse: their
      // premium, 285, is realized and the 23,400 reserve is released.
      id: 'may-expiry-puts-lapse', covers: ['expiry', 'lapse', 'reserve release'], action: 'clock', to: MAY(15, '17:30'),
      expect: {
        events: [{ type: 'option.expired', summary: 'Expired worthless: 3 CVTM260515P78 (fixing 85.6)', owner: 'account', date: '2026-05-15' }],
        cash: { account: { USD: { settled: 502_252.05, unsettled: 0, reserved: 0, availableToTrade: 502_252.05, availableToWithdraw: 502_252.05 } }, treasury: { USD: { settled: 500_000 } } },
        positions: [],
        holdings: { put2: null },
        pending: [],
        lifecycle: [],
        // Whole scenario, cash in and out: +557.40 - 25,213.50 + 328.05 - 8,000 - 211.95 + 283.05 + 25,800 + 8,709 = 2,252.05.
        pnl: { account: { realized: 2_263, commissions: -10.95, unrealized: 0, total: 2_252.05 } }, // 1,978 + 285
        nav: { account: 502_252.05, book: 1_002_252.05 },
        balance: { account: { cash: 502_252.05, positions: null, assets: 502_252.05, liabilities: 0, netAssets: 502_252.05 } },
      },
    },
  ],
};

export default [equityOption, etfOption];
