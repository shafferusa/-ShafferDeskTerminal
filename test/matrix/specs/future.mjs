// Futures family (engine family "future"): the 11 catalog products accounted as margined futures.
// One scenario per product, each on its own fictional contract registered as exactly that product,
// with the multiplier, quotation, tick, margin, expiry and venue a real contract of that product has.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec (quotes,
// settlement prices, quantities, the contract's own terms, the Book's fee schedule). The arithmetic is
// in the comment beside it. Nothing here is copied from what the Terminal prints.
//
// The Terminal's documented rules for a future, restated so the arithmetic can be followed:
//   - A market buy fills at the ask, a market sell at the bid, of the quote in force.
//   - No purchase cash changes hands. A fill moves the contract's initial margin per contract from
//     settled cash into "Margin and collateral posted" (the Account's own asset, not spendable, not
//     transferable), and takes it back pro rata when the position is reduced or ends.
//   - Commission comes from the Book's fee schedule for futures and is expensed.
//   - A position carries a reference price: the fill price (the quantity-weighted average when contracts
//     are added) until the first end-of-day pass, the last settlement price after it. The Accounting
//     screens show it in the "Average cost" column.
//   - Variation margin: at each end-of-day pass (17:00 New York, on US business days) the position is
//     settled against the day's settlement price: (settlement - reference) x multiplier x contracts is
//     received or paid in settled cash and booked as realized P&L; the settlement becomes the reference.
//     No pass is made on a day the contract's own market is closed.
//   - The value shown for a position is its open trade equity: (last price - reference) x multiplier x
//     contracts, which is also its unrealized P&L. Its cost is nil.
//   - Reducing realizes (fill - reference) x multiplier on the contracts closed.
//   - On the last trading day the position is closed in cash at the final settlement price, without a
//     fee, and its margin is released. A physically delivered contract is closed out in cash the same
//     way and the Terminal says that delivery is not simulated. A contract past that day refuses trades.
//   - Each ticket opens its own strategy instance: a sale from the ticket opens a short beside a long,
//     and the holding is shown gross. A position is added to with Resize and reduced with Close.
//
// Clearing terms. Listed futures are cleared products. The Terminal keeps no clearing agreement for
// them (Treasury, Collateral says so): the terms that apply are the initial margin per contract stated
// on each contract and the Book's paper-desk assumptions. Every scenario therefore states its contract's
// initial margin and its Book's fee schedule, fill model and settlement in full.
//
// Settlement prices are fixtures (`closes`, or a `close_price` step). They exist from 16:00 New York
// of their date, as a data service would supply them; the end-of-day pass reads them at 17:00.

export const family = 'future';

/** 10:00 and 17:30 New York. Daylight time (UTC-4) runs from 8 March to 1 November 2026. */
const AM = (d, dst = true) => `${d}T${dst ? '14' : '15'}:00:00.000Z`;
const EOD = (d, dst = true) => `${d}T${dst ? '21' : '22'}:30:00.000Z`;

/** A Book, stated in full: capital into Treasury, funding to the Account, the futures fee schedule. */
const book = (name, { capital = [{ ccy: 'USD', amount: 1_000_000 }], funding, fee, extraFees = {}, settlement = {} }) => ({
  name,
  reportingCcy: 'USD',
  capital,
  account: { name: 'Alpha', funding },
  settings: {
    fees: { future: fee, ...extraFees },
    fill: { futureHalfSpreadTicks: 0.5, halfSpreadBps: { equity: 2 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false },
    settlement: { future: 0, ...settlement }, // a future has no settlement lag: margin moves on the trade date
  },
});

const FUTURES_TICKET = {
  ticket: 'Instrument drawer, Trade tab (futures ticket: Account, Buy or Sell, Contracts), then the trade preview; the strategy instance for Resize, Close and Roll',
  requiredFields: ['Account', 'Action (Buy / Sell)', 'Contracts'],
  automaticInputs: ['bid, ask and last (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model', 'initial margin from the contract terms', 'commission per contract from the Book fee schedule', 'daily settlement price (close fixture)'],
};
const NO_STATE = { pending: [], openOrders: [], borrowings: [], provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 }, alerts: [] };
const usd = (settled, margin = 0) => ({ settled, unsettled: 0, reserved: 0, restricted: 0, margin, availableToTrade: settled, availableToWithdraw: settled });

