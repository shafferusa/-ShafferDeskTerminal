// Fund family (engine family "fund"): open-ended funds that deal at their NAV.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec (NAVs, quantities,
// the Book's fee schedule and settlement assumptions). The arithmetic is in the comment beside it. Nothing
// here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules for funds, restated so the arithmetic
// can be followed; products/security.js "funds: forward pricing"):
//   - An order in an open-ended fund is never filled against a live quote. It is dealt at the next NAV struck
//     after it is placed: placed on a dealing day before the cut-off (16:00 New York), that day's NAV; placed
//     after the cut-off, or on a day the fund does not deal, the next dealing day's NAV. The trade date is the
//     dealing date and settlement is counted from it.
//   - The NAV of a dealing date is an official close of that date supplied by Shaffer MarketData (here a close
//     fixture, released after 16:00 New York of that date) or a NAV entered by hand for that date.
//   - Until its NAV is supplied the order waits, visibly, and is not expired at the end of the day. A
//     subscription keeps its estimated cost (quantity x last published NAV, plus fees) reserved meanwhile.
//   - The preview cannot know the NAV: it shows no fill price, and the amounts are estimated from the last
//     published NAV (the instrument's latest price). The fill records the difference against what was confirmed.
//   - Positions are valued at the latest published NAV (the instrument's price; here a quote fixture with a
//     last price only, standing in for the NAV MarketData publishes). Average cost; sales remove cost at the average.
//   - Distributions are recorded corporate actions (cash dividend), paid on the ex-date to the holding at the
//     open of that date.
//   - US fund dealing calendar: NYSE days. Good Friday, 3 April 2026, is closed. US clocks move to daylight
//     time on 8 March 2026: 10:00 New York is 15:00 UTC before and 14:00 UTC after; 18:00 is 23:00 / 22:00 UTC.

export const family = 'fund';

/** The Book every fund scenario starts from, stated in full so no figure rests on a default. */
const book = (name, over = {}) => ({
  name,
  reportingCcy: 'USD',
  capital: [{ ccy: 'USD', amount: 1_000_000 }],
  account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] },
  settings: {
    fees: { fund: { perUnit: 0, minimum: 0, bps: 0 }, ...(over.fees || {}) }, // no-load share classes: no commission
    fill: { halfSpreadBps: { fund: 0 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 },
    settlement: { fund: 1, foreignCash: 2, ...(over.settlement || {}) }, // US mutual funds settle T+1 from the dealing date
    short: { collateralPct: 1.02, marginPct: 0.3 },
    dividends: { withholdingPct: 0 },
  },
});

const START_STATE = {
  cash: {
    account: { USD: { settled: 500_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 500_000 } },
    treasury: { USD: { settled: 500_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 500_000 } },
  },
  positions: [],
  pending: [],
  openOrders: [],
  borrowings: [],
  nav: { account: 500_000, treasury: 500_000, book: 1_000_000 },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
};

const FUND_TICKET = {
  ticket: 'Instrument drawer, Trade tab (security ticket: Buy subscribes, Sell redeems), then the trade preview',
  requiredFields: ['Account (trading owner)', 'Action', 'Shares'],
  automaticInputs: ['dealing date from the order time, the 16:00 New York cut-off and the fund dealing calendar', 'NAV of the dealing date (close fixture standing in for Shaffer MarketData)', 'last published NAV for the estimate and for valuation (price fixture)', 'settlement date counted from the dealing date', 'commission from the Book fee schedule (none for a no-load class)'],
};

const waitingFor = (date, last) => `Waiting for the NAV of ${date}: a fund order is dealt at the next NAV struck after it is placed (cut-off 16:00 New York), never at a live quote. The amounts shown use the last published NAV, ${last}, as an estimate.`;

