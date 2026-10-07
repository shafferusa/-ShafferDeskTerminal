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

// ---------------------------------------------------------------------------------------------
// option_on_future
// ---------------------------------------------------------------------------------------------
// American options on a NYMEX-listed crude oil future. One option contract delivers ONE futures
// contract, and the future is 1,000 barrels: the premium is quoted per barrel and one option costs
// premium x 1,000. Exercise opens a futures position at the strike, which posts the future's initial
// margin and then settles variation every day like any future. A written put is cash-secured on the
// full contract value: contracts x 1,000 barrels x strike.
const FOP_CALL = 'BLCM6C70', FOP_PUT = 'BLCM6P66';
const futureOptionDraft = (name, symbol, right, strike) => ({
  productId: 'option_on_future', name, symbol, marketView: 'US_DERIV', venue: 'NYMEX', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlying: 'fut',
  multiplier: 1000, // premium multiplier: the future's 1,000 barrels
  terms: { right, strike, expiration: '2026-05-14', exercise: 'american', settlement: 'physical', deliverable: { units: 1 } }, // one futures contract per option
});
const optionOnFuture = {
  productId: 'option_on_future',
  title: 'Brennock Light Crude June 2026 options on the future (70 call, 66 put), NYMEX-listed, American, one 1,000-barrel future per contract',
  matrix: {
    ticket: 'The contract in its Marketplace (US Derivatives), Trade tab (option ticket), then the trade preview. Exercise is on the position Lifecycle menu; the futures position delivered is closed with Close on the strategy instance',
    requiredFields: OPTION_TICKET.requiredFields,
    automaticInputs: [...OPTION_TICKET.automaticInputs, 'initial margin per futures contract from the contract terms', 'daily settlement price of the future (close fixture)'],
    manualInputs: ['contract data at registration: premium multiplier (the future\'s multiplier), deliverable (1 future)', 'early exercise of a long American option (contracts), recorded by hand from the position Lifecycle menu'],
    settlement: 'Premium T+1 on the US calendar; the futures position delivered on exercise takes effect the same day and posts its initial margin at once',
    lifecycle: 'Expiry item on the option expiration date against the close of the future; in the money: exercised automatically into a futures position at the strike (simulated delivery) with initial margin posted; out of the money: lapses; the future then settles variation margin daily',
    accounting: 'Average premium; premium realized on sale, exercise and lapse; the future delivered is carried at the strike as its first settlement price, so the intrinsic value arrives as variation margin',
    collateral: 'A written put reserves contracts x 1,000 barrels x strike (cash-secured); initial margin of 6,500 a futures contract is posted from settled cash on exercise and released when the future is closed',
  },
  start: MAY(4),
  settlementCheck: { lag: 1, holidays: [] }, // US: no market holiday between 4 and 15 May 2026 (Memorial Day is 25 May)
  book: book('Matrix option on a future', { fees: { option: { perUnit: 1.50, minimum: 0, bps: 0 } } }), // 1.50 an option contract, 2.25 a futures contract
  instruments: {
    fut: { productId: 'commodity_future', name: 'Brennock Light Crude June 2026 future', symbol: 'BLCM6', marketView: 'US_DERIV', venue: 'NYMEX', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 1000,
      terms: { root: 'BLC', expiration: '2026-05-19', tickSize: 0.01, initialMargin: 6500, settlement: 'physical' } },
    main: futureOptionDraft('BLC June 2026 70 call', FOP_CALL, 'C', 70),
    put: futureOptionDraft('BLC June 2026 66 put', FOP_PUT, 'P', 66),
  },
  quotes: {
    fut: { bid: 71.20, ask: 71.22, last: 71.21, bidSize: 200, askSize: 200 },
    main: { bid: 2.10, ask: 2.14, last: 2.12, bidSize: 200, askSize: 200 },
    put: { bid: 0.80, ask: 0.84, last: 0.82, bidSize: 200, askSize: 200 },
  },
  expectAtStart: START_STATE,
  steps: [
    optionTicket({
      id: 'buy-to-open', covers: 'open', instrument: 'main', side: 'buy', qty: 4, symbol: FOP_CALL, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4, estimate: 2.14, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-05-05', calendar: 'US',
            cash: -8_560, // 4 contracts x 2.14 (the ask) x 1,000 barrels
            fees: 6, // 4 x 1.50
            notional: 284_840 }], // 4 contracts x 1 future x 1,000 barrels x 71.21 (the future's last price)
          cash: { USD: { purchases: 8_560, fees: 6, reserved: 0, required: 8_566, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 4, avgPrice: 2.14, fills: [{ qty: 4, price: 2.14, model: 'quoted-bid-ask', settleDate: '2026-05-05', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 4 BLCM6C70 @ 2.14 USD', owner: 'account', date: '2026-05-04' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -8_566, availableToTrade: 491_434, availableToWithdraw: 491_434 } } },
        positions: [{ instrument: 'main', lot: 'calls', owner: 'account', direction: 'long', qty: 4, avgCost: 2.14, cost: 8_560, price: 2.12,
          value: 8_480, // 4 x 2.12 (last) x 1,000
          unrealized: -80, priceSource: 'Test fixture' }],
        holdings: { main: { long: 4, short: 0, net: 4 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-05-05', amount: -8_566, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-05-14', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -6, fees: 0, borrowFunding: 0, unrealized: -80, total: -86 } },
        nav: { account: 499_914, book: 999_914 },
        balance: { account: { cash: 500_000, positions: 8_480, payable: 8_566, assets: 508_480, liabilities: 8_566, netAssets: 499_914 } },
      },
    }),
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAY(5),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 8,566.00 USD from settled cash', cash: { USD: -8_566 }, date: '2026-05-05' }],
        cash: { account: { USD: { settled: 491_434, unsettled: 0, availableToTrade: 491_434, availableToWithdraw: 491_434 } } },
        pending: [],
        balance: { account: { cash: 491_434, payable: null, assets: 499_914, liabilities: 0 } },
      },
    },
    optionTicket({
      // Writing 2 puts struck at 66. One contract stands for 1,000 barrels, so the cash-secured reserve is
      // 2 contracts x 1 future x 1,000 barrels x 66 = 132,000.
      id: 'write-puts', covers: ['write', 'reserve'], instrument: 'put', side: 'sell', qty: 2, symbol: FOP_PUT, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 2, estimate: 0.80, model: 'quoted-bid-ask', settleDate: '2026-05-06', cash: 1_600, fees: 3, // 2 x 0.80 (the bid) x 1,000; 2 x 1.50
            notional: 142_420 }], // 2 x 1,000 x 71.21
          cash: { USD: { purchases: 0, proceeds: 1_600, fees: 3, reserved: 132_000, required: 132_003, available: 491_434, shortfall: 0, netCash: 1_597 } },
          optionRequirement: [{ ccy: 'USD', amount: 132_000, finite: 132_000, naked: 0, uncoveredCallUnits: 0 }],
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 2, avgPrice: 0.80 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: /^Sold 2 BLCM6P66 @ 0\.80 USD$/, owner: 'account', date: '2026-05-05' }],
        cash: { account: { USD: { settled: 491_434, unsettled: 1_597, reserved: 132_000, availableToTrade: 361_031, availableToWithdraw: 359_434 } } }, // 491,434 + 1,597 - 132,000; 491,434 - 132,000
        positions: [
          { instrument: 'main', lot: 'calls', qty: 4, cost: 8_560, value: 8_480, unrealized: -80 },
          { instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -2, cost: -1_600, avgCost: 0.80, price: 0.82, value: -1_640, unrealized: -40 }, // -2 x 0.82 x 1,000
        ],
        holdings: { main: { long: 4, short: 0, net: 4 }, put: { long: 0, short: 2, net: -2 } },
        pending: [{ instrument: 'put', lot: 'puts', dueDate: '2026-05-06', amount: 1_597, into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-05-14', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-05-14', status: 'pending' }],
        pnl: { account: { commissions: -9, unrealized: -120, total: -129 } },
        nav: { account: 499_871, book: 999_871 },
        balance: { account: { cash: 491_434, receivable: 1_597, positions: 6_840, assets: 499_871, liabilities: 0, netAssets: 499_871 } }, // 8,480 - 1,640
      },
    }),
    {
      id: 'settle-put-premium', covers: 'settlement', action: 'clock', to: MAY(6),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,597.00 USD into settled cash', cash: { USD: 1_597 } }],
        cash: { account: { USD: { settled: 493_031, unsettled: 0, reserved: 132_000, availableToTrade: 361_031, availableToWithdraw: 361_031 } } },
        pending: [],
        balance: { account: { cash: 493_031, receivable: null } },
      },
    },
    { id: 'future-up', action: 'quote', instrument: 'fut', quote: { bid: 73.40, ask: 73.42, last: 73.41, bidSize: 200, askSize: 200 }, expect: {} }, // no future is held yet
    {
      id: 'call-premium-up', action: 'quote', instrument: 'main', quote: { bid: 3.70, ask: 3.76, last: 3.73, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'main', lot: 'calls', qty: 4, price: 3.73, value: 14_920, unrealized: 6_360 }, { instrument: 'put', qty: -2 }], // 4 x 3.73 x 1,000 - 8,560
        pnl: { account: { unrealized: 6_320, total: 6_311 } },
        nav: { account: 506_311, book: 1_006_311 },
        balance: { account: { positions: 13_280, assets: 506_311, netAssets: 506_311 } },
      },
    },
    {
      id: 'put-premium-down', action: 'quote', instrument: 'put', quote: { bid: 0.40, ask: 0.44, last: 0.42, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'main', qty: 4 }, { instrument: 'put', lot: 'puts', qty: -2, price: 0.42, value: -840, unrealized: 760 }], // -840 + 1,600
        pnl: { account: { unrealized: 7_120, total: 7_111 } },
        nav: { account: 507_111, book: 1_007_111 },
        balance: { account: { positions: 14_080, assets: 507_111, netAssets: 507_111 } },
      },
    },
    {
      // Early exercise of 1 call by hand. Its premium, 2.14 x 1,000 = 2,140, is realized as a loss. One futures
      // contract is delivered at the strike: long 1 at 70. No purchase price is paid for a future; its initial
      // margin, 6,500, is posted from settled cash at once. Against a last price of 73.41 it shows
      // (73.41 - 70) x 1,000 = 3,410 of open profit.
      id: 'exercise-early', covers: ['exercise', 'margin'], action: 'lifecycle', lot: 'calls', body: { action: 'exercise', contracts: 1 },
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 1 BLCM6C70 at strike 70', owner: 'account', date: '2026-05-06' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 1 BLCM6 at strike 70 on exercise of BLCM6C70/, owner: 'account', cash: { USD: -6_500 } },
        ],
        cash: { account: { USD: { settled: 486_531, unsettled: 0, margin: 6_500, reserved: 132_000, availableToTrade: 354_531, availableToWithdraw: 354_531 } } }, // 493,031 - 6,500; less the 132,000 reserve
        positions: [
          { instrument: 'fut', lot: 'calls', owner: 'account', direction: 'long', qty: 1, avgCost: 70, price: 73.41, value: 3_410, unrealized: 3_410 },
          { instrument: 'main', lot: 'calls', qty: 3, cost: 6_420, avgCost: 2.14, price: 3.73, value: 11_190, unrealized: 4_770 }, // 3 x 3.73 x 1,000 - 6,420
          { instrument: 'put', lot: 'puts', qty: -2, value: -840, unrealized: 760 },
        ],
        holdings: { fut: { long: 1, short: 0, net: 1 }, main: { long: 3, short: 0, net: 3 } },
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-05-14', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-05-14', status: 'pending' }, { type: 'future.expiry', instrument: 'fut', dueDate: '2026-05-19', status: 'pending' }],
        pnl: { account: { realized: -2_140, unrealized: 8_940, total: 6_791 } }, // 4,770 + 760 + 3,410
        nav: { account: 506_791, book: 1_006_791 }, // 320 lower: the time value of the exercised call (3,730 against 3,410 of intrinsic value)
        balance: { account: { cash: 486_531, margin: 6_500, positions: 13_760, assets: 506_791, liabilities: 0, netAssets: 506_791 } }, // 11,190 - 840 + 3,410
      },
    },
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'fut', date: '2026-05-06', value: 73.50, expect: {} },
    {
      // End of day: the future settles at 73.50 against the 70 it was delivered at. Variation margin received:
      // (73.50 - 70) x 1,000 = 3,500. From here it is measured from 73.50: against a last price of 73.41 it shows -90.
      id: 'variation-margin', covers: 'variation margin', action: 'clock', to: MAY(6, '17:30'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on 1 BLCM6: 3,500.00 USD (settlement 73.50 vs 70.00)', cash: { USD: 3_500 }, owner: 'account', date: '2026-05-06' }],
        cash: { account: { USD: { settled: 490_031, margin: 6_500, availableToTrade: 358_031, availableToWithdraw: 358_031 } } },
        positions: [{ instrument: 'fut', lot: 'calls', qty: 1, avgCost: 73.5, price: 73.41, value: -90, unrealized: -90 }, { instrument: 'main', qty: 3 }, { instrument: 'put', qty: -2 }],
        pnl: { account: { realized: 1_360, unrealized: 5_440, total: 6_791 } }, // -2,140 + 3,500; 4,770 + 760 - 90
        balance: { account: { cash: 490_031, positions: 10_260, assets: 506_791, netAssets: 506_791 } },
      },
    },
    { id: 'thursday-morning', action: 'clock', to: MAY(7), expect: {} },
    {
      id: 'future-up-2', action: 'quote', instrument: 'fut', quote: { bid: 74.00, ask: 74.02, last: 74.01, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'fut', lot: 'calls', qty: 1, price: 74.01, value: 510, unrealized: 510 }, { instrument: 'main', qty: 3 }, { instrument: 'put', qty: -2 }], // (74.01 - 73.50) x 1,000
        pnl: { account: { unrealized: 6_040, total: 7_391 } },
        nav: { account: 507_391, book: 1_007_391 },
        balance: { account: { positions: 10_860, assets: 507_391, netAssets: 507_391 } },
      },
    },
    {
      id: 'call-premium-up-2', action: 'quote', instrument: 'main', quote: { bid: 4.20, ask: 4.26, last: 4.23, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'fut', qty: 1 }, { instrument: 'main', lot: 'calls', qty: 3, price: 4.23, value: 12_690, unrealized: 6_270 }, { instrument: 'put', qty: -2 }], // 3 x 4.23 x 1,000 - 6,420
        pnl: { account: { unrealized: 7_540, total: 8_891 } }, // 6,270 + 760 + 510
        nav: { account: 508_891, book: 1_008_891 },
        balance: { account: { positions: 12_360, assets: 508_891, netAssets: 508_891 } },
      },
    },
    {
      // The futures position delivered by the exercise is closed with its own Close button: sell 1 at the bid, 74.00.
      // Realized against the last settlement price: (74.00 - 73.50) x 1,000 = 500. The 6,500 margin comes back.
      id: 'close-future', covers: ['close', 'margin release'], action: 'close', lot: 'calls', instrument: 'fut', scope: 'position', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'fut', qty: 1, estimate: 74.00, model: 'quoted-bid-ask', fees: 2.25, notional: 74_000, initialMargin: -6_500 }] }, // 1 x 74.00 x 1,000
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', instrument: 'fut', status: 'filled', filledQty: 1, avgPrice: 74.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 BLCM6 @ 74.00 (notional 74,000.00 USD; margin released 6,500.00 USD; realized 500.00 USD)', cash: { USD: 6_997.75 } }], // 500 - 2.25 + 6,500
        cash: { account: { USD: { settled: 497_028.75, margin: 0, availableToTrade: 365_028.75, availableToWithdraw: 365_028.75 } } },
        positions: [{ instrument: 'main', lot: 'calls', qty: 3, value: 12_690, unrealized: 6_270 }, { instrument: 'put', lot: 'puts', qty: -2, value: -840, unrealized: 760 }],
        holdings: { fut: null },
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-05-14', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-05-14', status: 'pending' }],
        pnl: { account: { realized: 1_860, commissions: -11.25, unrealized: 7_030, total: 8_878.75 } },
        nav: { account: 508_878.75, book: 1_008_878.75 },
        balance: { account: { cash: 497_028.75, margin: null, positions: 11_850, assets: 508_878.75, netAssets: 508_878.75 } },
      },
    },
    {
      id: 'sell-to-close-one', covers: 'reduce', action: 'close', lot: 'calls', scope: 'strategy', percent: 34, // 34% of 3 contracts, in whole contracts: sells 1
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 1, estimate: 4.20, model: 'quoted-bid-ask', settleDate: '2026-05-08', cash: 4_200, fees: 1.50 }] }, // 1 x 4.20 (the bid) x 1,000
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1, avgPrice: 4.20 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 BLCM6C70 @ 4.20 USD (realized 2,060.00 USD)' }], // 4,200 - 2,140
        cash: { account: { USD: { settled: 497_028.75, unsettled: 4_198.50, reserved: 132_000, availableToTrade: 369_227.25, availableToWithdraw: 365_028.75 } } },
        positions: [{ instrument: 'main', lot: 'calls', qty: 2, cost: 4_280, avgCost: 2.14, price: 4.23, value: 8_460, unrealized: 4_180 }, { instrument: 'put', qty: -2 }],
        holdings: { main: { long: 2, short: 0, net: 2 } },
        pending: [{ instrument: 'main', dueDate: '2026-05-08', amount: 4_198.50, into: 'cash' }],
        pnl: { account: { realized: 3_920, commissions: -12.75, unrealized: 4_940, total: 8_847.25 } },
        nav: { account: 508_847.25, book: 1_008_847.25 },
        balance: { account: { cash: 497_028.75, receivable: 4_198.50, positions: 7_620, assets: 508_847.25, netAssets: 508_847.25 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: MAY(8),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 4,198.50 USD into settled cash' }],
        cash: { account: { USD: { settled: 501_227.25, unsettled: 0, availableToTrade: 369_227.25, availableToWithdraw: 369_227.25 } } },
        pending: [],
        balance: { account: { cash: 501_227.25, receivable: null } },
      },
    },
    { id: 'expiry-close-known-later', action: 'close_price', instrument: 'fut', date: '2026-05-14', value: 74.10, expect: {} },
    {
      id: 'expiry-morning', covers: 'expiry', action: 'clock', to: MAY(14),
      expect: { lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-05-14', status: 'blocked' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-05-14', status: 'blocked' }] },
    },
    { id: 'future-on-expiry-morning', action: 'quote', instrument: 'fut', quote: { bid: 74.06, ask: 74.08, last: 74.07, bidSize: 200, askSize: 200 }, expect: {} },
    {
      id: 'call-on-expiry-morning', action: 'quote', instrument: 'main', quote: { bid: 4.04, ask: 4.10, last: 4.07, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'main', lot: 'calls', qty: 2, price: 4.07, value: 8_140, unrealized: 3_860 }, { instrument: 'put', qty: -2 }],
        pnl: { account: { unrealized: 4_620, total: 8_527.25 } },
        nav: { account: 508_527.25, book: 1_008_527.25 },
        balance: { account: { positions: 7_300, assets: 508_527.25, netAssets: 508_527.25 } },
      },
    },
    {
      id: 'put-on-expiry-morning', action: 'quote', instrument: 'put', quote: { bid: 0.01, ask: 0.03, last: 0.02, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'main', qty: 2 }, { instrument: 'put', lot: 'puts', qty: -2, price: 0.02, value: -40, unrealized: 1_560 }],
        pnl: { account: { unrealized: 5_420, total: 9_327.25 } },
        nav: { account: 509_327.25, book: 1_009_327.25 },
        balance: { account: { positions: 8_100, assets: 509_327.25, netAssets: 509_327.25 } },
      },
    },
    {
      // 17:30 on the expiration date. The future closed at 74.10.
      //   Calls (strike 70), in the money: exercised automatically. Premium of 2 x 2.14 x 1,000 = 4,280 realized as a
      //   loss; 2 futures delivered at 70, posting 2 x 6,500 = 13,000 of initial margin.
      //   Puts (strike 66), out of the money: lapse. Their premium, 1,600, is realized and the 132,000 reserve released.
      //   End of day: the 2 futures settle at 74.10 against 70: (74.10 - 70) x 1,000 x 2 = 8,200 received.
      //   Against a last price of 74.07 they then show (74.07 - 74.10) x 1,000 x 2 = -60.
      id: 'expiry', covers: ['expiry', 'exercise', 'lapse', 'margin', 'variation margin', 'reserve release'], action: 'clock', to: MAY(14, '17:30'),
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 2 BLCM6C70 at strike 70', owner: 'account', date: '2026-05-14' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 2 BLCM6 at strike 70 on exercise of BLCM6C70/, owner: 'account', cash: { USD: -13_000 }, date: '2026-05-14' },
          { type: 'option.expired', summary: 'Expired worthless: 2 BLCM6P66 (fixing 74.1)', owner: 'account', date: '2026-05-14' },
          { type: 'future.variation', summary: 'Variation margin received on 2 BLCM6: 8,200.00 USD (settlement 74.10 vs 70.00)', cash: { USD: 8_200 }, owner: 'account', date: '2026-05-14' },
        ],
        cash: { account: { USD: { settled: 496_427.25, unsettled: 0, margin: 13_000, reserved: 0, availableToTrade: 496_427.25, availableToWithdraw: 496_427.25 } } }, // 501,227.25 - 13,000 + 8,200
        positions: [{ instrument: 'fut', lot: 'calls', owner: 'account', direction: 'long', qty: 2, avgCost: 74.1, price: 74.07, value: -60, unrealized: -60 }],
        holdings: { fut: { long: 2, short: 0, net: 2 }, main: null, put: null },
        lifecycle: [{ type: 'future.expiry', instrument: 'fut', dueDate: '2026-05-19', status: 'pending' }],
        pnl: { account: { realized: 9_440, unrealized: -60, total: 9_367.25 } }, // 3,920 - 4,280 + 1,600 + 8,200
        nav: { account: 509_367.25, book: 1_009_367.25 },
        balance: { account: { cash: 496_427.25, margin: 13_000, positions: -60, assets: 509_367.25, liabilities: 0, netAssets: 509_367.25 } },
      },
    },
    { id: 'friday-morning', action: 'clock', to: MAY(15), expect: {} },
    {
      id: 'future-up-3', action: 'quote', instrument: 'fut', quote: { bid: 74.60, ask: 74.62, last: 74.61, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'fut', lot: 'calls', qty: 2, price: 74.61, value: 1_020, unrealized: 1_020 }], // (74.61 - 74.10) x 1,000 x 2
        pnl: { account: { unrealized: 1_020, total: 10_447.25 } },
        nav: { account: 510_447.25, book: 1_010_447.25 },
        balance: { account: { positions: 1_020, assets: 510_447.25, netAssets: 510_447.25 } },
      },
    },
    {
      id: 'close-futures', covers: ['close', 'margin release'], action: 'close', lot: 'calls', instrument: 'fut', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'fut', qty: 2, estimate: 74.60, model: 'quoted-bid-ask', fees: 4.50, notional: 149_200, initialMargin: -13_000 }] }, // 2 x 74.60 x 1,000; 2 x 2.25
        result: { status: 'closed', orders: [{ kind: 'trade', action: 'sell', instrument: 'fut', status: 'filled', filledQty: 2, avgPrice: 74.60 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2 BLCM6 @ 74.60 (notional 149,200.00 USD; margin released 13,000.00 USD; realized 1,000.00 USD)', cash: { USD: 13_995.50 } }], // (74.60 - 74.10) x 2,000 = 1,000; 1,000 - 4.50 + 13,000
        cash: { account: { USD: { settled: 510_422.75, unsettled: 0, margin: 0, reserved: 0, availableToTrade: 510_422.75, availableToWithdraw: 510_422.75 } }, treasury: { USD: { settled: 500_000 } } },
        positions: [],
        holdings: { fut: null },
        pending: [],
        lifecycle: [],
        // Whole scenario: calls bought for 8,560, one sold for 4,200; futures from the three exercised calls:
        // 3,500 + 500 and 8,200 + 1,000; puts +1,600; commissions 6 + 3 + 2.25 + 1.50 + 4.50 = 17.25.
        // -8,560 + 4,200 + 4,000 + 9,200 + 1,600 - 17.25 = 10,422.75.
        pnl: { account: { realized: 10_440, commissions: -17.25, unrealized: 0, total: 10_422.75 } },
        nav: { account: 510_422.75, book: 1_010_422.75 },
        balance: { account: { cash: 510_422.75, margin: null, positions: null, assets: 510_422.75, liabilities: 0, netAssets: 510_422.75 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// index_option
// ---------------------------------------------------------------------------------------------
// European, cash-settled options on a share index, 100 times the index, AM-settled: they stop
// trading the day before the third Friday and are settled in cash against a special opening
// quotation published that Friday morning. Nothing is delivered. The Account holds calls and writes
// an uncovered call at a higher strike (in a strategy instance of its own); Treasury holds puts as a
// Book-level hedge. Early exercise and early assignment are refused: the contracts are European.
//
// The index itself: the catalog has no product for an index (a published level that nothing trades
// on), and the option's registration form requires an underlying from the registry. The level is
// therefore carried by a reference instrument registered as an ETF and named as a reference level.
// It is given a last value only, never a bid or an ask, and nothing is traded on it here.
const IDX_CALL = 'NMX260417C4000', IDX_CALL2 = 'NMX260417C4050', IDX_PUT = 'NMX260417P3900';
const indexOptionDraft = (name, symbol, right, strike) => ({
  productId: 'index_option', name, symbol, marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlying: 'index', multiplier: 100,
  terms: { right, strike, expiration: '2026-04-17', exercise: 'european', settlement: 'cash', deliverable: { units: 100 } },
});
const AWAITING_NMX = /Awaiting the 2026-04-17 fixing for NMX/;
const indexOption = {
  productId: 'index_option',
  title: 'Northmark 400 Index options, 17 April 2026 (4000 call, 4050 call, 3900 put), Cboe-listed, European, cash-settled at 100 x the index, AM-settled',
  matrix: {
    ticket: `${OPTION_TICKET.ticket}. The settlement value is entered on the index reference instrument (Overview, Enter a price by hand, with its date)`,
    requiredFields: OPTION_TICKET.requiredFields,
    automaticInputs: ['premium bid, ask, last and size (quote fixture)', 'index level for the notional and for the reserve of an uncovered call (quote fixture, last value only)', 'fill price and fill model', 'premium settlement date', 'commission per contract', 'cash reserved against the written call'],
    manualInputs: ['the settlement value of an AM-settled series (special opening quotation), entered by hand as the index fixing for the expiration date', 'registration: the index level is carried by a reference instrument, because the catalog has no index product'],
    settlement: 'Premium T+1 on the US calendar; the cash settlement amount at expiry is due on the next business day (Monday 20 April for the Friday 17 April expiry)',
    lifecycle: 'Expiry items wait, blocked, until the settlement value for the expiration date exists; then settled in cash at 100 x (settlement value - strike) for a call in the money, nothing delivered; out of the money lapses; early exercise and early assignment refused (European)',
    accounting: 'Average premium; the cash settlement amount closes the position and the difference to the premium is realized; Treasury\'s puts are on Treasury\'s own balance sheet and P&L and in the Book\'s',
    collateral: 'The uncovered written call reserves 20% of 100 x the index level in its strategy instance, marked at each end of day and released at settlement',
  },
  start: APR(6),
  settlementCheck: { lag: 1, holidays: [] }, // US: no market holiday between 6 and 20 April 2026 (Good Friday was 3 April)
  book: book('Matrix index option'),
  instruments: {
    index: { productId: 'etf', name: 'Northmark 400 Index (reference level)', symbol: 'NMX', marketView: 'US_CASH', venue: 'Northmark Indices', venueType: 'exchange', venueCountry: 'US', issuer: 'Northmark Indices LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    main: indexOptionDraft('NMX 17 April 2026 4000 call', IDX_CALL, 'C', 4000),
    call2: indexOptionDraft('NMX 17 April 2026 4050 call', IDX_CALL2, 'C', 4050),
    put: indexOptionDraft('NMX 17 April 2026 3900 put', IDX_PUT, 'P', 3900),
  },
  quotes: {
    index: { last: 4012.50 }, // a published level: no bid, no ask
    main: { bid: 62.00, ask: 63.00, last: 62.50, bidSize: 100, askSize: 100 },
    call2: { bid: 38.00, ask: 39.00, last: 38.50, bidSize: 100, askSize: 100 },
    put: { bid: 40.00, ask: 41.00, last: 40.50, bidSize: 100, askSize: 100 },
  },
  expectAtStart: START_STATE,
  steps: [
    optionTicket({
      id: 'buy-to-open', covers: 'open', instrument: 'main', side: 'buy', qty: 3, symbol: IDX_CALL, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 3, estimate: 63.00, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-04-07', calendar: 'US',
            cash: -18_900, // 3 contracts x 63.00 (the ask) x 100
            fees: 1.95, // 3 x 0.65
            notional: 1_203_750 }], // 3 x 100 x 4,012.50 (the index level)
          cash: { USD: { purchases: 18_900, fees: 1.95, reserved: 0, required: 18_901.95, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 3, avgPrice: 63.00, fills: [{ qty: 3, price: 63.00, model: 'quoted-bid-ask', settleDate: '2026-04-07', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 3 NMX260417C4000 @ 63.00 USD', owner: 'account', date: '2026-04-06' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -18_901.95, availableToTrade: 481_098.05, availableToWithdraw: 481_098.05 } } },
        positions: [{ instrument: 'main', lot: 'calls', owner: 'account', direction: 'long', qty: 3, avgCost: 63, cost: 18_900, price: 62.50,
          value: 18_750, // 3 x 62.50 (last) x 100
          unrealized: -150, priceSource: 'Test fixture' }],
        holdings: { main: { long: 3, short: 0, net: 3 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-07', amount: -18_901.95, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-04-17', status: 'pending', owner: 'account' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -1.95, fees: 0, borrowFunding: 0, unrealized: -150, total: -151.95 } },
        nav: { account: 499_848.05, treasury: 500_000, book: 999_848.05 },
        balance: { account: { cash: 500_000, positions: 18_750, payable: 18_901.95, assets: 518_750, liabilities: 18_901.95, netAssets: 499_848.05 } },
      },
    }),
    optionTicket({
      // Treasury buys 2 puts for the Book: 2 x 41.00 x 100 = 8,200, paid from Treasury's own cash.
      id: 'treasury-buys-puts', covers: ['open', 'treasury'], instrument: 'put', side: 'buy', qty: 2, symbol: IDX_PUT, as: 'hedge', owner: 'treasury',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'put', qty: 2, estimate: 41.00, model: 'quoted-bid-ask', settleDate: '2026-04-07', cash: -8_200, fees: 1.30, notional: 802_500 }], // 2 x 100 x 4,012.50
          cash: { USD: { purchases: 8_200, fees: 1.30, required: 8_201.30, available: 500_000, shortfall: 0 } }, // Treasury's cash, not the Account's
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2, avgPrice: 41.00 }] },
        events: [{ type: 'strategy.submitted', owner: 'treasury' }, { type: 'trade.fill', summary: 'Bought 2 NMX260417P3900 @ 41.00 USD', owner: 'treasury', date: '2026-04-06' }],
        cash: { treasury: { USD: { settled: 500_000, unsettled: -8_201.30, availableToTrade: 491_798.70 } } },
        positions: [
          { instrument: 'main', lot: 'calls', owner: 'account', qty: 3 },
          { instrument: 'put', lot: 'hedge', owner: 'treasury', direction: 'long', qty: 2, avgCost: 41, cost: 8_200, price: 40.50, value: 8_100, unrealized: -100 }, // 2 x 40.50 x 100
        ],
        holdings: { put: { long: 2, short: 0, net: 2 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-07', amount: -18_901.95 }, { instrument: 'put', owner: 'treasury', dueDate: '2026-04-07', amount: -8_201.30, into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-04-17', status: 'pending', owner: 'account' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-04-17', status: 'pending', owner: 'treasury' }],
        pnl: { treasury: { realized: 0, commissions: -1.30, unrealized: -100, total: -101.30 }, book: { commissions: -3.25, unrealized: -250, total: -253.25 } },
        nav: { treasury: 499_898.70, book: 999_746.75 }, // 499,848.05 + 499,898.70
        balance: { treasury: { cash: 500_000, positions: 8_100, payable: 8_201.30, netAssets: 499_898.70 } },
      },
    }),
    optionTicket({
      // The Account writes 1 call at 4050 on its own ticket: a strategy instance of its own, so it is uncovered there
      // (the 4000 calls sit in another one). Reserve: 1 contract x 100 x 4,012.50 x 20% = 80,250.
      id: 'write-uncovered-call', covers: ['write', 'reserve'], instrument: 'call2', side: 'sell', qty: 1, symbol: IDX_CALL2, as: 'written',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: ['naked-call', 'unbounded'],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'call2', qty: 1, estimate: 38.00, model: 'quoted-bid-ask', settleDate: '2026-04-07', cash: 3_800, fees: 0.65, notional: 401_250 }], // 1 x 38.00 (the bid) x 100
          cash: { USD: { purchases: 0, proceeds: 3_800, fees: 0.65, reserved: 80_250, required: 80_250.65, available: 481_098.05, shortfall: 0, netCash: 3_799.35 } },
          optionRequirement: [{ ccy: 'USD', amount: 80_250, finite: 0, naked: 80_250, uncoveredCallUnits: 100 }],
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 1, avgPrice: 38.00 }] },
        events: [{ type: 'strategy.submitted', owner: 'account' }, { type: 'trade.fill', summary: /^Sold 1 NMX260417C4050 @ 38\.00 USD$/, owner: 'account' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -15_102.60, reserved: 80_250, availableToTrade: 404_647.40, availableToWithdraw: 400_848.05 } } }, // 500,000 + 3,799.35 - 18,901.95 - 80,250; 500,000 - 18,901.95 - 80,250
        positions: [
          { instrument: 'call2', lot: 'written', owner: 'account', direction: 'short', qty: -1, avgCost: 38, cost: -3_800, price: 38.50, value: -3_850, unrealized: -50 },
          { instrument: 'main', lot: 'calls', owner: 'account', qty: 3, value: 18_750, unrealized: -150 },
          { instrument: 'put', lot: 'hedge', owner: 'treasury', qty: 2 },
        ],
        holdings: { call2: { long: 0, short: 1, net: -1 } },
        pending: [
          { instrument: 'call2', owner: 'account', dueDate: '2026-04-07', amount: 3_799.35, into: 'cash' },
          { instrument: 'main', owner: 'account', dueDate: '2026-04-07', amount: -18_901.95 },
          { instrument: 'put', owner: 'treasury', dueDate: '2026-04-07', amount: -8_201.30 },
        ],
        lifecycle: [
          { type: 'option.expiry', instrument: 'call2', dueDate: '2026-04-17', status: 'pending', owner: 'account' },
          { type: 'option.expiry', instrument: 'main', dueDate: '2026-04-17', status: 'pending', owner: 'account' },
          { type: 'option.expiry', instrument: 'put', dueDate: '2026-04-17', status: 'pending', owner: 'treasury' },
        ],
        pnl: { account: { commissions: -2.60, unrealized: -200, total: -202.60 }, book: { commissions: -3.90, unrealized: -300, total: -303.90 } },
        nav: { account: 499_797.40, book: 999_696.10 },
        balance: { account: { cash: 500_000, receivable: 3_799.35, positions: 14_900, payable: 18_901.95, assets: 518_699.35, liabilities: 18_901.95, netAssets: 499_797.40 } }, // 18,750 - 3,850
      },
    }),
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: APR(7),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 3,799.35 USD into settled cash', owner: 'account' },
          { type: 'settlement.pay', summary: 'paid 18,901.95 USD from settled cash', owner: 'account' },
          { type: 'settlement.pay', summary: 'paid 8,201.30 USD from settled cash', owner: 'treasury' },
        ],
        cash: {
          account: { USD: { settled: 484_897.40, unsettled: 0, reserved: 80_250, availableToTrade: 404_647.40, availableToWithdraw: 404_647.40 } }, // 500,000 + 3,799.35 - 18,901.95
          treasury: { USD: { settled: 491_798.70, unsettled: 0, availableToTrade: 491_798.70 } },
        },
        pending: [],
        balance: { account: { cash: 484_897.40, receivable: null, payable: null, assets: 499_797.40, liabilities: 0 }, treasury: { cash: 491_798.70, payable: null } },
      },
    },
    {
      id: 'exercise-early', covers: 'exercise', action: 'lifecycle', lot: 'calls', body: { action: 'exercise', contracts: 1 },
      status: 'blocked', reason: 'A European option can be exercised only at expiration.',
      expect: { refused: 'This option is European: it can only be exercised at expiration.' },
    },
    {
      id: 'assign-early', covers: 'assignment', action: 'lifecycle', lot: 'written', body: { action: 'assign', contracts: 1 },
      status: 'blocked', reason: 'A written European option cannot be assigned before expiration.',
      expect: { refused: 'A European option cannot be assigned before expiration.' },
    },
    {
      id: 'treasury-exercise-early', covers: ['exercise', 'treasury'], action: 'lifecycle', lot: 'hedge', body: { action: 'exercise', contracts: 2 },
      status: 'blocked', reason: 'A European option can be exercised only at expiration, whoever holds it.',
      expect: { refused: 'This option is European: it can only be exercised at expiration.' },
    },
    { id: 'thursday-9-april', action: 'clock', to: APR(9), expect: {} },
    { id: 'index-up', action: 'quote', instrument: 'index', quote: { last: 4060.00 }, expect: {} }, // the reserve follows at the end of the day
    {
      id: 'calls-up', action: 'quote', instrument: 'main', quote: { bid: 88.00, ask: 89.50, last: 88.75, bidSize: 100, askSize: 100 },
      expect: {
        positions: [{ instrument: 'call2', qty: -1 }, { instrument: 'main', lot: 'calls', qty: 3, price: 88.75, value: 26_625, unrealized: 7_725 }, { instrument: 'put', qty: 2 }], // 3 x 88.75 x 100 - 18,900
        pnl: { account: { unrealized: 7_675, total: 7_672.40 }, book: { unrealized: 7_575, total: 7_571.10 } }, // Account 7,725 - 50; Book: less Treasury's 100, and 3.90 of commission
        nav: { account: 507_672.40, book: 1_007_571.10 },
        balance: { account: { positions: 22_775, assets: 507_672.40, netAssets: 507_672.40 } },
      },
    },
    {
      id: 'written-call-up', action: 'quote', instrument: 'call2', quote: { bid: 54.00, ask: 55.50, last: 54.75, bidSize: 100, askSize: 100 },
      expect: {
        positions: [{ instrument: 'call2', lot: 'written', qty: -1, price: 54.75, value: -5_475, unrealized: -1_675 }, { instrument: 'main', qty: 3 }, { instrument: 'put', qty: 2 }], // -5,475 + 3,800
        pnl: { account: { unrealized: 6_050, total: 6_047.40 }, book: { unrealized: 5_950, total: 5_946.10 } },
        nav: { account: 506_047.40, book: 1_005_946.10 },
        balance: { account: { positions: 21_150, assets: 506_047.40, netAssets: 506_047.40 } },
      },
    },
    {
      id: 'puts-down', action: 'quote', instrument: 'put', quote: { bid: 22.00, ask: 23.00, last: 22.50, bidSize: 100, askSize: 100 },
      expect: {
        positions: [{ instrument: 'call2', qty: -1 }, { instrument: 'main', qty: 3 }, { instrument: 'put', lot: 'hedge', owner: 'treasury', qty: 2, price: 22.50, value: 4_500, unrealized: -3_700 }], // 2 x 22.50 x 100 - 8,200
        pnl: { treasury: { unrealized: -3_700, total: -3_701.30 }, book: { unrealized: 2_350, total: 2_346.10 } }, // 6,050 - 3,700; less 3.90 commission
        nav: { treasury: 496_298.70, book: 1_002_346.10 },
        balance: { treasury: { positions: 4_500, netAssets: 496_298.70 } },
      },
    },
    {
      id: 'sell-to-close-one', covers: 'reduce', action: 'close', lot: 'calls', scope: 'strategy', percent: 34, // 34% of 3 contracts, in whole contracts: sells 1
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 1, estimate: 88.00, model: 'quoted-bid-ask', settleDate: '2026-04-10', cash: 8_800, fees: 0.65 }] }, // 1 x 88.00 (the bid) x 100
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1, avgPrice: 88.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 NMX260417C4000 @ 88.00 USD (realized 2,500.00 USD)' }], // 8,800 - 6,300
        cash: { account: { USD: { settled: 484_897.40, unsettled: 8_799.35, reserved: 80_250, availableToTrade: 413_446.75, availableToWithdraw: 404_647.40 } } },
        positions: [{ instrument: 'call2', qty: -1, value: -5_475, unrealized: -1_675 }, { instrument: 'main', lot: 'calls', qty: 2, cost: 12_600, avgCost: 63, price: 88.75, value: 17_750, unrealized: 5_150 }, { instrument: 'put', qty: 2 }],
        holdings: { main: { long: 2, short: 0, net: 2 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-10', amount: 8_799.35, into: 'cash' }],
        pnl: { account: { realized: 2_500, commissions: -3.25, unrealized: 3_475, total: 5_971.75 }, book: { realized: 2_500, commissions: -4.55, unrealized: -225, total: 2_270.45 } },
        nav: { account: 505_971.75, book: 1_002_270.45 },
        balance: { account: { cash: 484_897.40, receivable: 8_799.35, positions: 12_275, assets: 505_971.75, netAssets: 505_971.75 } }, // 17,750 - 5,475
      },
    },
    {
      // Friday: the sale settles, and Thursday's end of day marked the reserve to the index at 4,060: 100 x 4,060 x 20% = 81,200.
      id: 'settle-reduce', covers: ['settlement', 'reserve mark'], action: 'clock', to: APR(10),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 8,799.35 USD into settled cash', owner: 'account' }],
        cash: { account: { USD: { settled: 493_696.75, unsettled: 0, reserved: 81_200, availableToTrade: 412_496.75, availableToWithdraw: 412_496.75 } } },
        pending: [],
        balance: { account: { cash: 493_696.75, receivable: null } },
      },
    },
    {
      // Expiration morning. The series stopped trading yesterday; its settlement value is not known to the Terminal,
      // so all three expiry items wait, blocked, naming the missing fixing.
      id: 'expiry-morning', covers: 'expiry', action: 'clock', to: APR(17),
      expect: {
        lifecycle: [
          { type: 'option.expiry', instrument: 'call2', dueDate: '2026-04-17', status: 'blocked', owner: 'account', reason: AWAITING_NMX },
          { type: 'option.expiry', instrument: 'main', dueDate: '2026-04-17', status: 'blocked', owner: 'account', reason: AWAITING_NMX },
          { type: 'option.expiry', instrument: 'put', dueDate: '2026-04-17', status: 'blocked', owner: 'treasury', reason: AWAITING_NMX },
        ],
      },
    },
    { id: 'index-trading-on-friday', action: 'quote', instrument: 'index', quote: { last: 4080.00 }, expect: {} }, // the live level is not the settlement value
    {
      // The special opening quotation, 4,071.36, entered by hand as the index fixing for 17 April. On the next cycle:
      //   Account's 2 calls at 4000: cash 2 x 100 x (4,071.36 - 4,000) = 14,272, due Monday; less cost 12,600 = 1,672 realized.
      //   Treasury's 2 puts at 3900: out of the money, lapse; their cost, 8,200, is realized as a loss.
      //   Account's written call at 4050: assigned in cash, 1 x 100 x (4,071.36 - 4,050) = 2,136 to pay Monday;
      //   3,800 received less 2,136 = 1,664 realized; the 81,200 reserve is released.
      id: 'settlement-value-by-hand', covers: ['expiry', 'cash settlement', 'assignment', 'lapse', 'reserve release'], action: 'manual_price', instrument: 'index', value: 4071.36, forDate: '2026-04-17', note: 'Special opening quotation, 17 April 2026',
      expect: {
        events: [
          { type: 'option.cash_settled', summary: 'Exercised (cash settlement): 2 NMX260417C4000 at 71.36 per unit', owner: 'account', date: '2026-04-17' },
          { type: 'option.expired', summary: 'Expired worthless: 2 NMX260417P3900 (fixing 4071.36)', owner: 'treasury', date: '2026-04-17' },
          { type: 'option.cash_settled', summary: 'Assigned (cash settlement): 1 NMX260417C4050 at 21.36 per unit', owner: 'account', date: '2026-04-17' },
        ],
        cash: { account: { USD: { settled: 493_696.75, unsettled: 12_136, reserved: 0, availableToTrade: 505_832.75, availableToWithdraw: 491_560.75 } } }, // 14,272 - 2,136; 493,696.75 - 2,136
        positions: [],
        holdings: { main: null, call2: null, put: null },
        pending: [{ instrument: 'call2', lot: 'written', owner: 'account', dueDate: '2026-04-20', amount: -2_136, into: 'cash' }, { instrument: 'main', lot: 'calls', owner: 'account', dueDate: '2026-04-20', amount: 14_272, into: 'cash' }],
        lifecycle: [],
        pnl: {
          account: { realized: 5_836, commissions: -3.25, unrealized: 0, total: 5_832.75 }, // 2,500 + 1,672 + 1,664
          treasury: { realized: -8_200, commissions: -1.30, unrealized: 0, total: -8_201.30 },
          book: { realized: -2_364, commissions: -4.55, unrealized: 0, total: -2_368.55 },
        },
        nav: { account: 505_832.75, treasury: 491_798.70, book: 997_631.45 },
        balance: {
          account: { cash: 493_696.75, receivable: 14_272, payable: 2_136, positions: null, assets: 507_968.75, liabilities: 2_136, netAssets: 505_832.75 },
          treasury: { cash: 491_798.70, positions: null, netAssets: 491_798.70 },
        },
      },
    },
    {
      id: 'settle-cash-settlement', covers: 'settlement', action: 'clock', to: APR(20),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 14,272.00 USD into settled cash', owner: 'account' }, { type: 'settlement.pay', summary: 'paid 2,136.00 USD from settled cash', owner: 'account' }],
        // Account: 500,000 - 18,901.95 + 3,799.35 + 8,799.35 + 14,272 - 2,136 = 505,832.75. Treasury: 500,000 - 8,201.30.
        cash: { account: { USD: { settled: 505_832.75, unsettled: 0, reserved: 0, availableToTrade: 505_832.75, availableToWithdraw: 505_832.75 } }, treasury: { USD: { settled: 491_798.70 } } },
        pending: [],
        balance: { account: { cash: 505_832.75, receivable: null, payable: null, assets: 505_832.75, liabilities: 0, netAssets: 505_832.75 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// listed_option
// ---------------------------------------------------------------------------------------------
// A Eurex-listed put on a Xetra-listed German share, in euros, held by a Book that reports in US
// dollars: 100 shares a contract, American, physical delivery. It is bought together with the shares
// as a protective put (one package on the Strategies page), carried over the Easter closing days of
// its market, adjusted for a 2-for-1 split of the share, half sold, and the rest exercised
// automatically at expiry: the shares held with it are delivered at the adjusted strike.
//
// Calendars: the venue country is DE, so trading and settlement dates are worked out on TARGET.
// Good Friday 3 April and Easter Monday 6 April 2026 are closed (New York is open on the Monday).
// Premium settles T+1, shares T+2 (settlement.foreignCash).
//
// FX fixture: EUR/USD 1.10 at the start, 1.12 from 7 April. Every euro amount is a multiple of 0.50
// so that it converts to exact cents at both rates.
//   - Entries are converted when posted. Balances are converted at the current rate. The difference
//     is the FX effect: it is neither realized nor unrealized P&L.
//   - When the rate moves to 1.12 the Account holds 128,435 EUR of cash and positions that cost
//     21,555 EUR, all booked at 1.10: (128,435 + 21,555) x 0.02 = 2,999.80 USD of FX effect. Later
//     entries are booked at 1.12, so that figure does not change again.
const EUR_PUT = 'RMB260417P40';
const AWAITING_RMB = /Awaiting the 2026-04-17 fixing for RMB/;
const listedOption = {
  productId: 'listed_option',
  title: 'Rheintal Maschinenbau 17 April 2026 40 put, Eurex-listed, American, 100 shares, physical delivery, in euros in a US dollar Book',
  matrix: {
    ticket: 'Strategies page (execution template Protective Put) for the opening package; the contract\'s Trade tab for the part sale (Close half on the position); then the trade preview',
    requiredFields: ['Account', 'Execution template', 'Instrument', 'Shares', 'Expiration', 'Put strike'],
    automaticInputs: [...OPTION_TICKET.automaticInputs, 'EUR/USD rate (FX fixture) for reporting-currency figures', 'contracts from the share quantity and the contract\'s deliverable (500 shares / 100)'],
    manualInputs: ['stock split of the underlying (ratio, ex-date), recorded by hand on the share'],
    settlement: 'Premium T+1 and shares T+2 on TARGET: the shares bought on Wednesday 1 April settle on Tuesday 7 April, after Good Friday and Easter Monday; cash settles in euros',
    lifecycle: 'A whole-number forward split of the underlying adjusts the contract on its ex-date (contracts x2, strike / 2, contract size unchanged); expiry item on the expiration date; long put in the money: exercised automatically, shares held in the same strategy instance delivered at the strike (simulated delivery)',
    accounting: 'Average premium in euros; every entry also stored in US dollars at the rate when posted; balances translated at the current rate, the difference reported as FX effect; premium realized on sale and on exercise',
    collateral: 'None: a long option and the shares it protects reserve nothing',
  },
  start: APR(1),
  settlementCheck: { lag: 1, holidays: ['2026-04-03', '2026-04-06'] }, // TARGET closing days at Easter 2026; checked for the option legs (the share legs settle T+2 and state no date in their previews)
  book: {
    ...book('Matrix listed option', { fees: { option: { perUnit: 1, minimum: 0, bps: 0 }, equity: { perUnit: 0.01, minimum: 5, bps: 0 } } }), // 1.00 EUR a contract; 0.01 EUR a share, at least 5.00 an order
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'EUR', amount: 200_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }, { ccy: 'EUR', amount: 150_000 }] },
  },
  fx: { 'EUR/USD': 1.10 },
  instruments: {
    stock: { productId: 'common_stock', name: 'Rheintal Maschinenbau AG', symbol: 'RMB', marketView: 'FOREIGN_CASH', venue: 'Xetra', venueType: 'exchange', venueCountry: 'DE', issuer: 'Rheintal Maschinenbau AG', domicile: 'DE', underlyingGeo: 'DE', tradingCcy: 'EUR', terms: {} },
    main: { productId: 'listed_option', name: 'RMB 17 April 2026 40 put', symbol: EUR_PUT, marketView: 'FOREIGN_DERIV', venue: 'Eurex', venueType: 'exchange', venueCountry: 'DE', underlyingGeo: 'DE', tradingCcy: 'EUR', underlying: 'stock', multiplier: 100,
      terms: { right: 'P', strike: 40, expiration: '2026-04-17', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } },
  },
  quotes: {
    stock: { bid: 41.24, ask: 41.26, last: 41.25, bidSize: 20000, askSize: 20000 },
    main: { bid: 1.80, ask: 1.85, last: 1.82, bidSize: 500, askSize: 500 },
  },
  expectAtStart: {
    ...START_STATE,
    cash: {
      account: { USD: { settled: 500_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 500_000 }, EUR: { settled: 150_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 150_000, availableToWithdraw: 150_000 } },
      treasury: { USD: { settled: 500_000 }, EUR: { settled: 50_000 } },
    },
    nav: { account: 665_000, treasury: 555_000, book: 1_220_000 }, // 500,000 + 150,000 x 1.10; 500,000 + 50,000 x 1.10
  },
  steps: [
    {
      // Protective put, as the Strategies page sends it: buy 500 shares and 5 puts (500 / 100 a contract).
      id: 'protective-put', covers: ['open', 'protective put'], action: 'package', as: 'protected', instrument: 'stock',
      input: {
        template: 'protective_put', underlyingId: '$inst:stock', origin: 'strategy_page', investmentStrategy: null, holdingPeriod: null, hedgeObjective: null,
        mode: 'new', quantity: 500, hedgeRatio: 1, options: { expiration: '2026-04-17', strikes: { put: 40 }, contracts: null },
        borrow: null, orderType: 'market', limitPrice: null, stopPrice: null, tif: 'day', financing: null,
      },
      strategyPage: { template: 'Protective Put / Long + Put Cover', underlying: 'stock', quantity: 500, expiration: '2026-04-17', strikes: { 'Put strike': 40 } },
      expect: {
        preview: {
          blocking: 0, errors: [], template: 'protective_put',
          legs: [
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'stock', qty: 500, estimate: 41.26, model: 'quoted-bid-ask', priceSource: 'Test fixture', calendar: 'TARGET', cash: -20_630, fees: 5 }, // 500 x 41.26 (the ask); 500 x 0.01
            { kind: 'trade', action: 'buy', purpose: 'hedge', instrument: 'main', qty: 5, estimate: 1.85, model: 'quoted-bid-ask', settleDate: '2026-04-02', calendar: 'TARGET', cash: -925, fees: 5 }, // 5 x 1.85 (the ask) x 100; 5 x 1.00
          ],
          cash: { EUR: { purchases: 21_555, fees: 10, reserved: 0, required: 21_565, available: 150_000, shortfall: 0, netCash: -21_565 } },
          netPremium: { amount: 925, ccy: 'EUR', type: 'debit' },
        },
        result: { status: 'open', orders: [
          { kind: 'trade', action: 'buy', instrument: 'stock', status: 'filled', filledQty: 500, avgPrice: 41.26, fills: [{ qty: 500, price: 41.26, settleDate: '2026-04-07' }] }, // T+2 on TARGET: Thursday 2 (1); Friday 3 and Monday 6 are closed; Tuesday 7 (2)
          { kind: 'trade', action: 'buy', instrument: 'main', status: 'filled', filledQty: 5, avgPrice: 1.85, fills: [{ qty: 5, price: 1.85, settleDate: '2026-04-02' }] },
        ] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 500 RMB @ 41.26 EUR', owner: 'account', date: '2026-04-01' }, { type: 'trade.fill', summary: 'Bought 5 RMB260417P40 @ 1.85 EUR', owner: 'account' }],
        cash: { account: { EUR: { settled: 150_000, unsettled: -21_565, availableToTrade: 128_435, availableToWithdraw: 128_435 }, USD: { settled: 500_000, availableToTrade: 500_000 } } }, // 20,635 for the shares and 930 for the puts
        positions: [
          { instrument: 'main', lot: 'protected', owner: 'account', direction: 'long', qty: 5, avgCost: 1.85, cost: 925, price: 1.82, value: 910, unrealized: -15, priceSource: 'Test fixture' }, // euros: 5 x 1.82 x 100
          { instrument: 'stock', lot: 'protected', owner: 'account', direction: 'long', qty: 500, avgCost: 41.26, cost: 20_630, price: 41.25, value: 20_625, unrealized: -5 },
        ],
        holdings: { main: { long: 5, short: 0, net: 5 }, stock: { long: 500, short: 0, net: 500 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-02', amount: -930, ccy: 'EUR', into: 'cash' }, { instrument: 'stock', owner: 'account', dueDate: '2026-04-07', amount: -20_635, ccy: 'EUR', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-04-17', status: 'pending' }],
        // In US dollars at 1.10: commission 10 x 1.10 = 11.00; unrealized (-15 - 5) x 1.10 = -22.00.
        pnl: { account: { realized: 0, dividends: 0, commissions: -11, fees: 0, borrowFunding: 0, unrealized: -22, fx: 0, total: -33 } },
        nav: { account: 664_967, treasury: 555_000, book: 1_219_967 },
        balance: { account: {
          cash: 665_000, positions: 23_688.50, payable: 23_721.50, assets: 688_688.50, liabilities: 23_721.50, netAssets: 664_967, // (910 + 20,625) x 1.10; 21,565 x 1.10
          local: { EUR: { cash: 150_000, positions: 21_535, payable: 21_565 }, USD: { cash: 500_000 } },
        } },
      },
    },
    {
      id: 'settle-premium', covers: 'settlement', action: 'clock', to: APR(2),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 930.00 EUR from settled cash', cash: { EUR: -930 }, date: '2026-04-02' }],
        cash: { account: { EUR: { settled: 149_070, unsettled: -20_635, availableToTrade: 128_435, availableToWithdraw: 128_435 } } },
        pending: [{ instrument: 'stock', owner: 'account', dueDate: '2026-04-07', amount: -20_635, ccy: 'EUR', into: 'cash' }],
        balance: { account: { cash: 663_977, payable: 22_698.50, assets: 687_665.50, liabilities: 22_698.50, local: { EUR: { cash: 149_070, payable: 20_635 } } } }, // 500,000 + 149,070 x 1.10; 20,635 x 1.10
      },
    },
    { id: 'good-friday', covers: 'holiday', action: 'clock', to: APR(3), expect: {} }, // TARGET (and New York) closed: nothing settles
    { id: 'easter-monday', covers: 'holiday', action: 'clock', to: APR(6), expect: {} }, // New York is open, TARGET is not: the share purchase is still pending
    {
      id: 'settle-shares', covers: ['settlement', 'holiday'], action: 'clock', to: APR(7),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 20,635.00 EUR from settled cash', cash: { EUR: -20_635 }, date: '2026-04-07' }],
        cash: { account: { EUR: { settled: 128_435, unsettled: 0, availableToTrade: 128_435, availableToWithdraw: 128_435 } } },
        pending: [],
        balance: { account: { cash: 641_278.50, payable: null, assets: 664_967, liabilities: 0, local: { EUR: { cash: 128_435, payable: null } } } }, // 500,000 + 128,435 x 1.10
      },
    },
    {
      // The euro rises to 1.12. Account: (128,435 cash + 21,555 of position cost) x 0.02 = 2,999.80 of FX effect;
      // unrealized -20 EUR is now -22.40. Treasury: 50,000 x 0.02 = 1,000.
      id: 'euro-rises', covers: 'fx', action: 'fx_rate', pair: 'EUR/USD', rate: 1.12,
      expect: {
        pnl: { account: { unrealized: -22.40, fx: 2_999.80, total: 2_966.40 }, treasury: { fx: 1_000, total: 1_000 } }, // -11 - 22.40 + 2,999.80
        nav: { account: 667_966.40, treasury: 556_000, book: 1_223_966.40 }, // 500,000 + (128,435 + 21,535) x 1.12; 500,000 + 50,000 x 1.12
        balance: { account: { cash: 643_847.20, positions: 24_119.20, assets: 667_966.40, netAssets: 667_966.40 } }, // 500,000 + 128,435 x 1.12; 21,535 x 1.12
      },
    },
    {
      id: 'stock-falls', action: 'quote', instrument: 'stock', quote: { bid: 38.50, ask: 38.54, last: 38.52, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [{ instrument: 'main', qty: 5 }, { instrument: 'stock', lot: 'protected', qty: 500, price: 38.52, value: 19_260, unrealized: -1_370 }], // 500 x 38.52 - 20,630
        pnl: { account: { unrealized: -1_551.20, total: 1_437.60 } }, // (-15 - 1,370) x 1.12; -11 - 1,551.20 + 2,999.80
        nav: { account: 666_437.60, book: 1_222_437.60 },
        balance: { account: { positions: 22_590.40, assets: 666_437.60, netAssets: 666_437.60, local: { EUR: { positions: 20_170 } } } },
      },
    },
    {
      id: 'put-premium-up', action: 'quote', instrument: 'main', quote: { bid: 2.60, ask: 2.70, last: 2.65, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'protected', qty: 5, price: 2.65, value: 1_325, unrealized: 400 }, { instrument: 'stock', qty: 500 }], // 5 x 2.65 x 100 - 925
        pnl: { account: { unrealized: -1_086.40, total: 1_902.40 } }, // (400 - 1,370) x 1.12
        nav: { account: 666_902.40, book: 1_222_902.40 },
        balance: { account: { positions: 23_055.20, assets: 666_902.40, netAssets: 666_902.40, local: { EUR: { positions: 20_585 } } } },
      },
    },
    { id: 'split-recorded', covers: 'split', action: 'corporate_action', instrument: 'stock', type: 'split', exDate: '2026-04-13', ratioNum: 2, ratioDen: 1, expect: {} },
    {
      // Ex-date. The shares double and keep their cost. The put is ADJUSTED, not flagged: 5 contracts at 40 become
      // 10 contracts at 20, still 100 shares each, cost unchanged (average premium 925 / 1,000 = 0.925).
      // Quotes are still the pre-split ones until the data source sends adjusted prices in the next two steps.
      id: 'split-applied', covers: ['split', 'contract adjustment'], action: 'clock', to: APR(13),
      expect: {
        events: [
          { type: 'split', summary: '2-for-1 split of RMB: 500 became 1,000; cost basis unchanged', owner: 'account' },
          { type: 'split.option_adjustment', summary: 'Option adjusted for the 2-for-1 split of RMB: contracts x2, strike divided by 2', owner: 'account' },
        ],
        positions: [
          { instrument: 'main', lot: 'protected', qty: 10, cost: 925, avgCost: 0.925, price: 2.65, value: 2_650, unrealized: 1_725 },
          { instrument: 'stock', lot: 'protected', qty: 1000, cost: 20_630, avgCost: 20.63, price: 38.52, value: 38_520, unrealized: 17_890 },
        ],
        holdings: { main: { long: 10, short: 0, net: 10 }, stock: { long: 1000, short: 0, net: 1000 } },
        pnl: { account: { unrealized: 21_968.80, total: 24_957.60 } }, // 19,615 x 1.12
        nav: { account: 689_957.60, book: 1_245_957.60 },
        balance: { account: { positions: 46_110.40, assets: 689_957.60, netAssets: 689_957.60, local: { EUR: { positions: 41_170 } } } },
      },
    },
    {
      id: 'stock-quote-post-split', action: 'quote', instrument: 'stock', quote: { bid: 19.25, ask: 19.27, last: 19.26, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [{ instrument: 'main', qty: 10 }, { instrument: 'stock', lot: 'protected', qty: 1000, price: 19.26, value: 19_260, unrealized: -1_370 }],
        pnl: { account: { unrealized: 397.60, total: 3_386.40 } }, // (1,725 - 1,370) x 1.12
        nav: { account: 668_386.40, book: 1_224_386.40 },
        balance: { account: { positions: 24_539.20, assets: 668_386.40, netAssets: 668_386.40, local: { EUR: { positions: 21_910 } } } },
      },
    },
    {
      id: 'put-quote-post-split', action: 'quote', instrument: 'main', quote: { bid: 1.30, ask: 1.36, last: 1.33, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'protected', qty: 10, price: 1.33, value: 1_330, unrealized: 405 }, { instrument: 'stock', qty: 1000 }], // 10 x 1.33 x 100 - 925
        pnl: { account: { unrealized: -1_080.80, total: 1_908 } }, // (405 - 1,370) x 1.12
        nav: { account: 666_908, book: 1_222_908 },
        balance: { account: { positions: 23_060.80, assets: 666_908, netAssets: 666_908, local: { EUR: { positions: 20_590 } } } },
      },
    },
    {
      // Sell to close half of the puts: Close half on the position, on the contract's ticket. 5 x 1.30 x 100 = 650.
      // Cost removed at the average premium: 5 x 0.925 x 100 = 462.50. Realized 187.50 EUR = 210.00 USD at 1.12.
      id: 'sell-half-the-puts', covers: 'reduce', action: 'close', lot: 'protected', instrument: 'main', scope: 'position', percent: 50,
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 5, estimate: 1.30, model: 'quoted-bid-ask', settleDate: '2026-04-14', calendar: 'TARGET', cash: 650, fees: 5 }] },
        result: { status: 'open', orders: [{ action: 'sell', instrument: 'main', status: 'filled', filledQty: 5, avgPrice: 1.30 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 5 RMB260417P40 @ 1.30 EUR (realized 187.50 EUR)' }],
        cash: { account: { EUR: { settled: 128_435, unsettled: 645, availableToTrade: 129_080, availableToWithdraw: 128_435 } } },
        positions: [
          { instrument: 'main', lot: 'protected', qty: 5, cost: 462.50, avgCost: 0.925, price: 1.33, value: 665, unrealized: 202.50 },
          { instrument: 'stock', lot: 'protected', qty: 1000, value: 19_260, unrealized: -1_370 },
        ],
        holdings: { main: { long: 5, short: 0, net: 5 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-14', amount: 645, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: 210, commissions: -16.60, unrealized: -1_307.60, fx: 2_999.80, total: 1_885.60 } }, // 11 + 5 x 1.12; (202.50 - 1,370) x 1.12
        nav: { account: 666_885.60, book: 1_222_885.60 },
        balance: { account: { cash: 643_847.20, receivable: 722.40, positions: 22_316, assets: 666_885.60, netAssets: 666_885.60, local: { EUR: { receivable: 645, positions: 19_925 } } } }, // 645 x 1.12; (665 + 19,260) x 1.12
      },
    },
    {
      id: 'settle-part-sale', covers: 'settlement', action: 'clock', to: APR(14),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 645.00 EUR into settled cash', cash: { EUR: 645 } }],
        cash: { account: { EUR: { settled: 129_080, unsettled: 0, availableToTrade: 129_080, availableToWithdraw: 129_080 } } },
        pending: [],
        balance: { account: { cash: 644_569.60, receivable: null, local: { EUR: { cash: 129_080, receivable: null } } } }, // 500,000 + 129,080 x 1.12
      },
    },
    { id: 'expiry-close-known-later', action: 'close_price', instrument: 'stock', date: '2026-04-17', value: 18.60, expect: {} },
    {
      id: 'expiry-morning', covers: 'expiry', action: 'clock', to: APR(17),
      expect: { lifecycle: [{ type: 'option.expiry', instrument: 'main', dueDate: '2026-04-17', status: 'blocked', reason: AWAITING_RMB }] },
    },
    {
      id: 'stock-on-expiry-morning', action: 'quote', instrument: 'stock', quote: { bid: 18.60, ask: 18.64, last: 18.62, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [{ instrument: 'main', qty: 5 }, { instrument: 'stock', lot: 'protected', qty: 1000, price: 18.62, value: 18_620, unrealized: -2_010 }],
        pnl: { account: { unrealized: -2_024.40, total: 1_168.80 } }, // (202.50 - 2,010) x 1.12; 210 - 16.60 - 2,024.40 + 2,999.80
        nav: { account: 666_168.80, book: 1_222_168.80 },
        balance: { account: { positions: 21_599.20, assets: 666_168.80, netAssets: 666_168.80, local: { EUR: { positions: 19_285 } } } },
      },
    },
    {
      id: 'put-on-expiry-morning', action: 'quote', instrument: 'main', quote: { bid: 1.36, ask: 1.42, last: 1.39, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'protected', qty: 5, price: 1.39, value: 695, unrealized: 232.50 }, { instrument: 'stock', qty: 1000 }],
        pnl: { account: { unrealized: -1_990.80, total: 1_202.40 } }, // (232.50 - 2,010) x 1.12
        nav: { account: 666_202.40, book: 1_222_202.40 },
        balance: { account: { positions: 21_632.80, assets: 666_202.40, netAssets: 666_202.40, local: { EUR: { positions: 19_315 } } } },
      },
    },
    {
      // 17:30 New York on the expiration date. The share closed at 18.60, below the adjusted strike of 20: the 5 puts
      // are exercised automatically. Their remaining premium, 462.50 EUR, is realized as a loss (518.00 USD), and 500
      // of the 1,000 shares held with them are delivered at 20: 10,000 EUR due T+2, Tuesday 21 April. Those shares
      // cost 500 x 20.63 = 10,315: realized -315 EUR (-352.80 USD).
      id: 'expiry-put-exercised', covers: ['expiry', 'exercise'], action: 'clock', to: APR(17, '17:30'),
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 5 RMB260417P40 at strike 20', owner: 'account', date: '2026-04-17' },
          { type: 'option.delivery', summary: /^Simulated delivery: delivered 500 RMB at strike 20 on exercise of RMB260417P40/, owner: 'account', date: '2026-04-17' },
        ],
        cash: { account: { EUR: { settled: 129_080, unsettled: 10_000, availableToTrade: 139_080, availableToWithdraw: 129_080 } } },
        positions: [{ instrument: 'stock', lot: 'protected', owner: 'account', direction: 'long', qty: 500, cost: 10_315, avgCost: 20.63, price: 18.62, value: 9_310, unrealized: -1_005 }],
        holdings: { main: null, stock: { long: 500, short: 0, net: 500 } },
        pending: [{ instrument: 'stock', owner: 'account', dueDate: '2026-04-21', amount: 10_000, ccy: 'EUR', into: 'cash' }],
        lifecycle: [],
        alerts: ['hedge.review'], // the put was the hedge leg of the package: with it gone, the 500 shares left are flagged for a hedge review
        pnl: { account: { realized: -660.80, unrealized: -1_125.60, fx: 2_999.80, total: 1_196.80 } }, // 210 - 518 - 352.80; -1,005 x 1.12
        nav: { account: 666_196.80, book: 1_222_196.80 },
        balance: { account: { cash: 644_569.60, receivable: 11_200, positions: 10_427.20, assets: 666_196.80, netAssets: 666_196.80, local: { EUR: { receivable: 10_000, positions: 9_310 } } } },
      },
    },
    {
      id: 'settle-delivery', covers: 'settlement', action: 'clock', to: APR(21),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 10,000.00 EUR into settled cash', cash: { EUR: 10_000 } }],
        cash: { account: { EUR: { settled: 139_080, unsettled: 0, availableToTrade: 139_080, availableToWithdraw: 139_080 } } },
        pending: [],
        balance: { account: { cash: 655_769.60, receivable: null, local: { EUR: { cash: 139_080, receivable: null } } } }, // 500,000 + 139,080 x 1.12
      },
    },
    {
      id: 'sell-remaining-shares', covers: 'close', action: 'ticket', ticketOf: 'equity', instrument: 'stock', side: 'sell', qty: 500, from: 'protected',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', instrument: 'stock', qty: 500, estimate: 18.60, model: 'quoted-bid-ask', calendar: 'TARGET', cash: 9_300, fees: 5 }] }, // 500 x 18.60 (the bid)
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 500, avgPrice: 18.60, fills: [{ qty: 500, price: 18.60, settleDate: '2026-04-23' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 500 RMB @ 18.60 EUR (realized -1,015.00 EUR)' }], // 9,300 - 10,315
        cash: { account: { EUR: { settled: 139_080, unsettled: 9_295, availableToTrade: 148_375, availableToWithdraw: 139_080 } } },
        positions: [],
        holdings: { stock: null },
        alerts: [], // the strategy instance is closed: nothing is left to review
        pending: [{ instrument: 'stock', owner: 'account', dueDate: '2026-04-23', amount: 9_295, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: -1_797.60, commissions: -22.20, unrealized: 0, fx: 2_999.80, total: 1_180 } }, // -660.80 - 1,015 x 1.12; 16.60 + 5.60
        nav: { account: 666_180, book: 1_222_180 },
        balance: { account: { cash: 655_769.60, receivable: 10_410.40, positions: null, assets: 666_180, netAssets: 666_180, local: { EUR: { receivable: 9_295, positions: null } } } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: APR(23),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 9,295.00 EUR into settled cash', cash: { EUR: 9_295 } }],
        // Euros: 150,000 - 21,565 + 645 + 10,000 + 9,295 = 148,375. In dollars: 500,000 + 148,375 x 1.12 = 666,180.
        cash: { account: { EUR: { settled: 148_375, unsettled: 0, availableToTrade: 148_375, availableToWithdraw: 148_375 }, USD: { settled: 500_000 } }, treasury: { USD: { settled: 500_000 }, EUR: { settled: 50_000 } } },
        pending: [],
        balance: { account: { cash: 666_180, receivable: null, assets: 666_180, liabilities: 0, netAssets: 666_180, local: { EUR: { cash: 148_375, receivable: null } } } },
      },
    },
  ],
};

export default [listedOption, equityOption, etfOption, indexOption, optionOnFuture];