// ---------------------------------------------------------------------------------------------
// equity_index_future
// ---------------------------------------------------------------------------------------------
// Modelled on the CME E-mini S&P 500: 50 USD per index point, minimum move 0.25 points (12.50 USD),
// cash settled on the third Friday of the contract month at a special opening quotation, which is
// computed to two decimals and is not a tick price. Initial margin 22,000 USD a contract.
// Week used: Monday 16 to Monday 23 March 2026, no US holiday. The June contract's third Friday,
// 19 June 2026, is the Juneteenth holiday, so its last day is Thursday 18 June.
const IDX = (symbol, month, expiration) => ({
  productId: 'equity_index_future', name: `Meridian 500 Index future, ${month}`, symbol, marketView: 'US_DERIV', venue: 'CME', venueType: 'exchange', venueCountry: 'US',
  underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 50,
  terms: { root: 'M5', expiration, tickSize: 0.25, initialMargin: 22_000, settlement: 'cash', priceUnits: 'index points' },
});
const equityIndexFuture = {
  productId: 'equity_index_future',
  title: 'Meridian 500 Index future (50 USD a point), March and June 2026, CME',
  matrix: {
    ...FUTURES_TICKET,
    manualInputs: ['none: the final settlement price is supplied as the close of the last trading day (it can be entered by hand, see equity_future)'],
    settlement: 'No purchase cash. Initial margin 22,000 USD a contract is posted on the trade date; variation margin is paid or received in cash at each end-of-day pass; cash final settlement on the last trading day',
    lifecycle: 'Daily variation margin (automatic); final settlement in cash at the final settlement price on the last trading day (automatic); roll to the next contract month from the strategy instance; a contract past its last trading day refuses trades',
    accounting: 'Nil cost; value is open trade equity since the last settlement; variation margin and closes are realized P&L; commission 2.25 USD a contract expensed; margin posted is the Account\'s own asset',
    collateral: 'Initial margin per contract from the contract terms, held in "Margin and collateral posted": not available to trade or to withdraw; released pro rata on reduction, close and final settlement. An order whose margin is not covered is refused',
  },
  start: AM('2026-03-16'),
  settlementCheck: { lag: 0, holidays: [] }, // US: no holiday between 16 and 23 March 2026
  book: book('Matrix equity-index future', { funding: [{ ccy: 'USD', amount: 300_000 }], fee: { perUnit: 2.25, minimum: 0, bps: 0 } }),
  instruments: { main: IDX('M5H6', 'March 2026', '2026-03-20'), next: IDX('M5M6', 'June 2026', '2026-06-18') },
  quotes: {
    main: { bid: 5800.00, ask: 5800.25, last: 5800.00, bidSize: 200, askSize: 200 },
    next: { bid: 5821.00, ask: 5821.25, last: 5821.00, bidSize: 200, askSize: 200 },
  },
  // Daily settlement prices. The final settlement price of the March contract arrives in a step of its own.
  closes: {
    main: { '2026-03-16': 5812.50, '2026-03-17': 5779.75, '2026-03-18': 5790.00, '2026-03-19': 5766.50 },
    next: { '2026-03-19': 5818.50, '2026-03-20': 5790.25 },
  },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: usd(300_000) }, treasury: { USD: usd(700_000) } },
    positions: [], lifecycle: [],
    nav: { account: 300_000, treasury: 700_000, book: 1_000_000 },
  },
  steps: [
    {
      id: 'open', covers: ['open', 'initial margin'], action: 'ticket', instrument: 'main', side: 'buy', qty: 4, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4, estimate: 5800.25, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-16', calendar: 'US',
            notional: 1_160_050, // 4 x 5,800.25 (the ask) x 50
            initialMargin: 88_000, // 4 x 22,000
            fees: 9 }], // 4 x 2.25
          cash: { USD: { purchases: 0, fees: 9, margin: 88_000, required: 88_009, available: 300_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 4, avgPrice: 5800.25, fills: [{ qty: 4, price: 5800.25, model: 'quoted-bid-ask', settleDate: '2026-03-16', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 4 M5H6 @ 5,800.25 (notional 1,160,050.00 USD; margin posted 88,000.00 USD)', cash: { USD: -88_009 }, owner: 'account', date: '2026-03-16' }],
        cash: { account: { USD: usd(211_991, 88_000) } }, // 300,000 - 88,000 margin - 9 commission
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 4, avgCost: 5800.25, cost: 0, price: 5800.00,
          value: -50, unrealized: -50, // (5,800.00 last - 5,800.25) x 50 x 4
          notional: 1_160_000, margin: 88_000, priceSource: 'Test fixture' }], // 4 x 5,800.00 x 50; the margin posted for the position
        holdings: { main: { long: 4, short: 0, net: 4 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -9, fees: 0, borrowFunding: 0, unrealized: -50, fx: 0, total: -59 } },
        nav: { account: 299_941, book: 999_941 },
        balance: { account: { cash: 211_991, margin: 88_000, positions: -50, assets: 299_941, liabilities: 0, netAssets: 299_941 } },
      },
    },
    {
      // 10 more would need 220,000 of margin and 22.50 of commission; 211,991 is free. Shortfall 8,031.50.
      id: 'order-beyond-margin', covers: 'margin shortfall', action: 'ticket', instrument: 'main', side: 'buy', qty: 10,
      status: 'blocked', reason: 'Initial margin for 10 more contracts is not covered by the Account\'s free cash. It is refused, not funded.',
      expect: { refused: /Alpha is short 8,031\.50 USD.*margin and collateral 220,000\.00 USD.*211,991\.00 USD is available/s },
    },
    {
      // Settled 211,991 plus margin 88,000 is the 300,000 that was funded, less 9. Only the settled part can leave.
      id: 'withdraw-posted-margin', covers: 'margin not spendable', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 250_000,
      status: 'blocked', reason: 'Margin posted is not available to withdraw.',
      expect: { refused: 'Alpha has 211,991.00 USD of settled USD available; 250,000.00 USD requested' },
    },
    {
      id: 'day-1-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-16'),
      expect: {
        // Settlement 5,812.50 against the fill 5,800.25: 12.25 x 50 x 4 = 2,450.00 received.
        events: [{ type: 'future.variation', summary: 'Variation margin received on 4 M5H6: 2,450.00 USD (settlement 5,812.50 vs 5,800.25)', cash: { USD: 2_450 }, owner: 'account', date: '2026-03-16' }],
        cash: { account: { USD: usd(214_441, 88_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 4, avgCost: 5812.50, price: 5800.00, value: -2_500, unrealized: -2_500 }], // (5,800.00 - 5,812.50) x 200
        pnl: { account: { realized: 2_450, unrealized: -2_500, total: -59 } },
        balance: { account: { cash: 214_441, positions: -2_500, assets: 299_941, netAssets: 299_941 } },
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-03-17'), expect: {} },
    {
      id: 'quote-down', action: 'quote', instrument: 'main', quote: { bid: 5781.00, ask: 5781.25, last: 5781.25, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 4, avgCost: 5812.50, price: 5781.25, value: -6_250, unrealized: -6_250, notional: 1_156_250 }], // (5,781.25 - 5,812.50) x 200; 4 x 5,781.25 x 50
        pnl: { account: { unrealized: -6_250, total: -3_809 } }, // 2,450 - 9 - 6,250
        nav: { account: 296_191, book: 996_191 },
        balance: { account: { positions: -6_250, assets: 296_191, netAssets: 296_191 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 4 -> 6: buys 2 more in the same strategy instance
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2, estimate: 5781.25, model: 'quoted-bid-ask', settleDate: '2026-03-17',
          notional: 578_125, initialMargin: 44_000, fees: 4.50 }], // 2 x 5,781.25 x 50; 2 x 22,000; 2 x 2.25
          cash: { USD: { purchases: 0, fees: 4.50, margin: 44_000, required: 44_004.50, available: 214_441, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 2, avgPrice: 5781.25 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 2 M5H6 @ 5,781.25 (notional 578,125.00 USD; margin posted 44,000.00 USD)', cash: { USD: -44_004.50 } }],
        cash: { account: { USD: usd(170_436.50, 132_000) } }, // 214,441 - 44,004.50
        // Reference price: (4 x 5,812.50 + 2 x 5,781.25) / 6 = 34,812.50 / 6 = 5,802.083333.
        // Value: the first 4 are 31.25 under their reference, the 2 new ones are at theirs: 4 x -31.25 x 50 = -6,250.
        positions: [{ instrument: 'main', lot: 'lot', qty: 6, avgCost: 5802.083333, cost: 0, price: 5781.25, value: -6_250, unrealized: -6_250, notional: 1_734_375, margin: 132_000 }], // 6 x 5,781.25 x 50
        holdings: { main: { long: 6, short: 0, net: 6 } },
        pnl: { account: { commissions: -13.50, unrealized: -6_250, total: -3_813.50 } },
        nav: { account: 296_186.50, book: 996_186.50 },
        balance: { account: { cash: 170_436.50, margin: 132_000, positions: -6_250, assets: 296_186.50, netAssets: 296_186.50 } },
      },
    },
    {
      id: 'day-2-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-17'),
      expect: {
        // 6 x 5,779.75 x 50 = 1,733,925 against 4 x 5,812.50 x 50 + 2 x 5,781.25 x 50 = 1,740,625: 6,700.00 paid.
        events: [{ type: 'future.variation', summary: /^Variation margin paid on 6 M5H6: 6,700\.00 USD \(settlement 5,779\.75 vs 5,802\.083333\)$/, cash: { USD: -6_700 }, date: '2026-03-17' }],
        cash: { account: { USD: usd(163_736.50, 132_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 6, avgCost: 5779.75, price: 5781.25, value: 450, unrealized: 450 }], // (5,781.25 - 5,779.75) x 300
        pnl: { account: { realized: -4_250, unrealized: 450, total: -3_813.50 } }, // 2,450 - 6,700
        balance: { account: { cash: 163_736.50, positions: 450 } },
      },
    },
    { id: 'wednesday', action: 'clock', to: AM('2026-03-18'), expect: {} },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 5795.50, ask: 5795.75, last: 5795.50, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 6, avgCost: 5779.75, price: 5795.50, value: 4_725, unrealized: 4_725 }], // 15.75 x 300
        pnl: { account: { unrealized: 4_725, total: 461.50 } }, // -4,250 - 13.50 + 4,725
        nav: { account: 300_461.50, book: 1_000_461.50 },
        balance: { account: { positions: 4_725, assets: 300_461.50, netAssets: 300_461.50 } },
      },
    },
    {
      id: 'reduce', covers: ['reduce', 'margin release'], action: 'close', lot: 'lot', scope: 'strategy', percent: 50, // sells 3 of the 6
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 3, estimate: 5795.50, model: 'quoted-bid-ask', settleDate: '2026-03-18',
          notional: 869_325, initialMargin: -66_000, fees: 6.75 }], // 3 x 5,795.50 (the bid) x 50; 3 x 22,000 released; 3 x 2.25
          cash: { USD: { purchases: 0, fees: 6.75, margin: 0, required: 6.75, available: 163_736.50, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 3, avgPrice: 5795.50 }] },
        // Realized on the 3 closed: (5,795.50 - 5,779.75) x 50 x 3 = 2,362.50. Cash: 2,362.50 - 6.75 + 66,000 = 68,355.75.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 3 M5H6 @ 5,795.50 (notional 869,325.00 USD; margin released 66,000.00 USD; realized 2,362.50 USD)', cash: { USD: 68_355.75 } }],
        cash: { account: { USD: usd(232_092.25, 66_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 3, avgCost: 5779.75, price: 5795.50, value: 2_362.50, unrealized: 2_362.50, notional: 869_325, margin: 66_000 }], // 15.75 x 150; 3 x 5,795.50 x 50
        holdings: { main: { long: 3, short: 0, net: 3 } },
        pnl: { account: { realized: -1_887.50, commissions: -20.25, unrealized: 2_362.50, total: 454.75 } },
        nav: { account: 300_454.75, book: 1_000_454.75 },
        balance: { account: { cash: 232_092.25, margin: 66_000, positions: 2_362.50, assets: 300_454.75, netAssets: 300_454.75 } },
      },
    },
    {
      // A sale from the ticket does not reduce the long: it opens a short in a strategy instance of its own,
      // with its own margin, and the holding is shown gross.
      id: 'open-short', covers: ['open short', 'gross holdings'], action: 'ticket', instrument: 'main', side: 'sell', qty: 2, as: 'short',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2, estimate: 5795.50, model: 'quoted-bid-ask', settleDate: '2026-03-18',
          notional: 579_550, initialMargin: 44_000, fees: 4.50 }], // 2 x 5,795.50 x 50
          cash: { USD: { purchases: 0, fees: 4.50, margin: 44_000, required: 44_004.50, available: 232_092.25, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2, avgPrice: 5795.50 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Sold 2 M5H6 @ 5,795.50 (notional 579,550.00 USD; margin posted 44,000.00 USD)', cash: { USD: -44_004.50 } }],
        cash: { account: { USD: usd(188_087.75, 110_000) } },
        positions: [
          { instrument: 'main', lot: 'lot', direction: 'long', qty: 3, avgCost: 5779.75, value: 2_362.50, unrealized: 2_362.50, notional: 869_325, margin: 66_000 },
          { instrument: 'main', lot: 'short', owner: 'account', direction: 'short', qty: -2, avgCost: 5795.50, cost: 0, price: 5795.50, value: 0, unrealized: 0, notional: 579_550, margin: 44_000 }, // 2 x 5,795.50 x 50
        ],
        holdings: { main: { long: 3, short: 2, net: 1 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }, { type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }],
        pnl: { account: { commissions: -24.75, total: 450.25 } },
        nav: { account: 300_450.25, book: 1_000_450.25 },
        balance: { account: { cash: 188_087.75, margin: 110_000, assets: 300_450.25, netAssets: 300_450.25 } },
      },
    },
    {
      id: 'day-3-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-18'),
      expect: {
        // Settlement 5,790.00. Long 3: (5,790.00 - 5,779.75) x 150 = 1,537.50 received.
        // Short 2: it sold at 5,795.50 and the settlement is 5.50 lower: 5.50 x 50 x 2 = 550.00 received.
        events: [
          { type: 'future.variation', summary: 'Variation margin received on 3 M5H6: 1,537.50 USD (settlement 5,790.00 vs 5,779.75)', cash: { USD: 1_537.50 } },
          { type: 'future.variation', summary: 'Variation margin received on -2 M5H6: 550.00 USD (settlement 5,790.00 vs 5,795.50)', cash: { USD: 550 } },
        ],
        cash: { account: { USD: usd(190_175.25, 110_000) } },
        positions: [
          { instrument: 'main', lot: 'lot', qty: 3, avgCost: 5790, price: 5795.50, value: 825, unrealized: 825 }, // 5.50 x 150
          { instrument: 'main', lot: 'short', qty: -2, avgCost: 5790, price: 5795.50, value: -550, unrealized: -550 }, // 5.50 x 50 x -2
        ],
        pnl: { account: { realized: 200, unrealized: 275, total: 450.25 } }, // -1,887.50 + 1,537.50 + 550
        balance: { account: { cash: 190_175.25, positions: 275 } },
      },
    },
    { id: 'thursday', action: 'clock', to: AM('2026-03-19'), expect: {} },
    {
      id: 'quote-down-2', action: 'quote', instrument: 'main', quote: { bid: 5770.00, ask: 5770.25, last: 5770.00, bidSize: 200, askSize: 200 },
      expect: {
        positions: [
          { instrument: 'main', lot: 'lot', qty: 3, price: 5770, value: -3_000, unrealized: -3_000 }, // (5,770 - 5,790) x 150
          { instrument: 'main', lot: 'short', qty: -2, price: 5770, value: 2_000, unrealized: 2_000 }, // (5,770 - 5,790) x 50 x -2
        ],
        pnl: { account: { unrealized: -1_000, total: -824.75 } }, // 200 - 24.75 - 1,000
        nav: { account: 299_175.25, book: 999_175.25 },
        balance: { account: { positions: -1_000, assets: 299_175.25, netAssets: 299_175.25 } },
      },
    },
    {
      id: 'close-short', covers: ['close short', 'margin release'], action: 'close', lot: 'short', scope: 'position', percent: 100, // the Close button on the short position
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2, estimate: 5770.25, model: 'quoted-bid-ask', settleDate: '2026-03-19',
          notional: 577_025, initialMargin: -44_000, fees: 4.50 }], // 2 x 5,770.25 (the ask) x 50
          cash: { USD: { purchases: 0, fees: 4.50, margin: 0, required: 4.50, available: 190_175.25, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ action: 'buy', status: 'filled', filledQty: 2, avgPrice: 5770.25 }] },
        // Realized: (5,790.00 - 5,770.25) x 50 x 2 = 1,975.00. Cash: 1,975 - 4.50 + 44,000 = 45,970.50.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 2 M5H6 @ 5,770.25 (notional 577,025.00 USD; margin released 44,000.00 USD; realized 1,975.00 USD)', cash: { USD: 45_970.50 } }],
        cash: { account: { USD: usd(236_145.75, 66_000) } },
        positions: [{ instrument: 'main', lot: 'lot', direction: 'long', qty: 3, avgCost: 5790, price: 5770, value: -3_000, unrealized: -3_000, notional: 865_500, margin: 66_000 }], // 3 x 5,770 x 50
        holdings: { main: { long: 3, short: 0, net: 3 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }],
        pnl: { account: { realized: 2_175, commissions: -29.25, unrealized: -3_000, total: -854.25 } },
        nav: { account: 299_145.75, book: 999_145.75 },
        balance: { account: { cash: 236_145.75, margin: 66_000, positions: -3_000, assets: 299_145.75, netAssets: 299_145.75 } },
      },
    },
    {
      // The day before the March contract's last day the long is rolled into June: one package, two legs.
      // The preview asks for the June margin in free cash although the March margin is released by the same package.
      id: 'roll', covers: 'roll', action: 'roll', lot: 'lot', into: 'next',
      expect: {
        preview: { blocking: 0, errors: [],
          legs: [
            { kind: 'trade', action: 'sell', instrument: 'main', qty: 3, estimate: 5770.00, model: 'quoted-bid-ask', settleDate: '2026-03-19', notional: 865_500, initialMargin: -66_000, fees: 6.75 }, // 3 x 5,770.00 x 50
            { kind: 'trade', action: 'buy', instrument: 'next', qty: 3, estimate: 5821.25, model: 'quoted-bid-ask', settleDate: '2026-03-19', notional: 873_187.50, initialMargin: 66_000, fees: 6.75 }, // 3 x 5,821.25 x 50
          ],
          cash: { USD: { purchases: 0, fees: 13.50, margin: 66_000, required: 66_013.50, available: 236_145.75, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', instrument: 'main', status: 'filled', filledQty: 3, avgPrice: 5770 }, { action: 'buy', instrument: 'next', status: 'filled', filledQty: 3, avgPrice: 5821.25 }] },
        // March leg realizes (5,770.00 - 5,790.00) x 150 = -3,000.00 and releases 66,000; June posts 66,000.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 3 M5H6 @ 5,770.00 (notional 865,500.00 USD; margin released 66,000.00 USD; realized -3,000.00 USD)', cash: { USD: 62_993.25 } }, // -3,000 - 6.75 + 66,000
          { type: 'trade.fill', summary: 'Bought 3 M5M6 @ 5,821.25 (notional 873,187.50 USD; margin posted 66,000.00 USD)', cash: { USD: -66_006.75 } },
        ],
        cash: { account: { USD: usd(233_132.25, 66_000) } }, // 236,145.75 + 62,993.25 - 66,006.75
        positions: [{ instrument: 'next', lot: 'lot', owner: 'account', direction: 'long', qty: 3, avgCost: 5821.25, cost: 0, price: 5821, value: -37.50, unrealized: -37.50, // (5,821.00 - 5,821.25) x 150
          notional: 873_150, margin: 66_000 }], // 3 x 5,821.00 x 50
        holdings: { main: null, next: { long: 3, short: 0, net: 3 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'next', dueDate: '2026-06-18', status: 'pending' }],
        pnl: { account: { realized: -825, commissions: -42.75, unrealized: -37.50, total: -905.25 } },
        nav: { account: 299_094.75, book: 999_094.75 },
        balance: { account: { cash: 233_132.25, margin: 66_000, positions: -37.50, assets: 299_094.75, netAssets: 299_094.75 } },
      },
    },
    {
      // One March contract is bought again to be held to final settlement.
      id: 'open-to-expiry', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1, as: 'expiring',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1, estimate: 5770.25, settleDate: '2026-03-19', notional: 288_512.50, initialMargin: 22_000, fees: 2.25 }] }, // 5,770.25 x 50
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1, avgPrice: 5770.25 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 M5H6 @ 5,770.25 (notional 288,512.50 USD; margin posted 22,000.00 USD)', cash: { USD: -22_002.25 } }],
        cash: { account: { USD: usd(211_130, 88_000) } },
        positions: [
          { instrument: 'main', lot: 'expiring', owner: 'account', direction: 'long', qty: 1, avgCost: 5770.25, cost: 0, price: 5770, value: -12.50, unrealized: -12.50, notional: 288_500, margin: 22_000 }, // -0.25 x 50; 5,770 x 50
          { instrument: 'next', lot: 'lot', qty: 3, avgCost: 5821.25, value: -37.50, unrealized: -37.50, notional: 873_150, margin: 66_000 },
        ],
        holdings: { main: { long: 1, short: 0, net: 1 }, next: { long: 3, short: 0, net: 3 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }, { type: 'future.expiry', instrument: 'next', dueDate: '2026-06-18', status: 'pending' }],
        pnl: { account: { commissions: -45, unrealized: -50, total: -920 } },
        nav: { account: 299_080, book: 999_080 },
        balance: { account: { cash: 211_130, margin: 88_000, positions: -50, assets: 299_080, netAssets: 299_080 } },
      },
    },
    {
      id: 'day-4-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-19'),
      expect: {
        // June: (5,818.50 - 5,821.25) x 150 = -412.50. March: (5,766.50 - 5,770.25) x 50 = -187.50. Positions are settled in the order they were opened.
        events: [
          { type: 'future.variation', summary: 'Variation margin paid on 3 M5M6: 412.50 USD (settlement 5,818.50 vs 5,821.25)', cash: { USD: -412.50 } },
          { type: 'future.variation', summary: 'Variation margin paid on 1 M5H6: 187.50 USD (settlement 5,766.50 vs 5,770.25)', cash: { USD: -187.50 } },
        ],
        cash: { account: { USD: usd(210_530, 88_000) } },
        positions: [
          { instrument: 'main', lot: 'expiring', qty: 1, avgCost: 5766.50, price: 5770, value: 175, unrealized: 175 }, // 3.50 x 50
          { instrument: 'next', lot: 'lot', qty: 3, avgCost: 5818.50, price: 5821, value: 375, unrealized: 375 }, // 2.50 x 150
        ],
        pnl: { account: { realized: -1_425, unrealized: 550, total: -920 } },
        balance: { account: { cash: 210_530, positions: 550 } },
      },
    },
    {
      // The last trading day of the March contract. Its final settlement is due today and cannot run before the
      // final settlement price exists (after the close): the lifecycle item says so instead of guessing a price.
      id: 'last-trading-day', covers: 'final settlement', action: 'clock', to: AM('2026-03-20'),
      expect: {
        lifecycle: [
          { type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'blocked', reason: /^Awaiting the final settlement price for M5H6 \(2026-03-20\)/ },
          { type: 'future.expiry', instrument: 'next', dueDate: '2026-06-18', status: 'pending' },
        ],
      },
    },
    {
      id: 'june-quote', action: 'quote', instrument: 'next', quote: { bid: 5790.00, ask: 5790.25, last: 5790.00, bidSize: 200, askSize: 200 },
      expect: {
        positions: [{ instrument: 'main', lot: 'expiring', qty: 1, value: 175 }, { instrument: 'next', lot: 'lot', qty: 3, avgCost: 5818.50, price: 5790, value: -4_275, unrealized: -4_275 }], // (5,790.00 - 5,818.50) x 150
        pnl: { account: { unrealized: -4_100, total: -5_570 } }, // -1,425 - 45 - 4,100
        nav: { account: 294_430, book: 994_430 },
        balance: { account: { positions: -4_100, assets: 294_430, netAssets: 294_430 } },
      },
    },
    // The March contract's final settlement price: the special opening quotation of the index, 5,742.36.
    { id: 'final-settlement-price', covers: 'final settlement', action: 'close_price', instrument: 'main', date: '2026-03-20', value: 5742.36, expect: {} },
    {
      id: 'expiry-cash-settlement', covers: ['final settlement', 'expiry', 'variation margin', 'margin release'], action: 'clock', to: EOD('2026-03-20'),
      expect: {
        // March: closed at 5,742.36 against the reference 5,766.50: -24.14 x 50 = -1,207.00; margin 22,000 released; no fee.
        // June: (5,790.25 - 5,818.50) x 150 = -4,237.50 paid.
        events: [
          { type: 'future.final_settlement', summary: /^Final settlement: 1 M5H6 closed in cash at 5,742\.36$/, cash: { USD: 20_793 }, owner: 'account', date: '2026-03-20' },
          { type: 'future.variation', summary: 'Variation margin paid on 3 M5M6: 4,237.50 USD (settlement 5,790.25 vs 5,818.50)', cash: { USD: -4_237.50 }, date: '2026-03-20' },
        ],
        cash: { account: { USD: usd(227_085.50, 66_000) } }, // 210,530 + 20,793 - 4,237.50
        positions: [{ instrument: 'next', lot: 'lot', direction: 'long', qty: 3, avgCost: 5790.25, price: 5790, value: -37.50, unrealized: -37.50, notional: 868_500, margin: 66_000 }], // 3 x 5,790 x 50
        holdings: { main: null, next: { long: 3, short: 0, net: 3 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'next', dueDate: '2026-06-18', status: 'pending' }],
        pnl: { account: { realized: -6_869.50, unrealized: -37.50, total: -6_952 } }, // -1,425 - 1,207 - 4,237.50
        nav: { account: 293_048, book: 993_048 },
        balance: { account: { cash: 227_085.50, margin: 66_000, positions: -37.50, assets: 293_048, netAssets: 293_048 } },
      },
    },
    { id: 'monday', action: 'clock', to: AM('2026-03-23'), expect: {} },
    {
      id: 'trade-after-expiry', covers: 'expired contract', action: 'ticket', instrument: 'main', side: 'buy', qty: 1,
      status: 'blocked', reason: 'The March contract\'s last trading day was 20 March 2026.',
      expect: { refused: 'M5H6 expired on 2026-03-20' },
    },
    {
      id: 'close', covers: ['close', 'margin release'], action: 'close', lot: 'lot', instrument: 'next', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'next', qty: 3, estimate: 5790.00, model: 'quoted-bid-ask', settleDate: '2026-03-23', notional: 868_500, initialMargin: -66_000, fees: 6.75 }],
          cash: { USD: { purchases: 0, fees: 6.75, margin: 0, required: 6.75, available: 227_085.50, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 3, avgPrice: 5790 }] },
        // Realized: (5,790.00 - 5,790.25) x 150 = -37.50. Cash: -37.50 - 6.75 + 66,000 = 65,955.75.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 3 M5M6 @ 5,790.00 (notional 868,500.00 USD; margin released 66,000.00 USD; realized -37.50 USD)', cash: { USD: 65_955.75 } }],
        // Whole scenario, by hand. March lot: bought 4 at 5,800.25 and 2 at 5,781.25, sold 3 at 5,795.50 and 3 at 5,770.00: -67.00 points x 50 = -3,350.
        // Short: sold 2 at 5,795.50, bought at 5,770.25: +2,525. June: 3 x (5,790.00 - 5,821.25) x 50 = -4,687.50.
        // Held to expiry: (5,742.36 - 5,770.25) x 50 = -1,394.50. Total -6,907.00. Commission: 23 contracts x 2.25 = 51.75.
        cash: { account: { USD: usd(293_041.25, 0) }, treasury: { USD: usd(700_000) } }, // 300,000 - 6,907 - 51.75
        positions: [],
        holdings: { next: null },
        lifecycle: [],
        pnl: { account: { realized: -6_907, commissions: -51.75, unrealized: 0, total: -6_958.75 } },
        nav: { account: 293_041.25, treasury: 700_000, book: 993_041.25 },
        balance: { account: { cash: 293_041.25, margin: null, positions: null, assets: 293_041.25, liabilities: 0, netAssets: 293_041.25 } },
      },
    },
  ],
};

export default [equityIndexFuture];
