// Digital-asset family (engine family "crypto"): cryptocurrencies, stablecoins and tokenized assets.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec (quotes, quantities,
// the Book's fee schedule and settlement assumptions). The arithmetic is in the comment beside it. Nothing
// here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be followed):
//   - A digital asset trades on the 24x7 calendar (ALLDAYS): an order fills on a Saturday or a Sunday like any day.
//   - Quantities are fractional to 1e-8 of a unit.
//   - A market buy fills at the ask, a market sell at the bid, of the quote in force. The Book's crypto fee
//     schedule (basis points of principal) is charged as commission and expensed.
//   - Settlement is same-day (Book setting settlement.crypto = 0): the fill and its cash settle in the same cycle,
//     counted on the 24x7 calendar.
//   - Average cost; a sale removes cost at the average. Positions are valued at the last price.
//   - Not exchange-listed securities: the trading platform is entered as an OTC venue, so the Marketplace routing
//     convention (server/core/catalog.js) places the asset in Foreign Based; nothing implies a US listing.
//   - No short sales: digital assets have no securities borrow in the Terminal, and the ticket does not offer one.
//   - Events of the asset itself (forks, airdrops, staking rewards) are recorded by hand. Units received for nothing
//     are recorded as a purchase at a stated fill price of 0.00: they arrive at zero cost, so their value shows as
//     unrealized gain (the Terminal has no income-in-kind entry; see the matrix text).
//   - US clocks move to daylight time on Sunday 8 March 2026: 10:00 New York is 15:00 UTC on Saturday 7 March and
//     14:00 UTC from Sunday 8 March. The business date is New York's.

export const family = 'crypto';

