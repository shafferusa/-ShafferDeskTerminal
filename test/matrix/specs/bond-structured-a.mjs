// Bond family (engine family "bond"), structured group A: 12 catalog products marked "partial" in the catalog
// (inflation-linked, callable, puttable, convertible, exchangeable and contingent convertible bonds, mortgage-backed
// securities). One scenario each, on a fictional instrument registered as exactly that product with the terms a real
// instrument of that product has. The catalog's manual events (index ratio, call, put, conversion, trigger, paydown,
// loss) are recorded by hand through the interface, to completion.
//
// Every expected number is a literal worked out by hand from the inputs stated in the same spec. The arithmetic is in
// the comment beside it. Nothing here is copied from what the Terminal prints.
//
// The general rules for debt securities are those of bond-government.mjs and bond-corporate.mjs, restated:
//   - Quantity is face amount. A price is the clean price in percent of par. A market buy fills at the ask, a market
//     sell at the bid, of the quote in force.
//   - A trade settles principal plus the accrued interest to its SETTLEMENT date, each rounded to the cent.
//     Commission comes from the Book's fee schedule on the clean principal and is expensed.
//   - Accrued interest: ACT/ACT (ICMA) face x coupon / frequency x days since the last coupon date / days in the period;
//     30/360 face x coupon x days30 / 360.
//   - The position is carried at clean cost with average cost, valued clean at the last price. Accrued interest is a
//     separate asset ("Accrued income"); its growth is coupon and interest income.
//   - At the end of each business day D (17:00 New York, NYSE days) the accrued balance is trued up to: interest to D
//     on the face settled by D, plus the interest bought (less sold) in trades settling after D, to their settlement
//     dates. The end-of-day run happens once per clock move, for the latest day that has ended.
//   - A coupon is paid on its coupon date, moved to the next business day of the payment calendar, to the face settled
//     before the coupon date.
//
// The Terminal's rules for the structured terms (server/products/bond.js), restated so the arithmetic can be followed:
//   - Principal outstanding per unit of face = pool factor x index ratio (each 1 for a plain bond). A trade settles
//     face x factor x ratio x price / 100 plus accrued interest on the same principal; a position is valued and its
//     average cost shown per 100 of that principal; coupons are paid on it.
//   - Inflation-linked bonds: the index ratio (reference index on the date / on the dated date) is entered at
//     registration and recorded by hand after (no inflation index feed). Recording a new ratio books, for every holder,
//     face x (new - old) as inflation accretion: added to the position's cost and to coupon and interest income (a fall
//     is negative). The accrued interest is trued up to today on the new ratio. At maturity the bond repays face x
//     ratio; with a deflation floor (US TIPS) never less than par. Coupons are never floored.
//
// Clock: scenario instants are 10:00 New York unless a step says otherwise.

export const family = 'bond';

/** 10:00 in New York on a date in Eastern Standard Time (UTC-5): November to early March. */
const EST = (d) => `${d}T15:00:00.000Z`;
/** 10:00 in New York on a date in Eastern Daylight Time (UTC-4): mid-March to the end of October. */
const EDT = (d) => `${d}T14:00:00.000Z`;

