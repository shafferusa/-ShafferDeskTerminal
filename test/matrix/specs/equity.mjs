// Equity family (engine family "equity"): the 12 catalog products accounted as equity-like
// securities. One scenario per product, each on its own fictional instrument registered as exactly
// that product.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec (quotes,
// quantities, the Book's fee schedule and assumptions). The arithmetic is in the comment beside it.
// Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (they are the Terminal's documented rules, restated so the
// arithmetic can be followed):
//   - A market buy fills at the ask, a market sell at the bid, of the quote in force.
//   - Commission comes from the Book's fee schedule and is expensed (it is not added to cost).
//   - Positions carry average cost. Selling part removes cost at the average.
//   - A fill books the position on trade date and leaves a payable or receivable; cash moves on the
//     settlement date. Positions are valued at the last price.
//   - Calendar week used: Monday 2 March 2026 to Tuesday 10 March 2026. No US, UK or TARGET holiday
//     falls in it (Presidents' Day was 16 February; Good Friday is 3 April). US clocks move to daylight
//     time on Sunday 8 March, so 10:00 New York is 15:00 UTC up to 6 March and 14:00 UTC from 9 March.

export const family = 'equity';

const MON = '2026-03-02T15:00:00.000Z'; // Monday 2 March 2026, 10:00 New York
const TUE = '2026-03-03T15:00:00.000Z';
const WED = '2026-03-04T15:00:00.000Z';
const THU = '2026-03-05T15:00:00.000Z';
const FRI = '2026-03-06T15:00:00.000Z';
const MON2 = '2026-03-09T14:00:00.000Z'; // Monday 9 March 2026, 10:00 New York (daylight time)
const TUE2 = '2026-03-10T14:00:00.000Z';

/** The Book every equity scenario starts from, stated in full so no figure rests on a default. */
const book = (name, over = {}) => ({
  name,
  reportingCcy: 'USD',
  capital: [{ ccy: 'USD', amount: 1_000_000 }],
  account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] },
  settings: {
    fees: { equity: { perUnit: 0.005, minimum: 1, bps: 0 }, ...(over.fees || {}) }, // 0.005 a share, at least 1.00 an order
    fill: { halfSpreadBps: { equity: 2 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 },
    settlement: { equity: 1, foreignCash: 2, ...(over.settlement || {}) }, // T+1 for US listings, T+2 for foreign listings
    short: { collateralPct: 1.02, marginPct: 0.3 },
    dividends: { withholdingPct: 0, ...(over.dividends || {}) },
  },
});

/** State before any trade: 1,000,000 deposited in Treasury, 500,000 of it funded to the Account. */
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

const SECURITY_TICKET = {
  ticket: 'Instrument drawer, Trade tab (security ticket), then the trade preview',
  requiredFields: ['Account', 'Action', 'Shares'],
  automaticInputs: ['bid, ask, last and size (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model', 'settlement date from the listing venue calendar', 'commission from the Book fee schedule'],
};

