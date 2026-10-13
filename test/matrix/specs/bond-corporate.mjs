// Bond family (engine family "bond"), corporate and money-market group: 13 catalog products, one
// scenario each, on a fictional instrument registered as exactly that product with the terms a real
// instrument of that product has (day count, coupon frequency, currency, settlement lag and calendar,
// minimum denomination, seniority).
//
// Every expected number is a literal worked out by hand from the inputs stated in the same spec.
// The arithmetic is in the comment beside it. Nothing here is copied from what the Terminal prints.
//
// The rules these scenarios rely on (the Terminal's documented rules for debt securities, the same as
// in bond-government.mjs, restated so the arithmetic can be followed):
//   - Quantity is face amount. A price is the clean price in percent of par. A market buy fills at
//     the ask, a market sell at the bid, of the quote in force.
//   - A trade settles principal (face x price / 100) plus the accrued interest to its SETTLEMENT
//     date, each rounded to the cent. Commission comes from the Book's fee schedule on the clean
//     principal and is expensed (it is not added to cost).
//   - Accrued interest per day count:
//       30/360 (US)    face x coupon x days30 / 360: every month 30 days; a 31st start is the 30th, and a
//                      31st end is the 30th when the start is the 30th or 31st
//       30E/360        the same, except that every 31st (start or end) counts as the 30th
//       ACT/ACT (ICMA) face x coupon / frequency x days since the last coupon date / days in the period
//       ACT/360        face x rate x actual days / 360 (a floating coupon, and its whole coupon too)
//     A zero-coupon or discount instrument has none.
//   - A fixed coupon is the annual rate divided by the number of coupons a year, whatever the day count.
//   - The position is carried at clean cost with average cost, valued clean at the last price.
//     Accrued interest is a separate asset ("Accrued income"); its growth is coupon and interest
//     income, never realized or unrealized P&L. Selling part removes cost at the average.
//   - At the end of each business day D (17:00 New York, NYSE days) the accrued balance is trued up to:
//     interest to D on the face settled by D, plus the interest bought (less the interest sold) in trades
//     that settle after D, which runs to their settlement dates. The change is income. The end-of-day run
//     happens once per clock move, for the latest day that has ended, after settlements and lifecycle work.
//   - A coupon is paid on its coupon date, moved to the next business day of the payment calendar, to the
//     face settled before the coupon date. Redemption is paid the same way at maturity.
//   - A fill books the position on trade date and leaves a payable or receivable; cash moves on the
//     settlement date.
//   - A discount instrument (commercial paper, ABCP, a bankers' acceptance, a zero) has no coupon: the
//     discount earned is price gain, unrealized while held and realized at sale or redemption. The Terminal
//     does not accrete it into interest income, and it has no discount-rate or yield quotation: every quote
//     below given as a rate is converted by hand to a price in % of par, with the formula in the comment.
//
// Clock: scenario instants are 10:00 New York unless a step says otherwise.

export const family = 'bond';