/** Fill assumptions every scenario states in full (a quote with a bid and an ask fills at them). */
const FILL = { halfSpreadBps: { bond: 3 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const SHORT = { collateralPct: 1.02, marginPct: 0.3 };

/** State before any trade: capital deposited in Treasury, part of it funded to the Account (reporting currency amounts). */
const startState = (account, treasury) => ({
  positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [],
  nav: { account, treasury, book: account + treasury },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
});
const idle = (amount) => ({ settled: amount, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: amount });
const usdCash = (amount) => ({ USD: idle(amount) });

const BOND_TICKET = {
  ticket: 'Instrument drawer, Trade tab (security ticket: Account, Action, Face amount, order terms, Settlement), then the trade preview',
  requiredFields: ['Account', 'Action', 'Face amount'],
  automaticInputs: ['bid, ask, last in % of par (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model', 'accrued interest to the settlement date from the registered coupon terms', 'settlement date from the instrument convention and settlement calendar', 'commission from the Book fee schedule'],
};

// ---------------------------------------------------------------------------------------------
// tips
// ---------------------------------------------------------------------------------------------
// A US Treasury Inflation-Protected Security: 0.375% real coupon, 15 January and 15 July, ACT/ACT, T+1 on the US bond
// calendar, multiples of 100 face, maturing Friday 15 January 2027, with the TIPS deflation floor. Fictional, and run in
// a DEFLATION scenario so that the floor binds: the reference CPI falls below its level at the dated date before
// maturity.
//
// Index ratios (entered by hand): 1.00620 at registration (for settlement on 2 December 2026), 1.00910 recorded on
// 2 December (an up-move: accretion earned), 0.99790 recorded on 12 January 2027 (a fall below 1: accretion lost, and
// the redemption is floored at par).
//
// Coupon period 15 Jul 2026 to 15 Jan 2027: 184 days (16 + 31 + 30 + 31 + 30 + 31 + 15). A full real coupon is
// 0.1875 per 100 of adjusted principal. Days from 15 July: to 2 Dec 140, 3 Dec 141, 23 Dec 161, 24 Dec 162, 28 Dec 166,
// 11 Jan 180, 12 Jan 181. Accrued = face x ratio x 0.1875% x days / 184.
// Christmas, Friday 25 December 2026, is a bond-market and stock-market holiday: the partial sale on Thursday
// 24 December settles on Monday 28 December. Commission: 0.5 basis point of clean principal.
const tipsDraft = {
  productId: 'tips', name: 'US Treasury 0.375% Inflation-Indexed Note 15-Jan-2027', symbol: 'TII-0.375-JAN27', marketView: 'US_CASH', venueType: 'otc', issuer: 'United States Treasury', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
  terms: { couponType: 'fixed', couponRate: 0.00375, frequency: 2, maturity: '2027-01-15', issueDate: '2022-01-15', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 100, indexRatio: 1.0062, inflationFloor: true },
};
const tips = {
  productId: 'tips',
  title: 'US TIPS 0.375% due 15 January 2027: index ratios recorded by hand (up, then below 1), partial sale over Christmas, final coupon on adjusted principal, redemption floored at par',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 100)'],
    manualInputs: ['Registration: Index ratio (required; no inflation index feed) and Deflation floor', 'Index ratio recorded by hand on the instrument form (Edit, Lifecycle events recorded by hand: New index ratio, Index ratio as of, Review, Record index ratio)'],
    settlement: 'T+1 on the US bond calendar; principal = face x index ratio x clean price; accrued on the adjusted principal; Christmas skipped',
    lifecycle: 'Daily accrual on the adjusted principal; index ratio changes by hand book inflation accretion (income or loss) and true up accrued; final coupon on face x ratio; redemption at face x ratio floored at par (deflation floor)',
    accounting: 'Cost includes inflation accretion; accretion and coupon in coupon and interest income; realized P&L on the sale and on the floored redemption; commission expensed',
    collateral: 'None for a long position',
  },
  start: EST('2026-12-01'), // Tuesday
  settlementCheck: { lag: 1, holidays: ['2026-12-25'] },
  book: {
    name: 'Matrix TIPS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: { main: tipsDraft },
  quotes: { main: { bid: 99.75, ask: 99.78125, last: 99.765625, bidSize: 20_000_000, askSize: 20_000_000 } }, // real clean prices
  expectAtStart: { ...startState(2_000_000, 1_000_000), cash: { account: usdCash(2_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      // A second TIPS registered without its index ratio is refused: the Terminal has no index feed and does not assume 1.
      id: 'register-without-ratio', covers: 'registration', action: 'register_instrument',
      draft: { ...tipsDraft, name: 'US Treasury 0.125% Inflation-Indexed Note 15-Apr-2027', symbol: 'TII-0.125-APR27', terms: { ...tipsDraft.terms, couponRate: 0.00125, maturity: '2027-04-15', issueDate: '2022-04-15', indexRatio: undefined } },
      status: 'blocked', reason: 'An inflation-linked bond cannot be registered without its index ratio.',
      expect: { refused: 'needs its index ratio' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 99.78125, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-12-02', calendar: 'USBOND',
            notional: 1_006_200, // adjusted principal: 1,000,000 x 1.00620
            gross: 1_003_998.94, // 1,006,200 x 99.78125 / 100 = 1,003,998.9375
            accrued: 1_435.48, // 1,000,000 x 1.00620 x 0.1875% x 140/184 = 1,435.4755
            cash: -1_005_434.42, // 1,003,998.94 + 1,435.48
            fees: 50.2 }], // 0.5 bp of 1,003,998.94 = 50.1999
          cash: { USD: { purchases: 1_005_434.42, fees: 50.2, required: 1_005_484.62, available: 2_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 99.78125, fills: [{ qty: 1_000_000, price: 99.78125, model: 'quoted-bid-ask', settleDate: '2026-12-02', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 TII-0.375-JAN27 @ 99.78125 USD', owner: 'account', date: '2026-12-01' }],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -1_005_484.62, availableToTrade: 994_515.38 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000,
          avgCost: 99.78125, // 1,003,998.94 / (1,006,200 / 100)
          cost: 1_003_998.94, price: 99.765625,
          value: 1_003_841.72, // 1,006,200 x 99.765625 / 100 = 1,003,841.72
          unrealized: -157.22, accrued: 1_435.48, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-12-02', amount: -1_005_484.62, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-01-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2027-01-15', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -50.2, fees: 0, borrowFunding: 0, unrealized: -157.22, total: -207.42 } },
        nav: { account: 1_999_792.58, book: 2_999_792.58 }, // 2,000,000 - 50.20 - 157.22
        balance: { account: { cash: 2_000_000, accruedIncome: 1_435.48, positions: 1_003_841.72, payable: 1_005_484.62, assets: 3_005_277.20, liabilities: 1_005_484.62, netAssets: 1_999_792.58 } },
      },
    },
    {
      // End of day 1 Dec: the interest bought runs to 2 Dec and is already on the books. Nothing else.
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2026-12-02'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,005,484.62 USD from settled cash', cash: { USD: -1_005_484.62 }, date: '2026-12-02' }],
        cash: { account: { USD: { settled: 994_515.38, unsettled: 0, availableToTrade: 994_515.38 } } },
        pending: [],
        balance: { account: { cash: 994_515.38, payable: null, assets: 1_999_792.58, liabilities: 0 } },
      },
    },
    {
      // The index ratio for 2 December is recorded by hand: 1.00620 to 1.00910.
      // Accretion 1,000,000 x (1.00910 - 1.00620) = 2,900.00: cost 1,003,998.94 + 2,900 = 1,006,898.94, income 2,900.
      // Accrued trued up to today on the new ratio: 1,000,000 x 1.00910 x 0.1875% x 140/184 = 1,439.6128; on the books
      // 1,435.48: 4.13 more.
      id: 'index-ratio-up', covers: 'index ratio (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'index_ratio', ratio: 1.0091, asOf: '2026-12-02' },
      expect: {
        events: [
          { type: 'bond.index_ratio', summary: 'Index ratio of TII-0.375-JAN27 recorded by hand: 1.00620 to 1.00910 (as of 2026-12-02). Principal of 1,000,000 face up 2,900.00 USD: inflation accretion earned', owner: 'account', date: '2026-12-02' },
          { type: 'accrual.coupon', summary: 'Interest accrued on TII-0.375-JAN27: 4.13 USD' },
        ],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, cost: 1_006_898.94,
          avgCost: 99.781879, // 1,006,898.94 / 10,091 = 99.7818789
          price: 99.765625, value: 1_006_734.92, // 1,009,100 x 99.765625 / 100 = 1,006,734.92
          unrealized: -164.02, accrued: 1_439.61 }],
        pnl: { account: { couponInterest: 2_904.13, unrealized: -164.02, total: 2_689.91 } }, // 2,900 + 4.13; -50.20 - 164.02 + 2,904.13
        nav: { account: 2_002_689.91, book: 3_002_689.91 }, // 994,515.38 + 1,439.61 + 1,006,734.92
        balance: { account: { accruedIncome: 1_439.61, positions: 1_006_734.92, assets: 2_002_689.91, netAssets: 2_002_689.91 } },
      },
    },
    {
      // Bought at the new ratio, settling Thursday 3 Dec.
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 1,000,000 -> 1,500,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 500_000, estimate: 99.78125, settleDate: '2026-12-03',
          notional: 504_550, // 500,000 x 1.00910
          gross: 503_446.30, // 504,550 x 99.78125 / 100 = 503,446.2953
          accrued: 724.95, // 500,000 x 1.00910 x 0.1875% x 141/184 = 724.9479
          cash: -504_171.25, fees: 25.17 }], // 0.5 bp of 503,446.30 = 25.1723
          cash: { USD: { purchases: 504_171.25, fees: 25.17, required: 504_196.42, available: 994_515.38, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 500_000, avgPrice: 99.78125 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 500,000 TII-0.375-JAN27 @ 99.78125 USD' }],
        cash: { account: { USD: { settled: 994_515.38, unsettled: -504_196.42, availableToTrade: 490_318.96 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000,
          cost: 1_510_345.24, // 1,006,898.94 + 503,446.30
          avgCost: 99.781669, // 1,510,345.24 / 15,136.5 = 99.7816695
          price: 99.765625, value: 1_510_102.38, // 1,513,650 x 99.765625 / 100 = 1,510,102.383
          unrealized: -242.86, accrued: 2_164.56 }], // 1,439.61 + 724.95
        holdings: { main: { long: 1_500_000, short: 0, net: 1_500_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-12-03', amount: -504_196.42, into: 'cash' }],
        pnl: { account: { commissions: -75.37, unrealized: -242.86, total: 2_585.90 } }, // 50.20 + 25.17; 2,904.13 - 75.37 - 242.86
        nav: { account: 2_002_585.90, book: 3_002_585.90 },
        balance: { account: { cash: 994_515.38, accruedIncome: 2_164.56, positions: 1_510_102.38, payable: 504_196.42, assets: 2_506_782.32, liabilities: 504_196.42, netAssets: 2_002_585.90 } },
      },
    },
    {
      // End of day 2 Dec: 1,000,000 settled to 2 Dec (1,439.61) plus 500,000 to its settlement on 3 Dec (724.95): no change.
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: EST('2026-12-03'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 504,196.42 USD from settled cash', cash: { USD: -504_196.42 } }],
        cash: { account: { USD: { settled: 490_318.96, unsettled: 0, availableToTrade: 490_318.96 } } },
        pending: [],
        balance: { account: { cash: 490_318.96, payable: null, assets: 2_002_585.90, liabilities: 0 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 100.1, ask: 100.13125, last: 100.115625, bidSize: 20_000_000, askSize: 20_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, price: 100.115625, value: 1_515_400.16, unrealized: 5_054.92 }], // 1,513,650 x 100.115625 / 100 = 1,515,400.158; - 1,510,345.24
        pnl: { account: { unrealized: 5_054.92, total: 7_883.68 } }, // 2,904.13 - 75.37 + 5,054.92
        nav: { account: 2_007_883.68, book: 3_007_883.68 },
        balance: { account: { positions: 1_515_400.16, assets: 2_007_883.68, netAssets: 2_007_883.68 } },
      },
    },
    {
      // Thursday 24 December. End of day 23 Dec: 1,500,000 x 1.00910 x 0.1875% x 161/184 = 2,483.3320; on the books 2,164.56:
      // 318.77 more.
      id: 'christmas-eve', covers: 'accrual', action: 'clock', to: EST('2026-12-24'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on TII-0.375-JAN27: 318.77 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, accrued: 2_483.33 }],
        pnl: { account: { couponInterest: 3_222.90, total: 8_202.45 } }, // 2,904.13 + 318.77
        nav: { account: 2_008_202.45, book: 3_008_202.45 },
        balance: { account: { accruedIncome: 2_483.33, assets: 2_008_202.45, netAssets: 2_008_202.45 } },
      },
    },
    {
      // Sold on Christmas Eve: T+1 is Friday 25 December, a holiday, so it settles Monday 28 December. The accrued sold runs
      // to that date (166 days).
      id: 'reduce-over-christmas', covers: ['reduce', 'market holiday'], action: 'ticket', instrument: 'main', side: 'sell', qty: 600_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 600_000, estimate: 100.1, settleDate: '2026-12-28', calendar: 'USBOND',
          notional: 605_460, // 600,000 x 1.00910
          gross: 606_065.46, // 605,460 x 100.10 / 100
          accrued: 1_024.18, // 600,000 x 1.00910 x 0.1875% x 166/184 = 1,024.1817
          cash: 607_089.64, fees: 30.3 }] }, // 0.5 bp of 606,065.46 = 30.3033
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 600_000, avgPrice: 100.1 }] },
        // Cost removed at the average: 1,510,345.24 x 600,000 / 1,500,000 = 604,138.10; realized 606,065.46 - 604,138.10 = 1,927.36.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 600,000 TII-0.375-JAN27 @ 100.10 USD (realized 1,927.36 USD)', date: '2026-12-24' }],
        cash: { account: { USD: { settled: 490_318.96, unsettled: 607_059.34, availableToTrade: 1_097_378.30 } } }, // 607,089.64 - 30.30
        positions: [{ instrument: 'main', lot: 'lot', qty: 900_000, cost: 906_207.14, // 1,510,345.24 - 604,138.10
          avgCost: 99.781669, // 906,207.14 / 9,081.9
          price: 100.115625, value: 909_240.09, // 908,190 x 100.115625 / 100 = 909,240.0947
          unrealized: 3_032.95, accrued: 1_459.15 }], // 2,483.33 - 1,024.18
        holdings: { main: { long: 900_000, short: 0, net: 900_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-12-28', amount: 607_059.34, into: 'cash' }],
        pnl: { account: { realized: 1_927.36, commissions: -105.67, unrealized: 3_032.95, total: 8_077.54 } }, // 75.37 + 30.30; 1,927.36 + 3,222.90 - 105.67 + 3,032.95
        nav: { account: 2_008_077.54, book: 3_008_077.54 },
        balance: { account: { cash: 490_318.96, receivable: 607_059.34, accruedIncome: 1_459.15, positions: 909_240.09, assets: 2_008_077.54, liabilities: 0, netAssets: 2_008_077.54 } },
      },
    },
    {
      // Monday 28 December, after the holiday. End of day 24 Dec: the sale settles on 28 Dec, so on 24 Dec all 1,500,000 is
      // still settled face: 1,500,000 x 1.00910 x 0.1875% x 162/184 = 2,498.7564, less the interest sold to 28 Dec,
      // 1,024.1817: 1,474.5747. On the books 1,459.15: 15.42 more (the 600,000 sold earns until its sale settles).
      id: 'settle-after-christmas', covers: ['settlement', 'market holiday'], action: 'clock', to: EST('2026-12-28'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 607,059.34 USD into settled cash', cash: { USD: 607_059.34 }, date: '2026-12-28' },
          { type: 'accrual.coupon', summary: 'Interest accrued on TII-0.375-JAN27: 15.42 USD' },
        ],
        cash: { account: { USD: { settled: 1_097_378.30, unsettled: 0, availableToTrade: 1_097_378.30 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 900_000, accrued: 1_474.57 }],
        pending: [],
        pnl: { account: { couponInterest: 3_238.32, total: 8_092.96 } }, // 3,222.90 + 15.42
        nav: { account: 2_008_092.96, book: 3_008_092.96 },
        balance: { account: { cash: 1_097_378.30, receivable: null, accruedIncome: 1_474.57, assets: 2_008_092.96, netAssets: 2_008_092.96 } },
      },
    },
    {
      id: 'ratio-zero-refused', covers: 'index ratio (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'index_ratio', ratio: 0 },
      status: 'blocked', reason: 'An index ratio of zero is not a ratio of two index levels.',
      expect: { refused: 'Enter the index ratio as a positive number' },
    },
    {
      // Tuesday 12 January 2027. End of day 11 Jan: 900,000 x 1.00910 x 0.1875% x 180/184 = 1,665.8376; 191.27 more.
      id: 'january', covers: 'accrual', action: 'clock', to: EST('2027-01-12'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on TII-0.375-JAN27: 191.27 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 900_000, accrued: 1_665.84 }],
        pnl: { account: { couponInterest: 3_429.59, total: 8_284.23 } },
        nav: { account: 2_008_284.23, book: 3_008_284.23 },
        balance: { account: { accruedIncome: 1_665.84, assets: 2_008_284.23, netAssets: 2_008_284.23 } },
      },
    },
    {
      // Deflation: the index ratio recorded by hand falls from 1.00910 to 0.99790, below 1.
      // Accretion 900,000 x (0.99790 - 1.00910) = -10,080.00: cost 906,207.14 - 10,080 = 896,127.14; income -10,080.
      // Accrued trued up to today on the new ratio: 900,000 x 0.99790 x 0.1875% x 181/184 = 1,656.5004; on the books
      // 1,665.84: 9.34 less ("Interest cost accrued", the balance falls).
      id: 'index-ratio-below-one', covers: 'index ratio (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'index_ratio', ratio: 0.9979, asOf: '2027-01-12' },
      expect: {
        events: [
          { type: 'bond.index_ratio', summary: 'Index ratio of TII-0.375-JAN27 recorded by hand: 1.00910 to 0.99790 (as of 2027-01-12). Principal of 900,000 face down 10,080.00 USD: inflation accretion lost', owner: 'account', date: '2027-01-12' },
          { type: 'accrual.coupon', summary: 'Interest cost accrued on TII-0.375-JAN27: 9.34 USD' },
        ],
        positions: [{ instrument: 'main', lot: 'lot', qty: 900_000, cost: 896_127.14,
          avgCost: 99.779219, // 896,127.14 / 8,981.1 = 99.7792186
          price: 100.115625, value: 899_148.44, // 898,110 x 100.115625 / 100 = 899,148.4397
          unrealized: 3_021.30, accrued: 1_656.50 }],
        pnl: { account: { couponInterest: -6_659.75, unrealized: 3_021.30, total: -1_816.76 } }, // 3,429.59 - 10,080 - 9.34; 1,927.36 - 6,659.75 - 105.67 + 3,021.30
        nav: { account: 1_998_183.24, book: 2_998_183.24 }, // 1,097,378.30 + 1,656.50 + 899,148.44
        balance: { account: { accruedIncome: 1_656.50, positions: 899_148.44, assets: 1_998_183.24, netAssets: 1_998_183.24 } },
      },
    },
    {
      // Friday 15 January 2027: final coupon and redemption.
      // Coupon on the adjusted principal (coupons are not floored): 900,000 x 0.99790 x 0.1875% = 1,683.95625 -> 1,683.96.
      // On the books 1,656.50: the coupon exceeds it by 27.46, the interest from 12 Jan to maturity.
      // Redemption: face x ratio would be 898,110.00, below par: the deflation floor repays 900,000 x 100% = 900,000.00.
      // Realized 900,000 - 896,127.14 = 3,872.86.
      id: 'maturity', covers: ['coupon', 'maturity', 'close'], action: 'clock', to: EST('2027-01-15'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 900,000 TII-0.375-JAN27 (index ratio 0.99790: adjusted principal 898,110.00 USD): 1,683.96 USD', cash: { USD: 1_683.96 }, owner: 'account', date: '2027-01-15' },
          { type: 'accrual.coupon', summary: 'Interest accrued on TII-0.375-JAN27: 27.46 USD' },
          { type: 'bond.redemption', summary: 'Redeemed at maturity: 900,000 TII-0.375-JAN27 at 100.00% of par on index ratio 0.99790, below 1: principal floored at par, 900,000.00 USD', owner: 'account', date: '2027-01-15' },
          { type: 'settlement.receive', summary: 'received 900,000.00 USD into settled cash', cash: { USD: 900_000 } },
        ],
        cash: { account: { USD: { settled: 1_999_062.26, unsettled: 0, availableToTrade: 1_999_062.26 } }, treasury: usdCash(1_000_000) }, // 1,097,378.30 + 1,683.96 + 900,000
        positions: [],
        holdings: { main: null },
        pending: [],
        lifecycle: [],
        pnl: { account: { realized: 5_800.22, couponInterest: -6_632.29, commissions: -105.67, unrealized: 0, total: -937.74 } }, // 1,927.36 + 3,872.86; -6,659.75 + 27.46
        nav: { account: 1_999_062.26, book: 2_999_062.26 },
        balance: { account: { cash: 1_999_062.26, positions: null, accruedIncome: null, receivable: null, assets: 1_999_062.26, liabilities: 0, netAssets: 1_999_062.26 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// foreign_inflation_linked
// ---------------------------------------------------------------------------------------------
// A UK index-linked gilt (3-month-lag design): 0.75% real coupon on 22 May and 22 November, ACT/ACT, T+1 on the London
// calendar (London Stock Exchange listing, venue country GB), in sterling, in a Book that reports in US dollars. Its own
// conventions against a US TIPS: the index is UK RPI and there is NO deflation floor (the principal repaid is face x index
// ratio, whatever it is), and a fall in the ratio is recorded like a rise. Ratios entered by hand: 1.43872 at registration,
// 1.44510 on 2 November 2027, 1.44105 on 1 December 2027 (a small fall: negative accretion).
//   - The 22 November coupon is paid on face x ratio of the 1,500,000 settled before it.
//   - 700,000 is sold on Friday 24 December 2027 (New York closed for Christmas, London open): T+1 skips the weekend and
//     the two English bank holidays of Monday 27 and Tuesday 28 December, and settles Wednesday 29 December.
//   - The rest is closed on 29 December for settlement on 30 December.
// Not modelled: the gilt ex-dividend period (seven business days before a coupon); no trade here settles inside it.
//
// Coupon periods: 22 May to 22 Nov 2027 is 184 days, 22 Nov 2027 to 22 May 2028 is 182 (2028 is a leap year). A full
// real coupon is 0.375 per 100 of adjusted principal. Days from 22 May: to 2 Nov 164, to 3 Nov 165. From 22 Nov: to 30 Nov 8,
// to 1 Dec 9, to 23 Dec 31, to 28 Dec 36, to 29 Dec 37, to 30 Dec 38. GBP/USD 1.27 throughout (fixture). Reporting-currency
// rule (as in bond-corporate.mjs): balances at the current rate; income, commission and realized P&L posting by posting at
// the rate when booked; FX effects are what the balance-sheet accounts are worth at the current rate less what they were
// booked at (here only cents of rounding). Commission: 1 basis point of clean principal.
const foreignInflationLinked = {
  productId: 'foreign_inflation_linked',
  title: 'UK 0.75% index-linked gilt 2033 in sterling, reported in dollars: RPI index ratios recorded by hand (up and down, no deflation floor), coupon on adjusted principal, sale over the English Christmas bank holidays, close',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount'],
    manualInputs: ['Registration: Index ratio (required; no inflation index feed), Deflation floor left off (UK index-linked gilts have none)', 'Index ratio recorded by hand on the instrument form (Edit, Lifecycle events recorded by hand)'],
    settlement: 'T+1 on the London calendar (venue country GB); principal = face x index ratio x clean price; English bank holidays skipped; New York holiday does not stop a London trade; ex-dividend period not modelled',
    lifecycle: 'Daily accrual on the adjusted principal (New York end of day); index ratio changes book inflation accretion (positive or negative) and true up accrued; coupon on face x ratio; no floor at maturity',
    accounting: 'Sterling position, cost including accretion, accrued, coupon, sale proceeds; US dollar figures at the current rate for balances and unrealized P&L, at the booking rate for income, commission and realized P&L',
    collateral: 'None for a long position',
  },
  start: EDT('2027-11-01'), // Monday (New York is on daylight time until 7 November 2027)
  settlementCheck: { lag: 1, holidays: ['2027-12-27', '2027-12-28'] }, // English bank holidays for Christmas and Boxing Day
  book: {
    name: 'Matrix index-linked gilt', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'GBP', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'GBP', amount: 2_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 1 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  fx: { 'GBP/USD': 1.27 },
  instruments: {
    main: { productId: 'foreign_inflation_linked', name: 'United Kingdom 0.75% Index-linked Treasury Gilt 22-Nov-2033', symbol: 'UKTI-0.75-33', marketView: 'FOREIGN_CASH', venueType: 'exchange', venue: 'London Stock Exchange', venueCountry: 'GB', issuer: 'HM Treasury (UK Debt Management Office)', domicile: 'GB', underlyingGeo: 'GB', tradingCcy: 'GBP', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.0075, frequency: 2, maturity: '2033-11-22', issueDate: '2013-11-22', dayCount: 'ACT/ACT', redemption: 100, indexRatio: 1.43872, inflationFloor: false } },
  },
  quotes: { main: { bid: 98.3, ask: 98.4, last: 98.35, bidSize: 10_000_000, askSize: 10_000_000 } }, // real clean prices
  expectAtStart: {
    ...startState(3_175_000, 1_635_000), // 2,500,000 GBP x 1.27; 1,000,000 USD + 500,000 GBP x 1.27
    cash: { account: { GBP: idle(2_500_000) }, treasury: { USD: idle(1_000_000), GBP: idle(500_000) } },
  },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 98.4, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-11-02', calendar: 'UK',
            notional: 1_438_720, // 1,000,000 x 1.43872
            gross: 1_415_700.48, // 1,438,720 x 98.40 / 100
            accrued: 4_808.77, // 1,438,720 x 0.375% x 164/184 = 4,808.7652
            cash: -1_420_509.25, fees: 141.57 }], // 1 bp of 1,415,700.48
          cash: { GBP: { purchases: 1_420_509.25, fees: 141.57, required: 1_420_650.82, available: 2_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 98.4, fills: [{ qty: 1_000_000, price: 98.4, model: 'quoted-bid-ask', settleDate: '2027-11-02', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 UKTI-0.75-33 @ 98.40 GBP', owner: 'account', date: '2027-11-01' }],
        cash: { account: { GBP: { settled: 2_500_000, unsettled: -1_420_650.82, availableToTrade: 1_079_349.18 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 98.4, cost: 1_415_700.48, price: 98.35,
          value: 1_414_981.12, // 1,438,720 x 98.35 / 100
          unrealized: -719.36, accrued: 4_808.77, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-11-02', amount: -1_420_650.82, ccy: 'GBP', into: 'cash' }],
        // 22 Nov 2027 is a Monday; 22 Nov 2033 a Tuesday.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-11-22', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2033-11-22', status: 'pending' }],
        // Dollars at 1.27: commission 141.57 x 1.27 = 179.79; unrealized -719.36 x 1.27 = -913.59.
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -179.79, fees: 0, borrowFunding: 0, unrealized: -913.59, fx: 0, total: -1_093.38 } },
        nav: { account: 3_173_906.62, book: 4_808_906.62 }, // (2,500,000 - 1,420,650.82 + 1,414,981.12 + 4,808.77) x 1.27
        balance: { account: { cash: 3_175_000, accruedIncome: 6_107.14, positions: 1_797_026.02, payable: 1_804_226.54, assets: 4_978_133.16, liabilities: 1_804_226.54, netAssets: 3_173_906.62,
          local: { GBP: { cash: 2_500_000, accruedIncome: 4_808.77, positions: 1_414_981.12, payable: 1_420_650.82 } } } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2027-11-02'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,420,650.82 GBP from settled cash', cash: { GBP: -1_420_650.82 }, date: '2027-11-02' }],
        cash: { account: { GBP: { settled: 1_079_349.18, unsettled: 0, availableToTrade: 1_079_349.18 } } },
        pending: [],
        balance: { account: { cash: 1_370_773.46, payable: null, assets: 3_173_906.62, liabilities: 0, local: { GBP: { cash: 1_079_349.18, payable: null } } } }, // 1,079,349.18 x 1.27
      },
    },
    {
      // RPI index ratio for 2 November recorded by hand: 1.43872 to 1.44510. Accretion 1,000,000 x 0.00638 = 6,380.00 sterling
      // (8,102.60 dollars): cost 1,415,700.48 + 6,380 = 1,422,080.48. Accrued to today on the new ratio: 1,445,100 x 0.375% x
      // 164/184 = 4,830.0897; 21.32 more (27.08 dollars). FX effects -0.01: rounding of the translated postings (cash
      // 1,370,773.46 against 1,370,773.4586, position cost 1,806,042.21 against 1,806,042.2096, accrued 6,134.22 against 6,134.2143).
      id: 'index-ratio-up', covers: 'index ratio (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'index_ratio', ratio: 1.4451, asOf: '2027-11-02' },
      expect: {
        events: [
          { type: 'bond.index_ratio', summary: 'Index ratio of UKTI-0.75-33 recorded by hand: 1.43872 to 1.44510 (as of 2027-11-02). Principal of 1,000,000 face up 6,380.00 GBP: inflation accretion earned', owner: 'account', date: '2027-11-02' },
          { type: 'accrual.coupon', summary: 'Interest accrued on UKTI-0.75-33: 21.32 GBP' },
        ],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, cost: 1_422_080.48, avgCost: 98.407064, // 1,422,080.48 / 14,451
          price: 98.35, value: 1_421_255.85, unrealized: -824.63, accrued: 4_830.09 }], // 1,445,100 x 98.35 / 100 = 1,421,255.85
        pnl: { account: { couponInterest: 8_129.68, unrealized: -1_047.28, fx: -0.01, total: 6_902.60 } }, // 8,102.60 + 27.08; -824.63 x 1.27
        nav: { account: 3_181_902.60, book: 4_816_902.60 }, // (1,079,349.18 + 1,421,255.85 + 4,830.09) x 1.27
        balance: { account: { accruedIncome: 6_134.21, positions: 1_804_994.93, assets: 3_181_902.60, netAssets: 3_181_902.60, local: { GBP: { accruedIncome: 4_830.09, positions: 1_421_255.85 } } } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 1,000,000 -> 1,500,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 500_000, estimate: 98.4, settleDate: '2027-11-03', calendar: 'UK',
          notional: 722_550, // 500,000 x 1.44510
          gross: 710_989.20, // 722,550 x 98.40 / 100
          accrued: 2_429.77, // 722,550 x 0.375% x 165/184 = 2,429.7724
          cash: -713_418.97, fees: 71.1 }], // 1 bp of 710,989.20
          cash: { GBP: { purchases: 713_418.97, fees: 71.1, required: 713_490.07, available: 1_079_349.18, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 500_000, avgPrice: 98.4 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 500,000 UKTI-0.75-33 @ 98.40 GBP' }],
        cash: { account: { GBP: { settled: 1_079_349.18, unsettled: -713_490.07, availableToTrade: 365_859.11 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, cost: 2_133_069.68, // 1,422,080.48 + 710,989.20
          avgCost: 98.404709, // 2,133,069.68 / 21,676.5
          price: 98.35, value: 2_131_883.78, unrealized: -1_185.90, accrued: 7_259.86 }], // 2,167,650 x 98.35 / 100; 4,830.09 + 2,429.77
        holdings: { main: { long: 1_500_000, short: 0, net: 1_500_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-11-03', amount: -713_490.07, ccy: 'GBP', into: 'cash' }],
        pnl: { account: { commissions: -270.09, unrealized: -1_506.09, fx: 0, total: 6_353.50 } }, // 179.79 + 71.10 x 1.27 (90.30); -1,185.90 x 1.27
        nav: { account: 3_181_353.49, book: 4_816_353.49 },
        balance: { account: { cash: 1_370_773.46, accruedIncome: 9_220.02, positions: 2_707_492.40, payable: 906_132.39, assets: 4_087_485.88, liabilities: 906_132.39, netAssets: 3_181_353.49,
          local: { GBP: { cash: 1_079_349.18, accruedIncome: 7_259.86, positions: 2_131_883.78, payable: 713_490.07 } } } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: EDT('2027-11-03'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 713,490.07 GBP from settled cash', cash: { GBP: -713_490.07 } }],
        cash: { account: { GBP: { settled: 365_859.11, unsettled: 0, availableToTrade: 365_859.11 } } },
        pending: [],
        balance: { account: { cash: 464_641.07, payable: null, assets: 3_181_353.49, liabilities: 0, local: { GBP: { cash: 365_859.11, payable: null } } } },
      },
    },
    {
      // Monday 22 November: coupon on face x ratio of the 1,500,000 settled before it: 2,167,650 x 0.375% = 8,128.6875 ->
      // 8,128.69 sterling. On the books 7,259.86 (to 2 and 3 Nov): the coupon exceeds it by 868.83, the interest since then
      // (1,103.41 dollars).
      id: 'coupon', covers: 'coupon', action: 'clock', to: EST('2027-11-22'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 1,500,000 UKTI-0.75-33 (index ratio 1.44510: adjusted principal 2,167,650.00 GBP): 8,128.69 GBP', cash: { GBP: 8_128.69 }, owner: 'account', date: '2027-11-22' },
          { type: 'accrual.coupon', summary: 'Interest accrued on UKTI-0.75-33: 868.83 GBP' },
        ],
        cash: { account: { GBP: { settled: 373_987.80, availableToTrade: 373_987.80 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-05-22', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2033-11-22', status: 'pending' }],
        pnl: { account: { couponInterest: 9_233.09, total: 7_456.91 } }, // 8,129.68 + 868.83 x 1.27 (1,103.41)
        nav: { account: 3_182_456.91, book: 4_817_456.91 }, // (373,987.80 + 2,131,883.78) x 1.27
        balance: { account: { cash: 474_964.51, accruedIncome: null, assets: 3_182_456.91, netAssets: 3_182_456.91, local: { GBP: { cash: 373_987.80, accruedIncome: null } } } },
      },
    },
    {
      // End of day 30 Nov: 2,167,650 x 0.375% x 8/182 = 357.3049 (453.77 dollars).
      id: 'december', covers: 'accrual', action: 'clock', to: EST('2027-12-01'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on UKTI-0.75-33: 357.30 GBP' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, accrued: 357.3 }],
        pnl: { account: { couponInterest: 9_686.86, total: 7_910.68 } },
        nav: { account: 3_182_910.68, book: 4_817_910.68 },
        balance: { account: { accruedIncome: 453.77, assets: 3_182_910.68, netAssets: 3_182_910.68, local: { GBP: { accruedIncome: 357.3 } } } },
      },
    },
    {
      // The ratio falls: 1.44510 to 1.44105 (no floor applies to a gilt, now or at maturity). Accretion 1,500,000 x -0.00405 =
      // -6,075.00 sterling (-7,715.25 dollars): cost 2,133,069.68 - 6,075 = 2,126,994.68. Accrued to today, 9 days, on the new
      // ratio: 2,161,575 x 0.375% x 9/182 = 400.8417; 43.54 more (55.30 dollars): a day of interest less the fall on 8 days.
      id: 'index-ratio-down', covers: 'index ratio (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'index_ratio', ratio: 1.44105, asOf: '2027-12-01' },
      expect: {
        events: [
          { type: 'bond.index_ratio', summary: 'Index ratio of UKTI-0.75-33 recorded by hand: 1.44510 to 1.44105 (as of 2027-12-01). Principal of 1,500,000 face down 6,075.00 GBP: inflation accretion lost', owner: 'account', date: '2027-12-01' },
          { type: 'accrual.coupon', summary: 'Interest accrued on UKTI-0.75-33: 43.54 GBP' },
        ],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, cost: 2_126_994.68, avgCost: 98.400226, // 2,126,994.68 / 21,615.75
          price: 98.35, value: 2_125_909.01, unrealized: -1_085.67, accrued: 400.84 }], // 2,161,575 x 98.35 / 100 = 2,125,909.0125
        pnl: { account: { couponInterest: 2_026.91, unrealized: -1_378.80, total: 378.02 } }, // 9,686.86 - 7,715.25 + 55.30
        nav: { account: 3_175_378.02, book: 4_810_378.02 },
        balance: { account: { accruedIncome: 509.07, positions: 2_699_904.44, assets: 3_175_378.02, netAssets: 3_175_378.02, local: { GBP: { accruedIncome: 400.84, positions: 2_125_909.01 } } } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 99.1, ask: 99.2, last: 99.15, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, price: 99.15, value: 2_143_201.61, unrealized: 16_206.93 }], // 2,161,575 x 99.15 / 100 = 2,143,201.6125
        pnl: { account: { unrealized: 20_582.80, total: 22_339.62 } }, // 16,206.93 x 1.27
        nav: { account: 3_197_339.62, book: 4_832_339.62 },
        balance: { account: { positions: 2_721_866.04, assets: 3_197_339.62, netAssets: 3_197_339.62, local: { GBP: { positions: 2_143_201.61 } } } },
      },
    },
    {
      // Friday 24 December: New York is closed (Christmas observed), London is open. End of day 23 Dec: 2,161,575 x 0.375% x
      // 31/182 = 1,380.6797; 979.84 more (1,244.40 dollars). FX effects -0.01 (rounding, as above).
      id: 'christmas-eve', covers: 'accrual', action: 'clock', to: EST('2027-12-24'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on UKTI-0.75-33: 979.84 GBP' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, accrued: 1_380.68 }],
        pnl: { account: { couponInterest: 3_271.31, fx: -0.01, total: 23_584.01 } },
        nav: { account: 3_198_584.01, book: 4_833_584.01 },
        balance: { account: { accruedIncome: 1_753.46, assets: 3_198_584.01, netAssets: 3_198_584.01, local: { GBP: { accruedIncome: 1_380.68 } } } },
      },
    },
    {
      // Sold on 24 December: T+1 skips Saturday, Sunday and the bank holidays of 27 and 28 December: settles Wednesday 29 December.
      // Cost out at the average: 2,126,994.68 x 7/15 = 992,597.52; realized 999,656.39 - 992,597.52 = 7,058.87 sterling (8,964.76 dollars).
      id: 'reduce-over-uk-holidays', covers: ['reduce', 'market holiday'], action: 'ticket', instrument: 'main', side: 'sell', qty: 700_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 700_000, estimate: 99.1, settleDate: '2027-12-29', calendar: 'UK',
          notional: 1_008_735, // 700,000 x 1.44105
          gross: 999_656.39, // 1,008,735 x 99.10 / 100 = 999,656.385
          accrued: 769.02, // 1,008,735 x 0.375% x 37/182 = 769.0221
          cash: 1_000_425.41, fees: 99.97 }] }, // 1 bp of 999,656.39
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 700_000, avgPrice: 99.1 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 700,000 UKTI-0.75-33 @ 99.10 GBP (realized 7,058.87 GBP)', date: '2027-12-24' }],
        cash: { account: { GBP: { settled: 373_987.80, unsettled: 1_000_325.44, availableToTrade: 1_374_313.24 } } }, // 1,000,425.41 - 99.97
        positions: [{ instrument: 'main', lot: 'lot', qty: 800_000, cost: 1_134_397.16, avgCost: 98.400226, // 2,126,994.68 - 992,597.52; / 11,528.4
          price: 99.15, value: 1_143_040.86, unrealized: 8_643.70, accrued: 611.66 }], // 1,152,840 x 99.15 / 100; 1,380.68 - 769.02
        holdings: { main: { long: 800_000, short: 0, net: 800_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-12-29', amount: 1_000_325.44, ccy: 'GBP', into: 'cash' }],
        pnl: { account: { realized: 8_964.76, commissions: -397.05, unrealized: 10_977.50, fx: 0, total: 22_816.52 } }, // 270.09 + 99.97 x 1.27 (126.96); 8,643.70 x 1.27
        nav: { account: 3_197_816.52, book: 4_832_816.52 },
        balance: { account: { cash: 474_964.51, receivable: 1_270_413.31, accruedIncome: 776.81, positions: 1_451_661.89, assets: 3_197_816.52, liabilities: 0, netAssets: 3_197_816.52,
          local: { GBP: { receivable: 1_000_325.44, accruedIncome: 611.66, positions: 1_143_040.86 } } } },
      },
    },
    {
      // Wednesday 29 December. End of day 28 Dec (New York open; London closed): the sale settles on the 29th, so all 1,500,000
      // is still settled face: 2,161,575 x 0.375% x 36/182 = 1,603.4127, less the interest sold to 29 Dec, 769.0221: 834.3406.
      // On the books 611.66: 222.68 more (282.80 dollars).
      id: 'settle-reduce', covers: ['settlement', 'market holiday'], action: 'clock', to: EST('2027-12-29'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 1,000,325.44 GBP into settled cash', cash: { GBP: 1_000_325.44 }, date: '2027-12-29' },
          { type: 'accrual.coupon', summary: 'Interest accrued on UKTI-0.75-33: 222.68 GBP' },
        ],
        cash: { account: { GBP: { settled: 1_374_313.24, unsettled: 0, availableToTrade: 1_374_313.24 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 800_000, accrued: 834.34 }],
        pending: [],
        pnl: { account: { couponInterest: 3_554.11, fx: 0, total: 23_099.32 } },
        nav: { account: 3_198_099.32, book: 4_833_099.32 },
        balance: { account: { cash: 1_745_377.81, receivable: null, accruedIncome: 1_059.61, assets: 3_198_099.32, netAssets: 3_198_099.32, local: { GBP: { cash: 1_374_313.24, receivable: null, accruedIncome: 834.34 } } } },
      },
    },
    {
      // Closed for settlement on Thursday 30 December. Realized 1,142,464.44 - 1,134,397.16 = 8,067.28 sterling (10,245.45 dollars).
      // Interest sold 902.64 against 834.34 on the books: 68.30 more income (86.74 dollars).
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 800_000, estimate: 99.1, settleDate: '2027-12-30', calendar: 'UK',
          notional: 1_152_840, // 800,000 x 1.44105
          gross: 1_142_464.44, // 1,152,840 x 99.10 / 100
          accrued: 902.64, // 1,152,840 x 0.375% x 38/182 = 902.6407
          cash: 1_143_367.08, fees: 114.25 }] }, // 1 bp of 1,142,464.44
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 800_000, avgPrice: 99.1 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 800,000 UKTI-0.75-33 @ 99.10 GBP (realized 8,067.28 GBP)' },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of UKTI-0.75-33: 68.30 GBP' },
        ],
        cash: { account: { GBP: { settled: 1_374_313.24, unsettled: 1_143_252.83, availableToTrade: 2_517_566.07 } } }, // 1,143,367.08 - 114.25
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2027-12-30', amount: 1_143_252.83, ccy: 'GBP', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: 19_210.21, couponInterest: 3_640.85, commissions: -542.15, unrealized: 0, fx: 0, total: 22_308.91 } }, // 8,964.76 + 10,245.45; + 86.74; + 114.25 x 1.27 (145.10)
        nav: { account: 3_197_308.91, book: 4_832_308.91 }, // 2,517,566.07 x 1.27 = 3,197,308.9089
        balance: { account: { cash: 1_745_377.81, receivable: 1_451_931.09, positions: null, accruedIncome: null, assets: 3_197_308.91, liabilities: 0, netAssets: 3_197_308.91,
          local: { GBP: { receivable: 1_143_252.83, positions: null, accruedIncome: null } } } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EST('2027-12-30'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,143,252.83 GBP into settled cash', cash: { GBP: 1_143_252.83 } }],
        cash: { account: { GBP: { settled: 2_517_566.07, unsettled: 0, availableToTrade: 2_517_566.07 } }, treasury: { USD: { settled: 1_000_000 }, GBP: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 3_197_308.91, receivable: null, assets: 3_197_308.91, liabilities: 0, local: { GBP: { cash: 2_517_566.07, receivable: null } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// callable_bond
// ---------------------------------------------------------------------------------------------
// A US industrial's callable senior notes: 5.75%, coupons 15 June and 15 December, 30/360, T+1 on the US bond calendar,
// pieces of 1,000, maturing 15 June 2033, callable by the issuer from 15 June 2028 at 101, from 15 June 2029 at 100.50 and
// from 15 June 2030 at par (American-style after each date, as registered in its call schedule). The issuer's calls are
// recorded by hand on the instrument (Edit, Lifecycle events recorded by hand, Issuer call): the Terminal checks the date
// and the price against the schedule and applies the call to every holder.
//   - A call before the first call date is refused; so is a call at a price other than the one in force.
//   - On the first call date, after the coupon, the issuer calls 25% of the issue pro rata: no accrued interest (first
//     day of the period).
//   - On 15 August 2028 it calls the rest at 101, with 60 days of accrued interest paid; the position closes and the
//     remaining coupons and the redemption are cancelled. The notes can no longer be traded.
// Not modelled: the call notice period (30 to 60 days); the call is recorded on its redemption date.
//
// Days of 30/360 from 15 Dec 2027: to 2 Jun 167, 5 Jun 170, 7 Jun 172, 9 Jun 174. From 15 Jun 2028: to 14 Aug 59, 15 Aug
// 60. A full coupon is 2.875 per 100. Commission: 0.5 basis point of clean principal.
const callableBond = {
  productId: 'callable_bond',
  title: 'Halden Industrial 5.75% callable notes 2033: a call before the first call date and one at the wrong price refused, coupon, 25% partial call at 101 on the first call date, the rest called on 15 August with accrued interest',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    manualInputs: ['Registration: Call schedule (dates and call prices)', 'Issuer call recorded by hand on the instrument form: Call price (% of par), Share of the issue called (1 = whole issue), Review, Record issuer call'],
    settlement: 'T+1 on the US bond calendar; a call is paid on the day it is recorded, principal at the call price plus accrued interest to that day',
    lifecycle: 'Daily accrual on 30/360; semi-annual coupon; partial call pro rata to every holder; full call closes every holding and cancels the next coupon and the maturity; call date and price checked against the schedule',
    accounting: 'Clean cost at average; realized P&L on the sale and on each call (call price against average cost); accrued interest paid with the call is income; commission expensed',
    collateral: 'None for a long position',
  },
  start: EDT('2028-06-01'), // Thursday
  settlementCheck: { lag: 1, holidays: [] },
  book: {
    name: 'Matrix callable bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 4_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 3_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'callable_bond', name: 'Halden Industrial Corp 5.75% Callable Senior Notes 15-Jun-2033', symbol: 'HALDEN-5.75-33C', marketView: 'US_CASH', venueType: 'otc', issuer: 'Halden Industrial Corp', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.0575, frequency: 2, maturity: '2033-06-15', issueDate: '2023-06-15', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured',
        callSchedule: [{ date: '2028-06-15', price: 101 }, { date: '2029-06-15', price: 100.5 }, { date: '2030-06-15', price: 100 }] } },
  },
  quotes: { main: { bid: 101.05, ask: 101.25, last: 101.1, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(3_000_000, 1_000_000), cash: { account: usdCash(3_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2_000_000, estimate: 101.25, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2028-06-02', calendar: 'USBOND',
            gross: 2_025_000, // 2,000,000 x 101.25 / 100
            accrued: 53_347.22, // 167 days: 2,000,000 x 5.75% x 167/360 = 53,347.222
            cash: -2_078_347.22, fees: 101.25 }], // 0.5 bp of 2,025,000
          cash: { USD: { purchases: 2_078_347.22, fees: 101.25, required: 2_078_448.47, available: 3_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2_000_000, avgPrice: 101.25, fills: [{ qty: 2_000_000, price: 101.25, model: 'quoted-bid-ask', settleDate: '2028-06-02', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000,000 HALDEN-5.75-33C @ 101.25 USD', owner: 'account', date: '2028-06-01' }],
        cash: { account: { USD: { settled: 3_000_000, unsettled: -2_078_448.47, availableToTrade: 921_551.53 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2_000_000, avgCost: 101.25, cost: 2_025_000, price: 101.1,
          value: 2_022_000, unrealized: -3_000, accrued: 53_347.22, priceSource: 'Test fixture' }],
        holdings: { main: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-06-02', amount: -2_078_448.47, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-06-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2033-06-15', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -101.25, fees: 0, borrowFunding: 0, unrealized: -3_000, total: -3_101.25 } },
        nav: { account: 2_996_898.75, book: 3_996_898.75 },
        balance: { account: { cash: 3_000_000, accruedIncome: 53_347.22, positions: 2_022_000, payable: 2_078_448.47, assets: 5_075_347.22, liabilities: 2_078_448.47, netAssets: 2_996_898.75 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2028-06-02'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,078,448.47 USD from settled cash', cash: { USD: -2_078_448.47 }, date: '2028-06-02' }],
        cash: { account: { USD: { settled: 921_551.53, unsettled: 0, availableToTrade: 921_551.53 } } },
        pending: [],
        balance: { account: { cash: 921_551.53, payable: null, assets: 2_996_898.75, liabilities: 0 } },
      },
    },
    {
      id: 'call-before-first-call-date', covers: 'call (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'call', price: 101, share: 1 },
      status: 'blocked', reason: 'The notes are not callable before 15 June 2028, their first call date.',
      expect: { refused: 'is not callable before 2028-06-15, its first call date (at 101.00% of par)' },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.25, // 2,000,000 -> 2,500,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 500_000, estimate: 101.25, settleDate: '2028-06-05', calendar: 'USBOND',
          gross: 506_250, // 500,000 x 101.25 / 100
          accrued: 13_576.39, // settles Monday 5 Jun, 170 days: 500,000 x 5.75% x 170/360 = 13,576.389
          cash: -519_826.39, fees: 25.31 }], // 0.5 bp of 506,250 = 25.3125
          cash: { USD: { purchases: 519_826.39, fees: 25.31, required: 519_851.70, available: 921_551.53, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 500_000, avgPrice: 101.25 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 500,000 HALDEN-5.75-33C @ 101.25 USD' }],
        cash: { account: { USD: { settled: 921_551.53, unsettled: -519_851.70, availableToTrade: 401_699.83 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_500_000, cost: 2_531_250, avgCost: 101.25, price: 101.1, value: 2_527_500, unrealized: -3_750, accrued: 66_923.61 }], // 53,347.22 + 13,576.39
        holdings: { main: { long: 2_500_000, short: 0, net: 2_500_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-06-05', amount: -519_851.70, into: 'cash' }],
        pnl: { account: { commissions: -126.56, unrealized: -3_750, total: -3_876.56 } },
        nav: { account: 2_996_123.44, book: 3_996_123.44 },
        balance: { account: { cash: 921_551.53, accruedIncome: 66_923.61, positions: 2_527_500, payable: 519_851.70, assets: 3_515_975.14, liabilities: 519_851.70, netAssets: 2_996_123.44 } },
      },
    },
    {
      // Monday 5 June. End of day 2 Jun: 2,000,000 settled to 2 Jun plus 500,000 to 5 Jun: what is on the books.
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: EDT('2028-06-05'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 519,851.70 USD from settled cash', cash: { USD: -519_851.70 } }],
        cash: { account: { USD: { settled: 401_699.83, unsettled: 0, availableToTrade: 401_699.83 } } },
        pending: [],
        balance: { account: { cash: 401_699.83, payable: null, assets: 2_996_123.44, liabilities: 0 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 101.4, ask: 101.6, last: 101.5, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_500_000, price: 101.5, value: 2_537_500, unrealized: 6_250 }],
        pnl: { account: { unrealized: 6_250, total: 6_123.44 } },
        nav: { account: 3_006_123.44, book: 4_006_123.44 },
        balance: { account: { positions: 2_537_500, assets: 3_006_123.44, netAssets: 3_006_123.44 } },
      },
    },
    {
      // Thursday 8 June. End of day 7 Jun: 2,500,000 x 5.75% x 172/360 = 68,680.556; on the books 66,923.61: 1,756.95 more.
      id: 'june-8', covers: 'accrual', action: 'clock', to: EDT('2028-06-08'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on HALDEN-5.75-33C: 1,756.95 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_500_000, accrued: 68_680.56 }],
        pnl: { account: { couponInterest: 1_756.95, total: 7_880.39 } },
        nav: { account: 3_007_880.39, book: 4_007_880.39 },
        balance: { account: { accruedIncome: 68_680.56, assets: 3_007_880.39, netAssets: 3_007_880.39 } },
      },
    },
    {
      // Cost out at the average: 700,000 x 101.25% = 708,750; realized 709,800 - 708,750 = 1,050.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 700_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 700_000, estimate: 101.4, settleDate: '2028-06-09',
          gross: 709_800, // 700,000 x 101.40 / 100
          accrued: 19_454.17, // settles 9 Jun, 174 days: 700,000 x 5.75% x 174/360 = 19,454.167
          cash: 729_254.17, fees: 35.49 }] }, // 0.5 bp of 709,800
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 700_000, avgPrice: 101.4 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 700,000 HALDEN-5.75-33C @ 101.40 USD (realized 1,050.00 USD)' }],
        cash: { account: { USD: { settled: 401_699.83, unsettled: 729_218.68, availableToTrade: 1_130_918.51 } } }, // 729,254.17 - 35.49
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_800_000, cost: 1_822_500, avgCost: 101.25, price: 101.5, value: 1_827_000, unrealized: 4_500, accrued: 49_226.39 }], // 68,680.56 - 19,454.17
        holdings: { main: { long: 1_800_000, short: 0, net: 1_800_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-06-09', amount: 729_218.68, into: 'cash' }],
        pnl: { account: { realized: 1_050, commissions: -162.05, unrealized: 4_500, total: 7_144.90 } },
        nav: { account: 3_007_144.90, book: 4_007_144.90 },
        balance: { account: { cash: 401_699.83, receivable: 729_218.68, accruedIncome: 49_226.39, positions: 1_827_000, assets: 3_007_144.90, liabilities: 0, netAssets: 3_007_144.90 } },
      },
    },
    {
      // Thursday 15 June, the first call date. The sale settled on 9 Jun. Coupon on the 1,800,000 settled before today:
      // 1,800,000 x 2.875% = 51,750. On the books 49,226.39: the coupon exceeds it by 2,523.61.
      id: 'coupon', covers: ['coupon', 'settlement'], action: 'clock', to: EDT('2028-06-15'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 729,218.68 USD into settled cash', cash: { USD: 729_218.68 } },
          { type: 'bond.coupon', summary: 'Coupon received on 1,800,000 HALDEN-5.75-33C: 51,750.00 USD', cash: { USD: 51_750 }, owner: 'account', date: '2028-06-15' },
          { type: 'accrual.coupon', summary: 'Interest accrued on HALDEN-5.75-33C: 2,523.61 USD' },
        ],
        cash: { account: { USD: { settled: 1_182_668.51, unsettled: 0, availableToTrade: 1_182_668.51 } } }, // 401,699.83 + 729,218.68 + 51,750
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_800_000, accrued: 0 }],
        pending: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-12-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2033-06-15', status: 'pending' }],
        pnl: { account: { couponInterest: 4_280.56, total: 9_668.51 } },
        nav: { account: 3_009_668.51, book: 4_009_668.51 },
        balance: { account: { cash: 1_182_668.51, receivable: null, accruedIncome: null, assets: 3_009_668.51, netAssets: 3_009_668.51 } },
      },
    },
    {
      id: 'call-at-wrong-price', covers: 'call (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'call', price: 100.5, share: 1 },
      status: 'blocked', reason: 'From 15 June 2028 the call price is 101; 100.50 applies only from 15 June 2029.',
      expect: { refused: 'The call price in force on 2028-06-15 is 101.00% of par (from 2028-06-15 under the call schedule); a call at 100.50 is not in the terms.' },
    },
    {
      // The issuer calls 25% of the issue, pro rata, at 101: 450,000 of the 1,800,000 held. No accrued interest (the first day
      // of the period). Paid today: 454,500. Cost out at the average 450,000 x 101.25% = 455,625: realized -1,125.
      id: 'partial-call', covers: ['call (by hand)', 'reduce'], action: 'instrument_lifecycle', instrument: 'main', body: { action: 'call', price: 101, share: 0.25 },
      expect: {
        events: [
          { type: 'bond.call', summary: 'Partial issuer call recorded by hand (25% of the issue, pro rata): 450,000 HALDEN-5.75-33C at 101.00% of par', owner: 'account', date: '2028-06-15' },
          { type: 'settlement.receive', summary: 'received 454,500.00 USD into settled cash', cash: { USD: 454_500 } },
        ],
        cash: { account: { USD: { settled: 1_637_168.51, availableToTrade: 1_637_168.51 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_350_000, cost: 1_366_875, avgCost: 101.25, price: 101.5, value: 1_370_250, unrealized: 3_375, accrued: 0 }],
        holdings: { main: { long: 1_350_000, short: 0, net: 1_350_000 } },
        pnl: { account: { realized: -75, unrealized: 3_375, total: 7_418.51 } }, // 1,050 - 1,125
        nav: { account: 3_007_418.51, book: 4_007_418.51 },
        balance: { account: { cash: 1_637_168.51, positions: 1_370_250, assets: 3_007_418.51, netAssets: 3_007_418.51 } },
      },
    },
    {
      // Tuesday 15 August, past Juneteenth and Independence Day. End of day 14 Aug: 1,350,000 x 5.75% x 59/360 = 12,721.875.
      id: 'august', covers: 'accrual', action: 'clock', to: EDT('2028-08-15'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on HALDEN-5.75-33C: 12,721.88 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_350_000, accrued: 12_721.88 }],
        pnl: { account: { couponInterest: 17_002.44, total: 20_140.39 } },
        nav: { account: 3_020_140.39, book: 4_020_140.39 },
        balance: { account: { accruedIncome: 12_721.88, assets: 3_020_140.39, netAssets: 3_020_140.39 } },
      },
    },
    {
      // The rest of the issue is called at 101 (the price in force until 15 June 2029). Principal 1,350,000 x 101% = 1,363,500;
      // accrued interest to today, 60 days: 1,350,000 x 5.75% x 60/360 = 12,937.50; paid together 1,376,437.50. Realized
      // 1,363,500 - 1,366,875 = -3,375. The interest paid exceeds the 12,721.88 on the books by 215.62 (today's day).
      // The coupon of 15 December and the maturity are cancelled.
      id: 'full-call', covers: ['call (by hand)', 'close'], action: 'instrument_lifecycle', instrument: 'main', body: { action: 'call', price: 101, share: 1 },
      expect: {
        events: [
          { type: 'bond.call', summary: 'Issuer call recorded by hand (whole issue): 1,350,000 HALDEN-5.75-33C at 101.00% of par', owner: 'account', date: '2028-08-15' },
          { type: 'settlement.receive', summary: 'received 1,376,437.50 USD into settled cash', cash: { USD: 1_376_437.50 } },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of HALDEN-5.75-33C: 215.62 USD' },
        ],
        cash: { account: { USD: { settled: 3_013_606.01, unsettled: 0, availableToTrade: 3_013_606.01 } }, treasury: usdCash(1_000_000) },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        pnl: { account: { realized: -3_450, couponInterest: 17_218.06, commissions: -162.05, unrealized: 0, total: 13_606.01 } }, // -75 - 3,375; + 215.62
        nav: { account: 3_013_606.01, book: 4_013_606.01 },
        balance: { account: { cash: 3_013_606.01, positions: null, accruedIncome: null, assets: 3_013_606.01, liabilities: 0, netAssets: 3_013_606.01 } },
      },
    },
    {
      id: 'trade-after-call', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 100_000,
      status: 'blocked', reason: 'The whole issue has been called and redeemed: nothing is left to trade.',
      expect: { refused: 'was called by the issuer and redeemed in full on 2028-08-15' },
    },
  ],
};

export default [tips, foreignInflationLinked, callableBond];