// ---------------------------------------------------------------------------------------------
// mutual_fund
// ---------------------------------------------------------------------------------------------
// An open-ended US mutual fund, no-load investor class, dealt through its transfer agent (not exchange-listed).
// A subscription before the cut-off deals at that day's NAV; a redemption placed after the Thursday cut-off
// before Good Friday deals at Monday's NAV (the Thursday NAV, already published, must not be used); a quarterly
// income distribution; a final redemption to zero.
const mutualFund = {
  productId: 'mutual_fund',
  title: 'Lakemont Balanced Fund, Investor Class: US open-ended mutual fund dealt at the next NAV',
  matrix: {
    ...FUND_TICKET,
    manualInputs: ['income distribution (ex-date, amount per share), recorded by hand as a cash dividend'],
    settlement: 'T+1 from the dealing date on the US calendar (Book setting settlement.fund = 1); the dealing date is the day of the order before 16:00 New York, else the next dealing day',
    lifecycle: 'Orders wait for the NAV of their dealing date (never filled at a live quote, never expired at the end of the day); distribution paid on its ex-date; NAV drops by the distribution',
    accounting: 'Average cost; subscription cost reserved while waiting; payable or receivable until settlement; realized P&L on redemption; distribution income; valued at the latest published NAV',
    collateral: 'None; limit orders and short sales do not apply to a fund and are refused',
  },
  start: '2026-03-02T15:00:00.000Z', // Monday 2 March 2026, 10:00 New York
  settlementCheck: { lag: 1, holidays: ['2026-04-03'] }, // NYSE days; Good Friday 3 April 2026
  book: book('Matrix mutual fund'),
  instruments: {
    main: { productId: 'mutual_fund', name: 'Lakemont Balanced Fund, Investor Class', symbol: 'LKBIX', marketView: 'US_CASH', venue: 'Lakemont Funds transfer agent', venueType: 'otc', venueCountry: 'US', issuer: 'Lakemont Funds Trust', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  },
  quotes: { main: { last: 24.10 } }, // NAV published for Friday 27 February
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'subscribe', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: ['not-executable'],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1000, estimate: null, reference: 24.10, model: 'next-nav', executable: false, settleDate: '2026-03-03', calendar: 'US',
            cash: -24_100, // 1,000 x 24.10, the last published NAV, as an estimate
            fees: 0 }],
          cash: { USD: { purchases: 24_100, fees: 0, required: 24_100, available: 500_000, shortfall: 0 } },
        },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'working', filledQty: 0, avgPrice: null, fills: [] }] },
        events: [{ type: 'strategy.submitted' }],
        cash: { account: { USD: { settled: 500_000, unsettled: 0, reserved: 24_100, availableToTrade: 475_900 } } }, // the estimate is reserved: 500,000 - 24,100
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'buy', status: 'working', qty: 1000, filledQty: 0, owner: 'account', reason: waitingFor('2026-03-02', '24.10') }],
        pnl: { account: { realized: 0, dividends: 0, commissions: 0, fees: 0, unrealized: 0, total: 0 } },
        nav: { account: 500_000, book: 1_000_000 },
        balance: { account: { cash: 500_000, assets: 500_000, liabilities: 0, netAssets: 500_000 } },
      },
    },
    {
      id: 'nav-before-close', action: 'close_price', instrument: 'main', date: '2026-03-02', value: 24.18,
      expect: {}, // the NAV of 2 March is struck after the 16:00 close; at 10:00 it is not released and nothing deals
    },
    {
      id: 'dealt-at-nav', covers: ['open', 'settlement'], action: 'clock', to: '2026-03-02T23:00:00.000Z', // 18:00 New York: the NAV of 2 March is out
      expect: {
        events: [
          { type: 'trade.fill', summary: 'Bought 1,000 LKBIX @ 24.18 USD', owner: 'account', date: '2026-03-02' }, // 1,000 x 24.18 = 24,180
          // Confirmed on the estimate 24,100; dealt at 24,180: 80 more, 0.33% of 24,100, inside the 0.5% tolerance.
          { type: 'order.fill_variance', summary: /within tolerance.*Dealt at the NAV of its dealing date, 24\.18/, owner: 'account', date: '2026-03-02' },
        ],
        cash: { account: { USD: { settled: 500_000, unsettled: -24_180, reserved: 0, availableToTrade: 475_820 } } }, // reservation released; 24,180 owed on 3 March
        openOrders: [],
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1000, avgCost: 24.18, cost: 24_180,
          price: 24.10, value: 24_100, // valued at the latest published price, still 24.10 until the new NAV is published as the price
          unrealized: -80, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1000, short: 0, net: 1000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-03', amount: -24_180, ccy: 'USD', into: 'cash' }],
        pnl: { account: { unrealized: -80, total: -80 } },
        nav: { account: 499_920, book: 999_920 },
        balance: { account: { cash: 500_000, positions: 24_100, payable: 24_180, assets: 524_100, liabilities: 24_180, netAssets: 499_920 } },
      },
    },
    {
      id: 'nav-published', action: 'quote', instrument: 'main', quote: { last: 24.18 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1000, price: 24.18, value: 24_180, unrealized: 0 }], // 1,000 x 24.18
        pnl: { account: { unrealized: 0, total: 0 } },
        nav: { account: 500_000, book: 1_000_000 },
        balance: { account: { positions: 24_180, assets: 524_180, netAssets: 500_000 } },
      },
    },
    {
      id: 'settle-subscription', covers: 'settlement', action: 'clock', to: '2026-03-03T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 24,180.00 USD from settled cash', cash: { USD: -24_180 }, date: '2026-03-03' }],
        cash: { account: { USD: { settled: 475_820, unsettled: 0, availableToTrade: 475_820 } } },
        pending: [],
        balance: { account: { cash: 475_820, payable: null, assets: 500_000, liabilities: 0 } },
      },
    },
    {
      id: 'limit-order', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 100, order: { orderType: 'limit', limitPrice: 24.00 },
      status: 'unsupported', reason: 'A fund deals at the next NAV, whatever it is: a limit order does not apply to it.',
      expect: { refused: 'does not apply' },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.01 },
      status: 'unsupported', reason: 'Fund shares are subscribed and redeemed with the fund; they are not borrowed and sold short.',
      expect: { refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' } },
    },
    {
      id: 'distribution-recorded', covers: 'distribution', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-03-04', amount: 0.12,
      expect: {},
    },
    {
      id: 'distribution-paid', covers: 'distribution', action: 'clock', to: '2026-03-04T15:00:00.000Z',
      expect: {
        events: [{ type: 'dividend', summary: 'Dividend on 1,000 LKBIX: 120.00 USD (0.12 per unit, ex-date 2026-03-04)', cash: { USD: 120 }, owner: 'account' }], // 1,000 x 0.12
        cash: { account: { USD: { settled: 475_940, availableToTrade: 475_940 } } },
        pnl: { account: { dividends: 120, total: 120 } },
        nav: { account: 500_120, book: 1_000_120 },
        balance: { account: { cash: 475_940, assets: 500_120, netAssets: 500_120 } },
      },
    },
    {
      id: 'nav-ex-distribution', action: 'quote', instrument: 'main', quote: { last: 24.08 }, // the NAV falls by about the distribution
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1000, price: 24.08, value: 24_080, unrealized: -100 }], // 24,080 - 24,180
        pnl: { account: { unrealized: -100, total: 20 } },
        nav: { account: 500_020, book: 1_000_020 },
        balance: { account: { positions: 24_080, assets: 500_020, netAssets: 500_020 } },
      },
    },
    {
      id: 'nav-thursday', action: 'quote', instrument: 'main', quote: { last: 24.40 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1000, price: 24.40, value: 24_400, unrealized: 220 }],
        pnl: { account: { unrealized: 220, total: 340 } },
        nav: { account: 500_340, book: 1_000_340 },
        balance: { account: { positions: 24_400, assets: 500_340, netAssets: 500_340 } },
      },
    },
    {
      id: 'thursday-after-cutoff', action: 'clock', to: '2026-04-02T21:00:00.000Z', // Thursday 2 April 2026, 17:00 New York
      expect: {},
    },
    {
      id: 'thursday-nav-supplied', action: 'close_price', instrument: 'main', date: '2026-04-02', value: 24.40,
      expect: {}, // Thursday's NAV is out, but an order placed after Thursday's cut-off must not use it
    },
    {
      id: 'redeem-after-cutoff', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 400, from: 'lot', settlementCheck: false,
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          // Placed after Thursday's cut-off: dealing date is the next dealing day. Friday 3 April is Good Friday (closed),
          // so Monday 6 April; settlement T+1 is Tuesday 7 April.
          legs: [{ kind: 'trade', action: 'sell', qty: 400, estimate: null, reference: 24.40, model: 'next-nav', executable: false, settleDate: '2026-04-07', cash: 9_760, fees: 0 }], // 400 x 24.40 as an estimate
          cash: { USD: { proceeds: 9_760, fees: 0 } },
        },
        result: { orders: [{ action: 'sell', status: 'working', filledQty: 0, fills: [] }] },
        events: [{ type: 'strategy.legs_added' }],
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'sell', status: 'working', qty: 400, filledQty: 0, owner: 'account', reason: waitingFor('2026-04-06', '24.40') }],
      },
    },
    {
      id: 'good-friday', action: 'clock', to: '2026-04-03T22:00:00.000Z', // Good Friday, 18:00 New York: the fund does not deal
      expect: {
        // The order still waits; on a closed day its reason is the market calendar's.
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'sell', status: 'working', qty: 400, filledQty: 0, owner: 'account' }],
      },
    },
    {
      id: 'monday-nav-supplied', action: 'close_price', instrument: 'main', date: '2026-04-06', value: 24.55,
      expect: {},
    },
    {
      id: 'monday-nav-published', action: 'quote', instrument: 'main', quote: { last: 24.55 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1000, price: 24.55, value: 24_550, unrealized: 370 }], // 24,550 - 24,180
        pnl: { account: { unrealized: 370, total: 490 } },
        nav: { account: 500_490, book: 1_000_490 },
        balance: { account: { positions: 24_550, assets: 500_490, netAssets: 500_490 } },
      },
    },
    {
      id: 'redeemed-at-monday-nav', covers: ['reduce', 'settlement'], action: 'clock', to: '2026-04-06T22:00:00.000Z', // Monday 6 April, 18:00 New York
      expect: {
        events: [
          // 400 x 24.55 = 9,820. Cost out at the average: 24,180 x 400/1,000 = 9,672. Realized 9,820 - 9,672 = 148.
          { type: 'trade.fill', summary: 'Sold 400 LKBIX @ 24.55 USD (realized 148.00 USD)', owner: 'account', date: '2026-04-06' },
          // Confirmed on 9,760, dealt 9,820: 60 more, 0.61% of 9,760, beyond the 0.5% tolerance (recorded, as forward pricing implies).
          { type: 'order.fill_variance', summary: /outside tolerance.*Dealt at the NAV of its dealing date, 24\.55.*as expected of forward pricing/, owner: 'account', date: '2026-04-06' },
        ],
        cash: { account: { USD: { settled: 475_940, unsettled: 9_820, availableToTrade: 485_760 } } }, // 475,940 + 9,820
        openOrders: [],
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 600, avgCost: 24.18, cost: 14_508, price: 24.55, value: 14_730, unrealized: 222 }], // 600 x 24.18; 600 x 24.55; 14,730 - 14,508
        holdings: { main: { long: 600, short: 0, net: 600 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-07', amount: 9_820, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 148, dividends: 120, unrealized: 222, total: 490 } },
        nav: { account: 500_490, book: 1_000_490 },
        balance: { account: { cash: 475_940, receivable: 9_820, positions: 14_730, assets: 500_490, liabilities: 0, netAssets: 500_490 } },
      },
    },
    {
      id: 'settle-redemption', covers: 'settlement', action: 'clock', to: '2026-04-07T14:00:00.000Z', // Tuesday 7 April, 10:00 New York
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 9,820.00 USD into settled cash', cash: { USD: 9_820 }, date: '2026-04-07' }],
        cash: { account: { USD: { settled: 485_760, unsettled: 0, availableToTrade: 485_760 } } },
        pending: [],
        balance: { account: { cash: 485_760, receivable: null } },
      },
    },
    {
      id: 'over-redeem', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 700, from: 'lot',
      status: 'blocked', reason: 'The Account holds 600 shares and cannot redeem 700.',
      expect: { refused: 'more than it holds' },
    },
    {
      id: 'redeem-all', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 600, from: 'lot',
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          legs: [{ kind: 'trade', action: 'sell', qty: 600, estimate: null, reference: 24.55, model: 'next-nav', executable: false, settleDate: '2026-04-08', cash: 14_730, fees: 0 }], // before the cut-off: dealt at 7 April's NAV; 600 x 24.55 estimate
          cash: { USD: { proceeds: 14_730, fees: 0 } },
        },
        result: { orders: [{ action: 'sell', status: 'working', filledQty: 0, fills: [] }] },
        events: [{ type: 'strategy.legs_added' }],
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'sell', status: 'working', qty: 600, filledQty: 0, owner: 'account', reason: waitingFor('2026-04-07', '24.55') }],
      },
    },
    {
      id: 'tuesday-nav', action: 'close_price', instrument: 'main', date: '2026-04-07', value: 24.60,
      expect: {},
    },
    {
      id: 'tuesday-nav-published', action: 'quote', instrument: 'main', quote: { last: 24.60 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 600, price: 24.60, value: 14_760, unrealized: 252 }], // 600 x 24.60 - 14,508
        // The waiting order's estimate follows the last published NAV (still the same dealing date).
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'sell', status: 'working', qty: 600, filledQty: 0, owner: 'account', reason: waitingFor('2026-04-07', '24.60') }],
        pnl: { account: { unrealized: 252, total: 520 } },
        nav: { account: 500_520, book: 1_000_520 },
        balance: { account: { positions: 14_760, assets: 500_520, netAssets: 500_520 } },
      },
    },
    {
      id: 'redeemed-in-full', covers: ['close', 'settlement'], action: 'clock', to: '2026-04-07T22:00:00.000Z',
      expect: {
        events: [
          { type: 'trade.fill', summary: 'Sold 600 LKBIX @ 24.60 USD (realized 252.00 USD)', owner: 'account', date: '2026-04-07' }, // 14,760 - 14,508
          { type: 'order.fill_variance', summary: /within tolerance.*Dealt at the NAV of its dealing date, 24\.6/, owner: 'account', date: '2026-04-07' }, // 30 on 14,730 = 0.2%
        ],
        cash: { account: { USD: { settled: 485_760, unsettled: 14_760, availableToTrade: 500_520 } } },
        openOrders: [],
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-08', amount: 14_760, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 400, dividends: 120, unrealized: 0, total: 520 } }, // 148 + 252; total 400 + 120
        nav: { account: 500_520, book: 1_000_520 },
        balance: { account: { cash: 485_760, receivable: 14_760, positions: null, assets: 500_520, netAssets: 500_520 } },
      },
    },
    {
      id: 'settle-final', covers: 'settlement', action: 'clock', to: '2026-04-08T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 14,760.00 USD into settled cash', cash: { USD: 14_760 }, date: '2026-04-08' }],
        cash: { account: { USD: { settled: 500_520, unsettled: 0, availableToTrade: 500_520 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 500_520, receivable: null, assets: 500_520, liabilities: 0, netAssets: 500_520 } },
      },
    },
  ],
};

export default [mutualFund];
