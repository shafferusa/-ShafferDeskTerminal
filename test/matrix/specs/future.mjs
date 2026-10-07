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

// ---------------------------------------------------------------------------------------------
// equity_future
// ---------------------------------------------------------------------------------------------
// A single-stock future: 100 shares a contract, quoted in USD a share, minimum move 0.01 (1.00 USD a
// contract), physically delivered: at expiry the long receives 100 shares a contract against payment
// of the final settlement price. Initial margin 1,500 USD a contract (20% of a 75.00 share).
// The Terminal does not simulate the delivery: it closes the contract in cash at the final settlement
// price and says so. The delivery itself is then recorded by hand, as a purchase of the shares at that
// price on the stock's own ticket. The final settlement price is also entered by hand here: the
// contract stops quoting on its last day, the lifecycle item waits for the price, and nothing is
// guessed in the meantime (the position is unpriced and the net asset value provisional).
// Commission: 0.75 USD a contract, at least 5.00 USD an order. Shares are delivered free of commission.
const equityFuture = {
  productId: 'equity_future',
  title: 'Calloway Freight Lines single-stock future (100 shares, physical delivery), March 2026',
  matrix: {
    ...FUTURES_TICKET,
    requiredFields: ['Account', 'Action (Buy / Sell)', 'Contracts', 'for the delivery recorded by hand: the stock ticket with "State a fill price"'],
    manualInputs: ['final settlement price, entered by hand on the contract (Overview, "Enter a price by hand", closing price for the last trading day)', 'physical delivery: purchase of 100 shares a contract at the final settlement price, on the stock ticket with a stated fill price'],
    settlement: 'No purchase cash; initial margin 1,500 USD a contract; daily variation margin; at expiry closed out in cash at the final settlement price (physical delivery is not simulated); the shares delivered by hand settle T+1 like any stock purchase',
    lifecycle: 'Daily variation margin (automatic); final settlement waits, visibly blocked, until a final settlement price exists, then closes the contract in cash (automatic) and states that delivery is not simulated; delivery by hand',
    accounting: 'Nil cost; variation margin and closes are realized P&L; commission 0.75 USD a contract with a 5.00 USD minimum an order; without a price the position is unpriced and the net asset value provisional; delivered shares carried at the final settlement price',
    collateral: 'Initial margin per contract, posted in cash, released on reduction, close and final settlement',
  },
  start: AM('2026-03-16'),
  settlementCheck: { lag: 0, holidays: [] }, // US: no holiday between 16 and 25 March 2026
  book: book('Matrix single-stock future', { funding: [{ ccy: 'USD', amount: 100_000 }], fee: { perUnit: 0.75, minimum: 5, bps: 0 }, extraFees: { equity: { perUnit: 0, minimum: 0, bps: 0 } }, settlement: { equity: 1 } }),
  instruments: {
    common: { productId: 'common_stock', name: 'Calloway Freight Lines Inc.', symbol: 'CWFL', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Calloway Freight Lines Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    main: { productId: 'equity_future', name: 'Calloway Freight Lines single-stock future, March 2026', symbol: 'CWFH6', marketView: 'US_DERIV', venue: 'Lakeshore Futures Exchange', venueType: 'exchange', venueCountry: 'US',
      underlying: 'common', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 100,
      terms: { root: 'CWF', expiration: '2026-03-20', tickSize: 0.01, initialMargin: 1_500, settlement: 'physical', priceUnits: 'USD per share' } },
  },
  quotes: {
    common: { bid: 74.60, ask: 74.62, last: 74.61, bidSize: 5000, askSize: 5000 },
    main: { bid: 74.95, ask: 75.00, last: 74.98, bidSize: 300, askSize: 300 },
  },
  closes: { main: { '2026-03-16': 75.40, '2026-03-17': 73.90, '2026-03-18': 74.10, '2026-03-19': 74.60 } },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: usd(100_000) }, treasury: { USD: usd(900_000) } },
    positions: [], lifecycle: [],
    nav: { account: 100_000, treasury: 900_000, book: 1_000_000 },
  },
  steps: [
    {
      id: 'open-short', covers: ['open short', 'initial margin'], action: 'ticket', instrument: 'main', side: 'sell', qty: 10, as: 'short',
      expect: {
        preview: { blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 10, estimate: 74.95, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-16', calendar: 'US',
            notional: 74_950, initialMargin: 15_000, fees: 7.50 }], // 10 x 74.95 (the bid) x 100; 10 x 1,500; 10 x 0.75
          cash: { USD: { purchases: 0, fees: 7.50, margin: 15_000, required: 15_007.50, available: 100_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10, avgPrice: 74.95, fills: [{ qty: 10, price: 74.95, model: 'quoted-bid-ask', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Sold 10 CWFH6 @ 74.95 (notional 74,950.00 USD; margin posted 15,000.00 USD)', cash: { USD: -15_007.50 }, owner: 'account', date: '2026-03-16' }],
        cash: { account: { USD: usd(84_992.50, 15_000) } },
        positions: [{ instrument: 'main', lot: 'short', owner: 'account', direction: 'short', qty: -10, avgCost: 74.95, cost: 0, price: 74.98,
          value: -30, unrealized: -30, // sold at 74.95, last 74.98: 0.03 x 100 x 10 against the short
          notional: 74_980, margin: 15_000 }], // 10 x 74.98 x 100
        holdings: { main: { long: 0, short: 10, net: -10 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -7.50, fees: 0, borrowFunding: 0, unrealized: -30, fx: 0, total: -37.50 } },
        nav: { account: 99_962.50, book: 999_962.50 },
        balance: { account: { cash: 84_992.50, margin: 15_000, positions: -30, assets: 99_962.50, liabilities: 0, netAssets: 99_962.50 } },
      },
    },
    {
      id: 'day-1-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-16'),
      expect: {
        // Settlement 75.40, 0.45 above the sale: the short pays 0.45 x 100 x 10 = 450.00.
        events: [{ type: 'future.variation', summary: 'Variation margin paid on -10 CWFH6: 450.00 USD (settlement 75.40 vs 74.95)', cash: { USD: -450 }, date: '2026-03-16' }],
        cash: { account: { USD: usd(84_542.50, 15_000) } },
        positions: [{ instrument: 'main', lot: 'short', qty: -10, avgCost: 75.40, price: 74.98, value: 420, unrealized: 420 }], // (75.40 - 74.98) x 1,000
        pnl: { account: { realized: -450, unrealized: 420, total: -37.50 } },
        balance: { account: { cash: 84_542.50, positions: 420 } },
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-03-17'), expect: {} },
    {
      id: 'quote-down', action: 'quote', instrument: 'main', quote: { bid: 73.80, ask: 73.85, last: 73.82, bidSize: 300, askSize: 300 },
      expect: {
        positions: [{ instrument: 'main', lot: 'short', qty: -10, avgCost: 75.40, price: 73.82, value: 1_580, unrealized: 1_580, notional: 73_820 }], // (75.40 - 73.82) x 1,000
        pnl: { account: { unrealized: 1_580, total: 1_122.50 } }, // -450 - 7.50 + 1,580
        nav: { account: 101_122.50, book: 1_001_122.50 },
        balance: { account: { positions: 1_580, assets: 101_122.50, netAssets: 101_122.50 } },
      },
    },
    {
      id: 'reduce-short', covers: ['reduce', 'margin release'], action: 'close', lot: 'short', scope: 'strategy', percent: 40, // buys back 4 of the 10
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4, estimate: 73.85, model: 'quoted-bid-ask', settleDate: '2026-03-17',
          notional: 29_540, initialMargin: -6_000, fees: 5 }], // 4 x 73.85 (the ask) x 100; 4 x 0.75 = 3.00, raised to the 5.00 minimum
          cash: { USD: { purchases: 0, fees: 5, margin: 0, required: 5, available: 84_542.50, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 4, avgPrice: 73.85 }] },
        // Realized on the 4 bought back: (75.40 - 73.85) x 100 x 4 = 620.00. Cash: 620 - 5 + 6,000 = 6,615.00.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 4 CWFH6 @ 73.85 (notional 29,540.00 USD; margin released 6,000.00 USD; realized 620.00 USD)', cash: { USD: 6_615 } }],
        cash: { account: { USD: usd(91_157.50, 9_000) } },
        positions: [{ instrument: 'main', lot: 'short', qty: -6, avgCost: 75.40, price: 73.82, value: 948, unrealized: 948, notional: 44_292, margin: 9_000 }], // (75.40 - 73.82) x 600; 6 x 73.82 x 100
        holdings: { main: { long: 0, short: 6, net: -6 } },
        pnl: { account: { realized: 170, commissions: -12.50, unrealized: 948, total: 1_105.50 } },
        nav: { account: 101_105.50, book: 1_001_105.50 },
        balance: { account: { cash: 91_157.50, margin: 9_000, positions: 948, assets: 101_105.50, netAssets: 101_105.50 } },
      },
    },
    {
      id: 'day-2-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-17'),
      expect: {
        // Settlement 73.90, 1.50 below the last one: the short receives 1.50 x 100 x 6 = 900.00.
        events: [{ type: 'future.variation', summary: 'Variation margin received on -6 CWFH6: 900.00 USD (settlement 73.90 vs 75.40)', cash: { USD: 900 }, date: '2026-03-17' }],
        cash: { account: { USD: usd(92_057.50, 9_000) } },
        positions: [{ instrument: 'main', lot: 'short', qty: -6, avgCost: 73.90, price: 73.82, value: 48, unrealized: 48 }], // (73.90 - 73.82) x 600
        pnl: { account: { realized: 1_070, unrealized: 48, total: 1_105.50 } },
        balance: { account: { cash: 92_057.50, positions: 48 } },
      },
    },
    { id: 'wednesday', action: 'clock', to: AM('2026-03-18'), expect: {} },
    {
      id: 'cover-rest', covers: ['close short', 'margin release'], action: 'close', lot: 'short', scope: 'position', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 6, estimate: 73.85, model: 'quoted-bid-ask', settleDate: '2026-03-18',
          notional: 44_310, initialMargin: -9_000, fees: 5 }], // 6 x 73.85 x 100; 6 x 0.75 = 4.50, raised to 5.00
          cash: { USD: { purchases: 0, fees: 5, margin: 0, required: 5, available: 92_057.50, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ action: 'buy', status: 'filled', filledQty: 6, avgPrice: 73.85 }] },
        // Realized: (73.90 - 73.85) x 100 x 6 = 30.00. Cash: 30 - 5 + 9,000 = 9,025.00.
        // The short as a whole: sold 10 at 74.95, bought 10 at 73.85: 1.10 x 100 x 10 = 1,100.00.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 6 CWFH6 @ 73.85 (notional 44,310.00 USD; margin released 9,000.00 USD; realized 30.00 USD)', cash: { USD: 9_025 } }],
        cash: { account: { USD: usd(101_082.50, 0) } },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        pnl: { account: { realized: 1_100, commissions: -17.50, unrealized: 0, total: 1_082.50 } },
        nav: { account: 101_082.50, book: 1_001_082.50 },
        balance: { account: { cash: 101_082.50, margin: null, positions: null, assets: 101_082.50, netAssets: 101_082.50 } },
      },
    },
    {
      id: 'open-long', covers: ['open', 'initial margin'], action: 'ticket', instrument: 'main', side: 'buy', qty: 3, as: 'long',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 3, estimate: 73.85, model: 'quoted-bid-ask', settleDate: '2026-03-18',
          notional: 22_155, initialMargin: 4_500, fees: 5 }], // 3 x 73.85 x 100; 3 x 1,500; 2.25 raised to 5.00
          cash: { USD: { purchases: 0, fees: 5, margin: 4_500, required: 4_505, available: 101_082.50, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 3, avgPrice: 73.85 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 3 CWFH6 @ 73.85 (notional 22,155.00 USD; margin posted 4,500.00 USD)', cash: { USD: -4_505 } }],
        cash: { account: { USD: usd(96_577.50, 4_500) } },
        positions: [{ instrument: 'main', lot: 'long', owner: 'account', direction: 'long', qty: 3, avgCost: 73.85, cost: 0, price: 73.82, value: -9, unrealized: -9, notional: 22_146, margin: 4_500 }], // (73.82 - 73.85) x 300; 3 x 73.82 x 100
        holdings: { main: { long: 3, short: 0, net: 3 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }],
        pnl: { account: { commissions: -22.50, unrealized: -9, total: 1_068.50 } },
        nav: { account: 101_068.50, book: 1_001_068.50 },
        balance: { account: { cash: 96_577.50, margin: 4_500, positions: -9, assets: 101_068.50, netAssets: 101_068.50 } },
      },
    },
    {
      id: 'day-3-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-18'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on 3 CWFH6: 75.00 USD (settlement 74.10 vs 73.85)', cash: { USD: 75 }, date: '2026-03-18' }], // 0.25 x 300
        cash: { account: { USD: usd(96_652.50, 4_500) } },
        positions: [{ instrument: 'main', lot: 'long', qty: 3, avgCost: 74.10, price: 73.82, value: -84, unrealized: -84 }], // (73.82 - 74.10) x 300
        pnl: { account: { realized: 1_175, unrealized: -84, total: 1_068.50 } },
        balance: { account: { cash: 96_652.50, positions: -84 } },
      },
    },
    { id: 'thursday', action: 'clock', to: AM('2026-03-19'), expect: {} },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 74.55, ask: 74.60, last: 74.58, bidSize: 300, askSize: 300 },
      expect: {
        positions: [{ instrument: 'main', lot: 'long', qty: 3, avgCost: 74.10, price: 74.58, value: 144, unrealized: 144 }], // 0.48 x 300
        pnl: { account: { unrealized: 144, total: 1_296.50 } }, // 1,175 - 22.50 + 144
        nav: { account: 101_296.50, book: 1_001_296.50 },
        balance: { account: { positions: 144, assets: 101_296.50, netAssets: 101_296.50 } },
      },
    },
    {
      id: 'day-4-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-19'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on 3 CWFH6: 150.00 USD (settlement 74.60 vs 74.10)', cash: { USD: 150 }, date: '2026-03-19' }], // 0.50 x 300
        cash: { account: { USD: usd(96_802.50, 4_500) } },
        positions: [{ instrument: 'main', lot: 'long', qty: 3, avgCost: 74.60, price: 74.58, value: -6, unrealized: -6 }], // (74.58 - 74.60) x 300
        pnl: { account: { realized: 1_325, unrealized: -6, total: 1_296.50 } },
        balance: { account: { cash: 96_802.50, positions: -6 } },
      },
    },
    {
      // Last trading day. The final settlement is due and waits for its price.
      id: 'last-trading-day', covers: 'final settlement', action: 'clock', to: AM('2026-03-20'),
      expect: { lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'blocked', reason: /^Awaiting the final settlement price for CWFH6 \(2026-03-20\)/ }] },
    },
    { id: 'stock-close', action: 'quote', instrument: 'common', quote: { bid: 74.20, ask: 74.30, last: 74.25, bidSize: 5000, askSize: 5000 }, expect: {} },
    {
      // The contract stops quoting. With no price its open trade equity cannot be stated: the position is unpriced and
      // the net asset value, now settled cash plus margin (96,802.50 + 4,500), is marked provisional. Nothing is guessed.
      id: 'quote-ends', covers: 'missing price', action: 'quote', instrument: 'main', quote: { clear: true },
      expect: {
        positions: [{ instrument: 'main', lot: 'long', qty: 3, avgCost: 74.60, price: null, value: null, unrealized: null, notional: null, margin: 4_500, provisional: true }],
        provisional: { account: true, book: true },
        pnl: { account: { realized: 1_325, commissions: -22.50, unrealized: 0, total: 1_302.50, complete: false } },
        nav: { account: 101_302.50, book: 1_001_302.50 },
        balance: { account: { positions: null, assets: 101_302.50, netAssets: 101_302.50 } },
      },
    },
    {
      // The end-of-day pass of the last trading day: no settlement price, so no variation margin and no final settlement.
      id: 'expiry-without-a-price', covers: ['final settlement', 'missing price'], action: 'clock', to: EOD('2026-03-20'),
      expect: { events: [] },
    },
    {
      // The final settlement price, the stock's closing price 74.25, is entered by hand for the last trading day.
      // The next engine cycle closes the contract in cash: (74.25 - 74.60) x 300 = -105.00; margin 4,500 released; no fee.
      id: 'final-price-by-hand', covers: ['final settlement', 'manual price', 'expiry', 'margin release'], action: 'manual_price', instrument: 'main', value: 74.25, forDate: '2026-03-20', note: 'Final settlement price: closing price of CWFL on 20 March 2026',
      expect: {
        events: [{ type: 'future.final_settlement', summary: 'Final settlement: 3 CWFH6 closed in cash at 74.25 (physical delivery is not simulated)', cash: { USD: 4_395 }, owner: 'account', date: '2026-03-20' }],
        cash: { account: { USD: usd(101_197.50, 0) } },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        provisional: { account: false, book: false },
        pnl: { account: { realized: 1_220, unrealized: 0, total: 1_197.50, complete: true } }, // 1,325 - 105
        nav: { account: 101_197.50, book: 1_001_197.50 },
        balance: { account: { cash: 101_197.50, margin: null, positions: null, assets: 101_197.50, netAssets: 101_197.50 } },
      },
    },
    { id: 'monday', action: 'clock', to: AM('2026-03-23'), expect: {} },
    {
      id: 'trade-after-expiry', covers: 'expired contract', action: 'ticket', instrument: 'main', side: 'sell', qty: 1,
      status: 'blocked', reason: 'The contract\'s last trading day was 20 March 2026.',
      expect: { refused: 'CWFH6 expired on 2026-03-20' },
    },
    {
      // The contract called for delivery of 3 x 100 shares against 300 x 74.25 = 22,275.00. The Terminal closed it in
      // cash, so the delivery is recorded by hand: the shares are bought on the stock ticket at the final settlement price.
      id: 'delivery-by-hand', covers: 'physical delivery', action: 'ticket', ticketOf: 'equity', instrument: 'common', side: 'buy', qty: 300, as: 'delivered', order: { statedPrice: 74.25 }, settlementCheck: false,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'common', qty: 300, estimate: 74.25, model: 'stated-price', settleDate: '2026-03-24', cash: -22_275, fees: 0 }], // 300 x 74.25; T+1
          cash: { USD: { purchases: 22_275, fees: 0, required: 22_275, available: 101_197.50, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 300, avgPrice: 74.25, fills: [{ qty: 300, price: 74.25, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 300 CWFL @ 74.25 USD', cash: {}, owner: 'account', date: '2026-03-23' }],
        cash: { account: { USD: { settled: 101_197.50, unsettled: -22_275, margin: 0, availableToTrade: 78_922.50, availableToWithdraw: 78_922.50 } } }, // the 22,275 owed tomorrow is neither spendable nor withdrawable
        positions: [{ instrument: 'common', lot: 'delivered', owner: 'account', direction: 'long', qty: 300, avgCost: 74.25, cost: 22_275, price: 74.25, value: 22_275, unrealized: 0 }],
        holdings: { common: { long: 300, short: 0, net: 300 } },
        pending: [{ instrument: 'common', owner: 'account', dueDate: '2026-03-24', amount: -22_275, ccy: 'USD', into: 'cash' }],
        nav: { account: 101_197.50, book: 1_001_197.50 }, // bought at their value: nothing gained or lost
        balance: { account: { cash: 101_197.50, positions: 22_275, payable: 22_275, assets: 123_472.50, liabilities: 22_275, netAssets: 101_197.50 } },
      },
    },
    {
      id: 'delivery-settles', covers: 'settlement', action: 'clock', to: AM('2026-03-24'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 22,275.00 USD from settled cash', cash: { USD: -22_275 }, date: '2026-03-24' }],
        cash: { account: { USD: usd(78_922.50, 0) } },
        pending: [],
        balance: { account: { cash: 78_922.50, payable: null, assets: 101_197.50, liabilities: 0 } },
      },
    },
    {
      id: 'stock-up', action: 'quote', instrument: 'common', quote: { bid: 74.40, ask: 74.44, last: 74.42, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'common', lot: 'delivered', qty: 300, cost: 22_275, price: 74.42, value: 22_326, unrealized: 51 }], // 300 x 74.42
        pnl: { account: { unrealized: 51, total: 1_248.50 } },
        nav: { account: 101_248.50, book: 1_001_248.50 },
        balance: { account: { positions: 22_326, assets: 101_248.50, netAssets: 101_248.50 } },
      },
    },
    {
      id: 'sell-delivered-shares', covers: 'close', action: 'ticket', ticketOf: 'equity', instrument: 'common', side: 'sell', qty: 300, from: 'delivered', settlementCheck: false,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'common', qty: 300, estimate: 74.40, model: 'quoted-bid-ask', settleDate: '2026-03-25', cash: 22_320, fees: 0 }] }, // 300 x 74.40 (the bid)
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 300, avgPrice: 74.40 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 300 CWFL @ 74.40 USD (realized 45.00 USD)' }], // 300 x (74.40 - 74.25)
        cash: { account: { USD: { settled: 78_922.50, unsettled: 22_320, availableToTrade: 101_242.50, availableToWithdraw: 78_922.50 } } }, // proceeds can be traded on, not withdrawn, before they settle
        positions: [],
        holdings: { common: null },
        pending: [{ instrument: 'common', owner: 'account', dueDate: '2026-03-25', amount: 22_320, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 1_265, unrealized: 0, total: 1_242.50 } },
        nav: { account: 101_242.50, book: 1_001_242.50 },
        balance: { account: { cash: 78_922.50, receivable: 22_320, positions: null, assets: 101_242.50, netAssets: 101_242.50 } },
      },
    },
    {
      id: 'sale-settles', covers: 'settlement', action: 'clock', to: AM('2026-03-25'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 22,320.00 USD into settled cash', cash: { USD: 22_320 } }],
        // By hand: 100,000 + 1,100 (short) + 120 (long: 3 x 100 x (74.25 - 73.85)) + 45 (shares) - 22.50 commission = 101,242.50.
        cash: { account: { USD: usd(101_242.50, 0) }, treasury: { USD: usd(900_000) } },
        pending: [],
        nav: { account: 101_242.50, treasury: 900_000, book: 1_001_242.50 },
        balance: { account: { cash: 101_242.50, receivable: null, assets: 101_242.50, liabilities: 0, netAssets: 101_242.50 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// gov_bond_future
// ---------------------------------------------------------------------------------------------
// Modelled on the Eurex Euro-Bund future: 100,000 EUR face of a notional 6% German federal bond, quoted
// in percent of par to two decimals, so one point is 1,000 EUR and the minimum move 0.01 is 10 EUR.
// Physically delivered (a deliverable Bund on the 10th of the contract month; last trading day two
// exchange days before, 8 June 2026); this scenario closes the position before then.
// The contract is in euros and the Book reports in US dollars: every euro amount is checked, and so is
// its translation at the EUR/USD fixture (1.10, then 1.08). Postings are translated at the rate of the
// day they are booked; balances and open trade equity at the current rate; the difference is the
// "FX effects" line.
// The venue is in Germany, so the contract follows the TARGET calendar: Friday 1 May 2026 is a holiday
// there and an ordinary business day in New York. The end-of-day pass of that Friday must exchange no
// variation margin, although the standing quote (130.64) differs from Thursday's settlement (130.70).
// Commission: 1.50 EUR a contract.
const govBondFuture = {
  productId: 'gov_bond_future',
  title: 'Euro-Bund future (100,000 EUR face, 10 EUR a tick), June 2026, Eurex, held short across 1 May',
  matrix: {
    ...FUTURES_TICKET,
    manualInputs: ['none in this scenario (delivery of a deliverable bond is not simulated: the position is closed before the last trading day)'],
    settlement: 'No purchase cash; initial margin 2,600 EUR a contract and daily variation margin, both in euros; no variation on a TARGET holiday',
    lifecycle: 'Daily variation margin on the contract\'s own business days (automatic); none on 1 May 2026 (TARGET holiday, US business day); the first settlement after the holiday is against the last settlement before it',
    accounting: 'Euro cash, margin and open trade equity translated to USD at the current fixture rate; realized P&L and commission at the rate of their day; the rest is FX effects; commission 1.50 EUR a contract',
    collateral: 'Initial margin per contract in EUR, posted from the Account\'s EUR cash; released pro rata',
  },
  start: AM('2026-04-28'),
  settlementCheck: { lag: 0, holidays: ['2026-05-01'] }, // TARGET: 1 May 2026; no US holiday between 28 April and 5 May
  book: book('Matrix government-bond future', {
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'EUR', amount: 400_000 }],
    funding: [{ ccy: 'USD', amount: 200_000 }, { ccy: 'EUR', amount: 200_000 }],
    fee: { perUnit: 1.50, minimum: 0, bps: 0 },
  }),
  fx: { 'EUR/USD': 1.10 },
  instruments: {
    main: { productId: 'gov_bond_future', name: 'Euro-Bund future, June 2026', symbol: 'FGBLM6', marketView: 'FOREIGN_DERIV', venue: 'Eurex', venueType: 'exchange', venueCountry: 'DE', issuer: 'Federal Republic of Germany', domicile: 'DE', underlyingGeo: 'DE',
      tradingCcy: 'EUR', multiplier: 1000,
      terms: { root: 'FGBL', expiration: '2026-06-08', tickSize: 0.01, initialMargin: 2_600, settlement: 'physical', priceUnits: '% of par' } },
  },
  quotes: { main: { bid: 130.50, ask: 130.51, last: 130.50, bidSize: 500, askSize: 500 } },
  closes: { main: { '2026-04-28': 130.42, '2026-04-29': 130.61, '2026-04-30': 130.70, '2026-05-04': 130.25 } }, // none on 1 May: the exchange is closed
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: usd(200_000), EUR: usd(200_000) }, treasury: { USD: usd(800_000), EUR: usd(200_000) } },
    positions: [], lifecycle: [],
    nav: { account: 420_000, treasury: 1_020_000, book: 1_440_000 }, // 200,000 EUR x 1.10 = 220,000 USD each
  },
  steps: [
    {
      id: 'open-short', covers: ['open short', 'initial margin'], action: 'ticket', instrument: 'main', side: 'sell', qty: 10, as: 'hedge',
      expect: {
        preview: { blocking: 0, errors: [], notes: ['calendar-approximate'], // TARGET days stand in for the exchange's own calendar, and the preview says so
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 10, estimate: 130.50, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-04-28', calendar: 'TARGET',
            notional: 1_305_000, initialMargin: 26_000, fees: 15 }], // 10 x 130.50 x 1,000; 10 x 2,600; 10 x 1.50 (all EUR)
          cash: { EUR: { purchases: 0, fees: 15, margin: 26_000, required: 26_015, available: 200_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10, avgPrice: 130.50 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Sold 10 FGBLM6 @ 130.50 (notional 1,305,000.00 EUR; margin posted 26,000.00 EUR)', cash: { EUR: -26_015 }, owner: 'account', date: '2026-04-28' }],
        cash: { account: { EUR: usd(173_985, 26_000), USD: usd(200_000) } },
        positions: [{ instrument: 'main', lot: 'hedge', owner: 'account', direction: 'short', qty: -10, avgCost: 130.50, cost: 0, price: 130.50, value: 0, unrealized: 0, notional: 1_305_000, margin: 26_000 }],
        holdings: { main: { long: 0, short: 10, net: -10 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-06-08', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -16.50, fees: 0, borrowFunding: 0, unrealized: 0, fx: 0, total: -16.50 } }, // 15 EUR x 1.10
        nav: { account: 419_983.50, book: 1_439_983.50 },
        // USD 200,000 + EUR 173,985 x 1.10 = 391,383.50; margin 26,000 x 1.10 = 28,600.
        balance: { account: { cash: 391_383.50, margin: 28_600, positions: null, assets: 419_983.50, liabilities: 0, netAssets: 419_983.50, local: { EUR: { cash: 173_985, margin: 26_000 }, USD: { cash: 200_000 } } } },
      },
    },
    {
      id: 'day-1-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-04-28'),
      expect: {
        // Settlement 130.42, 0.08 below the sale: the short receives 0.08 x 1,000 x 10 = 800.00 EUR (880.00 USD).
        events: [{ type: 'future.variation', summary: 'Variation margin received on -10 FGBLM6: 800.00 EUR (settlement 130.42 vs 130.50)', cash: { EUR: 800 }, date: '2026-04-28' }],
        cash: { account: { EUR: usd(174_785, 26_000) } },
        positions: [{ instrument: 'main', lot: 'hedge', qty: -10, avgCost: 130.42, price: 130.50, value: -800, unrealized: -800 }], // (130.50 - 130.42) x 10,000 against the short
        pnl: { account: { realized: 880, unrealized: -880, total: -16.50 } },
        balance: { account: { cash: 392_263.50, positions: -880, assets: 419_983.50, local: { EUR: { cash: 174_785, positions: -800 } } } }, // 200,000 + 174,785 x 1.10
      },
    },
    { id: 'wednesday', action: 'clock', to: AM('2026-04-29'), expect: {} },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 130.63, ask: 130.64, last: 130.64, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'hedge', qty: -10, avgCost: 130.42, price: 130.64, value: -2_200, unrealized: -2_200, notional: 1_306_400 }], // (130.64 - 130.42) x 10,000
        pnl: { account: { unrealized: -2_420, total: -1_556.50 } }, // 880 - 16.50 - 2,420
        nav: { account: 418_443.50, book: 1_438_443.50 },
        balance: { account: { positions: -2_420, assets: 418_443.50, netAssets: 418_443.50, local: { EUR: { positions: -2_200 } } } },
      },
    },
    {
      id: 'day-2-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-04-29'),
      expect: {
        // Settlement 130.61, 0.19 above the last one: the short pays 1,900.00 EUR (2,090.00 USD).
        events: [{ type: 'future.variation', summary: 'Variation margin paid on -10 FGBLM6: 1,900.00 EUR (settlement 130.61 vs 130.42)', cash: { EUR: -1_900 }, date: '2026-04-29' }],
        cash: { account: { EUR: usd(172_885, 26_000) } },
        positions: [{ instrument: 'main', lot: 'hedge', qty: -10, avgCost: 130.61, price: 130.64, value: -300, unrealized: -300 }],
        pnl: { account: { realized: -1_210, unrealized: -330, total: -1_556.50 } },
        balance: { account: { cash: 390_173.50, positions: -330, local: { EUR: { cash: 172_885, positions: -300 } } } }, // 200,000 + 172,885 x 1.10
      },
    },
    { id: 'thursday', action: 'clock', to: AM('2026-04-30'), expect: {} },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'hedge', factor: 1.5, // 10 -> 15 short: sells 5 more
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 5, estimate: 130.63, model: 'quoted-bid-ask', settleDate: '2026-04-30',
          notional: 653_150, initialMargin: 13_000, fees: 7.50 }], // 5 x 130.63 (the bid) x 1,000
          cash: { EUR: { purchases: 0, fees: 7.50, margin: 13_000, required: 13_007.50, available: 172_885, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 5, avgPrice: 130.63 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 5 FGBLM6 @ 130.63 (notional 653,150.00 EUR; margin posted 13,000.00 EUR)', cash: { EUR: -13_007.50 } }],
        cash: { account: { EUR: usd(159_877.50, 39_000) } },
        // Reference: (10 x 130.61 + 5 x 130.63) / 15 = 130.616667. Value: 10 x -0.03 x 1,000 + 5 x -0.01 x 1,000 = -350 EUR (-385 USD).
        positions: [{ instrument: 'main', lot: 'hedge', qty: -15, avgCost: 130.616667, price: 130.64, value: -350, unrealized: -350, notional: 1_959_600, margin: 39_000 }], // 15 x 130.64 x 1,000
        holdings: { main: { long: 0, short: 15, net: -15 } },
        pnl: { account: { commissions: -24.75, unrealized: -385, total: -1_619.75 } }, // 22.50 EUR x 1.10
        nav: { account: 418_380.25, book: 1_438_380.25 },
        balance: { account: { cash: 375_865.25, margin: 42_900, positions: -385, assets: 418_380.25, netAssets: 418_380.25, local: { EUR: { cash: 159_877.50, margin: 39_000, positions: -350 } } } }, // 200,000 + 159,877.50 x 1.10
      },
    },
    {
      id: 'day-3-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-04-30'),
      expect: {
        // 15 x 130.70 x 1,000 = 1,960,500 against 10 x 130.61 x 1,000 + 5 x 130.63 x 1,000 = 1,959,250: the short pays 1,250.00 EUR (1,375.00 USD).
        events: [{ type: 'future.variation', summary: 'Variation margin paid on -15 FGBLM6: 1,250.00 EUR (settlement 130.70 vs 130.616667)', cash: { EUR: -1_250 }, date: '2026-04-30' }],
        cash: { account: { EUR: usd(158_627.50, 39_000) } },
        positions: [{ instrument: 'main', lot: 'hedge', qty: -15, avgCost: 130.70, price: 130.64, value: 900, unrealized: 900 }], // (130.70 - 130.64) x 15,000
        pnl: { account: { realized: -2_585, unrealized: 990, total: -1_619.75 } },
        balance: { account: { cash: 374_490.25, positions: 990, local: { EUR: { cash: 158_627.50, positions: 900 } } } }, // 200,000 + 158,627.50 x 1.10
      },
    },
    {
      // Friday 1 May 2026: Eurex and TARGET are closed, New York is open and the Terminal runs its end-of-day pass.
      // The quote still stands at 130.64 against Thursday's settlement of 130.70. Nothing may be exchanged.
      id: 'exchange-holiday', covers: ['exchange holiday', 'variation margin'], action: 'clock', to: EOD('2026-05-01'),
      expect: { events: [] },
    },
    { id: 'monday', action: 'clock', to: AM('2026-05-04'), expect: {} },
    {
      // The euro falls from 1.10 to 1.08 USD. Euro balances are unchanged; their USD translation moves.
      id: 'euro-falls', covers: 'FX translation', action: 'fx_rate', pair: 'EUR/USD', rate: 1.08,
      expect: {
        // EUR cash 158,627.50 and margin 39,000 lose 0.02 USD each: 197,627.50 x -0.02 = -3,952.55 (FX effects).
        // Open trade equity 900 EUR is now 972 USD. Realized P&L and commission keep the rate of their day.
        pnl: { account: { realized: -2_585, commissions: -24.75, unrealized: 972, fx: -3_952.55, total: -5_590.30 } },
        nav: { account: 414_409.70, treasury: 1_016_000, book: 1_430_409.70 }, // 200,000 + (158,627.50 + 39,000 + 900) x 1.08; 800,000 + 200,000 x 1.08
        balance: { account: { cash: 371_317.70, margin: 42_120, positions: 972, assets: 414_409.70, netAssets: 414_409.70 } }, // 200,000 + 158,627.50 x 1.08
      },
    },
    {
      id: 'quote-down', action: 'quote', instrument: 'main', quote: { bid: 130.20, ask: 130.21, last: 130.20, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'hedge', qty: -15, avgCost: 130.70, price: 130.20, value: 7_500, unrealized: 7_500, notional: 1_953_000 }], // (130.70 - 130.20) x 15,000
        pnl: { account: { unrealized: 8_100, total: 1_537.70 } }, // -2,585 - 24.75 + 8,100 - 3,952.55
        nav: { account: 421_537.70, book: 1_437_537.70 },
        balance: { account: { positions: 8_100, assets: 421_537.70, netAssets: 421_537.70, local: { EUR: { positions: 7_500 } } } },
      },
    },
    {
      id: 'reduce', covers: ['reduce', 'margin release'], action: 'close', lot: 'hedge', scope: 'strategy', percent: 40, // buys back 6 of the 15
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 6, estimate: 130.21, model: 'quoted-bid-ask', settleDate: '2026-05-04',
          notional: 781_260, initialMargin: -15_600, fees: 9 }], // 6 x 130.21 (the ask) x 1,000
          cash: { EUR: { purchases: 0, fees: 9, margin: 0, required: 9, available: 158_627.50, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 6, avgPrice: 130.21 }] },
        // Realized: (130.70 - 130.21) x 1,000 x 6 = 2,940.00 EUR, 3,175.20 USD at 1.08. Cash: 2,940 - 9 + 15,600 = 18,531.00 EUR.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 6 FGBLM6 @ 130.21 (notional 781,260.00 EUR; margin released 15,600.00 EUR; realized 2,940.00 EUR)', cash: { EUR: 18_531 } }],
        cash: { account: { EUR: usd(177_158.50, 23_400) } },
        positions: [{ instrument: 'main', lot: 'hedge', qty: -9, avgCost: 130.70, price: 130.20, value: 4_500, unrealized: 4_500, notional: 1_171_800, margin: 23_400 }],
        holdings: { main: { long: 0, short: 9, net: -9 } },
        pnl: { account: { realized: 590.20, commissions: -34.47, unrealized: 4_860, fx: -3_952.55, total: 1_463.18 } }, // -2,585 + 3,175.20; -24.75 - 9 x 1.08
        nav: { account: 421_463.18, book: 1_437_463.18 },
        balance: { account: { cash: 391_331.18, margin: 25_272, positions: 4_860, assets: 421_463.18, netAssets: 421_463.18, local: { EUR: { cash: 177_158.50, margin: 23_400, positions: 4_500 } } } }, // 200,000 + 177,158.50 x 1.08
      },
    },
    {
      id: 'day-after-holiday-variation', covers: ['variation margin', 'exchange holiday'], action: 'clock', to: EOD('2026-05-04'),
      expect: {
        // The first settlement after the holiday, against Thursday's 130.70: (130.70 - 130.25) x 1,000 x 9 = 4,050.00 EUR received (4,374.00 USD).
        events: [{ type: 'future.variation', summary: 'Variation margin received on -9 FGBLM6: 4,050.00 EUR (settlement 130.25 vs 130.70)', cash: { EUR: 4_050 }, date: '2026-05-04' }],
        cash: { account: { EUR: usd(181_208.50, 23_400) } },
        positions: [{ instrument: 'main', lot: 'hedge', qty: -9, avgCost: 130.25, price: 130.20, value: 450, unrealized: 450 }], // (130.25 - 130.20) x 9,000
        pnl: { account: { realized: 4_964.20, unrealized: 486, total: 1_463.18 } },
        balance: { account: { cash: 395_705.18, positions: 486, local: { EUR: { cash: 181_208.50, positions: 450 } } } }, // 200,000 + 181,208.50 x 1.08
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-05-05'), expect: {} },
    {
      id: 'close', covers: ['close', 'margin release'], action: 'close', lot: 'hedge', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 9, estimate: 130.21, model: 'quoted-bid-ask', settleDate: '2026-05-05',
          notional: 1_171_890, initialMargin: -23_400, fees: 13.50 }],
          cash: { EUR: { purchases: 0, fees: 13.50, margin: 0, required: 13.50, available: 181_208.50, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ action: 'buy', status: 'filled', filledQty: 9, avgPrice: 130.21 }] },
        // Realized: (130.25 - 130.21) x 1,000 x 9 = 360.00 EUR (388.80 USD). Cash: 360 - 13.50 + 23,400 = 23,746.50 EUR.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 9 FGBLM6 @ 130.21 (notional 1,171,890.00 EUR; margin released 23,400.00 EUR; realized 360.00 EUR)', cash: { EUR: 23_746.50 } }],
        // In euros, by hand: sold 10 at 130.50 and 5 at 130.63, bought 15 at 130.21: (1,305.00 + 653.15 - 1,953.15) x 1,000 = 5,000.00;
        // commission 30 contracts x 1.50 = 45.00. EUR cash 200,000 + 5,000 - 45 = 204,955.00.
        cash: { account: { EUR: usd(204_955, 0), USD: usd(200_000) }, treasury: { USD: usd(800_000), EUR: usd(200_000) } },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        pnl: { account: { realized: 5_353, commissions: -49.05, unrealized: 0, fx: -3_952.55, total: 1_351.40 } }, // 4,964.20 + 388.80; -34.47 - 13.50 x 1.08
        nav: { account: 421_351.40, treasury: 1_016_000, book: 1_437_351.40 }, // 200,000 + 204,955 x 1.08
        balance: { account: { cash: 421_351.40, margin: null, positions: null, assets: 421_351.40, liabilities: 0, netAssets: 421_351.40, local: { EUR: { cash: 204_955, margin: null, positions: null }, USD: { cash: 200_000 } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// treasury_future
// ---------------------------------------------------------------------------------------------
// Modelled on the CBOT 10-Year US Treasury Note future: 100,000 USD face, quoted in points of par
// and halves of a thirty-second, so one point is 1,000 USD and the minimum move, 1/64 of a point
// (0.015625), is 15.625 USD a contract. 112-16 is 112.50; 112-08+ is 112.265625.
// Physically delivered (a Treasury note with 6.5 to 10 years left); last trading day the seventh
// business day before the last business day of the month: Friday 20 March 2026 for the March contract.
// Held to that day here: the Terminal closes it in cash at the final settlement price and states that
// delivery is not simulated. Initial margin 2,200 USD a contract; commission 0.85 USD a contract.
const treasuryFuture = {
  productId: 'treasury_future',
  title: '10-Year US Treasury Note future (100,000 USD face, 1/64 tick), March 2026, CBOT, held to its last trading day',
  matrix: {
    ...FUTURES_TICKET,
    manualInputs: ['none in this scenario; delivery of a Treasury note against the invoice amount is not simulated and would be recorded by hand on the note\'s own ticket'],
    settlement: 'No purchase cash; initial margin 2,200 USD a contract; daily variation margin at 15.625 USD a sixty-fourth; closed out in cash on the last trading day',
    lifecycle: 'Daily variation margin (automatic); on the last trading day closed in cash at the final settlement price, labelled "physical delivery is not simulated" (automatic); a contract past that day refuses trades',
    accounting: 'Nil cost; prices in sixty-fourths carried exactly; variation margin and closes are realized P&L; commission 0.85 USD a contract',
    collateral: 'Initial margin per contract, released pro rata on reduction and at final settlement',
  },
  start: AM('2026-03-16'),
  settlementCheck: { lag: 0, holidays: [] }, // US: no holiday between 16 and 23 March 2026
  book: book('Matrix Treasury future', { funding: [{ ccy: 'USD', amount: 250_000 }], fee: { perUnit: 0.85, minimum: 0, bps: 0 } }),
  instruments: {
    main: { productId: 'treasury_future', name: '10-Year US Treasury Note future, March 2026', symbol: 'TYH6', marketView: 'US_DERIV', venue: 'CBOT', venueType: 'exchange', venueCountry: 'US', issuer: 'United States Treasury', domicile: 'US', underlyingGeo: 'US',
      tradingCcy: 'USD', multiplier: 1000,
      terms: { root: 'TY', expiration: '2026-03-20', tickSize: 0.015625, initialMargin: 2_200, settlement: 'physical', priceUnits: 'points of par (halves of 1/32)' } },
  },
  quotes: { main: { bid: 112.484375, ask: 112.5, last: 112.5, bidSize: 500, askSize: 500 } }, // 112-15+ bid, 112-16 offered
  // 112-08+, 112-23, 112-20+, 112-18+
  closes: { main: { '2026-03-16': 112.265625, '2026-03-17': 112.71875, '2026-03-18': 112.640625, '2026-03-19': 112.578125 } },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: usd(250_000) }, treasury: { USD: usd(750_000) } },
    positions: [], lifecycle: [],
    nav: { account: 250_000, treasury: 750_000, book: 1_000_000 },
  },
  steps: [
    {
      id: 'open', covers: ['open', 'initial margin'], action: 'ticket', instrument: 'main', side: 'buy', qty: 8, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 8, estimate: 112.5, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-16', calendar: 'US',
            notional: 900_000, initialMargin: 17_600, fees: 6.80 }], // 8 x 112.50 x 1,000; 8 x 2,200; 8 x 0.85
          cash: { USD: { purchases: 0, fees: 6.80, margin: 17_600, required: 17_606.80, available: 250_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 8, avgPrice: 112.5 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 8 TYH6 @ 112.50 (notional 900,000.00 USD; margin posted 17,600.00 USD)', cash: { USD: -17_606.80 }, owner: 'account', date: '2026-03-16' }],
        cash: { account: { USD: usd(232_393.20, 17_600) } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 8, avgCost: 112.5, cost: 0, price: 112.5, value: 0, unrealized: 0, notional: 900_000, margin: 17_600 }],
        holdings: { main: { long: 8, short: 0, net: 8 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -6.80, fees: 0, borrowFunding: 0, unrealized: 0, fx: 0, total: -6.80 } },
        nav: { account: 249_993.20, book: 999_993.20 },
        balance: { account: { cash: 232_393.20, margin: 17_600, positions: null, assets: 249_993.20, liabilities: 0, netAssets: 249_993.20 } },
      },
    },
    {
      id: 'day-1-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-16'),
      expect: {
        // 112-08+ against 112-16: 15 sixty-fourths down. 15 x 15.625 x 8 = 1,875.00 paid.
        events: [{ type: 'future.variation', summary: 'Variation margin paid on 8 TYH6: 1,875.00 USD (settlement 112.265625 vs 112.50)', cash: { USD: -1_875 }, date: '2026-03-16' }],
        cash: { account: { USD: usd(230_518.20, 17_600) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 8, avgCost: 112.265625, price: 112.5, value: 1_875, unrealized: 1_875 }], // the quote still stands 15 sixty-fourths above the settlement
        pnl: { account: { realized: -1_875, unrealized: 1_875, total: -6.80 } },
        balance: { account: { cash: 230_518.20, positions: 1_875 } },
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-03-17'), expect: {} },
    {
      id: 'quote-tuesday', action: 'quote', instrument: 'main', quote: { bid: 112.28125, ask: 112.296875, last: 112.28125, bidSize: 500, askSize: 500 }, // 112-09 bid, 112-09+ offered
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 8, avgCost: 112.265625, price: 112.28125, value: 125, unrealized: 125, notional: 898_250 }], // one sixty-fourth x 15.625 x 8; 8 x 112.28125 x 1,000
        pnl: { account: { unrealized: 125, total: -1_756.80 } }, // -1,875 - 6.80 + 125
        nav: { account: 248_243.20, book: 998_243.20 },
        balance: { account: { positions: 125, assets: 248_243.20, netAssets: 248_243.20 } },
      },
    },
    {
      id: 'day-2-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-17'),
      expect: {
        // 112-23 against 112-08+: 29 sixty-fourths up. 29 x 15.625 x 8 = 3,625.00 received.
        events: [{ type: 'future.variation', summary: 'Variation margin received on 8 TYH6: 3,625.00 USD (settlement 112.71875 vs 112.265625)', cash: { USD: 3_625 }, date: '2026-03-17' }],
        cash: { account: { USD: usd(234_143.20, 17_600) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 8, avgCost: 112.71875, price: 112.28125, value: -3_500, unrealized: -3_500 }], // 28 sixty-fourths x 15.625 x 8
        pnl: { account: { realized: 1_750, unrealized: -3_500, total: -1_756.80 } },
        balance: { account: { cash: 234_143.20, positions: -3_500 } },
      },
    },
    { id: 'wednesday', action: 'clock', to: AM('2026-03-18'), expect: {} },
    {
      id: 'quote-wednesday', action: 'quote', instrument: 'main', quote: { bid: 112.796875, ask: 112.8125, last: 112.8125, bidSize: 500, askSize: 500 }, // 112-25+ bid, 112-26 offered
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 8, avgCost: 112.71875, price: 112.8125, value: 750, unrealized: 750, notional: 902_500 }], // 6 sixty-fourths x 15.625 x 8
        pnl: { account: { unrealized: 750, total: 2_493.20 } }, // 1,750 - 6.80 + 750
        nav: { account: 252_493.20, book: 1_002_493.20 },
        balance: { account: { positions: 750, assets: 252_493.20, netAssets: 252_493.20 } },
      },
    },
    {
      id: 'reduce', covers: ['reduce', 'margin release'], action: 'close', lot: 'lot', scope: 'strategy', percent: 25, // sells 2 of the 8
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2, estimate: 112.796875, model: 'quoted-bid-ask', settleDate: '2026-03-18',
          notional: 225_593.75, initialMargin: -4_400, fees: 1.70 }], // 2 x 112.796875 x 1,000
          cash: { USD: { purchases: 0, fees: 1.70, margin: 0, required: 1.70, available: 234_143.20, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2, avgPrice: 112.796875 }] },
        // Realized: 5 sixty-fourths (112-25+ against 112-23) x 15.625 x 2 = 156.25. Cash: 156.25 - 1.70 + 4,400 = 4,554.55.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2 TYH6 @ 112.796875 (notional 225,593.75 USD; margin released 4,400.00 USD; realized 156.25 USD)', cash: { USD: 4_554.55 } }],
        cash: { account: { USD: usd(238_697.75, 13_200) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 6, avgCost: 112.71875, price: 112.8125, value: 562.50, unrealized: 562.50, notional: 676_875, margin: 13_200 }], // 6 sixty-fourths x 15.625 x 6
        holdings: { main: { long: 6, short: 0, net: 6 } },
        pnl: { account: { realized: 1_906.25, commissions: -8.50, unrealized: 562.50, total: 2_460.25 } },
        nav: { account: 252_460.25, book: 1_002_460.25 },
        balance: { account: { cash: 238_697.75, margin: 13_200, positions: 562.50, assets: 252_460.25, netAssets: 252_460.25 } },
      },
    },
    {
      id: 'day-3-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-18'),
      expect: {
        // 112-20+ against 112-23: 5 sixty-fourths down. 5 x 15.625 x 6 = 468.75 paid.
        events: [{ type: 'future.variation', summary: 'Variation margin paid on 6 TYH6: 468.75 USD (settlement 112.640625 vs 112.71875)', cash: { USD: -468.75 }, date: '2026-03-18' }],
        cash: { account: { USD: usd(238_229, 13_200) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 6, avgCost: 112.640625, price: 112.8125, value: 1_031.25, unrealized: 1_031.25 }], // 11 sixty-fourths x 15.625 x 6
        pnl: { account: { realized: 1_437.50, unrealized: 1_031.25, total: 2_460.25 } },
        balance: { account: { cash: 238_229, positions: 1_031.25 } },
      },
    },
    { id: 'thursday', action: 'clock', to: AM('2026-03-19'), expect: {} },
    {
      id: 'quote-thursday', action: 'quote', instrument: 'main', quote: { bid: 112.59375, ask: 112.609375, last: 112.59375, bidSize: 500, askSize: 500 }, // 112-19 bid, 112-19+ offered
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 6, avgCost: 112.640625, price: 112.59375, value: -281.25, unrealized: -281.25, notional: 675_562.50 }], // 3 sixty-fourths down x 15.625 x 6
        pnl: { account: { unrealized: -281.25, total: 1_147.75 } }, // 1,437.50 - 8.50 - 281.25
        nav: { account: 251_147.75, book: 1_001_147.75 },
        balance: { account: { positions: -281.25, assets: 251_147.75, netAssets: 251_147.75 } },
      },
    },
    {
      id: 'day-4-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-19'),
      expect: {
        // 112-18+ against 112-20+: 4 sixty-fourths down. 4 x 15.625 x 6 = 375.00 paid.
        events: [{ type: 'future.variation', summary: 'Variation margin paid on 6 TYH6: 375.00 USD (settlement 112.578125 vs 112.640625)', cash: { USD: -375 }, date: '2026-03-19' }],
        cash: { account: { USD: usd(237_854, 13_200) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 6, avgCost: 112.578125, price: 112.59375, value: 93.75, unrealized: 93.75 }], // one sixty-fourth x 15.625 x 6
        pnl: { account: { realized: 1_062.50, unrealized: 93.75, total: 1_147.75 } },
        balance: { account: { cash: 237_854, positions: 93.75 } },
      },
    },
    {
      id: 'last-trading-day', covers: 'final settlement', action: 'clock', to: AM('2026-03-20'),
      expect: { lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-20', status: 'blocked', reason: /^Awaiting the final settlement price for TYH6 \(2026-03-20\)/ }] },
    },
    // The final settlement price, 112-13+.
    { id: 'final-settlement-price', covers: 'final settlement', action: 'close_price', instrument: 'main', date: '2026-03-20', value: 112.421875, expect: {} },
    {
      id: 'expiry-physical-contract', covers: ['final settlement', 'expiry', 'physical delivery', 'margin release'], action: 'clock', to: EOD('2026-03-20'),
      expect: {
        // 112-13+ against 112-18+: 10 sixty-fourths down. 10 x 15.625 x 6 = 937.50 lost; margin 13,200 released; no fee.
        // The contract calls for delivery of notes; the Terminal closes it in cash and says that delivery is not simulated.
        events: [{ type: 'future.final_settlement', summary: 'Final settlement: 6 TYH6 closed in cash at 112.421875 (physical delivery is not simulated)', cash: { USD: 12_262.50 }, owner: 'account', date: '2026-03-20' }],
        // By hand: bought 8 at 112-16; sold 2 at 112-25+ (+19 sixty-fourths) and 6 at 112-13+ (-5): (2 x 19 - 6 x 5) x 15.625 = 125.00; commission 10 x 0.85 = 8.50.
        cash: { account: { USD: usd(250_116.50, 0) }, treasury: { USD: usd(750_000) } },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        pnl: { account: { realized: 125, commissions: -8.50, unrealized: 0, total: 116.50 } },
        nav: { account: 250_116.50, treasury: 750_000, book: 1_000_116.50 },
        balance: { account: { cash: 250_116.50, margin: null, positions: null, assets: 250_116.50, liabilities: 0, netAssets: 250_116.50 } },
      },
    },
    { id: 'monday', action: 'clock', to: AM('2026-03-23'), expect: {} },
    {
      id: 'trade-after-expiry', covers: 'expired contract', action: 'ticket', instrument: 'main', side: 'sell', qty: 1,
      status: 'blocked', reason: 'The contract\'s last trading day was 20 March 2026.',
      expect: { refused: 'TYH6 expired on 2026-03-20' },
    },
  ],
};

export default [equityIndexFuture, equityFuture, govBondFuture, treasuryFuture];