/** 10:00 in New York on a date in Eastern Standard Time (UTC-5): November to early March. */
const EST = (d) => `${d}T15:00:00.000Z`;
/** 10:00 in New York on a date in Eastern Daylight Time (UTC-4): mid-March to the end of October. */
const EDT = (d) => `${d}T14:00:00.000Z`;
const EST_1730 = (d) => `${d}T22:30:00.000Z`; // 17:30 New York in standard time, after the 17:00 end-of-day cutoff
const EDT_1730 = (d) => `${d}T21:30:00.000Z`; // 17:30 New York in daylight time

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
// corporate_bond_ig
// ---------------------------------------------------------------------------------------------
// An investment-grade US industrial's senior unsecured notes: 4.85%, coupons 18 January and 18 July,
// 30/360 (US), T+1 on the US bond calendar, pieces of 1,000. The 18 January 2027 coupon date is Martin
// Luther King Jr. Day (bond and stock markets and the Federal Reserve closed): the coupon is paid on
// Tuesday 19 January, and on 30/360 the day of waiting earns nothing.
//
// The Account buys 800,000, adds 200,000 at a higher price (average cost 98.85), sells 400,000 before the
// coupon (cost removed at the average), takes the coupon on the 600,000 left across the holiday, and sells
// the rest after it.
//
// Days of 30/360 from 18 July 2026: to 13 Jan 2027 175, to 14 Jan 176, to 15 Jan 177, to 18 Jan 180.
// One 30/360 day at 4.85%: 107.7778 on 800,000, 80.8333 on 600,000. A full coupon is 2.425 per 100.
// Commission: 0.75 basis point of clean principal.
const corporateBondIg = {
  productId: 'corporate_bond_ig',
  title: 'Marlow Industries 4.85% senior notes due 18 January 2034 (investment grade): two purchases at average cost, a partial sale, a coupon on a market holiday, closed',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    manualInputs: ['none: coupon schedule, 30/360 accrued interest and settlement follow from the registered terms'],
    settlement: 'T+1 on the US bond calendar (Book setting settlement.bond = 1); a coupon date on Martin Luther King Jr. Day is paid the next business day',
    lifecycle: 'Daily accrual on 30/360 (US); semi-annual coupon to the face settled before the coupon date, paid on the next payment day after a holiday; next coupon and maturity scheduled',
    accounting: 'Clean cost at average across two purchases; cost removed at the average on the sale; accrued interest bought and sold through Accrued income; coupon income separate from realized and unrealized P&L; commission expensed',
    collateral: 'None for a long position',
  },
  start: EST('2027-01-12'), // Tuesday
  settlementCheck: { lag: 1, holidays: ['2027-01-18'] }, // Martin Luther King Jr. Day
  book: {
    name: 'Matrix investment-grade bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.75 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'corporate_bond_ig', name: 'Marlow Industries Inc 4.85% Senior Notes 18-Jan-2034', symbol: 'MARLOW-4.85-JAN34', marketView: 'US_CASH', venueType: 'otc', issuer: 'Marlow Industries Inc', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.0485, frequency: 2, maturity: '2034-01-18', issueDate: '2024-01-18', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured' } },
  },
  quotes: { main: { bid: 98.6, ask: 98.75, last: 98.675, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(2_000_000, 1_000_000), cash: { account: usdCash(2_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'odd-denomination', covers: 'minimum denomination', action: 'ticket', instrument: 'main', side: 'buy', qty: 800_500,
      status: 'blocked', reason: 'The notes trade in pieces of 1,000 face; 800,500 is not a multiple of 1,000.',
      expect: { refused: 'quantity must be a multiple of 1000' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 800_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 800_000, estimate: 98.75, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-01-13', calendar: 'USBOND',
            gross: 790_000, // 800,000 x 98.75 / 100
            accrued: 18_861.11, // settles 13 Jan, 175 days of 30/360: 800,000 x 4.85% x 175/360 = 18,861.111
            cash: -808_861.11, // 790,000 + 18,861.11
            fees: 59.25 }], // 0.75 bp of 790,000
          cash: { USD: { purchases: 808_861.11, fees: 59.25, required: 808_920.36, available: 2_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 800_000, avgPrice: 98.75, fills: [{ qty: 800_000, price: 98.75, model: 'quoted-bid-ask', settleDate: '2027-01-13', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 800,000 MARLOW-4.85-JAN34 @ 98.75 USD', owner: 'account', date: '2027-01-12' }],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -808_920.36, availableToTrade: 1_191_079.64 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 800_000, avgCost: 98.75, cost: 790_000, price: 98.675,
          value: 789_400, // 800,000 x 98.675 / 100, clean
          unrealized: -600, accrued: 18_861.11, priceSource: 'Test fixture' }],
        holdings: { main: { long: 800_000, short: 0, net: 800_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-01-13', amount: -808_920.36, ccy: 'USD', into: 'cash' }],
        // 18 Jan 2027 is Martin Luther King Jr. Day: the coupon is due Tuesday 19 Jan. 18 Jan 2034 is a Wednesday.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-01-19', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-01-18', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -59.25, fees: 0, borrowFunding: 0, unrealized: -600, total: -659.25 } },
        nav: { account: 1_999_340.75, book: 2_999_340.75 }, // 2,000,000 - 59.25 - 600
        balance: { account: { cash: 2_000_000, accruedIncome: 18_861.11, positions: 789_400, payable: 808_920.36, assets: 2_808_261.11, liabilities: 808_920.36, netAssets: 1_999_340.75 } },
      },
    },
    {
      // End of day 12 Jan: nothing has settled; the interest bought runs to 13 Jan and is already on the books. No income.
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2027-01-13'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 808,920.36 USD from settled cash', cash: { USD: -808_920.36 }, date: '2027-01-13' }],
        cash: { account: { USD: { settled: 1_191_079.64, unsettled: 0, availableToTrade: 1_191_079.64 } } },
        pending: [],
        balance: { account: { cash: 1_191_079.64, payable: null, assets: 1_999_340.75, liabilities: 0 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 99.1, ask: 99.25, last: 99.175, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 800_000, price: 99.175, value: 793_400, unrealized: 3_400 }], // 800,000 x 99.175% - 790,000
        pnl: { account: { unrealized: 3_400, total: 3_340.75 } },
        nav: { account: 2_003_340.75, book: 3_003_340.75 },
        balance: { account: { positions: 793_400, assets: 2_003_340.75, netAssets: 2_003_340.75 } },
      },
    },
    {
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.25, // 800,000 -> 1,000,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 200_000, estimate: 99.25, settleDate: '2027-01-14', calendar: 'USBOND',
          gross: 198_500, // 200,000 x 99.25 / 100
          accrued: 4_742.22, // settles 14 Jan, 176 days: 200,000 x 4.85% x 176/360 = 4,742.222
          cash: -203_242.22, fees: 14.89 }], // 0.75 bp of 198,500 = 14.8875
          cash: { USD: { purchases: 203_242.22, fees: 14.89, required: 203_257.11, available: 1_191_079.64, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 200_000, avgPrice: 99.25, fills: [{ qty: 200_000, price: 99.25, settleDate: '2027-01-14' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 200,000 MARLOW-4.85-JAN34 @ 99.25 USD' }],
        cash: { account: { USD: { settled: 1_191_079.64, unsettled: -203_257.11, availableToTrade: 987_822.53 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000,
          cost: 988_500, // 790,000 + 198,500
          avgCost: 98.85, // 988,500 / 1,000,000 x 100
          price: 99.175, value: 991_750, // 1,000,000 x 99.175 / 100
          unrealized: 3_250, accrued: 23_603.33 }], // 18,861.11 + 4,742.22
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-01-14', amount: -203_257.11, into: 'cash' }],
        pnl: { account: { commissions: -74.14, unrealized: 3_250, total: 3_175.86 } }, // 59.25 + 14.89
        nav: { account: 2_003_175.86, book: 3_003_175.86 },
        balance: { account: { cash: 1_191_079.64, accruedIncome: 23_603.33, positions: 991_750, payable: 203_257.11, assets: 2_206_432.97, liabilities: 203_257.11, netAssets: 2_003_175.86 } },
      },
    },
    {
      // End of day 13 Jan: 800,000 settled, to 13 Jan 18,861.1111; 200,000 unsettled, to 14 Jan 4,742.2222; total 23,603.33,
      // which is on the books: no income.
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: EST('2027-01-14'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 203,257.11 USD from settled cash', cash: { USD: -203_257.11 } }],
        cash: { account: { USD: { settled: 987_822.53, unsettled: 0, availableToTrade: 987_822.53 } } },
        pending: [],
        balance: { account: { cash: 987_822.53, payable: null, assets: 2_003_175.86, liabilities: 0 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 400_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 400_000, estimate: 99.1, settleDate: '2027-01-15',
          gross: 396_400, // 400,000 x 99.10 / 100
          accrued: 9_538.33, // settles 15 Jan, 177 days: 400,000 x 4.85% x 177/360 = 9,538.333
          cash: 405_938.33, fees: 29.73 }] }, // 0.75 bp of 396,400
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 400_000, avgPrice: 99.1 }] },
        // Cost removed at the average: 400,000 x 98.85% = 395,400. Realized 396,400 - 395,400 = 1,000.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 400,000 MARLOW-4.85-JAN34 @ 99.10 USD (realized 1,000.00 USD)' }],
        cash: { account: { USD: { settled: 987_822.53, unsettled: 405_908.60, availableToTrade: 1_393_731.13 } } }, // 405,938.33 - 29.73
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, cost: 593_100, avgCost: 98.85, price: 99.175,
          value: 595_050, // 600,000 x 99.175 / 100
          unrealized: 1_950, accrued: 14_065 }], // 23,603.33 - 9,538.33
        holdings: { main: { long: 600_000, short: 0, net: 600_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-01-15', amount: 405_908.60, into: 'cash' }],
        pnl: { account: { realized: 1_000, commissions: -103.87, unrealized: 1_950, total: 2_846.13 } }, // 74.14 + 29.73
        nav: { account: 2_002_846.13, book: 3_002_846.13 },
        balance: { account: { cash: 987_822.53, receivable: 405_908.60, accruedIncome: 14_065, positions: 595_050, assets: 2_002_846.13, liabilities: 0, netAssets: 2_002_846.13 } },
      },
    },
    {
      // Tuesday 19 January, after the long weekend. In order: the sale settles (due Friday 15 Jan); the coupon of 18 Jan is paid
      // on the 600,000 settled before it: 600,000 x 2.425% = 14,550.00. Accrued on the books 14,065.00 (800,000 x 175 + 200,000 x 176
      // - 400,000 x 177 thirty-day days at 4.85%/360); the coupon exceeds it by 485.00 (600,000 x 180 days = 14,550). The balance then
      // stands at the coupon date, zero, and the end-of-day run of Friday 15 Jan, older than that, does nothing.
      id: 'coupon', covers: ['coupon', 'market holiday', 'settlement'], action: 'clock', to: EST('2027-01-19'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 405,908.60 USD into settled cash', cash: { USD: 405_908.60 } },
          { type: 'bond.coupon', summary: 'Coupon received on 600,000 MARLOW-4.85-JAN34: 14,550.00 USD', cash: { USD: 14_550 }, owner: 'account', date: '2027-01-19' },
          { type: 'accrual.coupon', summary: 'Interest accrued on MARLOW-4.85-JAN34: 485.00 USD' },
        ],
        cash: { account: { USD: { settled: 1_408_281.13, unsettled: 0, availableToTrade: 1_408_281.13 } } }, // 987,822.53 + 405,908.60 + 14,550
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, accrued: 0 }],
        pending: [],
        // 18 Jul 2027 is a Sunday: due Monday 19 July.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-07-19', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-01-18', status: 'pending' }],
        pnl: { account: { couponInterest: 485, total: 3_331.13 } },
        nav: { account: 2_003_331.13, book: 3_003_331.13 }, // 1,408,281.13 + 595,050
        balance: { account: { cash: 1_408_281.13, receivable: null, accruedIncome: null, assets: 2_003_331.13, netAssets: 2_003_331.13 } },
      },
    },
    {
      // End of day 19 Jan: one 30/360 day on 600,000 = 80.8333.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EST('2027-01-20'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on MARLOW-4.85-JAN34: 80.83 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, accrued: 80.83 }],
        pnl: { account: { couponInterest: 565.83, total: 3_411.96 } },
        nav: { account: 2_003_411.96, book: 3_003_411.96 },
        balance: { account: { accruedIncome: 80.83, assets: 2_003_411.96, netAssets: 2_003_411.96 } },
      },
    },
    {
      id: 'quote-down', action: 'quote', instrument: 'main', quote: { bid: 98.2, ask: 98.35, last: 98.275, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, price: 98.275, value: 589_650, unrealized: -3_450 }], // 600,000 x 98.275% - 593,100
        pnl: { account: { unrealized: -3_450, total: -1_988.04 } }, // 1,000 + 565.83 - 103.87 - 3,450
        nav: { account: 1_998_011.96, book: 2_998_011.96 },
        balance: { account: { positions: 589_650, assets: 1_998_011.96, netAssets: 1_998_011.96 } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 600_000, estimate: 98.2, settleDate: '2027-01-21',
          gross: 589_200, // 600,000 x 98.20 / 100
          accrued: 242.50, // settles 21 Jan, 3 days of 30/360 into the new period: 600,000 x 4.85% x 3/360
          cash: 589_442.50, fees: 44.19 }] }, // 0.75 bp of 589,200
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 600_000, avgPrice: 98.2 }] },
        // Realized 589,200 - 593,100 = -3,900. Interest sold 242.50 against 80.83 on the books: 161.67 more income (two days on 600,000).
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 600,000 MARLOW-4\.85-JAN34 @ 98\.20 USD \(realized [-−]3,900\.00 USD\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of MARLOW-4.85-JAN34: 161.67 USD' },
        ],
        cash: { account: { USD: { settled: 1_408_281.13, unsettled: 589_398.31, availableToTrade: 1_997_679.44 } } }, // 589,442.50 - 44.19
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2027-01-21', amount: 589_398.31, into: 'cash' }],
        lifecycle: [],
        // Interest in all: 14,550 coupon + 9,538.33 + 242.50 sold - 18,861.11 - 4,742.22 bought = 727.50.
        pnl: { account: { realized: -2_900, couponInterest: 727.50, commissions: -148.06, unrealized: 0, total: -2_320.56 } }, // 1,000 - 3,900; 103.87 + 44.19
        nav: { account: 1_997_679.44, book: 2_997_679.44 },
        balance: { account: { cash: 1_408_281.13, receivable: 589_398.31, positions: null, accruedIncome: null, assets: 1_997_679.44, liabilities: 0, netAssets: 1_997_679.44 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EST('2027-01-21'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 589,398.31 USD into settled cash', cash: { USD: 589_398.31 } }],
        cash: { account: { USD: { settled: 1_997_679.44, unsettled: 0, availableToTrade: 1_997_679.44 } }, treasury: { USD: { settled: 1_000_000 } } },
        pending: [],
        balance: { account: { cash: 1_997_679.44, receivable: null, assets: 1_997_679.44, liabilities: 0, netAssets: 1_997_679.44 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// high_yield_bond
// ---------------------------------------------------------------------------------------------
// A high-yield issuer's senior notes: 8.50%, coupons 1 June and 1 December, 30/360 (US), T+1 on the US
// bond calendar, pieces of 1,000 (a real high-yield bond usually has a 2,000 minimum and 1,000 steps after
// it; the Terminal has one quantity step, so 1,000 is registered). The catalog says defaults and
// restructurings are recorded by hand, and this scenario does both through the interface:
//   - The Account buys 500,000 at 72 (already distressed) with 168 days of accrued interest.
//   - The issuer announces that it will not pay the 1 June coupon. The user records it on the instrument
//     (Edit, "Lifecycle events recorded by hand", coupon suspension). The holding goes on non-accrual: the
//     interest accrued and not received, 19,951.39, is reversed out of coupon and interest income (the
//     19,833.33 paid to the seller at purchase is lost with it); no interest accrues from then on.
//   - 1 June passes, after Memorial Day: nothing is paid, and the history says so.
//   - 200,000 is sold at 38, flat: a bond whose coupons are suspended trades without accrued interest.
//   - The restructuring cancels the notes for a cash distribution of 35% of par: recorded by hand as an early
//     redemption of the remaining 300,000 at 35 from the position's Lifecycle menu, paid the same day.
// Commission: 2 basis points of clean principal (none on the redemption).
const highYieldBond = {
  productId: 'high_yield_bond',
  title: 'Corvane Holdings 8.50% senior notes due 1 June 2031 (high yield): bought distressed, coupon suspended on default, a missed coupon, a flat sale, a cash restructuring',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    manualInputs: ['Default: coupon suspension recorded on the instrument (Edit, Lifecycle events recorded by hand, Review coupon suspension, Suspend coupons)', 'Restructuring: early redemption at the cash distribution price, face and label, recorded on the position (Lifecycle, Early redemption)'],
    settlement: 'T+1 on the US bond calendar; a sale of the defaulted bond settles flat (no accrued interest); the restructuring distribution is paid on the day it is recorded',
    lifecycle: 'Daily accrual on 30/360 until the coupon suspension; on suspension, accrued interest reversed (non-accrual); a coupon date passing while suspended is listed as not paid; restructuring by hand closes the position',
    accounting: 'Clean cost at average; accrued interest reversed out of coupon and interest income on suspension; realized losses on the flat sale and on the restructuring distribution; commission expensed',
    collateral: 'None for a long position',
  },
  start: EDT('2027-05-18'), // Tuesday
  settlementCheck: { lag: 1, holidays: ['2027-05-31'] }, // Memorial Day
  book: {
    name: 'Matrix high-yield bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 2 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'high_yield_bond', name: 'Corvane Holdings Inc 8.50% Senior Notes 1-Jun-2031', symbol: 'CORVANE-8.5-JUN31', marketView: 'US_CASH', venueType: 'otc', issuer: 'Corvane Holdings Inc', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.085, frequency: 2, maturity: '2031-06-01', issueDate: '2023-06-01', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured' } },
  },
  quotes: { main: { bid: 71, ask: 72, last: 71.5, bidSize: 5_000_000, askSize: 5_000_000 } },
  expectAtStart: { ...startState(1_000_000, 1_000_000), cash: { account: usdCash(1_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 500_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 500_000, estimate: 72, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-05-19', calendar: 'USBOND',
            gross: 360_000, // 500,000 x 72 / 100
            accrued: 19_833.33, // settles 19 May, 168 days of 30/360 from 1 Dec: 500,000 x 8.5% x 168/360 = 19,833.333
            cash: -379_833.33, fees: 72 }], // 2 bp of 360,000
          cash: { USD: { purchases: 379_833.33, fees: 72, required: 379_905.33, available: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 500_000, avgPrice: 72, fills: [{ qty: 500_000, price: 72, model: 'quoted-bid-ask', settleDate: '2027-05-19', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 500,000 CORVANE-8.5-JUN31 @ 72.00 USD', owner: 'account', date: '2027-05-18' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -379_905.33, availableToTrade: 620_094.67 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 500_000, avgCost: 72, cost: 360_000, price: 71.5,
          value: 357_500, unrealized: -2_500, accrued: 19_833.33, priceSource: 'Test fixture' }], // 500,000 x 71.5%
        holdings: { main: { long: 500_000, short: 0, net: 500_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-05-19', amount: -379_905.33, ccy: 'USD', into: 'cash' }],
        // 1 Jun 2027 is a Tuesday; 1 Jun 2031 is a Sunday, so redemption is due Monday 2 June 2031.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-06-01', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2031-06-02', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -72, fees: 0, borrowFunding: 0, unrealized: -2_500, total: -2_572 } },
        nav: { account: 997_428, book: 1_997_428 },
        balance: { account: { cash: 1_000_000, accruedIncome: 19_833.33, positions: 357_500, payable: 379_905.33, assets: 1_377_333.33, liabilities: 379_905.33, netAssets: 997_428 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2027-05-19'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 379,905.33 USD from settled cash', cash: { USD: -379_905.33 }, date: '2027-05-19' }],
        cash: { account: { USD: { settled: 620_094.67, unsettled: 0, availableToTrade: 620_094.67 } } },
        pending: [],
        balance: { account: { cash: 620_094.67, payable: null, assets: 997_428, liabilities: 0 } },
      },
    },
    {
      // End of day Thursday 20 May: 169 days on 500,000: 42,500 x 169/360 = 19,951.3889. Income 118.06.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EDT('2027-05-21'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on CORVANE-8.5-JUN31: 118.06 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 500_000, accrued: 19_951.39 }],
        pnl: { account: { couponInterest: 118.06, total: -2_453.94 } },
        nav: { account: 997_546.06, book: 1_997_546.06 },
        balance: { account: { accruedIncome: 19_951.39, assets: 997_546.06, netAssets: 997_546.06 } },
      },
    },
    {
      // The issuer says it will not pay the 1 June coupon: the price falls.
      id: 'quote-distress', action: 'quote', instrument: 'main', quote: { bid: 54, ask: 56, last: 55, bidSize: 5_000_000, askSize: 5_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 500_000, price: 55, value: 275_000, unrealized: -85_000 }], // 500,000 x 55% - 360,000
        pnl: { account: { unrealized: -85_000, total: -84_953.94 } }, // 118.06 - 72 - 85,000
        nav: { account: 915_046.06, book: 1_915_046.06 },
        balance: { account: { positions: 275_000, assets: 915_046.06, netAssets: 915_046.06 } },
      },
    },
    {
      // Recorded by hand on the instrument. The accrued balance of 19,951.39 will not be paid: it is reversed out of coupon and
      // interest income at once. Interest income to date: 118.06 - 19,951.39 = -19,833.33, the accrued interest bought.
      id: 'default-suspend-coupons', covers: 'default (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'suspend_coupon', suspended: true },
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Accrued interest reversed on CORVANE-8.5-JUN31: coupons suspended, not accrued or paid: 19,951.39 USD', owner: 'account', date: '2027-05-21' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 500_000, accrued: 0 }],
        pnl: { account: { couponInterest: -19_833.33, total: -104_905.33 } },
        nav: { account: 895_094.67, book: 1_895_094.67 }, // 620,094.67 + 275,000
        balance: { account: { accruedIncome: null, assets: 895_094.67, netAssets: 895_094.67 } },
      },
    },
    {
      // Tuesday 1 June, after Memorial Day. The coupon date passes unpaid and is listed; the next one is scheduled. Nothing accrues.
      id: 'coupon-missed', covers: ['missed coupon', 'market holiday'], action: 'clock', to: EDT('2027-06-01'),
      expect: {
        events: [{ type: 'bond.coupon_missed', summary: 'Coupon of 2027-06-01 not paid on 500,000 CORVANE-8.5-JUN31: coupons are suspended', owner: 'account', date: '2027-06-01' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-12-01', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2031-06-02', status: 'pending' }],
      },
    },
    {
      id: 'quote-default', action: 'quote', instrument: 'main', quote: { bid: 38, ask: 40, last: 39, bidSize: 5_000_000, askSize: 5_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 500_000, price: 39, value: 195_000, unrealized: -165_000 }], // 500,000 x 39% - 360,000
        pnl: { account: { unrealized: -165_000, total: -184_905.33 } }, // -19,833.33 - 72 - 165,000
        nav: { account: 815_094.67, book: 1_815_094.67 },
        balance: { account: { positions: 195_000, assets: 815_094.67, netAssets: 815_094.67 } },
      },
    },
    {
      id: 'sell-flat', covers: ['reduce', 'flat trading'], action: 'ticket', instrument: 'main', side: 'sell', qty: 200_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 200_000, estimate: 38, settleDate: '2027-06-02',
          gross: 76_000, // 200,000 x 38 / 100
          accrued: 0, // coupons suspended: the bond trades flat
          cash: 76_000, fees: 15.20 }] }, // 2 bp of 76,000
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 200_000, avgPrice: 38 }] },
        // Cost removed at the average: 200,000 x 72% = 144,000. Realized 76,000 - 144,000 = -68,000.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 200,000 CORVANE-8\.5-JUN31 @ 38\.00 USD \(realized [-−]68,000\.00 USD\)$/ }],
        cash: { account: { USD: { settled: 620_094.67, unsettled: 75_984.80, availableToTrade: 696_079.47 } } }, // 76,000 - 15.20
        positions: [{ instrument: 'main', lot: 'lot', qty: 300_000, cost: 216_000, avgCost: 72, price: 39, value: 117_000, unrealized: -99_000, accrued: 0 }],
        holdings: { main: { long: 300_000, short: 0, net: 300_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-06-02', amount: 75_984.80, into: 'cash' }],
        pnl: { account: { realized: -68_000, commissions: -87.20, unrealized: -99_000, total: -186_920.53 } }, // -68,000 - 19,833.33 - 87.20 - 99,000
        nav: { account: 813_079.47, book: 1_813_079.47 },
        balance: { account: { cash: 620_094.67, receivable: 75_984.80, positions: 117_000, assets: 813_079.47, liabilities: 0, netAssets: 813_079.47 } },
      },
    },
    {
      id: 'settle-sale', covers: 'settlement', action: 'clock', to: EDT('2027-06-02'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 75,984.80 USD into settled cash', cash: { USD: 75_984.80 } }],
        cash: { account: { USD: { settled: 696_079.47, unsettled: 0, availableToTrade: 696_079.47 } } },
        pending: [],
        balance: { account: { cash: 696_079.47, receivable: null, assets: 813_079.47 } },
      },
    },
    {
      // The restructuring plan cancels the notes for 35% of par in cash, recorded by hand on the position. No accrued interest is
      // paid (coupons are suspended). Realized 300,000 x 35% - 216,000 = 105,000 - 216,000 = -111,000.
      id: 'restructuring', covers: ['restructuring (by hand)', 'close'], action: 'lifecycle', lot: 'lot', body: { action: 'redeem', price: 35, face: 300_000, label: 'Restructuring, notes cancelled for cash' },
      expect: {
        events: [
          { type: 'bond.early_redemption', summary: 'Restructuring, notes cancelled for cash: 300,000 CORVANE-8.5-JUN31 at 35.00% of par', owner: 'account', date: '2027-06-02' },
          { type: 'settlement.receive', summary: 'received 105,000.00 USD into settled cash', cash: { USD: 105_000 } },
        ],
        cash: { account: { USD: { settled: 801_079.47, unsettled: 0, availableToTrade: 801_079.47 } }, treasury: { USD: { settled: 1_000_000 } } }, // 696,079.47 + 105,000
        positions: [],
        holdings: { main: null },
        pending: [],
        lifecycle: [],
        pnl: { account: { realized: -179_000, couponInterest: -19_833.33, commissions: -87.20, unrealized: 0, total: -198_920.53 } }, // -68,000 - 111,000
        nav: { account: 801_079.47, book: 1_801_079.47 },
        balance: { account: { cash: 801_079.47, positions: null, accruedIncome: null, assets: 801_079.47, liabilities: 0, netAssets: 801_079.47 } },
      },
    },
  ],
};

export default [corporateBondIg, highYieldBond];
