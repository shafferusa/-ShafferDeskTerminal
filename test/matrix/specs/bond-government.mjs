// Bond family (engine family "bond"), government and plain corporate group: 13 catalog products,
// one scenario each, on a fictional instrument registered as exactly that product with the terms a
// real instrument of that product has (day count, coupon frequency, settlement lag and calendar,
// currency, minimum denomination).
//
// Every expected number is a literal worked out by hand from the inputs stated in the same spec.
// The arithmetic is in the comment beside it. Nothing here is copied from what the Terminal prints.
//
// The rules these scenarios rely on (the Terminal's documented rules for debt securities, restated
// so the arithmetic can be followed):
//   - Quantity is face amount. A price is the clean price in percent of par. A market buy fills at
//     the ask, a market sell at the bid, of the quote in force.
//   - A trade settles principal (face x price / 100) plus the accrued interest to its SETTLEMENT
//     date, each rounded to the cent. Commission comes from the Book's fee schedule on the clean
//     principal and is expensed (it is not added to cost).
//   - Accrued interest per day count:
//       ACT/ACT (ICMA)  face x coupon / frequency x days since the last coupon date / days in the coupon period
//       30/360 (US)     face x coupon x days30 / 360, each month counted as 30 days
//       ACT/365         face x coupon x actual days / 365        ACT/360: the same over 360
//     A zero-coupon or discount instrument has none.
//   - The position is carried at cost (clean) with average cost, valued clean at the last price.
//     Accrued interest is a separate asset ("Accrued income"); its growth is coupon and interest
//     income, never realized or unrealized P&L. Selling part removes cost at the average.
//   - At the end of each business day D (17:00 New York, New York Stock Exchange days) the accrued balance is trued up
//     to: interest to D on the face settled by D, plus the interest bought (less the interest sold)
//     in trades that settle after D, which runs to their settlement dates. The change is income.
//     The end-of-day run happens once per clock move, for the latest day that has ended.
//   - A coupon is paid on its coupon date, moved to the next business day of the payment calendar,
//     to the face settled before the coupon date. Redemption is paid the same way at maturity.
//   - A fill books the position on trade date and leaves a payable or receivable; cash moves on
//     the settlement date.
//
// Clock: scenario instants are 10:00 New York unless a step says otherwise.

export const family = 'bond';

/** 10:00 in New York on a date in Eastern Standard Time (UTC-5): November to early March. */
const EST = (d) => `${d}T15:00:00.000Z`;