// ---------------------------------------------------------------------------------------------
// common_stock
// ---------------------------------------------------------------------------------------------
const commonStock = {
  productId: 'common_stock',
  title: 'Northfield Tool Works, NYSE-listed common stock',
  matrix: {
    ...SECURITY_TICKET,
    manualInputs: ['cash dividend (ex-date, amount per share), recorded by hand', 'stock split (ratio, ex-date), recorded by hand'],
    settlement: 'T+1 on the US equity calendar (Book setting settlement.equity = 1)',
    lifecycle: 'Cash dividend paid on its date from the holding at the open of the ex-date; split applied on its ex-date (quantity changes, cost does not)',
    accounting: 'Average cost; commission expensed; payable or receivable until settlement; realized P&L on sale; dividend income; valued at last price',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix common stock'),
  instruments: {
    main: { productId: 'common_stock', name: 'Northfield Tool Works Inc.', symbol: 'NFTW', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Northfield Tool Works Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  },
  quotes: { main: { bid: 50.00, ask: 50.02, last: 50.01, bidSize: 5000, askSize: 5000 } },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 200, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 200, estimate: 50.02, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US',
            cash: -10_004, // 200 x 50.02 (the ask)
            fees: 1 }], // 200 x 0.005 = 1.00, which is also the minimum
          cash: { USD: { purchases: 10_004, fees: 1, required: 10_005, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 200, avgPrice: 50.02, fills: [{ qty: 200, price: 50.02, model: 'quoted-bid-ask', settleDate: '2026-03-03', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 200 NFTW @ 50.02 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -10_005, availableToTrade: 489_995 } } }, // 10,004 + 1 owed until settlement
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 200, avgCost: 50.02, cost: 10_004, price: 50.01,
          value: 10_002, // 200 x 50.01 (last)
          unrealized: -2, priceSource: 'Test fixture' }], // 10,002 - 10,004
        holdings: { main: { long: 200, short: 0, net: 200 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-03-03', amount: -10_005, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -1, fees: 0, borrowFunding: 0, unrealized: -2, total: -3 } },
        nav: { account: 499_997, book: 999_997 }, // 500,000 - 1 commission - 2 unrealized
        balance: { account: { cash: 500_000, positions: 10_002, payable: 10_005, assets: 510_002, liabilities: 10_005, netAssets: 499_997 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 10,005.00 USD from settled cash', cash: { USD: -10_005 }, date: '2026-03-03' }],
        cash: { account: { USD: { settled: 489_995, unsettled: 0, availableToTrade: 489_995 } } },
        pending: [],
        balance: { account: { cash: 489_995, payable: null, assets: 499_997, liabilities: 0 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 51.00, ask: 51.03, last: 51.02, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 200, avgCost: 50.02, price: 51.02, value: 10_204, unrealized: 200 }], // 200 x 51.02 = 10,204; less cost 10,004
        pnl: { account: { unrealized: 200, total: 199 } },
        nav: { account: 500_199, book: 1_000_199 },
        balance: { account: { positions: 10_204, assets: 500_199, netAssets: 500_199 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 200 -> 300: buys 100 more in the same strategy instance
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy', qty: 100, estimate: 51.03, settleDate: '2026-03-04', cash: -5_103, fees: 1 }], // 100 x 51.03; fee 0.50 raised to the 1.00 minimum
          cash: { USD: { purchases: 5_103, fees: 1, required: 5_104, available: 489_995, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 100, avgPrice: 51.03 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 100 NFTW @ 51.03 USD' }],
        cash: { account: { USD: { settled: 489_995, unsettled: -5_104, availableToTrade: 484_891 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 300,
          cost: 15_107, // 10,004 + 5,103
          avgCost: 50.356667, // 15,107 / 300
          price: 51.02, value: 15_306, // 300 x 51.02
          unrealized: 199 }], // 15,306 - 15,107
        holdings: { main: { long: 300, short: 0, net: 300 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-04', amount: -5_104, into: 'cash' }],
        pnl: { account: { commissions: -2, unrealized: 199, total: 197 } },
        nav: { account: 500_197, book: 1_000_197 },
        balance: { account: { cash: 489_995, positions: 15_306, payable: 5_104, assets: 505_301, liabilities: 5_104, netAssets: 500_197 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: WED,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 5,104.00 USD', cash: { USD: -5_104 } }],
        cash: { account: { USD: { settled: 484_891, unsettled: 0, availableToTrade: 484_891 } } },
        pending: [],
        balance: { account: { cash: 484_891, payable: null, assets: 500_197, liabilities: 0 } },
      },
    },
    {
      id: 'oversell', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 500, from: 'lot',
      status: 'blocked', reason: 'The Account holds 300 and cannot sell 500; going short needs a securities borrow.',
      expect: { refused: 'more than it holds' },
    },
    {
      id: 'dividend-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-03-05', amount: 0.35,
      expect: {}, // recording changes nothing until the date arrives
    },
    {
      id: 'dividend-paid', covers: 'dividend', action: 'clock', to: THU,
      expect: {
        events: [{ type: 'dividend', summary: 'Dividend on 300 NFTW: 105.00 USD (0.35 per unit, ex-date 2026-03-05)', cash: { USD: 105 }, owner: 'account' }], // 300 x 0.35
        cash: { account: { USD: { settled: 484_996, availableToTrade: 484_996 } } },
        pnl: { account: { dividends: 105, total: 302 } }, // -2 commission + 105 + 199
        nav: { account: 500_302, book: 1_000_302 },
        balance: { account: { cash: 484_996, assets: 500_302, netAssets: 500_302 } },
      },
    },
    {
      id: 'quote-up-2', action: 'quote', instrument: 'main', quote: { bid: 52.40, ask: 52.44, last: 52.42, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 300, price: 52.42, value: 15_726, unrealized: 619 }], // 300 x 52.42 = 15,726; less 15,107
        pnl: { account: { unrealized: 619, total: 722 } },
        nav: { account: 500_722, book: 1_000_722 },
        balance: { account: { positions: 15_726, assets: 500_722, netAssets: 500_722 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 120, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 120, estimate: 52.40, model: 'quoted-bid-ask', settleDate: '2026-03-06', cash: 6_288, fees: 1 }], // 120 x 52.40 (the bid); fee 0.60 raised to 1.00
          cash: { USD: { proceeds: 6_288, fees: 1 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 120, avgPrice: 52.40 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 120 NFTW @ 52.40 USD (realized 245.20 USD)' }],
        // Cost removed at the average: 15,107 x 120/300 = 6,042.80. Realized 6,288 - 6,042.80 = 245.20.
        cash: { account: { USD: { settled: 484_996, unsettled: 6_287, availableToTrade: 491_283 } } }, // 6,288 - 1 owed to the Account
        positions: [{ instrument: 'main', lot: 'lot', qty: 180, cost: 9_064.20, avgCost: 50.356667, price: 52.42,
          value: 9_435.60, // 180 x 52.42
          unrealized: 371.40 }], // 9,435.60 - 9,064.20
        holdings: { main: { long: 180, short: 0, net: 180 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-06', amount: 6_287, into: 'cash' }],
        pnl: { account: { realized: 245.20, commissions: -3, dividends: 105, unrealized: 371.40, total: 718.60 } },
        nav: { account: 500_718.60, book: 1_000_718.60 },
        balance: { account: { cash: 484_996, receivable: 6_287, positions: 9_435.60, assets: 500_718.60, liabilities: 0, netAssets: 500_718.60 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: FRI,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 6,287.00 USD into settled cash', cash: { USD: 6_287 } }],
        cash: { account: { USD: { settled: 491_283, unsettled: 0, availableToTrade: 491_283 } } },
        pending: [],
        balance: { account: { cash: 491_283, receivable: null } },
      },
    },
    {
      id: 'split-recorded', covers: 'split', action: 'corporate_action', instrument: 'main', type: 'split', exDate: '2026-03-09', ratioNum: 2, ratioDen: 1,
      expect: {},
    },
    {
      id: 'split-applied', covers: 'split', action: 'clock', to: MON2,
      expect: {
        events: [{ type: 'split', summary: '2-for-1 split of NFTW: 180 became 360; cost basis unchanged' }],
        // Quantity doubles and cost stays. The quote is still the pre-split one until the data source sends the
        // adjusted price in the next step, so the value shown here is 360 x 52.42.
        positions: [{ instrument: 'main', lot: 'lot', qty: 360, cost: 9_064.20, avgCost: 25.178333, price: 52.42, value: 18_871.20, unrealized: 9_807 }],
        holdings: { main: { long: 360, short: 0, net: 360 } },
        pnl: { account: { unrealized: 9_807, total: 10_154.20 } }, // 245.20 - 3 + 105 + 9,807
        nav: { account: 510_154.20, book: 1_010_154.20 },
        balance: { account: { positions: 18_871.20, assets: 510_154.20, netAssets: 510_154.20 } },
      },
    },
    {
      id: 'quote-post-split', action: 'quote', instrument: 'main', quote: { bid: 26.20, ask: 26.22, last: 26.21, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 360, price: 26.21, value: 9_435.60, unrealized: 371.40 }], // 360 x 26.21
        pnl: { account: { unrealized: 371.40, total: 718.60 } },
        nav: { account: 500_718.60, book: 1_000_718.60 },
        balance: { account: { positions: 9_435.60, assets: 500_718.60, netAssets: 500_718.60 } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 360, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 360, estimate: 26.20, settleDate: '2026-03-10', cash: 9_432, fees: 1.80 }] }, // 360 x 26.20; fee 360 x 0.005
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 360, avgPrice: 26.20 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 360 NFTW @ 26.20 USD (realized 367.80 USD)' }], // 9,432 - 9,064.20
        cash: { account: { USD: { settled: 491_283, unsettled: 9_430.20, availableToTrade: 500_713.20 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-03-10', amount: 9_430.20, into: 'cash' }],
        pnl: { account: { realized: 613, commissions: -4.80, dividends: 105, unrealized: 0, total: 713.20 } }, // 245.20 + 367.80; 1 + 1 + 1 + 1.80
        nav: { account: 500_713.20, book: 1_000_713.20 },
        balance: { account: { cash: 491_283, receivable: 9_430.20, positions: null, assets: 500_713.20, netAssets: 500_713.20 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: TUE2,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 9,430.20 USD into settled cash' }],
        cash: { account: { USD: { settled: 500_713.20, unsettled: 0, availableToTrade: 500_713.20 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 500_713.20, receivable: null, assets: 500_713.20, liabilities: 0, netAssets: 500_713.20 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// adr
// ---------------------------------------------------------------------------------------------
// A US-listed depositary receipt of a Japanese issuer. The Book assumes 15% dividend withholding;
// the depositary's service fee is not generated by the Terminal and is recorded by hand.
const adr = {
  productId: 'adr',
  title: 'Kobori Precision Instruments ADR, NASDAQ-listed, Japanese issuer',
  matrix: {
    ...SECURITY_TICKET,
    manualInputs: ['cash dividend (ex-date, amount per ADR), recorded by hand', 'depositary fee, recorded by hand as a manual cash flow of kind Fee on the position'],
    settlement: 'T+1 on the US equity calendar: the listing venue decides, not the issuer domicile',
    lifecycle: 'Cash dividend net of the Book withholding assumption (15%); depositary fee by hand',
    accounting: 'Average cost; dividend income gross with withholding booked as a fee; depositary fee booked as a fee',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix ADR', { dividends: { withholdingPct: 15 } }),
  instruments: {
    main: { productId: 'adr', name: 'Kobori Precision Instruments ADR', symbol: 'KBPI', marketView: 'US_CASH', venue: 'NASDAQ', venueType: 'exchange', venueCountry: 'US', issuer: 'Kobori Precision Instruments K.K.', domicile: 'JP', underlyingGeo: 'JP', tradingCcy: 'USD', terms: {} },
  },
  quotes: { main: { bid: 38.42, ask: 38.46, last: 38.44, bidSize: 5000, askSize: 5000 } },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 500, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 500, estimate: 38.46, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US',
          cash: -19_230, // 500 x 38.46
          fees: 2.50 }], // 500 x 0.005
          cash: { USD: { purchases: 19_230, fees: 2.50, required: 19_232.50, available: 500_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 500, avgPrice: 38.46, fills: [{ qty: 500, price: 38.46, settleDate: '2026-03-03', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 500 KBPI @ 38.46 USD' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -19_232.50, availableToTrade: 480_767.50 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 500, avgCost: 38.46, cost: 19_230, price: 38.44, value: 19_220, unrealized: -10 }], // 500 x 38.44
        holdings: { main: { long: 500, short: 0, net: 500 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-03', amount: -19_232.50, into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -2.50, fees: 0, borrowFunding: 0, unrealized: -10, total: -12.50 } },
        nav: { account: 499_987.50, book: 999_987.50 },
        balance: { account: { cash: 500_000, positions: 19_220, payable: 19_232.50, assets: 519_220, liabilities: 19_232.50, netAssets: 499_987.50 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 19,232.50 USD from settled cash' }],
        cash: { account: { USD: { settled: 480_767.50, unsettled: 0, availableToTrade: 480_767.50 } } },
        pending: [],
        balance: { account: { cash: 480_767.50, payable: null, assets: 499_987.50, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.4, // 500 -> 700
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', qty: 200, estimate: 38.46, settleDate: '2026-03-04', cash: -7_692, fees: 1 }] }, // 200 x 38.46; 200 x 0.005
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 200, avgPrice: 38.46 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 200 KBPI @ 38.46 USD' }],
        cash: { account: { USD: { settled: 480_767.50, unsettled: -7_693, availableToTrade: 473_074.50 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 700, cost: 26_922, avgCost: 38.46, price: 38.44, value: 26_908, unrealized: -14 }], // 19,230 + 7,692; 700 x 38.44
        holdings: { main: { long: 700, short: 0, net: 700 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-04', amount: -7_693, into: 'cash' }],
        pnl: { account: { commissions: -3.50, unrealized: -14, total: -17.50 } },
        nav: { account: 499_982.50, book: 999_982.50 },
        balance: { account: { cash: 480_767.50, positions: 26_908, payable: 7_693, assets: 507_675.50, liabilities: 7_693, netAssets: 499_982.50 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: WED,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 7,693.00 USD' }],
        cash: { account: { USD: { settled: 473_074.50, unsettled: 0, availableToTrade: 473_074.50 } } },
        pending: [],
        balance: { account: { cash: 473_074.50, payable: null, assets: 499_982.50, liabilities: 0 } },
      },
    },
    { id: 'dividend-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-03-05', amount: 0.62, expect: {} },
    {
      id: 'dividend-paid', covers: 'dividend', action: 'clock', to: THU,
      expect: {
        // Gross 700 x 0.62 = 434.00. Withholding 15% = 65.10. Cash received 368.90.
        events: [{ type: 'dividend', summary: 'Dividend on 700 KBPI: 434.00 USD (0.62 per unit, ex-date 2026-03-05), less 65.10 USD withholding', cash: { USD: 368.90 } }],
        cash: { account: { USD: { settled: 473_443.40, availableToTrade: 473_443.40 } } },
        pnl: { account: { dividends: 434, fees: -65.10, total: 351.40 } }, // -3.50 + 434 - 65.10 - 14
        nav: { account: 500_351.40, book: 1_000_351.40 },
        balance: { account: { cash: 473_443.40, assets: 500_351.40, netAssets: 500_351.40 } },
      },
    },
    {
      id: 'depositary-fee', covers: 'depositary fee', action: 'cashflow', lot: 'lot', category: 'fee', amount: -14, note: 'Depositary service fee, 0.02 per ADR', // 700 x 0.02
      expect: {
        events: [{ type: 'manual.cashflow', summary: 'Manual fee on KBPI: paid 14.00 USD. Depositary service fee, 0.02 per ADR', cash: { USD: -14 }, owner: 'account' }],
        cash: { account: { USD: { settled: 473_429.40, availableToTrade: 473_429.40 } } },
        pnl: { account: { fees: -79.10, total: 337.40 } },
        nav: { account: 500_337.40, book: 1_000_337.40 },
        balance: { account: { cash: 473_429.40, assets: 500_337.40, netAssets: 500_337.40 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 39.10, ask: 39.14, last: 39.12, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 700, price: 39.12, value: 27_384, unrealized: 462 }], // 700 x 39.12 - 26,922
        pnl: { account: { unrealized: 462, total: 813.40 } },
        nav: { account: 500_813.40, book: 1_000_813.40 },
        balance: { account: { positions: 27_384, assets: 500_813.40, netAssets: 500_813.40 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 300, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 300, estimate: 39.10, settleDate: '2026-03-06', cash: 11_730, fees: 1.50 }] }, // 300 x 39.10; 300 x 0.005
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 300, avgPrice: 39.10 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 300 KBPI @ 39.10 USD (realized 192.00 USD)' }], // 300 x (39.10 - 38.46)
        cash: { account: { USD: { settled: 473_429.40, unsettled: 11_728.50, availableToTrade: 485_157.90 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 400, cost: 15_384, avgCost: 38.46, price: 39.12, value: 15_648, unrealized: 264 }], // 400 x 38.46; 400 x 39.12
        holdings: { main: { long: 400, short: 0, net: 400 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-06', amount: 11_728.50, into: 'cash' }],
        pnl: { account: { realized: 192, commissions: -5, dividends: 434, fees: -79.10, unrealized: 264, total: 805.90 } },
        nav: { account: 500_805.90, book: 1_000_805.90 },
        balance: { account: { cash: 473_429.40, receivable: 11_728.50, positions: 15_648, assets: 500_805.90, liabilities: 0, netAssets: 500_805.90 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: FRI,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 11,728.50 USD into settled cash' }],
        cash: { account: { USD: { settled: 485_157.90, unsettled: 0, availableToTrade: 485_157.90 } } },
        pending: [],
        balance: { account: { cash: 485_157.90, receivable: null } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100, // the strategy instance's "Close 100%"
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 400, estimate: 39.10, settleDate: '2026-03-09', cash: 15_640, fees: 2 }] }, // 400 x 39.10; 400 x 0.005
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 400, avgPrice: 39.10 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 400 KBPI @ 39.10 USD (realized 256.00 USD)' }], // 15,640 - 15,384
        cash: { account: { USD: { settled: 485_157.90, unsettled: 15_638, availableToTrade: 500_795.90 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-03-09', amount: 15_638, into: 'cash' }],
        pnl: { account: { realized: 448, commissions: -7, dividends: 434, fees: -79.10, unrealized: 0, total: 795.90 } },
        nav: { account: 500_795.90, book: 1_000_795.90 },
        balance: { account: { cash: 485_157.90, receivable: 15_638, positions: null, assets: 500_795.90, netAssets: 500_795.90 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MON2,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 15,638.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 500_795.90, unsettled: 0, availableToTrade: 500_795.90 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 500_795.90, receivable: null, assets: 500_795.90, liabilities: 0, netAssets: 500_795.90 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// short_sale
// ---------------------------------------------------------------------------------------------
// Borrow, sell short, carry, cover in two parts, return. Figures that depend on the Book's short
// assumptions: collateral is 102% of market value in restricted cash; a further 30% of market
// value is reserved from free cash; the borrow fee is 1.25% a year on market value, ACT/360.
//   - Sale proceeds settle into restricted cash (less the commission). They are never buying power.
//   - At each end of day the collateral is marked to 1.02 x quantity x last price, topped up from or
//     released to settled cash, and the reserve is reset to 0.30 x quantity x last price.
//   - The fee accrues once per day on that day's closing price (the fixture's last price); when
//     securities are returned during the day, the fee is accrued up to that day on the current price.
//   - A cover is paid from restricted cash first. What is left after the short is gone is released.
const AT_1730 = (d) => `${d}T22:30:00.000Z`; // 17:30 New York (winter time): after the 17:00 end-of-day cutoff
const shortSale = {
  productId: 'short_sale',
  title: 'Brightwater Retail Group, NYSE-listed, sold short against a securities borrow',
  matrix: {
    ticket: 'Instrument drawer, Trade tab: Sell short (adds the securities borrow leg), then Buy to cover; the strategy instance for Close',
    requiredFields: ['Account', 'Action (Sell short / Buy to cover)', 'Shares', 'borrow assumption only when no borrow data is supplied'],
    automaticInputs: ['bid, ask, last (quote fixture)', 'borrow availability and fee (borrow fixture standing in for Shaffer MarketData)', 'collateral and margin from the Book short assumptions', 'settlement date', 'commission'],
    manualInputs: ['dividend on the borrowed shares (ex-date, amount), recorded by hand'],
    settlement: 'T+1 on the US equity calendar; sale proceeds settle into restricted cash; a cover is paid from restricted cash first',
    lifecycle: 'Daily borrow fee accrual; end-of-day collateral mark and margin reserve; dividend compensation paid to the lender; fee paid when the borrow is fully returned (otherwise monthly)',
    accounting: 'Short position at negative cost (proceeds); unrealized against last price; borrow fee and dividend compensation under borrowing and funding expenses; the borrow is one record in the borrowing register',
    collateral: 'Restricted cash = 102% of market value, marked daily; 30% margin reserve; neither is buying power or withdrawable',
  },
  // The catalog lists "Short sale" as a product, but it is a transaction on a security, not an instrument.
  tradedOn: 'A short sale is placed from the Sell short action on the ticket of a registered security (here a common stock); the registry refuses to register a "Short sale" instrument, which the first step asserts.',
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix short sale'),
  instruments: {
    main: { productId: 'common_stock', name: 'Brightwater Retail Group Inc.', symbol: 'BWRG', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Brightwater Retail Group Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    other: { productId: 'common_stock', name: 'Calloway Freight Lines Inc.', symbol: 'CWFL', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Calloway Freight Lines Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  },
  quotes: {
    main: { bid: 80.00, ask: 80.04, last: 80.02, bidSize: 5000, askSize: 5000 },
    other: { bid: 100.00, ask: 100.02, last: 100.01, bidSize: 20000, askSize: 20000 },
  },
  borrow: { main: { available: true, quantity: 50_000, feeRate: 0.0125 } },
  expectAtStart: { ...START_STATE, lifecycle: [] },
  steps: [
    {
      id: 'register-a-short-sale', covers: 'registration', action: 'register_instrument',
      draft: { productId: 'short_sale', name: 'Brightwater Retail Group short sale', symbol: 'BWRG.SHORT', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {} },
      status: 'unsupported', reason: 'A short sale is not an instrument. It is the Sell short action on the security, with its borrow leg.',
      expect: { refused: 'Register the security, not the sale' },
    },
    {
      id: 'short-without-borrow-data', covers: 'short', action: 'ticket', instrument: 'other', side: 'sell_short', qty: 100,
      status: 'blocked', reason: 'No borrow availability or fee is supplied for CWFL and none was stated: a short sale cannot proceed without a securities borrow.',
      expect: { refused: 'no borrow availability data for CWFL' },
    },
    {
      id: 'short', covers: ['borrow', 'short'], action: 'ticket', instrument: 'main', side: 'sell_short', qty: 1000, as: 'short',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'borrow_sec', action: 'borrow_sec', instrument: 'main', qty: 1000, borrow: { available: true, feeRate: 0.0125, dailyCost: 2.78, source: 'Test fixture' } }, // 1,000 x 80.02 x 0.0125 / 360 = 2.7785
            { kind: 'trade', action: 'sell_short', instrument: 'main', qty: 1000, estimate: 80.00, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: 80_000, fees: 5, dependsOn: [1], // 1,000 x 80.00 (the bid); 1,000 x 0.005
              shortCollateral: { topUp: 1_600, marginHold: 24_000 } }, // 2% and 30% of 80,000
          ],
          cash: { USD: { purchases: 0, proceeds: 0, restrictedProceeds: 80_000, fees: 5, collateral: 1_600, margin: 24_000, required: 25_605, available: 500_000, shortfall: 0 } }, // 5 + 1,600 + 24,000
        },
        result: { status: 'open', orders: [
          { kind: 'borrow_sec', status: 'filled', filledQty: 1000 },
          { kind: 'trade', action: 'sell_short', status: 'filled', filledQty: 1000, avgPrice: 80.00, fills: [{ qty: 1000, price: 80.00, model: 'quoted-bid-ask', settleDate: '2026-03-03', source: 'Test fixture' }] },
        ] },
        events: [{ type: 'strategy.submitted' }, { type: 'secloan.borrow', summary: 'Borrowed 1,000 BWRG at a fee of 1.250% p.a.' }, { type: 'trade.fill', summary: 'Sold short 1,000 BWRG @ 80.00 USD' }],
        // Proceeds 80,000 less 5 commission are owed to the Account and will arrive as restricted cash.
        // Reserve: 0.30 x 1,000 x 80.02 = 24,006. Free cash to trade: 500,000 - 24,006 = 475,994.
        cash: { account: { USD: { settled: 500_000, unsettled: 79_995, restricted: 0, reserved: 24_006, availableToTrade: 475_994, availableToWithdraw: 475_994 } } },
        positions: [
          { instrument: 'borrow:main', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 1000, value: 80_020, accrued: 0 }, // value of the securities, 1,000 x 80.02
          { instrument: 'main', lot: 'short', owner: 'account', direction: 'short', qty: -1000, avgCost: 80, cost: -80_000, price: 80.02, value: -80_020, unrealized: -20, restrictedCash: 0 },
        ],
        holdings: { main: { long: 0, short: 1000, net: -1000 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-03', amount: 79_995, into: 'cash.restricted' }],
        lifecycle: [{ type: 'secloan.fee', instrument: 'borrow:main', dueDate: '2026-04-01', status: 'pending' }], // first business day of the next month
        borrowings: [{ owner: 'account', family: 'secloan', instrument: 'main', lot: 'short', qty: 1000, value: 80_020, rate: 0.0125, accrued: 0, collateralCash: null, nextPayment: '2026-04-01' }], // no collateral until the sale settles
        pnl: { account: { realized: 0, dividends: 0, commissions: -5, fees: 0, borrowFunding: 0, unrealized: -20, total: -25 } },
        nav: { account: 499_975, book: 999_975 },
        balance: { account: { cash: 500_000, receivable: 79_995, positions: -80_020, netAssets: 499_975 } },
      },
    },
    {
      id: 'settle-short', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        // Collateral required: 1.02 x 1,000 x 80.02 = 81,620.40. Proceeds received 79,995. Top-up from settled cash 1,625.40.
        events: [
          { type: 'settlement.receive', summary: 'received 79,995.00 USD into restricted cash' },
          { type: 'collateral.mark', summary: 'Short collateral on BWRG marked to market: posted 1,625.40 USD', cash: { USD: -1_625.40 } },
        ],
        cash: { account: { USD: { settled: 498_374.60, unsettled: 0, restricted: 81_620.40, reserved: 24_006, availableToTrade: 474_368.60, availableToWithdraw: 474_368.60 } } },
        positions: [{ instrument: 'borrow:main', qty: 1000, value: 80_020 }, { instrument: 'main', qty: -1000, value: -80_020, unrealized: -20, restrictedCash: 81_620.40 }],
        pending: [],
        borrowings: [{ instrument: 'main', qty: 1000, value: 80_020, accrued: 0, collateralCash: 81_620.40 }],
        balance: { account: { cash: 498_374.60, restricted: 81_620.40, receivable: null, positions: -80_020, netAssets: 499_975 } },
      },
    },
    {
      id: 'fee-day-1', covers: 'borrow fee', action: 'clock', to: AT_1730('2026-03-03'),
      expect: {
        events: [{ type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 BWRG: 2.78 USD' }], // 1,000 x 80.02 x 0.0125 / 360 = 2.7785
        positions: [{ instrument: 'borrow:main', qty: 1000, value: 80_020, accrued: -2.78 }, { instrument: 'main', qty: -1000, restrictedCash: 81_620.40 }],
        borrowings: [{ instrument: 'main', qty: 1000, accrued: 2.78, costToDate: 2.78, collateralCash: 81_620.40 }],
        pnl: { account: { borrowFunding: -2.78, total: -27.78 } },
        nav: { account: 499_972.22, book: 999_972.22 },
        balance: { account: { accruedExpense: 2.78, netAssets: 499_972.22 } },
      },
    },
    { id: 'next-morning', action: 'clock', to: WED, expect: {} },
    {
      id: 'price-up', action: 'quote', instrument: 'main', quote: { bid: 82.00, ask: 82.04, last: 82.02, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'borrow:main', qty: 1000, value: 82_020 }, { instrument: 'main', qty: -1000, price: 82.02, value: -82_020, unrealized: -2_020 }], // -82,020 + 80,000
        borrowings: [{ instrument: 'main', qty: 1000, value: 82_020, accrued: 2.78 }],
        pnl: { account: { unrealized: -2_020, total: -2_027.78 } },
        nav: { account: 497_972.22, book: 997_972.22 },
        balance: { account: { positions: -82_020, netAssets: 497_972.22 } },
      },
    },
    { id: 'dividend-recorded', covers: 'dividend compensation', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-03-05', amount: 0.40, expect: {} },
    {
      id: 'fee-day-2', covers: ['borrow fee', 'collateral mark'], action: 'clock', to: AT_1730('2026-03-04'),
      expect: {
        // Fee: 1,000 x 82.02 x 0.0125 / 360 = 2.8479; accrued so far 2.7785 + 2.8479 = 5.6264 -> 5.63, so 2.85 is added.
        // Collateral: 1.02 x 1,000 x 82.02 = 83,660.40; held 81,620.40; top-up 2,040.00. Reserve: 0.30 x 82,020 = 24,606.
        events: [
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 BWRG: 2.85 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on BWRG marked to market: posted 2,040.00 USD', cash: { USD: -2_040 } },
        ],
        cash: { account: { USD: { settled: 496_334.60, restricted: 83_660.40, reserved: 24_606, availableToTrade: 471_728.60, availableToWithdraw: 471_728.60 } } },
        positions: [{ instrument: 'borrow:main', qty: 1000, accrued: -5.63 }, { instrument: 'main', qty: -1000, restrictedCash: 83_660.40 }],
        borrowings: [{ instrument: 'main', qty: 1000, accrued: 5.63, costToDate: 5.63, collateralCash: 83_660.40 }],
        pnl: { account: { borrowFunding: -5.63, total: -2_030.63 } },
        nav: { account: 497_969.37, book: 997_969.37 },
        balance: { account: { cash: 496_334.60, restricted: 83_660.40, accruedExpense: 5.63, netAssets: 497_969.37 } },
      },
    },
    {
      id: 'dividend-compensation', covers: 'dividend compensation', action: 'clock', to: THU,
      expect: {
        events: [{ type: 'dividend.compensation', summary: 'Dividend compensation paid on 1,000 borrowed BWRG: 400.00 USD', cash: { USD: -400 } }], // 1,000 x 0.40, owed to the lender
        cash: { account: { USD: { settled: 495_934.60, availableToTrade: 471_328.60, availableToWithdraw: 471_328.60 } } },
        pnl: { account: { borrowFunding: -405.63, dividends: 0, total: -2_430.63 } },
        nav: { account: 497_569.37, book: 997_569.37 },
        balance: { account: { cash: 495_934.60, netAssets: 497_569.37 } },
      },
    },
    {
      // Settled 495,934.60 plus restricted 83,660.40 is 579,595.00, more than the 500,125.00 this purchase needs.
      // It must still be refused: only 495,934.60 - 24,606.00 reserve = 471,328.60 is free. Shortfall 28,796.40.
      id: 'buy-with-restricted-cash', covers: 'restricted proceeds', action: 'ticket', instrument: 'other', side: 'buy', qty: 5000,
      status: 'blocked', reason: 'Short-sale proceeds and the margin reserve are not buying power.',
      expect: { refused: /is short 28,796\.40 USD.*471,328\.60 USD is available/s },
    },
    {
      id: 'withdraw-restricted-cash', covers: 'restricted proceeds', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 480_000,
      status: 'blocked', reason: 'Restricted collateral and the margin reserve cannot leave the Account.',
      expect: { refused: 'Alpha has 471,328.60 USD of settled USD available; 480,000.00 USD requested' },
    },
    {
      id: 'price-down', action: 'quote', instrument: 'main', quote: { bid: 78.50, ask: 78.54, last: 78.52, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'borrow:main', qty: 1000, value: 78_520 }, { instrument: 'main', qty: -1000, price: 78.52, value: -78_520, unrealized: 1_480 }], // -78,520 + 80,000
        borrowings: [{ instrument: 'main', qty: 1000, value: 78_520, accrued: 5.63 }],
        pnl: { account: { unrealized: 1_480, total: 1_069.37 } }, // -5 - 405.63 + 1,480
        nav: { account: 501_069.37, book: 1_001_069.37 },
        balance: { account: { positions: -78_520, netAssets: 501_069.37 } },
      },
    },
    {
      id: 'cover-part', covers: ['cover', 'return'], action: 'ticket', instrument: 'main', side: 'buy_to_cover', qty: 400, from: 'short',
      expect: {
        preview: { blocking: 0, errors: [], legs: [
          { kind: 'trade', action: 'buy_to_cover', qty: 400, estimate: 78.54, settleDate: '2026-03-06', cash: -31_416, fees: 2 }, // 400 x 78.54 (the ask); 400 x 0.005
          { kind: 'return_sec', action: 'return_sec', qty: 400, dependsOn: [1] },
        ] },
        result: { status: 'open', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 400, avgPrice: 78.54 }, { kind: 'return_sec', status: 'filled', filledQty: 400 }] },
        // Realized: 400 x (80.00 - 78.54) = 584.00. Fee to today on the current price: 1,000 x 78.52 x 0.0125 / 360 = 2.7264;
        // accrued 5.6264 + 2.7264 = 8.3528 -> 8.35, so 2.72 is added.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought to cover 400 BWRG @ 78.54 USD (realized 584.00 USD)' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 BWRG: 2.72 USD' },
          { type: 'secloan.return', summary: 'Returned 400 borrowed BWRG' },
        ],
        // Owed for the cover: 31,416 + 2 = 31,418. Reserve: 0.30 x 600 x 78.52 = 14,133.60.
        cash: { account: { USD: { settled: 495_934.60, unsettled: -31_418, restricted: 83_660.40, reserved: 14_133.60, availableToTrade: 450_383, availableToWithdraw: 450_383 } } }, // 495,934.60 - 31,418 - 14,133.60
        positions: [
          { instrument: 'borrow:main', qty: 600, value: 47_112, accrued: -8.35 }, // 600 x 78.52
          { instrument: 'main', qty: -600, cost: -48_000, avgCost: 80, price: 78.52, value: -47_112, unrealized: 888, restrictedCash: 83_660.40 }, // -47,112 + 48,000
        ],
        holdings: { main: { long: 0, short: 600, net: -600 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-06', amount: -31_418, into: 'cash.restricted' }],
        borrowings: [{ instrument: 'main', qty: 600, value: 47_112, accrued: 8.35, costToDate: 8.35, collateralCash: 83_660.40 }],
        pnl: { account: { realized: 584, commissions: -7, borrowFunding: -408.35, unrealized: 888, total: 1_056.65 } },
        nav: { account: 501_056.65, book: 1_001_056.65 },
        balance: { account: { cash: 495_934.60, restricted: 83_660.40, positions: -47_112, payable: 31_418, accruedExpense: 8.35, netAssets: 501_056.65 } },
      },
    },
    {
      id: 'settle-cover-part', covers: ['settlement', 'collateral mark'], action: 'clock', to: FRI,
      expect: {
        // The cover is paid from restricted cash: 83,660.40 - 31,418 = 52,242.40 left. Required for the 600 still short:
        // 1.02 x 600 x 78.52 = 48,054.24. The surplus 4,188.16 is released to settled cash.
        events: [
          { type: 'settlement.pay', summary: 'paid 31,418.00 USD from restricted cash' },
          { type: 'collateral.mark', summary: 'Short collateral on BWRG marked to market: released 4,188.16 USD', cash: { USD: 4_188.16 } },
        ],
        cash: { account: { USD: { settled: 500_122.76, unsettled: 0, restricted: 48_054.24, reserved: 14_133.60, availableToTrade: 485_989.16, availableToWithdraw: 485_989.16 } } }, // 500,122.76 - 14,133.60
        positions: [{ instrument: 'borrow:main', qty: 600 }, { instrument: 'main', qty: -600, restrictedCash: 48_054.24 }],
        borrowings: [{ instrument: 'main', qty: 600, accrued: 8.35, collateralCash: 48_054.24 }],
        pending: [],
        balance: { account: { cash: 500_122.76, restricted: 48_054.24, payable: null, netAssets: 501_056.65 } },
      },
    },
    {
      id: 'cover-rest', covers: ['cover', 'return', 'close', 'borrow fee'], action: 'close', lot: 'short', scope: 'position', percent: 100, // the Close button on the short position itself
      expect: {
        preview: { blocking: 0, errors: [], legs: [
          { kind: 'trade', action: 'buy_to_cover', qty: 600, estimate: 78.54, settleDate: '2026-03-09', cash: -47_124, fees: 3 }, // 600 x 78.54; 600 x 0.005
          { kind: 'return_sec', action: 'return_sec', qty: 600, dependsOn: [1] },
        ] },
        result: { status: 'closed', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 600, avgPrice: 78.54 }, { kind: 'return_sec', status: 'filled', filledQty: 600 }] },
        // Realized: 48,000 - 47,124 = 876.00. Fee for one more day on 600: 600 x 78.52 x 0.0125 / 360 = 1.6358;
        // accrued 8.3528 + 1.6358 = 9.9886 -> 9.99, so 1.64 is added, and the whole 9.99 is paid now that the borrow is returned.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought to cover 600 BWRG @ 78.54 USD (realized 876.00 USD)' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 600 BWRG: 1.64 USD' },
          { type: 'secloan.return', summary: 'Returned 600 borrowed BWRG' },
          { type: 'interest.payment', summary: /Borrow fee paid on Borrow of BWRG.*: 9\.99 USD/, cash: { USD: -9.99 } },
        ],
        cash: { account: { USD: { settled: 500_112.77, unsettled: -47_127, restricted: 48_054.24, reserved: 0, availableToTrade: 452_985.77, availableToWithdraw: 452_985.77 } } }, // 500,122.76 - 9.99; 47,124 + 3 owed
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-03-09', amount: -47_127, into: 'cash.restricted' }],
        lifecycle: [],
        borrowings: [],
        pnl: { account: { realized: 1_460, commissions: -10, borrowFunding: -409.99, unrealized: 0, total: 1_040.01 } }, // 584 + 876; 400 + 9.99
        nav: { account: 501_040.01, book: 1_001_040.01 },
        balance: { account: { cash: 500_112.77, restricted: 48_054.24, positions: null, payable: 47_127, accruedExpense: null, netAssets: 501_040.01 } },
      },
    },
    {
      id: 'settle-cover-rest', covers: ['settlement', 'collateral release'], action: 'clock', to: MON2,
      expect: {
        // 48,054.24 - 47,127 = 927.24 of collateral is left with no short to secure: it is released.
        events: [
          { type: 'settlement.pay', summary: 'paid 47,127.00 USD from restricted cash' },
          { type: 'collateral.mark', summary: 'Short collateral on BWRG marked to market: released 927.24 USD', cash: { USD: 927.24 } },
        ],
        cash: { account: { USD: { settled: 501_040.01, unsettled: 0, restricted: 0, reserved: 0, availableToTrade: 501_040.01, availableToWithdraw: 501_040.01 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 501_040.01, restricted: null, payable: null, assets: 501_040.01, liabilities: 0, netAssets: 501_040.01 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// preferred_stock
// ---------------------------------------------------------------------------------------------
// Two separate purchases from the ticket: each is its own strategy instance and position, and the
// holding is shown gross across them. Commission here is 5 basis points of principal, no minimum.
const preferredStock = {
  productId: 'preferred_stock',
  title: 'Harbor Mutual Financial 6.25% Series A preferred, NYSE-listed, 25.00 par',
  matrix: {
    ...SECURITY_TICKET,
    manualInputs: ['preferred dividend (ex-date, amount per share), recorded by hand'],
    settlement: 'T+1 on the US equity calendar',
    lifecycle: 'Quarterly preferred dividend from the recorded corporate action, paid per position from the holding at the open of the ex-date',
    accounting: 'Average cost per position (two ticket purchases are two positions); commission in basis points of principal; dividend income',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix preferred stock', { fees: { equity: { perUnit: 0, minimum: 0, bps: 5 } } }),
  instruments: {
    main: { productId: 'preferred_stock', name: 'Harbor Mutual Financial 6.25% Series A Preferred', symbol: 'HMF.PRA', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Harbor Mutual Financial Corp.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  },
  quotes: { main: { bid: 24.80, ask: 24.84, last: 24.82, bidSize: 10000, askSize: 10000 } },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1000, as: 'lotA',
      expect: {
        preview: { blocking: 0, errors: [], warnings: [], legs: [{ action: 'buy', qty: 1000, estimate: 24.84, model: 'quoted-bid-ask', settleDate: '2026-03-03', calendar: 'US',
          cash: -24_840, // 1,000 x 24.84
          fees: 12.42 }], // 5 bp of 24,840
          cash: { USD: { purchases: 24_840, fees: 12.42, required: 24_852.42, available: 500_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1000, avgPrice: 24.84 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000 HMF.PRA @ 24.84 USD' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -24_852.42, availableToTrade: 475_147.58 } } },
        positions: [{ instrument: 'main', lot: 'lotA', owner: 'account', direction: 'long', qty: 1000, avgCost: 24.84, cost: 24_840, price: 24.82, value: 24_820, unrealized: -20 }],
        holdings: { main: { long: 1000, short: 0, net: 1000 } },
        pending: [{ instrument: 'main', lot: 'lotA', dueDate: '2026-03-03', amount: -24_852.42, into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -12.42, fees: 0, borrowFunding: 0, unrealized: -20, total: -32.42 } },
        nav: { account: 499_967.58, book: 999_967.58 },
        balance: { account: { cash: 500_000, positions: 24_820, payable: 24_852.42, assets: 524_820, liabilities: 24_852.42, netAssets: 499_967.58 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 24,852.42 USD from settled cash' }],
        cash: { account: { USD: { settled: 475_147.58, unsettled: 0, availableToTrade: 475_147.58 } } },
        pending: [],
        balance: { account: { cash: 475_147.58, payable: null, assets: 499_967.58, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'ticket', instrument: 'main', side: 'buy', qty: 400, as: 'lotB', // a second ticket purchase: a new position
      expect: {
        preview: { blocking: 0, errors: [], warnings: ['already-held'], // the preview says the Account already holds 1,000
          legs: [{ action: 'buy', qty: 400, estimate: 24.84, settleDate: '2026-03-04', cash: -9_936, fees: 4.97 }] }, // 400 x 24.84; 5 bp of 9,936 = 4.968
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 400, avgPrice: 24.84 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 400 HMF.PRA @ 24.84 USD' }],
        cash: { account: { USD: { settled: 475_147.58, unsettled: -9_940.97, availableToTrade: 465_206.61 } } },
        positions: [
          { instrument: 'main', lot: 'lotA', qty: 1000, cost: 24_840, avgCost: 24.84, value: 24_820, unrealized: -20 },
          { instrument: 'main', lot: 'lotB', qty: 400, cost: 9_936, avgCost: 24.84, price: 24.82, value: 9_928, unrealized: -8 }, // 400 x 24.82
        ],
        holdings: { main: { long: 1400, short: 0, net: 1400 } }, // gross across the two positions
        pending: [{ instrument: 'main', lot: 'lotB', dueDate: '2026-03-04', amount: -9_940.97, into: 'cash' }],
        pnl: { account: { commissions: -17.39, unrealized: -28, total: -45.39 } },
        nav: { account: 499_954.61, book: 999_954.61 },
        balance: { account: { cash: 475_147.58, positions: 34_748, payable: 9_940.97, assets: 509_895.58, liabilities: 9_940.97, netAssets: 499_954.61 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: WED,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 9,940.97 USD' }],
        cash: { account: { USD: { settled: 465_206.61, unsettled: 0, availableToTrade: 465_206.61 } } },
        pending: [],
        balance: { account: { cash: 465_206.61, payable: null, assets: 499_954.61, liabilities: 0 } },
      },
    },
    { id: 'dividend-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-03-05', amount: 0.390625, expect: {} }, // 6.25% x 25.00 / 4
    {
      id: 'dividend-paid', covers: 'dividend', action: 'clock', to: THU,
      expect: {
        // Paid per position: 1,000 x 0.390625 = 390.625 -> 390.63, and 400 x 0.390625 = 156.25. Together 546.88.
        events: [
          { type: 'dividend', summary: 'Dividend on 1,000 HMF.PRA: 390.63 USD (0.390625 per unit, ex-date 2026-03-05)', cash: { USD: 390.63 }, lot: 'lotA' },
          { type: 'dividend', summary: 'Dividend on 400 HMF.PRA: 156.25 USD', cash: { USD: 156.25 }, lot: 'lotB' },
        ],
        cash: { account: { USD: { settled: 465_753.49, availableToTrade: 465_753.49 } } },
        pnl: { account: { dividends: 546.88, total: 501.49 } }, // -17.39 + 546.88 - 28
        nav: { account: 500_501.49, book: 1_000_501.49 },
        balance: { account: { cash: 465_753.49, assets: 500_501.49, netAssets: 500_501.49 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 25.10, ask: 25.14, last: 25.12, bidSize: 10000, askSize: 10000 },
      expect: {
        positions: [
          { instrument: 'main', lot: 'lotA', qty: 1000, price: 25.12, value: 25_120, unrealized: 280 },
          { instrument: 'main', lot: 'lotB', qty: 400, price: 25.12, value: 10_048, unrealized: 112 },
        ],
        pnl: { account: { unrealized: 392, total: 921.49 } },
        nav: { account: 500_921.49, book: 1_000_921.49 },
        balance: { account: { positions: 35_168, assets: 500_921.49, netAssets: 500_921.49 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 600, from: 'lotA',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 600, estimate: 25.10, settleDate: '2026-03-06', cash: 15_060, fees: 7.53 }] }, // 600 x 25.10; 5 bp
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 600, avgPrice: 25.10 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 600 HMF.PRA @ 25.10 USD (realized 156.00 USD)' }], // 600 x (25.10 - 24.84)
        cash: { account: { USD: { settled: 465_753.49, unsettled: 15_052.47, availableToTrade: 480_805.96 } } },
        positions: [
          { instrument: 'main', lot: 'lotA', qty: 400, cost: 9_936, avgCost: 24.84, value: 10_048, unrealized: 112 },
          { instrument: 'main', lot: 'lotB', qty: 400, cost: 9_936, value: 10_048, unrealized: 112 },
        ],
        holdings: { main: { long: 800, short: 0, net: 800 } },
        pending: [{ instrument: 'main', lot: 'lotA', dueDate: '2026-03-06', amount: 15_052.47, into: 'cash' }],
        pnl: { account: { realized: 156, commissions: -24.92, dividends: 546.88, unrealized: 224, total: 901.96 } },
        nav: { account: 500_901.96, book: 1_000_901.96 },
        balance: { account: { cash: 465_753.49, receivable: 15_052.47, positions: 20_096, assets: 500_901.96, liabilities: 0, netAssets: 500_901.96 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: FRI,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 15,052.47 USD into settled cash' }],
        cash: { account: { USD: { settled: 480_805.96, unsettled: 0, availableToTrade: 480_805.96 } } },
        pending: [],
        balance: { account: { cash: 480_805.96, receivable: null } },
      },
    },
    {
      id: 'close-first', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 400, from: 'lotA',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 400, estimate: 25.10, settleDate: '2026-03-09', cash: 10_040, fees: 5.02 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 400 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 400 HMF.PRA @ 25.10 USD (realized 104.00 USD)' }],
        cash: { account: { USD: { settled: 480_805.96, unsettled: 10_034.98, availableToTrade: 490_840.94 } } },
        positions: [{ instrument: 'main', lot: 'lotB', qty: 400, cost: 9_936, value: 10_048, unrealized: 112 }],
        holdings: { main: { long: 400, short: 0, net: 400 } },
        pending: [{ instrument: 'main', lot: 'lotA', dueDate: '2026-03-09', amount: 10_034.98, into: 'cash' }],
        pnl: { account: { realized: 260, commissions: -29.94, unrealized: 112, total: 888.94 } },
        nav: { account: 500_888.94, book: 1_000_888.94 },
        balance: { account: { cash: 480_805.96, receivable: 10_034.98, positions: 10_048, assets: 500_888.94, netAssets: 500_888.94 } },
      },
    },
    {
      id: 'close-second', covers: 'close', action: 'close', lot: 'lotB', scope: 'position', percent: 100, // the Close button on the position
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 400, estimate: 25.10, settleDate: '2026-03-09', cash: 10_040, fees: 5.02 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 400 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 400 HMF.PRA @ 25.10 USD (realized 104.00 USD)' }],
        cash: { account: { USD: { settled: 480_805.96, unsettled: 20_069.96, availableToTrade: 500_875.92 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lotA', dueDate: '2026-03-09', amount: 10_034.98 }, { instrument: 'main', lot: 'lotB', dueDate: '2026-03-09', amount: 10_034.98 }],
        pnl: { account: { realized: 364, commissions: -34.96, dividends: 546.88, unrealized: 0, total: 875.92 } },
        nav: { account: 500_875.92, book: 1_000_875.92 },
        balance: { account: { cash: 480_805.96, receivable: 20_069.96, positions: null, assets: 500_875.92, netAssets: 500_875.92 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MON2,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 10,034.98 USD' }, { type: 'settlement.receive', summary: 'received 10,034.98 USD' }],
        cash: { account: { USD: { settled: 500_875.92, unsettled: 0, availableToTrade: 500_875.92 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 500_875.92, receivable: null, assets: 500_875.92, liabilities: 0, netAssets: 500_875.92 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// gdr
// ---------------------------------------------------------------------------------------------
// A London-listed, US dollar depositary receipt. The listing venue (GB) decides the calendar and the
// settlement lag: T+2 on England and Wales business days. The first purchase is made on Thursday
// 2 April 2026 so that settlement has to step over Good Friday (3 April) and Easter Monday (6 April),
// both London holidays: T+1 is Tuesday 7 April and T+2 is Wednesday 8 April.
// Commission: 10 basis points of principal, at least 5.00 an order.
const APR = (d) => `2026-04-${d}T14:00:00.000Z`; // 10:00 New York in April (daylight time)
const gdr = {
  productId: 'gdr',
  title: 'Anatolia Cement GDR, London-listed in US dollars, Turkish issuer',
  matrix: {
    ...SECURITY_TICKET,
    manualInputs: ['cash dividend (ex-date, amount per GDR), recorded by hand', 'depositary fee, recorded by hand as a manual cash flow of kind Fee on the position'],
    settlement: 'T+2 on the London calendar (Book setting settlement.foreignCash = 2); Good Friday and Easter Monday are skipped',
    lifecycle: 'Cash dividend from the recorded corporate action; depositary fee by hand',
    accounting: 'Average cost; commission in basis points with a minimum per order; dividend income; depositary fee booked as a fee',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 2, holidays: ['2026-04-03', '2026-04-06'] }, // London: Good Friday and Easter Monday 2026
  book: book('Matrix GDR', { fees: { equity: { perUnit: 0, minimum: 5, bps: 10 } } }),
  instruments: {
    main: { productId: 'gdr', name: 'Anatolia Cement GDR', symbol: 'ANCG', marketView: 'FOREIGN_CASH', venue: 'London Stock Exchange', venueType: 'exchange', venueCountry: 'GB', issuer: 'Anatolia Cement Sanayi A.S.', domicile: 'TR', underlyingGeo: 'TR', tradingCcy: 'USD', terms: {} },
  },
  quotes: { main: { bid: 12.30, ask: 12.36, last: 12.33, bidSize: 20000, askSize: 20000 } },
  expectAtStart: START_STATE,
  steps: [
    { id: 'to-april', action: 'clock', to: APR('02'), expect: {} },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1000, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ action: 'buy', qty: 1000, estimate: 12.36, model: 'quoted-bid-ask', settleDate: '2026-04-08', calendar: 'UK',
          cash: -12_360, // 1,000 x 12.36
          fees: 12.36 }], // 10 bp of 12,360
          cash: { USD: { purchases: 12_360, fees: 12.36, required: 12_372.36, available: 500_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1000, avgPrice: 12.36, fills: [{ qty: 1000, price: 12.36, settleDate: '2026-04-08' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000 ANCG @ 12.36 USD', date: '2026-04-02' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -12_372.36, availableToTrade: 487_627.64 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1000, avgCost: 12.36, cost: 12_360, price: 12.33, value: 12_330, unrealized: -30 }],
        holdings: { main: { long: 1000, short: 0, net: 1000 } },
        pending: [{ instrument: 'main', dueDate: '2026-04-08', amount: -12_372.36, into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -12.36, fees: 0, borrowFunding: 0, unrealized: -30, total: -42.36 } },
        nav: { account: 499_957.64, book: 999_957.64 },
        balance: { account: { cash: 500_000, positions: 12_330, payable: 12_372.36, assets: 512_330, liabilities: 12_372.36, netAssets: 499_957.64 } },
      },
    },
    { id: 'holiday-not-settled', covers: 'settlement', action: 'clock', to: APR('07'), expect: {} }, // Tuesday 7 April is only T+1 in London: nothing moves
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: APR('08'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 12,372.36 USD from settled cash', date: '2026-04-08' }],
        cash: { account: { USD: { settled: 487_627.64, unsettled: 0, availableToTrade: 487_627.64 } } },
        pending: [],
        balance: { account: { cash: 487_627.64, payable: null, assets: 499_957.64, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 1,000 -> 1,500
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', qty: 500, estimate: 12.36, settleDate: '2026-04-10', cash: -6_180, fees: 6.18 }] }, // 500 x 12.36; 10 bp
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 500, avgPrice: 12.36 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 500 ANCG @ 12.36 USD' }],
        cash: { account: { USD: { settled: 487_627.64, unsettled: -6_186.18, availableToTrade: 481_441.46 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1500, cost: 18_540, avgCost: 12.36, price: 12.33, value: 18_495, unrealized: -45 }],
        holdings: { main: { long: 1500, short: 0, net: 1500 } },
        pending: [{ instrument: 'main', dueDate: '2026-04-10', amount: -6_186.18, into: 'cash' }],
        pnl: { account: { commissions: -18.54, unrealized: -45, total: -63.54 } },
        nav: { account: 499_936.46, book: 999_936.46 },
        balance: { account: { cash: 487_627.64, positions: 18_495, payable: 6_186.18, assets: 506_122.64, liabilities: 6_186.18, netAssets: 499_936.46 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: APR('10'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 6,186.18 USD' }],
        cash: { account: { USD: { settled: 481_441.46, unsettled: 0, availableToTrade: 481_441.46 } } },
        pending: [],
        balance: { account: { cash: 481_441.46, payable: null, assets: 499_936.46, liabilities: 0 } },
      },
    },
    { id: 'dividend-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-04-13', amount: 0.18, expect: {} },
    {
      id: 'dividend-paid', covers: 'dividend', action: 'clock', to: APR('13'),
      expect: {
        events: [{ type: 'dividend', summary: 'Dividend on 1,500 ANCG: 270.00 USD (0.18 per unit, ex-date 2026-04-13)', cash: { USD: 270 } }], // 1,500 x 0.18
        cash: { account: { USD: { settled: 481_711.46, availableToTrade: 481_711.46 } } },
        pnl: { account: { dividends: 270, total: 206.46 } },
        nav: { account: 500_206.46, book: 1_000_206.46 },
        balance: { account: { cash: 481_711.46, assets: 500_206.46, netAssets: 500_206.46 } },
      },
    },
    {
      id: 'depositary-fee', covers: 'depositary fee', action: 'cashflow', lot: 'lot', category: 'fee', amount: -15, note: 'Depositary fee, 0.01 per GDR', // 1,500 x 0.01
      expect: {
        events: [{ type: 'manual.cashflow', summary: 'Manual fee on ANCG: paid 15.00 USD. Depositary fee, 0.01 per GDR', cash: { USD: -15 } }],
        cash: { account: { USD: { settled: 481_696.46, availableToTrade: 481_696.46 } } },
        pnl: { account: { fees: -15, total: 191.46 } },
        nav: { account: 500_191.46, book: 1_000_191.46 },
        balance: { account: { cash: 481_696.46, assets: 500_191.46, netAssets: 500_191.46 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 12.90, ask: 12.96, last: 12.93, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1500, price: 12.93, value: 19_395, unrealized: 855 }], // 1,500 x 12.93 - 18,540
        pnl: { account: { unrealized: 855, total: 1_091.46 } },
        nav: { account: 501_091.46, book: 1_001_091.46 },
        balance: { account: { positions: 19_395, assets: 501_091.46, netAssets: 501_091.46 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 300, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 300, estimate: 12.90, settleDate: '2026-04-15', cash: 3_870, fees: 5 }] }, // 300 x 12.90; 10 bp = 3.87, raised to the 5.00 minimum
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 300, avgPrice: 12.90 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 300 ANCG @ 12.90 USD (realized 162.00 USD)' }], // 300 x (12.90 - 12.36)
        cash: { account: { USD: { settled: 481_696.46, unsettled: 3_865, availableToTrade: 485_561.46 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1200, cost: 14_832, avgCost: 12.36, price: 12.93, value: 15_516, unrealized: 684 }],
        holdings: { main: { long: 1200, short: 0, net: 1200 } },
        pending: [{ instrument: 'main', dueDate: '2026-04-15', amount: 3_865, into: 'cash' }],
        pnl: { account: { realized: 162, commissions: -23.54, dividends: 270, fees: -15, unrealized: 684, total: 1_077.46 } },
        nav: { account: 501_077.46, book: 1_001_077.46 },
        balance: { account: { cash: 481_696.46, receivable: 3_865, positions: 15_516, assets: 501_077.46, liabilities: 0, netAssets: 501_077.46 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: APR('15'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 3,865.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 485_561.46, unsettled: 0, availableToTrade: 485_561.46 } } },
        pending: [],
        balance: { account: { cash: 485_561.46, receivable: null } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 1200, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 1200, estimate: 12.90, settleDate: '2026-04-17', cash: 15_480, fees: 15.48 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1200, avgPrice: 12.90 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1,200 ANCG @ 12.90 USD (realized 648.00 USD)' }],
        cash: { account: { USD: { settled: 485_561.46, unsettled: 15_464.52, availableToTrade: 501_025.98 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-04-17', amount: 15_464.52, into: 'cash' }],
        pnl: { account: { realized: 810, commissions: -39.02, dividends: 270, fees: -15, unrealized: 0, total: 1_025.98 } },
        nav: { account: 501_025.98, book: 1_001_025.98 },
        balance: { account: { cash: 485_561.46, receivable: 15_464.52, positions: null, assets: 501_025.98, netAssets: 501_025.98 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: APR('17'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 15,464.52 USD into settled cash' }],
        cash: { account: { USD: { settled: 501_025.98, unsettled: 0, availableToTrade: 501_025.98 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 501_025.98, receivable: null, assets: 501_025.98, liabilities: 0, netAssets: 501_025.98 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// etf
// ---------------------------------------------------------------------------------------------
// A limit order that waits and then fills when the quote comes down to it; two positions from two
// tickets; a sale that names which position it sells from; and a sale refused because the chosen
// position is smaller than the quantity, even though the Account holds enough in total.
const etf = {
  productId: 'etf',
  title: 'Meridian Total Market ETF, NYSE Arca-listed',
  matrix: {
    ...SECURITY_TICKET,
    requiredFields: ['Account', 'Action', 'Shares', 'Order type and Limit price for the limit order', 'Sell from (when the Account holds the fund in more than one position)'],
    manualInputs: ['cash distribution (ex-date, amount per share), recorded by hand'],
    settlement: 'T+1 on the US equity calendar',
    lifecycle: 'A working limit order fills on a later engine cycle once the ask reaches the limit; cash distribution per position from the recorded corporate action',
    accounting: 'Nothing is booked while an order only works; average cost per position; sales reduce the position named on the ticket',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix ETF'),
  instruments: {
    main: { productId: 'etf', name: 'Meridian Total Market ETF', symbol: 'MTMK', marketView: 'US_CASH', venue: 'NYSE Arca', venueType: 'exchange', venueCountry: 'US', issuer: 'Meridian Index Funds Trust', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  },
  quotes: { main: { bid: 100.00, ask: 100.04, last: 100.02, bidSize: 5000, askSize: 5000 } },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'limit-order-works', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 150, as: 'lotA', order: { orderType: 'limit', limitPrice: 99.50, tif: 'gtc' },
      expect: {
        // The ask is 100.04, above the 99.50 limit: the order is accepted and waits. Nothing is booked.
        preview: { blocking: 0, errors: [], legs: [{ action: 'buy', qty: 150, orderType: 'limit', executable: false, settleDate: '2026-03-03' }] },
        result: { status: 'working', orders: [{ action: 'buy', status: 'working', filledQty: 0, reason: /Limit not reached/, fills: [] }] },
        events: [{ type: 'strategy.submitted' }],
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'buy', status: 'working', qty: 150, filledQty: 0 }],
        cash: { account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000 } } },
        positions: [], pending: [],
        pnl: { account: { realized: 0, dividends: 0, commissions: 0, fees: 0, borrowFunding: 0, unrealized: 0, total: 0 } },
        nav: { account: 500_000, book: 1_000_000 },
        balance: { account: { cash: 500_000, assets: 500_000, liabilities: 0, netAssets: 500_000 } },
      },
    },
    {
      id: 'limit-order-fills', covers: 'open', action: 'quote', instrument: 'main', quote: { bid: 99.44, ask: 99.48, last: 99.46, bidSize: 5000, askSize: 5000 },
      expect: {
        // The next engine cycle finds the ask at 99.48, inside the limit, and fills there.
        // The fill is 0.56% below the 100.04 the preview showed (99.48 / 100.04 - 1 = -0.5598%), outside the Book's
        // 0.5% confirmation tolerance, so the difference is recorded as its own history event.
        events: [{ type: 'trade.fill', summary: 'Bought 150 MTMK @ 99.48 USD', lot: 'lotA' }, { type: 'order.fill_variance', summary: /99\.48 against 100\.04 confirmed \(-0\.5598%\)/ }],
        openOrders: [],
        cash: { account: { USD: { settled: 500_000, unsettled: -14_923, availableToTrade: 485_077 } } }, // 150 x 99.48 = 14,922 plus 1.00 (0.75 raised to the minimum)
        positions: [{ instrument: 'main', lot: 'lotA', owner: 'account', direction: 'long', qty: 150, avgCost: 99.48, cost: 14_922, price: 99.46, value: 14_919, unrealized: -3 }],
        holdings: { main: { long: 150, short: 0, net: 150 } },
        pending: [{ instrument: 'main', lot: 'lotA', dueDate: '2026-03-03', amount: -14_923, into: 'cash' }],
        pnl: { account: { commissions: -1, unrealized: -3, total: -4 } },
        nav: { account: 499_996, book: 999_996 },
        balance: { account: { cash: 500_000, positions: 14_919, payable: 14_923, assets: 514_919, liabilities: 14_923, netAssets: 499_996 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 14,923.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 485_077, unsettled: 0, availableToTrade: 485_077 } } },
        pending: [],
        balance: { account: { cash: 485_077, payable: null, assets: 499_996, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'ticket', instrument: 'main', side: 'buy', qty: 250, as: 'lotB',
      expect: {
        preview: { blocking: 0, errors: [], warnings: ['already-held'], legs: [{ action: 'buy', qty: 250, estimate: 99.48, settleDate: '2026-03-04', cash: -24_870, fees: 1.25 }] }, // 250 x 99.48; 250 x 0.005
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 250, avgPrice: 99.48 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 250 MTMK @ 99.48 USD' }],
        cash: { account: { USD: { settled: 485_077, unsettled: -24_871.25, availableToTrade: 460_205.75 } } },
        positions: [
          { instrument: 'main', lot: 'lotA', qty: 150, cost: 14_922, value: 14_919, unrealized: -3 },
          { instrument: 'main', lot: 'lotB', qty: 250, cost: 24_870, avgCost: 99.48, price: 99.46, value: 24_865, unrealized: -5 },
        ],
        holdings: { main: { long: 400, short: 0, net: 400 } },
        pending: [{ instrument: 'main', lot: 'lotB', dueDate: '2026-03-04', amount: -24_871.25, into: 'cash' }],
        pnl: { account: { commissions: -2.25, unrealized: -8, total: -10.25 } },
        nav: { account: 499_989.75, book: 999_989.75 },
        balance: { account: { cash: 485_077, positions: 39_784, payable: 24_871.25, assets: 524_861, liabilities: 24_871.25, netAssets: 499_989.75 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: WED,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 24,871.25 USD' }],
        cash: { account: { USD: { settled: 460_205.75, unsettled: 0, availableToTrade: 460_205.75 } } },
        pending: [],
        balance: { account: { cash: 460_205.75, payable: null, assets: 499_989.75, liabilities: 0 } },
      },
    },
    { id: 'distribution-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-03-05', amount: 0.45, expect: {} },
    {
      id: 'distribution-paid', covers: 'dividend', action: 'clock', to: THU,
      expect: {
        events: [
          { type: 'dividend', summary: 'Dividend on 150 MTMK: 67.50 USD', cash: { USD: 67.50 }, lot: 'lotA' }, // 150 x 0.45
          { type: 'dividend', summary: 'Dividend on 250 MTMK: 112.50 USD', cash: { USD: 112.50 }, lot: 'lotB' }, // 250 x 0.45
        ],
        cash: { account: { USD: { settled: 460_385.75, availableToTrade: 460_385.75 } } },
        pnl: { account: { dividends: 180, total: 169.75 } },
        nav: { account: 500_169.75, book: 1_000_169.75 },
        balance: { account: { cash: 460_385.75, assets: 500_169.75, netAssets: 500_169.75 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 101.20, ask: 101.24, last: 101.22, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [
          { instrument: 'main', lot: 'lotA', qty: 150, price: 101.22, value: 15_183, unrealized: 261 }, // 150 x 101.22 - 14,922
          { instrument: 'main', lot: 'lotB', qty: 250, price: 101.22, value: 25_305, unrealized: 435 }, // 250 x 101.22 - 24,870
        ],
        pnl: { account: { unrealized: 696, total: 873.75 } },
        nav: { account: 500_873.75, book: 1_000_873.75 },
        balance: { account: { positions: 40_488, assets: 500_873.75, netAssets: 500_873.75 } },
      },
    },
    {
      id: 'sell-more-than-the-position', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 200, from: 'lotA',
      status: 'blocked', reason: 'The position chosen on the ticket holds 150. The other 250 are a different position and are not sold by this ticket.',
      expect: { refused: 'more than it holds' },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 100, from: 'lotB', // "Sell from": the second position
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 100, estimate: 101.20, settleDate: '2026-03-06', cash: 10_120, fees: 1 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 100, avgPrice: 101.20 }] },
        events: [{ type: 'strategy.legs_added', lot: 'lotB' }, { type: 'trade.fill', summary: 'Sold 100 MTMK @ 101.20 USD (realized 172.00 USD)', lot: 'lotB' }], // 100 x (101.20 - 99.48)
        cash: { account: { USD: { settled: 460_385.75, unsettled: 10_119, availableToTrade: 470_504.75 } } },
        positions: [
          { instrument: 'main', lot: 'lotA', qty: 150, cost: 14_922, value: 15_183, unrealized: 261 },
          { instrument: 'main', lot: 'lotB', qty: 150, cost: 14_922, avgCost: 99.48, value: 15_183, unrealized: 261 },
        ],
        holdings: { main: { long: 300, short: 0, net: 300 } },
        pending: [{ instrument: 'main', lot: 'lotB', dueDate: '2026-03-06', amount: 10_119, into: 'cash' }],
        pnl: { account: { realized: 172, commissions: -3.25, dividends: 180, unrealized: 522, total: 870.75 } },
        nav: { account: 500_870.75, book: 1_000_870.75 },
        balance: { account: { cash: 460_385.75, receivable: 10_119, positions: 30_366, assets: 500_870.75, liabilities: 0, netAssets: 500_870.75 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: FRI,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 10,119.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 470_504.75, unsettled: 0, availableToTrade: 470_504.75 } } },
        pending: [],
        balance: { account: { cash: 470_504.75, receivable: null } },
      },
    },
    {
      id: 'close-first', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 150, from: 'lotA',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 150, estimate: 101.20, settleDate: '2026-03-09', cash: 15_180, fees: 1 }] }, // 150 x 101.20; 0.75 raised to 1.00
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 150 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 150 MTMK @ 101.20 USD (realized 258.00 USD)' }],
        cash: { account: { USD: { settled: 470_504.75, unsettled: 15_179, availableToTrade: 485_683.75 } } },
        positions: [{ instrument: 'main', lot: 'lotB', qty: 150, cost: 14_922, value: 15_183, unrealized: 261 }],
        holdings: { main: { long: 150, short: 0, net: 150 } },
        pending: [{ instrument: 'main', lot: 'lotA', dueDate: '2026-03-09', amount: 15_179, into: 'cash' }],
        pnl: { account: { realized: 430, commissions: -4.25, unrealized: 261, total: 866.75 } },
        nav: { account: 500_866.75, book: 1_000_866.75 },
        balance: { account: { cash: 470_504.75, receivable: 15_179, positions: 15_183, assets: 500_866.75, netAssets: 500_866.75 } },
      },
    },
    {
      id: 'close-second', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 150, from: 'lotB',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 150, estimate: 101.20, settleDate: '2026-03-09', cash: 15_180, fees: 1 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 150 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 150 MTMK @ 101.20 USD (realized 258.00 USD)' }],
        cash: { account: { USD: { settled: 470_504.75, unsettled: 30_358, availableToTrade: 500_862.75 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lotA', dueDate: '2026-03-09', amount: 15_179 }, { instrument: 'main', lot: 'lotB', dueDate: '2026-03-09', amount: 15_179 }],
        pnl: { account: { realized: 688, commissions: -5.25, dividends: 180, unrealized: 0, total: 862.75 } },
        nav: { account: 500_862.75, book: 1_000_862.75 },
        balance: { account: { cash: 470_504.75, receivable: 30_358, positions: null, assets: 500_862.75, netAssets: 500_862.75 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MON2,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 15,179.00 USD' }, { type: 'settlement.receive', summary: 'received 15,179.00 USD' }],
        cash: { account: { USD: { settled: 500_862.75, unsettled: 0, availableToTrade: 500_862.75 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 500_862.75, receivable: null, assets: 500_862.75, liabilities: 0, netAssets: 500_862.75 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// etn
// ---------------------------------------------------------------------------------------------
// An exchange-traded note is an unsecured debt of its issuer. The Terminal does not simulate an issuer
// credit event: the catalog says it is recorded by hand. Here the quotes stop (the position becomes
// unpriced and the net asset value provisional), a recovery mark is entered by hand, and the final
// recovery is booked as a sale at a stated price.
const etn = {
  productId: 'etn',
  title: 'Calder Bank Commodity Index ETN due 2031, NYSE Arca-listed',
  matrix: {
    ...SECURITY_TICKET,
    requiredFields: ['Account', 'Action', 'Shares', 'State a fill price (for the recovery recorded by hand)'],
    manualInputs: ['manual price after quotes stop (Instrument drawer, Overview, Enter a price by hand)', 'issuer credit event: final recovery recorded as a sale at a stated fill price'],
    settlement: 'T+1 on the US equity calendar',
    lifecycle: 'No scheduled events. Issuer redemption and credit events are not simulated; recorded by hand',
    accounting: 'Average cost; a position with no price is carried at cost and the net asset value is marked provisional; a manual price is labelled manual; a stated-price fill is recorded as a manual input',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix ETN'),
  instruments: {
    main: { productId: 'etn', name: 'Calder Bank Commodity Index ETN due 2031', symbol: 'CBCI', marketView: 'US_CASH', venue: 'NYSE Arca', venueType: 'exchange', venueCountry: 'US', issuer: 'Calder Bank plc', domicile: 'GB', underlyingGeo: 'Global commodities', tradingCcy: 'USD', terms: {} },
  },
  quotes: { main: { bid: 20.00, ask: 20.04, last: 20.02, bidSize: 5000, askSize: 5000 } },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 600, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ action: 'buy', qty: 600, estimate: 20.04, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -12_024, fees: 3 }], // 600 x 20.04; 600 x 0.005
          cash: { USD: { purchases: 12_024, fees: 3, required: 12_027, available: 500_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 600, avgPrice: 20.04 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 600 CBCI @ 20.04 USD' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -12_027, availableToTrade: 487_973 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 600, avgCost: 20.04, cost: 12_024, price: 20.02, value: 12_012, unrealized: -12, provisional: false, priceSource: 'Test fixture' }],
        holdings: { main: { long: 600, short: 0, net: 600 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-03', amount: -12_027, into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -3, fees: 0, borrowFunding: 0, unrealized: -12, total: -15, complete: true } },
        nav: { account: 499_985, book: 999_985 },
        balance: { account: { cash: 500_000, positions: 12_012, payable: 12_027, assets: 512_012, liabilities: 12_027, netAssets: 499_985 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 12,027.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 487_973, unsettled: 0, availableToTrade: 487_973 } } },
        pending: [],
        balance: { account: { cash: 487_973, payable: null, assets: 499_985, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 600 -> 900
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', qty: 300, estimate: 20.04, settleDate: '2026-03-04', cash: -6_012, fees: 1.50 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 300, avgPrice: 20.04 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 300 CBCI @ 20.04 USD' }],
        cash: { account: { USD: { settled: 487_973, unsettled: -6_013.50, availableToTrade: 481_959.50 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 900, cost: 18_036, avgCost: 20.04, price: 20.02, value: 18_018, unrealized: -18 }],
        holdings: { main: { long: 900, short: 0, net: 900 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-04', amount: -6_013.50, into: 'cash' }],
        pnl: { account: { commissions: -4.50, unrealized: -18, total: -22.50 } },
        nav: { account: 499_977.50, book: 999_977.50 },
        balance: { account: { cash: 487_973, positions: 18_018, payable: 6_013.50, assets: 505_991, liabilities: 6_013.50, netAssets: 499_977.50 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: WED,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 6,013.50 USD' }],
        cash: { account: { USD: { settled: 481_959.50, unsettled: 0, availableToTrade: 481_959.50 } } },
        pending: [],
        balance: { account: { cash: 481_959.50, payable: null, assets: 499_977.50, liabilities: 0 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 300, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 300, estimate: 20.00, settleDate: '2026-03-05', cash: 6_000, fees: 1.50 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 300, avgPrice: 20.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 300 CBCI @ 20.00 USD (realized -12.00 USD)' }], // 300 x (20.00 - 20.04)
        cash: { account: { USD: { settled: 481_959.50, unsettled: 5_998.50, availableToTrade: 487_958 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 600, cost: 12_024, avgCost: 20.04, price: 20.02, value: 12_012, unrealized: -12 }],
        holdings: { main: { long: 600, short: 0, net: 600 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-05', amount: 5_998.50, into: 'cash' }],
        pnl: { account: { realized: -12, commissions: -6, unrealized: -12, total: -30 } },
        nav: { account: 499_970, book: 999_970 },
        balance: { account: { cash: 481_959.50, receivable: 5_998.50, positions: 12_012, assets: 499_970, liabilities: 0, netAssets: 499_970 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: THU,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 5,998.50 USD into settled cash' }],
        cash: { account: { USD: { settled: 487_958, unsettled: 0, availableToTrade: 487_958 } } },
        pending: [],
        balance: { account: { cash: 487_958, receivable: null } },
      },
    },
    {
      id: 'issuer-redemption-not-automated', covers: 'issuer credit event', action: 'lifecycle', lot: 'lot', body: { action: 'redeem', price: 100, face: 600 },
      status: 'unsupported', reason: 'An issuer redemption or credit-event settlement of an ETN is not simulated. It is recorded by hand as a sale at a stated price.',
      expect: { refused: { api: 'Early redemption does not apply to this position', browser: 'offers only: Manual cash flow' } },
    },
    {
      id: 'quotes-stop', covers: 'issuer credit event', action: 'quote', instrument: 'main', quote: { clear: true },
      expect: {
        // No price: the position is carried at cost (12,024), its value and unrealized P&L are missing, and every
        // figure that rests on it is marked provisional. Nothing is shown as zero in its place.
        positions: [{ instrument: 'main', lot: 'lot', qty: 600, cost: 12_024, price: null, value: null, unrealized: null, provisional: true, priceSource: null }],
        pnl: { account: { unrealized: 0, total: -18, complete: false } }, // only what is known: -12 realized and -6 commission
        nav: { account: 499_982, book: 999_982 }, // 487,958 cash + 12,024 at cost
        provisional: { account: true, book: true },
        balance: { account: { positions: 12_024, assets: 499_982, netAssets: 499_982 } },
      },
    },
    {
      id: 'manual-mark', covers: 'issuer credit event', action: 'manual_price', instrument: 'main', value: 6.00, note: 'Indicative recovery after the issuer default notice',
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 600, price: 6, value: 3_600, unrealized: -8_424, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }], // 600 x 6.00 - 12,024
        pnl: { account: { unrealized: -8_424, total: -8_442, complete: true } },
        nav: { account: 491_558, book: 991_558 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 3_600, assets: 491_558, netAssets: 491_558 } },
      },
    },
    {
      id: 'recovery-by-hand', covers: ['issuer credit event', 'close'], action: 'ticket', instrument: 'main', side: 'sell', qty: 600, from: 'lot', order: { statedPrice: 6.25 },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 600, estimate: 6.25, model: 'stated-price', settleDate: '2026-03-06', cash: 3_750, fees: 3 }] }, // 600 x 6.25
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 600, avgPrice: 6.25, fills: [{ qty: 600, price: 6.25, model: 'stated-price', source: null }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 600 CBCI @ 6.25 USD (realized -8,274.00 USD)' }], // 3,750 - 12,024
        cash: { account: { USD: { settled: 487_958, unsettled: 3_747, availableToTrade: 491_705 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-03-06', amount: 3_747, into: 'cash' }],
        pnl: { account: { realized: -8_286, commissions: -9, unrealized: 0, total: -8_295 } },
        nav: { account: 491_705, book: 991_705 },
        balance: { account: { cash: 487_958, receivable: 3_747, positions: null, assets: 491_705, netAssets: 491_705 } },
      },
    },
    {
      id: 'settle-recovery', covers: 'settlement', action: 'clock', to: FRI,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 3,747.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 491_705, unsettled: 0, availableToTrade: 491_705 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 491_705, receivable: null, assets: 491_705, liabilities: 0, netAssets: 491_705 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// closed_end_fund
// ---------------------------------------------------------------------------------------------
// The offer shows 400 shares, so a market order for 1,000 fills 400 per engine cycle: 400 at once,
// 400 on the next cycle, 200 on the one after. The fee schedule applies to the order: each fill
// pays what the schedule adds for the order's filled quantity (2.00, 2.00, 1.00 here; the 1.00
// minimum never binds), and each fill settles on its own. The monthly distribution has an income part (a recorded dividend) and a return of
// capital, which is recorded by hand and lowers the cost of the position instead of being income.
const closedEndFund = {
  productId: 'closed_end_fund',
  title: 'Granite Peak Municipal Income Fund, NYSE-listed closed-end fund',
  matrix: {
    ...SECURITY_TICKET,
    manualInputs: ['income distribution (ex-date, amount per share), recorded by hand', 'return of capital, recorded by hand as a manual cash flow of kind Return of capital on the position'],
    settlement: 'T+1 on the US equity calendar, per fill',
    lifecycle: 'An order larger than the displayed size fills in parts, one per engine cycle; income distribution from the recorded corporate action; return of capital by hand',
    accounting: 'Average cost over the partial fills; commission by the fee schedule on the order, charged as it fills; return of capital reduces cost and is not income',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix closed-end fund'),
  instruments: {
    main: { productId: 'closed_end_fund', name: 'Granite Peak Municipal Income Fund', symbol: 'GPMF', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Granite Peak Funds', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  },
  quotes: { main: { bid: 14.00, ask: 14.02, last: 14.01, bidSize: 5000, askSize: 400 } },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'open-part-filled', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1000, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ action: 'buy', qty: 1000, estimate: 14.02, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -14_020, fees: 5 }], // 1,000 x 14.02; 1,000 x 0.005
          cash: { USD: { purchases: 14_020, fees: 5, required: 14_025, available: 500_000, shortfall: 0 } } },
        // The confirmation fills the 400 on offer; the engine cycle that follows fills 400 more.
        result: { status: 'partial', orders: [{ action: 'buy', status: 'partial', qty: 1000, filledQty: 400, avgPrice: 14.02, fills: [{ qty: 400, price: 14.02, settleDate: '2026-03-03' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 400 GPMF @ 14.02 USD' }, { type: 'trade.fill', summary: 'Bought 400 GPMF @ 14.02 USD' }],
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'buy', status: 'partial', qty: 1000, filledQty: 800 }],
        cash: { account: { USD: { settled: 500_000, unsettled: -11_220, availableToTrade: 488_780 } } }, // two fills of 400 x 14.02 = 5,608 plus 2.00 each
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 800, avgCost: 14.02, cost: 11_216, price: 14.01, value: 11_208, unrealized: -8 }],
        holdings: { main: { long: 800, short: 0, net: 800 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-03', amount: -5_610, into: 'cash' }, { instrument: 'main', dueDate: '2026-03-03', amount: -5_610, into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: -4, fees: 0, borrowFunding: 0, unrealized: -8, total: -12 } },
        nav: { account: 499_988, book: 999_988 },
        balance: { account: { cash: 500_000, positions: 11_208, payable: 11_220, assets: 511_208, liabilities: 11_220, netAssets: 499_988 } },
      },
    },
    {
      id: 'open-filled', covers: 'open', action: 'cycle',
      expect: {
        events: [{ type: 'trade.fill', summary: 'Bought 200 GPMF @ 14.02 USD' }],
        openOrders: [],
        cash: { account: { USD: { settled: 500_000, unsettled: -14_025, availableToTrade: 485_975 } } }, // the last 200 x 14.02 = 2,804 plus 1.00
        positions: [{ instrument: 'main', lot: 'lot', qty: 1000, cost: 14_020, avgCost: 14.02, price: 14.01, value: 14_010, unrealized: -10 }],
        holdings: { main: { long: 1000, short: 0, net: 1000 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-03', amount: -5_610 }, { instrument: 'main', dueDate: '2026-03-03', amount: -5_610 }, { instrument: 'main', dueDate: '2026-03-03', amount: -2_805 }],
        pnl: { account: { commissions: -5, unrealized: -10, total: -15 } }, // 2 + 2 + 1, the same 5.00 the preview showed
        nav: { account: 499_985, book: 999_985 },
        balance: { account: { positions: 14_010, payable: 14_025, assets: 514_010, liabilities: 14_025, netAssets: 499_985 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 5,610.00 USD' }, { type: 'settlement.pay', summary: 'paid 5,610.00 USD' }, { type: 'settlement.pay', summary: 'paid 2,805.00 USD' }],
        cash: { account: { USD: { settled: 485_975, unsettled: 0, availableToTrade: 485_975 } } },
        pending: [],
        balance: { account: { cash: 485_975, payable: null, assets: 499_985, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.2, // 1,000 -> 1,200
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', qty: 200, estimate: 14.02, settleDate: '2026-03-04', cash: -2_804, fees: 1 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 200, avgPrice: 14.02 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 200 GPMF @ 14.02 USD' }],
        cash: { account: { USD: { settled: 485_975, unsettled: -2_805, availableToTrade: 483_170 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1200, cost: 16_824, avgCost: 14.02, price: 14.01, value: 16_812, unrealized: -12 }],
        holdings: { main: { long: 1200, short: 0, net: 1200 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-04', amount: -2_805, into: 'cash' }],
        pnl: { account: { commissions: -6, unrealized: -12, total: -18 } },
        nav: { account: 499_982, book: 999_982 },
        balance: { account: { cash: 485_975, positions: 16_812, payable: 2_805, assets: 502_787, liabilities: 2_805, netAssets: 499_982 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: WED,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,805.00 USD' }],
        cash: { account: { USD: { settled: 483_170, unsettled: 0, availableToTrade: 483_170 } } },
        pending: [],
        balance: { account: { cash: 483_170, payable: null, assets: 499_982, liabilities: 0 } },
      },
    },
    { id: 'distribution-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-03-05', amount: 0.0625, expect: {} },
    {
      id: 'distribution-paid', covers: 'dividend', action: 'clock', to: THU,
      expect: {
        events: [{ type: 'dividend', summary: 'Dividend on 1,200 GPMF: 75.00 USD (0.0625 per unit, ex-date 2026-03-05)', cash: { USD: 75 } }], // 1,200 x 0.0625
        cash: { account: { USD: { settled: 483_245, availableToTrade: 483_245 } } },
        pnl: { account: { dividends: 75, total: 57 } },
        nav: { account: 500_057, book: 1_000_057 },
        balance: { account: { cash: 483_245, assets: 500_057, netAssets: 500_057 } },
      },
    },
    {
      id: 'return-of-capital', covers: 'return of capital', action: 'cashflow', lot: 'lot', category: 'return_of_capital', amount: 36, note: 'Return of capital in the March distribution, 0.03 per share', // 1,200 x 0.03
      expect: {
        events: [{ type: 'manual.cashflow', summary: 'Manual return of capital on GPMF: received 36.00 USD. Return of capital in the March distribution, 0.03 per share', cash: { USD: 36 } }],
        cash: { account: { USD: { settled: 483_281, availableToTrade: 483_281 } } },
        // Cost falls by 36 to 16,788 (13.99 a share). It is not income: the same 36 shows up as unrealized P&L instead.
        positions: [{ instrument: 'main', lot: 'lot', qty: 1200, cost: 16_788, avgCost: 13.99, price: 14.01, value: 16_812, unrealized: 24 }],
        pnl: { account: { dividends: 75, unrealized: 24, total: 93 } },
        nav: { account: 500_093, book: 1_000_093 },
        balance: { account: { cash: 483_281, positions: 16_812, assets: 500_093, netAssets: 500_093 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 500, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 500, estimate: 14.00, settleDate: '2026-03-06', cash: 7_000, fees: 2.50 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 500, avgPrice: 14.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 500 GPMF @ 14.00 USD (realized 5.00 USD)' }], // 7,000 - 16,788 x 500/1,200 (6,995)
        cash: { account: { USD: { settled: 483_281, unsettled: 6_997.50, availableToTrade: 490_278.50 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 700, cost: 9_793, avgCost: 13.99, price: 14.01, value: 9_807, unrealized: 14 }],
        holdings: { main: { long: 700, short: 0, net: 700 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-06', amount: 6_997.50, into: 'cash' }],
        pnl: { account: { realized: 5, commissions: -8.50, dividends: 75, unrealized: 14, total: 85.50 } },
        nav: { account: 500_085.50, book: 1_000_085.50 },
        balance: { account: { cash: 483_281, receivable: 6_997.50, positions: 9_807, assets: 500_085.50, liabilities: 0, netAssets: 500_085.50 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: FRI,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 6,997.50 USD into settled cash' }],
        cash: { account: { USD: { settled: 490_278.50, unsettled: 0, availableToTrade: 490_278.50 } } },
        pending: [],
        balance: { account: { cash: 490_278.50, receivable: null } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 700, estimate: 14.00, settleDate: '2026-03-09', cash: 9_800, fees: 3.50 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 700, avgPrice: 14.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 700 GPMF @ 14.00 USD (realized 7.00 USD)' }], // 9,800 - 9,793
        cash: { account: { USD: { settled: 490_278.50, unsettled: 9_796.50, availableToTrade: 500_075 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-03-09', amount: 9_796.50, into: 'cash' }],
        pnl: { account: { realized: 12, commissions: -12, dividends: 75, unrealized: 0, total: 75 } },
        nav: { account: 500_075, book: 1_000_075 },
        balance: { account: { cash: 490_278.50, receivable: 9_796.50, positions: null, assets: 500_075, netAssets: 500_075 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MON2,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 9,796.50 USD into settled cash' }],
        cash: { account: { USD: { settled: 500_075, unsettled: 0, availableToTrade: 500_075 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 500_075, receivable: null, assets: 500_075, liabilities: 0, netAssets: 500_075 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// reit
// ---------------------------------------------------------------------------------------------
// A Tokyo-listed REIT in yen, held by a Book that reports in US dollars. It exercises the JP
// calendar (T+2 stepping over the Vernal Equinox holiday on Friday 20 March 2026), yen amounts
// with no decimals, and translation into the reporting currency when the yen rate moves.
//
// FX fixture: USD/JPY 150 at the start, 160 later. All yen amounts are chosen as multiples of 24 so
// that they convert to exact cents at both rates and no expected figure sits on a rounding edge.
//   - Entries are converted when posted (at 150 until the rate moves). Balances are converted at the
//     current rate. The difference is the FX effect: it is not realized P&L and not unrealized P&L.
const MAR = (d) => `2026-03-${d}T14:00:00.000Z`; // 10:00 New York from 9 March (daylight time)
const reit = {
  productId: 'reit',
  title: 'Hanazono Logistics REIT, Tokyo-listed, in yen, in a US dollar Book',
  matrix: {
    ...SECURITY_TICKET,
    requiredFields: ['Account', 'Action', 'Units'],
    automaticInputs: [...SECURITY_TICKET.automaticInputs, 'USD/JPY rate (FX fixture) for reporting-currency figures'],
    manualInputs: ['cash distribution (ex-date, yen per unit), recorded by hand'],
    settlement: 'T+2 on the Tokyo calendar (settlement.foreignCash = 2); the Vernal Equinox holiday on 20 March 2026 is skipped; cash settles in yen',
    lifecycle: 'Cash distribution in yen from the recorded corporate action',
    accounting: 'Average cost in yen; every entry also stored in US dollars at the rate when posted; balances translated at the current rate, the difference reported as FX effect',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 2, holidays: ['2026-03-20'] }, // Tokyo: Vernal Equinox Day 2026
  book: {
    ...book('Matrix REIT', { fees: { equity: { perUnit: 0, minimum: 0, bps: 16 } } }), // 0.16% of principal
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'JPY', amount: 60_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }, { ccy: 'JPY', amount: 45_000_000 }] },
  },
  fx: { 'USD/JPY': 150 },
  instruments: {
    main: { productId: 'reit', name: 'Hanazono Logistics REIT Investment Corp.', symbol: 'HNZL', marketView: 'FOREIGN_CASH', venue: 'Tokyo Stock Exchange', venueType: 'exchange', venueCountry: 'JP', issuer: 'Hanazono Logistics REIT Investment Corp.', domicile: 'JP', underlyingGeo: 'JP', tradingCcy: 'JPY', terms: {} },
  },
  quotes: { main: { bid: 149_760, ask: 150_000, last: 149_880, bidSize: 500, askSize: 500 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 500_000, unsettled: 0, reserved: 0, restricted: 0, availableToTrade: 500_000 }, JPY: { settled: 45_000_000, unsettled: 0, reserved: 0, restricted: 0, availableToTrade: 45_000_000 } },
      treasury: { USD: { settled: 500_000 }, JPY: { settled: 15_000_000 } },
    },
    positions: [], pending: [], openOrders: [], borrowings: [],
    nav: { account: 800_000, treasury: 600_000, book: 1_400_000 }, // 500,000 + 45,000,000 / 150; 500,000 + 15,000,000 / 150
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    { id: 'to-trade-week', action: 'clock', to: MAR('18'), expect: {} }, // Wednesday 18 March 2026
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 20, as: 'lot',
      expect: {
        // T+2 in Tokyo from Wednesday 18 March: Thursday 19 (1), Friday 20 is a holiday, Monday 23 (2).
        preview: { blocking: 0, errors: [], legs: [{ action: 'buy', qty: 20, estimate: 150_000, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-23', calendar: 'JP',
          cash: -3_000_000, // 20 x 150,000 yen
          fees: 4_800 }], // 0.16% of 3,000,000
          cash: { JPY: { purchases: 3_000_000, fees: 4_800, required: 3_004_800, available: 45_000_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 20, avgPrice: 150_000, fills: [{ qty: 20, price: 150_000, settleDate: '2026-03-23', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 20 HNZL @ 150,000.00 JPY', date: '2026-03-18' }],
        cash: { account: { JPY: { settled: 45_000_000, unsettled: -3_004_800, availableToTrade: 41_995_200 }, USD: { settled: 500_000, availableToTrade: 500_000 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 20, avgCost: 150_000, cost: 3_000_000, price: 149_880, value: 2_997_600, unrealized: -2_400 }], // yen
        holdings: { main: { long: 20, short: 0, net: 20 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-23', amount: -3_004_800, ccy: 'JPY', into: 'cash' }],
        // In US dollars at 150: commission 4,800 / 150 = 32.00; unrealized -2,400 / 150 = -16.00.
        pnl: { account: { realized: 0, dividends: 0, commissions: -32, fees: 0, borrowFunding: 0, unrealized: -16, fx: 0, total: -48 } },
        nav: { account: 799_952, treasury: 600_000, book: 1_399_952 },
        balance: { account: {
          cash: 800_000, positions: 19_984, payable: 20_032, assets: 819_984, liabilities: 20_032, netAssets: 799_952, // 2,997,600 / 150; 3,004,800 / 150
          local: { JPY: { cash: 45_000_000, positions: 2_997_600, payable: 3_004_800 }, USD: { cash: 500_000 } },
        } },
      },
    },
    { id: 'holiday-not-settled', covers: 'settlement', action: 'clock', to: MAR('20'), expect: {} }, // the Tokyo holiday: nothing settles
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR('23'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 3,004,800 JPY from settled cash', cash: { JPY: -3_004_800 }, date: '2026-03-23' }],
        cash: { account: { JPY: { settled: 41_995_200, unsettled: 0, availableToTrade: 41_995_200 } } },
        pending: [],
        balance: { account: { cash: 779_968, payable: null, assets: 799_952, liabilities: 0, local: { JPY: { cash: 41_995_200, payable: null } } } }, // 500,000 + 41,995,200 / 150
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 20 -> 30 units
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', qty: 10, estimate: 150_000, settleDate: '2026-03-25', cash: -1_500_000, fees: 2_400 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 10, avgPrice: 150_000 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 10 HNZL @ 150,000.00 JPY' }],
        cash: { account: { JPY: { settled: 41_995_200, unsettled: -1_502_400, availableToTrade: 40_492_800 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 30, cost: 4_500_000, avgCost: 150_000, price: 149_880, value: 4_496_400, unrealized: -3_600 }],
        holdings: { main: { long: 30, short: 0, net: 30 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-25', amount: -1_502_400, ccy: 'JPY', into: 'cash' }],
        pnl: { account: { commissions: -48, unrealized: -24, total: -72 } }, // 7,200 / 150; 3,600 / 150
        nav: { account: 799_928, book: 1_399_928 },
        balance: { account: { cash: 779_968, positions: 29_976, payable: 10_016, assets: 809_944, liabilities: 10_016, netAssets: 799_928, local: { JPY: { positions: 4_496_400, payable: 1_502_400 } } } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: MAR('25'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,502,400 JPY from settled cash' }],
        cash: { account: { JPY: { settled: 40_492_800, unsettled: 0, availableToTrade: 40_492_800 } } },
        pending: [],
        balance: { account: { cash: 769_952, payable: null, assets: 799_928, liabilities: 0, local: { JPY: { cash: 40_492_800, payable: null } } } }, // 500,000 + 40,492,800 / 150
      },
    },
    { id: 'distribution-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-03-27', amount: 3_200, expect: {} },
    {
      id: 'distribution-paid', covers: 'dividend', action: 'clock', to: MAR('27'),
      expect: {
        events: [{ type: 'dividend', summary: 'Dividend on 30 HNZL: 96,000 JPY (3200 per unit, ex-date 2026-03-27)', cash: { JPY: 96_000 } }], // 30 x 3,200
        cash: { account: { JPY: { settled: 40_588_800, availableToTrade: 40_588_800 } } },
        pnl: { account: { dividends: 640, total: 568 } }, // 96,000 / 150 = 640
        nav: { account: 800_568, book: 1_400_568 },
        balance: { account: { cash: 770_592, assets: 800_568, netAssets: 800_568, local: { JPY: { cash: 40_588_800 } } } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 151_250, ask: 151_500, last: 151_400, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 30, price: 151_400, value: 4_542_000, unrealized: 42_000 }], // 30 x 151,400 - 4,500,000
        pnl: { account: { unrealized: 280, total: 872 } }, // 42,000 / 150
        nav: { account: 800_872, book: 1_400_872 },
        balance: { account: { positions: 30_280, assets: 800_872, netAssets: 800_872, local: { JPY: { positions: 4_542_000 } } } },
      },
    },
    {
      id: 'yen-weakens', covers: 'fx translation', action: 'fx_rate', pair: 'USD/JPY', rate: 160,
      expect: {
        // Yen balances are worth less in dollars. Account, at 160: cash 40,588,800 / 160 = 253,680; position 4,542,000 / 160 = 28,387.50.
        // FX effect: cash 253,680 - 270,592 posted = -16,912; position cost 4,500,000 / 160 = 28,125 - 30,000 posted = -1,875; together -18,787.
        // Unrealized is now 42,000 / 160 = 262.50. Total: -48 + 640 + 262.50 - 18,787 = -17,932.50.
        pnl: { account: { commissions: -48, dividends: 640, unrealized: 262.50, fx: -18_787, total: -17_932.50 },
          book: { fx: -25_037 } }, // plus Treasury's 15,000,000 yen: 93,750 - 100,000 = -6,250
        nav: { account: 782_067.50, treasury: 593_750, book: 1_375_817.50 },
        balance: { account: { cash: 753_680, positions: 28_387.50, assets: 782_067.50, netAssets: 782_067.50 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 12, from: 'lot',
      expect: {
        // T+2 from Friday 27 March: Monday 30 (1), Tuesday 31 (2).
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 12, estimate: 151_250, settleDate: '2026-03-31', cash: 1_815_000, fees: 2_904 }] }, // 12 x 151,250; 0.16%
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 12, avgPrice: 151_250 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 12 HNZL @ 151,250.00 JPY (realized 15,000 JPY)' }], // 1,815,000 - 12 x 150,000
        cash: { account: { JPY: { settled: 40_588_800, unsettled: 1_812_096, availableToTrade: 42_400_896 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 18, cost: 2_700_000, avgCost: 150_000, price: 151_400, value: 2_725_200, unrealized: 25_200 }],
        holdings: { main: { long: 18, short: 0, net: 18 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-31', amount: 1_812_096, ccy: 'JPY', into: 'cash' }],
        // Posted at 160: realized 15,000 / 160 = 93.75; commission 2,904 / 160 = 18.15. Unrealized 25,200 / 160 = 157.50.
        pnl: { account: { realized: 93.75, commissions: -66.15, dividends: 640, unrealized: 157.50, fx: -18_787, total: -17_961.90 } },
        nav: { account: 782_038.10, book: 1_375_788.10 }, // 500,000 + (40,588,800 + 1,812,096 + 2,725,200) / 160
        balance: { account: { cash: 753_680, receivable: 11_325.60, positions: 17_032.50, assets: 782_038.10, liabilities: 0, netAssets: 782_038.10, local: { JPY: { receivable: 1_812_096, positions: 2_725_200 } } } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: MAR('31'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,812,096 JPY into settled cash' }],
        cash: { account: { JPY: { settled: 42_400_896, unsettled: 0, availableToTrade: 42_400_896 } } },
        pending: [],
        balance: { account: { cash: 765_005.60, receivable: null, local: { JPY: { cash: 42_400_896, receivable: null } } } }, // 500,000 + 42,400,896 / 160
      },
    },
    {
      id: 'quote-up-2', action: 'quote', instrument: 'main', quote: { bid: 152_500, ask: 152_750, last: 152_600, bidSize: 500, askSize: 500 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 18, price: 152_600, value: 2_746_800, unrealized: 46_800 }],
        pnl: { account: { unrealized: 292.50, total: -17_826.90 } }, // 46,800 / 160
        nav: { account: 782_173.10, book: 1_375_923.10 },
        balance: { account: { positions: 17_167.50, assets: 782_173.10, netAssets: 782_173.10, local: { JPY: { positions: 2_746_800 } } } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 18, from: 'lot',
      expect: {
        // T+2 from Tuesday 31 March: Wednesday 1 April (1), Thursday 2 April (2).
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 18, estimate: 152_500, settleDate: '2026-04-02', cash: 2_745_000, fees: 4_392 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 18, avgPrice: 152_500 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 18 HNZL @ 152,500.00 JPY (realized 45,000 JPY)' }],
        cash: { account: { JPY: { settled: 42_400_896, unsettled: 2_740_608, availableToTrade: 45_141_504 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-04-02', amount: 2_740_608, ccy: 'JPY', into: 'cash' }],
        // Realized 45,000 / 160 = 281.25 more; commission 4,392 / 160 = 27.45 more.
        pnl: { account: { realized: 375, commissions: -93.60, dividends: 640, unrealized: 0, fx: -18_787, total: -17_865.60 } },
        nav: { account: 782_134.40, book: 1_375_884.40 }, // 500,000 + 45,141,504 / 160
        balance: { account: { cash: 765_005.60, receivable: 17_128.80, positions: null, assets: 782_134.40, netAssets: 782_134.40, local: { JPY: { receivable: 2_740_608, positions: null } } } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: APR('02'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 2,740,608 JPY into settled cash' }],
        cash: { account: { JPY: { settled: 45_141_504, unsettled: 0, availableToTrade: 45_141_504 }, USD: { settled: 500_000 } }, treasury: { USD: { settled: 500_000 }, JPY: { settled: 15_000_000 } } },
        pending: [],
        balance: { account: { cash: 782_134.40, receivable: null, assets: 782_134.40, liabilities: 0, netAssets: 782_134.40, local: { JPY: { cash: 45_141_504, receivable: null } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// warrant, subscription_right, convertible_preferred: events recorded by hand
// ---------------------------------------------------------------------------------------------
// The catalog marks these three "partly manual": they trade and settle like any listed security, but
// exercise, lapse and conversion are not simulated. The position's Lifecycle menu offers no such
// action, and the API refuses one (asserted below as `unsupported`). The event is recorded by hand
// with two tickets at stated fill prices, which keeps the books right without inventing a price:
//   - the instrument given up is sold at a stated price equal to its average cost (no profit or loss),
//   - the shares received are bought at a stated price equal to the cash paid per share plus the cost
//     given up per share, so the cost carries over into the shares;
//   - what is left to lapse is sold at a stated price of zero: its whole cost is a realized loss.
// The fee schedule of these three Books is zero on purpose: a commission on the two recording tickets
// would be a cost that an exercise or conversion does not have.
const NO_FEES = { fees: { equity: { perUnit: 0, minimum: 0, bps: 0 } } };
const BY_HAND_TICKET = {
  ticket: 'Instrument drawer, Trade tab (security ticket) with "State a fill price" for the events recorded by hand',
  requiredFields: ['Account', 'Action', 'Shares', 'State a fill price (for exercise, conversion and lapse recorded by hand)'],
  automaticInputs: SECURITY_TICKET.automaticInputs,
};

const warrant = {
  productId: 'warrant',
  title: 'Solvane Energy warrants (one share at 11.50), NYSE American-listed',
  matrix: {
    ...BY_HAND_TICKET,
    manualInputs: ['exercise: sale of the warrants at their average cost and purchase of the shares at strike plus warrant cost, both at stated prices', 'lapse: sale of the remaining warrants at a stated price of zero'],
    settlement: 'T+1 on the US equity calendar; a sale at zero has nothing to settle',
    lifecycle: 'None simulated. Exercise and expiry are recorded by hand; an automatic exercise is refused',
    accounting: 'Average cost; on exercise the warrant cost moves into the cost of the shares with no profit or loss; a lapse realizes the remaining cost as a loss',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix warrant', NO_FEES),
  instruments: {
    common: { productId: 'common_stock', name: 'Solvane Energy Corp.', symbol: 'SLVN', marketView: 'US_CASH', venue: 'NYSE American', venueType: 'exchange', venueCountry: 'US', issuer: 'Solvane Energy Corp.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    main: { productId: 'warrant', name: 'Solvane Energy Corp. warrants, 11.50 strike, expiring 30 June 2028', symbol: 'SLVN.WS', marketView: 'US_CASH', venue: 'NYSE American', venueType: 'exchange', venueCountry: 'US', issuer: 'Solvane Energy Corp.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  },
  quotes: {
    common: { bid: 13.80, ask: 13.84, last: 13.82, bidSize: 20000, askSize: 20000 },
    main: { bid: 2.40, ask: 2.46, last: 2.43, bidSize: 20000, askSize: 20000 },
  },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2000, as: 'warrants',
      expect: {
        preview: { blocking: 0, errors: [], notes: ['support'], // the preview states that exercise and expiry are recorded by hand
          legs: [{ action: 'buy', qty: 2000, estimate: 2.46, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -4_920, fees: 0 }], // 2,000 x 2.46
          cash: { USD: { purchases: 4_920, fees: 0, required: 4_920, available: 500_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 2000, avgPrice: 2.46 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000 SLVN.WS @ 2.46 USD' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -4_920, availableToTrade: 495_080 } } },
        positions: [{ instrument: 'main', lot: 'warrants', owner: 'account', direction: 'long', qty: 2000, avgCost: 2.46, cost: 4_920, price: 2.43, value: 4_860, unrealized: -60 }],
        holdings: { main: { long: 2000, short: 0, net: 2000 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-03', amount: -4_920, into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: 0, fees: 0, borrowFunding: 0, unrealized: -60, total: -60 } },
        nav: { account: 499_940, book: 999_940 },
        balance: { account: { cash: 500_000, positions: 4_860, payable: 4_920, assets: 504_860, liabilities: 4_920, netAssets: 499_940 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 4,920.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 495_080, unsettled: 0, availableToTrade: 495_080 } } },
        pending: [],
        balance: { account: { cash: 495_080, payable: null, assets: 499_940, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'warrants', factor: 1.5, // 2,000 -> 3,000
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', qty: 1000, estimate: 2.46, settleDate: '2026-03-04', cash: -2_460, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1000, avgPrice: 2.46 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 1,000 SLVN.WS @ 2.46 USD' }],
        cash: { account: { USD: { settled: 495_080, unsettled: -2_460, availableToTrade: 492_620 } } },
        positions: [{ instrument: 'main', lot: 'warrants', qty: 3000, cost: 7_380, avgCost: 2.46, price: 2.43, value: 7_290, unrealized: -90 }],
        holdings: { main: { long: 3000, short: 0, net: 3000 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-04', amount: -2_460, into: 'cash' }],
        pnl: { account: { unrealized: -90, total: -90 } },
        nav: { account: 499_910, book: 999_910 },
        balance: { account: { cash: 495_080, positions: 7_290, payable: 2_460, assets: 502_370, liabilities: 2_460, netAssets: 499_910 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: WED,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,460.00 USD' }],
        cash: { account: { USD: { settled: 492_620, unsettled: 0, availableToTrade: 492_620 } } },
        pending: [],
        balance: { account: { cash: 492_620, payable: null, assets: 499_910, liabilities: 0 } },
      },
    },
    { id: 'shares-rally', action: 'quote', instrument: 'common', quote: { bid: 15.00, ask: 15.04, last: 15.02, bidSize: 20000, askSize: 20000 }, expect: {} },
    {
      id: 'warrants-rally', action: 'quote', instrument: 'main', quote: { bid: 3.50, ask: 3.56, last: 3.53, bidSize: 20000, askSize: 20000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'warrants', qty: 3000, price: 3.53, value: 10_590, unrealized: 3_210 }], // 3,000 x 3.53 - 7,380
        pnl: { account: { unrealized: 3_210, total: 3_210 } },
        nav: { account: 503_210, book: 1_003_210 },
        balance: { account: { positions: 10_590, assets: 503_210, netAssets: 503_210 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 500, from: 'warrants',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 500, estimate: 3.50, settleDate: '2026-03-05', cash: 1_750, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 500, avgPrice: 3.50 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 500 SLVN.WS @ 3.50 USD (realized 520.00 USD)' }], // 500 x (3.50 - 2.46)
        cash: { account: { USD: { settled: 492_620, unsettled: 1_750, availableToTrade: 494_370 } } },
        positions: [{ instrument: 'main', lot: 'warrants', qty: 2500, cost: 6_150, avgCost: 2.46, price: 3.53, value: 8_825, unrealized: 2_675 }],
        holdings: { main: { long: 2500, short: 0, net: 2500 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-05', amount: 1_750, into: 'cash' }],
        pnl: { account: { realized: 520, unrealized: 2_675, total: 3_195 } },
        nav: { account: 503_195, book: 1_003_195 },
        balance: { account: { cash: 492_620, receivable: 1_750, positions: 8_825, assets: 503_195, liabilities: 0, netAssets: 503_195 } },
      },
    },
    {
      id: 'automatic-exercise', covers: 'exercise', action: 'lifecycle', lot: 'warrants', body: { action: 'exercise', contracts: 2000 },
      status: 'unsupported', reason: 'Warrant exercise is not simulated; the catalog says it is recorded by hand.',
      expect: { refused: { api: 'This position cannot be exercised', browser: 'offers only: Manual cash flow' } },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: THU,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,750.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 494_370, unsettled: 0, availableToTrade: 494_370 } } },
        pending: [],
        balance: { account: { cash: 494_370, receivable: null } },
      },
    },
    {
      // Exercise 2,000 warrants by hand, first ticket: the warrants given up, at their average cost 2.46.
      id: 'exercise-warrants-given-up', covers: 'exercise', action: 'ticket', instrument: 'main', side: 'sell', qty: 2000, from: 'warrants', order: { statedPrice: 2.46 },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 2000, estimate: 2.46, model: 'stated-price', settleDate: '2026-03-06', cash: 4_920, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2000, avgPrice: 2.46, fills: [{ qty: 2000, price: 2.46, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 2,000 SLVN\.WS @ 2\.46 USD$/ }], // at cost: no realized profit or loss
        cash: { account: { USD: { settled: 494_370, unsettled: 4_920, availableToTrade: 499_290 } } },
        positions: [{ instrument: 'main', lot: 'warrants', qty: 500, cost: 1_230, avgCost: 2.46, price: 3.53, value: 1_765, unrealized: 535 }],
        holdings: { main: { long: 500, short: 0, net: 500 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-06', amount: 4_920, into: 'cash' }],
        pnl: { account: { realized: 520, unrealized: 535, total: 1_055 } },
        nav: { account: 501_055, book: 1_001_055 }, // the value above cost of the 2,000 warrants reappears with the shares in the next step
        balance: { account: { cash: 494_370, receivable: 4_920, positions: 1_765, assets: 501_055, netAssets: 501_055 } },
      },
    },
    {
      // Second ticket: 2,000 shares received at 11.50 strike + 2.46 warrant cost = 13.96 a share.
      id: 'exercise-shares-received', covers: 'exercise', action: 'ticket', instrument: 'common', side: 'buy', qty: 2000, as: 'shares', order: { statedPrice: 13.96 },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', instrument: 'common', qty: 2000, estimate: 13.96, model: 'stated-price', settleDate: '2026-03-06', cash: -27_920, fees: 0 }] }, // 2,000 x 13.96
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 2000, avgPrice: 13.96, fills: [{ qty: 2000, price: 13.96, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000 SLVN @ 13.96 USD' }],
        // Net cash of the two tickets: 4,920 - 27,920 = -23,000, which is the strike paid: 2,000 x 11.50.
        cash: { account: { USD: { settled: 494_370, unsettled: -23_000, availableToTrade: 471_370 } } },
        positions: [
          { instrument: 'common', lot: 'shares', owner: 'account', direction: 'long', qty: 2000, cost: 27_920, avgCost: 13.96, price: 15.02, value: 30_040, unrealized: 2_120 }, // 2,000 x 15.02
          { instrument: 'main', lot: 'warrants', qty: 500, cost: 1_230, value: 1_765, unrealized: 535 },
        ],
        holdings: { common: { long: 2000, short: 0, net: 2000 }, main: { long: 500, short: 0, net: 500 } },
        pending: [{ instrument: 'common', dueDate: '2026-03-06', amount: -27_920, into: 'cash' }, { instrument: 'main', dueDate: '2026-03-06', amount: 4_920, into: 'cash' }],
        pnl: { account: { realized: 520, unrealized: 2_655, total: 3_175 } },
        nav: { account: 503_175, book: 1_003_175 },
        balance: { account: { cash: 494_370, receivable: 4_920, positions: 31_805, payable: 27_920, assets: 531_095, liabilities: 27_920, netAssets: 503_175 } },
      },
    },
    {
      id: 'settle-exercise', covers: 'settlement', action: 'clock', to: FRI,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 4,920.00 USD into settled cash' }, { type: 'settlement.pay', summary: 'paid 27,920.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 471_370, unsettled: 0, availableToTrade: 471_370 } } },
        pending: [],
        balance: { account: { cash: 471_370, receivable: null, payable: null, assets: 503_175, liabilities: 0 } },
      },
    },
    {
      // The last 500 warrants are left to lapse: recorded as a sale at a stated price of zero.
      id: 'lapse', covers: 'lapse', action: 'ticket', instrument: 'main', side: 'sell', qty: 500, from: 'warrants', order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 500, estimate: 0, model: 'stated-price', cash: 0, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 500, avgPrice: 0, fills: [{ qty: 500, price: 0, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 500 SLVN.WS @ 0.00 USD (realized -1,230.00 USD)' }], // the remaining cost
        positions: [{ instrument: 'common', lot: 'shares', qty: 2000, cost: 27_920, value: 30_040, unrealized: 2_120 }],
        holdings: { main: null },
        pending: [], // nothing to settle
        pnl: { account: { realized: -710, unrealized: 2_120, total: 1_410 } }, // 520 - 1,230
        nav: { account: 501_410, book: 1_001_410 },
        balance: { account: { cash: 471_370, positions: 30_040, assets: 501_410, netAssets: 501_410 } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'ticket', instrument: 'common', side: 'sell', qty: 2000, from: 'shares',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', instrument: 'common', qty: 2000, estimate: 15.00, model: 'quoted-bid-ask', settleDate: '2026-03-09', cash: 30_000, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 2000, avgPrice: 15.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2,000 SLVN @ 15.00 USD (realized 2,080.00 USD)' }], // 30,000 - 27,920
        cash: { account: { USD: { settled: 471_370, unsettled: 30_000, availableToTrade: 501_370 } } },
        positions: [],
        holdings: { common: null },
        pending: [{ instrument: 'common', dueDate: '2026-03-09', amount: 30_000, into: 'cash' }],
        pnl: { account: { realized: 1_370, unrealized: 0, total: 1_370 } }, // -7,380 warrants bought + 1,750 sold - 23,000 strike + 30,000 shares sold
        nav: { account: 501_370, book: 1_001_370 },
        balance: { account: { cash: 471_370, receivable: 30_000, positions: null, assets: 501_370, netAssets: 501_370 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MON2,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 30,000.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 501_370, unsettled: 0, availableToTrade: 501_370 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 501_370, receivable: null, assets: 501_370, liabilities: 0, netAssets: 501_370 } },
      },
    },
  ],
};

const subscriptionRight = {
  productId: 'subscription_right',
  title: 'Ardent Paper Holdings subscription rights (4 rights and 20.00 buy one share), NASDAQ-listed',
  matrix: {
    ...BY_HAND_TICKET,
    requiredFields: [...BY_HAND_TICKET.requiredFields, 'Sell from (two positions are held)'],
    manualInputs: ['exercise: sale of the rights at their average cost and purchase of the new shares at subscription price plus rights cost, both at stated prices', 'lapse: sale of the unexercised rights at a stated price of zero'],
    settlement: 'T+1 on the US equity calendar; a sale at zero has nothing to settle',
    lifecycle: 'None simulated. Exercise and lapse are recorded by hand; an automatic exercise is refused',
    accounting: 'Average cost per position; on exercise the rights cost moves into the cost of the new shares; a lapse realizes the remaining cost as a loss',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix subscription right', NO_FEES),
  instruments: {
    common: { productId: 'common_stock', name: 'Ardent Paper Holdings Inc.', symbol: 'ARDP', marketView: 'US_CASH', venue: 'NASDAQ', venueType: 'exchange', venueCountry: 'US', issuer: 'Ardent Paper Holdings Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    main: { productId: 'subscription_right', name: 'Ardent Paper Holdings subscription rights, 4 rights and 20.00 per share, expiring 20 March 2026', symbol: 'ARDP.RT', marketView: 'US_CASH', venue: 'NASDAQ', venueType: 'exchange', venueCountry: 'US', issuer: 'Ardent Paper Holdings Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  },
  quotes: {
    common: { bid: 22.00, ask: 22.04, last: 22.02, bidSize: 20000, askSize: 20000 },
    main: { bid: 0.48, ask: 0.50, last: 0.49, bidSize: 50000, askSize: 50000 },
  },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 4000, as: 'rights1',
      expect: {
        preview: { blocking: 0, errors: [], notes: ['support'], legs: [{ action: 'buy', qty: 4000, estimate: 0.50, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -2_000, fees: 0 }], // 4,000 x 0.50
          cash: { USD: { purchases: 2_000, fees: 0, required: 2_000, available: 500_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 4000, avgPrice: 0.50 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 4,000 ARDP.RT @ 0.50 USD' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -2_000, availableToTrade: 498_000 } } },
        positions: [{ instrument: 'main', lot: 'rights1', owner: 'account', direction: 'long', qty: 4000, avgCost: 0.5, cost: 2_000, price: 0.49, value: 1_960, unrealized: -40 }],
        holdings: { main: { long: 4000, short: 0, net: 4000 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-03', amount: -2_000, into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: 0, fees: 0, borrowFunding: 0, unrealized: -40, total: -40 } },
        nav: { account: 499_960, book: 999_960 },
        balance: { account: { cash: 500_000, positions: 1_960, payable: 2_000, assets: 501_960, liabilities: 2_000, netAssets: 499_960 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,000.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 498_000, unsettled: 0, availableToTrade: 498_000 } } },
        pending: [],
        balance: { account: { cash: 498_000, payable: null, assets: 499_960, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'ticket', instrument: 'main', side: 'buy', qty: 2000, as: 'rights2',
      expect: {
        preview: { blocking: 0, errors: [], warnings: ['already-held'], legs: [{ action: 'buy', qty: 2000, estimate: 0.50, settleDate: '2026-03-04', cash: -1_000, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 2000, avgPrice: 0.50 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000 ARDP.RT @ 0.50 USD' }],
        cash: { account: { USD: { settled: 498_000, unsettled: -1_000, availableToTrade: 497_000 } } },
        positions: [
          { instrument: 'main', lot: 'rights1', qty: 4000, cost: 2_000, value: 1_960, unrealized: -40 },
          { instrument: 'main', lot: 'rights2', qty: 2000, cost: 1_000, avgCost: 0.5, price: 0.49, value: 980, unrealized: -20 },
        ],
        holdings: { main: { long: 6000, short: 0, net: 6000 } },
        pending: [{ instrument: 'main', lot: 'rights2', dueDate: '2026-03-04', amount: -1_000, into: 'cash' }],
        pnl: { account: { unrealized: -60, total: -60 } },
        nav: { account: 499_940, book: 999_940 },
        balance: { account: { cash: 498_000, positions: 2_940, payable: 1_000, assets: 500_940, liabilities: 1_000, netAssets: 499_940 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: WED,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,000.00 USD' }],
        cash: { account: { USD: { settled: 497_000, unsettled: 0, availableToTrade: 497_000 } } },
        pending: [],
        balance: { account: { cash: 497_000, payable: null, assets: 499_940, liabilities: 0 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 1000, from: 'rights2',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 1000, estimate: 0.48, settleDate: '2026-03-05', cash: 480, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1000, avgPrice: 0.48 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1,000 ARDP.RT @ 0.48 USD (realized -20.00 USD)' }], // 1,000 x (0.48 - 0.50)
        cash: { account: { USD: { settled: 497_000, unsettled: 480, availableToTrade: 497_480 } } },
        positions: [
          { instrument: 'main', lot: 'rights1', qty: 4000, cost: 2_000, value: 1_960, unrealized: -40 },
          { instrument: 'main', lot: 'rights2', qty: 1000, cost: 500, value: 490, unrealized: -10 },
        ],
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [{ instrument: 'main', lot: 'rights2', dueDate: '2026-03-05', amount: 480, into: 'cash' }],
        pnl: { account: { realized: -20, unrealized: -50, total: -70 } },
        nav: { account: 499_930, book: 999_930 },
        balance: { account: { cash: 497_000, receivable: 480, positions: 2_450, assets: 499_930, liabilities: 0, netAssets: 499_930 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: THU,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 480.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 497_480, unsettled: 0, availableToTrade: 497_480 } } },
        pending: [],
        balance: { account: { cash: 497_480, receivable: null } },
      },
    },
    {
      id: 'automatic-exercise', covers: 'exercise', action: 'lifecycle', lot: 'rights1', body: { action: 'exercise', contracts: 4000 },
      status: 'unsupported', reason: 'Exercise of a subscription right is not simulated; the catalog says it is recorded by hand.',
      expect: { refused: { api: 'This position cannot be exercised', browser: 'offers only: Manual cash flow' } },
    },
    {
      // Exercise 4,000 rights for 1,000 new shares, first ticket: the rights given up at their average cost 0.50.
      id: 'exercise-rights-given-up', covers: 'exercise', action: 'ticket', instrument: 'main', side: 'sell', qty: 4000, from: 'rights1', order: { statedPrice: 0.50 },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 4000, estimate: 0.5, model: 'stated-price', settleDate: '2026-03-06', cash: 2_000, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 4000, avgPrice: 0.5, fills: [{ qty: 4000, price: 0.5, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 4,000 ARDP\.RT @ 0\.50 USD$/ }],
        cash: { account: { USD: { settled: 497_480, unsettled: 2_000, availableToTrade: 499_480 } } },
        positions: [{ instrument: 'main', lot: 'rights2', qty: 1000, cost: 500, value: 490, unrealized: -10 }],
        holdings: { main: { long: 1000, short: 0, net: 1000 } },
        pending: [{ instrument: 'main', lot: 'rights1', dueDate: '2026-03-06', amount: 2_000, into: 'cash' }],
        pnl: { account: { realized: -20, unrealized: -10, total: -30 } },
        nav: { account: 499_970, book: 999_970 },
        balance: { account: { cash: 497_480, receivable: 2_000, positions: 490, assets: 499_970, netAssets: 499_970 } },
      },
    },
    {
      // Second ticket: 1,000 new shares at 20.00 subscription price + 4 x 0.50 rights cost = 22.00 a share.
      id: 'exercise-shares-received', covers: 'exercise', action: 'ticket', instrument: 'common', side: 'buy', qty: 1000, as: 'shares', order: { statedPrice: 22.00 },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', instrument: 'common', qty: 1000, estimate: 22, model: 'stated-price', settleDate: '2026-03-06', cash: -22_000, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1000, avgPrice: 22, fills: [{ qty: 1000, price: 22, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000 ARDP @ 22.00 USD' }],
        // Net cash of the two tickets: 2,000 - 22,000 = -20,000, the subscription money: 1,000 x 20.00.
        cash: { account: { USD: { settled: 497_480, unsettled: -20_000, availableToTrade: 477_480 } } },
        positions: [
          { instrument: 'common', lot: 'shares', owner: 'account', direction: 'long', qty: 1000, cost: 22_000, avgCost: 22, price: 22.02, value: 22_020, unrealized: 20 },
          { instrument: 'main', lot: 'rights2', qty: 1000, cost: 500, value: 490, unrealized: -10 },
        ],
        holdings: { common: { long: 1000, short: 0, net: 1000 }, main: { long: 1000, short: 0, net: 1000 } },
        pending: [{ instrument: 'common', dueDate: '2026-03-06', amount: -22_000, into: 'cash' }, { instrument: 'main', dueDate: '2026-03-06', amount: 2_000, into: 'cash' }],
        pnl: { account: { realized: -20, unrealized: 10, total: -10 } },
        nav: { account: 499_990, book: 999_990 },
        balance: { account: { cash: 497_480, receivable: 2_000, positions: 22_510, payable: 22_000, assets: 521_990, liabilities: 22_000, netAssets: 499_990 } },
      },
    },
    {
      id: 'settle-exercise', covers: 'settlement', action: 'clock', to: FRI,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 2,000.00 USD into settled cash' }, { type: 'settlement.pay', summary: 'paid 22,000.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 477_480, unsettled: 0, availableToTrade: 477_480 } } },
        pending: [],
        balance: { account: { cash: 477_480, receivable: null, payable: null, assets: 499_990, liabilities: 0 } },
      },
    },
    {
      id: 'lapse', covers: 'lapse', action: 'ticket', instrument: 'main', side: 'sell', qty: 1000, from: 'rights2', order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 1000, estimate: 0, model: 'stated-price', cash: 0, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1000, avgPrice: 0, fills: [{ qty: 1000, price: 0, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1,000 ARDP.RT @ 0.00 USD (realized -500.00 USD)' }],
        positions: [{ instrument: 'common', lot: 'shares', qty: 1000, cost: 22_000, value: 22_020, unrealized: 20 }],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: -520, unrealized: 20, total: -500 } },
        nav: { account: 499_500, book: 999_500 },
        balance: { account: { cash: 477_480, positions: 22_020, assets: 499_500, netAssets: 499_500 } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'ticket', instrument: 'common', side: 'sell', qty: 1000, from: 'shares',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', instrument: 'common', qty: 1000, estimate: 22, model: 'quoted-bid-ask', settleDate: '2026-03-09', cash: 22_000, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1000, avgPrice: 22 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 1,000 ARDP @ 22\.00 USD$/ }], // sold at cost
        cash: { account: { USD: { settled: 477_480, unsettled: 22_000, availableToTrade: 499_480 } } },
        positions: [],
        holdings: { common: null },
        pending: [{ instrument: 'common', dueDate: '2026-03-09', amount: 22_000, into: 'cash' }],
        pnl: { account: { realized: -520, unrealized: 0, total: -520 } }, // -3,000 rights bought + 480 sold - 20,000 subscription + 22,000 shares sold
        nav: { account: 499_480, book: 999_480 },
        balance: { account: { cash: 477_480, receivable: 22_000, positions: null, assets: 499_480, netAssets: 499_480 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MON2,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 22,000.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 499_480, unsettled: 0, availableToTrade: 499_480 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 499_480, receivable: null, assets: 499_480, liabilities: 0, netAssets: 499_480 } },
      },
    },
  ],
};

const convertiblePreferred = {
  productId: 'convertible_preferred',
  title: 'Tallgrass Biosciences 5.75% Series B convertible preferred (2.5 common shares each), NASDAQ-listed',
  matrix: {
    ...BY_HAND_TICKET,
    manualInputs: ['preferred dividend (ex-date, amount per share), recorded by hand', 'conversion: sale of the preferred at its average cost and purchase of the common shares at the cost carried over, both at stated prices'],
    settlement: 'T+1 on the US equity calendar; the two conversion tickets settle on the same day and net to no cash',
    lifecycle: 'Quarterly preferred dividend from the recorded corporate action. Conversion is not simulated: recorded by hand; an automatic conversion is refused',
    accounting: 'Average cost; on conversion the cost of the preferred becomes the cost of the common shares with no profit or loss and no net cash',
    collateral: 'None for a long position',
  },
  start: MON,
  settlementCheck: { lag: 1, holidays: [] }, // US equities: no holiday between 2 and 10 March 2026
  book: book('Matrix convertible preferred', NO_FEES),
  instruments: {
    common: { productId: 'common_stock', name: 'Tallgrass Biosciences Inc.', symbol: 'TLGB', marketView: 'US_CASH', venue: 'NASDAQ', venueType: 'exchange', venueCountry: 'US', issuer: 'Tallgrass Biosciences Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    main: { productId: 'convertible_preferred', name: 'Tallgrass Biosciences 5.75% Series B Convertible Preferred', symbol: 'TLGB.PRB', marketView: 'US_CASH', venue: 'NASDAQ', venueType: 'exchange', venueCountry: 'US', issuer: 'Tallgrass Biosciences Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  },
  quotes: {
    common: { bid: 21.00, ask: 21.04, last: 21.02, bidSize: 20000, askSize: 20000 },
    main: { bid: 52.00, ask: 52.10, last: 52.05, bidSize: 5000, askSize: 5000 },
  },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 400, as: 'pref',
      expect: {
        preview: { blocking: 0, errors: [], notes: ['support'], legs: [{ action: 'buy', qty: 400, estimate: 52.10, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -20_840, fees: 0 }], // 400 x 52.10
          cash: { USD: { purchases: 20_840, fees: 0, required: 20_840, available: 500_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 400, avgPrice: 52.10 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 400 TLGB.PRB @ 52.10 USD' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -20_840, availableToTrade: 479_160 } } },
        positions: [{ instrument: 'main', lot: 'pref', owner: 'account', direction: 'long', qty: 400, avgCost: 52.10, cost: 20_840, price: 52.05, value: 20_820, unrealized: -20 }],
        holdings: { main: { long: 400, short: 0, net: 400 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-03', amount: -20_840, into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, commissions: 0, fees: 0, borrowFunding: 0, unrealized: -20, total: -20 } },
        nav: { account: 499_980, book: 999_980 },
        balance: { account: { cash: 500_000, positions: 20_820, payable: 20_840, assets: 520_820, liabilities: 20_840, netAssets: 499_980 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: TUE,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 20,840.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 479_160, unsettled: 0, availableToTrade: 479_160 } } },
        pending: [],
        balance: { account: { cash: 479_160, payable: null, assets: 499_980, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'pref', factor: 1.25, // 400 -> 500
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', qty: 100, estimate: 52.10, settleDate: '2026-03-04', cash: -5_210, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 100, avgPrice: 52.10 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 100 TLGB.PRB @ 52.10 USD' }],
        cash: { account: { USD: { settled: 479_160, unsettled: -5_210, availableToTrade: 473_950 } } },
        positions: [{ instrument: 'main', lot: 'pref', qty: 500, cost: 26_050, avgCost: 52.10, price: 52.05, value: 26_025, unrealized: -25 }],
        holdings: { main: { long: 500, short: 0, net: 500 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-04', amount: -5_210, into: 'cash' }],
        pnl: { account: { unrealized: -25, total: -25 } },
        nav: { account: 499_975, book: 999_975 },
        balance: { account: { cash: 479_160, positions: 26_025, payable: 5_210, assets: 505_185, liabilities: 5_210, netAssets: 499_975 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: WED,
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 5,210.00 USD' }],
        cash: { account: { USD: { settled: 473_950, unsettled: 0, availableToTrade: 473_950 } } },
        pending: [],
        balance: { account: { cash: 473_950, payable: null, assets: 499_975, liabilities: 0 } },
      },
    },
    { id: 'dividend-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'main', type: 'cash_dividend', exDate: '2026-03-05', amount: 0.71875, expect: {} }, // 5.75% x 50.00 / 4
    {
      id: 'dividend-paid', covers: 'dividend', action: 'clock', to: THU,
      expect: {
        events: [{ type: 'dividend', summary: 'Dividend on 500 TLGB.PRB: 359.38 USD (0.71875 per unit, ex-date 2026-03-05)', cash: { USD: 359.38 } }], // 500 x 0.71875 = 359.375
        cash: { account: { USD: { settled: 474_309.38, availableToTrade: 474_309.38 } } },
        pnl: { account: { dividends: 359.38, total: 334.38 } },
        nav: { account: 500_334.38, book: 1_000_334.38 },
        balance: { account: { cash: 474_309.38, assets: 500_334.38, netAssets: 500_334.38 } },
      },
    },
    { id: 'shares-rally', action: 'quote', instrument: 'common', quote: { bid: 24.00, ask: 24.04, last: 24.02, bidSize: 20000, askSize: 20000 }, expect: {} },
    {
      id: 'preferred-rallies', action: 'quote', instrument: 'main', quote: { bid: 59.60, ask: 59.80, last: 59.70, bidSize: 5000, askSize: 5000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'pref', qty: 500, price: 59.70, value: 29_850, unrealized: 3_800 }], // 500 x 59.70 - 26,050
        pnl: { account: { unrealized: 3_800, total: 4_159.38 } },
        nav: { account: 504_159.38, book: 1_004_159.38 },
        balance: { account: { positions: 29_850, assets: 504_159.38, netAssets: 504_159.38 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 100, from: 'pref',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 100, estimate: 59.60, settleDate: '2026-03-06', cash: 5_960, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 100, avgPrice: 59.60 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 100 TLGB.PRB @ 59.60 USD (realized 750.00 USD)' }], // 100 x (59.60 - 52.10)
        cash: { account: { USD: { settled: 474_309.38, unsettled: 5_960, availableToTrade: 480_269.38 } } },
        positions: [{ instrument: 'main', lot: 'pref', qty: 400, cost: 20_840, avgCost: 52.10, price: 59.70, value: 23_880, unrealized: 3_040 }],
        holdings: { main: { long: 400, short: 0, net: 400 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-06', amount: 5_960, into: 'cash' }],
        pnl: { account: { realized: 750, dividends: 359.38, unrealized: 3_040, total: 4_149.38 } },
        nav: { account: 504_149.38, book: 1_004_149.38 },
        balance: { account: { cash: 474_309.38, receivable: 5_960, positions: 23_880, assets: 504_149.38, liabilities: 0, netAssets: 504_149.38 } },
      },
    },
    {
      id: 'automatic-conversion', covers: 'conversion', action: 'lifecycle', lot: 'pref', body: { action: 'convert', qty: 200 },
      status: 'unsupported', reason: 'Conversion into common shares is not simulated; the catalog says it is recorded by hand.',
      expect: { refused: { api: 'Unknown lifecycle action "convert"', browser: 'offers only: Manual cash flow' } },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: FRI,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 5,960.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 480_269.38, unsettled: 0, availableToTrade: 480_269.38 } } },
        pending: [],
        balance: { account: { cash: 480_269.38, receivable: null } },
      },
    },
    {
      // Convert 200 preferred into 500 common, first ticket: the preferred given up at its average cost 52.10.
      id: 'conversion-preferred-given-up', covers: 'conversion', action: 'ticket', instrument: 'main', side: 'sell', qty: 200, from: 'pref', order: { statedPrice: 52.10 },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 200, estimate: 52.10, model: 'stated-price', settleDate: '2026-03-09', cash: 10_420, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 200, avgPrice: 52.10, fills: [{ qty: 200, price: 52.10, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 200 TLGB\.PRB @ 52\.10 USD$/ }],
        cash: { account: { USD: { settled: 480_269.38, unsettled: 10_420, availableToTrade: 490_689.38 } } },
        positions: [{ instrument: 'main', lot: 'pref', qty: 200, cost: 10_420, avgCost: 52.10, price: 59.70, value: 11_940, unrealized: 1_520 }],
        holdings: { main: { long: 200, short: 0, net: 200 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-09', amount: 10_420, into: 'cash' }],
        pnl: { account: { realized: 750, unrealized: 1_520, total: 2_629.38 } },
        nav: { account: 502_629.38, book: 1_002_629.38 },
        balance: { account: { cash: 480_269.38, receivable: 10_420, positions: 11_940, assets: 502_629.38, netAssets: 502_629.38 } },
      },
    },
    {
      // Second ticket: 500 common received (200 x 2.5) at the cost carried over, 10,420 / 500 = 20.84 a share.
      id: 'conversion-shares-received', covers: 'conversion', action: 'ticket', instrument: 'common', side: 'buy', qty: 500, as: 'shares', order: { statedPrice: 20.84 },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy', instrument: 'common', qty: 500, estimate: 20.84, model: 'stated-price', settleDate: '2026-03-09', cash: -10_420, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 500, avgPrice: 20.84, fills: [{ qty: 500, price: 20.84, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 500 TLGB @ 20.84 USD' }],
        cash: { account: { USD: { settled: 480_269.38, unsettled: 0, availableToTrade: 480_269.38 } } }, // 10,420 owed to the Account and 10,420 owed by it
        positions: [
          { instrument: 'common', lot: 'shares', owner: 'account', direction: 'long', qty: 500, cost: 10_420, avgCost: 20.84, price: 24.02, value: 12_010, unrealized: 1_590 }, // 500 x 24.02
          { instrument: 'main', lot: 'pref', qty: 200, cost: 10_420, value: 11_940, unrealized: 1_520 },
        ],
        holdings: { common: { long: 500, short: 0, net: 500 }, main: { long: 200, short: 0, net: 200 } },
        pending: [{ instrument: 'common', dueDate: '2026-03-09', amount: -10_420, into: 'cash' }, { instrument: 'main', dueDate: '2026-03-09', amount: 10_420, into: 'cash' }],
        pnl: { account: { realized: 750, unrealized: 3_110, total: 4_219.38 } },
        nav: { account: 504_219.38, book: 1_004_219.38 },
        balance: { account: { cash: 480_269.38, receivable: 10_420, positions: 23_950, payable: 10_420, assets: 514_639.38, liabilities: 10_420, netAssets: 504_219.38 } },
      },
    },
    {
      id: 'settle-conversion', covers: 'settlement', action: 'clock', to: MON2,
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 10,420.00 USD into settled cash' }, { type: 'settlement.pay', summary: 'paid 10,420.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 480_269.38, unsettled: 0, availableToTrade: 480_269.38 } } }, // no net cash
        pending: [],
        balance: { account: { cash: 480_269.38, receivable: null, payable: null, assets: 504_219.38, liabilities: 0 } },
      },
    },
    {
      id: 'close-preferred', covers: 'close', action: 'close', lot: 'pref', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 200, estimate: 59.60, settleDate: '2026-03-10', cash: 11_920, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 200, avgPrice: 59.60 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 200 TLGB.PRB @ 59.60 USD (realized 1,500.00 USD)' }], // 11,920 - 10,420
        cash: { account: { USD: { settled: 480_269.38, unsettled: 11_920, availableToTrade: 492_189.38 } } },
        positions: [{ instrument: 'common', lot: 'shares', qty: 500, cost: 10_420, value: 12_010, unrealized: 1_590 }],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-03-10', amount: 11_920, into: 'cash' }],
        pnl: { account: { realized: 2_250, unrealized: 1_590, total: 4_199.38 } },
        nav: { account: 504_199.38, book: 1_004_199.38 },
        balance: { account: { cash: 480_269.38, receivable: 11_920, positions: 12_010, assets: 504_199.38, netAssets: 504_199.38 } },
      },
    },
    {
      id: 'close-shares', covers: 'close', action: 'ticket', instrument: 'common', side: 'sell', qty: 500, from: 'shares',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', instrument: 'common', qty: 500, estimate: 24.00, settleDate: '2026-03-10', cash: 12_000, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 500, avgPrice: 24.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 500 TLGB @ 24.00 USD (realized 1,580.00 USD)' }], // 12,000 - 10,420
        cash: { account: { USD: { settled: 480_269.38, unsettled: 23_920, availableToTrade: 504_189.38 } } },
        positions: [],
        holdings: { common: null },
        pending: [{ instrument: 'common', dueDate: '2026-03-10', amount: 12_000, into: 'cash' }, { instrument: 'main', dueDate: '2026-03-10', amount: 11_920, into: 'cash' }],
        pnl: { account: { realized: 3_830, dividends: 359.38, unrealized: 0, total: 4_189.38 } }, // 750 + 1,500 + 1,580
        nav: { account: 504_189.38, book: 1_004_189.38 },
        balance: { account: { cash: 480_269.38, receivable: 23_920, positions: null, assets: 504_189.38, netAssets: 504_189.38 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: TUE2,
      expect: {
        events: [{ type: 'settlement.receive', summary: /received 1[12],[09][02]0\.00 USD/ }, { type: 'settlement.receive', summary: /received 1[12],[09][02]0\.00 USD/ }],
        cash: { account: { USD: { settled: 504_189.38, unsettled: 0, availableToTrade: 504_189.38 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 504_189.38, receivable: null, assets: 504_189.38, liabilities: 0, netAssets: 504_189.38 } },
      },
    },
  ],
};

export default [commonStock, preferredStock, adr, gdr, etf, etn, closedEndFund, reit, shortSale, warrant, subscriptionRight, convertiblePreferred];
