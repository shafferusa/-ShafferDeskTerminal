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
const EDT = (d) => `${d}T14:00:00.000Z`; // eslint-disable-line no-unused-vars

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
      // Monday 28 December, after the holiday. End of day 24 Dec: 900,000 x 1.00910 x 0.1875% x 162/184 = 1,499.2539 on the
      // face settled, the sale settling later; plus nothing for the sale (its interest to 28 Dec is already off the books).
      // On the books 1,459.15: 40.10 more.
      id: 'settle-after-christmas', covers: ['settlement', 'market holiday'], action: 'clock', to: EST('2026-12-28'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 607,059.34 USD into settled cash', cash: { USD: 607_059.34 }, date: '2026-12-28' },
          { type: 'accrual.coupon', summary: 'Interest accrued on TII-0.375-JAN27: 40.10 USD' },
        ],
        cash: { account: { USD: { settled: 1_097_378.30, unsettled: 0, availableToTrade: 1_097_378.30 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 900_000, accrued: 1_499.25 }],
        pending: [],
        pnl: { account: { couponInterest: 3_263, total: 8_117.64 } },
        nav: { account: 2_008_117.64, book: 3_008_117.64 },
        balance: { account: { cash: 1_097_378.30, receivable: null, accruedIncome: 1_499.25, assets: 2_008_117.64, netAssets: 2_008_117.64 } },
      },
    },
    {
      id: 'ratio-zero-refused', covers: 'index ratio (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'index_ratio', ratio: 0 },
      status: 'blocked', reason: 'An index ratio of zero is not a ratio of two index levels.',
      expect: { refused: 'Enter the index ratio as a positive number' },
    },
    {
      // Tuesday 12 January 2027. End of day 11 Jan: 900,000 x 1.00910 x 0.1875% x 180/184 = 1,665.8376; 166.59 more.
      id: 'january', covers: 'accrual', action: 'clock', to: EST('2027-01-12'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on TII-0.375-JAN27: 166.59 USD' }],
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

export default [tips];
