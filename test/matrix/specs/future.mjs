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
//     fee, and its margin is released. A physically delivered contract whose deliverable is configured
//     (its Underlying is the deliverable asset; commodity_future here) is then delivered on paper: goods
//     received or given up at the invoice amount, labelled simulated. A physically delivered contract
//     without a configured deliverable, and every bond future (the deliverable basket, conversion factors
//     and accrued interest are not modelled), is closed out in cash and the Terminal says that delivery is
//     not simulated; a delivery notice on it is refused with that reason. A contract past that day
//     refuses trades.
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
      // Three of the five June contracts are closed; two are held to the last trading day.
      id: 'close-part', covers: ['reduce', 'margin release'], action: 'close', lot: 'lot', instrument: 'next', scope: 'strategy', percent: 60,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'next', qty: 3, estimate: 69.55, model: 'quoted-bid-ask', settleDate: '2026-04-08', notional: 208_650, initialMargin: -18_000, fees: 4.50 }], // 3 x 69.55 x 1,000; 3 x 6,000; 3 x 1.50
          cash: { USD: { purchases: 0, fees: 4.50, margin: 0, required: 4.50, available: 112_227.50, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 3, avgPrice: 69.55 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 3 CLM6 @ 69.55 (notional 208,650.00 USD; margin released 18,000.00 USD; realized 450.00 USD)', cash: { USD: 18_445.50 } }], // (69.55 - 69.40) x 3,000 = 450; 450 - 4.50 + 18,000
        cash: { account: { USD: usd(130_673, 12_000) } }, // 112,227.50 + 18,445.50
        positions: [{ instrument: 'next', lot: 'lot', owner: 'account', direction: 'long', qty: 2, avgCost: 69.40, cost: 0, price: 69.56, value: 320, unrealized: 320, notional: 139_120, margin: 12_000 }], // (69.56 - 69.40) x 2,000; 2 x 69.56 x 1,000
        holdings: { next: { long: 2, short: 0, net: 2 } },
        pnl: { account: { realized: -7_300, commissions: -27, unrealized: 320, total: -7_007 } }, // -7,750 + 450; 22.50 + 4.50
        nav: { account: 142_993, book: 992_993 }, // 130,673 + 12,000 + 320
        balance: { account: { cash: 130_673, margin: 12_000, positions: 320, assets: 142_993, netAssets: 142_993 } },
      },
    },
    { id: 'last-trading-day', action: 'clock', to: AM('2026-05-19'), expect: {} }, // Tuesday 19 May 2026, 10:00 New York
    {
      id: 'quote-last-day', action: 'quote', instrument: 'next', quote: { bid: 66.30, ask: 66.33, last: 66.31, bidSize: 300, askSize: 300 },
      expect: {
        positions: [{ instrument: 'next', lot: 'lot', owner: 'account', direction: 'long', qty: 2, avgCost: 69.40, cost: 0, price: 66.31, value: -6_180, unrealized: -6_180, notional: 132_620, margin: 12_000 }], // (66.31 - 69.40) x 2,000
        pnl: { account: { unrealized: -6_180, total: -13_507 } }, // -7,300 - 27 - 6,180
        nav: { account: 136_493, book: 986_493 },
        balance: { account: { positions: -6_180, assets: 136_493, netAssets: 136_493 } },
      },
    },
    { id: 'oil-quote-last-day', action: 'quote', instrument: 'oil', quote: { bid: 66.45, ask: 66.50, last: 66.48, bidSize: 1_000_000, askSize: 1_000_000 }, expect: {} },
    {
      // Invalid: the window is open (last trading day) but a long does not give notice; it takes delivery.
      id: 'request-delivery-long-side', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', instrument: 'next', body: { action: 'deliver', contracts: 2 },
      status: 'blocked', reason: 'Only the short side gives notice of delivery; the long takes delivery.',
      expect: { refused: 'Only the short side gives notice of delivery. This long CLM6 position takes delivery' },
    },
    {
      // Valid: held to the end of the last trading day, the two contracts are delivered (simulated) at the final settlement price 66.40.
      //   Close-out: (66.40 - 69.40) x 1,000 x 2 = -6,000.00 realized; margin 12,000.00 released; cash +6,000.00.
      //   Delivery: 2 x 1,000 = 2,000 barrels received at 66.40: invoice 2 x 1,000 x 66.40 = 132,800.00, owed T+2 = Thursday 21 May.
      id: 'expiry-delivery', covers: ['final settlement', 'expiry', 'physical delivery', 'margin release'], action: 'clock', to: EOD('2026-05-19'),
      expect: {
        events: [
          { type: 'future.final_settlement', summary: 'Final settlement: 2 CLM6 closed at 66.40 for simulated physical delivery', cash: { USD: 6_000 }, owner: 'account', date: '2026-05-19' },
          { type: 'future.delivery', summary: 'Simulated delivery (paper entry, no goods move): received 2,000 barrels WTI-CUSH on 2 CLM6 at 66.40; invoice 132,800.00 USD payable 2026-05-21', owner: 'account', date: '2026-05-19' },
        ],
        cash: { account: { USD: { settled: 136_673, unsettled: -132_800, reserved: 0, restricted: 0, margin: 0, availableToTrade: 3_873, availableToWithdraw: 3_873 } } }, // 130,673 + 6,000; 136,673 - 132,800
        positions: [{ instrument: 'oil', lot: 'lot', owner: 'account', direction: 'long', qty: 2_000, avgCost: 66.40, cost: 132_800, price: 66.48, value: 132_960, unrealized: 160 }], // 2,000 x 66.48; 132,960 - 132,800
        holdings: { next: null, oil: { long: 2_000, short: 0, net: 2_000 } },
        pending: [{ instrument: 'oil', lot: 'lot', owner: 'account', dueDate: '2026-05-21', amount: -132_800, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -13_300, unrealized: 160, total: -13_167 } }, // -7,300 - 6,000; -13,300 - 27 + 160
        nav: { account: 136_833, book: 986_833 }, // 136,673 + 132,960 - 132,800
        balance: { account: { cash: 136_673, margin: null, positions: 132_960, payable: 132_800, assets: 269_633, liabilities: 132_800, netAssets: 136_833 } },
      },
    },
    {
      // Invalid: the June position no longer exists (delivered).
      id: 'request-delivery-closed', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', instrument: 'next', body: { action: 'deliver', contracts: 2 },
      status: 'blocked', reason: 'The position has been delivered and is closed: there is nothing left to deliver.',
      expect: { refused: { engine: 'This CLM6 position is closed: it holds no contracts', api: 'This CLM6 position is closed: it holds no contracts', browser: 'lists no open CLM6 position' } },
    },
    {
      id: 'invoice-paid', covers: 'settlement', action: 'clock', to: AM('2026-05-21'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 132,800.00 USD from settled cash', cash: { USD: -132_800 }, owner: 'account', date: '2026-05-21' }],
        cash: { account: { USD: usd(3_873, 0) } }, // 136,673 - 132,800
        pending: [],
        balance: { account: { cash: 3_873, payable: null, assets: 136_833, liabilities: 0 } },
      },
    },
    {
      id: 'oil-quote', action: 'quote', instrument: 'oil', quote: { bid: 66.90, ask: 66.95, last: 66.92, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        positions: [{ instrument: 'oil', lot: 'lot', owner: 'account', direction: 'long', qty: 2_000, avgCost: 66.40, cost: 132_800, price: 66.92, value: 133_840, unrealized: 1_040 }], // 2,000 x 66.92
        pnl: { account: { unrealized: 1_040, total: -12_287 } }, // -13,300 - 27 + 1,040
        nav: { account: 137_713, book: 987_713 }, // 3,873 + 133,840
        balance: { account: { positions: 133_840, assets: 137_713, netAssets: 137_713 } },
      },
    },
    {
      // The delivered barrels are sold at the bid from the strategy instance: 2,000 x 66.90 = 133,800.00; commission
      // 2,000 x 0.01 = 20.00; realized (66.90 - 66.40) x 2,000 = 1,000.00. Settles T+2 on the US calendar: Thursday
      // 21 May + 2 business days, skipping Memorial Day (Monday 25 May) = Tuesday 26 May (checked by hand: the
      // scenario's standing lag is the futures' 0, hence settlementCheck false).
      id: 'sell-delivered-oil', covers: ['close', 'settlement'], action: 'close', lot: 'lot', instrument: 'oil', scope: 'position', settlementCheck: false,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'oil', qty: 2_000, estimate: 66.90, model: 'quoted-bid-ask', settleDate: '2026-05-26', cash: 133_800, fees: 20 }] },
        result: { orders: [{ action: 'sell', status: 'filled', filledQty: 2_000, avgPrice: 66.90 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2,000 WTI-CUSH @ 66.90 USD (realized 1,000.00 USD)', owner: 'account', date: '2026-05-21' }],
        cash: { account: { USD: { settled: 3_873, unsettled: 133_780, availableToTrade: 137_653, availableToWithdraw: 3_873 } } }, // 133,800 - 20
        positions: [],
        holdings: { oil: null },
        pending: [{ instrument: 'oil', lot: 'lot', owner: 'account', dueDate: '2026-05-26', amount: 133_780, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -12_300, commissions: -47, unrealized: 0, total: -12_347 } }, // -13,300 + 1,000; 27 + 20
        nav: { account: 137_653, book: 987_653 },
        balance: { account: { cash: 3_873, positions: null, receivable: 133_780, assets: 137_653, liabilities: 0, netAssets: 137_653 } },
      },
    },
    {
      // By hand, the whole scenario: May bought 71.22, sold 69.10: -2.12 x 5,000 = -10,600. June bought 68.83: 3 sold
      // at 69.55, 0.72 x 3,000 = 2,160; 2 delivered at 66.40, -2.43 x 2,000 = -4,860. Barrels bought 66.40, sold 66.90:
      // +1,000. Realized -12,300. Commission 18 contracts x 1.50 = 27 plus 20 = 47. 150,000 - 12,347 = 137,653.
      id: 'sale-settles', covers: 'settlement', action: 'clock', to: AM('2026-05-26'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 133,780.00 USD into settled cash', cash: { USD: 133_780 }, owner: 'account', date: '2026-05-26' }],
        cash: { account: { USD: usd(137_653, 0) }, treasury: { USD: usd(850_000) } },
        pending: [],
        nav: { account: 137_653, treasury: 850_000, book: 987_653 },
        balance: { account: { cash: 137_653, margin: null, positions: null, receivable: null, payable: null, assets: 137_653, liabilities: 0, netAssets: 137_653 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// volatility_future
// ---------------------------------------------------------------------------------------------
// Modelled on the Cboe VIX future: 1,000 USD an index point, minimum move 0.05 (50 USD), cash settled
// on a Wednesday morning (30 days before the third Friday of the following month: 18 March 2026 for
// the March contract) at a special opening quotation computed to two decimals. Initial margin 8,000
// USD a contract; commission 1.80 USD a contract.
// A short volatility position through a spike: the variation margin of the spike day is more than the
// Account's free cash. The Terminal pays it, leaves the Account's settled cash negative and raises a
// cash-deficit alert; it does not fund the Account by itself. A further order is refused while the
// deficit stands. The user then funds the Account from Treasury and the alert clears.
const volatilityFuture = {
  productId: 'volatility_future',
  title: 'Volatility index future (1,000 USD a point), March 2026, Cboe Futures Exchange, short through a spike',
  matrix: {
    ...FUTURES_TICKET,
    manualInputs: ['funding of a cash deficit after variation margin: a Treasury transfer made by the user (the Terminal never funds it by itself)'],
    settlement: 'No purchase cash; initial margin 8,000 USD a contract; daily variation margin at 1,000 USD a point; cash final settlement on the Wednesday',
    lifecycle: 'Daily variation margin (automatic), paid even when it exceeds free cash: settled cash goes negative and a cash-deficit alert is raised; cash final settlement at the special opening quotation (automatic)',
    accounting: 'Nil cost; variation margin and closes are realized P&L; a deficit is shown as negative settled cash, never as a silent loan or transfer; commission 1.80 USD a contract',
    collateral: 'Initial margin per contract; a variation call beyond free cash is a visible deficit; new orders are refused while it stands; the funding transfer creates no P&L',
  },
  start: AM('2026-03-12'),
  settlementCheck: { lag: 0, holidays: [] }, // US: no holiday between 12 and 19 March 2026
  book: book('Matrix volatility future', { funding: [{ ccy: 'USD', amount: 60_000 }], fee: { perUnit: 1.80, minimum: 0, bps: 0 } }),
  instruments: {
    main: { productId: 'volatility_future', name: 'Meridian Volatility Index future, March 2026', symbol: 'VXH6', marketView: 'US_DERIV', venue: 'Cboe Futures Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US',
      tradingCcy: 'USD', multiplier: 1000,
      terms: { root: 'VX', expiration: '2026-03-18', tickSize: 0.05, initialMargin: 8_000, settlement: 'cash', priceUnits: 'volatility index points' } },
  },
  quotes: { main: { bid: 17.45, ask: 17.50, last: 17.45, bidSize: 300, askSize: 300 } },
  closes: { main: { '2026-03-12': 17.10, '2026-03-13': 21.95, '2026-03-16': 19.40, '2026-03-17': 18.85 } },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: usd(60_000) }, treasury: { USD: usd(940_000) } },
    positions: [], lifecycle: [],
    nav: { account: 60_000, treasury: 940_000, book: 1_000_000 },
  },
  steps: [
    {
      id: 'open-short', covers: ['open short', 'initial margin'], action: 'ticket', instrument: 'main', side: 'sell', qty: 6, as: 'short',
      expect: {
        preview: { blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 6, estimate: 17.45, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-12', calendar: 'US',
            notional: 104_700, initialMargin: 48_000, fees: 10.80 }], // 6 x 17.45 x 1,000; 6 x 8,000; 6 x 1.80
          cash: { USD: { purchases: 0, fees: 10.80, margin: 48_000, required: 48_010.80, available: 60_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 6, avgPrice: 17.45 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Sold 6 VXH6 @ 17.45 (notional 104,700.00 USD; margin posted 48,000.00 USD)', cash: { USD: -48_010.80 }, owner: 'account', date: '2026-03-12' }],
        cash: { account: { USD: usd(11_989.20, 48_000) } },
        positions: [{ instrument: 'main', lot: 'short', owner: 'account', direction: 'short', qty: -6, avgCost: 17.45, cost: 0, price: 17.45, value: 0, unrealized: 0, notional: 104_700, margin: 48_000 }],
        holdings: { main: { long: 0, short: 6, net: -6 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-18', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -10.80, fees: 0, borrowFunding: 0, unrealized: 0, fx: 0, total: -10.80 } },
        nav: { account: 59_989.20, book: 999_989.20 },
        balance: { account: { cash: 11_989.20, margin: 48_000, positions: null, assets: 59_989.20, liabilities: 0, netAssets: 59_989.20 } },
      },
    },
    {
      id: 'day-1-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-12'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on -6 VXH6: 2,100.00 USD (settlement 17.10 vs 17.45)', cash: { USD: 2_100 }, date: '2026-03-12' }], // 0.35 x 1,000 x 6
        cash: { account: { USD: usd(14_089.20, 48_000) } },
        positions: [{ instrument: 'main', lot: 'short', qty: -6, avgCost: 17.10, price: 17.45, value: -2_100, unrealized: -2_100 }],
        pnl: { account: { realized: 2_100, unrealized: -2_100, total: -10.80 } },
        balance: { account: { cash: 14_089.20, positions: -2_100 } },
      },
    },
    { id: 'friday', action: 'clock', to: AM('2026-03-13'), expect: {} },
    {
      id: 'spike', action: 'quote', instrument: 'main', quote: { bid: 21.80, ask: 21.90, last: 21.85, bidSize: 300, askSize: 300 },
      expect: {
        positions: [{ instrument: 'main', lot: 'short', qty: -6, avgCost: 17.10, price: 21.85, value: -28_500, unrealized: -28_500, notional: 131_100 }], // (21.85 - 17.10) x 6,000 against the short
        pnl: { account: { unrealized: -28_500, total: -26_410.80 } }, // 2,100 - 10.80 - 28,500
        nav: { account: 33_589.20, book: 973_589.20 },
        balance: { account: { positions: -28_500, assets: 33_589.20, netAssets: 33_589.20 } },
      },
    },
    {
      id: 'variation-beyond-cash', covers: ['variation margin', 'margin shortfall'], action: 'clock', to: EOD('2026-03-13'),
      expect: {
        // Settlement 21.95 against 17.10: 4.85 x 1,000 x 6 = 29,100.00 to pay, with 14,089.20 of free cash.
        // The call is paid in full; settled cash is -15,010.80 and the deficit is reported. The 48,000 of margin stays posted.
        events: [{ type: 'future.variation', summary: 'Variation margin paid on -6 VXH6: 29,100.00 USD (settlement 21.95 vs 17.10)', cash: { USD: -29_100 }, date: '2026-03-13' }],
        cash: { account: { USD: usd(-15_010.80, 48_000) }, treasury: { USD: usd(940_000) } }, // Treasury is not touched
        positions: [{ instrument: 'main', lot: 'short', qty: -6, avgCost: 21.95, price: 21.85, value: 600, unrealized: 600 }], // (21.95 - 21.85) x 6,000
        alerts: ['margin.deficit'],
        borrowings: [], // no loan was created to cover it
        pnl: { account: { realized: -27_000, unrealized: 600, total: -26_410.80 } },
        balance: { account: { cash: -15_010.80, margin: 48_000, positions: 600, assets: 33_589.20, liabilities: 0, netAssets: 33_589.20 } },
      },
    },
    {
      // One more contract would need 8,000 of margin and 1.80 of commission, and the Account has -15,010.80: shortfall 23,012.60.
      id: 'order-while-in-deficit', covers: 'margin shortfall', action: 'ticket', instrument: 'main', side: 'sell', qty: 1,
      status: 'blocked', reason: 'The Account has a cash deficit: no further margin can be posted.',
      expect: { refused: /Alpha is short 23,012\.60 USD.*margin and collateral 8,000\.00 USD.*-15,010\.80 USD is available/s },
    },
    {
      id: 'fund-the-deficit', covers: ['margin shortfall', 'Treasury funding'], action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 40_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 40,000.00 USD from Treasury to Alpha', owner: 'treasury' }],
        cash: { account: { USD: usd(24_989.20, 48_000) }, treasury: { USD: usd(900_000) } },
        alerts: [], // the deficit is covered: the alert is gone at the next cycle
        nav: { account: 73_589.20, treasury: 900_000, book: 973_589.20 }, // funding moves net assets between owners; the Book is unchanged
        pnl: { account: { realized: -27_000, unrealized: 600, total: -26_410.80 } }, // a transfer is not P&L
        balance: { account: { cash: 24_989.20, assets: 73_589.20, netAssets: 73_589.20 } },
      },
    },
    { id: 'monday', action: 'clock', to: AM('2026-03-16'), expect: {} },
    {
      id: 'spike-fades', action: 'quote', instrument: 'main', quote: { bid: 19.60, ask: 19.70, last: 19.65, bidSize: 300, askSize: 300 },
      expect: {
        positions: [{ instrument: 'main', lot: 'short', qty: -6, avgCost: 21.95, price: 19.65, value: 13_800, unrealized: 13_800, notional: 117_900 }], // (21.95 - 19.65) x 6,000
        pnl: { account: { unrealized: 13_800, total: -13_210.80 } }, // -27,000 - 10.80 + 13,800
        nav: { account: 86_789.20, book: 986_789.20 },
        balance: { account: { positions: 13_800, assets: 86_789.20, netAssets: 86_789.20 } },
      },
    },
    {
      id: 'reduce', covers: ['reduce', 'margin release'], action: 'close', lot: 'short', scope: 'strategy', percent: 50, // buys back 3 of the 6
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 3, estimate: 19.70, model: 'quoted-bid-ask', settleDate: '2026-03-16',
          notional: 59_100, initialMargin: -24_000, fees: 5.40 }], // 3 x 19.70 (the ask) x 1,000
          cash: { USD: { purchases: 0, fees: 5.40, margin: 0, required: 5.40, available: 24_989.20, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 3, avgPrice: 19.70 }] },
        // Realized: (21.95 - 19.70) x 1,000 x 3 = 6,750.00. Cash: 6,750 - 5.40 + 24,000 = 30,744.60.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 3 VXH6 @ 19.70 (notional 59,100.00 USD; margin released 24,000.00 USD; realized 6,750.00 USD)', cash: { USD: 30_744.60 } }],
        cash: { account: { USD: usd(55_733.80, 24_000) } },
        positions: [{ instrument: 'main', lot: 'short', qty: -3, avgCost: 21.95, price: 19.65, value: 6_900, unrealized: 6_900, notional: 58_950, margin: 24_000 }],
        holdings: { main: { long: 0, short: 3, net: -3 } },
        pnl: { account: { realized: -20_250, commissions: -16.20, unrealized: 6_900, total: -13_366.20 } },
        nav: { account: 86_633.80, book: 986_633.80 },
        balance: { account: { cash: 55_733.80, margin: 24_000, positions: 6_900, assets: 86_633.80, netAssets: 86_633.80 } },
      },
    },
    {
      id: 'day-3-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-16'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on -3 VXH6: 7,650.00 USD (settlement 19.40 vs 21.95)', cash: { USD: 7_650 }, date: '2026-03-16' }], // 2.55 x 3,000
        cash: { account: { USD: usd(63_383.80, 24_000) } },
        positions: [{ instrument: 'main', lot: 'short', qty: -3, avgCost: 19.40, price: 19.65, value: -750, unrealized: -750 }],
        pnl: { account: { realized: -12_600, unrealized: -750, total: -13_366.20 } },
        balance: { account: { cash: 63_383.80, positions: -750 } },
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-03-17'), expect: {} },
    {
      id: 'quote-tuesday', action: 'quote', instrument: 'main', quote: { bid: 18.90, ask: 19.00, last: 18.95, bidSize: 300, askSize: 300 },
      expect: {
        positions: [{ instrument: 'main', lot: 'short', qty: -3, avgCost: 19.40, price: 18.95, value: 1_350, unrealized: 1_350, notional: 56_850 }], // (19.40 - 18.95) x 3,000
        pnl: { account: { unrealized: 1_350, total: -11_266.20 } }, // -12,600 - 16.20 + 1,350
        nav: { account: 88_733.80, book: 988_733.80 },
        balance: { account: { positions: 1_350, assets: 88_733.80, netAssets: 88_733.80 } },
      },
    },
    {
      id: 'day-4-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-17'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on -3 VXH6: 1,650.00 USD (settlement 18.85 vs 19.40)', cash: { USD: 1_650 }, date: '2026-03-17' }], // 0.55 x 3,000
        cash: { account: { USD: usd(65_033.80, 24_000) } },
        positions: [{ instrument: 'main', lot: 'short', qty: -3, avgCost: 18.85, price: 18.95, value: -300, unrealized: -300 }],
        pnl: { account: { realized: -10_950, unrealized: -300, total: -11_266.20 } },
        balance: { account: { cash: 65_033.80, positions: -300 } },
      },
    },
    {
      id: 'settlement-day', covers: 'final settlement', action: 'clock', to: AM('2026-03-18'),
      expect: { lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-18', status: 'blocked', reason: /^Awaiting the final settlement price for VXH6 \(2026-03-18\)/ }] },
    },
    // The final settlement value, a special opening quotation: 18.62 (not a multiple of the 0.05 tick).
    { id: 'final-settlement-value', covers: 'final settlement', action: 'close_price', instrument: 'main', date: '2026-03-18', value: 18.62, expect: {} },
    {
      id: 'expiry-cash-settlement', covers: ['final settlement', 'expiry', 'margin release'], action: 'clock', to: EOD('2026-03-18'),
      expect: {
        // Closed at 18.62 against the reference 18.85: 0.23 x 1,000 x 3 = 690.00 for the short; margin 24,000 released; no fee.
        events: [{ type: 'future.final_settlement', summary: /^Final settlement: 3 VXH6 closed in cash at 18\.62$/, cash: { USD: 24_690 }, owner: 'account', date: '2026-03-18' }],
        // By hand: sold 6 at 17.45; bought 3 at 19.70 and 3 at 18.62: (104.70 - 59.10 - 55.86) x 1,000 = -10,260.00. Commission 9 x 1.80 = 16.20.
        // Funded 60,000 + 40,000: 100,000 - 10,260 - 16.20 = 89,723.80.
        cash: { account: { USD: usd(89_723.80, 0) }, treasury: { USD: usd(900_000) } },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        pnl: { account: { realized: -10_260, commissions: -16.20, unrealized: 0, total: -10_276.20 } },
        nav: { account: 89_723.80, treasury: 900_000, book: 989_723.80 },
        balance: { account: { cash: 89_723.80, margin: null, positions: null, assets: 89_723.80, liabilities: 0, netAssets: 89_723.80 } },
      },
    },
    { id: 'thursday', action: 'clock', to: AM('2026-03-19'), expect: {} },
    {
      id: 'trade-after-expiry', covers: 'expired contract', action: 'ticket', instrument: 'main', side: 'buy', qty: 1,
      status: 'blocked', reason: 'The contract was settled on 18 March 2026.',
      expect: { refused: 'VXH6 expired on 2026-03-18' },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// dividend_future
// ---------------------------------------------------------------------------------------------
// Modelled on the CME S&P 500 Annual Dividend Index future: 250 USD an index point, minimum move
// 0.05 (12.50 USD). Its price is the dividends the index will have paid over the year, in index
// points; it is cash settled on the third Friday of December (18 December 2026) at the final value
// of the dividend index, which is not a tick price. Initial margin 1,100 USD a contract; commission
// 1.10 USD a contract. December 2026 is on standard time: 10:00 New York is 15:00 UTC.
const dividendFuture = {
  productId: 'dividend_future',
  title: 'Meridian 500 Annual Dividend Index future (250 USD a point), December 2026, CME',
  matrix: {
    ...FUTURES_TICKET,
    manualInputs: ['none: the final value of the dividend index is supplied as the close of the last trading day'],
    settlement: 'No purchase cash; initial margin 1,100 USD a contract; daily variation margin at 250 USD a dividend point; cash final settlement at the realized dividend index',
    lifecycle: 'Daily variation margin (automatic); cash final settlement on the third Friday of December (automatic); a contract past that day refuses trades',
    accounting: 'Nil cost; no dividend income is booked (the dividends are the price); variation margin and closes are realized P&L; commission 1.10 USD a contract',
    collateral: 'Initial margin per contract; released pro rata on reduction and at final settlement',
  },
  start: AM('2026-12-14', false),
  settlementCheck: { lag: 0, holidays: [] }, // US: no holiday between 14 and 21 December 2026
  book: book('Matrix dividend future', { funding: [{ ccy: 'USD', amount: 100_000 }], fee: { perUnit: 1.10, minimum: 0, bps: 0 } }),
  instruments: {
    main: { productId: 'dividend_future', name: 'Meridian 500 Annual Dividend Index future, December 2026', symbol: 'MDZ6', marketView: 'US_DERIV', venue: 'CME', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US',
      tradingCcy: 'USD', multiplier: 250,
      terms: { root: 'MD', expiration: '2026-12-18', tickSize: 0.05, initialMargin: 1_100, settlement: 'cash', priceUnits: 'index points of dividends' } },
  },
  quotes: { main: { bid: 78.40, ask: 78.45, last: 78.40, bidSize: 500, askSize: 500 } },
  closes: { main: { '2026-12-14': 78.50, '2026-12-15': 78.65, '2026-12-16': 78.70, '2026-12-17': 78.75 } },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: usd(100_000) }, treasury: { USD: usd(900_000) } },
    positions: [], lifecycle: [],
    nav: { account: 100_000, treasury: 900_000, book: 1_000_000 },
  },
  steps: [
    {
      id: 'open', covers: ['open', 'initial margin'], action: 'ticket', instrument: 'main', side: 'buy', qty: 20, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 20, estimate: 78.45, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-12-14', calendar: 'US',
            notional: 392_250, initialMargin: 22_000, fees: 22 }], // 20 x 78.45 x 250; 20 x 1,100; 20 x 1.10
          cash: { USD: { purchases: 0, fees: 22, margin: 22_000, required: 22_022, available: 100_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20, avgPrice: 78.45 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 20 MDZ6 @ 78.45 (notional 392,250.00 USD; margin posted 22,000.00 USD)', cash: { USD: -22_022 }, owner: 'account', date: '2026-12-14' }],
        cash: { account: { USD: usd(77_978, 22_000) } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 20, avgCost: 78.45, cost: 0, price: 78.40, value: -250, unrealized: -250, notional: 392_000, margin: 22_000 }], // -0.05 x 250 x 20; 20 x 78.40 x 250
        holdings: { main: { long: 20, short: 0, net: 20 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-12-18', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -22, fees: 0, borrowFunding: 0, unrealized: -250, fx: 0, total: -272 } },
        nav: { account: 99_728, book: 999_728 },
        balance: { account: { cash: 77_978, margin: 22_000, positions: -250, assets: 99_728, liabilities: 0, netAssets: 99_728 } },
      },
    },
    {
      id: 'day-1-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-12-14', false),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on 20 MDZ6: 250.00 USD (settlement 78.50 vs 78.45)', cash: { USD: 250 }, date: '2026-12-14' }], // 0.05 x 250 x 20
        cash: { account: { USD: usd(78_228, 22_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 20, avgCost: 78.50, price: 78.40, value: -500, unrealized: -500 }],
        pnl: { account: { realized: 250, unrealized: -500, total: -272 } },
        balance: { account: { cash: 78_228, positions: -500 } },
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-12-15', false), expect: {} },
    {
      id: 'quote-tuesday', action: 'quote', instrument: 'main', quote: { bid: 78.55, ask: 78.60, last: 78.60, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 20, avgCost: 78.50, price: 78.60, value: 500, unrealized: 500, notional: 393_000 }], // 0.10 x 5,000
        pnl: { account: { unrealized: 500, total: 728 } }, // 250 - 22 + 500
        nav: { account: 100_728, book: 1_000_728 },
        balance: { account: { positions: 500, assets: 100_728, netAssets: 100_728 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 20 -> 30
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 10, estimate: 78.60, model: 'quoted-bid-ask', settleDate: '2026-12-15',
          notional: 196_500, initialMargin: 11_000, fees: 11 }], // 10 x 78.60 x 250
          cash: { USD: { purchases: 0, fees: 11, margin: 11_000, required: 11_011, available: 78_228, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 10, avgPrice: 78.60 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 10 MDZ6 @ 78.60 (notional 196,500.00 USD; margin posted 11,000.00 USD)', cash: { USD: -11_011 } }],
        cash: { account: { USD: usd(67_217, 33_000) } },
        // Reference: (20 x 78.50 + 10 x 78.60) / 30 = 78.533333. Value: 20 x 0.10 x 250 = 500 (the 10 new ones are at their reference).
        positions: [{ instrument: 'main', lot: 'lot', qty: 30, avgCost: 78.533333, price: 78.60, value: 500, unrealized: 500, notional: 589_500, margin: 33_000 }],
        holdings: { main: { long: 30, short: 0, net: 30 } },
        pnl: { account: { commissions: -33, total: 717 } },
        nav: { account: 100_717, book: 1_000_717 },
        balance: { account: { cash: 67_217, margin: 33_000, assets: 100_717, netAssets: 100_717 } },
      },
    },
    {
      id: 'day-2-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-12-15', false),
      expect: {
        // 30 x 78.65 x 250 = 589,875 against 20 x 78.50 x 250 + 10 x 78.60 x 250 = 589,000: 875.00 received.
        events: [{ type: 'future.variation', summary: 'Variation margin received on 30 MDZ6: 875.00 USD (settlement 78.65 vs 78.533333)', cash: { USD: 875 }, date: '2026-12-15' }],
        cash: { account: { USD: usd(68_092, 33_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 30, avgCost: 78.65, price: 78.60, value: -375, unrealized: -375 }], // -0.05 x 7,500
        pnl: { account: { realized: 1_125, unrealized: -375, total: 717 } },
        balance: { account: { cash: 68_092, positions: -375 } },
      },
    },
    { id: 'wednesday', action: 'clock', to: AM('2026-12-16', false), expect: {} },
    {
      id: 'quote-wednesday', action: 'quote', instrument: 'main', quote: { bid: 78.70, ask: 78.75, last: 78.70, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 30, avgCost: 78.65, price: 78.70, value: 375, unrealized: 375, notional: 590_250 }],
        pnl: { account: { unrealized: 375, total: 1_467 } }, // 1,125 - 33 + 375
        nav: { account: 101_467, book: 1_001_467 },
        balance: { account: { positions: 375, assets: 101_467, netAssets: 101_467 } },
      },
    },
    {
      id: 'reduce', covers: ['reduce', 'margin release'], action: 'close', lot: 'lot', scope: 'strategy', percent: 40, // sells 12 of the 30
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 12, estimate: 78.70, model: 'quoted-bid-ask', settleDate: '2026-12-16',
          notional: 236_100, initialMargin: -13_200, fees: 13.20 }], // 12 x 78.70 x 250
          cash: { USD: { purchases: 0, fees: 13.20, margin: 0, required: 13.20, available: 68_092, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 12, avgPrice: 78.70 }] },
        // Realized: (78.70 - 78.65) x 250 x 12 = 150.00. Cash: 150 - 13.20 + 13,200 = 13,336.80.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 12 MDZ6 @ 78.70 (notional 236,100.00 USD; margin released 13,200.00 USD; realized 150.00 USD)', cash: { USD: 13_336.80 } }],
        cash: { account: { USD: usd(81_428.80, 19_800) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 18, avgCost: 78.65, price: 78.70, value: 225, unrealized: 225, notional: 354_150, margin: 19_800 }], // 0.05 x 250 x 18
        holdings: { main: { long: 18, short: 0, net: 18 } },
        pnl: { account: { realized: 1_275, commissions: -46.20, unrealized: 225, total: 1_453.80 } },
        nav: { account: 101_453.80, book: 1_001_453.80 },
        balance: { account: { cash: 81_428.80, margin: 19_800, positions: 225, assets: 101_453.80, netAssets: 101_453.80 } },
      },
    },
    {
      id: 'day-3-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-12-16', false),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on 18 MDZ6: 225.00 USD (settlement 78.70 vs 78.65)', cash: { USD: 225 }, date: '2026-12-16' }],
        cash: { account: { USD: usd(81_653.80, 19_800) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 18, avgCost: 78.70, price: 78.70, value: 0, unrealized: 0 }],
        pnl: { account: { realized: 1_500, unrealized: 0, total: 1_453.80 } },
        balance: { account: { cash: 81_653.80, positions: null } },
      },
    },
    { id: 'thursday', action: 'clock', to: AM('2026-12-17', false), expect: {} },
    {
      id: 'quote-thursday', action: 'quote', instrument: 'main', quote: { bid: 78.75, ask: 78.80, last: 78.75, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 18, avgCost: 78.70, price: 78.75, value: 225, unrealized: 225, notional: 354_375 }],
        pnl: { account: { unrealized: 225, total: 1_678.80 } },
        nav: { account: 101_678.80, book: 1_001_678.80 },
        balance: { account: { positions: 225, assets: 101_678.80, netAssets: 101_678.80 } },
      },
    },
    {
      id: 'day-4-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-12-17', false),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on 18 MDZ6: 225.00 USD (settlement 78.75 vs 78.70)', cash: { USD: 225 }, date: '2026-12-17' }],
        cash: { account: { USD: usd(81_878.80, 19_800) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 18, avgCost: 78.75, price: 78.75, value: 0, unrealized: 0 }],
        pnl: { account: { realized: 1_725, unrealized: 0, total: 1_678.80 } },
        balance: { account: { cash: 81_878.80, positions: null } },
      },
    },
    {
      id: 'last-trading-day', covers: 'final settlement', action: 'clock', to: AM('2026-12-18', false),
      expect: { lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-12-18', status: 'blocked', reason: /^Awaiting the final settlement price for MDZ6 \(2026-12-18\)/ }] },
    },
    // The dividend index for the year ends at 78.82 points.
    { id: 'final-dividend-index', covers: 'final settlement', action: 'close_price', instrument: 'main', date: '2026-12-18', value: 78.82, expect: {} },
    {
      id: 'expiry-cash-settlement', covers: ['final settlement', 'expiry', 'margin release'], action: 'clock', to: EOD('2026-12-18', false),
      expect: {
        // Closed at 78.82 against the reference 78.75: 0.07 x 250 x 18 = 315.00; margin 19,800 released; no fee.
        events: [{ type: 'future.final_settlement', summary: /^Final settlement: 18 MDZ6 closed in cash at 78\.82$/, cash: { USD: 20_115 }, owner: 'account', date: '2026-12-18' }],
        // By hand: bought 20 at 78.45 and 10 at 78.60; sold 12 at 78.70, 18 settled at 78.82: (944.40 + 1,418.76 - 1,569.00 - 786.00) x 250 = 2,040.00.
        // Commission 42 contracts x 1.10 = 46.20. 100,000 + 2,040 - 46.20 = 101,993.80.
        cash: { account: { USD: usd(101_993.80, 0) }, treasury: { USD: usd(900_000) } },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        pnl: { account: { realized: 2_040, dividends: 0, commissions: -46.20, unrealized: 0, total: 1_993.80 } },
        nav: { account: 101_993.80, treasury: 900_000, book: 1_001_993.80 },
        balance: { account: { cash: 101_993.80, margin: null, positions: null, assets: 101_993.80, liabilities: 0, netAssets: 101_993.80 } },
      },
    },
    { id: 'monday', action: 'clock', to: AM('2026-12-21', false), expect: {} },
    {
      id: 'trade-after-expiry', covers: 'expired contract', action: 'ticket', instrument: 'main', side: 'buy', qty: 1,
      status: 'blocked', reason: 'The contract was settled on 18 December 2026.',
      expect: { refused: 'MDZ6 expired on 2026-12-18' },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// crypto_future
// ---------------------------------------------------------------------------------------------
// Modelled on the CME Bitcoin future: 5 bitcoin a contract, quoted in USD a bitcoin, minimum move
// 5.00 (25 USD a contract), cash settled on the last Friday of the month (27 March 2026) at a
// reference rate computed to the cent, which is not a tick price. One contract is about a third of a
// million dollars and its initial margin is 95,000 USD: the margin check is what limits the size.
// Commission 6.00 USD a contract.
const cryptoFuture = {
  productId: 'crypto_future',
  title: 'Bitcoin future (5 BTC, cash settled to a reference rate), March 2026, CME',
  matrix: {
    ...FUTURES_TICKET,
    manualInputs: ['none: the final reference rate is supplied as the close of the last trading day'],
    settlement: 'No purchase cash and no bitcoin: initial margin 95,000 USD a contract; daily variation margin at 5 USD a dollar of price; cash final settlement at the reference rate',
    lifecycle: 'Daily variation margin on exchange business days (automatic); cash final settlement on the last Friday of the month (automatic); a contract past that day refuses trades',
    accounting: 'Nil cost; no digital asset is held; variation margin and closes are realized P&L; commission 6.00 USD a contract',
    collateral: 'Initial margin per contract; an order whose margin is not covered by free cash is refused',
  },
  start: AM('2026-03-23'),
  settlementCheck: { lag: 0, holidays: [] }, // US: no holiday between 23 and 30 March 2026
  book: book('Matrix cryptocurrency future', { funding: [{ ccy: 'USD', amount: 400_000 }], fee: { perUnit: 6, minimum: 0, bps: 0 } }),
  instruments: {
    main: { productId: 'crypto_future', name: 'Bitcoin future, March 2026', symbol: 'BTCH6', marketView: 'US_DERIV', venue: 'CME', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'Global',
      tradingCcy: 'USD', multiplier: 5,
      terms: { root: 'BTC', expiration: '2026-03-27', tickSize: 5, initialMargin: 95_000, settlement: 'cash', priceUnits: 'USD per bitcoin' } },
  },
  quotes: { main: { bid: 68_250, ask: 68_255, last: 68_250, bidSize: 50, askSize: 50 } },
  closes: { main: { '2026-03-23': 67_480, '2026-03-24': 69_120, '2026-03-25': 70_150, '2026-03-26': 69_790 } },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: usd(400_000) }, treasury: { USD: usd(600_000) } },
    positions: [], lifecycle: [],
    nav: { account: 400_000, treasury: 600_000, book: 1_000_000 },
  },
  steps: [
    {
      id: 'open', covers: ['open', 'initial margin'], action: 'ticket', instrument: 'main', side: 'buy', qty: 1, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1, estimate: 68_255, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-23', calendar: 'US',
            notional: 341_275, initialMargin: 95_000, fees: 6 }], // 1 x 68,255 x 5 bitcoin
          cash: { USD: { purchases: 0, fees: 6, margin: 95_000, required: 95_006, available: 400_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1, avgPrice: 68_255 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 BTCH6 @ 68,255.00 (notional 341,275.00 USD; margin posted 95,000.00 USD)', cash: { USD: -95_006 }, owner: 'account', date: '2026-03-23' }],
        cash: { account: { USD: usd(304_994, 95_000) } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1, avgCost: 68_255, cost: 0, price: 68_250, value: -25, unrealized: -25, notional: 341_250, margin: 95_000 }], // -5 x 5
        holdings: { main: { long: 1, short: 0, net: 1 } },
        lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-27', status: 'pending' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -6, fees: 0, borrowFunding: 0, unrealized: -25, fx: 0, total: -31 } },
        nav: { account: 399_969, book: 999_969 },
        balance: { account: { cash: 304_994, margin: 95_000, positions: -25, assets: 399_969, liabilities: 0, netAssets: 399_969 } },
      },
    },
    {
      id: 'day-1-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-23'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin paid on 1 BTCH6: 3,875.00 USD (settlement 67,480.00 vs 68,255.00)', cash: { USD: -3_875 }, date: '2026-03-23' }], // -775 x 5
        cash: { account: { USD: usd(301_119, 95_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1, avgCost: 67_480, price: 68_250, value: 3_850, unrealized: 3_850 }], // 770 x 5
        pnl: { account: { realized: -3_875, unrealized: 3_850, total: -31 } },
        balance: { account: { cash: 301_119, positions: 3_850 } },
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-03-24'), expect: {} },
    {
      id: 'quote-tuesday', action: 'quote', instrument: 'main', quote: { bid: 66_900, ask: 66_905, last: 66_900, bidSize: 50, askSize: 50 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1, avgCost: 67_480, price: 66_900, value: -2_900, unrealized: -2_900, notional: 334_500 }], // -580 x 5
        pnl: { account: { unrealized: -2_900, total: -6_781 } }, // -3,875 - 6 - 2,900
        nav: { account: 393_219, book: 993_219 },
        balance: { account: { positions: -2_900, assets: 393_219, netAssets: 393_219 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 2, // 1 -> 2
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1, estimate: 66_905, model: 'quoted-bid-ask', settleDate: '2026-03-24',
          notional: 334_525, initialMargin: 95_000, fees: 6 }],
          cash: { USD: { purchases: 0, fees: 6, margin: 95_000, required: 95_006, available: 301_119, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1, avgPrice: 66_905 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 1 BTCH6 @ 66,905.00 (notional 334,525.00 USD; margin posted 95,000.00 USD)', cash: { USD: -95_006 } }],
        cash: { account: { USD: usd(206_113, 190_000) } },
        // Reference: (67,480 + 66,905) / 2 = 67,192.50. Value: (66,900 - 67,192.50) x 5 x 2 = -2,925.
        positions: [{ instrument: 'main', lot: 'lot', qty: 2, avgCost: 67_192.50, price: 66_900, value: -2_925, unrealized: -2_925, notional: 669_000, margin: 190_000 }],
        holdings: { main: { long: 2, short: 0, net: 2 } },
        pnl: { account: { commissions: -12, unrealized: -2_925, total: -6_812 } },
        nav: { account: 393_188, book: 993_188 },
        balance: { account: { cash: 206_113, margin: 190_000, positions: -2_925, assets: 393_188, netAssets: 393_188 } },
      },
    },
    {
      id: 'day-2-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-24'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on 2 BTCH6: 19,275.00 USD (settlement 69,120.00 vs 67,192.50)', cash: { USD: 19_275 }, date: '2026-03-24' }], // 1,927.50 x 5 x 2
        cash: { account: { USD: usd(225_388, 190_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2, avgCost: 69_120, price: 66_900, value: -22_200, unrealized: -22_200 }], // -2,220 x 10
        pnl: { account: { realized: 15_400, unrealized: -22_200, total: -6_812 } },
        balance: { account: { cash: 225_388, positions: -22_200 } },
      },
    },
    { id: 'wednesday', action: 'clock', to: AM('2026-03-25'), expect: {} },
    {
      id: 'quote-wednesday', action: 'quote', instrument: 'main', quote: { bid: 70_400, ask: 70_405, last: 70_400, bidSize: 50, askSize: 50 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2, avgCost: 69_120, price: 70_400, value: 12_800, unrealized: 12_800, notional: 704_000 }], // 1,280 x 10
        pnl: { account: { unrealized: 12_800, total: 28_188 } }, // 15,400 - 12 + 12,800
        nav: { account: 428_188, book: 1_028_188 },
        balance: { account: { positions: 12_800, assets: 428_188, netAssets: 428_188 } },
      },
    },
    {
      // 3 more would need 285,000 of margin and 18.00 of commission; 225,388 is free although net assets are 428,188. Shortfall 59,630.
      id: 'order-beyond-margin', covers: 'margin shortfall', action: 'ticket', instrument: 'main', side: 'buy', qty: 3,
      status: 'blocked', reason: 'Margin already posted and open trade equity are not free cash: the order is refused, not funded.',
      expect: { refused: /Alpha is short 59,630\.00 USD.*margin and collateral 285,000\.00 USD.*225,388\.00 USD is available/s },
    },
    {
      id: 'reduce', covers: ['reduce', 'margin release'], action: 'close', lot: 'lot', scope: 'strategy', percent: 50, // sells 1 of the 2
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 1, estimate: 70_400, model: 'quoted-bid-ask', settleDate: '2026-03-25',
          notional: 352_000, initialMargin: -95_000, fees: 6 }],
          cash: { USD: { purchases: 0, fees: 6, margin: 0, required: 6, available: 225_388, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1, avgPrice: 70_400 }] },
        // Realized: (70,400 - 69,120) x 5 = 6,400.00. Cash: 6,400 - 6 + 95,000 = 101,394.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 BTCH6 @ 70,400.00 (notional 352,000.00 USD; margin released 95,000.00 USD; realized 6,400.00 USD)', cash: { USD: 101_394 } }],
        cash: { account: { USD: usd(326_782, 95_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1, avgCost: 69_120, price: 70_400, value: 6_400, unrealized: 6_400, notional: 352_000, margin: 95_000 }],
        holdings: { main: { long: 1, short: 0, net: 1 } },
        pnl: { account: { realized: 21_800, commissions: -18, unrealized: 6_400, total: 28_182 } },
        nav: { account: 428_182, book: 1_028_182 },
        balance: { account: { cash: 326_782, margin: 95_000, positions: 6_400, assets: 428_182, netAssets: 428_182 } },
      },
    },
    {
      id: 'day-3-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-25'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin received on 1 BTCH6: 5,150.00 USD (settlement 70,150.00 vs 69,120.00)', cash: { USD: 5_150 }, date: '2026-03-25' }], // 1,030 x 5
        cash: { account: { USD: usd(331_932, 95_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1, avgCost: 70_150, price: 70_400, value: 1_250, unrealized: 1_250 }],
        pnl: { account: { realized: 26_950, unrealized: 1_250, total: 28_182 } },
        balance: { account: { cash: 331_932, positions: 1_250 } },
      },
    },
    { id: 'thursday', action: 'clock', to: AM('2026-03-26'), expect: {} },
    {
      id: 'quote-thursday', action: 'quote', instrument: 'main', quote: { bid: 69_800, ask: 69_805, last: 69_800, bidSize: 50, askSize: 50 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1, avgCost: 70_150, price: 69_800, value: -1_750, unrealized: -1_750, notional: 349_000 }], // -350 x 5
        pnl: { account: { unrealized: -1_750, total: 25_182 } }, // 26,950 - 18 - 1,750
        nav: { account: 425_182, book: 1_025_182 },
        balance: { account: { positions: -1_750, assets: 425_182, netAssets: 425_182 } },
      },
    },
    {
      id: 'day-4-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-26'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin paid on 1 BTCH6: 1,800.00 USD (settlement 69,790.00 vs 70,150.00)', cash: { USD: -1_800 }, date: '2026-03-26' }], // -360 x 5
        cash: { account: { USD: usd(330_132, 95_000) } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1, avgCost: 69_790, price: 69_800, value: 50, unrealized: 50 }],
        pnl: { account: { realized: 25_150, unrealized: 50, total: 25_182 } },
        balance: { account: { cash: 330_132, positions: 50 } },
      },
    },
    {
      id: 'last-trading-day', covers: 'final settlement', action: 'clock', to: AM('2026-03-27'),
      expect: { lifecycle: [{ type: 'future.expiry', instrument: 'main', dueDate: '2026-03-27', status: 'blocked', reason: /^Awaiting the final settlement price for BTCH6 \(2026-03-27\)/ }] },
    },
    // The reference rate at 4 p.m. London on the last Friday of March: 69,512.37 USD.
    { id: 'final-reference-rate', covers: 'final settlement', action: 'close_price', instrument: 'main', date: '2026-03-27', value: 69_512.37, expect: {} },
    {
      id: 'expiry-cash-settlement', covers: ['final settlement', 'expiry', 'margin release'], action: 'clock', to: EOD('2026-03-27'),
      expect: {
        // Closed at 69,512.37 against the reference 69,790: -277.63 x 5 = -1,388.15; margin 95,000 released; no fee.
        events: [{ type: 'future.final_settlement', summary: /^Final settlement: 1 BTCH6 closed in cash at 69,512\.37$/, cash: { USD: 93_611.85 }, owner: 'account', date: '2026-03-27' }],
        // By hand: bought at 68,255 and 66,905; sold at 70,400 and settled at 69,512.37: 4,752.37 x 5 = 23,761.85. Commission 3 x 6 = 18.
        cash: { account: { USD: usd(423_743.85, 0) }, treasury: { USD: usd(600_000) } },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        pnl: { account: { realized: 23_761.85, commissions: -18, unrealized: 0, total: 23_743.85 } },
        nav: { account: 423_743.85, treasury: 600_000, book: 1_023_743.85 },
        balance: { account: { cash: 423_743.85, margin: null, positions: null, assets: 423_743.85, liabilities: 0, netAssets: 423_743.85 } },
      },
    },
    { id: 'monday', action: 'clock', to: AM('2026-03-30'), expect: {} },
    {
      id: 'trade-after-expiry', covers: 'expired contract', action: 'ticket', instrument: 'main', side: 'buy', qty: 1,
      status: 'blocked', reason: 'The contract was settled on 27 March 2026.',
      expect: { refused: 'BTCH6 expired on 2026-03-27' },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// perpetual_future
// ---------------------------------------------------------------------------------------------
// A linear bitcoin perpetual on an offshore venue: 0.1 bitcoin a contract, quoted in USD a bitcoin,
// minimum move 0.50 (0.05 USD a contract). It never expires. Longs and shorts exchange a funding
// payment every eight hours (00:00, 08:00 and 16:00 UTC): the funding rate times the position's
// notional; with a positive rate longs pay shorts. The catalog says funding is recorded by hand:
// each payment here is entered as a manual cash flow of kind "Funding expense" on the position.
// The venue trades every day, so the contract's trading and settlement calendars are set to the
// every-day calendar and the scenario starts on a Saturday. The Terminal's end-of-day pass still runs
// on US business days only: nothing is settled over the weekend, and Monday's variation margin is
// against the fill. Initial margin 700 USD a contract (ten times leverage); commission 5 basis points
// of the contract value, the venue's taker fee, rather than an amount per contract.
const perpetualFuture = {
  productId: 'perpetual_future',
  title: 'Bitcoin / US dollar perpetual future (0.1 BTC, funding recorded by hand), traded every day',
  matrix: {
    ...FUTURES_TICKET,
    manualInputs: ['each funding payment, recorded by hand: strategy instance, the position\'s Lifecycle menu, Manual cash flow, kind "Funding expense" (negative when paid, positive when received)'],
    settlement: 'No purchase cash; initial margin 700 USD a contract; variation margin at each end-of-day pass (US business days); no expiry and no final settlement',
    lifecycle: 'Variation margin (automatic, not on weekends); funding payments are not generated and are recorded by hand; no expiry item exists; closes like any future',
    accounting: 'Nil cost; variation margin and closes are realized P&L; funding paid and received under borrowing and funding expenses; commission 5 basis points of contract value',
    collateral: 'Initial margin per contract; released pro rata on reduction and close',
  },
  start: '2026-03-14T15:00:00.000Z', // Saturday 14 March 2026, 11:00 New York
  settlementCheck: { lag: 0, holidays: [] },
  book: book('Matrix perpetual future', { funding: [{ ccy: 'USD', amount: 100_000 }], fee: { perUnit: 0, minimum: 0, bps: 5 } }),
  instruments: {
    main: { productId: 'perpetual_future', name: 'Bitcoin / US dollar perpetual future', symbol: 'BTCP', marketView: 'FOREIGN_DERIV', venue: 'Meridian Digital Derivatives', venueType: 'exchange', venueCountry: 'SC', underlyingGeo: 'Global',
      tradingCcy: 'USD', multiplier: 0.1, conventions: { tradingCalendar: 'ALLDAYS', settlementCalendar: 'ALLDAYS' },
      terms: { root: 'BTCP', perpetual: true, tickSize: 0.5, initialMargin: 700, settlement: 'cash', priceUnits: 'USD per bitcoin' } },
  },
  quotes: { main: { bid: 69_000, ask: 69_000.5, last: 69_000, bidSize: 5000, askSize: 5000 } },
  closes: { main: { '2026-03-16': 70_150, '2026-03-17': 70_420 } },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: usd(100_000) }, treasury: { USD: usd(900_000) } },
    positions: [], lifecycle: [],
    nav: { account: 100_000, treasury: 900_000, book: 1_000_000 },
  },
  steps: [
    {
      id: 'open-on-saturday', covers: ['open', 'initial margin', 'weekend trading'], action: 'ticket', instrument: 'main', side: 'buy', qty: 50, as: 'long',
      expect: {
        preview: { blocking: 0, errors: [], notes: ['support'], // the preview states that funding payments are recorded by hand and that there is no expiry
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 50, estimate: 69_000.5, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-14', calendar: 'ALLDAYS',
            notional: 345_002.50, initialMargin: 35_000, fees: 172.50 }], // 50 x 69,000.50 x 0.1; 50 x 700; 5 bp of 345,002.50 = 172.50125
          cash: { USD: { purchases: 0, fees: 172.50, margin: 35_000, required: 35_172.50, available: 100_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 50, avgPrice: 69_000.5 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 50 BTCP @ 69,000.50 (notional 345,002.50 USD; margin posted 35,000.00 USD)', cash: { USD: -35_172.50 }, owner: 'account', date: '2026-03-14' }],
        cash: { account: { USD: usd(64_827.50, 35_000) } },
        positions: [{ instrument: 'main', lot: 'long', owner: 'account', direction: 'long', qty: 50, avgCost: 69_000.5, cost: 0, price: 69_000, value: -2.50, unrealized: -2.50, notional: 345_000, margin: 35_000 }], // -0.50 x 0.1 x 50
        holdings: { main: { long: 50, short: 0, net: 50 } },
        lifecycle: [], // a perpetual has no expiry item
        pnl: { account: { realized: 0, dividends: 0, commissions: -172.50, fees: 0, borrowFunding: 0, unrealized: -2.50, fx: 0, total: -175 } },
        nav: { account: 99_825, book: 999_825 },
        balance: { account: { cash: 64_827.50, margin: 35_000, positions: -2.50, assets: 99_825, liabilities: 0, netAssets: 99_825 } },
      },
    },
    { id: 'saturday-funding-time', action: 'clock', to: '2026-03-14T16:05:00.000Z', expect: {} },
    {
      // 16:00 UTC funding at +0.0100%: the long pays 0.0001 x 345,000 (50 x 0.1 x 69,000) = 34.50.
      id: 'funding-paid', covers: 'funding payment', action: 'cashflow', lot: 'long', category: 'funding', amount: -34.50, note: 'Funding at 16:00 UTC: 0.0100% of 345,000.00 notional, longs pay',
      expect: {
        events: [{ type: 'manual.cashflow', summary: 'Manual funding on BTCP: paid 34.50 USD. Funding at 16:00 UTC: 0.0100% of 345,000.00 notional, longs pay', cash: { USD: -34.50 }, owner: 'account', date: '2026-03-14' }],
        cash: { account: { USD: usd(64_793, 35_000) } },
        pnl: { account: { borrowFunding: -34.50, total: -209.50 } },
        nav: { account: 99_790.50, book: 999_790.50 },
        balance: { account: { cash: 64_793, assets: 99_790.50, netAssets: 99_790.50 } },
      },
    },
    {
      // Sunday. No end-of-day pass has run since Friday: nothing is settled over the weekend.
      id: 'sunday', covers: 'weekend, no end-of-day pass', action: 'clock', to: '2026-03-15T22:00:00.000Z',
      expect: { events: [] },
    },
    {
      id: 'sunday-quote', action: 'quote', instrument: 'main', quote: { bid: 70_200, ask: 70_200.5, last: 70_200, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'long', qty: 50, avgCost: 69_000.5, price: 70_200, value: 5_997.50, unrealized: 5_997.50, notional: 351_000 }], // 1,199.50 x 0.1 x 50; 50 x 0.1 x 70,200
        pnl: { account: { unrealized: 5_997.50, total: 5_790.50 } }, // -172.50 - 34.50 + 5,997.50
        nav: { account: 105_790.50, book: 1_005_790.50 },
        balance: { account: { positions: 5_997.50, assets: 105_790.50, netAssets: 105_790.50 } },
      },
    },
    {
      // A negative funding rate, -0.0050%: shorts pay longs. The long receives 0.00005 x 351,000 = 17.55.
      id: 'funding-received', covers: 'funding payment', action: 'cashflow', lot: 'long', category: 'funding', amount: 17.55, note: 'Funding at 16:00 UTC: -0.0050% of 351,000.00 notional, shorts pay',
      expect: {
        events: [{ type: 'manual.cashflow', summary: 'Manual funding on BTCP: received 17.55 USD. Funding at 16:00 UTC: -0.0050% of 351,000.00 notional, shorts pay', cash: { USD: 17.55 }, date: '2026-03-15' }],
        cash: { account: { USD: usd(64_810.55, 35_000) } },
        pnl: { account: { borrowFunding: -16.95, total: 5_808.05 } }, // -34.50 + 17.55
        nav: { account: 105_808.05, book: 1_005_808.05 },
        balance: { account: { cash: 64_810.55, assets: 105_808.05, netAssets: 105_808.05 } },
      },
    },
    {
      id: 'monday-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-16'),
      expect: {
        // The first pass since the Saturday fill: (70,150 - 69,000.50) x 0.1 x 50 = 5,747.50 received. No funding is generated.
        events: [{ type: 'future.variation', summary: 'Variation margin received on 50 BTCP: 5,747.50 USD (settlement 70,150.00 vs 69,000.50)', cash: { USD: 5_747.50 }, date: '2026-03-16' }],
        cash: { account: { USD: usd(70_558.05, 35_000) } },
        positions: [{ instrument: 'main', lot: 'long', qty: 50, avgCost: 70_150, price: 70_200, value: 250, unrealized: 250 }], // 50 x 0.1 x 50
        pnl: { account: { realized: 5_747.50, unrealized: 250, total: 5_808.05 } },
        balance: { account: { cash: 70_558.05, positions: 250 } },
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-03-17'), expect: {} },
    {
      id: 'reduce', covers: ['reduce', 'margin release'], action: 'close', lot: 'long', scope: 'strategy', percent: 40, // sells 20 of the 50
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 20, estimate: 70_200, model: 'quoted-bid-ask', settleDate: '2026-03-17',
          notional: 140_400, initialMargin: -14_000, fees: 70.20 }], // 20 x 70,200 x 0.1; 5 bp of 140,400
          cash: { USD: { purchases: 0, fees: 70.20, margin: 0, required: 70.20, available: 70_558.05, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 20, avgPrice: 70_200 }] },
        // Realized: (70,200 - 70,150) x 0.1 x 20 = 100.00. Cash: 100 - 70.20 + 14,000 = 14,029.80.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 20 BTCP @ 70,200.00 (notional 140,400.00 USD; margin released 14,000.00 USD; realized 100.00 USD)', cash: { USD: 14_029.80 } }],
        cash: { account: { USD: usd(84_587.85, 21_000) } },
        positions: [{ instrument: 'main', lot: 'long', qty: 30, avgCost: 70_150, price: 70_200, value: 150, unrealized: 150, notional: 210_600, margin: 21_000 }],
        holdings: { main: { long: 30, short: 0, net: 30 } },
        pnl: { account: { realized: 5_847.50, commissions: -242.70, unrealized: 150, total: 5_737.85 } }, // 5,847.50 - 242.70 - 16.95 + 150
        nav: { account: 105_737.85, book: 1_005_737.85 },
        balance: { account: { cash: 84_587.85, margin: 21_000, positions: 150, assets: 105_737.85, netAssets: 105_737.85 } },
      },
    },
    {
      id: 'close-long', covers: ['close', 'margin release'], action: 'close', lot: 'long', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 30, estimate: 70_200, model: 'quoted-bid-ask', settleDate: '2026-03-17',
          notional: 210_600, initialMargin: -21_000, fees: 105.30 }], // 5 bp of 210,600
          cash: { USD: { purchases: 0, fees: 105.30, margin: 0, required: 105.30, available: 84_587.85, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 30, avgPrice: 70_200 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 30 BTCP @ 70,200.00 (notional 210,600.00 USD; margin released 21,000.00 USD; realized 150.00 USD)', cash: { USD: 21_044.70 } }], // 150 - 105.30 + 21,000
        cash: { account: { USD: usd(105_632.55, 0) } },
        positions: [],
        holdings: { main: null },
        pnl: { account: { realized: 5_997.50, commissions: -348, unrealized: 0, total: 5_632.55 } }, // the long: (70,200 - 69,000.50) x 0.1 x 50 = 5,997.50
        nav: { account: 105_632.55, book: 1_005_632.55 },
        balance: { account: { cash: 105_632.55, margin: null, positions: null, assets: 105_632.55, netAssets: 105_632.55 } },
      },
    },
    {
      id: 'open-short', covers: ['open short', 'initial margin'], action: 'ticket', instrument: 'main', side: 'sell', qty: 40, as: 'short',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 40, estimate: 70_200, model: 'quoted-bid-ask', settleDate: '2026-03-17',
          notional: 280_800, initialMargin: 28_000, fees: 140.40 }], // 40 x 70,200 x 0.1; 5 bp
          cash: { USD: { purchases: 0, fees: 140.40, margin: 28_000, required: 28_140.40, available: 105_632.55, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 40, avgPrice: 70_200 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Sold 40 BTCP @ 70,200.00 (notional 280,800.00 USD; margin posted 28,000.00 USD)', cash: { USD: -28_140.40 } }],
        cash: { account: { USD: usd(77_492.15, 28_000) } },
        positions: [{ instrument: 'main', lot: 'short', owner: 'account', direction: 'short', qty: -40, avgCost: 70_200, cost: 0, price: 70_200, value: 0, unrealized: 0, notional: 280_800, margin: 28_000 }],
        holdings: { main: { long: 0, short: 40, net: -40 } },
        pnl: { account: { commissions: -488.40, total: 5_492.15 } },
        nav: { account: 105_492.15, book: 1_005_492.15 },
        balance: { account: { cash: 77_492.15, margin: 28_000, assets: 105_492.15, netAssets: 105_492.15 } },
      },
    },
    {
      // Funding at +0.0100% again: this time the Account is short and receives 0.0001 x 280,800 = 28.08.
      id: 'funding-received-short', covers: 'funding payment', action: 'cashflow', lot: 'short', category: 'funding', amount: 28.08, note: 'Funding at 16:00 UTC: 0.0100% of 280,800.00 notional, longs pay',
      expect: {
        events: [{ type: 'manual.cashflow', summary: 'Manual funding on BTCP: received 28.08 USD. Funding at 16:00 UTC: 0.0100% of 280,800.00 notional, longs pay', cash: { USD: 28.08 } }],
        cash: { account: { USD: usd(77_520.23, 28_000) } },
        pnl: { account: { borrowFunding: 11.13, total: 5_520.23 } }, // -34.50 + 17.55 + 28.08: net funding received
        nav: { account: 105_520.23, book: 1_005_520.23 },
        balance: { account: { cash: 77_520.23, assets: 105_520.23, netAssets: 105_520.23 } },
      },
    },
    {
      id: 'tuesday-variation', covers: 'variation margin', action: 'clock', to: EOD('2026-03-17'),
      expect: {
        events: [{ type: 'future.variation', summary: 'Variation margin paid on -40 BTCP: 880.00 USD (settlement 70,420.00 vs 70,200.00)', cash: { USD: -880 }, date: '2026-03-17' }], // 220 x 0.1 x 40 against the short
        cash: { account: { USD: usd(76_640.23, 28_000) } },
        positions: [{ instrument: 'main', lot: 'short', qty: -40, avgCost: 70_420, price: 70_200, value: 880, unrealized: 880 }],
        pnl: { account: { realized: 5_117.50, unrealized: 880, total: 5_520.23 } },
        balance: { account: { cash: 76_640.23, positions: 880 } },
      },
    },
    { id: 'wednesday', action: 'clock', to: AM('2026-03-18'), expect: {} },
    {
      id: 'quote-wednesday', action: 'quote', instrument: 'main', quote: { bid: 69_700, ask: 69_700.5, last: 69_700.5, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'short', qty: -40, avgCost: 70_420, price: 69_700.5, value: 2_878, unrealized: 2_878, notional: 278_802 }], // (70,420 - 69,700.50) x 0.1 x 40
        pnl: { account: { unrealized: 2_878, total: 7_518.23 } }, // 5,117.50 - 488.40 + 11.13 + 2,878
        nav: { account: 107_518.23, book: 1_007_518.23 },
        balance: { account: { positions: 2_878, assets: 107_518.23, netAssets: 107_518.23 } },
      },
    },
    {
      id: 'close-short', covers: ['close short', 'margin release'], action: 'close', lot: 'short', scope: 'position', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 40, estimate: 69_700.5, model: 'quoted-bid-ask', settleDate: '2026-03-18',
          notional: 278_802, initialMargin: -28_000, fees: 139.40 }], // 40 x 69,700.50 x 0.1; 5 bp of 278,802 = 139.401
          cash: { USD: { purchases: 0, fees: 139.40, margin: 0, required: 139.40, available: 76_640.23, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ action: 'buy', status: 'filled', filledQty: 40, avgPrice: 69_700.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 40 BTCP @ 69,700.50 (notional 278,802.00 USD; margin released 28,000.00 USD; realized 2,878.00 USD)', cash: { USD: 30_738.60 } }], // 2,878 - 139.40 + 28,000
        // By hand: long 50 from 69,000.50 to 70,200: 5,997.50. Short 40 from 70,200 to 69,700.50: 1,998.00. Total 7,995.50.
        // Commission 172.50 + 70.20 + 105.30 + 140.40 + 139.40 = 627.80. Funding -34.50 + 17.55 + 28.08 = 11.13.
        cash: { account: { USD: usd(107_378.83, 0) }, treasury: { USD: usd(900_000) } }, // 100,000 + 7,995.50 - 627.80 + 11.13
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        pnl: { account: { realized: 7_995.50, commissions: -627.80, borrowFunding: 11.13, unrealized: 0, total: 7_378.83 } },
        nav: { account: 107_378.83, treasury: 900_000, book: 1_007_378.83 },
        balance: { account: { cash: 107_378.83, margin: null, positions: null, assets: 107_378.83, liabilities: 0, netAssets: 107_378.83 } },
      },
    },
  ],
};

export default [equityFuture, equityIndexFuture, govBondFuture, treasuryFuture, stirFuture, fxFuture, commodityFuture, volatilityFuture, dividendFuture, cryptoFuture, perpetualFuture];
