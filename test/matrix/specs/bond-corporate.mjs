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

// ---------------------------------------------------------------------------------------------
// eurobond
// ---------------------------------------------------------------------------------------------
// A euro-denominated Eurobond of a Swedish telecom issuer, listed in Luxembourg and settled through the
// international central securities depositories: 3.625% paid ANNUALLY on 15 March, accrued on 30E/360
// (the Eurobond basis: every 31st counts as the 30th), T+2 on the TARGET calendar, pieces of 100,000.
// In a Book that reports in US dollars.
//
// What sets it apart from a US corporate: one coupon a year (3.625 per 100), the 30E/360 basis, the euro
// payment calendar and settlement two TARGET days after the trade. A sale on Thursday 25 March 2027 settles
// on Wednesday 31 March: Good Friday (26 March) and Easter Monday (29 March) are TARGET closing days. On
// Easter Monday New York is open, so the Terminal's end of day runs while the euro market is shut. The
// settlement date is the 31st: 30E/360 counts 15 days from 15 March (30 - 15); 30/360 US would count 16.
//
// Days of 30E/360: 15 Mar 2026 to 12 Mar 2027 357; from 15 Mar 2027: to 24 Mar 9, to 29 Mar 14, to 30 Mar 15,
// to 31 Mar 15, to 2 Apr 17. One day at 3.625% on 2,000,000 is 201.3889.
//
// Reporting currency (as in bond-government.mjs, foreign_gov_bill): every posting is translated at the
// EUR/USD rate in force when it is booked and rounded to the cent; balances and unrealized P&L at the
// current rate; "FX effects" is what the change of rate did to the euro balances as booked. EUR/USD is 1.08
// at the start and 1.10 after the coupon. Commission: 0.5 bp of principal.
const eurobond = {
  productId: 'eurobond',
  title: 'Brennvik Telecom 3.625% euro notes due 15 March 2033 (Eurobond, Luxembourg-listed): annual coupon, 30E/360, T+2 on TARGET across Easter, reported in US dollars',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 100,000)'],
    manualInputs: ['none: annual coupon, 30E/360 accrued interest and T+2 TARGET settlement follow from the registered terms and conventions'],
    settlement: 'T+2 on the TARGET calendar (instrument convention, settlement lag 2); Good Friday and Easter Monday are skipped; amounts in euro',
    lifecycle: 'Daily accrual on 30E/360 (a 31st counts as the 30th); one coupon a year on 15 March; next coupon and maturity scheduled',
    accounting: 'Euro position, cash, accrued interest and settlement; US dollar figures at the current rate for balances and unrealized P&L, at the booking rate for income, commission and realized P&L; FX effects reported separately',
    collateral: 'None for a long position',
  },
  start: EST('2027-03-10'), // Wednesday
  settlementCheck: { lag: 2, holidays: ['2027-03-26', '2027-03-29'] }, // Good Friday and Easter Monday, TARGET closing days
  book: {
    name: 'Matrix Eurobond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'EUR', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'EUR', amount: 2_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  fx: { 'EUR/USD': 1.08 },
  instruments: {
    main: { productId: 'eurobond', name: 'Brennvik Telecom AB 3.625% Notes 15-Mar-2033 EUR', symbol: 'BRENNVIK-3.625-33', marketView: 'FOREIGN_CASH', venueType: 'exchange', venue: 'Luxembourg Stock Exchange', venueCountry: 'LU', issuer: 'Brennvik Telecom AB', domicile: 'SE', underlyingGeo: 'SE', tradingCcy: 'EUR', multiplier: 0.01,
      conventions: { settleLag: 2 },
      terms: { couponType: 'fixed', couponRate: 0.03625, frequency: 1, maturity: '2033-03-15', issueDate: '2023-03-15', dayCount: '30E/360', redemption: 100, minDenomination: 100_000, seniority: 'Senior unsecured' } },
  },
  quotes: { main: { bid: 99.3, ask: 99.4, last: 99.35, bidSize: 20_000_000, askSize: 20_000_000 } },
  expectAtStart: {
    ...startState(2_700_000, 1_540_000), // 2,500,000 EUR x 1.08; 1,000,000 USD + 500,000 EUR x 1.08
    cash: { account: { EUR: idle(2_500_000) }, treasury: { USD: idle(1_000_000), EUR: idle(500_000) } },
  },
  steps: [
    {
      id: 'below-denomination', covers: 'minimum denomination', action: 'ticket', instrument: 'main', side: 'buy', qty: 150_000,
      status: 'blocked', reason: 'The notes are issued in pieces of 100,000; 150,000 cannot be delivered.',
      expect: { refused: 'quantity must be a multiple of 100000' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2_000_000, estimate: 99.4, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-03-12', calendar: 'TARGET',
            gross: 1_988_000, // 2,000,000 x 99.40 / 100
            accrued: 71_895.83, // settles Friday 12 Mar, 357 days of 30E/360: 2,000,000 x 3.625% x 357/360 = 71,895.833
            cash: -2_059_895.83, fees: 99.4 }], // 0.5 bp of 1,988,000
          cash: { EUR: { purchases: 2_059_895.83, fees: 99.4, required: 2_059_995.23, available: 2_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2_000_000, avgPrice: 99.4, fills: [{ qty: 2_000_000, price: 99.4, model: 'quoted-bid-ask', settleDate: '2027-03-12', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000,000 BRENNVIK-3.625-33 @ 99.40 EUR', owner: 'account', date: '2027-03-10' }],
        cash: { account: { EUR: { settled: 2_500_000, unsettled: -2_059_995.23, availableToTrade: 440_004.77 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2_000_000, avgCost: 99.4, cost: 1_988_000, price: 99.35,
          value: 1_987_000, unrealized: -1_000, accrued: 71_895.83, priceSource: 'Test fixture' }], // euro
        holdings: { main: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-03-12', amount: -2_059_995.23, ccy: 'EUR', into: 'cash' }],
        // 15 Mar 2027 is a Monday; 15 Mar 2033 is a Tuesday. One coupon a year.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-03-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2033-03-15', status: 'pending' }],
        // In dollars at 1.08: commission 99.40 x 1.08 = 107.35; unrealized -1,000 x 1.08 = -1,080.
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -107.35, fees: 0, borrowFunding: 0, unrealized: -1_080, fx: 0, total: -1_187.35 } },
        nav: { account: 2_698_812.65, book: 4_238_812.65 }, // (2,500,000 - 2,059,995.23 + 1,987,000 + 71,895.83) x 1.08 = 2,498,900.60 x 1.08
        balance: { account: { cash: 2_700_000, accruedIncome: 77_647.50, positions: 2_145_960, payable: 2_224_794.85, assets: 4_923_607.50, liabilities: 2_224_794.85, netAssets: 2_698_812.65, // 71,895.83 x 1.08 = 77,647.496; 2,059,995.23 x 1.08 = 2,224,794.848; 4,558,895.83 x 1.08 = 4,923,607.496
          local: { EUR: { cash: 2_500_000, accruedIncome: 71_895.83, positions: 1_987_000, payable: 2_059_995.23 } } } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2027-03-12'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,059,995.23 EUR from settled cash', cash: { EUR: -2_059_995.23 }, date: '2027-03-12' }],
        cash: { account: { EUR: { settled: 440_004.77, unsettled: 0, availableToTrade: 440_004.77 } } },
        pending: [],
        balance: { account: { cash: 475_205.15, payable: null, assets: 2_698_812.65, liabilities: 0, local: { EUR: { cash: 440_004.77, payable: null } } } }, // 440,004.77 x 1.08 = 475,205.152
      },
    },
    {
      // Monday 15 March (daylight time in New York from 14 March). The annual coupon on the 2,000,000 settled before it:
      // 2,000,000 x 3.625% = 72,500 euro. Accrued on the books 71,895.83; the coupon exceeds it by 604.17, three 30E/360 days
      // (12 to 15 March); in dollars 604.17 x 1.08 = 652.50. The end-of-day run of Friday 12 March is older than the coupon: skipped.
      id: 'coupon', covers: 'coupon', action: 'clock', to: EDT('2027-03-15'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 2,000,000 BRENNVIK-3.625-33: 72,500.00 EUR', cash: { EUR: 72_500 }, owner: 'account', date: '2027-03-15' },
          { type: 'accrual.coupon', summary: 'Interest accrued on BRENNVIK-3.625-33: 604.17 EUR' },
        ],
        cash: { account: { EUR: { settled: 512_504.77, availableToTrade: 512_504.77 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-03-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2033-03-15', status: 'pending' }], // a Wednesday
        pnl: { account: { couponInterest: 652.50, total: -534.85 } },
        nav: { account: 2_699_465.15, book: 4_239_465.15 }, // (512,504.77 + 1,987,000) x 1.08 = 2,699,465.152
        balance: { account: { cash: 553_505.15, accruedIncome: null, assets: 2_699_465.15, netAssets: 2_699_465.15, local: { EUR: { cash: 512_504.77, accruedIncome: null } } } },
      },
    },
    {
      id: 'euro-rises', covers: 'fx', action: 'fx_rate', pair: 'EUR/USD', rate: 1.1,
      expect: {
        // Net assets 2,499,504.77 euro x 1.10 = 2,749,455.25. Unrealized -1,000 x 1.10 = -1,100.
        // FX effects: cash and the position at cost stand at 553,505.15 + 2,147,040 = 2,700,545.15 dollars as booked; at 1.10 the same
        // 2,500,504.77 euro are 2,750,555.25 (2,750,555.247): +50,010.10. Treasury's 500,000 euro: 550,000 - 540,000 = +10,000.
        pnl: { account: { unrealized: -1_100, fx: 50_010.10, total: 49_455.25 }, book: { fx: 60_010.10 } },
        nav: { account: 2_749_455.25, treasury: 1_550_000, book: 4_299_455.25 },
        balance: { account: { cash: 563_755.25, positions: 2_185_700, assets: 2_749_455.25, netAssets: 2_749_455.25 } }, // 512,504.77 x 1.10 = 563,755.247; 1,987,000 x 1.10
      },
    },
    {
      // Thursday 25 March. End of day 24 March: nine 30E/360 days on 2,000,000: 72,500 x 9/360 = 1,812.50 euro, 1,993.75 dollars.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EDT('2027-03-25'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on BRENNVIK-3.625-33: 1,812.50 EUR' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 1_812.50 }],
        pnl: { account: { couponInterest: 2_646.25, total: 51_449 } }, // 652.50 + 1,993.75
        nav: { account: 2_751_449, book: 4_301_449 }, // 2,501,317.27 euro x 1.10
        balance: { account: { accruedIncome: 1_993.75, assets: 2_751_449, netAssets: 2_751_449, local: { EUR: { accruedIncome: 1_812.50 } } } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 99.8, ask: 99.9, last: 99.85, bidSize: 20_000_000, askSize: 20_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, price: 99.85, value: 1_997_000, unrealized: 9_000 }], // 2,000,000 x 99.85% - 1,988,000
        pnl: { account: { unrealized: 9_900, total: 62_449 } }, // 9,000 x 1.10
        nav: { account: 2_762_449, book: 4_312_449 },
        balance: { account: { positions: 2_196_700, assets: 2_762_449, netAssets: 2_762_449, local: { EUR: { positions: 1_997_000 } } } },
      },
    },
    {
      // Thursday 25 March: T+2 on TARGET skips Good Friday and Easter Monday and lands on Wednesday 31 March.
      id: 'reduce', covers: ['reduce', 'market holiday'], action: 'ticket', instrument: 'main', side: 'sell', qty: 800_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 800_000, estimate: 99.8, settleDate: '2027-03-31', calendar: 'TARGET',
          gross: 798_400, // 800,000 x 99.80 / 100
          accrued: 1_208.33, // to 31 Mar, 15 days of 30E/360 (the 31st is the 30th): 800,000 x 3.625% x 15/360 = 1,208.333 (30/360 US: 16 days, 1,288.89)
          cash: 799_608.33, fees: 39.92 }] }, // 0.5 bp of 798,400
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 800_000, avgPrice: 99.8 }] },
        // Realized 798,400 - 800,000 x 99.40% = 3,200 euro, 3,520 dollars. Commission 39.92 x 1.10 = 43.91.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 800,000 BRENNVIK-3.625-33 @ 99.80 EUR (realized 3,200.00 EUR)' }],
        cash: { account: { EUR: { settled: 512_504.77, unsettled: 799_568.41, availableToTrade: 1_312_073.18 } } }, // 799,608.33 - 39.92
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, cost: 1_192_800, avgCost: 99.4, price: 99.85, value: 1_198_200, unrealized: 5_400,
          accrued: 604.17 }], // 1,812.50 - 1,208.33
        holdings: { main: { long: 1_200_000, short: 0, net: 1_200_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-03-31', amount: 799_568.41, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: 3_520, commissions: -151.26, unrealized: 5_940, total: 61_965.09 } }, // 107.35 + 43.91; 5,400 x 1.10
        nav: { account: 2_761_965.09, book: 4_311_965.09 }, // (512,504.77 + 799,568.41 + 1,198,200 + 604.17) x 1.10 = 2,510,877.35 x 1.10
        balance: { account: { cash: 563_755.25, receivable: 879_525.25, accruedIncome: 664.59, positions: 1_318_020, assets: 2_761_965.09, liabilities: 0, netAssets: 2_761_965.09,
          local: { EUR: { cash: 512_504.77, receivable: 799_568.41, accruedIncome: 604.17, positions: 1_198_200 } } } },
      },
    },
    {
      // Tuesday 30 March. Good Friday: New York closed too, no end of day. Easter Monday: TARGET closed, New York open, so the end of day
      // of 29 March runs: settled 2,000,000 to 29 March, 14 days, 2,819.4444; less the 1,208.3333 sold to 31 March: 1,611.11.
      // On the books 604.17: income 1,006.94 euro (five days on 2,000,000), 1,107.63 dollars. Nothing settles.
      id: 'easter', covers: ['market holiday', 'accrual'], action: 'clock', to: EDT('2027-03-30'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on BRENNVIK-3.625-33: 1,006.94 EUR', date: '2027-03-30' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, accrued: 1_611.11 }],
        pnl: { account: { couponInterest: 3_753.88, total: 63_072.72 } },
        nav: { account: 2_763_072.72, book: 4_313_072.72 },
        balance: { account: { accruedIncome: 1_772.22, assets: 2_763_072.72, netAssets: 2_763_072.72, local: { EUR: { accruedIncome: 1_611.11 } } } },
      },
    },
    {
      // Wednesday 31 March: the sale settles. End of day 30 March: 15 days on 2,000,000 = 3,020.8333, less 1,208.3333 = 1,812.50; income 201.39.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2027-03-31'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 799,568.41 EUR into settled cash', cash: { EUR: 799_568.41 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on BRENNVIK-3.625-33: 201.39 EUR' },
        ],
        cash: { account: { EUR: { settled: 1_312_073.18, unsettled: 0, availableToTrade: 1_312_073.18 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, accrued: 1_812.50 }],
        pending: [],
        pnl: { account: { couponInterest: 3_975.41, total: 63_294.25 } },
        nav: { account: 2_763_294.25, book: 4_313_294.25 },
        balance: { account: { cash: 1_443_280.50, receivable: null, accruedIncome: 1_993.75, assets: 2_763_294.25, netAssets: 2_763_294.25, local: { EUR: { cash: 1_312_073.18, receivable: null, accruedIncome: 1_812.50 } } } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_200_000, estimate: 99.8, settleDate: '2027-04-02',
          gross: 1_197_600, // 1,200,000 x 99.80 / 100
          accrued: 2_054.17, // to Friday 2 April, 17 days of 30E/360: 1,200,000 x 3.625% x 17/360 = 2,054.1667
          cash: 1_199_654.17, fees: 59.88 }] }, // 0.5 bp of 1,197,600
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1_200_000, avgPrice: 99.8 }] },
        // Realized 1,197,600 - 1,192,800 = 4,800 euro, 5,280 dollars. Interest sold 2,054.17 against 1,812.50 on the books: 241.67 more
        // income (30E/360 from 30 March to 2 April is 2 days on 1,200,000; the 800,000 earned nothing for the 31st). 265.84 dollars.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 1,200,000 BRENNVIK-3.625-33 @ 99.80 EUR (realized 4,800.00 EUR)' },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of BRENNVIK-3.625-33: 241.67 EUR' },
        ],
        cash: { account: { EUR: { settled: 1_312_073.18, unsettled: 1_199_594.29, availableToTrade: 2_511_667.47 } } }, // 1,199,654.17 - 59.88
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2027-04-02', amount: 1_199_594.29, ccy: 'EUR', into: 'cash' }],
        lifecycle: [],
        // Euro interest in all: 72,500 + 1,208.33 + 2,054.17 sold - 71,895.83 bought = 3,866.67; in dollars, posting by posting, 4,241.25.
        pnl: { account: { realized: 8_800, couponInterest: 4_241.25, commissions: -217.13, unrealized: 0, fx: 50_010.10, total: 62_834.22 } }, // 3,520 + 5,280; 151.26 + 65.87
        nav: { account: 2_762_834.22, book: 4_312_834.22 }, // 2,511,667.47 x 1.10 = 2,762,834.217
        balance: { account: { cash: 1_443_280.50, receivable: 1_319_553.72, positions: null, accruedIncome: null, assets: 2_762_834.22, liabilities: 0, netAssets: 2_762_834.22,
          local: { EUR: { cash: 1_312_073.18, receivable: 1_199_594.29, positions: null, accruedIncome: null } } } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2027-04-02'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,199,594.29 EUR into settled cash', cash: { EUR: 1_199_594.29 } }],
        cash: { account: { EUR: { settled: 2_511_667.47, unsettled: 0, availableToTrade: 2_511_667.47 } }, treasury: { USD: { settled: 1_000_000 }, EUR: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 2_762_834.22, receivable: null, assets: 2_762_834.22, liabilities: 0, netAssets: 2_762_834.22, local: { EUR: { cash: 2_511_667.47, receivable: null } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// foreign_market_bond
// ---------------------------------------------------------------------------------------------
// A Bulldog: a sterling bond of a FRENCH issuer, listed on the London Stock Exchange and following the UK
// market's conventions: 5.25% paid semi-annually on 1 March and 1 September, ACT/ACT, T+1 on the London
// calendar, pieces of 1,000. In a Book that reports in US dollars. The issuer's home country plays no part:
// the listing, the currency, the calendar and the conventions are the UK market's.
//   - Bought on Wednesday 25 August 2027; 600,000 more on Friday 27 August settles on Tuesday 31 August, over
//     the Summer bank holiday (Monday 30 August): London is closed, New York is open, so the Terminal's end
//     of day runs on the 30th while the sterling market is shut.
//   - The 1 September coupon is paid on the 2,100,000 settled before it.
//   - The rest is sold on Friday 3 September for settlement on Monday 6 September, which is Labor Day in New
//     York and a business day in London: the sterling settlement is not moved by the US holiday.
// Not modelled: an ex-dividend period. Older Bulldogs, like gilts, go ex-dividend seven business days before a
// coupon; the Terminal has no ex-dividend period for debt securities (a coupon belongs to the face settled
// before the coupon date), so this bond is registered as one without it (record date the day before).
//
// Coupon periods (ACT/ACT): 1 Mar to 1 Sep 2027 is 184 days, 1 Sep 2027 to 1 Mar 2028 is 182. A coupon is
// 2.625 per 100. Days from 1 Mar: to 26 Aug 178, to 30 Aug 182, to 31 Aug 183. From 1 Sep: to 2 Sep 1, to
// 3 Sep 2, to 6 Sep 5. Reporting currency as in eurobond: GBP/USD 1.27, then 1.25. Commission 0.8 bp.
const foreignMarketBond = {
  productId: 'foreign_market_bond',
  title: 'Compagnie Valmont 5.25% sterling bonds due 2035 (Bulldog: French issuer, London listing, UK conventions): ACT/ACT, T+1 over a UK bank holiday and Labor Day, reported in US dollars',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    manualInputs: ['none: the UK market conventions follow from the London listing (venue country GB) and the registered terms'],
    settlement: 'T+1 on the London calendar (venue country GB); the Summer bank holiday is skipped; Labor Day in New York does not move a sterling settlement; no ex-dividend period (not modelled by the Terminal)',
    lifecycle: 'Daily accrual on ACT/ACT, on a London holiday too; semi-annual coupon to the face settled before the coupon date',
    accounting: 'Sterling position, cash, accrued interest and settlement; US dollar figures at the current rate for balances and unrealized P&L, at the booking rate for income, commission and realized P&L; FX effects reported separately',
    collateral: 'None for a long position',
  },
  start: EDT('2027-08-25'), // Wednesday
  settlementCheck: { lag: 1, holidays: ['2027-08-30'] }, // Summer bank holiday in England
  book: {
    name: 'Matrix Bulldog bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'GBP', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'GBP', amount: 2_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.8 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  fx: { 'GBP/USD': 1.27 },
  instruments: {
    main: { productId: 'foreign_market_bond', name: 'Compagnie Valmont SA 5.25% Sterling Bonds 1-Sep-2035', symbol: 'VALMONT-5.25-35', marketView: 'FOREIGN_CASH', venueType: 'exchange', venue: 'London Stock Exchange', venueCountry: 'GB', issuer: 'Compagnie Valmont SA', domicile: 'FR', underlyingGeo: 'FR', tradingCcy: 'GBP', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.0525, frequency: 2, maturity: '2035-09-01', issueDate: '2015-09-01', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured' } },
  },
  quotes: { main: { bid: 97.6, ask: 97.75, last: 97.675, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: {
    ...startState(3_175_000, 1_635_000), // 2,500,000 GBP x 1.27; 1,000,000 USD + 500,000 GBP x 1.27
    cash: { account: { GBP: idle(2_500_000) }, treasury: { USD: idle(1_000_000), GBP: idle(500_000) } },
  },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_500_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_500_000, estimate: 97.75, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-08-26', calendar: 'UK',
            gross: 1_466_250, // 1,500,000 x 97.75 / 100
            accrued: 38_091.03, // settles 26 Aug, 178 of 184 days: 39,375 x 178/184 = 38,091.033
            cash: -1_504_341.03, fees: 117.3 }], // 0.8 bp of 1,466,250
          cash: { GBP: { purchases: 1_504_341.03, fees: 117.3, required: 1_504_458.33, available: 2_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_500_000, avgPrice: 97.75, fills: [{ qty: 1_500_000, price: 97.75, model: 'quoted-bid-ask', settleDate: '2027-08-26', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,500,000 VALMONT-5.25-35 @ 97.75 GBP', owner: 'account', date: '2027-08-25' }],
        cash: { account: { GBP: { settled: 2_500_000, unsettled: -1_504_458.33, availableToTrade: 995_541.67 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_500_000, avgCost: 97.75, cost: 1_466_250, price: 97.675,
          value: 1_465_125, unrealized: -1_125, accrued: 38_091.03, priceSource: 'Test fixture' }], // sterling
        holdings: { main: { long: 1_500_000, short: 0, net: 1_500_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-08-26', amount: -1_504_458.33, ccy: 'GBP', into: 'cash' }],
        // 1 Sep 2027 is a Wednesday. 1 Sep 2035 is a Saturday: redemption on Monday 3 September 2035.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-09-01', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2035-09-03', status: 'pending' }],
        // In dollars at 1.27: commission 117.30 x 1.27 = 148.97; unrealized -1,125 x 1.27 = -1,428.75.
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -148.97, fees: 0, borrowFunding: 0, unrealized: -1_428.75, fx: 0, total: -1_577.72 } },
        nav: { account: 3_173_422.28, book: 4_808_422.28 }, // (2,500,000 - 1,504,458.33 + 1,465,125 + 38,091.03) x 1.27 = 2,498,757.70 x 1.27
        balance: { account: { cash: 3_175_000, accruedIncome: 48_375.61, positions: 1_860_708.75, payable: 1_910_662.08, assets: 5_084_084.36, liabilities: 1_910_662.08, netAssets: 3_173_422.28, // 38,091.03 x 1.27; 1,465,125 x 1.27; 1,504,458.33 x 1.27 = 1,910,662.079
          local: { GBP: { cash: 2_500_000, accruedIncome: 38_091.03, positions: 1_465_125, payable: 1_504_458.33 } } } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2027-08-26'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,504,458.33 GBP from settled cash', cash: { GBP: -1_504_458.33 }, date: '2027-08-26' }],
        cash: { account: { GBP: { settled: 995_541.67, unsettled: 0, availableToTrade: 995_541.67 } } },
        pending: [],
        balance: { account: { cash: 1_264_337.92, payable: null, assets: 3_173_422.28, liabilities: 0, local: { GBP: { cash: 995_541.67, payable: null } } } }, // 995,541.67 x 1.27 = 1,264,337.921
      },
    },
    // End of day 26 Aug: 1,500,000 settled, 178 days, 38,091.03: on the books already.
    { id: 'friday', action: 'clock', to: EDT('2027-08-27'), expect: { events: [] } },
    {
      // Friday 27 Aug: T+1 would be Monday 30 Aug, the Summer bank holiday: the purchase settles Tuesday 31 Aug.
      id: 'increase', covers: ['increase', 'market holiday'], action: 'resize', lot: 'lot', factor: 1.4, // 1,500,000 -> 2,100,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 600_000, estimate: 97.75, settleDate: '2027-08-31', calendar: 'UK',
          gross: 586_500, // 600,000 x 97.75 / 100
          accrued: 15_664.40, // settles 31 Aug, 183 of 184 days: 15,750 x 183/184 = 15,664.402
          cash: -602_164.40, fees: 46.92 }], // 0.8 bp of 586,500
          cash: { GBP: { purchases: 602_164.40, fees: 46.92, required: 602_211.32, available: 995_541.67, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 600_000, avgPrice: 97.75, fills: [{ qty: 600_000, price: 97.75, settleDate: '2027-08-31' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 600,000 VALMONT-5.25-35 @ 97.75 GBP' }],
        cash: { account: { GBP: { settled: 995_541.67, unsettled: -602_211.32, availableToTrade: 393_330.35 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_100_000, cost: 2_052_750, avgCost: 97.75, price: 97.675, value: 2_051_175, unrealized: -1_575, accrued: 53_755.43 }], // 38,091.03 + 15,664.40
        holdings: { main: { long: 2_100_000, short: 0, net: 2_100_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-08-31', amount: -602_211.32, ccy: 'GBP', into: 'cash' }],
        pnl: { account: { commissions: -208.56, unrealized: -2_000.25, total: -2_208.81 } }, // 148.97 + 46.92 x 1.27 (59.59); -1,575 x 1.27
        nav: { account: 3_172_791.19, book: 4_807_791.19 },
        balance: { account: { cash: 1_264_337.92, accruedIncome: 68_269.40, positions: 2_604_992.25, payable: 764_808.38, assets: 3_937_599.57, liabilities: 764_808.38, netAssets: 3_172_791.19,
          local: { GBP: { accruedIncome: 53_755.43, positions: 2_051_175, payable: 602_211.32 } } } },
      },
    },
    {
      // Tuesday 31 Aug. The end of day of Monday 30 Aug runs (New York was open): 1,500,000 settled, to 30 Aug, 182 days,
      // 38,947.0109; 600,000 unsettled, to 31 Aug, 15,664.4022; together 54,611.41. On the books 53,755.43: income 855.98 sterling,
      // 1,087.09 dollars. Then the purchase settles.
      id: 'uk-holiday', covers: ['market holiday', 'accrual', 'settlement'], action: 'clock', to: EDT('2027-08-31'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 602,211.32 GBP from settled cash', cash: { GBP: -602_211.32 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on VALMONT-5.25-35: 855.98 GBP' },
        ],
        cash: { account: { GBP: { settled: 393_330.35, unsettled: 0, availableToTrade: 393_330.35 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_100_000, accrued: 54_611.41 }],
        pending: [],
        // FX effects 0.01: the posting-by-posting translation of cash (1,264,337.92 - 764,808.38 = 499,529.54 booked) against
        // 393,330.35 x 1.27 = 499,529.5445.
        pnl: { account: { couponInterest: 1_087.09, fx: 0.01, total: -1_121.71 } },
        nav: { account: 3_173_878.29, book: 4_808_878.29 },
        balance: { account: { cash: 499_529.54, payable: null, accruedIncome: 69_356.49, assets: 3_173_878.29, liabilities: 0, netAssets: 3_173_878.29, local: { GBP: { cash: 393_330.35, payable: null, accruedIncome: 54_611.41 } } } },
      },
    },
    {
      // Wednesday 1 Sep: the coupon on 2,100,000: 2,100,000 x 2.625% = 55,125.00. On the books 54,611.41: 513.59 more income
      // (two days on 1,500,000, 427.99, and one on 600,000, 85.60), 652.26 dollars.
      id: 'coupon', covers: 'coupon', action: 'clock', to: EDT('2027-09-01'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 2,100,000 VALMONT-5.25-35: 55,125.00 GBP', cash: { GBP: 55_125 }, owner: 'account', date: '2027-09-01' },
          { type: 'accrual.coupon', summary: 'Interest accrued on VALMONT-5.25-35: 513.59 GBP' },
        ],
        cash: { account: { GBP: { settled: 448_455.35, availableToTrade: 448_455.35 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_100_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-03-01', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2035-09-03', status: 'pending' }],
        pnl: { account: { couponInterest: 1_739.35, fx: 0, total: -469.46 } },
        nav: { account: 3_174_530.54, book: 4_809_530.54 }, // (448,455.35 + 2,051,175) x 1.27
        balance: { account: { cash: 569_538.29, accruedIncome: null, assets: 3_174_530.54, netAssets: 3_174_530.54, local: { GBP: { cash: 448_455.35, accruedIncome: null } } } },
      },
    },
    {
      id: 'sterling-weakens', covers: 'fx', action: 'fx_rate', pair: 'GBP/USD', rate: 1.25,
      expect: {
        // FX effects: cash 569,538.29 and the position at cost 2,606,992.50 as booked; at 1.25: 560,569.1875 + 2,565,937.50:
        // -50,024.10. Treasury's 500,000 sterling: 625,000 - 635,000 = -10,000.
        pnl: { account: { unrealized: -1_968.75, fx: -50_024.10, total: -50_462.06 }, book: { fx: -60_024.10 } },
        nav: { account: 3_124_537.94, treasury: 1_625_000, book: 4_749_537.94 }, // 2,499,630.35 x 1.25
        balance: { account: { cash: 560_569.19, positions: 2_563_968.75, assets: 3_124_537.94, netAssets: 3_124_537.94 } },
      },
    },
    // End of day 1 Sep: interest to 1 Sep is zero days of the new period (the balance stands at the coupon date): nothing is booked.
    { id: 'accrue', covers: 'accrual', action: 'clock', to: EDT('2027-09-02'), expect: { events: [] } },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 98.1, ask: 98.25, last: 98.175, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_100_000, price: 98.175, value: 2_061_675, unrealized: 8_925 }], // 2,100,000 x 98.175% - 2,052,750
        pnl: { account: { unrealized: 11_156.25, total: -37_337.06 } },
        nav: { account: 3_137_662.94, book: 4_762_662.94 },
        balance: { account: { positions: 2_577_093.75, assets: 3_137_662.94, netAssets: 3_137_662.94, local: { GBP: { positions: 2_061_675 } } } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 700_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 700_000, estimate: 98.1, settleDate: '2027-09-03', calendar: 'UK',
          gross: 686_700, // 700,000 x 98.10 / 100
          accrued: 201.92, // settles 3 Sep, 2 of 182 days: 18,375 x 2/182 = 201.923
          cash: 686_901.92, fees: 54.94 }] }, // 0.8 bp of 686,700 = 54.936
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 700_000, avgPrice: 98.1 }] },
        // Realized 686,700 - 700,000 x 97.75% = 2,450 sterling, 3,062.50 dollars.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 700,000 VALMONT-5.25-35 @ 98.10 GBP (realized 2,450.00 GBP)' }],
        cash: { account: { GBP: { settled: 448_455.35, unsettled: 686_846.98, availableToTrade: 1_135_302.33 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_400_000, cost: 1_368_500, avgCost: 97.75, price: 98.175, value: 1_374_450, unrealized: 5_950, accrued: -201.92 }], // the interest sold, booked ahead of the two days it covers
        holdings: { main: { long: 1_400_000, short: 0, net: 1_400_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-09-03', amount: 686_846.98, ccy: 'GBP', into: 'cash' }],
        // Posting by posting: commission 54.94 x 1.25 = 68.68; FX effects -50,024.11 (each balance's translation rounded once at the end).
        pnl: { account: { realized: 3_062.50, commissions: -277.24, unrealized: 7_437.50, fx: -50_024.11, total: -38_062 }, book: { fx: -60_024.11 } },
        nav: { account: 3_136_938.01, book: 4_761_938.01 }, // (448,455.35 + 686,846.98 + 1,374,450 - 201.92) x 1.25 = 2,509,550.41 x 1.25
        balance: { account: { cash: 560_569.19, receivable: 858_558.73, accruedIncome: -252.40, positions: 1_718_062.50, assets: 3_136_938.01, liabilities: 0, netAssets: 3_136_938.01,
          local: { GBP: { cash: 448_455.35, receivable: 686_846.98, accruedIncome: -201.92, positions: 1_374_450 } } } },
      },
    },
    {
      // End of day 2 Sep: 2,100,000 settled, 1 day: 302.8846; less 201.9231 sold: 100.96. On the books -201.92: income 302.88 (378.60 dollars).
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2027-09-03'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 686,846.98 GBP into settled cash', cash: { GBP: 686_846.98 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on VALMONT-5.25-35: 302.88 GBP' },
        ],
        cash: { account: { GBP: { settled: 1_135_302.33, unsettled: 0, availableToTrade: 1_135_302.33 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_400_000, accrued: 100.96 }],
        pending: [],
        pnl: { account: { couponInterest: 2_117.95, total: -37_683.40 } },
        nav: { account: 3_137_316.61, book: 4_762_316.61 }, // (1,135,302.33 + 1,374,450 + 100.96) x 1.25
        balance: { account: { cash: 1_419_127.91, receivable: null, accruedIncome: 126.20, assets: 3_137_316.61, netAssets: 3_137_316.61, local: { GBP: { cash: 1_135_302.33, receivable: null, accruedIncome: 100.96 } } } },
      },
    },
    {
      // Friday 3 Sep: T+1 is Monday 6 Sep, Labor Day in New York and a business day in London.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_400_000, estimate: 98.1, settleDate: '2027-09-06', calendar: 'UK',
          gross: 1_373_400, // 1,400,000 x 98.10 / 100
          accrued: 1_009.62, // settles 6 Sep, 5 of 182 days: 36,750 x 5/182 = 1,009.615
          cash: 1_374_409.62, fees: 109.87 }] }, // 0.8 bp of 1,373,400 = 109.872
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1_400_000, avgPrice: 98.1 }] },
        // Realized 1,373,400 - 1,368,500 = 4,900 sterling, 6,125 dollars. Interest: 1,009.62 sold against 100.96 on the books: 908.66 more
        // (four days from 2 to 6 Sep on 1,400,000, 807.69, and the day to 3 Sep on the 700,000 sold, 100.96). 1,135.83 dollars.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 1,400,000 VALMONT-5.25-35 @ 98.10 GBP (realized 4,900.00 GBP)' },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of VALMONT-5.25-35: 908.66 GBP' },
        ],
        cash: { account: { GBP: { settled: 1_135_302.33, unsettled: 1_374_299.75, availableToTrade: 2_509_602.08 } } }, // 1,374,409.62 - 109.87
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2027-09-06', amount: 1_374_299.75, ccy: 'GBP', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: 9_187.50, couponInterest: 3_253.78, commissions: -414.58, unrealized: 0, fx: -50_024.11, total: -37_997.41 } }, // sterling interest in all 55,125 + 201.92 + 1,009.62 - 38,091.03 - 15,664.40 = 2,581.11
        nav: { account: 3_137_002.60, book: 4_762_002.60 }, // 2,509,602.08 x 1.25
        balance: { account: { cash: 1_419_127.91, receivable: 1_717_874.69, positions: null, accruedIncome: null, assets: 3_137_002.60, liabilities: 0, netAssets: 3_137_002.60,
          local: { GBP: { cash: 1_135_302.33, receivable: 1_374_299.75, positions: null, accruedIncome: null } } } },
      },
    },
    {
      // Tuesday 7 Sep (New York closed on Monday): the sale settled on the London date, Monday 6 Sep, and is booked now.
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2027-09-07'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,374,299.75 GBP into settled cash', cash: { GBP: 1_374_299.75 } }],
        cash: { account: { GBP: { settled: 2_509_602.08, unsettled: 0, availableToTrade: 2_509_602.08 } }, treasury: { USD: { settled: 1_000_000 }, GBP: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 3_137_002.60, receivable: null, assets: 3_137_002.60, liabilities: 0, netAssets: 3_137_002.60, local: { GBP: { cash: 2_509_602.08, receivable: null } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// corporate_sukuk
// ---------------------------------------------------------------------------------------------
// US dollar trust certificates (an ijara sukuk) of a Gulf logistics company's issuing vehicle, listed on
// Nasdaq Dubai and settled through the international depositories: periodic distributions at a profit rate
// of 5.10% a year paid QUARTERLY on 5 January, April, July and October, 30/360, T+2 on the US dollar
// calendar (instrument conventions: settlement and payment calendars USD, lag 2), pieces of 200,000.
// The Terminal books a sukuk on the bond engine: the periodic distribution is the "coupon" (the history says
// "Coupon received"), the dissolution amount at the scheduled dissolution date is the "redemption".
//   - Bought on Tuesday 29 June 2027 for settlement on Thursday 1 July.
//   - The 5 July distribution date is Independence Day observed (Federal Reserve and New York closed): the
//     distribution is paid on Tuesday 6 July, and on 30/360 the day of waiting earns nothing.
//   - 400,000 sold on Wednesday 7 July; the next quarterly distribution, 5 October, is paid on the 600,000 left,
//     which is then sold.
// A quarterly distribution is 5.10% / 4 = 1.275 per 100. One 30/360 day on 1,000,000 is 141.6667.
// Days of 30/360 from 5 April 2027: to 1 Jul 86. From 5 Jul: to 6 Jul 1, to 8 Jul 3, to 9 Jul 4. From 5 Oct: to 7 Oct 2.
// Commission: 0.6 basis point of clean principal.
const corporateSukuk = {
  productId: 'corporate_sukuk',
  title: 'Al Noor Logistics 5.10% US dollar trust certificates due 5 April 2030 (corporate sukuk, Nasdaq Dubai): quarterly distributions, one on Independence Day, a partial sale, closed',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 200,000)'],
    manualInputs: ['none (the Terminal calls the periodic distribution a coupon and the dissolution a redemption)'],
    settlement: 'T+2 on the US dollar calendar from the instrument conventions (listing venue Nasdaq Dubai has no holiday calendar in the Terminal; the certificates settle in dollars through the international depositories)',
    lifecycle: 'Daily accrual of the profit rate on 30/360; quarterly periodic distribution to the face settled before the distribution date, paid on the next US dollar business day after a holiday; next distribution and dissolution scheduled',
    accounting: 'Clean cost at average; distributions and the profit accrued on them are coupon and interest income, apart from realized P&L; commission expensed',
    collateral: 'None for a long position',
  },
  start: EDT('2027-06-29'), // Tuesday
  settlementCheck: { lag: 2, holidays: ['2027-07-05'] }, // Independence Day observed
  book: {
    name: 'Matrix corporate sukuk', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.6 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'corporate_sukuk', name: 'Al Noor Logistics Sukuk Ltd 5.10% Trust Certificates 5-Apr-2030', symbol: 'ALNOOR-5.1-APR30', marketView: 'FOREIGN_CASH', venueType: 'exchange', venue: 'Nasdaq Dubai', venueCountry: 'AE', issuer: 'Al Noor Logistics Sukuk Ltd', domicile: 'AE', underlyingGeo: 'AE', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settlementCalendar: 'USD', paymentCalendar: 'USD', settleLag: 2 },
      terms: { couponType: 'fixed', couponRate: 0.051, frequency: 4, maturity: '2030-04-05', issueDate: '2025-04-05', dayCount: '30/360', redemption: 100, minDenomination: 200_000, seniority: 'Senior unsecured (ijara)' } },
  },
  quotes: { main: { bid: 101.1, ask: 101.25, last: 101.175, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(2_000_000, 1_000_000), cash: { account: usdCash(2_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 101.25, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-07-01', calendar: 'USD',
            gross: 1_012_500, // 1,000,000 x 101.25 / 100
            accrued: 12_183.33, // settles 1 Jul, 86 days of 30/360 from 5 Apr: 1,000,000 x 5.1% x 86/360 = 12,183.333
            cash: -1_024_683.33, fees: 60.75 }], // 0.6 bp of 1,012,500
          cash: { USD: { purchases: 1_024_683.33, fees: 60.75, required: 1_024_744.08, available: 2_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 101.25, fills: [{ qty: 1_000_000, price: 101.25, model: 'quoted-bid-ask', settleDate: '2027-07-01', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 ALNOOR-5.1-APR30 @ 101.25 USD', owner: 'account', date: '2027-06-29' }],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -1_024_744.08, availableToTrade: 975_255.92 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 101.25, cost: 1_012_500, price: 101.175,
          value: 1_011_750, unrealized: -750, accrued: 12_183.33, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-07-01', amount: -1_024_744.08, ccy: 'USD', into: 'cash' }],
        // 5 Jul 2027 is Independence Day observed: the distribution is due Tuesday 6 July. 5 Apr 2030 is a Friday.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-07-06', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-04-05', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -60.75, fees: 0, borrowFunding: 0, unrealized: -750, total: -810.75 } },
        nav: { account: 1_999_189.25, book: 2_999_189.25 },
        balance: { account: { cash: 2_000_000, accruedIncome: 12_183.33, positions: 1_011_750, payable: 1_024_744.08, assets: 3_023_933.33, liabilities: 1_024_744.08, netAssets: 1_999_189.25 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2027-07-01'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,024,744.08 USD from settled cash', cash: { USD: -1_024_744.08 }, date: '2027-07-01' }],
        cash: { account: { USD: { settled: 975_255.92, unsettled: 0, availableToTrade: 975_255.92 } } },
        pending: [],
        balance: { account: { cash: 975_255.92, payable: null, assets: 1_999_189.25, liabilities: 0 } },
      },
    },
    {
      // Tuesday 6 July. The quarterly distribution of 5 July on 1,000,000: 1.275% = 12,750.00. On the books 12,183.33: 566.67 more
      // (four 30/360 days, 1 to 5 July). The end of day of Friday 2 July is older than the distribution date: skipped.
      id: 'distribution', covers: ['periodic distribution', 'market holiday'], action: 'clock', to: EDT('2027-07-06'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 1,000,000 ALNOOR-5.1-APR30: 12,750.00 USD', cash: { USD: 12_750 }, owner: 'account', date: '2027-07-06' },
          { type: 'accrual.coupon', summary: 'Interest accrued on ALNOOR-5.1-APR30: 566.67 USD' },
        ],
        cash: { account: { USD: { settled: 988_005.92, availableToTrade: 988_005.92 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-10-05', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-04-05', status: 'pending' }], // a Tuesday
        pnl: { account: { couponInterest: 566.67, total: -244.08 } },
        nav: { account: 1_999_755.92, book: 2_999_755.92 }, // 988,005.92 + 1,011,750
        balance: { account: { cash: 988_005.92, accruedIncome: null, assets: 1_999_755.92, netAssets: 1_999_755.92 } },
      },
    },
    {
      // End of day 6 July: one 30/360 day on 1,000,000: 141.67.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EDT('2027-07-07'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on ALNOOR-5.1-APR30: 141.67 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, accrued: 141.67 }],
        pnl: { account: { couponInterest: 708.34, total: -102.41 } },
        nav: { account: 1_999_897.59, book: 2_999_897.59 },
        balance: { account: { accruedIncome: 141.67, assets: 1_999_897.59, netAssets: 1_999_897.59 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 400_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 400_000, estimate: 101.1, settleDate: '2027-07-09', calendar: 'USD',
          gross: 404_400, // 400,000 x 101.10 / 100
          accrued: 226.67, // settles 9 Jul, 4 days: 400,000 x 5.1% x 4/360 = 226.667
          cash: 404_626.67, fees: 24.26 }] }, // 0.6 bp of 404,400 = 24.264
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 400_000, avgPrice: 101.1 }] },
        // Realized 404,400 - 400,000 x 101.25% = -600.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 400,000 ALNOOR-5\.1-APR30 @ 101\.10 USD \(realized [-−]600\.00 USD\)$/ }],
        cash: { account: { USD: { settled: 988_005.92, unsettled: 404_602.41, availableToTrade: 1_392_608.33 } } }, // 404,626.67 - 24.26
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, cost: 607_500, avgCost: 101.25, price: 101.175, value: 607_050, unrealized: -450, accrued: -85 }], // 141.67 - 226.67
        holdings: { main: { long: 600_000, short: 0, net: 600_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-07-09', amount: 404_602.41, into: 'cash' }],
        pnl: { account: { realized: -600, commissions: -85.01, unrealized: -450, total: -426.67 } }, // 708.34 - 600 - 85.01 - 450
        nav: { account: 1_999_573.33, book: 2_999_573.33 },
        balance: { account: { cash: 988_005.92, receivable: 404_602.41, accruedIncome: -85, positions: 607_050, assets: 1_999_573.33, liabilities: 0, netAssets: 1_999_573.33 } },
      },
    },
    {
      // End of day 8 July: 1,000,000 settled, 3 days, 425.00; less the 226.67 sold to 9 July: 198.33. On the books -85.00: income 283.33.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2027-07-09'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 404,602.41 USD into settled cash', cash: { USD: 404_602.41 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on ALNOOR-5.1-APR30: 283.33 USD' },
        ],
        cash: { account: { USD: { settled: 1_392_608.33, unsettled: 0, availableToTrade: 1_392_608.33 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, accrued: 198.33 }],
        pending: [],
        pnl: { account: { couponInterest: 991.67, total: -143.34 } },
        nav: { account: 1_999_856.66, book: 2_999_856.66 },
        balance: { account: { cash: 1_392_608.33, receivable: null, accruedIncome: 198.33, assets: 1_999_856.66, netAssets: 1_999_856.66 } },
      },
    },
    {
      // Tuesday 5 October: the next quarterly distribution, on the 600,000 settled before it: 1.275% = 7,650.00. On the books 198.33:
      // 7,451.67 more. (Three months pass in one move: the distribution is paid first and the older end of day is skipped.)
      id: 'next-distribution', covers: 'periodic distribution', action: 'clock', to: EDT('2027-10-05'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 600,000 ALNOOR-5.1-APR30: 7,650.00 USD', cash: { USD: 7_650 }, owner: 'account', date: '2027-10-05' },
          { type: 'accrual.coupon', summary: 'Interest accrued on ALNOOR-5.1-APR30: 7,451.67 USD' },
        ],
        cash: { account: { USD: { settled: 1_400_258.33, availableToTrade: 1_400_258.33 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-01-05', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-04-05', status: 'pending' }], // a Wednesday
        pnl: { account: { couponInterest: 8_443.34, total: 7_308.33 } },
        nav: { account: 2_007_308.33, book: 3_007_308.33 }, // 1,400,258.33 + 607,050
        balance: { account: { cash: 1_400_258.33, accruedIncome: null, assets: 2_007_308.33, netAssets: 2_007_308.33 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 101.6, ask: 101.75, last: 101.675, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, price: 101.675, value: 610_050, unrealized: 2_550 }], // 600,000 x 101.675% - 607,500
        pnl: { account: { unrealized: 2_550, total: 10_308.33 } },
        nav: { account: 2_010_308.33, book: 3_010_308.33 },
        balance: { account: { positions: 610_050, assets: 2_010_308.33, netAssets: 2_010_308.33 } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 600_000, estimate: 101.6, settleDate: '2027-10-07', calendar: 'USD',
          gross: 609_600, // 600,000 x 101.60 / 100
          accrued: 170, // settles 7 Oct, 2 days: 600,000 x 5.1% x 2/360
          cash: 609_770, fees: 36.58 }] }, // 0.6 bp of 609,600 = 36.576
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 600_000, avgPrice: 101.6 }] },
        // Realized 609,600 - 607,500 = 2,100. Interest sold 170.00 against nothing on the books: 170.00 income.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 600,000 ALNOOR-5.1-APR30 @ 101.60 USD (realized 2,100.00 USD)' },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of ALNOOR-5.1-APR30: 170.00 USD' },
        ],
        cash: { account: { USD: { settled: 1_400_258.33, unsettled: 609_733.42, availableToTrade: 2_009_991.75 } } }, // 609,770 - 36.58
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2027-10-07', amount: 609_733.42, into: 'cash' }],
        lifecycle: [],
        // Profit in all: 12,750 + 7,650 distributions + 226.67 + 170 sold - 12,183.33 bought = 8,613.34.
        pnl: { account: { realized: 1_500, couponInterest: 8_613.34, commissions: -121.59, unrealized: 0, total: 9_991.75 } }, // -600 + 2,100; 85.01 + 36.58
        nav: { account: 2_009_991.75, book: 3_009_991.75 },
        balance: { account: { cash: 1_400_258.33, receivable: 609_733.42, positions: null, accruedIncome: null, assets: 2_009_991.75, liabilities: 0, netAssets: 2_009_991.75 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2027-10-07'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 609,733.42 USD into settled cash', cash: { USD: 609_733.42 } }],
        cash: { account: { USD: { settled: 2_009_991.75, unsettled: 0, availableToTrade: 2_009_991.75 } }, treasury: { USD: { settled: 1_000_000 } } },
        pending: [],
        balance: { account: { cash: 2_009_991.75, receivable: null, assets: 2_009_991.75, liabilities: 0, netAssets: 2_009_991.75 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// floating_rate_note
// ---------------------------------------------------------------------------------------------
// A bank's senior floating-rate notes in US dollars: three-month term SOFR (rate code TSOFR3M) plus 0.95%,
// set at the start of each quarterly period (20 January, April, July, October), interest on ACT/360 for the
// actual days of the period, T+1 on the US bond calendar, pieces of 1,000. The coupon of the period running
// at registration is entered on the form (Current coupon 5.30%: the 20 January fixing 4.35% + 0.95%).
// Every coupon needs its fixing, and none is made up:
//   - 20 April: the coupon of 20 Jan to 20 Apr (90 days at 5.30%) is paid. The fixing for the next period, which
//     should have come from Shaffer MarketData, does not arrive: an alert says interest is not accruing, nothing
//     accrues, and a trade is refused because its accrued interest cannot be computed.
//   - 20 July: the coupon of 20 Apr to 20 Jul is blocked, visibly, waiting for the 20 April fixing. MarketData
//     delivers the 20 July fixing (4.05%); the blocked coupon does not take it.
//   - The 20 April fixing (4.20%) is then entered by hand on the Data connection screen: the coupon is paid at
//     5.15% for 91 days, and the next period runs at 5.00% (4.05% + 0.95%).
// Days: 20 Jan to 13 Apr 83, to 20 Apr 90; 20 Apr to 20 Jul 91. From 20 Jul: to 21 Jul 1, 22 Jul 2, 23 Jul 3, 26 Jul 6.
// Commission: 0.5 basis point of clean principal.
const floatingRateNote = {
  productId: 'floating_rate_note',
  title: 'Kestrel Bancorp floating-rate senior notes due 20 October 2029 (3M term SOFR + 0.95%): a missing fixing stops accrual and blocks a coupon, the fixing entered by hand pays it',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    automaticInputs: [...BOND_TICKET.automaticInputs, 'reference-rate fixing of each coupon period (rate fixture standing in for Shaffer MarketData)'],
    manualInputs: ['Current coupon of the running period on the registration form', 'a missing fixing entered by hand (Data connection, Manual entries, Reference or funding rate, with its fixing date)'],
    settlement: 'T+1 on the US bond calendar; a trade is refused while the coupon rate of the current period is unknown (its accrued interest cannot be computed)',
    lifecycle: 'Accrual on ACT/360 at the period rate; quarterly coupon for the actual days at the fixing of the period start plus the spread; reset after each coupon; a missing fixing raises an alert, stops accrual and blocks the coupon until it is supplied or entered; a later fixing is never used for an earlier period',
    accounting: 'Clean cost at average; accrued interest bought and sold through Accrued income; coupon income separate from realized and unrealized P&L; the coupon of a period accrued without a rate is income when it is paid',
    collateral: 'None for a long position',
  },
  start: EDT('2027-04-12'), // Monday
  settlementCheck: { lag: 1, holidays: [] },
  book: {
    name: 'Matrix floating-rate note', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'floating_rate_note', name: 'Kestrel Bancorp Inc Floating Rate Senior Notes 20-Oct-2029', symbol: 'KESTREL-FRN-OCT29', marketView: 'US_CASH', venueType: 'otc', issuer: 'Kestrel Bancorp Inc', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'float', referenceRate: 'TSOFR3M', spread: 0.0095, currentCoupon: 0.053, frequency: 4, maturity: '2029-10-20', issueDate: '2024-10-20', dayCount: 'ACT/360', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured' } },
  },
  quotes: { main: { bid: 100.05, ask: 100.15, last: 100.1, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(2_500_000, 500_000), cash: { account: usdCash(2_500_000), treasury: usdCash(500_000) }, alerts: [] },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2_000_000, estimate: 100.15, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-04-13', calendar: 'USBOND',
            gross: 2_003_000, // 2,000,000 x 100.15 / 100
            accrued: 24_438.89, // settles 13 Apr, 83 days at 5.30% on ACT/360: 2,000,000 x 5.3% x 83/360 = 24,438.889
            cash: -2_027_438.89, fees: 100.15 }], // 0.5 bp of 2,003,000
          cash: { USD: { purchases: 2_027_438.89, fees: 100.15, required: 2_027_539.04, available: 2_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2_000_000, avgPrice: 100.15, fills: [{ qty: 2_000_000, price: 100.15, model: 'quoted-bid-ask', settleDate: '2027-04-13', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000,000 KESTREL-FRN-OCT29 @ 100.15 USD', owner: 'account', date: '2027-04-12' }],
        cash: { account: { USD: { settled: 2_500_000, unsettled: -2_027_539.04, availableToTrade: 472_460.96 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2_000_000, avgCost: 100.15, cost: 2_003_000, price: 100.1,
          value: 2_002_000, unrealized: -1_000, accrued: 24_438.89, priceSource: 'Test fixture' }],
        holdings: { main: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-04-13', amount: -2_027_539.04, ccy: 'USD', into: 'cash' }],
        // 20 Apr 2027 is a Tuesday. 20 Oct 2029 is a Saturday: redemption on Monday 22 October 2029.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-04-20', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2029-10-22', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -100.15, fees: 0, borrowFunding: 0, unrealized: -1_000, total: -1_100.15 } },
        nav: { account: 2_498_899.85, book: 2_998_899.85 },
        balance: { account: { cash: 2_500_000, accruedIncome: 24_438.89, positions: 2_002_000, payable: 2_027_539.04, assets: 4_526_438.89, liabilities: 2_027_539.04, netAssets: 2_498_899.85 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2027-04-13'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,027,539.04 USD from settled cash', cash: { USD: -2_027_539.04 }, date: '2027-04-13' }],
        cash: { account: { USD: { settled: 472_460.96, unsettled: 0, availableToTrade: 472_460.96 } } },
        pending: [],
        balance: { account: { cash: 472_460.96, payable: null, assets: 2_498_899.85, liabilities: 0 } },
      },
    },
    {
      // Tuesday 20 April. The coupon of 20 Jan to 20 Apr, 90 days at 5.30%: 2,000,000 x 5.3% x 90/360 = 26,500.00. On the books
      // 24,438.89: 2,061.11 more (seven days). No TSOFR3M fixing for 20 April has been supplied: the new period has no rate, an
      // alert says so, and nothing is accrued for it (on its first day nothing has accrued anyway).
      id: 'coupon', covers: ['coupon', 'reset'], action: 'clock', to: EDT('2027-04-20'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 2,000,000 KESTREL-FRN-OCT29: 26,500.00 USD', cash: { USD: 26_500 }, owner: 'account', date: '2027-04-20' },
          { type: 'accrual.coupon', summary: 'Interest accrued on KESTREL-FRN-OCT29: 2,061.11 USD' },
        ],
        cash: { account: { USD: { settled: 498_960.96, availableToTrade: 498_960.96 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-07-20', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2029-10-22', status: 'pending' }],
        alerts: ['bond.fixing'],
        pnl: { account: { couponInterest: 2_061.11, total: 960.96 } },
        nav: { account: 2_500_960.96, book: 3_000_960.96 }, // 498,960.96 + 2,002,000
        balance: { account: { cash: 498_960.96, accruedIncome: null, assets: 2_500_960.96, netAssets: 2_500_960.96 } },
      },
    },
    // A week later: still no fixing. The end of day books nothing (the rate is unknown, not zero).
    { id: 'no-fixing', covers: 'missing fixing', action: 'clock', to: EDT('2027-04-28'), expect: { events: [] } },
    {
      id: 'sell-without-fixing', covers: ['reduce', 'missing fixing'], action: 'ticket', instrument: 'main', side: 'sell', qty: 500_000, from: 'lot',
      status: 'blocked', reason: 'The accrued interest of the sale cannot be computed without the period\'s fixing; it is not booked as zero.',
      expect: { refused: 'has no TSOFR3M fixing for its current coupon period' },
    },
    {
      // Tuesday 20 July. The coupon of 20 Apr to 20 Jul waits, visibly, for the 20 April fixing. Nothing is paid or accrued.
      id: 'coupon-blocked', covers: ['coupon', 'missing fixing'], action: 'clock', to: EDT('2027-07-20'),
      expect: {
        events: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-07-20', status: 'blocked' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2029-10-22', status: 'pending' }],
      },
    },
    // MarketData delivers the 20 July fixing. It belongs to the period that starts today: the blocked coupon does not use it.
    { id: 'july-fixing-arrives', covers: 'reset', action: 'rate', code: 'TSOFR3M', value: 4.05, date: '2027-07-20', expect: { events: [] } },
    {
      // The 20 April fixing, 4.20%, entered by hand. The blocked coupon is paid at 4.20% + 0.95% = 5.15% for 91 days:
      // 2,000,000 x 5.15% x 91/360 = 26,036.11. Nothing had accrued for the period, so all of it is income now. The next period
      // takes the 20 July fixing: 4.05% + 0.95% = 5.00%. The alert is resolved.
      id: 'april-fixing-entered', covers: ['coupon', 'fixing by hand'], action: 'manual_rate', code: 'TSOFR3M', value: 4.2, date: '2027-04-20', note: 'April fixing from the calculation agent notice',
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 2,000,000 KESTREL-FRN-OCT29: 26,036.11 USD', cash: { USD: 26_036.11 }, owner: 'account', date: '2027-07-20' },
          { type: 'accrual.coupon', summary: 'Interest accrued on KESTREL-FRN-OCT29: 26,036.11 USD' },
        ],
        cash: { account: { USD: { settled: 524_997.07, availableToTrade: 524_997.07 } } },
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-10-20', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2029-10-22', status: 'pending' }], // a Wednesday
        alerts: [],
        pnl: { account: { couponInterest: 28_097.22, total: 26_997.07 } },
        nav: { account: 2_526_997.07, book: 3_026_997.07 },
        balance: { account: { cash: 524_997.07, assets: 2_526_997.07, netAssets: 2_526_997.07 } },
      },
    },
    {
      // Thursday 22 July. End of day 21 July: one day at 5.00%: 2,000,000 x 5% / 360 = 277.78.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EDT('2027-07-22'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on KESTREL-FRN-OCT29: 277.78 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 277.78 }],
        pnl: { account: { couponInterest: 28_375, total: 27_274.85 } },
        nav: { account: 2_527_274.85, book: 3_027_274.85 },
        balance: { account: { accruedIncome: 277.78, assets: 2_527_274.85, netAssets: 2_527_274.85 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 100.25, ask: 100.35, last: 100.3, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, price: 100.3, value: 2_006_000, unrealized: 3_000 }], // 2,000,000 x 100.30% - 2,003,000
        pnl: { account: { unrealized: 3_000, total: 31_274.85 } },
        nav: { account: 2_531_274.85, book: 3_031_274.85 },
        balance: { account: { positions: 2_006_000, assets: 2_531_274.85, netAssets: 2_531_274.85 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 800_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 800_000, estimate: 100.25, settleDate: '2027-07-23',
          gross: 802_000, // 800,000 x 100.25 / 100
          accrued: 333.33, // settles 23 Jul, 3 days at 5.00%: 800,000 x 5% x 3/360 = 333.333
          cash: 802_333.33, fees: 40.10 }] }, // 0.5 bp of 802,000
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 800_000, avgPrice: 100.25 }] },
        // Realized 802,000 - 800,000 x 100.15% = 800.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 800,000 KESTREL-FRN-OCT29 @ 100.25 USD (realized 800.00 USD)' }],
        cash: { account: { USD: { settled: 524_997.07, unsettled: 802_293.23, availableToTrade: 1_327_290.30 } } }, // 802,333.33 - 40.10
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, cost: 1_201_800, avgCost: 100.15, price: 100.3, value: 1_203_600, unrealized: 1_800, accrued: -55.55 }], // 277.78 - 333.33
        holdings: { main: { long: 1_200_000, short: 0, net: 1_200_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-07-23', amount: 802_293.23, into: 'cash' }],
        pnl: { account: { realized: 800, commissions: -140.25, unrealized: 1_800, total: 30_834.75 } }, // 100.15 + 40.10
        nav: { account: 2_530_834.75, book: 3_030_834.75 },
        balance: { account: { cash: 524_997.07, receivable: 802_293.23, accruedIncome: -55.55, positions: 1_203_600, assets: 2_530_834.75, liabilities: 0, netAssets: 2_530_834.75 } },
      },
    },
    {
      // End of day 22 July: 2,000,000 settled, 2 days at 5.00%: 555.5556; less the 333.3333 sold: 222.22. On the books -55.55: income 277.77.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2027-07-23'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 802,293.23 USD into settled cash', cash: { USD: 802_293.23 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on KESTREL-FRN-OCT29: 277.77 USD' },
        ],
        cash: { account: { USD: { settled: 1_327_290.30, unsettled: 0, availableToTrade: 1_327_290.30 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, accrued: 222.22 }],
        pending: [],
        pnl: { account: { couponInterest: 28_652.77, total: 31_112.52 } },
        nav: { account: 2_531_112.52, book: 3_031_112.52 },
        balance: { account: { cash: 1_327_290.30, receivable: null, accruedIncome: 222.22, assets: 2_531_112.52, netAssets: 2_531_112.52 } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_200_000, estimate: 100.25, settleDate: '2027-07-26',
          gross: 1_203_000, // 1,200,000 x 100.25 / 100
          accrued: 1_000, // settles Monday 26 Jul, 6 days at 5.00%: 1,200,000 x 5% x 6/360
          cash: 1_204_000, fees: 60.15 }] }, // 0.5 bp of 1,203,000
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1_200_000, avgPrice: 100.25 }] },
        // Realized 1,203,000 - 1,201,800 = 1,200. Interest sold 1,000 against 222.22 on the books: 777.78 more.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 1,200,000 KESTREL-FRN-OCT29 @ 100.25 USD (realized 1,200.00 USD)' },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of KESTREL-FRN-OCT29: 777.78 USD' },
        ],
        cash: { account: { USD: { settled: 1_327_290.30, unsettled: 1_203_939.85, availableToTrade: 2_531_230.15 } } }, // 1,204,000 - 60.15
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2027-07-26', amount: 1_203_939.85, into: 'cash' }],
        lifecycle: [],
        // Interest in all: 26,500 + 26,036.11 coupons + 333.33 + 1,000 sold - 24,438.89 bought = 29,430.55.
        pnl: { account: { realized: 2_000, couponInterest: 29_430.55, commissions: -200.40, unrealized: 0, total: 31_230.15 } },
        nav: { account: 2_531_230.15, book: 3_031_230.15 },
        balance: { account: { cash: 1_327_290.30, receivable: 1_203_939.85, positions: null, accruedIncome: null, assets: 2_531_230.15, liabilities: 0, netAssets: 2_531_230.15 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2027-07-26'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,203,939.85 USD into settled cash', cash: { USD: 1_203_939.85 } }],
        cash: { account: { USD: { settled: 2_531_230.15, unsettled: 0, availableToTrade: 2_531_230.15 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 2_531_230.15, receivable: null, assets: 2_531_230.15, liabilities: 0, netAssets: 2_531_230.15 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// zero_coupon_bond
// ---------------------------------------------------------------------------------------------
// A corporate zero-coupon note, issued in 2021 at a deep discount and now a few weeks from maturity: no coupon,
// no accrued interest, bought below par and redeemed at par. T+1 on the US bond calendar, pieces of 1,000.
// Its maturity date, Thursday 26 November 2026, is Thanksgiving: the redemption is paid on Friday 27 November.
//   - Bought on Monday 2 November at 99.60.
//   - 800,000 sold on Tuesday 10 November: T+1 would be Veterans Day, so it settles on Thursday 12 November.
//   - On Wednesday 25 November a purchase would settle on Friday 27 November, after the maturity date: refused.
//   - The 1,200,000 left is redeemed at 100.
// The discount is price gain: unrealized while held, realized at the sale and at redemption. The Terminal does
// not accrete the discount into interest income (nothing is booked between trades), so coupon income stays zero.
// Commission: 1 basis point of clean principal (none on the redemption).
const zeroCouponBond = {
  productId: 'zero_coupon_bond',
  title: 'Halvorsen Pharma zero-coupon notes due 26 November 2026: bought at a discount, part sold over Veterans Day, the rest redeemed at par after Thanksgiving',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    automaticInputs: ['bid, ask, last in % of par (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model', 'settlement date from the instrument convention and settlement calendar', 'commission from the Book fee schedule'],
    manualInputs: ['none'],
    settlement: 'T+1 on the US bond calendar; Veterans Day is skipped; a trade must settle before the maturity date, so a purchase the day before Thanksgiving (settling after maturity) is refused',
    lifecycle: 'No coupon and no accrual; redemption at par on the maturity date, moved to the next business day after Thanksgiving, automatic',
    accounting: 'Clean cost at average; no accrued interest; the discount is unrealized P&L while held and realized P&L at sale and redemption (no accretion into interest income)',
    collateral: 'None for a long position',
  },
  start: EST('2026-11-02'), // Monday
  settlementCheck: { lag: 1, holidays: ['2026-11-11', '2026-11-26'] }, // Veterans Day, Thanksgiving
  book: {
    name: 'Matrix zero-coupon bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 1 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'zero_coupon_bond', name: 'Halvorsen Pharma Inc Zero Coupon Notes 26-Nov-2026', symbol: 'HALV-ZERO-NOV26', marketView: 'US_CASH', venueType: 'otc', issuer: 'Halvorsen Pharma Inc', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'zero', maturity: '2026-11-26', issueDate: '2021-11-26', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured' } },
  },
  quotes: { main: { bid: 99.55, ask: 99.6, last: 99.575, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(2_500_000, 500_000), cash: { account: usdCash(2_500_000), treasury: usdCash(500_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2_000_000, estimate: 99.6, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-11-03', calendar: 'USBOND',
            gross: 1_992_000, // 2,000,000 x 99.60 / 100
            accrued: 0, cash: -1_992_000, fees: 199.20 }], // 1 bp of 1,992,000
          cash: { USD: { purchases: 1_992_000, fees: 199.20, required: 1_992_199.20, available: 2_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2_000_000, avgPrice: 99.6, fills: [{ qty: 2_000_000, price: 99.6, model: 'quoted-bid-ask', settleDate: '2026-11-03', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000,000 HALV-ZERO-NOV26 @ 99.60 USD', owner: 'account', date: '2026-11-02' }],
        cash: { account: { USD: { settled: 2_500_000, unsettled: -1_992_199.20, availableToTrade: 507_800.80 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2_000_000, avgCost: 99.6, cost: 1_992_000, price: 99.575,
          value: 1_991_500, unrealized: -500, accrued: 0, priceSource: 'Test fixture' }], // 2,000,000 x 99.575%
        holdings: { main: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-11-03', amount: -1_992_199.20, ccy: 'USD', into: 'cash' }],
        // No coupon. Maturity 26 Nov 2026 is Thanksgiving: redemption due Friday 27 November.
        lifecycle: [{ type: 'bond.maturity', instrument: 'main', dueDate: '2026-11-27', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -199.20, fees: 0, borrowFunding: 0, unrealized: -500, total: -699.20 } },
        nav: { account: 2_499_300.80, book: 2_999_300.80 },
        balance: { account: { cash: 2_500_000, positions: 1_991_500, payable: 1_992_199.20, assets: 4_491_500, liabilities: 1_992_199.20, netAssets: 2_499_300.80 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2026-11-03'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,992,199.20 USD from settled cash', cash: { USD: -1_992_199.20 }, date: '2026-11-03' }],
        cash: { account: { USD: { settled: 507_800.80, unsettled: 0, availableToTrade: 507_800.80 } } },
        pending: [],
        balance: { account: { cash: 507_800.80, payable: null, assets: 2_499_300.80, liabilities: 0 } },
      },
    },
    // A week passes: a zero has nothing to accrue, so nothing is booked.
    { id: 'week-on', covers: 'accrual', action: 'clock', to: EST('2026-11-10'), expect: { events: [] } },
    {
      id: 'quote-pull-to-par', action: 'quote', instrument: 'main', quote: { bid: 99.78, ask: 99.83, last: 99.805, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, price: 99.805, value: 1_996_100, unrealized: 4_100 }], // 2,000,000 x 99.805% - 1,992,000
        pnl: { account: { unrealized: 4_100, total: 3_900.80 } },
        nav: { account: 2_503_900.80, book: 3_003_900.80 },
        balance: { account: { positions: 1_996_100, assets: 2_503_900.80, netAssets: 2_503_900.80 } },
      },
    },
    {
      // Tuesday 10 Nov: T+1 would be Wednesday 11 Nov, Veterans Day: the sale settles Thursday 12 Nov.
      id: 'reduce', covers: ['reduce', 'market holiday'], action: 'ticket', instrument: 'main', side: 'sell', qty: 800_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 800_000, estimate: 99.78, settleDate: '2026-11-12', calendar: 'USBOND',
          gross: 798_240, // 800,000 x 99.78 / 100
          accrued: 0, cash: 798_240, fees: 79.82 }] }, // 1 bp of 798,240 = 79.824
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 800_000, avgPrice: 99.78 }] },
        // Realized: 798,240 - 800,000 x 99.60% = 798,240 - 796,800 = 1,440: the discount earned on the part sold.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 800,000 HALV-ZERO-NOV26 @ 99.78 USD (realized 1,440.00 USD)' }],
        cash: { account: { USD: { settled: 507_800.80, unsettled: 798_160.18, availableToTrade: 1_305_960.98 } } }, // 798,240 - 79.82
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, cost: 1_195_200, avgCost: 99.6, price: 99.805, value: 1_197_660, unrealized: 2_460 }], // 1,200,000 x 99.805%
        holdings: { main: { long: 1_200_000, short: 0, net: 1_200_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-11-12', amount: 798_160.18, into: 'cash' }],
        pnl: { account: { realized: 1_440, commissions: -279.02, unrealized: 2_460, total: 3_620.98 } }, // 199.20 + 79.82
        nav: { account: 2_503_620.98, book: 3_003_620.98 },
        balance: { account: { cash: 507_800.80, receivable: 798_160.18, positions: 1_197_660, assets: 2_503_620.98, liabilities: 0, netAssets: 2_503_620.98 } },
      },
    },
    {
      id: 'settle-reduce', covers: ['settlement', 'market holiday'], action: 'clock', to: EST('2026-11-12'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 798,160.18 USD into settled cash', cash: { USD: 798_160.18 } }],
        cash: { account: { USD: { settled: 1_305_960.98, unsettled: 0, availableToTrade: 1_305_960.98 } } },
        pending: [],
        balance: { account: { cash: 1_305_960.98, receivable: null, assets: 2_503_620.98 } },
      },
    },
    { id: 'thanksgiving-eve', action: 'clock', to: EST('2026-11-25'), expect: { events: [] } },
    {
      // Wednesday 25 Nov: T+1 skips Thanksgiving and lands on Friday 27 Nov, after the 26 Nov maturity date.
      id: 'buy-settling-after-maturity', covers: 'maturity', action: 'ticket', instrument: 'main', side: 'buy', qty: 100_000,
      status: 'blocked', reason: 'A debt security trades only for settlement before its maturity date; this purchase would settle after it is redeemed.',
      expect: { refused: 'matures on 2026-11-26; this trade would settle on 2026-11-27, after it is redeemed' },
    },
    {
      // Friday 27 Nov: redeemed at par. Realized 1,200,000 - 1,195,200 = 4,800.
      id: 'maturity', covers: ['maturity', 'close', 'market holiday'], action: 'clock', to: EST('2026-11-27'),
      expect: {
        events: [
          { type: 'bond.redemption', summary: 'Redeemed at maturity: 1,200,000 HALV-ZERO-NOV26 at 100.00% of par', owner: 'account' },
          { type: 'settlement.receive', summary: 'received 1,200,000.00 USD into settled cash', cash: { USD: 1_200_000 } },
        ],
        cash: { account: { USD: { settled: 2_505_960.98, unsettled: 0, availableToTrade: 2_505_960.98 } }, treasury: { USD: { settled: 500_000 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        lifecycle: [],
        // Discount earned in all: 1,440 + 4,800 = 6,240, all realized; commissions 279.02.
        pnl: { account: { realized: 6_240, couponInterest: 0, commissions: -279.02, unrealized: 0, total: 5_960.98 } },
        nav: { account: 2_505_960.98, book: 3_005_960.98 },
        balance: { account: { cash: 2_505_960.98, positions: null, assets: 2_505_960.98, liabilities: 0, netAssets: 2_505_960.98 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// perpetual_bond
// ---------------------------------------------------------------------------------------------
// A utility's perpetual hybrid notes: 6.125% semi-annual on 15 March and 15 September, 30/360, NO maturity
// (registered as perpetual, with one coupon date to anchor the schedule), callable by the issuer at par on
// coupon dates from 15 September 2027. T+1 on the US bond calendar, pieces of 1,000.
// The catalog: no maturity; coupons continue until sold or called; a call is recorded by hand. So:
//   - after the purchase only the next coupon is scheduled: no redemption, ever;
//   - 300,000 is sold before the coupon (cost at the average, accrued interest sold);
//   - the 15 September coupon is paid on the 700,000 settled before it, and the next one is scheduled;
//   - the issuer exercises its first call: recorded by hand on the position (Lifecycle, Early redemption at 100)
//     on the call date, after the coupon; nothing is accrued on the first day of a period, so par alone is paid.
// Days of 30/360 from 15 March 2027: to 10 Sep 175, to 13 Sep 178. One 30/360 day at 6.125% on 1,000,000 is 170.1389.
// Commission: 1 basis point of clean principal (none on the call).
const perpetualBond = {
  productId: 'perpetual_bond',
  title: 'Ardent Utilities 6.125% perpetual hybrid notes: no maturity scheduled, a partial sale, a coupon, the issuer call recorded by hand at par',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    manualInputs: ['Registration: Perpetual (no maturity) and one coupon date to anchor the schedule', 'Issuer call: early redemption price 100, face amount and label, recorded on the position (Lifecycle, Early redemption)'],
    settlement: 'T+1 on the US bond calendar; the call is paid on the day it is recorded',
    lifecycle: 'Daily accrual on 30/360; semi-annual coupons scheduled one at a time with no end; no maturity or redemption task; a call recorded by hand closes the position and cancels the next coupon',
    accounting: 'Clean cost at average; accrued interest bought and sold through Accrued income; coupon income separate; realized P&L on the sale and on the call',
    collateral: 'None for a long position',
  },
  start: EDT('2027-09-09'), // Thursday
  settlementCheck: { lag: 1, holidays: [] },
  book: {
    name: 'Matrix perpetual bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 1_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 1 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'perpetual_bond', name: 'Ardent Utilities Inc 6.125% Fixed Rate Perpetual Notes', symbol: 'ARDENT-6.125-PERP', marketView: 'US_CASH', venueType: 'otc', issuer: 'Ardent Utilities Inc', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.06125, frequency: 2, perpetual: true, anchorDate: '2025-03-15', issueDate: '2025-03-15', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Junior subordinated (hybrid)' } },
  },
  quotes: { main: { bid: 99.4, ask: 99.6, last: 99.5, bidSize: 5_000_000, askSize: 5_000_000 } },
  expectAtStart: { ...startState(1_500_000, 500_000), cash: { account: usdCash(1_500_000), treasury: usdCash(500_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 99.6, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-09-10', calendar: 'USBOND',
            gross: 996_000, // 1,000,000 x 99.60 / 100
            accrued: 29_774.31, // settles 10 Sep, 175 days of 30/360: 1,000,000 x 6.125% x 175/360 = 29,774.306
            cash: -1_025_774.31, fees: 99.6 }], // 1 bp of 996,000
          cash: { USD: { purchases: 1_025_774.31, fees: 99.6, required: 1_025_873.91, available: 1_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 99.6, fills: [{ qty: 1_000_000, price: 99.6, model: 'quoted-bid-ask', settleDate: '2027-09-10', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 ARDENT-6.125-PERP @ 99.60 USD', owner: 'account', date: '2027-09-09' }],
        cash: { account: { USD: { settled: 1_500_000, unsettled: -1_025_873.91, availableToTrade: 474_126.09 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 99.6, cost: 996_000, price: 99.5,
          value: 995_000, unrealized: -1_000, accrued: 29_774.31, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-09-10', amount: -1_025_873.91, ccy: 'USD', into: 'cash' }],
        // Only the next coupon (15 Sep 2027, a Wednesday). A perpetual has no maturity: no redemption is scheduled.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-09-15', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -99.6, fees: 0, borrowFunding: 0, unrealized: -1_000, total: -1_099.60 } },
        nav: { account: 1_498_900.40, book: 1_998_900.40 },
        balance: { account: { cash: 1_500_000, accruedIncome: 29_774.31, positions: 995_000, payable: 1_025_873.91, assets: 2_524_774.31, liabilities: 1_025_873.91, netAssets: 1_498_900.40 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2027-09-10'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,025,873.91 USD from settled cash', cash: { USD: -1_025_873.91 }, date: '2027-09-10' }],
        cash: { account: { USD: { settled: 474_126.09, unsettled: 0, availableToTrade: 474_126.09 } } },
        pending: [],
        balance: { account: { cash: 474_126.09, payable: null, assets: 1_498_900.40, liabilities: 0 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 300_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 300_000, estimate: 99.4, settleDate: '2027-09-13',
          gross: 298_200, // 300,000 x 99.40 / 100
          accrued: 9_085.42, // settles Monday 13 Sep, 178 days: 300,000 x 6.125% x 178/360 = 9,085.417
          cash: 307_285.42, fees: 29.82 }] }, // 1 bp of 298,200
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 300_000, avgPrice: 99.4 }] },
        // Realized 298,200 - 300,000 x 99.60% = -600.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 300,000 ARDENT-6\.125-PERP @ 99\.40 USD \(realized [-−]600\.00 USD\)$/ }],
        cash: { account: { USD: { settled: 474_126.09, unsettled: 307_255.60, availableToTrade: 781_381.69 } } }, // 307,285.42 - 29.82
        positions: [{ instrument: 'main', lot: 'lot', qty: 700_000, cost: 697_200, avgCost: 99.6, price: 99.5, value: 696_500, unrealized: -700, accrued: 20_688.89 }], // 29,774.31 - 9,085.42
        holdings: { main: { long: 700_000, short: 0, net: 700_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-09-13', amount: 307_255.60, into: 'cash' }],
        pnl: { account: { realized: -600, commissions: -129.42, unrealized: -700, total: -1_429.42 } },
        nav: { account: 1_498_570.58, book: 1_998_570.58 },
        balance: { account: { cash: 474_126.09, receivable: 307_255.60, accruedIncome: 20_688.89, positions: 696_500, assets: 1_498_570.58, liabilities: 0, netAssets: 1_498_570.58 } },
      },
    },
    {
      // Wednesday 15 Sep. The sale settled on Monday. The coupon of 15 Sep on the 700,000 settled before it: 700,000 x 3.0625% =
      // 21,437.50. On the books 20,688.89: 748.61 more (three days on 1,000,000 to 13 Sep, 510.42, and two on 700,000, 238.19).
      // The next coupon is scheduled; still no redemption.
      id: 'coupon', covers: ['coupon', 'settlement'], action: 'clock', to: EDT('2027-09-15'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 307,255.60 USD into settled cash', cash: { USD: 307_255.60 } },
          { type: 'bond.coupon', summary: 'Coupon received on 700,000 ARDENT-6.125-PERP: 21,437.50 USD', cash: { USD: 21_437.50 }, owner: 'account', date: '2027-09-15' },
          { type: 'accrual.coupon', summary: 'Interest accrued on ARDENT-6.125-PERP: 748.61 USD' },
        ],
        cash: { account: { USD: { settled: 802_819.19, unsettled: 0, availableToTrade: 802_819.19 } } }, // 474,126.09 + 307,255.60 + 21,437.50
        positions: [{ instrument: 'main', lot: 'lot', qty: 700_000, accrued: 0 }],
        pending: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-03-15', status: 'pending' }],
        pnl: { account: { couponInterest: 748.61, total: -680.81 } },
        nav: { account: 1_499_319.19, book: 1_999_319.19 }, // 802,819.19 + 696,500
        balance: { account: { cash: 802_819.19, receivable: null, accruedIncome: null, assets: 1_499_319.19, netAssets: 1_499_319.19 } },
      },
    },
    {
      // The issuer calls the notes at par on the first call date, recorded by hand. Paid today; no accrued interest (first day of
      // the period). Realized 700,000 - 697,200 = 2,800. The scheduled coupon of 15 March 2028 is cancelled.
      id: 'issuer-call', covers: ['call (by hand)', 'close'], action: 'lifecycle', lot: 'lot', body: { action: 'redeem', price: 100, face: 700_000, label: 'Issuer call at par on the first call date' },
      expect: {
        events: [
          { type: 'bond.early_redemption', summary: 'Issuer call at par on the first call date: 700,000 ARDENT-6.125-PERP at 100.00% of par', owner: 'account', date: '2027-09-15' },
          { type: 'settlement.receive', summary: 'received 700,000.00 USD into settled cash', cash: { USD: 700_000 } },
        ],
        cash: { account: { USD: { settled: 1_502_819.19, unsettled: 0, availableToTrade: 1_502_819.19 } }, treasury: { USD: { settled: 500_000 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        lifecycle: [],
        pnl: { account: { realized: 2_200, couponInterest: 748.61, commissions: -129.42, unrealized: 0, total: 2_819.19 } }, // -600 + 2,800
        nav: { account: 1_502_819.19, book: 2_002_819.19 },
        balance: { account: { cash: 1_502_819.19, positions: null, accruedIncome: null, assets: 1_502_819.19, liabilities: 0, netAssets: 1_502_819.19 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// subordinated_debt
// ---------------------------------------------------------------------------------------------
// A bank's Tier 2 subordinated notes (ranking behind senior creditors, ahead of shareholders): 5.875%,
// coupons 15 June and 15 December, 30/360, T+1 on the US bond calendar, pieces of 1,000. A credit desk SELLS
// THEM SHORT against a securities borrow (fee 0.75% a year: subordinated paper is dearer to borrow than
// senior), carries the short over the 15 December coupon, which it pays to the lender, and covers in two parts.
// The short-sale rules are those of bond-government.mjs (treasury_bond), restated:
//   - The seller receives principal plus accrued interest; the accrued coupon is owed (a negative accrued
//     balance) and its growth is an interest cost. On the coupon date the short pays the full coupon.
//   - Sale proceeds settle into restricted cash; at each end of day the collateral is marked to 102% of the
//     clean value at the last price plus the accrued coupon owed. 30% of the clean value at the last price is
//     reserved from free cash. Neither is buying power or withdrawable.
//   - The borrow fee accrues per calendar day on the clean value at that day's last price, ACT/360, and is paid
//     when the borrow is fully returned. A cover is paid from restricted cash first.
// Days of 30/360 from 15 June 2027: to 8 Dec 173. A full coupon is 2.9375 per 100: 29,375 on 1,000,000.
// One fee day at 97.60 on 1,000,000: 976,000 x 0.75% / 360 = 20.3333. Commission: 1 basis point of clean principal.
const subordinatedDebt = {
  productId: 'subordinated_debt',
  title: 'Brightwater Bank 5.875% Tier 2 subordinated notes due 15 June 2034: sold short against a borrow, coupon paid to the lender, covered in two parts',
  matrix: {
    ticket: 'Instrument drawer, Trade tab: Sell short (adds the securities borrow leg), then Buy to cover; the Close button of the short position',
    requiredFields: ['Account', 'Action (Sell short / Buy to cover)', 'Face amount (a multiple of 1,000)'],
    automaticInputs: ['bid, ask, last in % of par (quote fixture)', 'borrow availability and fee (borrow fixture standing in for Shaffer MarketData)', 'accrued interest received on the short sale and paid on the covers', 'collateral and margin from the Book short assumptions', 'settlement date', 'commission'],
    manualInputs: ['none'],
    settlement: 'T+1 on the US bond calendar; sale proceeds (principal plus accrued) settle into restricted cash; covers are paid from restricted cash first',
    lifecycle: 'Coupon paid to the lender on the face sold short; daily borrow fee; collateral marked each end of day to 102% of clean value plus accrued owed; fee paid when the borrow is returned',
    accounting: 'Short position at negative clean cost; accrued coupon owed as a negative accrued balance; coupon paid and accrued received and paid net to an interest cost; borrow fee under borrowing and funding; realized P&L on the covers',
    collateral: 'Restricted cash = 102% of market value including accrued owed, marked daily; 30% margin reserve; neither is buying power or withdrawable',
  },
  start: EST('2027-12-07'), // Tuesday
  settlementCheck: { lag: 1, holidays: [] },
  book: {
    name: 'Matrix subordinated debt', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 1 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'subordinated_debt', name: 'Brightwater Bank Corp 5.875% Subordinated Notes 15-Jun-2034', symbol: 'BRIGHT-5.875-34', marketView: 'US_CASH', venueType: 'otc', issuer: 'Brightwater Bank Corp', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.05875, frequency: 2, maturity: '2034-06-15', issueDate: '2024-06-15', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Subordinated (Tier 2)' } },
  },
  quotes: { main: { bid: 97.5, ask: 97.7, last: 97.6, bidSize: 5_000_000, askSize: 5_000_000 } },
  borrow: { main: { available: true, quantity: 5_000_000, feeRate: 0.0075 } },
  expectAtStart: { ...startState(2_000_000, 1_000_000), cash: { account: usdCash(2_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'short', covers: ['borrow', 'short'], action: 'ticket', instrument: 'main', side: 'sell_short', qty: 1_000_000, as: 'short',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'borrow_sec', action: 'borrow_sec', instrument: 'main', qty: 1_000_000, borrow: { available: true, feeRate: 0.0075, dailyCost: 20.33, source: 'Test fixture' } }, // 1,000,000 x 97.60% x 0.75% / 360
            { kind: 'trade', action: 'sell_short', instrument: 'main', qty: 1_000_000, estimate: 97.5, model: 'quoted-bid-ask', settleDate: '2027-12-08', calendar: 'USBOND', dependsOn: [1],
              gross: 975_000, // 1,000,000 x 97.50 / 100
              accrued: 28_232.64, // settles 8 Dec, 173 days of 30/360: 1,000,000 x 5.875% x 173/360 = 28,232.639
              cash: 1_003_232.64, fees: 97.5, // 1 bp of 975,000
              shortCollateral: { topUp: 20_064.65, marginHold: 300_969.79 } }, // 2% and 30% of the 1,003,232.64 proceeds
          ],
          cash: { USD: { purchases: 0, proceeds: 0, restrictedProceeds: 1_003_232.64, fees: 97.5, collateral: 20_064.65, margin: 300_969.79, required: 321_131.94, available: 2_000_000, shortfall: 0 } }, // 97.50 + 20,064.65 + 300,969.79
        },
        result: { status: 'open', orders: [
          { kind: 'borrow_sec', status: 'filled', filledQty: 1_000_000 },
          { kind: 'trade', action: 'sell_short', status: 'filled', filledQty: 1_000_000, avgPrice: 97.5, fills: [{ qty: 1_000_000, price: 97.5, model: 'quoted-bid-ask', settleDate: '2027-12-08', source: 'Test fixture' }] },
        ] },
        events: [{ type: 'strategy.submitted' }, { type: 'secloan.borrow', summary: 'Borrowed 1,000,000 BRIGHT-5.875-34 at a fee of 0.750% p.a.' }, { type: 'trade.fill', summary: 'Sold short 1,000,000 BRIGHT-5.875-34 @ 97.50 USD', owner: 'account', date: '2027-12-07' }],
        // Proceeds 1,003,232.64 less 97.50 commission arrive tomorrow as restricted cash. Reserve: 30% x 1,000,000 x 97.60% = 292,800.
        cash: { account: { USD: { settled: 2_000_000, unsettled: 1_003_135.14, restricted: 0, reserved: 292_800, availableToTrade: 1_707_200, availableToWithdraw: 1_707_200 } } },
        positions: [
          { instrument: 'borrow:main', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 1_000_000, value: 976_000, accrued: 0 },
          { instrument: 'main', lot: 'short', owner: 'account', direction: 'short', qty: -1_000_000, avgCost: 97.5, cost: -975_000, price: 97.6, value: -976_000, unrealized: -1_000, restrictedCash: 0,
            accrued: -28_232.64 }, // the accrued coupon received from the buyer is owed
        ],
        holdings: { main: { long: 0, short: 1_000_000, net: -1_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-12-08', amount: 1_003_135.14, into: 'cash.restricted' }],
        // Coupon Wednesday 15 Dec; borrow fee on the first business day of January (1 Jan 2028 is a Saturday: Monday 3 Jan); maturity Thursday 15 Jun 2034.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-12-15', status: 'pending' }, { type: 'secloan.fee', instrument: 'borrow:main', dueDate: '2028-01-03', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-06-15', status: 'pending' }],
        borrowings: [{ owner: 'account', family: 'secloan', instrument: 'main', lot: 'short', qty: 1_000_000, value: 976_000, rate: 0.0075, accrued: 0, collateralCash: null, nextPayment: '2028-01-03' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -97.5, fees: 0, borrowFunding: 0, unrealized: -1_000, total: -1_097.50 } },
        nav: { account: 1_998_902.50, book: 2_998_902.50 },
        balance: { account: { cash: 2_000_000, receivable: 1_003_135.14, accruedIncome: -28_232.64, positions: -976_000, netAssets: 1_998_902.50 } },
      },
    },
    {
      // Wednesday 8 Dec: the proceeds settle into restricted cash. End of day 7 Dec: collateral required 102% x (976,000 clean +
      // 28,232.64 accrued owed) = 102% x 1,004,232.64 = 1,024,317.29; held 1,003,135.14; 21,182.15 posted from settled cash.
      id: 'settle-short', covers: ['settlement', 'collateral mark'], action: 'clock', to: EST('2027-12-08'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 1,003,135.14 USD into restricted cash' },
          { type: 'collateral.mark', summary: 'Short collateral on BRIGHT-5.875-34 marked to market: posted 21,182.15 USD', cash: { USD: -21_182.15 } },
        ],
        cash: { account: { USD: { settled: 1_978_817.85, unsettled: 0, restricted: 1_024_317.29, reserved: 292_800, availableToTrade: 1_686_017.85, availableToWithdraw: 1_686_017.85 } } },
        positions: [{ instrument: 'borrow:main', qty: 1_000_000, value: 976_000 }, { instrument: 'main', qty: -1_000_000, value: -976_000, unrealized: -1_000, restrictedCash: 1_024_317.29, accrued: -28_232.64 }],
        pending: [],
        borrowings: [{ instrument: 'main', qty: 1_000_000, value: 976_000, accrued: 0, collateralCash: 1_024_317.29 }],
        balance: { account: { cash: 1_978_817.85, restricted: 1_024_317.29, receivable: null, accruedIncome: -28_232.64, positions: -976_000, netAssets: 1_998_902.50 } },
      },
    },
    {
      // Wednesday 15 Dec. In order: the coupon of 15 Dec is paid to the lender on the 1,000,000 sold short: 29,375.00. The accrued owed,
      // 28,232.64, falls 1,142.36 short of it (the interest cost from 8 to 15 Dec). Then the end of day of 14 Dec: borrow fee for
      // seven days at 97.60, 7 x 20.3333 = 142.33; collateral with nothing owed: 102% x 976,000 = 995,520.00; 28,797.29 released.
      id: 'coupon-paid-to-lender', covers: ['coupon', 'borrow fee', 'collateral mark'], action: 'clock', to: EST('2027-12-15'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon paid on 1,000,000 BRIGHT-5.875-34 sold short: 29,375.00 USD', cash: { USD: -29_375 }, owner: 'account', date: '2027-12-15' },
          { type: 'accrual.coupon', summary: 'Interest cost accrued on BRIGHT-5.875-34: 1,142.36 USD' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000,000 BRIGHT-5.875-34: 142.33 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on BRIGHT-5.875-34 marked to market: released 28,797.29 USD', cash: { USD: 28_797.29 } },
        ],
        cash: { account: { USD: { settled: 1_978_240.14, restricted: 995_520, reserved: 292_800, availableToTrade: 1_685_440.14, availableToWithdraw: 1_685_440.14 } } }, // 1,978,817.85 - 29,375 + 28,797.29
        positions: [{ instrument: 'borrow:main', qty: 1_000_000, accrued: -142.33 }, { instrument: 'main', qty: -1_000_000, restrictedCash: 995_520, accrued: 0 }],
        lifecycle: [{ type: 'secloan.fee', instrument: 'borrow:main', dueDate: '2028-01-03', status: 'pending' }, { type: 'bond.coupon', instrument: 'main', dueDate: '2028-06-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-06-15', status: 'pending' }],
        borrowings: [{ instrument: 'main', qty: 1_000_000, accrued: 142.33, costToDate: 142.33, collateralCash: 995_520 }],
        // Interest cost so far: 29,375 paid less 28,232.64 received with the sale = 1,142.36.
        pnl: { account: { couponInterest: -1_142.36, borrowFunding: -142.33, total: -2_382.19 } },
        nav: { account: 1_997_617.81, book: 2_997_617.81 },
        balance: { account: { cash: 1_978_240.14, restricted: 995_520, accruedIncome: null, accruedExpense: 142.33, netAssets: 1_997_617.81 } },
      },
    },
    {
      // Settled 1,978,240.14, of which 292,800 is reserved; the 995,520 of restricted collateral is not the Account's to move.
      id: 'withdraw-restricted-cash', covers: 'restricted proceeds', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 1_900_000,
      status: 'blocked', reason: 'Restricted collateral and the margin reserve cannot leave the Account.',
      expect: { refused: 'Alpha has 1,685,440.14 USD of settled USD available; 1,900,000.00 USD requested' },
    },
    {
      id: 'quote-down', action: 'quote', instrument: 'main', quote: { bid: 96.8, ask: 97, last: 96.9, bidSize: 5_000_000, askSize: 5_000_000 },
      expect: {
        positions: [{ instrument: 'borrow:main', qty: 1_000_000, value: 969_000 }, { instrument: 'main', qty: -1_000_000, price: 96.9, value: -969_000, unrealized: 6_000 }], // 975,000 - 969,000
        borrowings: [{ instrument: 'main', qty: 1_000_000, value: 969_000, accrued: 142.33 }],
        pnl: { account: { unrealized: 6_000, total: 4_617.81 } }, // -97.50 - 1,142.36 - 142.33 + 6,000
        nav: { account: 2_004_617.81, book: 3_004_617.81 },
        balance: { account: { positions: -969_000, netAssets: 2_004_617.81 } },
      },
    },
    {
      id: 'cover-part', covers: ['cover', 'return', 'borrow fee'], action: 'ticket', instrument: 'main', side: 'buy_to_cover', qty: 400_000, from: 'short',
      expect: {
        preview: { blocking: 0, errors: [], legs: [
          { kind: 'trade', action: 'buy_to_cover', qty: 400_000, estimate: 97, settleDate: '2027-12-16',
            gross: 388_000, // 400,000 x 97.00 / 100
            accrued: 65.28, // settles 16 Dec, 1 day of 30/360: 400,000 x 5.875% / 360 = 65.278
            cash: -388_065.28, fees: 38.8 }, // 1 bp of 388,000
          { kind: 'return_sec', action: 'return_sec', qty: 400_000, dependsOn: [1] },
        ] },
        result: { status: 'open', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 400_000, avgPrice: 97 }, { kind: 'return_sec', status: 'filled', filledQty: 400_000 }] },
        // Realized: 400,000 x (97.50 - 97.00)% = 2,000. Fee for today at the current price: 1,000,000 x 96.90% x 0.75% / 360 = 20.1875;
        // in all 142.3333 + 20.1875 = 162.5208 -> 162.52, so 20.19 is added.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought to cover 400,000 BRIGHT-5.875-34 @ 97.00 USD (realized 2,000.00 USD)' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000,000 BRIGHT-5.875-34: 20.19 USD' },
          { type: 'secloan.return', summary: 'Returned 400,000 borrowed BRIGHT-5.875-34' },
        ],
        // Owed for the cover: 388,065.28 + 38.80 = 388,104.08. Reserve: 30% x 600,000 x 96.90% = 174,420.
        cash: { account: { USD: { settled: 1_978_240.14, unsettled: -388_104.08, restricted: 995_520, reserved: 174_420, availableToTrade: 1_415_716.06, availableToWithdraw: 1_415_716.06 } } },
        positions: [
          { instrument: 'borrow:main', qty: 600_000, value: 581_400, accrued: -162.52 }, // 600,000 x 96.90%
          { instrument: 'main', qty: -600_000, cost: -585_000, avgCost: 97.5, price: 96.9, value: -581_400, unrealized: 3_600, restrictedCash: 995_520,
            accrued: 65.28 }, // the interest bought with the cover
        ],
        holdings: { main: { long: 0, short: 600_000, net: -600_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-12-16', amount: -388_104.08, into: 'cash.restricted' }],
        borrowings: [{ instrument: 'main', qty: 600_000, value: 581_400, accrued: 162.52, costToDate: 162.52, collateralCash: 995_520 }],
        pnl: { account: { realized: 2_000, couponInterest: -1_142.36, borrowFunding: -162.52, commissions: -136.30, unrealized: 3_600, total: 4_158.82 } }, // 97.50 + 38.80
        nav: { account: 2_004_158.82, book: 3_004_158.82 },
        balance: { account: { cash: 1_978_240.14, restricted: 995_520, accruedIncome: 65.28, positions: -581_400, payable: 388_104.08, accruedExpense: 162.52, netAssets: 2_004_158.82 } },
      },
    },
    {
      // Thursday 16 Dec: the cover is paid from restricted cash, 995,520 - 388,104.08 = 607,415.92 left. End of day 15 Dec: the interest
      // owed to 15 Dec is nil (first day of the period) and the 65.28 bought runs to 16 Dec: nothing to book; no fee day (the fee
      // already stands at 15 Dec). Collateral for the 600,000 still short, nothing owed: 102% x 581,400 = 593,028.00; 14,387.92 released.
      id: 'settle-cover-part', covers: ['settlement', 'collateral mark'], action: 'clock', to: EST('2027-12-16'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 388,104.08 USD from restricted cash' },
          { type: 'collateral.mark', summary: 'Short collateral on BRIGHT-5.875-34 marked to market: released 14,387.92 USD', cash: { USD: 14_387.92 } },
        ],
        cash: { account: { USD: { settled: 1_992_628.06, unsettled: 0, restricted: 593_028, reserved: 174_420, availableToTrade: 1_818_208.06, availableToWithdraw: 1_818_208.06 } } },
        positions: [{ instrument: 'borrow:main', qty: 600_000 }, { instrument: 'main', qty: -600_000, restrictedCash: 593_028, accrued: 65.28 }],
        borrowings: [{ instrument: 'main', qty: 600_000, accrued: 162.52, collateralCash: 593_028 }],
        pending: [],
        balance: { account: { cash: 1_992_628.06, restricted: 593_028, accruedIncome: 65.28, payable: null, netAssets: 2_004_158.82 } },
      },
    },
    {
      id: 'cover-rest', covers: ['cover', 'return', 'close', 'borrow fee'], action: 'close', lot: 'short', scope: 'position', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [
          { kind: 'trade', action: 'buy_to_cover', qty: 600_000, estimate: 97, settleDate: '2027-12-17',
            gross: 582_000, // 600,000 x 97.00 / 100
            accrued: 195.83, // settles 17 Dec, 2 days: 600,000 x 5.875% x 2/360 = 195.833
            cash: -582_195.83, fees: 58.2 }, // 1 bp of 582,000
          { kind: 'return_sec', action: 'return_sec', qty: 600_000, dependsOn: [1] },
        ] },
        result: { status: 'closed', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 600_000, avgPrice: 97 }, { kind: 'return_sec', status: 'filled', filledQty: 600_000 }] },
        // Realized: 585,000 - 582,000 = 3,000. Interest: 65.28 + 195.83 bought on the covers against nothing owed: 261.11 of cost (the day
        // to 16 Dec on 1,000,000, 163.19, and the day to 17 Dec on 600,000, 97.92). Fee for one more day on 600,000 at 96.90: 12.1125;
        // in all 174.6333 -> 174.63, so 12.11 is added, and the whole 174.63 is paid now.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought to cover 600,000 BRIGHT-5.875-34 @ 97.00 USD (realized 3,000.00 USD)' },
          { type: 'accrual.coupon', summary: 'Interest cost to disposal of BRIGHT-5.875-34: 261.11 USD' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 600,000 BRIGHT-5.875-34: 12.11 USD' },
          { type: 'secloan.return', summary: 'Returned 600,000 borrowed BRIGHT-5.875-34' },
          { type: 'interest.payment', summary: /Borrow fee paid on Borrow of BRIGHT-5\.875-34.*: 174\.63 USD/, cash: { USD: -174.63 } },
        ],
        cash: { account: { USD: { settled: 1_992_453.43, unsettled: -582_254.03, restricted: 593_028, reserved: 0, availableToTrade: 1_410_199.40, availableToWithdraw: 1_410_199.40 } } }, // 1,992,628.06 - 174.63; 582,195.83 + 58.20 owed
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2027-12-17', amount: -582_254.03, into: 'cash.restricted' }],
        lifecycle: [],
        borrowings: [],
        // Interest cost in all: 29,375 coupon + 65.28 + 195.83 paid on the covers - 28,232.64 received on the sale = 1,403.47.
        pnl: { account: { realized: 5_000, couponInterest: -1_403.47, borrowFunding: -174.63, commissions: -194.50, unrealized: 0, total: 3_227.40 } }, // 2,000 + 3,000; 136.30 + 58.20
        nav: { account: 2_003_227.40, book: 3_003_227.40 },
        balance: { account: { cash: 1_992_453.43, restricted: 593_028, positions: null, accruedIncome: null, payable: 582_254.03, accruedExpense: null, netAssets: 2_003_227.40 } },
      },
    },
    {
      // 593,028 - 582,254.03 = 10,773.97 of collateral is left with no short to secure: released.
      id: 'settle-cover-rest', covers: ['settlement', 'collateral release'], action: 'clock', to: EST('2027-12-17'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 582,254.03 USD from restricted cash' },
          { type: 'collateral.mark', summary: 'Short collateral on BRIGHT-5.875-34 marked to market: released 10,773.97 USD', cash: { USD: 10_773.97 } },
        ],
        cash: { account: { USD: { settled: 2_003_227.40, unsettled: 0, restricted: 0, reserved: 0, availableToTrade: 2_003_227.40, availableToWithdraw: 2_003_227.40 } }, treasury: { USD: { settled: 1_000_000 } } },
        pending: [],
        balance: { account: { cash: 2_003_227.40, restricted: null, payable: null, assets: 2_003_227.40, liabilities: 0, netAssets: 2_003_227.40 } },
      },
    },
  ],
};

export default [corporateBondIg, highYieldBond, eurobond, foreignMarketBond, corporateSukuk, floatingRateNote, zeroCouponBond, perpetualBond, subordinatedDebt];