const book = (name, over = {}) => ({
  name,
  reportingCcy: 'USD',
  capital: over.capital || [{ ccy: 'USD', amount: 1_000_000 }],
  account: { name: 'Alpha', funding: over.funding || [{ ccy: 'USD', amount: 500_000 }] },
  settings: {
    fees: { crypto: { perUnit: 0, minimum: 0, bps: 20, ...(over.fee || {}) } }, // 0.20% of principal, the platform's taker fee
    fill: { halfSpreadBps: { crypto: 5 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 },
    settlement: { crypto: 0, foreignCash: 2 },
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

const CRYPTO_TICKET = {
  ticket: 'Instrument drawer, Trade tab (security ticket: Buy, Sell; no Sell short), then the trade preview',
  requiredFields: ['Account (trading owner)', 'Action', 'Units (fractional to 1e-8)'],
  automaticInputs: ['bid, ask, last and size (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model', 'settlement date on the 24x7 calendar (same day)', 'commission from the Book crypto fee schedule (basis points)'],
};

// ---------------------------------------------------------------------------------------------
// cryptocurrency
// ---------------------------------------------------------------------------------------------
// A native coin bought on a Saturday and again (a fractional amount) on a Sunday, a staking reward recorded by hand,
// a partial sale on Monday, then everything sold. Weekend fills and same-day settlement on the 24x7 calendar.
const cryptocurrency = {
  productId: 'cryptocurrency',
  title: 'Halcyon (HLC), a native cryptocurrency on a crypto trading platform: weekend fills, fractional units, bps fees',
  matrix: {
    ...CRYPTO_TICKET,
    manualInputs: ['staking reward (units received), recorded by hand as a purchase at a stated fill price of 0.00; forks and airdrops the same way'],
    settlement: 'Same day (Book setting settlement.crypto = 0) on the 24x7 calendar (ALLDAYS): weekend trades settle on the weekend',
    lifecycle: 'None automated; staking rewards, forks and airdrops recorded by hand',
    accounting: 'Average cost; commission in basis points expensed; realized P&L on sale; valued at the last price; units received for nothing carried at zero cost (their value is unrealized gain, not income)',
    collateral: 'None; no securities borrow, so no short sale',
  },
  start: '2026-03-07T15:00:00.000Z', // Saturday 7 March 2026, 10:00 New York
  settlementCheck: false, // the 24x7 calendar counts weekends; the audit's weekday calculator does not apply (dates are stated by hand below)
  book: book('Matrix cryptocurrency'),
  instruments: {
    main: { productId: 'cryptocurrency', name: 'Halcyon', symbol: 'HLC', marketView: 'FOREIGN_CASH', venue: 'Kestrel Digital (crypto trading platform)', venueType: 'otc', venueCountry: 'US', underlyingGeo: 'Global', tradingCcy: 'USD', terms: {} },
  },
  quotes: { main: { bid: 41_250, ask: 41_262.50, last: 41_256, bidSize: 10, askSize: 10 } },
  expectAtStart: START_STATE,
  steps: [
    {
      id: 'buy-saturday', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2.5, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2.5, estimate: 41_262.50, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-07', calendar: 'ALLDAYS',
            cash: -103_156.25, // 2.5 x 41,262.50 (the ask)
            fees: 206.31 }], // 0.20% x 103,156.25 = 206.3125
          cash: { USD: { purchases: 103_156.25, fees: 206.31, required: 103_362.56, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2.5, avgPrice: 41_262.50, fills: [{ qty: 2.5, price: 41_262.50, model: 'quoted-bid-ask', settleDate: '2026-03-07', source: 'Test fixture', status: 'simulated', date: '2026-03-07' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 2.5 HLC @ 41,262.50 USD', owner: 'account', date: '2026-03-07' },
          { type: 'settlement.pay', summary: 'paid 103,362.56 USD from settled cash', cash: { USD: -103_362.56 }, date: '2026-03-07' }, // same day, a Saturday
        ],
        cash: { account: { USD: { settled: 396_637.44, unsettled: 0, availableToTrade: 396_637.44 } } }, // 500,000 - 103,362.56
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2.5, avgCost: 41_262.5, cost: 103_156.25, price: 41_256,
          value: 103_140, // 2.5 x 41,256 (last)
          unrealized: -16.25, priceSource: 'Test fixture' }],
        holdings: { main: { long: 2.5, short: 0, net: 2.5 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -206.31, fees: 0, unrealized: -16.25, total: -222.56 } },
        nav: { account: 499_777.44, book: 999_777.44 },
        balance: { account: { cash: 396_637.44, positions: 103_140, assets: 499_777.44, liabilities: 0, netAssets: 499_777.44 } },
      },
    },
    {
      id: 'sunday', action: 'clock', to: '2026-03-08T14:00:00.000Z', // Sunday 8 March, 10:00 New York (daylight time)
      expect: {},
    },
    {
      id: 'quote-sunday', action: 'quote', instrument: 'main', quote: { bid: 41_780, ask: 41_800, last: 41_790, bidSize: 10, askSize: 10 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2.5, price: 41_790, value: 104_475, unrealized: 1_318.75 }], // 2.5 x 41,790; less 103,156.25
        pnl: { account: { unrealized: 1_318.75, total: 1_112.44 } },
        nav: { account: 501_112.44, book: 1_001_112.44 },
        balance: { account: { positions: 104_475, assets: 501_112.44, netAssets: 501_112.44 } },
      },
    },
    {
      id: 'buy-fraction-sunday', covers: 'increase', action: 'ticket', instrument: 'main', side: 'buy', qty: 0.12345678, as: 'lot2',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', qty: 0.12345678, estimate: 41_800, settleDate: '2026-03-08', calendar: 'ALLDAYS',
            cash: -5_160.49, // 0.12345678 x 41,800 = 5,160.493404
            fees: 10.32 }], // 0.20% x 5,160.493404 = 10.3210
          cash: { USD: { purchases: 5_160.49, fees: 10.32, required: 5_170.81, available: 396_637.44, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 0.12345678, avgPrice: 41_800 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 0.12345678 HLC @ 41,800.00 USD', date: '2026-03-08' },
          { type: 'settlement.pay', summary: 'paid 5,170.81 USD from settled cash', cash: { USD: -5_170.81 }, date: '2026-03-08' },
        ],
        cash: { account: { USD: { settled: 391_466.63, availableToTrade: 391_466.63 } } }, // 396,637.44 - 5,170.81
        positions: [
          { instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2.5, avgCost: 41_262.5, cost: 103_156.25, price: 41_790, value: 104_475, unrealized: 1_318.75 },
          // avgCost not stated: the cost is carried to the cent (5,160.49) and its quotient by 0.12345678 has no short exact form.
          { instrument: 'main', lot: 'lot2', owner: 'account', direction: 'long', qty: 0.12345678, cost: 5_160.49, price: 41_790,
            value: 5_159.26, // 0.12345678 x 41,790 = 5,159.2588
            unrealized: -1.23 }, // 5,159.2588 - 5,160.49
        ],
        holdings: { main: { long: 2.62345678, short: 0, net: 2.62345678 } },
        pnl: { account: { commissions: -216.63, unrealized: 1_317.52, total: 1_100.89 } }, // 206.31 + 10.32; 1,318.75 - 1.23
        nav: { account: 501_100.89, book: 1_001_100.89 },
        balance: { account: { cash: 391_466.63, positions: 109_634.26, assets: 501_100.89, netAssets: 501_100.89 } }, // 104,475 + 5,159.26
      },
    },
    {
      id: 'staking-reward-by-hand', covers: 'staking reward', action: 'ticket', instrument: 'main', side: 'buy', qty: 0.05, as: 'reward', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', qty: 0.05, estimate: 0, model: 'stated-price', settleDate: '2026-03-08', cash: 0, fees: 0 }], // 0.05 x 0.00; 0.20% of nothing
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 0.05, avgPrice: 0, fills: [{ qty: 0.05, price: 0, model: 'stated-price', settleDate: '2026-03-08', source: null, status: null, date: '2026-03-08' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 0.05 HLC @ 0.00 USD', date: '2026-03-08' }], // no cash, so nothing to settle
        positions: [
          { instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2.5, avgCost: 41_262.5, cost: 103_156.25, price: 41_790, value: 104_475, unrealized: 1_318.75 },
          { instrument: 'main', lot: 'lot2', owner: 'account', direction: 'long', qty: 0.12345678, cost: 5_160.49, price: 41_790, value: 5_159.26, unrealized: -1.23 },
          { instrument: 'main', lot: 'reward', owner: 'account', direction: 'long', qty: 0.05, avgCost: 0, cost: 0, price: 41_790, value: 2_089.50, unrealized: 2_089.50 }, // 0.05 x 41,790
        ],
        holdings: { main: { long: 2.67345678, short: 0, net: 2.67345678 } },
        pnl: { account: { unrealized: 3_407.02, total: 3_190.39 } }, // 1,317.52 + 2,089.50; less 216.63 commission
        nav: { account: 503_190.39, book: 1_003_190.39 },
        balance: { account: { positions: 111_723.76, assets: 503_190.39, netAssets: 503_190.39 } }, // 109,634.26 + 2,089.50
      },
    },
    {
      id: 'monday', action: 'clock', to: '2026-03-09T14:00:00.000Z',
      expect: {},
    },
    {
      id: 'quote-monday', action: 'quote', instrument: 'main', quote: { bid: 40_900, ask: 40_920, last: 40_910, bidSize: 10, askSize: 10 },
      expect: {
        positions: [
          { instrument: 'main', lot: 'lot', qty: 2.5, price: 40_910, value: 102_275, unrealized: -881.25 }, // 2.5 x 40,910 - 103,156.25
          { instrument: 'main', lot: 'lot2', qty: 0.12345678, price: 40_910, value: 5_050.62, unrealized: -109.87 }, // 0.12345678 x 40,910 = 5,050.6169; - 5,160.49
          { instrument: 'main', lot: 'reward', qty: 0.05, price: 40_910, value: 2_045.50, unrealized: 2_045.50 },
        ],
        pnl: { account: { unrealized: 1_054.38, total: 837.75 } }, // -881.25 - 109.87 + 2,045.50; less 216.63
        nav: { account: 500_837.75, book: 1_000_837.75 },
        balance: { account: { positions: 109_371.12, assets: 500_837.75, netAssets: 500_837.75 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 1.2, from: 'lot',
      expect: {
        preview: {
          blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 1.2, estimate: 40_900, model: 'quoted-bid-ask', settleDate: '2026-03-09', cash: 49_080, fees: 98.16 }], // 1.2 x 40,900 (the bid); 0.20% x 49,080
          cash: { USD: { proceeds: 49_080, fees: 98.16 } },
        },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1.2, avgPrice: 40_900 }] },
        // Cost out at the average: 103,156.25 x 1.2 / 2.5 = 49,515.00. Realized 49,080 - 49,515 = -435.00.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 1\.2 HLC @ 40,900\.00 USD \(realized -435\.00 USD\)$/, date: '2026-03-09' },
          { type: 'settlement.receive', summary: 'received 48,981.84 USD into settled cash', cash: { USD: 48_981.84 }, date: '2026-03-09' }, // 49,080 - 98.16
        ],
        cash: { account: { USD: { settled: 440_448.47, availableToTrade: 440_448.47 } } }, // 391,466.63 + 48,981.84
        positions: [
          { instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1.3, avgCost: 41_262.5, cost: 53_641.25, price: 40_910, value: 53_183, unrealized: -458.25 }, // 103,156.25 - 49,515; 1.3 x 40,910
          { instrument: 'main', lot: 'lot2', owner: 'account', direction: 'long', qty: 0.12345678, cost: 5_160.49, price: 40_910, value: 5_050.62, unrealized: -109.87 },
          { instrument: 'main', lot: 'reward', owner: 'account', direction: 'long', qty: 0.05, avgCost: 0, cost: 0, price: 40_910, value: 2_045.50, unrealized: 2_045.50 },
        ],
        holdings: { main: { long: 1.47345678, short: 0, net: 1.47345678 } },
        pnl: { account: { realized: -435, commissions: -314.79, unrealized: 1_477.38, total: 727.59 } }, // 216.63 + 98.16; -458.25 - 109.87 + 2,045.50
        nav: { account: 500_727.59, book: 1_000_727.59 },
        balance: { account: { cash: 440_448.47, positions: 60_279.12, assets: 500_727.59, netAssets: 500_727.59 } }, // 53,183 + 5,050.62 + 2,045.50
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 1, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: 'A digital asset has no securities borrow in the Terminal, so it cannot be sold short.',
      expect: { refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' } },
    },
    {
      id: 'oversell', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 2, from: 'lot2',
      status: 'blocked', reason: 'The second lot holds 0.12345678 HLC.',
      expect: { refused: 'more than it holds' },
    },
    {
      id: 'close-lot', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 1.3, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 1.3, estimate: 40_900, settleDate: '2026-03-09', cash: 53_170, fees: 106.34 }] }, // 1.3 x 40,900; 0.20%
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1.3, avgPrice: 40_900 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 1\.3 HLC @ 40,900\.00 USD \(realized -471\.25 USD\)$/ }, // 53,170 - 53,641.25
          { type: 'settlement.receive', summary: 'received 53,063.66 USD into settled cash' }, // 53,170 - 106.34
        ],
        cash: { account: { USD: { settled: 493_512.13, availableToTrade: 493_512.13 } } }, // 440,448.47 + 53,063.66
        positions: [
          { instrument: 'main', lot: 'lot2', owner: 'account', direction: 'long', qty: 0.12345678, cost: 5_160.49, price: 40_910, value: 5_050.62, unrealized: -109.87 },
          { instrument: 'main', lot: 'reward', owner: 'account', direction: 'long', qty: 0.05, avgCost: 0, cost: 0, price: 40_910, value: 2_045.50, unrealized: 2_045.50 },
        ],
        holdings: { main: { long: 0.17345678, short: 0, net: 0.17345678 } },
        pnl: { account: { realized: -906.25, commissions: -421.13, unrealized: 1_935.63, total: 608.25 } }, // -435 - 471.25; 314.79 + 106.34; -109.87 + 2,045.50
        nav: { account: 500_608.25, book: 1_000_608.25 },
        balance: { account: { cash: 493_512.13, positions: 7_096.12, assets: 500_608.25, netAssets: 500_608.25 } },
      },
    },
    {
      id: 'close-fraction', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 0.12345678, from: 'lot2',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 0.12345678, estimate: 40_900, cash: 5_049.38, fees: 10.10 }] }, // 0.12345678 x 40,900 = 5,049.3823; 0.20% = 10.0988
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 0.12345678, avgPrice: 40_900 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 0\.12345678 HLC @ 40,900\.00 USD \(realized -111\.11 USD\)$/ }, // 5,049.38 - 5,160.49
          { type: 'settlement.receive', summary: 'received 5,039.28 USD into settled cash' }, // 5,049.38 - 10.10
        ],
        cash: { account: { USD: { settled: 498_551.41, availableToTrade: 498_551.41 } } },
        positions: [{ instrument: 'main', lot: 'reward', owner: 'account', direction: 'long', qty: 0.05, avgCost: 0, cost: 0, price: 40_910, value: 2_045.50, unrealized: 2_045.50 }],
        holdings: { main: { long: 0.05, short: 0, net: 0.05 } },
        pnl: { account: { realized: -1_017.36, commissions: -431.23, unrealized: 2_045.50, total: 596.91 } },
        nav: { account: 500_596.91, book: 1_000_596.91 },
        balance: { account: { cash: 498_551.41, positions: 2_045.50, assets: 500_596.91, netAssets: 500_596.91 } },
      },
    },
    {
      id: 'sell-reward', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 0.05, from: 'reward',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 0.05, estimate: 40_900, cash: 2_045, fees: 4.09 }] }, // 0.05 x 40,900; 0.20%
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 0.05, avgPrice: 40_900 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 0.05 HLC @ 40,900.00 USD (realized 2,045.00 USD)' }, // zero cost
          { type: 'settlement.receive', summary: 'received 2,040.91 USD into settled cash' },
        ],
        cash: { account: { USD: { settled: 500_592.32, unsettled: 0, availableToTrade: 500_592.32 } }, treasury: { USD: { settled: 500_000 } } },
        positions: [],
        holdings: { main: null },
        pnl: { account: { realized: 1_027.64, commissions: -435.32, unrealized: 0, total: 592.32 } }, // -1,017.36 + 2,045; 431.23 + 4.09
        nav: { account: 500_592.32, book: 1_000_592.32 },
        balance: { account: { cash: 500_592.32, positions: null, assets: 500_592.32, liabilities: 0, netAssets: 500_592.32 } },
      },
    },
  ],
};

export default [cryptocurrency];
