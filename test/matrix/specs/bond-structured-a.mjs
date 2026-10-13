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

// ---------------------------------------------------------------------------------------------
// puttable_bond
// ---------------------------------------------------------------------------------------------
// A US energy company's puttable senior notes: 4.25%, coupons 1 March and 1 September, 30/360, T+1 on the US bond
// calendar, pieces of 1,000, maturing 1 March 2035, with a holder put at par on 1 March 2028 and on 1 March 2031 (as
// registered in its put schedule). The issuer's credit weakens after purchase (the price falls to 92), so the holder puts
// part of the holding back at par on the put date: recorded by hand from the position's Lifecycle menu (Holder put). The
// Terminal accepts a put only on a put date, at its price.
//   - The increase on Friday 18 February 2028 settles on Tuesday 22 February, over Presidents' Day.
//   - A put before the put date and one the day after it are refused and name the put dates.
//   - The rest is closed after the put date at the market price.
// Not modelled: the put notice window (notice is given weeks before the put date).
//
// Days of 30/360 from 1 Sep 2027: to 16 Feb 2028 165, 17 Feb 166, 18 Feb 167, 22 Feb 171, 23 Feb 172, 25 Feb 174. From
// 1 Mar 2028: to 3 Mar 2. A full coupon is 2.125 per 100. Commission: 0.5 basis point of clean principal.
const puttableBond = {
  productId: 'puttable_bond',
  title: 'Corran Energy 4.25% puttable notes 2035: bought at a discount, increased over Presidents\' Day, partial sale, coupon, holder put at par on the put date recorded by hand, puts on other days refused, rest sold',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    manualInputs: ['Registration: Put dates and prices', 'Holder put recorded by hand from the position\'s Lifecycle menu (Holder put: Face amount put, Label)'],
    settlement: 'T+1 on the US bond calendar (Presidents\' Day skipped); a put is paid on the put date, principal at the put price plus accrued interest to that day',
    lifecycle: 'Daily accrual on 30/360; semi-annual coupon; holder put accepted only on a put date of the schedule, at its price; puts on any other day refused with the put dates named',
    accounting: 'Clean cost at average; realized P&L on the sale, on the put (par against average cost) and on the close; commission expensed',
    collateral: 'None for a long position',
  },
  start: EST('2028-02-15'), // Tuesday
  settlementCheck: { lag: 1, holidays: ['2028-02-21'] }, // Presidents' Day
  book: {
    name: 'Matrix puttable bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_500_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'puttable_bond', name: 'Corran Energy Inc 4.25% Puttable Senior Notes 1-Mar-2035', symbol: 'CORRAN-4.25-35P', marketView: 'US_CASH', venueType: 'otc', issuer: 'Corran Energy Inc', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.0425, frequency: 2, maturity: '2035-03-01', issueDate: '2021-03-01', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured',
        putSchedule: [{ date: '2028-03-01', price: 100 }, { date: '2031-03-01', price: 100 }] } },
  },
  quotes: { main: { bid: 96.3, ask: 96.5, last: 96.4, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(2_500_000, 1_000_000), cash: { account: usdCash(2_500_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_600_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_600_000, estimate: 96.5, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2028-02-16', calendar: 'USBOND',
            gross: 1_544_000, // 1,600,000 x 96.50 / 100
            accrued: 31_166.67, // 165 days: 1,600,000 x 4.25% x 165/360 = 31,166.667
            cash: -1_575_166.67, fees: 77.2 }], // 0.5 bp of 1,544,000
          cash: { USD: { purchases: 1_575_166.67, fees: 77.2, required: 1_575_243.87, available: 2_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_600_000, avgPrice: 96.5, fills: [{ qty: 1_600_000, price: 96.5, model: 'quoted-bid-ask', settleDate: '2028-02-16', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,600,000 CORRAN-4.25-35P @ 96.50 USD', owner: 'account', date: '2028-02-15' }],
        cash: { account: { USD: { settled: 2_500_000, unsettled: -1_575_243.87, availableToTrade: 924_756.13 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_600_000, avgCost: 96.5, cost: 1_544_000, price: 96.4,
          value: 1_542_400, unrealized: -1_600, accrued: 31_166.67, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_600_000, short: 0, net: 1_600_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-02-16', amount: -1_575_243.87, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-03-01', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2035-03-01', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -77.2, fees: 0, borrowFunding: 0, unrealized: -1_600, total: -1_677.20 } },
        nav: { account: 2_498_322.80, book: 3_498_322.80 },
        balance: { account: { cash: 2_500_000, accruedIncome: 31_166.67, positions: 1_542_400, payable: 1_575_243.87, assets: 4_073_566.67, liabilities: 1_575_243.87, netAssets: 2_498_322.80 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2028-02-16'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,575,243.87 USD from settled cash', cash: { USD: -1_575_243.87 }, date: '2028-02-16' }],
        cash: { account: { USD: { settled: 924_756.13, unsettled: 0, availableToTrade: 924_756.13 } } },
        pending: [],
        balance: { account: { cash: 924_756.13, payable: null, assets: 2_498_322.80, liabilities: 0 } },
      },
    },
    {
      id: 'put-before-put-date', covers: 'put (by hand)', action: 'lifecycle', lot: 'lot', body: { action: 'put', face: 1_000_000 },
      status: 'blocked', reason: 'The holder may put only on a put date of the schedule; the next is 1 March 2028.',
      expect: { refused: '2028-02-16 is not a put date of CORRAN-4.25-35P. The holder may put only on 2028-03-01 at 100.00; 2031-03-01 at 100.00; the next is 2028-03-01.' },
    },
    {
      // Friday 18 Feb. End of day 17 Feb: 1,600,000 x 4.25% x 166/360 = 31,355.556; 188.89 more.
      id: 'friday', covers: 'accrual', action: 'clock', to: EST('2028-02-18'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on CORRAN-4.25-35P: 188.89 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_600_000, accrued: 31_355.56 }],
        pnl: { account: { couponInterest: 188.89, total: -1_488.31 } },
        nav: { account: 2_498_511.69, book: 3_498_511.69 },
        balance: { account: { accruedIncome: 31_355.56, assets: 2_498_511.69, netAssets: 2_498_511.69 } },
      },
    },
    {
      // T+1 from Friday is Monday 21 February, Presidents' Day: settles Tuesday 22 February.
      id: 'increase', covers: ['increase', 'market holiday'], action: 'resize', lot: 'lot', factor: 1.25, // 1,600,000 -> 2,000,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 400_000, estimate: 96.5, settleDate: '2028-02-22', calendar: 'USBOND',
          gross: 386_000, // 400,000 x 96.50 / 100
          accrued: 8_075, // 171 days: 400,000 x 4.25% x 171/360
          cash: -394_075, fees: 19.3 }], // 0.5 bp of 386,000
          cash: { USD: { purchases: 394_075, fees: 19.3, required: 394_094.30, available: 924_756.13, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 400_000, avgPrice: 96.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 400,000 CORRAN-4.25-35P @ 96.50 USD' }],
        cash: { account: { USD: { settled: 924_756.13, unsettled: -394_094.30, availableToTrade: 530_661.83 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, cost: 1_930_000, avgCost: 96.5, price: 96.4, value: 1_928_000, unrealized: -2_000, accrued: 39_430.56 }], // 31,355.56 + 8,075
        holdings: { main: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-02-22', amount: -394_094.30, into: 'cash' }],
        pnl: { account: { commissions: -96.5, unrealized: -2_000, total: -1_907.61 } },
        nav: { account: 2_498_092.39, book: 3_498_092.39 },
        balance: { account: { cash: 924_756.13, accruedIncome: 39_430.56, positions: 1_928_000, payable: 394_094.30, assets: 2_892_186.69, liabilities: 394_094.30, netAssets: 2_498_092.39 } },
      },
    },
    {
      // Tuesday 22 February. End of day Friday 18 Feb (Monday was a holiday in New York too): 1,600,000 settled to 18 Feb,
      // 31,544.444, plus 400,000 to 22 Feb, 8,075: 39,619.444. On the books 39,430.56: 188.88 more.
      id: 'settle-after-presidents-day', covers: ['settlement', 'market holiday'], action: 'clock', to: EST('2028-02-22'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 394,094.30 USD from settled cash', cash: { USD: -394_094.30 }, date: '2028-02-22' },
          { type: 'accrual.coupon', summary: 'Interest accrued on CORRAN-4.25-35P: 188.88 USD' },
        ],
        cash: { account: { USD: { settled: 530_661.83, unsettled: 0, availableToTrade: 530_661.83 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 39_619.44 }],
        pending: [],
        pnl: { account: { couponInterest: 377.77, total: -1_718.73 } },
        nav: { account: 2_498_281.27, book: 3_498_281.27 },
        balance: { account: { cash: 530_661.83, payable: null, accruedIncome: 39_619.44, assets: 2_498_281.27, liabilities: 0, netAssets: 2_498_281.27 } },
      },
    },
    {
      // Thursday 24 Feb. End of day 23 Feb: 2,000,000 x 4.25% x 172/360 = 40,611.111; 991.67 more (five 30/360 days since the
      // 18th on 1,600,000, 944.44, and the day after the 22nd on the 400,000 bought, 47.22).
      id: 'feb-24', covers: 'accrual', action: 'clock', to: EST('2028-02-24'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on CORRAN-4.25-35P: 991.67 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 40_611.11 }],
        pnl: { account: { couponInterest: 1_369.44, total: -727.06 } },
        nav: { account: 2_499_272.94, book: 3_499_272.94 },
        balance: { account: { accruedIncome: 40_611.11, assets: 2_499_272.94, netAssets: 2_499_272.94 } },
      },
    },
    {
      // Cost out at the average 400,000 x 96.50% = 386,000; realized 385,200 - 386,000 = -800.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 400_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 400_000, estimate: 96.3, settleDate: '2028-02-25',
          gross: 385_200, // 400,000 x 96.30 / 100
          accrued: 8_216.67, // 174 days: 400,000 x 4.25% x 174/360 = 8,216.667
          cash: 393_416.67, fees: 19.26 }] }, // 0.5 bp of 385,200
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 400_000, avgPrice: 96.3 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 400,000 CORRAN-4\.25-35P @ 96\.30 USD \(realized [-−]800\.00 USD\)$/ }],
        cash: { account: { USD: { settled: 530_661.83, unsettled: 393_397.41, availableToTrade: 924_059.24 } } }, // 393,416.67 - 19.26
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_600_000, cost: 1_544_000, avgCost: 96.5, price: 96.4, value: 1_542_400, unrealized: -1_600, accrued: 32_394.44 }], // 40,611.11 - 8,216.67
        holdings: { main: { long: 1_600_000, short: 0, net: 1_600_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-02-25', amount: 393_397.41, into: 'cash' }],
        pnl: { account: { realized: -800, commissions: -115.76, unrealized: -1_600, total: -1_146.32 } },
        nav: { account: 2_498_853.68, book: 3_498_853.68 },
        balance: { account: { cash: 530_661.83, receivable: 393_397.41, accruedIncome: 32_394.44, positions: 1_542_400, assets: 2_498_853.68, liabilities: 0, netAssets: 2_498_853.68 } },
      },
    },
    {
      // The issuer's credit weakens: the notes fall to 92. The put at par is now worth exercising.
      id: 'credit-weakens', action: 'quote', instrument: 'main', quote: { bid: 92, ask: 92.5, last: 92.25, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_600_000, price: 92.25, value: 1_476_000, unrealized: -68_000 }], // 1,600,000 x 92.25 / 100
        pnl: { account: { unrealized: -68_000, total: -67_546.32 } },
        nav: { account: 2_432_453.68, book: 3_432_453.68 },
        balance: { account: { positions: 1_476_000, assets: 2_432_453.68, netAssets: 2_432_453.68 } },
      },
    },
    {
      // Wednesday 1 March, the put date and a coupon date. The sale settled on 25 Feb. Coupon on 1,600,000: 1,600,000 x 2.125%
      // = 34,000; on the books 32,394.44: 1,605.56 more.
      id: 'coupon', covers: ['coupon', 'settlement'], action: 'clock', to: EST('2028-03-01'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 393,397.41 USD into settled cash', cash: { USD: 393_397.41 } },
          { type: 'bond.coupon', summary: 'Coupon received on 1,600,000 CORRAN-4.25-35P: 34,000.00 USD', cash: { USD: 34_000 }, owner: 'account', date: '2028-03-01' },
          { type: 'accrual.coupon', summary: 'Interest accrued on CORRAN-4.25-35P: 1,605.56 USD' },
        ],
        cash: { account: { USD: { settled: 958_059.24, unsettled: 0, availableToTrade: 958_059.24 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_600_000, accrued: 0 }],
        pending: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-09-01', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2035-03-01', status: 'pending' }],
        pnl: { account: { couponInterest: 2_975, total: -65_940.76 } },
        nav: { account: 2_434_059.24, book: 3_434_059.24 },
        balance: { account: { cash: 958_059.24, receivable: null, accruedIncome: null, assets: 2_434_059.24, netAssets: 2_434_059.24 } },
      },
    },
    {
      // The holder puts 1,000,000 back at par. No accrued interest (the first day of the period). Paid today 1,000,000.
      // Cost out at the average 965,000: realized 35,000.
      id: 'holder-put', covers: ['put (by hand)', 'reduce'], action: 'lifecycle', lot: 'lot', body: { action: 'put', face: 1_000_000 },
      expect: {
        events: [
          { type: 'bond.put', summary: 'Holder put recorded by hand (put date 2028-03-01): 1,000,000 CORRAN-4.25-35P at 100.00% of par', owner: 'account', date: '2028-03-01' },
          { type: 'settlement.receive', summary: 'received 1,000,000.00 USD into settled cash', cash: { USD: 1_000_000 } },
        ],
        cash: { account: { USD: { settled: 1_958_059.24, availableToTrade: 1_958_059.24 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, cost: 579_000, avgCost: 96.5, price: 92.25, value: 553_500, unrealized: -25_500, accrued: 0 }],
        holdings: { main: { long: 600_000, short: 0, net: 600_000 } },
        pnl: { account: { realized: 34_200, unrealized: -25_500, total: 11_559.24 } }, // -800 + 35,000
        nav: { account: 2_511_559.24, book: 3_511_559.24 },
        balance: { account: { cash: 1_958_059.24, positions: 553_500, assets: 2_511_559.24, netAssets: 2_511_559.24 } },
      },
    },
    // Thursday 2 March. End of day 1 Mar: 600,000 at the first day of the period, nothing accrued.
    { id: 'day-after-put', action: 'clock', to: EST('2028-03-02'), expect: { events: [] } },
    {
      id: 'put-after-put-date', covers: 'put (by hand)', action: 'lifecycle', lot: 'lot', body: { action: 'put', face: 600_000 },
      status: 'blocked', reason: 'The put date has passed; the next is 1 March 2031.',
      expect: { refused: '2028-03-02 is not a put date of CORRAN-4.25-35P. The holder may put only on 2028-03-01 at 100.00; 2031-03-01 at 100.00; the next is 2031-03-01.' },
    },
    {
      // The rest is sold at 92 for settlement on 3 March: realized 552,000 - 579,000 = -27,000. Interest sold, 2 days of 30/360:
      // 600,000 x 4.25% x 2/360 = 141.67, all of it income earned to the settlement date.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 600_000, estimate: 92, settleDate: '2028-03-03',
          gross: 552_000, accrued: 141.67, cash: 552_141.67, fees: 27.6 }] }, // 600,000 x 92 / 100; 0.5 bp of 552,000
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 600_000, avgPrice: 92 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 600,000 CORRAN-4\.25-35P @ 92\.00 USD \(realized [-−]27,000\.00 USD\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of CORRAN-4.25-35P: 141.67 USD' },
        ],
        cash: { account: { USD: { settled: 1_958_059.24, unsettled: 552_114.07, availableToTrade: 2_510_173.31 } } }, // 552,141.67 - 27.60
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2028-03-03', amount: 552_114.07, into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: 7_200, couponInterest: 3_116.67, commissions: -143.36, unrealized: 0, total: 10_173.31 } }, // 34,200 - 27,000
        nav: { account: 2_510_173.31, book: 3_510_173.31 },
        balance: { account: { cash: 1_958_059.24, receivable: 552_114.07, positions: null, accruedIncome: null, assets: 2_510_173.31, liabilities: 0, netAssets: 2_510_173.31 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EST('2028-03-03'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 552,114.07 USD into settled cash', cash: { USD: 552_114.07 } }],
        cash: { account: { USD: { settled: 2_510_173.31, unsettled: 0, availableToTrade: 2_510_173.31 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 2_510_173.31, receivable: null, assets: 2_510_173.31, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// convertible_bond
// ---------------------------------------------------------------------------------------------
// A US technology company's convertible senior notes: 1.50%, coupons 15 March and 15 September, 30/360, T+1 on the US bond
// calendar, pieces of 1,000, maturing 15 March 2031, convertible into the issuer's own common stock (Veridian Systems Inc.,
// NASDAQ, registered in the same scenario) at 22.8571 shares per 1,000 face (a conversion price of 43.75). The stock is at
// 51.80, so the notes trade close to parity (22.8571 x 51.80 / 10 = 118.40 per 100).
// The conversion is recorded by hand from the position's Lifecycle menu (Conversion into shares). The rule the Terminal
// applies (server/products/bond.js, convert): the notes converted leave the position at their average cost with no
// realized P&L; the whole shares open in the same strategy instance at that carrying cost (a simulated delivery); the
// fraction of a share is paid in cash at the share price entered by hand, and its share of the cost against that cash is
// realized; the accrued interest on the notes converted is forfeited (reversed out of coupon and interest income), as US
// convertibles pay no accrued interest on conversion.
//   - Opened, increased, partly sold; then 1,000,000 of the 1,200,000 held is converted into 22,857 shares plus 0.1 of a
//     share in cash; a conversion without the share price for that fraction, and one larger than the holding, are refused.
//   - The strategy is then closed: the remaining notes and the shares are sold together, each on its own convention.
//
// Days of 30/360 from 15 Mar 2028: to 3 May 48, 4 May 49, 5 May 50, 9 May 54. Commission: bonds 0.5 basis point of clean
// principal; shares 0.005 a share, at least 1.00 an order.
const convertibleBond = {
  productId: 'convertible_bond',
  title: 'Veridian Systems 1.50% convertible notes 2031: opened, increased, partly sold, converted by hand into the issuer\'s shares at 22.8571 per 1,000 (fraction in cash, accrued forfeited), then notes and shares closed together',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    manualInputs: ['Registration: Shares delivered on conversion (the issuer\'s stock, a registered instrument) and Conversion ratio (shares per 1,000 face)', 'Conversion recorded by hand from the position\'s Lifecycle menu (Conversion into shares: Face amount converted, Settlement, Share price for the fraction)'],
    settlement: 'Notes T+1 on the US bond calendar; shares T+1 on the US stock calendar; the conversion moves no cash except the fraction of a share, paid at once',
    lifecycle: 'Daily accrual on 30/360; conversion closes the notes converted and opens the shares in the same strategy instance (simulated delivery); accrued interest on the notes converted forfeited',
    accounting: 'Shares carried at the notes\' carrying cost (no realized P&L on conversion except the cash fraction); forfeited accrued interest reverses coupon and interest income; realized P&L on the sales; commissions expensed',
    collateral: 'None for long positions',
  },
  start: EDT('2028-05-02'), // Tuesday
  settlementCheck: { lag: 1, holidays: [] },
  book: {
    name: 'Matrix convertible bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_500_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 }, equity: { perUnit: 0.005, minimum: 1, bps: 0 } }, fill: { ...FILL, halfSpreadBps: { bond: 3, equity: 2 } }, settlement: { bond: 1, equity: 1 }, short: SHORT },
  },
  instruments: {
    stock: { productId: 'common_stock', name: 'Veridian Systems Inc.', symbol: 'VRDN', marketView: 'US_CASH', venue: 'NASDAQ', venueType: 'exchange', venueCountry: 'US', issuer: 'Veridian Systems Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    main: { productId: 'convertible_bond', name: 'Veridian Systems Inc 1.50% Convertible Senior Notes 15-Mar-2031', symbol: 'VRDN-1.5-31CV', marketView: 'US_CASH', venueType: 'otc', issuer: 'Veridian Systems Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01, underlying: 'stock',
      terms: { couponType: 'fixed', couponRate: 0.015, frequency: 2, maturity: '2031-03-15', issueDate: '2025-03-15', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured', conversionRatio: 22.8571 } },
  },
  quotes: { main: { bid: 118, ask: 118.5, last: 118.25, bidSize: 10_000_000, askSize: 10_000_000 }, stock: { bid: 51.75, ask: 51.85, last: 51.8, bidSize: 100_000, askSize: 100_000 } },
  expectAtStart: { ...startState(2_500_000, 1_000_000), cash: { account: usdCash(2_500_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 118.5, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2028-05-03', calendar: 'USBOND',
            gross: 1_185_000, accrued: 2_000, // 1,000,000 x 118.50 / 100; 48 days: 1,000,000 x 1.5% x 48/360
            cash: -1_187_000, fees: 59.25 }], // 0.5 bp of 1,185,000
          cash: { USD: { purchases: 1_187_000, fees: 59.25, required: 1_187_059.25, available: 2_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 118.5, fills: [{ qty: 1_000_000, price: 118.5, model: 'quoted-bid-ask', settleDate: '2028-05-03', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 VRDN-1.5-31CV @ 118.50 USD', owner: 'account', date: '2028-05-02' }],
        cash: { account: { USD: { settled: 2_500_000, unsettled: -1_187_059.25, availableToTrade: 1_312_940.75 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 118.5, cost: 1_185_000, price: 118.25, value: 1_182_500, unrealized: -2_500, accrued: 2_000, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-05-03', amount: -1_187_059.25, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-09-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2031-03-17', status: 'pending' }], // 15 Mar 2031 is a Saturday
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -59.25, fees: 0, borrowFunding: 0, unrealized: -2_500, total: -2_559.25 } },
        nav: { account: 2_497_440.75, book: 3_497_440.75 },
        balance: { account: { cash: 2_500_000, accruedIncome: 2_000, positions: 1_182_500, payable: 1_187_059.25, assets: 3_684_500, liabilities: 1_187_059.25, netAssets: 2_497_440.75 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2028-05-03'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,187,059.25 USD from settled cash', cash: { USD: -1_187_059.25 }, date: '2028-05-03' }],
        cash: { account: { USD: { settled: 1_312_940.75, unsettled: 0, availableToTrade: 1_312_940.75 } } },
        pending: [],
        balance: { account: { cash: 1_312_940.75, payable: null, assets: 2_497_440.75, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 1,000,000 -> 1,500,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 500_000, estimate: 118.5, settleDate: '2028-05-04',
          gross: 592_500, accrued: 1_020.83, // 49 days: 500,000 x 1.5% x 49/360 = 1,020.833
          cash: -593_520.83, fees: 29.63 }], // 0.5 bp of 592,500 = 29.625
          cash: { USD: { purchases: 593_520.83, fees: 29.63, required: 593_550.46, available: 1_312_940.75, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 500_000, avgPrice: 118.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 500,000 VRDN-1.5-31CV @ 118.50 USD' }],
        cash: { account: { USD: { settled: 1_312_940.75, unsettled: -593_550.46, availableToTrade: 719_390.29 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, cost: 1_777_500, avgCost: 118.5, price: 118.25, value: 1_773_750, unrealized: -3_750, accrued: 3_020.83 }],
        holdings: { main: { long: 1_500_000, short: 0, net: 1_500_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-05-04', amount: -593_550.46, into: 'cash' }],
        pnl: { account: { commissions: -88.88, unrealized: -3_750, total: -3_838.88 } },
        nav: { account: 2_496_161.12, book: 3_496_161.12 },
        balance: { account: { cash: 1_312_940.75, accruedIncome: 3_020.83, positions: 1_773_750, payable: 593_550.46, assets: 3_089_711.58, liabilities: 593_550.46, netAssets: 2_496_161.12 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: EDT('2028-05-04'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 593,550.46 USD from settled cash', cash: { USD: -593_550.46 } }],
        cash: { account: { USD: { settled: 719_390.29, unsettled: 0, availableToTrade: 719_390.29 } } },
        pending: [],
        balance: { account: { cash: 719_390.29, payable: null, assets: 2_496_161.12, liabilities: 0 } },
      },
    },
    {
      // Cost out at the average 300,000 x 118.50% = 355,500; realized 354,000 - 355,500 = -1,500.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 300_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 300_000, estimate: 118, settleDate: '2028-05-05',
          gross: 354_000, accrued: 625, // 50 days: 300,000 x 1.5% x 50/360
          cash: 354_625, fees: 17.7 }] }, // 0.5 bp of 354,000
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 300_000, avgPrice: 118 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 300,000 VRDN-1\.5-31CV @ 118\.00 USD \(realized [-−]1,500\.00 USD\)$/ }],
        cash: { account: { USD: { settled: 719_390.29, unsettled: 354_607.30, availableToTrade: 1_073_997.59 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, cost: 1_422_000, avgCost: 118.5, price: 118.25, value: 1_419_000, unrealized: -3_000, accrued: 2_395.83 }], // 3,020.83 - 625
        holdings: { main: { long: 1_200_000, short: 0, net: 1_200_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-05-05', amount: 354_607.30, into: 'cash' }],
        pnl: { account: { realized: -1_500, commissions: -106.58, unrealized: -3_000, total: -4_606.58 } },
        nav: { account: 2_495_393.42, book: 3_495_393.42 },
        balance: { account: { cash: 719_390.29, receivable: 354_607.30, accruedIncome: 2_395.83, positions: 1_419_000, assets: 2_495_393.42, liabilities: 0, netAssets: 2_495_393.42 } },
      },
    },
    {
      // Monday 8 May. The sale settled on Friday. End of day 5 May: 1,200,000 x 1.5% x 50/360 = 2,500; on the books 2,395.83: 104.17 more.
      id: 'monday', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2028-05-08'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 354,607.30 USD into settled cash', cash: { USD: 354_607.30 }, date: '2028-05-08' },
          { type: 'accrual.coupon', summary: 'Interest accrued on VRDN-1.5-31CV: 104.17 USD' },
        ],
        cash: { account: { USD: { settled: 1_073_997.59, unsettled: 0, availableToTrade: 1_073_997.59 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, accrued: 2_500 }],
        pending: [],
        pnl: { account: { couponInterest: 104.17, total: -4_502.41 } },
        nav: { account: 2_495_497.59, book: 3_495_497.59 },
        balance: { account: { cash: 1_073_997.59, receivable: null, accruedIncome: 2_500, assets: 2_495_497.59, netAssets: 2_495_497.59 } },
      },
    },
    {
      id: 'convert-without-share-price', covers: 'conversion (by hand)', action: 'lifecycle', lot: 'lot', body: { action: 'convert', face: 1_000_000, settlement: 'shares' },
      status: 'blocked', reason: '1,000,000 face converts into 22,857.1 shares: the cash for the 0.1 of a share needs a share price, which is not assumed.',
      expect: { refused: '1,000,000 face converts into 22,857.1 shares: enter the share price for the fraction of a share paid in cash.' },
    },
    {
      id: 'convert-more-than-held', covers: 'conversion (by hand)', action: 'lifecycle', lot: 'lot', body: { action: 'convert', face: 1_500_000, sharePrice: 51.8, settlement: 'shares' },
      status: 'blocked', reason: 'The position holds 1,200,000 face.',
      expect: { refused: 'The position is 1,200,000 face; cannot convert 1,500,000.' },
    },
    {
      // 1,000,000 face converts into 1,000 x 22.8571 = 22,857.1 shares: 22,857 delivered, 0.1 paid in cash at 51.80 = 5.18.
      // Notes out at their carrying cost: 1,422,000 x 1,000,000 / 1,200,000 = 1,185,000. Shares in at that cost less the part of
      // the fraction: 1,185,000 x 22,857 / 22,857.1 = 1,184,994.8156 -> 1,184,994.82 (average cost 51.843847). The fraction's cost
      // 5.18 against its cash 5.18: realized 0.00. Accrued interest forfeited: 2,500 x 1,000,000 / 1,200,000 = 2,083.33,
      // reversed out of coupon and interest income. The shares are valued at 51.80: 1,183,992.60.
      id: 'convert', covers: ['conversion (by hand)', 'reduce'], action: 'lifecycle', lot: 'lot', body: { action: 'convert', face: 1_000_000, sharePrice: 51.8, settlement: 'shares' },
      expect: {
        events: [
          { type: 'bond.conversion', summary: 'Conversion recorded by hand: 1,000,000 VRDN-1.5-31CV into 22,857 VRDN (simulated delivery, 22.8571 shares per 1,000 face) at the bonds\' carrying cost 1,184,994.82 USD; 0.1 of a share paid in cash at 51.80: 5.18 USD; accrued interest 2,083.33 USD forfeited', owner: 'account', date: '2028-05-08', cash: { USD: 5.18 } },
        ],
        cash: { account: { USD: { settled: 1_074_002.77, availableToTrade: 1_074_002.77 } } },
        positions: [
          { instrument: 'main', lot: 'lot', qty: 200_000, cost: 237_000, avgCost: 118.5, price: 118.25, value: 236_500, unrealized: -500, accrued: 416.67 }, // 2,500 - 2,083.33
          { instrument: 'stock', lot: 'lot', owner: 'account', direction: 'long', qty: 22_857, cost: 1_184_994.82, avgCost: 51.843847, price: 51.8, value: 1_183_992.60, unrealized: -1_002.22, accrued: 0, priceSource: 'Test fixture' },
        ],
        holdings: { main: { long: 200_000, short: 0, net: 200_000 }, stock: { long: 22_857, short: 0, net: 22_857 } },
        pnl: { account: { realized: -1_500, couponInterest: -1_979.16, unrealized: -1_502.22, total: -5_087.96 } }, // 104.17 - 2,083.33; -500 - 1,002.22
        nav: { account: 2_494_912.04, book: 3_494_912.04 }, // 1,074,002.77 + 416.67 + 236,500 + 1,183,992.60
        balance: { account: { cash: 1_074_002.77, accruedIncome: 416.67, positions: 1_420_492.60, assets: 2_494_912.04, netAssets: 2_494_912.04 } },
      },
    },
    {
      // Notes and shares sold together at their bids. Notes: 200,000 x 118.00 = 236,000, accrued 54 days 450.00 (33.33 more than the
      // 416.67 on the books), commission 11.80; realized 236,000 - 237,000 = -1,000. Shares: 22,857 x 51.75 = 1,182,849.75,
      // commission 22,857 x 0.005 = 114.285 -> 114.29; realized 1,182,849.75 - 1,184,994.82 = -2,145.07. Both settle T+1, 9 May.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [
          { kind: 'trade', action: 'sell', instrument: 'main', qty: 200_000, estimate: 118, settleDate: '2028-05-09', gross: 236_000, accrued: 450, cash: 236_450, fees: 11.8 },
          { kind: 'trade', action: 'sell', instrument: 'stock', qty: 22_857, estimate: 51.75, settleDate: '2028-05-09', calendar: 'US', cash: 1_182_849.75, fees: 114.29 },
        ] },
        result: { status: 'closed' },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 200,000 VRDN-1\.5-31CV @ 118\.00 USD \(realized [-−]1,000\.00 USD\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of VRDN-1.5-31CV: 33.33 USD' },
          { type: 'trade.fill', summary: /^Sold 22,857 VRDN @ 51\.75 USD \(realized [-−]2,145\.07 USD\)$/ },
        ],
        cash: { account: { USD: { settled: 1_074_002.77, unsettled: 1_419_173.66, availableToTrade: 2_493_176.43 } } }, // 236,438.20 + 1,182,735.46
        positions: [],
        holdings: { main: null, stock: null },
        pending: [{ instrument: 'main', dueDate: '2028-05-09', amount: 236_438.20, into: 'cash' }, { instrument: 'stock', dueDate: '2028-05-09', amount: 1_182_735.46, into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -4_645.07, couponInterest: -1_945.83, commissions: -232.67, unrealized: 0, total: -6_823.57 } }, // -1,500 - 1,000 - 2,145.07; -1,979.16 + 33.33; 106.58 + 11.80 + 114.29
        nav: { account: 2_493_176.43, book: 3_493_176.43 },
        balance: { account: { cash: 1_074_002.77, receivable: 1_419_173.66, positions: null, accruedIncome: null, assets: 2_493_176.43, liabilities: 0, netAssets: 2_493_176.43 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2028-05-09'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 236,438.20 USD into settled cash', cash: { USD: 236_438.20 } },
          { type: 'settlement.receive', summary: 'received 1,182,735.46 USD into settled cash', cash: { USD: 1_182_735.46 } },
        ],
        cash: { account: { USD: { settled: 2_493_176.43, unsettled: 0, availableToTrade: 2_493_176.43 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 2_493_176.43, receivable: null, assets: 2_493_176.43, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// exchangeable_bond
// ---------------------------------------------------------------------------------------------
// A holding company's zero-coupon bonds exchangeable into the shares of ANOTHER company it owns a stake in: Aldermoor
// Holdings Inc issues them; they exchange into Pell Mineral Resources Inc. (NYSE, registered in the same scenario) at 30
// shares per 1,000 face (an exchange price of 33.33). Zero coupon: no accrued interest and no coupons; redeemed at par on
// 30 September 2030 if not exchanged. T+1 on the US bond calendar, pieces of 1,000. As usual for exchangeables, the issuer
// may elect to pay the holder the shares' value in cash instead of delivering the shares.
//   - Bought on Friday 6 October 2028 for settlement on Tuesday 10 October, over Columbus Day (bond market closed, stock
//     market open). Increased, then the shares rally from 32 to 36 and the bonds with them; part is sold.
//   - 600,000 face is exchanged into 18,000 Pell shares (no fraction), recorded by hand from the Lifecycle menu: the shares
//     open at the bonds' carrying cost. The last 400,000 is exchanged with the issuer electing cash settlement: it pays the
//     value of 12,000 shares at 36.00, entered by hand; the bonds close with a realized gain. Cash settlement without a
//     share price is refused.
//   - The shares are sold on their own ticket (stock ticket, T+1 on the US stock calendar).
// Commission: bonds 0.5 basis point of clean principal; shares 0.005 a share, at least 1.00 an order.
const exchangeableBond = {
  productId: 'exchangeable_bond',
  title: 'Aldermoor Holdings 0% bonds 2030 exchangeable into Pell Mineral shares: bought over Columbus Day, increased, partly sold, exchanged by hand into the other issuer\'s shares, the rest settled in cash at the issuer\'s election, shares sold',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    automaticInputs: ['bid, ask, last in % of par and the shares\' bid, ask, last (quote fixtures standing in for Shaffer MarketData)', 'fill price and fill model', 'settlement date from the instrument convention and settlement calendar', 'commission from the Book fee schedule'],
    manualInputs: ['Registration: Shares delivered on conversion (another issuer\'s stock) and Conversion ratio (shares per 1,000 face)', 'Exchange recorded by hand from the position\'s Lifecycle menu (Conversion into shares: Face amount converted, Settlement shares or cash, Share price)'],
    settlement: 'Bonds T+1 on the US bond calendar (Columbus Day skipped); shares T+1 on the US stock calendar; a cash-settled exchange is paid at once',
    lifecycle: 'Zero coupon: no accrual or coupon; redemption at par scheduled at maturity and cancelled once all is exchanged; exchange into shares (simulated delivery) or into cash at the issuer\'s election',
    accounting: 'Shares carried at the bonds\' carrying cost; a cash-settled exchange realizes the shares\' value against the bonds\' cost; realized P&L on the sales; commissions expensed',
    collateral: 'None for long positions',
  },
  start: EDT('2028-10-06'), // Friday
  settlementCheck: { lag: 1, holidays: ['2028-10-09'] }, // Columbus Day: US bond market closed
  book: {
    name: 'Matrix exchangeable bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 }, equity: { perUnit: 0.005, minimum: 1, bps: 0 } }, fill: { ...FILL, halfSpreadBps: { bond: 3, equity: 2 } }, settlement: { bond: 1, equity: 1 }, short: SHORT },
  },
  instruments: {
    stock: { productId: 'common_stock', name: 'Pell Mineral Resources Inc.', symbol: 'PELL', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Pell Mineral Resources Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    main: { productId: 'exchangeable_bond', name: 'Aldermoor Holdings Inc 0% Exchangeable Bonds 30-Sep-2030 (into Pell Mineral Resources shares)', symbol: 'ALDER-0-30EX', marketView: 'US_CASH', venueType: 'otc', issuer: 'Aldermoor Holdings Inc', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01, underlying: 'stock',
      terms: { couponType: 'zero', maturity: '2030-09-30', issueDate: '2025-09-30', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured', conversionRatio: 30 } },
  },
  quotes: { main: { bid: 103.4, ask: 103.8, last: 103.6, bidSize: 10_000_000, askSize: 10_000_000 }, stock: { bid: 31.95, ask: 32.05, last: 32, bidSize: 100_000, askSize: 100_000 } },
  expectAtStart: { ...startState(2_000_000, 1_000_000), cash: { account: usdCash(2_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      // T+1 from Friday is Monday 9 October, Columbus Day: the bonds settle Tuesday 10 October. No accrued interest (zero coupon).
      id: 'open', covers: ['open', 'market holiday'], action: 'ticket', instrument: 'main', side: 'buy', qty: 800_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 800_000, estimate: 103.8, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2028-10-10', calendar: 'USBOND',
            gross: 830_400, accrued: 0, cash: -830_400, fees: 41.52 }], // 800,000 x 103.80 / 100; 0.5 bp
          cash: { USD: { purchases: 830_400, fees: 41.52, required: 830_441.52, available: 2_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 800_000, avgPrice: 103.8, fills: [{ qty: 800_000, price: 103.8, model: 'quoted-bid-ask', settleDate: '2028-10-10', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 800,000 ALDER-0-30EX @ 103.80 USD', owner: 'account', date: '2028-10-06' }],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -830_441.52, availableToTrade: 1_169_558.48 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 800_000, avgCost: 103.8, cost: 830_400, price: 103.6, value: 828_800, unrealized: -1_600, accrued: 0, priceSource: 'Test fixture' }],
        holdings: { main: { long: 800_000, short: 0, net: 800_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-10-10', amount: -830_441.52, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.maturity', instrument: 'main', dueDate: '2030-09-30', status: 'pending' }], // a Monday; no coupon
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -41.52, fees: 0, borrowFunding: 0, unrealized: -1_600, total: -1_641.52 } },
        nav: { account: 1_998_358.48, book: 2_998_358.48 },
        balance: { account: { cash: 2_000_000, positions: 828_800, payable: 830_441.52, assets: 2_828_800, liabilities: 830_441.52, netAssets: 1_998_358.48 } },
      },
    },
    {
      id: 'settle-after-columbus-day', covers: ['settlement', 'market holiday'], action: 'clock', to: EDT('2028-10-10'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 830,441.52 USD from settled cash', cash: { USD: -830_441.52 }, date: '2028-10-10' }],
        cash: { account: { USD: { settled: 1_169_558.48, unsettled: 0, availableToTrade: 1_169_558.48 } } },
        pending: [],
        balance: { account: { cash: 1_169_558.48, payable: null, assets: 1_998_358.48, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 800,000 -> 1,200,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 400_000, estimate: 103.8, settleDate: '2028-10-11', gross: 415_200, accrued: 0, cash: -415_200, fees: 20.76 }],
          cash: { USD: { purchases: 415_200, fees: 20.76, required: 415_220.76, available: 1_169_558.48, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 400_000, avgPrice: 103.8 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 400,000 ALDER-0-30EX @ 103.80 USD' }],
        cash: { account: { USD: { settled: 1_169_558.48, unsettled: -415_220.76, availableToTrade: 754_337.72 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, cost: 1_245_600, avgCost: 103.8, price: 103.6, value: 1_243_200, unrealized: -2_400, accrued: 0 }],
        holdings: { main: { long: 1_200_000, short: 0, net: 1_200_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-10-11', amount: -415_220.76, into: 'cash' }],
        pnl: { account: { commissions: -62.28, unrealized: -2_400, total: -2_462.28 } },
        nav: { account: 1_997_537.72, book: 2_997_537.72 },
        balance: { account: { cash: 1_169_558.48, positions: 1_243_200, payable: 415_220.76, assets: 2_412_758.48, liabilities: 415_220.76, netAssets: 1_997_537.72 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: EDT('2028-10-11'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 415,220.76 USD from settled cash', cash: { USD: -415_220.76 } }],
        cash: { account: { USD: { settled: 754_337.72, unsettled: 0, availableToTrade: 754_337.72 } } },
        pending: [],
        balance: { account: { cash: 754_337.72, payable: null, assets: 1_997_537.72, liabilities: 0 } },
      },
    },
    { id: 'shares-rally', action: 'quote', instrument: 'stock', quote: { bid: 35.95, ask: 36.05, last: 36, bidSize: 100_000, askSize: 100_000 }, expect: {} },
    {
      // Parity is now 30 x 36 / 10 = 108 per 100; the bonds are quoted at 108.20 / 108.60.
      id: 'bonds-follow', action: 'quote', instrument: 'main', quote: { bid: 108.2, ask: 108.6, last: 108.4, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, price: 108.4, value: 1_300_800, unrealized: 55_200 }], // 1,200,000 x 108.40 / 100
        pnl: { account: { unrealized: 55_200, total: 55_137.72 } },
        nav: { account: 2_055_137.72, book: 3_055_137.72 },
        balance: { account: { positions: 1_300_800, assets: 2_055_137.72, netAssets: 2_055_137.72 } },
      },
    },
    {
      // Realized 216,400 - 200,000 x 103.80% (207,600) = 8,800.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 200_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 200_000, estimate: 108.2, settleDate: '2028-10-12', gross: 216_400, accrued: 0, cash: 216_400, fees: 10.82 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 200_000, avgPrice: 108.2 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 200,000 ALDER-0-30EX @ 108.20 USD (realized 8,800.00 USD)' }],
        cash: { account: { USD: { settled: 754_337.72, unsettled: 216_389.18, availableToTrade: 970_726.90 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, cost: 1_038_000, avgCost: 103.8, price: 108.4, value: 1_084_000, unrealized: 46_000, accrued: 0 }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-10-12', amount: 216_389.18, into: 'cash' }],
        pnl: { account: { realized: 8_800, commissions: -73.1, unrealized: 46_000, total: 54_726.90 } },
        nav: { account: 2_054_726.90, book: 3_054_726.90 },
        balance: { account: { cash: 754_337.72, receivable: 216_389.18, positions: 1_084_000, assets: 2_054_726.90, liabilities: 0, netAssets: 2_054_726.90 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: EDT('2028-10-12'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 216,389.18 USD into settled cash', cash: { USD: 216_389.18 } }],
        cash: { account: { USD: { settled: 970_726.90, unsettled: 0, availableToTrade: 970_726.90 } } },
        pending: [],
        balance: { account: { cash: 970_726.90, receivable: null, assets: 2_054_726.90, liabilities: 0 } },
      },
    },
    {
      // 600,000 face into 600 x 30 = 18,000 Pell shares exactly. The bonds out at their carrying cost 1,038,000 x 0.6 = 622,800;
      // the shares in at 622,800 (average cost 34.60), valued at 36.00: 648,000. No cash, no accrued interest (zero coupon).
      // Net assets fall 2,400: the bonds were valued at 108.40, the shares they became are worth 108.00 per 100.
      id: 'exchange-into-shares', covers: ['exchange (by hand)', 'reduce'], action: 'lifecycle', lot: 'lot', body: { action: 'convert', face: 600_000, settlement: 'shares' },
      expect: {
        events: [{ type: 'bond.exchange', summary: 'Exchange recorded by hand: 600,000 ALDER-0-30EX into 18,000 PELL (simulated delivery, 30 shares per 1,000 face) at the bonds\' carrying cost 622,800.00 USD', owner: 'account', date: '2028-10-12' }],
        positions: [
          { instrument: 'main', lot: 'lot', qty: 400_000, cost: 415_200, avgCost: 103.8, price: 108.4, value: 433_600, unrealized: 18_400, accrued: 0 },
          { instrument: 'stock', lot: 'lot', owner: 'account', direction: 'long', qty: 18_000, cost: 622_800, avgCost: 34.6, price: 36, value: 648_000, unrealized: 25_200, accrued: 0, priceSource: 'Test fixture' },
        ],
        holdings: { main: { long: 400_000, short: 0, net: 400_000 }, stock: { long: 18_000, short: 0, net: 18_000 } },
        pnl: { account: { unrealized: 43_600, total: 52_326.90 } },
        nav: { account: 2_052_326.90, book: 3_052_326.90 }, // 970,726.90 + 433,600 + 648,000
        balance: { account: { positions: 1_081_600, assets: 2_052_326.90, netAssets: 2_052_326.90 } },
      },
    },
    {
      id: 'cash-settlement-without-price', covers: 'exchange (by hand)', action: 'lifecycle', lot: 'lot', instrument: 'main', body: { action: 'convert', face: 400_000, settlement: 'cash' },
      status: 'blocked', reason: 'A cash settlement is the shares\' value at a price that must be stated; none is assumed.',
      expect: { refused: 'Enter the share price the cash settlement is worked out at.' },
    },
    {
      // The issuer elects to settle the last 400,000 in cash: the value of 400 x 30 = 12,000 shares at 36.00 = 432,000, paid now.
      // The bonds' carrying cost 415,200: realized 16,800. The bonds are gone: the redemption at maturity is cancelled.
      id: 'exchange-settled-in-cash', covers: ['exchange (by hand)', 'close'], action: 'lifecycle', lot: 'lot', instrument: 'main', body: { action: 'convert', face: 400_000, sharePrice: 36, settlement: 'cash' },
      expect: {
        events: [{ type: 'bond.exchange', summary: 'Exchange recorded by hand, settled in cash by the issuer: 400,000 ALDER-0-30EX for the value of 12,000 PELL at 36.00 USD: 432,000.00 USD (realized 16,800.00 USD)', owner: 'account', date: '2028-10-12', cash: { USD: 432_000 } }],
        cash: { account: { USD: { settled: 1_402_726.90, availableToTrade: 1_402_726.90 } } },
        positions: [{ instrument: 'stock', lot: 'lot', owner: 'account', direction: 'long', qty: 18_000, cost: 622_800, avgCost: 34.6, price: 36, value: 648_000, unrealized: 25_200, accrued: 0, priceSource: 'Test fixture' }],
        holdings: { main: null, stock: { long: 18_000, short: 0, net: 18_000 } },
        lifecycle: [],
        pnl: { account: { realized: 25_600, unrealized: 25_200, total: 50_726.90 } }, // 8,800 + 16,800
        nav: { account: 2_050_726.90, book: 3_050_726.90 },
        balance: { account: { cash: 1_402_726.90, positions: 648_000, assets: 2_050_726.90, netAssets: 2_050_726.90 } },
      },
    },
    {
      // On the stock ticket: 18,000 x 35.95 = 647,100; commission 18,000 x 0.005 = 90; realized 647,100 - 622,800 = 24,300.
      id: 'sell-shares', covers: 'close', action: 'ticket', ticketOf: 'equity', instrument: 'stock', side: 'sell', qty: 18_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'stock', qty: 18_000, estimate: 35.95, settleDate: '2028-10-13', calendar: 'US', cash: 647_100, fees: 90 }] },
        result: { orders: [{ action: 'sell', status: 'filled', filledQty: 18_000, avgPrice: 35.95 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 18,000 PELL @ 35.95 USD (realized 24,300.00 USD)' }],
        cash: { account: { USD: { settled: 1_402_726.90, unsettled: 647_010, availableToTrade: 2_049_736.90 } } },
        positions: [],
        holdings: { stock: null },
        pending: [{ instrument: 'stock', dueDate: '2028-10-13', amount: 647_010, into: 'cash' }],
        pnl: { account: { realized: 49_900, couponInterest: 0, commissions: -163.1, unrealized: 0, total: 49_736.90 } },
        nav: { account: 2_049_736.90, book: 3_049_736.90 },
        balance: { account: { cash: 1_402_726.90, receivable: 647_010, positions: null, assets: 2_049_736.90, liabilities: 0, netAssets: 2_049_736.90 } },
      },
    },
    {
      id: 'settle-shares', covers: 'settlement', action: 'clock', to: EDT('2028-10-13'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 647,010.00 USD into settled cash', cash: { USD: 647_010 } }],
        cash: { account: { USD: { settled: 2_049_736.90, unsettled: 0, availableToTrade: 2_049_736.90 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 2_049_736.90, receivable: null, assets: 2_049_736.90, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// coco_bond
// ---------------------------------------------------------------------------------------------
// A bank's Additional Tier 1 contingent convertible: 7.25% fixed, coupons 20 March and 20 September, 30/360, perpetual
// (first call date 20 September 2030 at par), T+2 (the instrument's own settlement convention), pieces of 200,000 (sold to
// professional investors only). Coupons are fully discretionary and the principal is written down if the bank's CET1 ratio
// falls below its trigger. Both are recorded by hand on the instrument form:
//   - the issuer cancels the coupon: recorded as a coupon suspension; the interest accrued and not received is reversed
//     (it will never be paid), the 20 September coupon date passes unpaid and is listed in the history;
//   - the trigger event: a permanent write-down of 75% of the principal (factor 1 to 0.25), with no payment; each holder's
//     cost falls by 75% and that cost is a realized loss.
// After it the notes trade on the reduced principal (face x 0.25 x price) and flat (coupons cancelled); the holding is sold.
//
// Days of 30/360 from 20 Mar 2028: to 3 Aug 133, 4 Aug 134, 7 Aug 137, 8 Aug 138, 9 Aug 139. Commission: 1 basis point of
// clean principal.
const cocoBond = {
  productId: 'coco_bond',
  title: 'Nordhavn Bank 7.25% perpetual AT1 CoCo: pieces of 200,000 (odd lot refused), T+2, opened, increased, partly sold, coupon cancelled by hand, coupon date missed, trigger write-down of 75% by hand, sold on the reduced principal',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 200,000)'],
    manualInputs: ['Registration: Perpetual, a coupon date, Call schedule, Minimum denomination 200,000, Settlement convention 2', 'Coupon cancellation recorded by hand (instrument form, Review coupon suspension, Suspend coupons)', 'Trigger event recorded by hand (instrument form: Principal written down to 0.25, Kind of write-down: Trigger event, Review write-down, Record write-down)'],
    settlement: 'T+2 on the US bond calendar (the instrument\'s own convention); after the write-down a trade settles face x factor x price, flat',
    lifecycle: 'Daily accrual on 30/360 until the coupon is cancelled; accrued interest reversed on cancellation; coupon date passes unpaid (history); permanent write-down of principal; no maturity',
    accounting: 'Clean cost at average; cancelled accrued interest reverses coupon income; the cost written down is a realized loss; realized P&L on the sales; commission expensed',
    collateral: 'None for a long position',
  },
  start: EDT('2028-08-01'), // Tuesday
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix CoCo', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 1 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'coco_bond', name: 'Nordhavn Bank AB 7.25% Perpetual Contingent Convertible AT1 Notes', symbol: 'NORDH-7.25-AT1', marketView: 'US_CASH', venueType: 'otc', issuer: 'Nordhavn Bank AB', domicile: 'SE', underlyingGeo: 'SE', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settleLag: 2 },
      terms: { couponType: 'fixed', couponRate: 0.0725, frequency: 2, perpetual: true, anchorDate: '2023-09-20', issueDate: '2023-09-20', dayCount: '30/360', redemption: 100, minDenomination: 200_000, seniority: 'Additional Tier 1 (deeply subordinated)',
        callSchedule: [{ date: '2030-09-20', price: 100 }] } },
  },
  quotes: { main: { bid: 97.6, ask: 98, last: 97.8, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(2_000_000, 1_000_000), cash: { account: usdCash(2_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'odd-lot', covers: 'minimum denomination', action: 'ticket', instrument: 'main', side: 'buy', qty: 250_000,
      status: 'blocked', reason: 'AT1 notes trade in multiples of 200,000 face.',
      expect: { refused: 'quantity must be a multiple of 200000' }, // the Terminal writes the step without a thousands separator
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 98, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2028-08-03', calendar: 'USBOND',
            gross: 980_000, accrued: 26_784.72, // 133 days: 1,000,000 x 7.25% x 133/360 = 26,784.722
            cash: -1_006_784.72, fees: 98 }], // 1 bp of 980,000
          cash: { USD: { purchases: 1_006_784.72, fees: 98, required: 1_006_882.72, available: 2_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 98, fills: [{ qty: 1_000_000, price: 98, model: 'quoted-bid-ask', settleDate: '2028-08-03', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 NORDH-7.25-AT1 @ 98.00 USD', owner: 'account', date: '2028-08-01' }],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -1_006_882.72, availableToTrade: 993_117.28 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 98, cost: 980_000, price: 97.8, value: 978_000, unrealized: -2_000, accrued: 26_784.72, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-08-03', amount: -1_006_882.72, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-09-20', status: 'pending' }], // perpetual: no maturity
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -98, fees: 0, borrowFunding: 0, unrealized: -2_000, total: -2_098 } },
        nav: { account: 1_997_902, book: 2_997_902 },
        balance: { account: { cash: 2_000_000, accruedIncome: 26_784.72, positions: 978_000, payable: 1_006_882.72, assets: 3_004_784.72, liabilities: 1_006_882.72, netAssets: 1_997_902 } },
      },
    },
    {
      // Thursday 3 Aug (T+2). End of day 2 Aug: the purchase settles on the 3rd; the interest bought is on the books.
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2028-08-03'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,006,882.72 USD from settled cash', cash: { USD: -1_006_882.72 }, date: '2028-08-03' }],
        cash: { account: { USD: { settled: 993_117.28, unsettled: 0, availableToTrade: 993_117.28 } } },
        pending: [],
        balance: { account: { cash: 993_117.28, payable: null, assets: 1_997_902, liabilities: 0 } },
      },
    },
    {
      // Thursday: T+2 is Monday 7 August.
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.4, // 1,000,000 -> 1,400,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 400_000, estimate: 98, settleDate: '2028-08-07',
          gross: 392_000, accrued: 11_036.11, // 137 days: 400,000 x 7.25% x 137/360 = 11,036.111
          cash: -403_036.11, fees: 39.2 }],
          cash: { USD: { purchases: 403_036.11, fees: 39.2, required: 403_075.31, available: 993_117.28, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 400_000, avgPrice: 98 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 400,000 NORDH-7.25-AT1 @ 98.00 USD' }],
        cash: { account: { USD: { settled: 993_117.28, unsettled: -403_075.31, availableToTrade: 590_041.97 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_400_000, cost: 1_372_000, avgCost: 98, price: 97.8, value: 1_369_200, unrealized: -2_800, accrued: 37_820.83 }],
        holdings: { main: { long: 1_400_000, short: 0, net: 1_400_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-08-07', amount: -403_075.31, into: 'cash' }],
        pnl: { account: { commissions: -137.2, unrealized: -2_800, total: -2_937.20 } },
        nav: { account: 1_997_062.80, book: 2_997_062.80 },
        balance: { account: { cash: 993_117.28, accruedIncome: 37_820.83, positions: 1_369_200, payable: 403_075.31, assets: 2_400_138.11, liabilities: 403_075.31, netAssets: 1_997_062.80 } },
      },
    },
    {
      // Monday 7 Aug. End of day Friday 4 Aug: 1,000,000 settled, 134 days, 26,986.111, plus 400,000 to 7 Aug, 11,036.111:
      // 38,022.22. On the books 37,820.83: 201.39 more.
      id: 'settle-increase', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2028-08-07'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 403,075.31 USD from settled cash', cash: { USD: -403_075.31 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on NORDH-7.25-AT1: 201.39 USD' },
        ],
        cash: { account: { USD: { settled: 590_041.97, unsettled: 0, availableToTrade: 590_041.97 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_400_000, accrued: 38_022.22 }],
        pending: [],
        pnl: { account: { couponInterest: 201.39, total: -2_735.81 } },
        nav: { account: 1_997_264.19, book: 2_997_264.19 },
        balance: { account: { cash: 590_041.97, payable: null, accruedIncome: 38_022.22, assets: 1_997_264.19, liabilities: 0, netAssets: 1_997_264.19 } },
      },
    },
    {
      // Cost out at the average 400,000 x 98% = 392,000; realized 390,400 - 392,000 = -1,600. Settles Wednesday 9 Aug.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 400_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 400_000, estimate: 97.6, settleDate: '2028-08-09',
          gross: 390_400, accrued: 11_197.22, // 139 days: 400,000 x 7.25% x 139/360 = 11,197.222
          cash: 401_597.22, fees: 39.04 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 400_000, avgPrice: 97.6 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 400,000 NORDH-7\.25-AT1 @ 97\.60 USD \(realized [-−]1,600\.00 USD\)$/ }],
        cash: { account: { USD: { settled: 590_041.97, unsettled: 401_558.18, availableToTrade: 991_600.15 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, cost: 980_000, avgCost: 98, price: 97.8, value: 978_000, unrealized: -2_000, accrued: 26_825 }], // 38,022.22 - 11,197.22
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2028-08-09', amount: 401_558.18, into: 'cash' }],
        pnl: { account: { realized: -1_600, commissions: -176.24, unrealized: -2_000, total: -3_574.85 } },
        nav: { account: 1_996_425.15, book: 2_996_425.15 },
        balance: { account: { cash: 590_041.97, receivable: 401_558.18, accruedIncome: 26_825, positions: 978_000, assets: 1_996_425.15, liabilities: 0, netAssets: 1_996_425.15 } },
      },
    },
    {
      // Wednesday 9 Aug. End of day 8 Aug: all 1,400,000 still settled (the sale settles on the 9th), 138 days, 38,908.333, less
      // the 11,197.222 sold: 27,711.11. On the books 26,825.00: 886.11 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2028-08-09'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 401,558.18 USD into settled cash', cash: { USD: 401_558.18 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on NORDH-7.25-AT1: 886.11 USD' },
        ],
        cash: { account: { USD: { settled: 991_600.15, unsettled: 0, availableToTrade: 991_600.15 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, accrued: 27_711.11 }],
        pending: [],
        pnl: { account: { couponInterest: 1_087.50, total: -2_688.74 } },
        nav: { account: 1_997_311.26, book: 2_997_311.26 },
        balance: { account: { cash: 991_600.15, receivable: null, accruedIncome: 27_711.11, assets: 1_997_311.26, netAssets: 1_997_311.26 } },
      },
    },
    {
      // The bank cancels the 20 September coupon (discretionary for AT1), recorded by hand as a coupon suspension. The 27,711.11
      // accrued will not be paid: reversed out of coupon and interest income. The notes now trade flat.
      id: 'coupon-cancelled', covers: 'coupon cancellation (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'suspend_coupon', suspended: true },
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Accrued interest reversed on NORDH-7.25-AT1: coupons suspended, not accrued or paid: 27,711.11 USD', owner: 'account' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, accrued: 0 }],
        pnl: { account: { couponInterest: -26_623.61, total: -30_399.85 } }, // 1,087.50 - 27,711.11
        nav: { account: 1_969_600.15, book: 2_969_600.15 },
        balance: { account: { accruedIncome: null, assets: 1_969_600.15, netAssets: 1_969_600.15 } },
      },
    },
    {
      // Wednesday 20 September: the coupon date passes unpaid and is listed. The next coupon date is scheduled (it is also
      // discretionary). Nothing accrued meanwhile.
      id: 'coupon-date-missed', covers: 'coupon cancellation (by hand)', action: 'clock', to: EDT('2028-09-20'),
      expect: {
        events: [{ type: 'bond.coupon_missed', summary: 'Coupon of 2028-09-20 not paid on 1,000,000 NORDH-7.25-AT1: coupons are suspended', owner: 'account', date: '2028-09-20' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2029-03-20', status: 'pending' }],
      },
    },
    {
      // The trigger event: the bank's CET1 ratio is reported below the trigger and 75% of the principal is written down
      // permanently, recorded by hand: factor 1 to 0.25. 750,000 of the 1,000,000 face is written off with no payment; cost out
      // 980,000 x 0.75 = 735,000, a realized loss. Left: cost 245,000 on 250,000 of principal (average cost still 98.00 per
      // 100 of principal), valued 250,000 x 97.80 / 100 = 244,500.
      id: 'trigger-write-down', covers: 'trigger event (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'writedown', newFactor: 0.25, kind: 'writedown' },
      expect: {
        events: [{ type: 'bond.writedown', summary: 'Principal written down by hand on NORDH-7.25-AT1: factor 1 to 0.25, 750,000 of principal written off with no payment (1,000,000 original face); cost 735,000.00 USD written off as realized loss', owner: 'account', date: '2028-09-20' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, cost: 245_000, avgCost: 98, price: 97.8, value: 244_500, unrealized: -500, accrued: 0 }],
        pnl: { account: { realized: -736_600, unrealized: -500, total: -763_899.85 } }, // -1,600 - 735,000
        nav: { account: 1_236_100.15, book: 2_236_100.15 },
        balance: { account: { positions: 244_500, assets: 1_236_100.15, netAssets: 1_236_100.15 } },
      },
    },
    {
      id: 'written-down-quote', action: 'quote', instrument: 'main', quote: { bid: 38, ask: 41, last: 39.5, bidSize: 5_000_000, askSize: 5_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, price: 39.5, value: 98_750, unrealized: -146_250 }], // 250,000 x 39.50 / 100
        pnl: { account: { unrealized: -146_250, total: -909_649.85 } },
        nav: { account: 1_090_350.15, book: 2_090_350.15 },
        balance: { account: { positions: 98_750, assets: 1_090_350.15, netAssets: 1_090_350.15 } },
      },
    },
    {
      // Sold on the reduced principal, flat: 1,000,000 face x 0.25 x 38.00 / 100 = 95,000; commission 1 bp, 9.50; settles
      // Friday 22 September (T+2). Realized 95,000 - 245,000 = -150,000.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_000_000, estimate: 38, settleDate: '2028-09-22', notional: 250_000, gross: 95_000, accrued: 0, cash: 95_000, fees: 9.5 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1_000_000, avgPrice: 38 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 1,000,000 NORDH-7\.25-AT1 @ 38\.00 USD \(realized [-−]150,000\.00 USD\)$/ }],
        cash: { account: { USD: { settled: 991_600.15, unsettled: 94_990.50, availableToTrade: 1_086_590.65 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2028-09-22', amount: 94_990.50, into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -886_600, commissions: -185.74, unrealized: 0, total: -913_409.35 } },
        nav: { account: 1_086_590.65, book: 2_086_590.65 },
        balance: { account: { cash: 991_600.15, receivable: 94_990.50, positions: null, assets: 1_086_590.65, liabilities: 0, netAssets: 1_086_590.65 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2028-09-22'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 94,990.50 USD into settled cash', cash: { USD: 94_990.50 } }],
        cash: { account: { USD: { settled: 1_086_590.65, unsettled: 0, availableToTrade: 1_086_590.65 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 1_086_590.65, receivable: null, assets: 1_086_590.65, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Mortgage-backed securities: rules common to the five scenarios below
// ---------------------------------------------------------------------------------------------
//   - Quantity is ORIGINAL face. Current face = original face x pool factor. A trade settles current face x price / 100
//     plus accrued interest on current face; a position is valued, and its average cost shown, per 100 of current face.
//   - A monthly pool accrues 30/360 from the 1st of the month: its coupon dates are the 1st, each ending the accrual period
//     of the month before, and the coupon (interest on the factor of that month) is paid after the payment delay
//     (registered as days after the period end: Fannie Mae 24, the 25th; Ginnie Mae I 14, the 15th), moved to the next
//     business day. It belongs to the face held at the end of the month (settled before the 1st).
//   - Paydowns are recorded by hand on the instrument (Edit, Lifecycle events recorded by hand) when the new factor is
//     published (about the 4th business day of the month): the new factor, the date it is effective from (the 1st), the date
//     the principal is paid (the same day as the coupon), and optionally the factor after scheduled amortisation alone (the
//     history then splits the principal into scheduled and prepaid, with the single monthly mortality SMM). Each holder is
//     paid face x (old factor - new factor) at par: a receivable until the payment date. Its cost falls in proportion; the
//     difference is realized P&L (the premium or discount on the principal returned). Accrued interest of the new month is
//     restated on the new factor; the coupon of the month before keeps the old one.
//   - A loss allocated to a non-agency tranche is a write-down of the factor with no payment (kind 'loss'); it is refused on
//     a pool whose principal an agency guarantees.

// ---------------------------------------------------------------------------------------------
// agency_mbs
// ---------------------------------------------------------------------------------------------
// A Fannie Mae UMBS 30-year 5.50% specified pool held by TREASURY as part of its liquidity portfolio: monthly 30/360,
// 24-day payment delay (paid on the 25th), guaranteed by Fannie Mae, settling T+3 on the US bond calendar (the instrument's
// own convention), original face in whole dollars. Factor 0.9187321 for November 2028.
//   - Bought on Tuesday 7 November for settlement on Monday 13 November (T+3 skips Friday 10 November, Veterans Day observed
//     by the bond market). Bought after the October record date, so the first coupon it receives is November's interest,
//     paid on 26 December (the 25th is Christmas).
//   - A loss allocation is refused: the principal is guaranteed.
//   - On 6 December the December factor is published: 0.9104562, effective 1 December, principal paid with the coupon;
//     0.9168105 after scheduled amortisation alone (the rest is prepayment).
//   - A quarter of the pool is sold after the factor, at the new current face; the coupon and the paydown of the whole
//     holding still come to Treasury (it held it at the November record date).
//   - The rest is sold for settlement on 29 December, before the December record date: nothing is left to receive.
// Commission: 0.25 basis point of clean principal. Days of 30/360: 1 to 13 Nov 12, 1 to 30 Nov 29; 1 Dec to 5 Dec 4, to 8 Dec 7,
// to 11 Dec 10, to 22 Dec 21, to 29 Dec 28. A month's coupon is 5.5% / 12 of current face.
const agencyMbs = {
  productId: 'agency_mbs',
  title: 'Fannie Mae UMBS 5.50% pool held by Treasury: T+3 over Veterans Day, loss allocation refused (guaranteed), factor and paydown by hand with prepayment split, sale on current face, coupon after the 24-day delay over Christmas, close',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account (Treasury)', 'Action', 'Face amount (original face)'],
    manualInputs: ['Registration: Pool factor, Payment delay 24, Guarantor, Settlement convention 3', 'Paydown recorded by hand on the instrument form: New pool factor, Factor effective from, Principal paid on, Factor after scheduled principal'],
    settlement: 'T+3 on the US bond calendar (the pool\'s own convention); current face = original face x factor; accrued 30/360 from the 1st on current face',
    lifecycle: 'Monthly coupon on the factor of the month, paid 24 days after the period ends (next business day); paydown principal paid on the payment date as a receivable; accrued restated on the new factor; loss allocation refused for a guaranteed pool',
    accounting: 'Treasury\'s position: cost per 100 of current face; paydown at par against cost is realized P&L; coupon and interest income; commission expensed',
    collateral: 'None for a long position',
  },
  start: EST('2028-11-07'), // Tuesday
  settlementCheck: { lag: 3, holidays: ['2028-11-10', '2028-11-23', '2028-12-25'] }, // Veterans Day (observed by the bond market), Thanksgiving, Christmas
  book: {
    name: 'Matrix agency MBS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 25_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 1_000_000 }] }, // the Account stays idle: Treasury trades
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.25 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'agency_mbs', name: 'Fannie Mae UMBS 30-Year 5.50% Pool BX1234', symbol: 'FN-5.5-BX1234', marketView: 'US_CASH', venueType: 'otc', issuer: 'Federal National Mortgage Association', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settleLag: 3 },
      terms: { couponType: 'fixed', couponRate: 0.055, frequency: 12, maturity: '2054-10-01', issueDate: '2024-10-01', dayCount: '30/360', redemption: 100, factor: 0.9187321, paymentDelayDays: 24, guarantor: 'Fannie Mae' } },
  },
  quotes: { main: { bid: 100.375, ask: 100.5, last: 100.4375, bidSize: 100_000_000, askSize: 100_000_000 } },
  expectAtStart: { ...startState(1_000_000, 24_000_000), cash: { account: usdCash(1_000_000), treasury: usdCash(24_000_000) } },
  steps: [
    {
      id: 'open', covers: ['open', 'market holiday'], action: 'ticket', instrument: 'main', side: 'buy', qty: 20_000_000, as: 'lot', owner: 'treasury',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 20_000_000, estimate: 100.5, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2028-11-13', calendar: 'USBOND',
            notional: 18_374_642, // current face: 20,000,000 x 0.9187321
            gross: 18_466_515.21, // 18,374,642 x 100.50 / 100
            accrued: 33_686.84, // 12 days: 18,374,642 x 5.5% x 12/360 = 33,686.844
            cash: -18_500_202.05, fees: 461.66 }], // 0.25 bp of 18,466,515.21 = 461.663
          cash: { USD: { purchases: 18_500_202.05, fees: 461.66, required: 18_500_663.71, available: 24_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20_000_000, avgPrice: 100.5, fills: [{ qty: 20_000_000, price: 100.5, model: 'quoted-bid-ask', settleDate: '2028-11-13', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted', owner: 'treasury' }, { type: 'trade.fill', summary: 'Bought 20,000,000 FN-5.5-BX1234 @ 100.50 USD', owner: 'treasury', date: '2028-11-07' }],
        cash: { treasury: { USD: { settled: 24_000_000, unsettled: -18_500_663.71, availableToTrade: 5_499_336.29 } }, account: { USD: { settled: 1_000_000, availableToTrade: 1_000_000 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 20_000_000, avgCost: 100.5, cost: 18_466_515.21, price: 100.4375,
          value: 18_455_031.06, // 18,374,642 x 100.4375 / 100 = 18,455,031.059
          unrealized: -11_484.15, accrued: 33_686.84, priceSource: 'Test fixture' }],
        holdings: { main: { long: 20_000_000, short: 0, net: 20_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2028-11-13', amount: -18_500_663.71, ccy: 'USD', into: 'cash' }],
        // Bought after the 31 October record date: the first coupon is 1 December's (November's interest), paid 24 days later,
        // the 25th, Christmas: on Tuesday 26 December. Maturity 1 Oct 2054 + 24 days = Sunday 25 Oct 2054: paid Monday 26 Oct.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-12-26', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2054-10-26', status: 'pending' }],
        pnl: {
          account: { realized: 0, couponInterest: 0, commissions: 0, unrealized: 0, total: 0 },
          book: { realized: 0, couponInterest: 0, commissions: -461.66, fees: 0, borrowFunding: 0, unrealized: -11_484.15, total: -11_945.81 },
        },
        nav: { account: 1_000_000, treasury: 23_988_054.19, book: 24_988_054.19 },
        balance: {
          account: { cash: 1_000_000, assets: 1_000_000, liabilities: 0, netAssets: 1_000_000 },
          book: { cash: 25_000_000, accruedIncome: 33_686.84, positions: 18_455_031.06, payable: 18_500_663.71, assets: 43_488_717.90, liabilities: 18_500_663.71, netAssets: 24_988_054.19 },
        },
      },
    },
    {
      // Monday 13 Nov (T+3: 8, 9, 13 November; the 10th is closed). End of day Friday 10 Nov (New York open): the interest bought runs
      // to the 13th and is on the books.
      id: 'settle-open', covers: ['settlement', 'market holiday'], action: 'clock', to: EST('2028-11-13'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 18,500,663.71 USD from settled cash', cash: { USD: -18_500_663.71 }, owner: 'treasury', date: '2028-11-13' }],
        cash: { treasury: { USD: { settled: 5_499_336.29, unsettled: 0, availableToTrade: 5_499_336.29 } } },
        pending: [],
        balance: { book: { cash: 6_499_336.29, payable: null, assets: 24_988_054.19, liabilities: 0 } },
      },
    },
    { id: 'treasury-screens', covers: 'open', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      id: 'loss-refused', covers: 'loss allocation (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'writedown', newFactor: 0.9, kind: 'loss' },
      status: 'blocked', reason: 'Fannie Mae guarantees the pool\'s principal: losses on the loans are not passed to holders.',
      expect: { refused: 'FN-5.5-BX1234 is guaranteed by Fannie Mae: losses on the underlying loans are not passed to holders.' },
    },
    {
      // Friday 1 December. End of day 30 Nov: 18,374,642 x 5.5% x 29/360 = 81,409.87; 47,723.03 more.
      id: 'december-1', covers: 'accrual', action: 'clock', to: EST('2028-12-01'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on FN-5.5-BX1234: 47,723.03 USD', owner: 'treasury' }],
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', qty: 20_000_000, accrued: 81_409.87 }],
        pnl: { book: { couponInterest: 47_723.03, total: 35_777.22 } },
        nav: { treasury: 24_035_777.22, book: 25_035_777.22 },
        balance: { book: { accruedIncome: 81_409.87, assets: 25_035_777.22, netAssets: 25_035_777.22 } },
      },
    },
    {
      // Wednesday 6 December. End of day 5 Dec: November's coupon, due on the 26th, is a receivable in accrued interest:
      // 18,374,642 x 5.5% / 12 = 84,217.11; plus 4 days of December on the same face (the December factor is not known yet):
      // 11,228.95. Together 95,446.06; 14,036.19 more.
      id: 'december-6', covers: 'accrual', action: 'clock', to: EST('2028-12-06'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on FN-5.5-BX1234: 14,036.19 USD', owner: 'treasury' }],
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', qty: 20_000_000, accrued: 95_446.06 }],
        pnl: { book: { couponInterest: 61_759.22, total: 49_813.41 } },
        nav: { treasury: 24_049_813.41, book: 25_049_813.41 },
        balance: { book: { accruedIncome: 95_446.06, assets: 25_049_813.41, netAssets: 25_049_813.41 } },
      },
    },
    {
      // The December factor is published and recorded by hand: 0.9187321 to 0.9104562 from 1 December, principal paid on
      // 26 December. Principal 20,000,000 x 0.0082759 = 165,518.00, receivable until then. Of it 0.0019216 of original face is
      // scheduled (0.9187321 - 0.9168105) and 0.0063543 prepaid (SMM 0.0063543 / 0.9168105 = 0.6931%). Cost out
      // 18,466,515.21 x 0.0082759 / 0.9187321 = 166,345.59: realized 165,518 - 166,345.59 = -827.59 (the 0.50 premium paid on
      // the principal returned at par). December's 4 days restated on the new current face 18,209,124: 11,127.80 instead of
      // 11,228.95, so the accrued balance is 95,344.91, 101.15 down. Current face now 18,209,124, valued at 100.4375.
      id: 'factor-and-paydown', covers: ['paydown (by hand)', 'prepayment (by hand)'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'paydown', newFactor: 0.9104562, effective: '2028-12-01', payDate: '2028-12-26', scheduledFactor: 0.9168105 },
      expect: {
        events: [
          { type: 'bond.paydown', summary: 'Principal paydown on FN-5.5-BX1234: factor 0.9187321 to 0.9104562 from 2028-12-01; scheduled principal 0.0019216, prepaid 0.0063543 of original face (SMM 0.6931%), 165,518.00 USD receivable on 2028-12-26', owner: 'treasury', date: '2028-12-06' },
          { type: 'accrual.coupon', summary: 'Accrued interest restated on the new factor of FN-5.5-BX1234, down: 101.15 USD', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 5_499_336.29, unsettled: 165_518, availableToTrade: 5_664_854.29 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', qty: 20_000_000, cost: 18_300_169.62, avgCost: 100.5, price: 100.4375,
          value: 18_288_788.92, // 18,209,124 x 100.4375 / 100 = 18,288,788.918
          unrealized: -11_380.70, accrued: 95_344.91 }],
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2028-12-26', amount: 165_518, ccy: 'USD', into: 'cash' }],
        pnl: { book: { realized: -827.59, couponInterest: 61_658.07, unrealized: -11_380.70, total: 48_988.12 } },
        nav: { treasury: 24_048_988.12, book: 25_048_988.12 },
        balance: { book: { cash: 6_499_336.29, receivable: 165_518, accruedIncome: 95_344.91, positions: 18_288_788.92, assets: 25_048_988.12, netAssets: 25_048_988.12 } },
      },
    },
    {
      // A quarter sold at the new factor: current face 5,000,000 x 0.9104562 = 4,552,281 at 100.375 = 4,569,352.05; accrued 10 days
      // to settlement on Monday 11 Dec: 6,954.87. Cost out 18,300,169.62 / 4 = 4,575,042.41: realized -5,690.36.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 5_000_000, from: 'lot', owner: 'treasury',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 5_000_000, estimate: 100.375, settleDate: '2028-12-11', notional: 4_552_281,
          gross: 4_569_352.05, accrued: 6_954.87, cash: 4_576_306.92, fees: 114.23 }] }, // 4,552,281 x 5.5% x 10/360 = 6,954.874; 0.25 bp = 114.234
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 5_000_000, avgPrice: 100.375 }] },
        events: [{ type: 'strategy.legs_added', owner: 'treasury' }, { type: 'trade.fill', summary: /^Sold 5,000,000 FN-5\.5-BX1234 @ 100\.375 USD \(realized [-−]5,690\.36 USD\)$/, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 5_499_336.29, unsettled: 4_741_710.69, availableToTrade: 10_241_046.98 } } }, // 165,518 + 4,576,192.69
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', qty: 15_000_000, cost: 13_725_127.21, avgCost: 100.5, price: 100.4375,
          value: 13_716_591.69, unrealized: -8_535.52, accrued: 88_390.04 }], // 13,656,843 x 100.4375 / 100; 95,344.91 - 6,954.87
        holdings: { main: { long: 15_000_000, short: 0, net: 15_000_000 } },
        // The trade (re)schedules the position's next coupon: 1 January (December's interest, paid 25 January 2029). November's,
        // paid on 26 December, is still to come: both are listed.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-12-26', status: 'pending' }, { type: 'bond.coupon', instrument: 'main', dueDate: '2029-01-25', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2054-10-26', status: 'pending' }],
        pending: [
          { instrument: 'main', owner: 'treasury', dueDate: '2028-12-11', amount: 4_576_192.69, ccy: 'USD', into: 'cash' },
          { instrument: 'main', owner: 'treasury', dueDate: '2028-12-26', amount: 165_518, ccy: 'USD', into: 'cash' },
        ],
        pnl: { book: { realized: -6_517.95, commissions: -575.89, unrealized: -8_535.52, total: 46_028.71 } },
        nav: { treasury: 24_046_028.71, book: 25_046_028.71 },
        balance: { book: { receivable: 4_741_710.69, accruedIncome: 88_390.04, positions: 13_716_591.69, assets: 25_046_028.71, netAssets: 25_046_028.71 } },
      },
    },
    {
      // Monday 11 Dec. End of day Friday 8 Dec: November's coupon on the whole 20,000,000 (held at the record date), 84,217.11;
      // plus 7 days of December on 18,209,124 (the sale settles on the 11th, so all of it is still settled face), 19,473.6465;
      // less the 10 days of interest sold, 6,954.8738: 96,735.88. On the books 88,390.04: 8,345.84 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EST('2028-12-11'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 4,576,192.69 USD into settled cash', cash: { USD: 4_576_192.69 }, owner: 'treasury' },
          { type: 'accrual.coupon', summary: 'Interest accrued on FN-5.5-BX1234: 8,345.84 USD', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 10_075_528.98, unsettled: 165_518, availableToTrade: 10_241_046.98 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', qty: 15_000_000, accrued: 96_735.88 }],
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2028-12-26', amount: 165_518, ccy: 'USD', into: 'cash' }],
        pnl: { book: { couponInterest: 70_003.91, total: 54_374.55 } },
        nav: { treasury: 24_054_374.55, book: 25_054_374.55 },
        balance: { book: { cash: 11_075_528.98, receivable: 165_518, accruedIncome: 96_735.88, assets: 25_054_374.55, netAssets: 25_054_374.55 } },
      },
    },
    {
      // Tuesday 26 December (the 25th is Christmas). The principal of the paydown arrives: 165,518.00. November's coupon is paid on
      // the 20,000,000 held at the November record date, on the November factor: 18,374,642 x 5.5% / 12 = 84,217.11. After it the
      // accrued balance is December's interest to 8 Dec (12,518.77), as it should be. End of day Friday 22 Dec: 15,000,000 x
      // 0.9104562 = 13,656,843 x 5.5% x 21/360 = 43,815.70; 31,296.93 more.
      id: 'coupon-and-principal-after-christmas', covers: ['coupon', 'paydown (by hand)', 'settlement', 'market holiday'], action: 'clock', to: EST('2028-12-26'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 165,518.00 USD into settled cash', cash: { USD: 165_518 }, owner: 'treasury', date: '2028-12-26' },
          { type: 'bond.coupon', summary: 'Coupon received on 20,000,000 FN-5.5-BX1234 (factor 0.9187321: current face 18,374,642): 84,217.11 USD', cash: { USD: 84_217.11 }, owner: 'treasury', date: '2028-12-26' },
          { type: 'accrual.coupon', summary: 'Interest accrued on FN-5.5-BX1234: 31,296.93 USD', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 10_325_264.09, unsettled: 0, availableToTrade: 10_325_264.09 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', qty: 15_000_000, accrued: 43_815.70 }],
        pending: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2029-01-25', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2054-10-26', status: 'pending' }],
        pnl: { book: { couponInterest: 101_300.84, total: 85_671.48 } },
        nav: { treasury: 24_085_671.48, book: 25_085_671.48 },
        balance: { book: { cash: 11_325_264.09, receivable: null, accruedIncome: 43_815.70, assets: 25_085_671.48, netAssets: 25_085_671.48 } },
      },
    },
    {
      // Sold for settlement on Friday 29 December, before the 31 December record date: the January coupon and paydown will go to
      // the buyer. 13,656,843 x 100.375 / 100 = 13,708,056.16; accrued 28 days 58,420.94 (14,605.24 more than the 43,815.70 on
      // the books); commission 342.70. Realized 13,708,056.16 - 13,725,127.21 = -17,071.05.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 15_000_000, estimate: 100.375, settleDate: '2028-12-29', notional: 13_656_843,
          gross: 13_708_056.16, accrued: 58_420.94, cash: 13_766_477.10, fees: 342.7 }] }, // 13,656,843 x 5.5% x 28/360 = 58,420.939; 0.25 bp = 342.701
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 15_000_000, avgPrice: 100.375 }] },
        events: [
          { type: 'strategy.legs_added', owner: 'treasury' },
          { type: 'trade.fill', summary: /^Sold 15,000,000 FN-5\.5-BX1234 @ 100\.375 USD \(realized [-−]17,071\.05 USD\)$/, owner: 'treasury' },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of FN-5.5-BX1234: 14,605.24 USD', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 10_325_264.09, unsettled: 13_766_134.40, availableToTrade: 24_091_398.49 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2028-12-29', amount: 13_766_134.40, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { book: { realized: -23_589, couponInterest: 115_906.08, commissions: -918.59, unrealized: 0, total: 91_398.49 } },
        nav: { treasury: 24_091_398.49, book: 25_091_398.49 },
        balance: { book: { cash: 11_325_264.09, receivable: 13_766_134.40, positions: null, accruedIncome: null, assets: 25_091_398.49, liabilities: 0, netAssets: 25_091_398.49 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EST('2028-12-29'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 13,766,134.40 USD into settled cash', cash: { USD: 13_766_134.40 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 24_091_398.49, unsettled: 0, availableToTrade: 24_091_398.49 } }, account: usdCash(1_000_000) },
        pending: [],
        balance: { book: { cash: 25_091_398.49, receivable: null, assets: 25_091_398.49, liabilities: 0 } },
      },
    },
    { id: 'treasury-screens-at-end', covers: 'close', action: 'owner_screens', owner: 'treasury', expect: {} },
  ],
};

// ---------------------------------------------------------------------------------------------
// non_agency_mbs
// ---------------------------------------------------------------------------------------------
// A private-label (non-agency) prime jumbo RMBS, subordinate Class B-1: 4.75% fixed, monthly 30/360, 24-day payment delay,
// no guarantee (losses on the loans reach the subordinate classes first), T+2 (the instrument's own convention), factor
// 0.6825513 for March 2029. Bought at a discount (92.50) by the Account.
//   - Bought on Tuesday 6 March, increased on Thursday 8 March (settling Monday 12 March); held over Good Friday (30 March,
//     bond and stock markets closed).
//   - The April remittance report (published Friday 6 April) is recorded by hand, effective 1 April: first the realized loss
//     allocated to the class, factor 0.6825513 to 0.6804313 (no payment: 4,500,000 x 0.00212 = 9,540 of principal written
//     off), then the paydown, 0.6804313 to 0.6741078 (0.6790421 after scheduled amortisation alone), paid on 25 April.
//   - A third is sold; the March coupon (on the March factor) and the April principal come on 25 April to the holder at the
//     record date; the rest is sold for settlement before the April record date.
// Commission: 0.5 basis point of clean principal. Days of 30/360 from 1 Mar: to 8 Mar 7, 9 Mar 8, 12 Mar 11, 29 Mar 28;
// from 1 Apr: to 5 Apr 4, 9 Apr 8, 10 Apr 9, 24 Apr 23, 27 Apr 26. A month's coupon is 4.75% / 12 of current face.
const nonAgencyMbs = {
  productId: 'non_agency_mbs',
  title: 'Harborview Prime Mortgage Trust 2024-2 Class B-1 (non-agency, subordinate): bought at a discount, increased, Good Friday, realized loss allocated by hand, paydown with prepayment split, partial sale, March coupon and April principal after the 24-day delay, close',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (original face)'],
    manualInputs: ['Registration: Pool factor, Payment delay 24, no Guarantor, Settlement convention 2', 'Realized loss allocated by hand (instrument form: Principal written down to, Kind of write-down: Realized loss allocated, Write-down effective from)', 'Paydown recorded by hand (New pool factor, Factor effective from, Principal paid on, Factor after scheduled principal)'],
    settlement: 'T+2 on the US bond calendar (the deal\'s own convention); current face = original face x factor; accrued 30/360 on current face',
    lifecycle: 'Monthly coupon on the factor of the month, paid after the 24-day delay; loss allocation writes the factor down with no payment and cancels the interest accrued on the principal written off; paydown principal receivable until the payment date',
    accounting: 'Cost per 100 of current face; the cost of principal written off is a realized loss; paydown at par against a discount cost is a realized gain; coupon and interest income; commission expensed',
    collateral: 'None for a long position',
  },
  start: EST('2029-03-06'), // Tuesday
  settlementCheck: { lag: 2, holidays: ['2029-03-30'] }, // Good Friday
  book: {
    name: 'Matrix non-agency MBS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 4_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'non_agency_mbs', name: 'Harborview Prime Mortgage Trust 2024-2 Class B-1 4.75%', symbol: 'HPMT-24-2-B1', marketView: 'US_CASH', venueType: 'otc', issuer: 'Harborview Prime Mortgage Trust 2024-2', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settleLag: 2 },
      terms: { couponType: 'fixed', couponRate: 0.0475, frequency: 12, maturity: '2054-06-01', issueDate: '2024-06-01', dayCount: '30/360', redemption: 100, factor: 0.6825513, paymentDelayDays: 24, seniority: 'Subordinate (Class B-1)' } },
  },
  quotes: { main: { bid: 92, ask: 92.5, last: 92.25, bidSize: 20_000_000, askSize: 20_000_000 } },
  expectAtStart: { ...startState(4_000_000, 1_000_000), cash: { account: usdCash(4_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 3_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 3_000_000, estimate: 92.5, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2029-03-08', calendar: 'USBOND',
            notional: 2_047_653.90, // current face: 3,000,000 x 0.6825513
            gross: 1_894_079.86, // 2,047,653.90 x 92.50 / 100 = 1,894,079.858
            accrued: 1_891.24, // 7 days: 2,047,653.90 x 4.75% x 7/360 = 1,891.2423
            cash: -1_895_971.10, fees: 94.7 }], // 0.5 bp of 1,894,079.86 = 94.704
          cash: { USD: { purchases: 1_895_971.10, fees: 94.7, required: 1_896_065.80, available: 4_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 3_000_000, avgPrice: 92.5, fills: [{ qty: 3_000_000, price: 92.5, model: 'quoted-bid-ask', settleDate: '2029-03-08', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 3,000,000 HPMT-24-2-B1 @ 92.50 USD', owner: 'account', date: '2029-03-06' }],
        cash: { account: { USD: { settled: 4_000_000, unsettled: -1_896_065.80, availableToTrade: 2_103_934.20 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 3_000_000, avgCost: 92.5, cost: 1_894_079.86, price: 92.25,
          value: 1_888_960.72, unrealized: -5_119.14, accrued: 1_891.24, priceSource: 'Test fixture' }], // 2,047,653.90 x 92.25 / 100 = 1,888,960.723
        holdings: { main: { long: 3_000_000, short: 0, net: 3_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2029-03-08', amount: -1_896_065.80, ccy: 'USD', into: 'cash' }],
        // First coupon 1 April (March's interest) + 24 days = Wednesday 25 April. Maturity 1 Jun 2054 + 24 = Thursday 25 June 2054.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2029-04-25', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2054-06-25', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -94.7, fees: 0, borrowFunding: 0, unrealized: -5_119.14, total: -5_213.84 } },
        nav: { account: 3_994_786.16, book: 4_994_786.16 },
        balance: { account: { cash: 4_000_000, accruedIncome: 1_891.24, positions: 1_888_960.72, payable: 1_896_065.80, assets: 5_890_851.96, liabilities: 1_896_065.80, netAssets: 3_994_786.16 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2029-03-08'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,896,065.80 USD from settled cash', cash: { USD: -1_896_065.80 }, date: '2029-03-08' }],
        cash: { account: { USD: { settled: 2_103_934.20, unsettled: 0, availableToTrade: 2_103_934.20 } } },
        pending: [],
        balance: { account: { cash: 2_103_934.20, payable: null, assets: 3_994_786.16, liabilities: 0 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5, // 3,000,000 -> 4,500,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 1_500_000, estimate: 92.5, settleDate: '2029-03-12', notional: 1_023_826.95,
          gross: 947_039.93, accrued: 1_485.97, cash: -948_525.90, fees: 47.35 }], // 1,023,826.95 x 92.50 / 100 = 947,039.929; 11 days: 1,485.966; 0.5 bp = 47.352
          cash: { USD: { purchases: 948_525.90, fees: 47.35, required: 948_573.25, available: 2_103_934.20, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1_500_000, avgPrice: 92.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 1,500,000 HPMT-24-2-B1 @ 92.50 USD' }],
        cash: { account: { USD: { settled: 2_103_934.20, unsettled: -948_573.25, availableToTrade: 1_155_360.95 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, cost: 2_841_119.79, avgCost: 92.5, price: 92.25, value: 2_833_441.08, unrealized: -7_678.71, accrued: 3_377.21 }], // 3,071,480.85 x 92.25 / 100
        holdings: { main: { long: 4_500_000, short: 0, net: 4_500_000 } },
        pending: [{ instrument: 'main', dueDate: '2029-03-12', amount: -948_573.25, into: 'cash' }],
        pnl: { account: { commissions: -142.05, unrealized: -7_678.71, total: -7_820.76 } },
        nav: { account: 3_992_179.24, book: 4_992_179.24 },
        balance: { account: { cash: 2_103_934.20, accruedIncome: 3_377.21, positions: 2_833_441.08, payable: 948_573.25, assets: 4_940_752.49, liabilities: 948_573.25, netAssets: 3_992_179.24 } },
      },
    },
    {
      // Monday 12 March. End of day Friday 9 Mar: 2,047,653.90 settled, 8 days, 2,161.4124, plus 1,023,826.95 to 12 Mar,
      // 1,485.9663: 3,647.38. On the books 3,377.21: 270.17 more.
      id: 'settle-increase', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2029-03-12'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 948,573.25 USD from settled cash', cash: { USD: -948_573.25 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on HPMT-24-2-B1: 270.17 USD' },
        ],
        cash: { account: { USD: { settled: 1_155_360.95, unsettled: 0, availableToTrade: 1_155_360.95 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, accrued: 3_647.38 }],
        pending: [],
        pnl: { account: { couponInterest: 270.17, total: -7_550.59 } },
        nav: { account: 3_992_449.41, book: 4_992_449.41 },
        balance: { account: { cash: 1_155_360.95, payable: null, accruedIncome: 3_647.38, assets: 3_992_449.41, liabilities: 0, netAssets: 3_992_449.41 } },
      },
    },
    {
      // Monday 2 April, after Good Friday. End of day Thursday 29 Mar: 3,071,480.85 x 4.75% x 28/360 = 11,347.42; 7,700.04 more.
      id: 'after-good-friday', covers: ['accrual', 'market holiday'], action: 'clock', to: EDT('2029-04-02'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on HPMT-24-2-B1: 7,700.04 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, accrued: 11_347.42 }],
        pnl: { account: { couponInterest: 7_970.21, total: 149.45 } },
        nav: { account: 4_000_149.45, book: 5_000_149.45 },
        balance: { account: { accruedIncome: 11_347.42, assets: 4_000_149.45, netAssets: 4_000_149.45 } },
      },
    },
    {
      // Friday 6 April. End of day 5 Apr: March's coupon (due 25 April) 3,071,480.85 x 4.75% / 12 = 12,157.9450, plus 4 days of
      // April on the March factor 1,621.0594: 13,779.0044, rounded once: 13,779.00. 2,431.58 more.
      id: 'remittance-day', covers: 'accrual', action: 'clock', to: EDT('2029-04-06'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on HPMT-24-2-B1: 2,431.58 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, accrued: 13_779 }],
        pnl: { account: { couponInterest: 10_401.79, total: 2_581.03 } },
        nav: { account: 4_002_581.03, book: 5_002_581.03 },
        balance: { account: { accruedIncome: 13_779, assets: 4_002_581.03, netAssets: 4_002_581.03 } },
      },
    },
    {
      // The realized loss allocated to Class B-1, recorded by hand from the remittance report: factor 0.6825513 to 0.6804313 from
      // 1 April. 4,500,000 x 0.00212 = 9,540 of principal written off, no payment. Cost out 2,841,119.79 x 0.00212 / 0.6825513
      // = 8,824.50: realized loss. April's 4 days of interest on the principal written off are cancelled: on 3,061,940.85 they
      // are 1,616.0244 instead of 1,621.0594; with March's coupon (on the March factor) 12,157.9450 the balance is 13,773.97,
      // 5.03 down.
      id: 'loss-allocated', covers: 'loss allocation (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'writedown', newFactor: 0.6804313, kind: 'loss', effective: '2029-04-01' },
      expect: {
        events: [
          { type: 'bond.loss', summary: 'Realized loss allocated by hand to HPMT-24-2-B1: factor 0.6825513 to 0.6804313 from 2029-04-01, 9,540 of principal written off with no payment (4,500,000 original face); cost 8,824.50 USD written off as realized loss', owner: 'account', date: '2029-04-06' },
          { type: 'accrual.coupon', summary: 'Accrued interest cancelled with the principal written off on HPMT-24-2-B1: 5.03 USD' },
        ],
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, cost: 2_832_295.29, avgCost: 92.5, price: 92.25, value: 2_824_640.43, unrealized: -7_654.86, accrued: 13_773.97 }], // 3,061,940.85 x 92.25 / 100 = 2,824,640.434
        pnl: { account: { realized: -8_824.50, couponInterest: 10_396.76, unrealized: -7_654.86, total: -6_224.65 } },
        nav: { account: 3_993_775.35, book: 4_993_775.35 },
        balance: { account: { accruedIncome: 13_773.97, positions: 2_824_640.43, assets: 3_993_775.35, netAssets: 3_993_775.35 } },
      },
    },
    {
      // The paydown, also from 1 April: 0.6804313 to 0.6741078, principal 4,500,000 x 0.0063235 = 28,455.75 receivable on 25 April.
      // Scheduled 0.0013892 of original face (0.6804313 - 0.6790421), prepaid 0.0049343 (SMM 0.0049343 / 0.6790421 = 0.7267%).
      // Cost out 2,832,295.29 x 0.0063235 / 0.6804313 = 26,321.57: realized +2,134.18 (principal returned at par, bought at 92.50).
      // April's 4 days on 3,033,485.10: 1,601.0060 instead of 1,616.0244; with March's coupon 12,157.9450 the balance is
      // 13,758.9511 -> 13,758.95, 15.02 down.
      id: 'factor-and-paydown', covers: ['paydown (by hand)', 'prepayment (by hand)'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'paydown', newFactor: 0.6741078, effective: '2029-04-01', payDate: '2029-04-25', scheduledFactor: 0.6790421 },
      expect: {
        events: [
          { type: 'bond.paydown', summary: 'Principal paydown on HPMT-24-2-B1: factor 0.6804313 to 0.6741078 from 2029-04-01; scheduled principal 0.0013892, prepaid 0.0049343 of original face (SMM 0.7267%), 28,455.75 USD receivable on 2029-04-25', owner: 'account', date: '2029-04-06' },
          { type: 'accrual.coupon', summary: 'Accrued interest restated on the new factor of HPMT-24-2-B1, down: 15.02 USD' },
        ],
        cash: { account: { USD: { settled: 1_155_360.95, unsettled: 28_455.75, availableToTrade: 1_183_816.70 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, cost: 2_805_973.72, avgCost: 92.5, price: 92.25, value: 2_798_390, unrealized: -7_583.72, accrued: 13_758.95 }], // 3,033,485.10 x 92.25 / 100 = 2,798,390.005
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2029-04-25', amount: 28_455.75, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -6_690.32, couponInterest: 10_381.74, unrealized: -7_583.72, total: -4_034.35 } },
        nav: { account: 3_995_965.65, book: 4_995_965.65 },
        balance: { account: { receivable: 28_455.75, accruedIncome: 13_758.95, positions: 2_798_390, assets: 3_995_965.65, netAssets: 3_995_965.65 } },
      },
    },
    {
      // A third sold: current face 1,500,000 x 0.6741078 = 1,011,161.70 at 92.00 = 930,268.76; accrued 9 days to Tuesday 10 April,
      // 1,200.75. Cost out 2,805,973.72 / 3 = 935,324.57: realized -5,055.81.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 1_500_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_500_000, estimate: 92, settleDate: '2029-04-10', notional: 1_011_161.70,
          gross: 930_268.76, accrued: 1_200.75, cash: 931_469.51, fees: 46.51 }] }, // 1,011,161.70 x 4.75% x 9/360 = 1,200.754; 0.5 bp = 46.513
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1_500_000, avgPrice: 92 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 1,500,000 HPMT-24-2-B1 @ 92\.00 USD \(realized [-−]5,055\.81 USD\)$/ }],
        cash: { account: { USD: { settled: 1_155_360.95, unsettled: 959_878.75, availableToTrade: 2_115_239.70 } } }, // 28,455.75 + 931,423.00
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_000_000, cost: 1_870_649.15, avgCost: 92.5, price: 92.25, value: 1_865_593.34, unrealized: -5_055.81, accrued: 12_558.20 }],
        holdings: { main: { long: 3_000_000, short: 0, net: 3_000_000 } },
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2029-04-25', status: 'pending' }, { type: 'bond.coupon', instrument: 'main', dueDate: '2029-05-25', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2054-06-25', status: 'pending' }],
        pending: [
          { instrument: 'main', owner: 'account', dueDate: '2029-04-10', amount: 931_423, ccy: 'USD', into: 'cash' },
          { instrument: 'main', owner: 'account', dueDate: '2029-04-25', amount: 28_455.75, ccy: 'USD', into: 'cash' },
        ],
        pnl: { account: { realized: -11_746.13, commissions: -188.56, unrealized: -5_055.81, total: -6_608.76 } },
        nav: { account: 3_993_391.24, book: 4_993_391.24 },
        balance: { account: { receivable: 959_878.75, accruedIncome: 12_558.20, positions: 1_865_593.34, assets: 3_993_391.24, netAssets: 3_993_391.24 } },
      },
    },
    {
      // Tuesday 10 April. End of day 9 Apr: March's coupon on the 4,500,000 held at the record date 12,157.95, plus 8 days of April
      // on 3,033,485.10 (the sale settles today) 3,202.0121, less the 9 days sold 1,200.7545: 14,159.2026 -> 14,159.20. 1,601.00 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2029-04-10'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 931,423.00 USD into settled cash', cash: { USD: 931_423 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on HPMT-24-2-B1: 1,601.00 USD' },
        ],
        cash: { account: { USD: { settled: 2_086_783.95, unsettled: 28_455.75, availableToTrade: 2_115_239.70 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_000_000, accrued: 14_159.20 }],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2029-04-25', amount: 28_455.75, ccy: 'USD', into: 'cash' }],
        pnl: { account: { couponInterest: 11_982.74, total: -5_007.76 } },
        nav: { account: 3_994_992.24, book: 4_994_992.24 },
        balance: { account: { cash: 2_086_783.95, receivable: 28_455.75, accruedIncome: 14_159.20, assets: 3_994_992.24, netAssets: 3_994_992.24 } },
      },
    },
    {
      // Wednesday 25 April: the April principal 28,455.75 arrives, and March's coupon on the 4,500,000 held at the March record date
      // on the March factor: 12,157.9450 paid as 12,157.95. After it the balance is 14,159.20 - 12,157.95 = 2,001.25, against
      // April's interest to 9 Apr worked whole, 3,202.0121 - 1,200.7545 = 2,001.2576 -> 2,001.26: the cent the coupon was rounded
      // up by comes back as income (0.01). End of day 24 Apr: 2,022,323.40 x 4.75% x 23/360 = 6,137.19; 4,135.93 more.
      id: 'coupon-and-principal', covers: ['coupon', 'paydown (by hand)', 'settlement'], action: 'clock', to: EDT('2029-04-25'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 28,455.75 USD into settled cash', cash: { USD: 28_455.75 }, date: '2029-04-25' },
          { type: 'bond.coupon', summary: 'Coupon received on 4,500,000 HPMT-24-2-B1 (factor 0.6825513: current face 3,071,480.85): 12,157.95 USD', cash: { USD: 12_157.95 }, owner: 'account', date: '2029-04-25' },
          { type: 'accrual.coupon', summary: 'Interest accrued on HPMT-24-2-B1: 0.01 USD' },
          { type: 'accrual.coupon', summary: 'Interest accrued on HPMT-24-2-B1: 4,135.93 USD' },
        ],
        cash: { account: { USD: { settled: 2_127_397.65, unsettled: 0, availableToTrade: 2_127_397.65 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_000_000, accrued: 6_137.19 }],
        pending: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2029-05-25', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2054-06-25', status: 'pending' }],
        pnl: { account: { couponInterest: 16_118.68, total: -871.82 } },
        nav: { account: 3_999_128.18, book: 4_999_128.18 },
        balance: { account: { cash: 2_127_397.65, receivable: null, accruedIncome: 6_137.19, assets: 3_999_128.18, netAssets: 3_999_128.18 } },
      },
    },
    {
      // The rest sold for settlement on Friday 27 April, before the April record date. 2,022,323.40 x 92.00 / 100 = 1,860,537.53;
      // accrued 26 days 6,937.69 (800.50 more than on the books); realized 1,860,537.53 - 1,870,649.15 = -10,111.62.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 3_000_000, estimate: 92, settleDate: '2029-04-27', notional: 2_022_323.40,
          gross: 1_860_537.53, accrued: 6_937.69, cash: 1_867_475.22, fees: 93.03 }] }, // 2,022,323.40 x 4.75% x 26/360 = 6,937.688; 0.5 bp = 93.027
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 3_000_000, avgPrice: 92 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 3,000,000 HPMT-24-2-B1 @ 92\.00 USD \(realized [-−]10,111\.62 USD\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of HPMT-24-2-B1: 800.50 USD' },
        ],
        cash: { account: { USD: { settled: 2_127_397.65, unsettled: 1_867_382.19, availableToTrade: 3_994_779.84 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2029-04-27', amount: 1_867_382.19, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -21_857.75, couponInterest: 16_919.18, commissions: -281.59, unrealized: 0, total: -5_220.16 } },
        nav: { account: 3_994_779.84, book: 4_994_779.84 },
        balance: { account: { cash: 2_127_397.65, receivable: 1_867_382.19, positions: null, accruedIncome: null, assets: 3_994_779.84, liabilities: 0, netAssets: 3_994_779.84 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2029-04-27'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,867,382.19 USD into settled cash', cash: { USD: 1_867_382.19 } }],
        cash: { account: { USD: { settled: 3_994_779.84, unsettled: 0, availableToTrade: 3_994_779.84 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 3_994_779.84, receivable: null, assets: 3_994_779.84, liabilities: 0 } },
      },
    },
  ],
};

export default [tips, foreignInflationLinked, callableBond, puttableBond, convertibleBond, exchangeableBond, cocoBond, agencyMbs, nonAgencyMbs];