/** Fill assumptions every scenario states in full. Quotes here always carry a bid and an ask, so the half spread is not used. */
const FILL = { halfSpreadBps: { bond: 3 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const SHORT = { collateralPct: 1.02, marginPct: 0.3 };

/** State before any trade: capital deposited in Treasury, part of it funded to the Account (reporting currency amounts). */
const startState = (account, treasury) => ({
  positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [],
  nav: { account, treasury, book: account + treasury },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
});
const usdCash = (amount) => ({ USD: { settled: amount, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: amount } });

const BOND_TICKET = {
  ticket: 'Instrument drawer, Trade tab (security ticket: Account, Action, Face amount, order terms, Settlement), then the trade preview',
  requiredFields: ['Account', 'Action', 'Face amount'],
  automaticInputs: ['bid, ask, last in % of par (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model', 'accrued interest to the settlement date from the registered coupon terms', 'settlement date from the instrument convention and settlement calendar', 'commission from the Book fee schedule'],
};

// ---------------------------------------------------------------------------------------------
// treasury_note
// ---------------------------------------------------------------------------------------------
// A 4% US Treasury note, coupons 15 May and 15 November, ACT/ACT, T+1 on the US bond calendar,
// traded in multiples of 100 face. The scenario runs across Veterans Day (Wednesday 11 November
// 2026: the bond market is closed, the stock market is open) and across the 15 November coupon,
// which falls on a Sunday and is paid on Monday 16 November.
//
// Coupon periods: 15 May 2026 to 15 Nov 2026 is 184 days (17 + 30 + 31 + 31 + 30 + 31 + 14);
// 15 Nov 2026 to 15 May 2027 is 181 days. A full coupon is 2.00 per 100 face.
// Days from 15 May 2026: to 10 Nov 179, to 11 Nov 180, to 12 Nov 181, to 13 Nov 182.
// Commission: 0.2 basis points of clean principal.
const treasuryNote = {
  productId: 'treasury_note',
  title: 'US Treasury 4% note due 15 November 2030, bought between coupons, held over a bond-market holiday and a coupon',
  matrix: {
    ...BOND_TICKET,
    manualInputs: ['none: coupon schedule, accrued interest and settlement follow from the registered terms'],
    settlement: 'T+1 on the US bond calendar (Book setting settlement.bond = 1); Veterans Day is skipped; an order placed on the holiday waits and is matched the next bond-market day',
    lifecycle: 'Daily accrual into coupon income; semi-annual coupon paid on the next payment day after a Sunday coupon date to the face settled before it; next coupon and maturity scheduled',
    accounting: 'Clean cost at average; accrued interest bought and sold through Accrued income; coupon income separate from realized and unrealized P&L; commission expensed',
    collateral: 'None for a long position',
  },
  start: EST('2026-11-09'), // Monday
  settlementCheck: { lag: 1, holidays: ['2026-11-11'] }, // Veterans Day, a US bond-market holiday
  book: {
    name: 'Matrix Treasury note', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 3_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.2 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    // multiplier 0.01: a price is per 100 face. US Treasuries trade over the counter; the US bond calendar follows from the US Based view.
    main: { productId: 'treasury_note', name: 'US Treasury Note 4% 15-Nov-2030', symbol: 'UST-4-NOV30', marketView: 'US_CASH', venueType: 'otc', issuer: 'United States Treasury', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2, maturity: '2030-11-15', issueDate: '2023-11-15', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 100 } },
  },
  quotes: { main: { bid: 99.5, ask: 99.53125, last: 99.515625, bidSize: 50_000_000, askSize: 50_000_000 } }, // 99-16, 99-17, 99-16+
  expectAtStart: { ...startState(3_000_000, 2_000_000), cash: { account: usdCash(3_000_000), treasury: usdCash(2_000_000) } },
  steps: [
    {
      id: 'odd-denomination', covers: 'minimum denomination', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_050,
      status: 'blocked', reason: 'Treasury notes trade in multiples of 100 face; 1,000,050 is not one.',
      expect: { refused: 'quantity must be a multiple of 100' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 99.53125, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-11-10', calendar: 'USBOND',
            gross: 995_312.50, // 1,000,000 x 99.53125 / 100
            accrued: 19_456.52, // settles 10 Nov: 1,000,000 x 2% x 179/184 = 19,456.5217
            cash: -1_014_769.02, // 995,312.50 + 19,456.52
            fees: 19.91 }], // 0.2 bp of 995,312.50 = 19.90625
          cash: { USD: { purchases: 1_014_769.02, fees: 19.91, required: 1_014_788.93, available: 3_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 99.53125, fills: [{ qty: 1_000_000, price: 99.53125, model: 'quoted-bid-ask', settleDate: '2026-11-10', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 UST-4-NOV30 @ 99.53125 USD', owner: 'account', date: '2026-11-09' }],
        cash: { account: { USD: { settled: 3_000_000, unsettled: -1_014_788.93, availableToTrade: 1_985_211.07 } } }, // 1,014,769.02 + 19.91 owed until settlement
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 99.53125, cost: 995_312.50, price: 99.515625,
          value: 995_156.25, // 1,000,000 x 99.515625 / 100, clean
          unrealized: -156.25, accrued: 19_456.52, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-11-10', amount: -1_014_788.93, ccy: 'USD', into: 'cash' }],
        // The 15 Nov 2026 coupon date is a Sunday: paid Monday 16 Nov. Maturity 15 Nov 2030 is a Friday.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2026-11-16', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-11-15', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -19.91, fees: 0, borrowFunding: 0, unrealized: -156.25, total: -176.16 } },
        nav: { account: 2_999_823.84, book: 4_999_823.84 }, // 3,000,000 - 19.91 - 156.25: buying accrued interest is not a cost
        balance: { account: { cash: 3_000_000, accruedIncome: 19_456.52, positions: 995_156.25, payable: 1_014_788.93, assets: 4_014_612.77, liabilities: 1_014_788.93, netAssets: 2_999_823.84 } },
      },
    },
    {
      // End of day 9 Nov: nothing has settled; the interest bought runs to 10 Nov and is already on the books. No income yet.
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2026-11-10'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,014,788.93 USD from settled cash', cash: { USD: -1_014_788.93 }, date: '2026-11-10' }],
        cash: { account: { USD: { settled: 1_985_211.07, unsettled: 0, availableToTrade: 1_985_211.07 } } },
        pending: [],
        balance: { account: { cash: 1_985_211.07, payable: null, assets: 2_999_823.84, liabilities: 0 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 99.75, ask: 99.78125, last: 99.765625, bidSize: 50_000_000, askSize: 50_000_000 }, // 99-24, 99-25, 99-24+
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, price: 99.765625, value: 997_656.25, unrealized: 2_343.75 }], // 997,656.25 - 995,312.50
        pnl: { account: { unrealized: 2_343.75, total: 2_323.84 } },
        nav: { account: 3_002_323.84, book: 5_002_323.84 },
        balance: { account: { positions: 997_656.25, assets: 3_002_323.84, netAssets: 3_002_323.84 } },
      },
    },
    {
      // Tuesday 10 Nov. T+1 would be Wednesday 11 Nov, Veterans Day: the bond market is closed, so the trade settles Thursday 12 Nov.
      id: 'increase', covers: ['increase', 'market holiday'], action: 'resize', lot: 'lot', factor: 1.6, // 1,000,000 -> 1,600,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 600_000, estimate: 99.78125, settleDate: '2026-11-12', calendar: 'USBOND',
          gross: 598_687.50, // 600,000 x 99.78125 / 100
          accrued: 11_804.35, // settles 12 Nov: 600,000 x 2% x 181/184 = 11,804.3478
          cash: -610_491.85, fees: 11.97 }], // 0.2 bp of 598,687.50 = 11.97375
          cash: { USD: { purchases: 610_491.85, fees: 11.97, required: 610_503.82, available: 1_985_211.07, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 600_000, avgPrice: 99.78125, fills: [{ qty: 600_000, price: 99.78125, settleDate: '2026-11-12' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 600,000 UST-4-NOV30 @ 99.78125 USD' }],
        cash: { account: { USD: { settled: 1_985_211.07, unsettled: -610_503.82, availableToTrade: 1_374_707.25 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_600_000,
          cost: 1_594_000, // 995,312.50 + 598,687.50
          avgCost: 99.625, // 1,594,000 / 1,600,000 x 100
          price: 99.765625, value: 1_596_250, // 1,600,000 x 99.765625 / 100
          unrealized: 2_250, accrued: 31_260.87 }], // 19,456.52 + 11,804.35
        holdings: { main: { long: 1_600_000, short: 0, net: 1_600_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-11-12', amount: -610_503.82, into: 'cash' }],
        pnl: { account: { commissions: -31.88, unrealized: 2_250, total: 2_218.12 } }, // 19.91 + 11.97
        nav: { account: 3_002_218.12, book: 5_002_218.12 },
        balance: { account: { cash: 1_985_211.07, accruedIncome: 31_260.87, positions: 1_596_250, payable: 610_503.82, assets: 3_612_721.94, liabilities: 610_503.82, netAssets: 3_002_218.12 } },
      },
    },
    {
      // Veterans Day morning. End of day 10 Nov: 1,000,000 settled, interest to 10 Nov 19,456.5217; 600,000 unsettled,
      // interest to 12 Nov 11,804.3478; total 31,260.87, which is what is on the books. No income, and nothing settles today.
      id: 'holiday-morning', covers: 'market holiday', action: 'clock', to: EST('2026-11-11'),
      expect: { events: [] },
    },
    {
      // An order placed on the bond-market holiday is accepted, says so, and waits: it is matched on Thursday 12 Nov
      // and settles T+1 from then, Friday 13 Nov.
      id: 'holiday-sell', covers: ['reduce', 'market holiday'], action: 'ticket', instrument: 'main', side: 'sell', qty: 400_000, from: 'lot', settlementCheck: false,
      expect: {
        preview: { blocking: 0, errors: [], warnings: ['not-trading-day'], legs: [{ kind: 'trade', action: 'sell', qty: 400_000, estimate: 99.75, settleDate: '2026-11-13',
          gross: 399_000, // 400,000 x 99.75 / 100
          accrued: 7_913.04, // settles 13 Nov: 400,000 x 2% x 182/184 = 7,913.0435
          cash: 406_913.04, fees: 7.98 }] }, // 0.2 bp of 399,000
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'working', filledQty: 0, reason: /Market closed today on calendar USBOND \(2026-11-11 is a holiday on USBOND\); will be matched on 2026-11-12/, fills: [] }] },
        events: [{ type: 'strategy.legs_added' }],
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'sell', status: 'working', qty: 400_000, filledQty: 0 }],
      },
    },
    {
      id: 'holiday-sell-fills', covers: ['reduce', 'settlement', 'accrual'], action: 'clock', to: EST('2026-11-12'),
      expect: {
        // Sale: cost removed at the average 400,000 x 99.625% = 398,500; realized 399,000 - 398,500 = 500.
        // Receivable 399,000 + 7,913.04 - 7.98 = 406,905.06.
        // End of day 11 Nov: settled face 1,000,000 to 11 Nov 20,000 x 180/184 = 19,565.2174; plus 600,000 to 12 Nov
        // 11,804.3478; less 400,000 sold to 13 Nov 7,913.0435: 23,456.5217. On the books 31,260.87 - 7,913.04 = 23,347.83.
        // Income 108.69: one day on the 1,000,000 that has settled.
        events: [
          { type: 'trade.fill', summary: 'Sold 400,000 UST-4-NOV30 @ 99.75 USD (realized 500.00 USD)', date: '2026-11-12' },
          { type: 'settlement.pay', summary: 'paid 610,503.82 USD from settled cash', cash: { USD: -610_503.82 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on UST-4-NOV30: 108.69 USD' },
        ],
        cash: { account: { USD: { settled: 1_374_707.25, unsettled: 406_905.06, availableToTrade: 1_781_612.31 } } }, // 1,985,211.07 - 610,503.82
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, cost: 1_195_500, avgCost: 99.625, price: 99.765625,
          value: 1_197_187.50, // 1,200,000 x 99.765625 / 100
          unrealized: 1_687.50, accrued: 23_456.52 }],
        holdings: { main: { long: 1_200_000, short: 0, net: 1_200_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-11-13', amount: 406_905.06, into: 'cash' }],
        openOrders: [],
        pnl: { account: { realized: 500, couponInterest: 108.69, commissions: -39.86, unrealized: 1_687.50, total: 2_256.33 } }, // 31.88 + 7.98
        nav: { account: 3_002_256.33, book: 5_002_256.33 },
        balance: { account: { cash: 1_374_707.25, receivable: 406_905.06, accruedIncome: 23_456.52, positions: 1_197_187.50, payable: null, assets: 3_002_256.33, liabilities: 0, netAssets: 3_002_256.33 } },
      },
    },
    {
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EST('2026-11-13'),
      expect: {
        // End of day 12 Nov: 1,600,000 settled (the sale settles tomorrow), to 12 Nov 32,000 x 181/184 = 31,478.2609;
        // less 7,913.0435 sold: 23,565.2174. Income 23,565.22 - 23,456.52 = 108.70.
        events: [
          { type: 'settlement.receive', summary: 'received 406,905.06 USD into settled cash', cash: { USD: 406_905.06 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on UST-4-NOV30: 108.70 USD' },
        ],
        cash: { account: { USD: { settled: 1_781_612.31, unsettled: 0, availableToTrade: 1_781_612.31 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, accrued: 23_565.22 }],
        pending: [],
        pnl: { account: { couponInterest: 217.39, total: 2_365.03 } },
        nav: { account: 3_002_365.03, book: 5_002_365.03 },
        balance: { account: { cash: 1_781_612.31, receivable: null, accruedIncome: 23_565.22, assets: 3_002_365.03, netAssets: 3_002_365.03 } },
      },
    },
    {
      id: 'oversell', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 2_000_000, from: 'lot',
      status: 'blocked', reason: 'The Account holds 1,200,000 face and cannot sell 2,000,000; going short needs a securities borrow.',
      expect: { refused: 'more than it holds' },
    },
    {
      id: 'coupon', covers: 'coupon', action: 'clock', to: EST('2026-11-16'),
      expect: {
        // Coupon of 15 Nov on the face settled before it: 1,200,000 x 2% = 24,000, paid Monday 16 Nov.
        // Accrued on the books 23,565.22; the coupon exceeds it by 434.78, the income earned from 12 Nov to the
        // coupon date (3 days on 1,200,000 = 391.30, and the day to 13 Nov on the 400,000 sold = 43.48).
        // The accrued balance is zero at the coupon date.
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 1,200,000 UST-4-NOV30: 24,000.00 USD', cash: { USD: 24_000 }, owner: 'account', date: '2026-11-16' },
          { type: 'accrual.coupon', summary: 'Interest accrued on UST-4-NOV30: 434.78 USD' },
        ],
        cash: { account: { USD: { settled: 1_805_612.31, availableToTrade: 1_805_612.31 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-05-17', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-11-15', status: 'pending' }], // 15 May 2027 is a Saturday
        pnl: { account: { couponInterest: 652.17, total: 2_799.81 } },
        nav: { account: 3_002_799.81, book: 5_002_799.81 },
        balance: { account: { cash: 1_805_612.31, accruedIncome: null, assets: 3_002_799.81, netAssets: 3_002_799.81 } },
      },
    },
    {
      id: 'quote-down', action: 'quote', instrument: 'main', quote: { bid: 99.25, ask: 99.28125, last: 99.265625, bidSize: 50_000_000, askSize: 50_000_000 }, // 99-08, 99-09, 99-08+
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, price: 99.265625, value: 1_191_187.50, unrealized: -4_312.50 }], // 1,191,187.50 - 1,195,500
        pnl: { account: { unrealized: -4_312.50, total: -3_200.19 } }, // 500 + 652.17 - 39.86 - 4,312.50
        nav: { account: 2_996_799.81, book: 4_996_799.81 },
        balance: { account: { positions: 1_191_187.50, assets: 2_996_799.81, netAssets: 2_996_799.81 } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_200_000, estimate: 99.25, settleDate: '2026-11-17',
          gross: 1_191_000, // 1,200,000 x 99.25 / 100
          accrued: 265.19, // settles 17 Nov, 2 days into the new 181-day period: 1,200,000 x 2% x 2/181 = 265.1934
          cash: 1_191_265.19, fees: 23.82 }] }, // 0.2 bp of 1,191,000
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1_200_000, avgPrice: 99.25 }] },
        // Realized 1,191,000 - 1,195,500 = -4,500. The 265.19 of interest sold was earned on the two days to settlement.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 1,200,000 UST-4-NOV30 @ 99\.25 USD \(realized [-−]4,500\.00 USD\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of UST-4-NOV30: 265.19 USD' },
        ],
        cash: { account: { USD: { settled: 1_805_612.31, unsettled: 1_191_241.37, availableToTrade: 2_996_853.68 } } }, // 1,191,000 + 265.19 - 23.82
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-11-17', amount: 1_191_241.37, into: 'cash' }],
        lifecycle: [],
        // Coupon income in all: 24,000 coupon + 7,913.04 + 265.19 sold - 19,456.52 - 11,804.35 bought = 917.36.
        pnl: { account: { realized: -4_000, couponInterest: 917.36, commissions: -63.68, unrealized: 0, total: -3_146.32 } }, // 500 - 4,500; 39.86 + 23.82
        nav: { account: 2_996_853.68, book: 4_996_853.68 },
        balance: { account: { cash: 1_805_612.31, receivable: 1_191_241.37, positions: null, accruedIncome: null, assets: 2_996_853.68, liabilities: 0, netAssets: 2_996_853.68 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EST('2026-11-17'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,191,241.37 USD into settled cash', cash: { USD: 1_191_241.37 } }],
        cash: { account: { USD: { settled: 2_996_853.68, unsettled: 0, availableToTrade: 2_996_853.68 } }, treasury: { USD: { settled: 2_000_000 } } },
        pending: [],
        balance: { account: { cash: 2_996_853.68, receivable: null, assets: 2_996_853.68, liabilities: 0, netAssets: 2_996_853.68 } },
      },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// treasury_bill
// ---------------------------------------------------------------------------------------------
// A 13-week US Treasury bill held by TREASURY (the Book's own liquidity, not an Account's trade):
// a discount instrument with no coupon, bought below par, part sold, the rest held to maturity
// and redeemed at par. Bills are quoted in the market as a bank discount rate on ACT/360; the
// Terminal takes prices in percent of par, so each quote below is converted by hand:
//     price = 100 - discount rate (%) x days from settlement to maturity / 360.
// T+1 on the US bond calendar; multiples of 100 face. Commission: 5.00 per million face.
// The discount earned is price gain (unrealized while held, realized at sale or redemption);
// the Terminal does not accrete a discount into interest income.
const treasuryBill = {
  productId: 'treasury_bill',
  title: 'US Treasury bill due 10 December 2026, held by Treasury: bought at a discount, part sold, the rest redeemed at par',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account (Treasury)', 'Action', 'Face amount', 'Settlement, when a trade must settle sooner than the convention'],
    manualInputs: ['the bank discount rate is converted to a price in % of par by hand (the Terminal has no discount-yield quotation)', 'same-day settlement stated on the ticket for a purchase on the day before maturity'],
    settlement: 'T+1 on the US bond calendar; a trade must settle before the maturity date, so the day before maturity only a same-day settlement stated on the ticket is accepted',
    lifecycle: 'No coupon and no accrual; redemption at par on the maturity date, automatic; a trade in the matured bill is refused',
    accounting: 'Clean cost at average; no accrued interest; discount earned is unrealized P&L while held and realized P&L at sale and at redemption; owned by Treasury, so the figures are Treasury\'s and the Book\'s, not an Account\'s',
    collateral: 'None for a long position; a short sale is refused without securities-borrow data',
  },
  start: EST('2026-11-09'), // Monday
  settlementCheck: { lag: 1, holidays: ['2026-11-11', '2026-11-26'] }, // Veterans Day, Thanksgiving
  book: {
    name: 'Matrix Treasury bill', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] }, // the Account stays idle: Treasury trades
    settings: { fees: { bond: { perUnit: 0.000005, minimum: 0, bps: 0 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'treasury_bill', name: 'US Treasury Bill 10-Dec-2026', symbol: 'USTB-10DEC26', marketView: 'US_CASH', venueType: 'otc', issuer: 'United States Treasury', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'zero', maturity: '2026-12-10', issueDate: '2026-09-10', dayCount: 'ACT/360', redemption: 100, minDenomination: 100 } },
  },
  // Settlement 10 Nov, 30 days to maturity. Bid 4.32% discount: 100 - 4.32 x 30/360 = 99.64. Ask 4.29%: 99.6425. Last 4.305%: 99.64125.
  quotes: { main: { bid: 99.64, ask: 99.6425, last: 99.64125, bidSize: 50_000_000, askSize: 50_000_000 } },
  expectAtStart: { ...startState(500_000, 4_500_000), cash: { account: usdCash(500_000), treasury: usdCash(4_500_000) } },
  steps: [
    {
      id: 'short-without-borrow', covers: 'short', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100_000, owner: 'treasury',
      status: 'blocked', reason: 'No borrow availability or fee is supplied for the bill and none was stated: a short sale cannot proceed without a securities borrow.',
      expect: { refused: 'no borrow availability data for USTB-10DEC26' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2_000_000, as: 'lot', owner: 'treasury',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2_000_000, estimate: 99.6425, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-11-10', calendar: 'USBOND',
            gross: 1_992_850, // 2,000,000 x 99.6425 / 100
            accrued: 0, cash: -1_992_850, fees: 10 }], // 2,000,000 x 0.000005
          cash: { USD: { purchases: 1_992_850, fees: 10, required: 1_992_860, available: 4_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2_000_000, avgPrice: 99.6425, fills: [{ qty: 2_000_000, price: 99.6425, model: 'quoted-bid-ask', settleDate: '2026-11-10', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted', owner: 'treasury' }, { type: 'trade.fill', summary: 'Bought 2,000,000 USTB-10DEC26 @ 99.6425 USD', owner: 'treasury', date: '2026-11-09' }],
        cash: { treasury: { USD: { settled: 4_500_000, unsettled: -1_992_860, availableToTrade: 2_507_140 } }, account: { USD: { settled: 500_000, availableToTrade: 500_000 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 2_000_000, avgCost: 99.6425, cost: 1_992_850, price: 99.64125,
          value: 1_992_825, // 2,000,000 x 99.64125 / 100
          unrealized: -25, accrued: 0, priceSource: 'Test fixture' }],
        holdings: { main: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2026-11-10', amount: -1_992_860, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.maturity', instrument: 'main', dueDate: '2026-12-10', status: 'pending' }], // a Thursday; no coupon is scheduled
        pnl: {
          account: { realized: 0, couponInterest: 0, commissions: 0, unrealized: 0, total: 0 },
          book: { realized: 0, couponInterest: 0, commissions: -10, fees: 0, borrowFunding: 0, unrealized: -25, total: -35 },
        },
        nav: { account: 500_000, treasury: 4_499_965, book: 4_999_965 }, // 4,500,000 - 10 - 25
        balance: {
          account: { cash: 500_000, assets: 500_000, liabilities: 0, netAssets: 500_000 },
          book: { cash: 5_000_000, positions: 1_992_825, payable: 1_992_860, assets: 6_992_825, liabilities: 1_992_860, netAssets: 4_999_965 },
        },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2026-11-10'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,992,860.00 USD from settled cash', cash: { USD: -1_992_860 }, owner: 'treasury', date: '2026-11-10' }],
        cash: { treasury: { USD: { settled: 2_507_140, unsettled: 0, availableToTrade: 2_507_140 } } },
        pending: [],
        balance: { book: { cash: 3_007_140, payable: null, assets: 4_999_965, liabilities: 0 } }, // 2,507,140 + the Account's 500,000
      },
    },
    { id: 'treasury-screens', covers: 'open', action: 'owner_screens', owner: 'treasury', expect: {} },
    // Two weeks pass (Veterans Day in between). A bill has no coupon: nothing accrues and nothing is posted.
    { id: 'two-weeks-on', action: 'clock', to: EST('2026-11-23'), expect: { events: [] } },
    {
      // Settlement 24 Nov, 16 days to maturity. Bid 4.3875% discount: 100 - 4.3875 x 16/360 = 99.805. Ask 4.33125%: 99.8075. Last 4.359375%: 99.80625.
      id: 'quote-pull-to-par', action: 'quote', instrument: 'main', quote: { bid: 99.805, ask: 99.8075, last: 99.80625, bidSize: 50_000_000, askSize: 50_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', qty: 2_000_000, price: 99.80625, value: 1_996_125, unrealized: 3_275 }], // 1,996,125 - 1,992,850
        pnl: { book: { unrealized: 3_275, total: 3_265 } },
        nav: { treasury: 4_503_265, book: 5_003_265 },
        balance: { book: { positions: 1_996_125, assets: 5_003_265, netAssets: 5_003_265 } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 500_000, from: 'lot', owner: 'treasury',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 500_000, estimate: 99.805, settleDate: '2026-11-24',
          gross: 499_025, // 500,000 x 99.805 / 100
          accrued: 0, cash: 499_025, fees: 2.50 }] }, // 500,000 x 0.000005
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 500_000, avgPrice: 99.805 }] },
        // Cost removed at the average: 500,000 x 99.6425% = 498,212.50. Realized 499,025 - 498,212.50 = 812.50: discount earned on the part sold.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 500,000 USTB-10DEC26 @ 99.805 USD (realized 812.50 USD)', owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 2_507_140, unsettled: 499_022.50, availableToTrade: 3_006_162.50 } } }, // 499,025 - 2.50
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', qty: 1_500_000, cost: 1_494_637.50, avgCost: 99.6425, price: 99.80625,
          value: 1_497_093.75, // 1,500,000 x 99.80625 / 100
          unrealized: 2_456.25 }],
        holdings: { main: { long: 1_500_000, short: 0, net: 1_500_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2026-11-24', amount: 499_022.50, into: 'cash' }],
        pnl: { book: { realized: 812.50, commissions: -12.50, unrealized: 2_456.25, total: 3_256.25 } },
        nav: { treasury: 4_503_256.25, book: 5_003_256.25 },
        balance: { book: { cash: 3_007_140, receivable: 499_022.50, positions: 1_497_093.75, assets: 5_003_256.25, liabilities: 0, netAssets: 5_003_256.25 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: EST('2026-11-24'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 499,022.50 USD into settled cash', cash: { USD: 499_022.50 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 3_006_162.50, unsettled: 0, availableToTrade: 3_006_162.50 } } },
        pending: [],
        balance: { book: { cash: 3_506_162.50, receivable: null } },
      },
    },
    // Wednesday 9 December, the day before maturity (Thanksgiving, 26 Nov, has passed with nothing to post).
    { id: 'day-before-maturity', action: 'clock', to: EST('2026-12-09'), expect: { events: [] } },
    {
      // One day to maturity. Last 4.32% discount: 100 - 4.32 x 1/360 = 99.988. Bid 4.50%: 99.9875. Ask 4.14%: 99.9885.
      id: 'quote-last-day', action: 'quote', instrument: 'main', quote: { bid: 99.9875, ask: 99.9885, last: 99.988, bidSize: 50_000_000, askSize: 50_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', qty: 1_500_000, price: 99.988, value: 1_499_820, unrealized: 5_182.50 }], // 1,499,820 - 1,494,637.50
        pnl: { book: { unrealized: 5_182.50, total: 5_982.50 } }, // 812.50 - 12.50 + 5,182.50
        nav: { treasury: 4_505_982.50, book: 5_005_982.50 },
        balance: { book: { positions: 1_499_820, assets: 5_005_982.50, netAssets: 5_005_982.50 } },
      },
    },
    {
      // A regular trade today would settle tomorrow, on the maturity date, when the bill is redeemed and cannot be delivered.
      id: 'buy-regular-settlement', covers: 'maturity', action: 'ticket', instrument: 'main', side: 'buy', qty: 100_000, owner: 'treasury',
      status: 'blocked', reason: 'A debt security trades only for settlement before its maturity date.',
      expect: { refused: 'matures on 2026-12-10; this trade would settle on 2026-12-10' },
    },
    {
      // The same purchase with same-day ("cash") settlement stated on the ticket: lag 0. It is paid for at once.
      id: 'buy-cash-settlement', covers: ['increase', 'stated settlement'], action: 'ticket', instrument: 'main', side: 'buy', qty: 100_000, as: 'top-up', owner: 'treasury', order: { settle: { lag: 0 } }, settlementCheck: false,
      expect: {
        preview: { blocking: 0, errors: [], warnings: ['already-held'], legs: [{ kind: 'trade', action: 'buy', qty: 100_000, estimate: 99.9885, settleDate: '2026-12-09',
          gross: 99_988.50, // 100,000 x 99.9885 / 100
          accrued: 0, cash: -99_988.50, fees: 0.50 }], // 100,000 x 0.000005
          cash: { USD: { purchases: 99_988.50, fees: 0.50, required: 99_989, available: 3_006_162.50, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 100_000, avgPrice: 99.9885, fills: [{ qty: 100_000, price: 99.9885, settleDate: '2026-12-09' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 100,000 USTB-10DEC26 @ 99.9885 USD', owner: 'treasury', date: '2026-12-09' },
          { type: 'settlement.pay', summary: 'paid 99,989.00 USD from settled cash', cash: { USD: -99_989 }, date: '2026-12-09' },
        ],
        cash: { treasury: { USD: { settled: 2_906_173.50, unsettled: 0, availableToTrade: 2_906_173.50 } } }, // 3,006,162.50 - 99,989
        positions: [
          { instrument: 'main', lot: 'lot', owner: 'treasury', qty: 1_500_000, cost: 1_494_637.50, value: 1_499_820, unrealized: 5_182.50 },
          { instrument: 'main', lot: 'top-up', owner: 'treasury', direction: 'long', qty: 100_000, avgCost: 99.9885, cost: 99_988.50, price: 99.988, value: 99_988, unrealized: -0.50, accrued: 0 },
        ],
        holdings: { main: { long: 1_600_000, short: 0, net: 1_600_000 } },
        pending: [],
        lifecycle: [{ type: 'bond.maturity', instrument: 'main', dueDate: '2026-12-10', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2026-12-10', status: 'pending' }], // one per position
        pnl: { book: { commissions: -13, unrealized: 5_182, total: 5_981.50 } }, // 5,182.50 - 0.50; 812.50 - 13 + 5,182
        nav: { treasury: 4_505_981.50, book: 5_005_981.50 },
        balance: { book: { cash: 3_406_173.50, positions: 1_599_808, assets: 5_005_981.50, liabilities: 0, netAssets: 5_005_981.50 } }, // 1,499,820 + 99,988
      },
    },
    {
      id: 'maturity', covers: ['maturity', 'close'], action: 'clock', to: EST('2026-12-10'),
      expect: {
        // Redeemed at par, each position on its own. Realized: 1,500,000 - 1,494,637.50 = 5,362.50 and 100,000 - 99,988.50 = 11.50.
        events: [
          { type: 'bond.redemption', summary: 'Redeemed at maturity: 1,500,000 USTB-10DEC26 at 100.00% of par', owner: 'treasury', date: '2026-12-10' },
          { type: 'settlement.receive', summary: 'received 1,500,000.00 USD into settled cash', cash: { USD: 1_500_000 } },
          { type: 'bond.redemption', summary: 'Redeemed at maturity: 100,000 USTB-10DEC26 at 100.00% of par', owner: 'treasury' },
          { type: 'settlement.receive', summary: 'received 100,000.00 USD into settled cash', cash: { USD: 100_000 } },
        ],
        cash: { treasury: { USD: { settled: 4_506_173.50, unsettled: 0, availableToTrade: 4_506_173.50 } }, account: { USD: { settled: 500_000 } } }, // 2,906,173.50 + 1,600,000
        positions: [],
        holdings: { main: null },
        pending: [],
        lifecycle: [],
        // Discount earned in all: 812.50 + 5,362.50 + 11.50 = 6,186.50, all of it realized; commissions 13.00.
        pnl: { book: { realized: 6_186.50, couponInterest: 0, commissions: -13, unrealized: 0, total: 6_173.50 }, account: { total: 0 } },
        nav: { account: 500_000, treasury: 4_506_173.50, book: 5_006_173.50 },
        balance: { book: { cash: 5_006_173.50, positions: null, assets: 5_006_173.50, liabilities: 0, netAssets: 5_006_173.50 } },
      },
    },
    { id: 'treasury-screens-after-maturity', covers: 'maturity', action: 'owner_screens', owner: 'treasury', expect: {} },
    { id: 'day-after-maturity', action: 'clock', to: EST('2026-12-11'), expect: { events: [] } },
    {
      // The quote fixture still shows a price, but there is nothing left to trade.
      id: 'buy-after-maturity', covers: 'maturity', action: 'ticket', instrument: 'main', side: 'buy', qty: 100_000, owner: 'treasury',
      status: 'blocked', reason: 'The bill has matured and was redeemed.',
      expect: { refused: 'USTB-10DEC26 matured on 2026-12-10 and was redeemed. It can no longer be traded.' },
    },
  ],
};

export default [treasuryNote, treasuryBill];
