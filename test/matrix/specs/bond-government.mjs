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

/** 10:00 in New York on a date in Eastern Daylight Time (UTC-4): mid-March to the end of October. */
const EDT = (d) => `${d}T14:00:00.000Z`;

/** Fill assumptions every scenario states in full. A quote with a bid and an ask fills at them; a manual mark without them fills 3 bp away from the mark (the Book's assumed half spread for bonds). */
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


// ---------------------------------------------------------------------------------------------
// treasury_bond
// ---------------------------------------------------------------------------------------------
// A 30-year US Treasury bond SOLD SHORT against a securities borrow, carried over a coupon date,
// covered in two parts. 4.5% semi-annual, ACT/ACT, coupons 15 February and 15 August, T+1 on the
// US bond calendar. The 15 February 2027 coupon date is Washington's Birthday (bond and stock
// markets closed): the coupon moves to Tuesday 16 February, and no end-of-day run happens on the 15th.
//
// What a short in a bond adds to the rules at the top of this file:
//   - The seller receives principal plus accrued interest; both are owed back. The accrued coupon is
//     a negative balance of Accrued income, and its daily growth is an interest COST in coupon and
//     interest income. On the coupon date the short pays the full coupon to the lender.
//   - Sale proceeds settle into restricted cash. At each end of day the collateral is marked to
//     102% of the market value INCLUDING accrued interest (clean value at the last price plus the
//     accrued coupon owed), topped up from or released to settled cash. A further 30% of the clean
//     value at the last price is reserved from free cash.
//   - The borrow fee, 0.40% a year here, accrues per calendar day on the clean value at that
//     day's last price, ACT/360; when securities are returned during the day it is accrued up to
//     that day on the current price, and it is paid when the borrow is fully returned.
//   - A cover is paid from restricted cash first; what is left once the short is gone is released.
//
// Coupon periods: 15 Aug 2026 to 15 Feb 2027 is 184 days; 15 Feb 2027 to 15 Aug 2027 is 181 days.
// A full coupon is 2.25 per 100 face: 22,500 on 1,000,000. Commission: 0.5 bp of clean principal.
const EST_1730 = (d) => `${d}T22:30:00.000Z`; // 17:30 New York, after the 17:00 end-of-day cutoff
const treasuryBond = {
  productId: 'treasury_bond',
  title: 'US Treasury 4.5% bond due 15 February 2052, sold short against a securities borrow, carried over a coupon and covered',
  matrix: {
    ticket: 'Instrument drawer, Trade tab: Sell short (adds the securities borrow leg), then Buy to cover; the Close button of the short position',
    requiredFields: ['Account', 'Action (Sell short / Buy to cover)', 'Face amount', 'borrow assumption only when no borrow data is supplied'],
    automaticInputs: ['bid, ask, last in % of par (quote fixture)', 'borrow availability and fee (borrow fixture standing in for Shaffer MarketData)', 'accrued interest received on the short sale and paid on the cover', 'collateral and margin from the Book short assumptions', 'settlement date', 'commission'],
    manualInputs: ['none'],
    settlement: 'T+1 on the US bond calendar; sale proceeds (principal plus accrued) settle into restricted cash; a cover is paid from restricted cash first',
    lifecycle: 'Daily interest cost on the short and daily borrow fee; collateral marked each end of day to 102% of clean value plus accrued; coupon paid to the lender on the next payment day after a holiday coupon date; fee paid when the borrow is returned',
    accounting: 'Short position at negative clean cost; accrued coupon owed as a negative accrued balance; the coupon paid and the accrued received and paid net to an interest cost in coupon and interest income; borrow fee under borrowing and funding; realized P&L on the covers',
    collateral: 'Restricted cash = 102% of market value including accrued interest, marked daily; 30% margin reserve on the clean value; neither is buying power or withdrawable',
  },
  start: EST('2027-02-09'), // Tuesday
  settlementCheck: { lag: 1, holidays: ['2027-02-15'] }, // Washington's Birthday
  book: {
    name: 'Matrix Treasury bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'treasury_bond', name: 'US Treasury Bond 4.5% 15-Feb-2052', symbol: 'UST-4.5-FEB52', marketView: 'US_CASH', venueType: 'otc', issuer: 'United States Treasury', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.045, frequency: 2, maturity: '2052-02-15', issueDate: '2022-02-15', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 100 } },
  },
  quotes: { main: { bid: 96.5, ask: 96.5625, last: 96.53125, bidSize: 50_000_000, askSize: 50_000_000 } }, // 96-16, 96-18, 96-17
  borrow: { main: { available: true, quantity: 25_000_000, feeRate: 0.004 } },
  expectAtStart: { ...startState(2_000_000, 3_000_000), cash: { account: usdCash(2_000_000), treasury: usdCash(3_000_000) } },
  steps: [
    {
      id: 'short', covers: ['borrow', 'short'], action: 'ticket', instrument: 'main', side: 'sell_short', qty: 1_000_000, as: 'short',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'borrow_sec', action: 'borrow_sec', instrument: 'main', qty: 1_000_000, borrow: { available: true, feeRate: 0.004, dailyCost: 10.73, source: 'Test fixture' } }, // 1,000,000 x 96.53125% x 0.004 / 360 = 10.7257
            { kind: 'trade', action: 'sell_short', instrument: 'main', qty: 1_000_000, estimate: 96.5, model: 'quoted-bid-ask', settleDate: '2027-02-10', calendar: 'USBOND', dependsOn: [1],
              gross: 965_000, // 1,000,000 x 96.5 / 100
              accrued: 21_888.59, // settles 10 Feb, 179 days into the 184-day period: 22,500 x 179/184 = 21,888.587
              cash: 986_888.59, fees: 48.25, // 0.5 bp of 965,000
              shortCollateral: { topUp: 19_737.77, marginHold: 296_066.58 } }, // 2% and 30% of the 986,888.59 proceeds
          ],
          cash: { USD: { purchases: 0, proceeds: 0, restrictedProceeds: 986_888.59, fees: 48.25, collateral: 19_737.77, margin: 296_066.58, required: 315_852.60, available: 2_000_000, shortfall: 0 } }, // 48.25 + 19,737.77 + 296,066.58
        },
        result: { status: 'open', orders: [
          { kind: 'borrow_sec', status: 'filled', filledQty: 1_000_000 },
          { kind: 'trade', action: 'sell_short', status: 'filled', filledQty: 1_000_000, avgPrice: 96.5, fills: [{ qty: 1_000_000, price: 96.5, model: 'quoted-bid-ask', settleDate: '2027-02-10', source: 'Test fixture' }] },
        ] },
        events: [{ type: 'strategy.submitted' }, { type: 'secloan.borrow', summary: 'Borrowed 1,000,000 UST-4.5-FEB52 at a fee of 0.400% p.a.' }, { type: 'trade.fill', summary: 'Sold short 1,000,000 UST-4.5-FEB52 @ 96.50 USD', owner: 'account', date: '2027-02-09' }],
        // Proceeds 986,888.59 less 48.25 commission are owed to the Account and will arrive as restricted cash.
        // Reserve: 30% x 1,000,000 x 96.53125% = 289,593.75. Free cash to trade: 2,000,000 - 289,593.75.
        cash: { account: { USD: { settled: 2_000_000, unsettled: 986_840.34, restricted: 0, reserved: 289_593.75, availableToTrade: 1_710_406.25, availableToWithdraw: 1_710_406.25 } } },
        positions: [
          { instrument: 'borrow:main', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 1_000_000, value: 965_312.50, accrued: 0 }, // clean value at the last price
          { instrument: 'main', lot: 'short', owner: 'account', direction: 'short', qty: -1_000_000, avgCost: 96.5, cost: -965_000, price: 96.53125, value: -965_312.50, unrealized: -312.50, restrictedCash: 0,
            accrued: -21_888.59 }, // the accrued coupon received from the buyer is owed
        ],
        holdings: { main: { long: 0, short: 1_000_000, net: -1_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-02-10', amount: 986_840.34, into: 'cash.restricted' }],
        // 15 Feb 2027 is a holiday: the coupon is due 16 Feb. The borrow fee is paid on the first business day of March. 15 Feb 2052 is a Thursday.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-02-16', status: 'pending' }, { type: 'secloan.fee', instrument: 'borrow:main', dueDate: '2027-03-01', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2052-02-15', status: 'pending' }],
        borrowings: [{ owner: 'account', family: 'secloan', instrument: 'main', lot: 'short', qty: 1_000_000, value: 965_312.50, rate: 0.004, accrued: 0, collateralCash: null, nextPayment: '2027-03-01' }], // no collateral until the sale settles
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -48.25, fees: 0, borrowFunding: 0, unrealized: -312.50, total: -360.75 } },
        nav: { account: 1_999_639.25, book: 4_999_639.25 },
        balance: { account: { cash: 2_000_000, receivable: 986_840.34, accruedIncome: -21_888.59, positions: -965_312.50, netAssets: 1_999_639.25 } },
      },
    },
    {
      id: 'settle-short', covers: ['settlement', 'collateral mark'], action: 'clock', to: EST('2027-02-10'),
      expect: {
        // Collateral required: 102% x (965,312.50 clean + 21,888.59 accrued) = 102% x 987,201.09 = 1,006,945.11.
        // Proceeds received 986,840.34. Top-up from settled cash 20,104.77.
        events: [
          { type: 'settlement.receive', summary: 'received 986,840.34 USD into restricted cash' },
          { type: 'collateral.mark', summary: 'Short collateral on UST-4.5-FEB52 marked to market: posted 20,104.77 USD', cash: { USD: -20_104.77 } },
        ],
        cash: { account: { USD: { settled: 1_979_895.23, unsettled: 0, restricted: 1_006_945.11, reserved: 289_593.75, availableToTrade: 1_690_301.48, availableToWithdraw: 1_690_301.48 } } },
        positions: [{ instrument: 'borrow:main', qty: 1_000_000, value: 965_312.50 }, { instrument: 'main', qty: -1_000_000, value: -965_312.50, unrealized: -312.50, restrictedCash: 1_006_945.11, accrued: -21_888.59 }],
        pending: [],
        borrowings: [{ instrument: 'main', qty: 1_000_000, value: 965_312.50, accrued: 0, collateralCash: 1_006_945.11 }],
        balance: { account: { cash: 1_979_895.23, restricted: 1_006_945.11, receivable: null, accruedIncome: -21_888.59, positions: -965_312.50, netAssets: 1_999_639.25 } },
      },
    },
    {
      id: 'fee-day-1', covers: 'borrow fee', action: 'clock', to: EST_1730('2027-02-10'),
      expect: {
        // End of day 10 Feb, the settlement date: the accrued owed to 10 Feb is what was received with the sale; nothing more yet. One day of fee: 10.7257.
        events: [{ type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000,000 UST-4.5-FEB52: 10.73 USD' }],
        positions: [{ instrument: 'borrow:main', qty: 1_000_000, accrued: -10.73 }, { instrument: 'main', qty: -1_000_000, accrued: -21_888.59 }],
        borrowings: [{ instrument: 'main', qty: 1_000_000, accrued: 10.73, costToDate: 10.73, collateralCash: 1_006_945.11 }],
        pnl: { account: { borrowFunding: -10.73, total: -371.48 } },
        nav: { account: 1_999_628.52, book: 4_999_628.52 },
        balance: { account: { accruedExpense: 10.73, netAssets: 1_999_628.52 } },
      },
    },
    {
      id: 'carry-day-2', covers: ['accrual', 'borrow fee', 'collateral mark'], action: 'clock', to: EST_1730('2027-02-11'),
      expect: {
        // Fee: two days 21.4514 -> 21.45, so 10.72 is added.
        // Interest owed to 11 Feb: 22,500 x 180/184 = 22,010.87; cost of the day 122.28.
        // Collateral: 102% x (965,312.50 + 22,010.87) = 1,007,069.84; held 1,006,945.11; top-up 124.73.
        events: [
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000,000 UST-4.5-FEB52: 10.72 USD' },
          { type: 'accrual.coupon', summary: 'Interest cost accrued on UST-4.5-FEB52: 122.28 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on UST-4.5-FEB52 marked to market: posted 124.73 USD', cash: { USD: -124.73 } },
        ],
        cash: { account: { USD: { settled: 1_979_770.50, restricted: 1_007_069.84, reserved: 289_593.75, availableToTrade: 1_690_176.75, availableToWithdraw: 1_690_176.75 } } },
        positions: [{ instrument: 'borrow:main', qty: 1_000_000, accrued: -21.45 }, { instrument: 'main', qty: -1_000_000, restrictedCash: 1_007_069.84, accrued: -22_010.87 }],
        borrowings: [{ instrument: 'main', qty: 1_000_000, accrued: 21.45, costToDate: 21.45, collateralCash: 1_007_069.84 }],
        pnl: { account: { couponInterest: -122.28, borrowFunding: -21.45, total: -504.48 } }, // -48.25 - 122.28 - 21.45 - 312.50
        nav: { account: 1_999_495.52, book: 4_999_495.52 },
        balance: { account: { cash: 1_979_770.50, restricted: 1_007_069.84, accruedIncome: -22_010.87, accruedExpense: 21.45, netAssets: 1_999_495.52 } },
      },
    },
    {
      // Tuesday 16 Feb, after the long weekend. In order: the coupon of 15 Feb is paid to the lender, 22,500 on the
      // 1,000,000 sold short; the accrued owed, 22,010.87, falls 489.13 short of it (the four days from 11 to 15 Feb);
      // then the end-of-day run of Friday 12 Feb, the last business day: fee for three days in all 32.1771 -> 32.18,
      // so 10.73 is added; collateral with no accrued owed 102% x 965,312.50 = 984,618.75, held 1,007,069.84,
      // 22,451.09 released.
      id: 'coupon-paid-to-lender', covers: ['coupon', 'collateral mark', 'borrow fee'], action: 'clock', to: EST('2027-02-16'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon paid on 1,000,000 UST-4.5-FEB52 sold short: 22,500.00 USD', cash: { USD: -22_500 }, owner: 'account', date: '2027-02-16' },
          { type: 'accrual.coupon', summary: 'Interest cost accrued on UST-4.5-FEB52: 489.13 USD' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000,000 UST-4.5-FEB52: 10.73 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on UST-4.5-FEB52 marked to market: released 22,451.09 USD', cash: { USD: 22_451.09 } },
        ],
        cash: { account: { USD: { settled: 1_979_721.59, restricted: 984_618.75, reserved: 289_593.75, availableToTrade: 1_690_127.84, availableToWithdraw: 1_690_127.84 } } }, // 1,979,770.50 - 22,500 + 22,451.09
        positions: [{ instrument: 'borrow:main', qty: 1_000_000, accrued: -32.18 }, { instrument: 'main', qty: -1_000_000, restrictedCash: 984_618.75, accrued: 0 }],
        lifecycle: [{ type: 'secloan.fee', instrument: 'borrow:main', dueDate: '2027-03-01', status: 'pending' }, { type: 'bond.coupon', instrument: 'main', dueDate: '2027-08-16', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2052-02-15', status: 'pending' }], // 15 Aug 2027 is a Sunday
        borrowings: [{ instrument: 'main', qty: 1_000_000, accrued: 32.18, costToDate: 32.18, collateralCash: 984_618.75 }],
        // Interest cost so far: 22,500 paid less 21,888.59 received with the sale = 611.41.
        pnl: { account: { couponInterest: -611.41, borrowFunding: -32.18, total: -1_004.34 } },
        nav: { account: 1_998_995.66, book: 4_998_995.66 },
        balance: { account: { cash: 1_979_721.59, restricted: 984_618.75, accruedIncome: null, accruedExpense: 32.18, netAssets: 1_998_995.66 } },
      },
    },
    {
      id: 'quote-down', action: 'quote', instrument: 'main', quote: { bid: 95.75, ask: 95.8125, last: 95.78125, bidSize: 50_000_000, askSize: 50_000_000 }, // 95-24, 95-26, 95-25
      expect: {
        positions: [{ instrument: 'borrow:main', qty: 1_000_000, value: 957_812.50 }, { instrument: 'main', qty: -1_000_000, price: 95.78125, value: -957_812.50, unrealized: 7_187.50 }], // 965,000 - 957,812.50
        borrowings: [{ instrument: 'main', qty: 1_000_000, value: 957_812.50, accrued: 32.18 }],
        pnl: { account: { unrealized: 7_187.50, total: 6_495.66 } }, // -48.25 - 611.41 - 32.18 + 7,187.50
        nav: { account: 2_006_495.66, book: 5_006_495.66 },
        balance: { account: { positions: -957_812.50, netAssets: 2_006_495.66 } },
      },
    },
    {
      // Settled 1,979,721.59 plus restricted 984,618.75 is 2,964,340.34. Only 1,979,721.59 - 289,593.75 reserve = 1,690,127.84 can leave.
      id: 'withdraw-restricted-cash', covers: 'restricted proceeds', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 1_900_000,
      status: 'blocked', reason: 'Restricted collateral and the margin reserve cannot leave the Account.',
      expect: { refused: 'Alpha has 1,690,127.84 USD of settled USD available; 1,900,000.00 USD requested' },
    },
    {
      id: 'cover-part', covers: ['cover', 'return', 'borrow fee'], action: 'ticket', instrument: 'main', side: 'buy_to_cover', qty: 400_000, from: 'short',
      expect: {
        preview: { blocking: 0, errors: [], legs: [
          { kind: 'trade', action: 'buy_to_cover', qty: 400_000, estimate: 95.8125, settleDate: '2027-02-17',
            gross: 383_250, // 400,000 x 95.8125 / 100
            accrued: 99.45, // settles 17 Feb, 2 days into the 181-day period: 9,000 x 2/181 = 99.4475
            cash: -383_349.45, fees: 19.16 }, // 0.5 bp of 383,250 = 19.1625
          { kind: 'return_sec', action: 'return_sec', qty: 400_000, dependsOn: [1] },
        ] },
        result: { status: 'open', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 400_000, avgPrice: 95.8125 }, { kind: 'return_sec', status: 'filled', filledQty: 400_000 }] },
        // Realized: 400,000 x (96.5 - 95.8125)% = 2,750. Fee to today, four days since 12 Feb at the current price:
        // 4 x 1,000,000 x 95.78125% x 0.004 / 360 = 42.5694; in all 32.1771 + 42.5694 = 74.7465 -> 74.75, so 42.57 is added.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought to cover 400,000 UST-4.5-FEB52 @ 95.8125 USD (realized 2,750.00 USD)' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000,000 UST-4.5-FEB52: 42.57 USD' },
          { type: 'secloan.return', summary: 'Returned 400,000 borrowed UST-4.5-FEB52' },
        ],
        // Owed for the cover: 383,349.45 + 19.16 = 383,368.61. Reserve: 30% x 600,000 x 95.78125% = 172,406.25.
        cash: { account: { USD: { settled: 1_979_721.59, unsettled: -383_368.61, restricted: 984_618.75, reserved: 172_406.25, availableToTrade: 1_423_946.73, availableToWithdraw: 1_423_946.73 } } }, // 1,979,721.59 - 383,368.61 - 172,406.25
        positions: [
          { instrument: 'borrow:main', qty: 600_000, value: 574_687.50, accrued: -74.75 }, // 600,000 x 95.78125%
          { instrument: 'main', qty: -600_000, cost: -579_000, avgCost: 96.5, price: 95.78125, value: -574_687.50, unrealized: 4_312.50, restrictedCash: 984_618.75,
            accrued: 99.45 }, // the interest bought with the cover; today's interest on the short is booked at the end of the day
        ],
        holdings: { main: { long: 0, short: 600_000, net: -600_000 } },
        pending: [{ instrument: 'main', dueDate: '2027-02-17', amount: -383_368.61, into: 'cash.restricted' }],
        borrowings: [{ instrument: 'main', qty: 600_000, value: 574_687.50, accrued: 74.75, costToDate: 74.75, collateralCash: 984_618.75 }],
        pnl: { account: { realized: 2_750, couponInterest: -611.41, borrowFunding: -74.75, commissions: -67.41, unrealized: 4_312.50, total: 6_308.93 } }, // 48.25 + 19.16
        nav: { account: 2_006_308.93, book: 5_006_308.93 },
        balance: { account: { cash: 1_979_721.59, restricted: 984_618.75, accruedIncome: 99.45, positions: -574_687.50, payable: 383_368.61, accruedExpense: 74.75, netAssets: 2_006_308.93 } },
      },
    },
    {
      id: 'settle-cover-part', covers: ['settlement', 'accrual', 'collateral mark'], action: 'clock', to: EST('2027-02-17'),
      expect: {
        // The cover is paid from restricted cash: 984,618.75 - 383,368.61 = 601,250.14 left.
        // End of day 16 Feb: 1,000,000 was still short on a settled basis: 22,500 x 1/181 = 124.3094 owed, less the 99.4475
        // bought with the cover: 24.86 owed. On the books +99.45: interest cost 124.31.
        // Collateral for the 600,000 still short: 102% x (574,687.50 + 24.86) = 586,206.61. The surplus 15,043.53 is released.
        events: [
          { type: 'settlement.pay', summary: 'paid 383,368.61 USD from restricted cash' },
          { type: 'accrual.coupon', summary: 'Interest cost accrued on UST-4.5-FEB52: 124.31 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on UST-4.5-FEB52 marked to market: released 15,043.53 USD', cash: { USD: 15_043.53 } },
        ],
        cash: { account: { USD: { settled: 1_994_765.12, unsettled: 0, restricted: 586_206.61, reserved: 172_406.25, availableToTrade: 1_822_358.87, availableToWithdraw: 1_822_358.87 } } },
        positions: [{ instrument: 'borrow:main', qty: 600_000 }, { instrument: 'main', qty: -600_000, restrictedCash: 586_206.61, accrued: -24.86 }],
        borrowings: [{ instrument: 'main', qty: 600_000, accrued: 74.75, collateralCash: 586_206.61 }],
        pending: [],
        pnl: { account: { couponInterest: -735.72, total: 6_184.62 } },
        nav: { account: 2_006_184.62, book: 5_006_184.62 },
        balance: { account: { cash: 1_994_765.12, restricted: 586_206.61, accruedIncome: -24.86, payable: null, netAssets: 2_006_184.62 } },
      },
    },
    {
      id: 'cover-rest', covers: ['cover', 'return', 'close', 'borrow fee'], action: 'close', lot: 'short', scope: 'position', percent: 100, // the Close button on the short position itself
      expect: {
        preview: { blocking: 0, errors: [], legs: [
          { kind: 'trade', action: 'buy_to_cover', qty: 600_000, estimate: 95.8125, settleDate: '2027-02-18',
            gross: 574_875, // 600,000 x 95.8125 / 100
            accrued: 223.76, // settles 18 Feb, 3 days into the period: 13,500 x 3/181 = 223.7569
            cash: -575_098.76, fees: 28.74 }, // 0.5 bp of 574,875 = 28.74375
          { kind: 'return_sec', action: 'return_sec', qty: 600_000, dependsOn: [1] },
        ] },
        result: { status: 'closed', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 600_000, avgPrice: 95.8125 }, { kind: 'return_sec', status: 'filled', filledQty: 600_000 }] },
        // Realized: 579,000 - 574,875 = 4,125. Interest: 24.86 was owed and 223.76 is paid with the cover: 198.90 more cost.
        // Fee for one more day on 600,000: 6.3854; in all 81.1319 -> 81.13, so 6.38 is added, and the whole 81.13 is paid now.
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought to cover 600,000 UST-4.5-FEB52 @ 95.8125 USD (realized 4,125.00 USD)' },
          { type: 'accrual.coupon', summary: 'Interest cost to disposal of UST-4.5-FEB52: 198.90 USD' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 600,000 UST-4.5-FEB52: 6.38 USD' },
          { type: 'secloan.return', summary: 'Returned 600,000 borrowed UST-4.5-FEB52' },
          { type: 'interest.payment', summary: /Borrow fee paid on Borrow of UST-4\.5-FEB52.*: 81\.13 USD/, cash: { USD: -81.13 } },
        ],
        cash: { account: { USD: { settled: 1_994_683.99, unsettled: -575_127.50, restricted: 586_206.61, reserved: 0, availableToTrade: 1_419_556.49, availableToWithdraw: 1_419_556.49 } } }, // 1,994,765.12 - 81.13; 575,098.76 + 28.74 owed
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2027-02-18', amount: -575_127.50, into: 'cash.restricted' }],
        lifecycle: [],
        borrowings: [],
        // Interest cost in all: 22,500 coupon + 99.45 + 223.76 paid on the covers - 21,888.59 received on the sale = 934.62.
        pnl: { account: { realized: 6_875, couponInterest: -934.62, borrowFunding: -81.13, commissions: -96.15, unrealized: 0, total: 5_763.10 } }, // 2,750 + 4,125; 67.41 + 28.74
        nav: { account: 2_005_763.10, book: 5_005_763.10 },
        balance: { account: { cash: 1_994_683.99, restricted: 586_206.61, positions: null, accruedIncome: null, payable: 575_127.50, accruedExpense: null, netAssets: 2_005_763.10 } },
      },
    },
    {
      id: 'settle-cover-rest', covers: ['settlement', 'collateral release'], action: 'clock', to: EST('2027-02-18'),
      expect: {
        // 586,206.61 - 575,127.50 = 11,079.11 of collateral is left with no short to secure: it is released.
        events: [
          { type: 'settlement.pay', summary: 'paid 575,127.50 USD from restricted cash' },
          { type: 'collateral.mark', summary: 'Short collateral on UST-4.5-FEB52 marked to market: released 11,079.11 USD', cash: { USD: 11_079.11 } },
        ],
        cash: { account: { USD: { settled: 2_005_763.10, unsettled: 0, restricted: 0, reserved: 0, availableToTrade: 2_005_763.10, availableToWithdraw: 2_005_763.10 } }, treasury: { USD: { settled: 3_000_000 } } },
        pending: [],
        balance: { account: { cash: 2_005_763.10, restricted: null, payable: null, assets: 2_005_763.10, liabilities: 0, netAssets: 2_005_763.10 } },
      },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// strips
// ---------------------------------------------------------------------------------------------
// A zero-coupon US Treasury STRIPS (the principal of a bond, stripped of its coupons): no coupon,
// no accrued interest, a price far below par. It starts with NO market price at all, which is
// usual for an off-the-run strip: the first purchase fills at a price the user states, the position
// is provisional until a price is entered by hand, a second purchase fills on that manual mark with
// the Book's assumed half spread, and only then does a quote arrive. T+1 on the US bond calendar;
// the second purchase is made on Friday 9 October 2026 and settles on Tuesday 13 October, because
// Monday 12 October is Columbus Day (bond market closed, stock market open).
// A resting limit order is filled on a later day, when the quote trades through the limit.
// Commission: 0.1 bp of principal with a minimum of 5.00 an order, which every order here pays.
const strips = {
  productId: 'strips',
  title: 'US Treasury STRIPS due 15 May 2036: stated fill price, manual mark, Columbus Day settlement, a resting limit sale',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount', 'a stated fill price or a manual price while no quote exists', 'Order type, Limit price and Time in force for the resting sale'],
    automaticInputs: ['settlement date', 'commission', 'bid, ask and last once a quote is supplied (quote fixture)'],
    manualInputs: ['fill price stated on the ticket for the first purchase (no quote exists)', 'price entered by hand on the instrument, used to value the position and to fill the second purchase with the assumed half spread'],
    settlement: 'T+1 on the US bond calendar; Columbus Day is skipped; a limit order that fills on a later day settles T+1 from the day it fills',
    lifecycle: 'No coupon and no accrual; maturity scheduled; without a price the position is carried at cost and the net asset value is provisional',
    accounting: 'Clean cost at average across a stated-price fill and a manual-mark fill; no accrued interest; realized P&L on each sale; minimum commission',
    collateral: 'None for a long position',
  },
  start: EDT('2026-10-08'), // Thursday
  settlementCheck: { lag: 1, holidays: ['2026-10-12'] }, // Columbus Day, a US bond-market holiday
  book: {
    name: 'Matrix STRIPS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 5, bps: 0.1 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'strips', name: 'US Treasury STRIPS 15-May-2036', symbol: 'STRIPS-MAY36', marketView: 'US_CASH', venueType: 'otc', issuer: 'United States Treasury', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      terms: { couponType: 'zero', maturity: '2036-05-15', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 100 } },
  },
  quotes: {}, // no quote to begin with
  expectAtStart: { ...startState(1_000_000, 1_000_000), cash: { account: usdCash(1_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open-at-stated-price', covers: ['open', 'stated fill price'], action: 'ticket', instrument: 'main', side: 'buy', qty: 800_000, as: 'lot', order: { statedPrice: 62.125 }, // 62-04
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 800_000, estimate: 62.125, model: 'stated-price', priceSource: null, settleDate: '2026-10-09', calendar: 'USBOND',
            gross: 497_000, // 800,000 x 62.125 / 100
            accrued: 0, cash: -497_000, fees: 5 }], // 0.1 bp of 497,000 = 4.97, raised to the 5.00 minimum
          cash: { USD: { purchases: 497_000, fees: 5, required: 497_005, available: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 800_000, avgPrice: 62.125, fills: [{ qty: 800_000, price: 62.125, model: 'stated-price', settleDate: '2026-10-09' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 800,000 STRIPS-MAY36 @ 62.125 USD', owner: 'account', date: '2026-10-08' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -497_005, availableToTrade: 502_995 } } },
        // No price exists: the value is missing, not zero and not the fill price. The position is carried at cost and everything built on it is provisional.
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 800_000, avgCost: 62.125, cost: 497_000, price: null, value: null, unrealized: null, accrued: 0, provisional: true, priceSource: null }],
        holdings: { main: { long: 800_000, short: 0, net: 800_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-10-09', amount: -497_005, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.maturity', instrument: 'main', dueDate: '2036-05-15', status: 'pending' }], // a Thursday; no coupon is scheduled
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -5, fees: 0, borrowFunding: 0, total: -5, complete: false } },
        nav: { account: 999_995, book: 1_999_995 }, // at cost, less the commission
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_000_000, positions: 497_000, payable: 497_005, assets: 1_497_000, liabilities: 497_005, netAssets: 999_995 } },
      },
    },
    {
      id: 'manual-mark', covers: 'manual price', action: 'manual_price', instrument: 'main', value: 62.2, note: 'Dealer indication, 8 October',
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 800_000, price: 62.2, value: 497_600, unrealized: 600, provisional: false, priceSource: 'Manual entry' }], // 800,000 x 62.2 / 100 - 497,000
        pnl: { account: { unrealized: 600, total: 595, complete: true } },
        nav: { account: 1_000_595, book: 2_000_595 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 497_600, assets: 1_497_600, netAssets: 1_000_595 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2026-10-09'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 497,005.00 USD from settled cash', cash: { USD: -497_005 }, date: '2026-10-09' }],
        cash: { account: { USD: { settled: 502_995, unsettled: 0, availableToTrade: 502_995 } } },
        pending: [],
        balance: { account: { cash: 502_995, payable: null, assets: 1_000_595, liabilities: 0 } },
      },
    },
    {
      // Friday 9 October, still no quote: the manual mark is the only price. A buy fills at the mark plus the Book's assumed
      // half spread of 3 bp: 62.2 x 1.0003 = 62.21866. T+1 skips Columbus Day (Monday 12 October): it settles Tuesday 13 October.
      id: 'increase-on-manual-mark', covers: ['increase', 'manual price', 'market holiday'], action: 'resize', lot: 'lot', factor: 1.5, // 800,000 -> 1,200,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 400_000, estimate: 62.21866, model: 'manual-mark', priceSource: 'Manual entry', settleDate: '2026-10-13', calendar: 'USBOND',
          gross: 248_874.64, // 400,000 x 62.21866 / 100
          accrued: 0, cash: -248_874.64, fees: 5 }], // 0.1 bp is 2.49: the minimum again
          cash: { USD: { purchases: 248_874.64, fees: 5, required: 248_879.64, available: 502_995, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 400_000, avgPrice: 62.21866, fills: [{ qty: 400_000, price: 62.21866, model: 'manual-mark', settleDate: '2026-10-13' }] }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 400,000 STRIPS-MAY36 @ 62.21866 USD' }],
        cash: { account: { USD: { settled: 502_995, unsettled: -248_879.64, availableToTrade: 254_115.36 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000,
          cost: 745_874.64, // 497,000 + 248,874.64
          avgCost: 62.15622, // 745,874.64 / 1,200,000 x 100
          price: 62.2, value: 746_400, // 1,200,000 x 62.2 / 100
          unrealized: 525.36 }],
        holdings: { main: { long: 1_200_000, short: 0, net: 1_200_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-10-13', amount: -248_879.64, into: 'cash' }],
        pnl: { account: { commissions: -10, unrealized: 525.36, total: 515.36 } },
        nav: { account: 1_000_515.36, book: 2_000_515.36 },
        balance: { account: { cash: 502_995, positions: 746_400, payable: 248_879.64, assets: 1_249_395, liabilities: 248_879.64, netAssets: 1_000_515.36 } },
      },
    },
    // Columbus Day: the stock market is open (so the Terminal's day ends as usual), the bond market is not. Nothing settles and nothing accrues on a strip.
    { id: 'columbus-day', covers: 'market holiday', action: 'clock', to: EDT('2026-10-12'), expect: { events: [] } },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: EDT('2026-10-13'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 248,879.64 USD from settled cash', cash: { USD: -248_879.64 }, date: '2026-10-13' }],
        cash: { account: { USD: { settled: 254_115.36, unsettled: 0, availableToTrade: 254_115.36 } } },
        pending: [],
        balance: { account: { cash: 254_115.36, payable: null, assets: 1_000_515.36, liabilities: 0 } },
      },
    },
    {
      id: 'quote-arrives', action: 'quote', instrument: 'main', quote: { bid: 62.375, ask: 62.4375, last: 62.40625, bidSize: 5_000_000, askSize: 5_000_000 }, // 62-12, 62-14, 62-13
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_200_000, price: 62.40625, value: 748_875, unrealized: 3_000.36, priceSource: 'Test fixture' }], // 1,200,000 x 62.40625 / 100 - 745,874.64
        pnl: { account: { unrealized: 3_000.36, total: 2_990.36 } },
        nav: { account: 1_002_990.36, book: 2_002_990.36 },
        balance: { account: { positions: 748_875, assets: 1_002_990.36, netAssets: 1_002_990.36 } },
      },
    },
    {
      // A sale of 500,000 at 62.75 or better, good until cancelled. The bid is 62.375: the order rests.
      id: 'limit-sell-rests', covers: ['reduce', 'limit order'], action: 'ticket', instrument: 'main', side: 'sell', qty: 500_000, from: 'lot', order: { orderType: 'limit', limitPrice: 62.75, tif: 'gtc' },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 500_000, estimate: 62.375, executable: false, settleDate: '2026-10-14', orderType: 'limit',
          gross: 311_875, cash: 311_875, fees: 5 }] }, // what it would fetch at today's bid: 500,000 x 62.375 / 100
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'working', filledQty: 0, reason: 'Limit not reached: executable price 62.375 is below the limit 62.75.', fills: [] }] },
        events: [{ type: 'strategy.legs_added' }],
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'sell', status: 'working', qty: 500_000, filledQty: 0 }],
      },
    },
    { id: 'order-rests-overnight', covers: 'limit order', action: 'clock', to: EDT('2026-10-14'), expect: { events: [] } },
    {
      // The bid moves through the limit. The order fills at the bid, 62.78125 (62-25), on Wednesday 14 October and settles T+1 from then.
      id: 'limit-sell-fills', covers: ['reduce', 'limit order'], action: 'quote', instrument: 'main', quote: { bid: 62.78125, ask: 62.84375, last: 62.8125, bidSize: 5_000_000, askSize: 5_000_000 },
      expect: {
        // Proceeds 500,000 x 62.78125% = 313,906.25. Cost removed at the average: 745,874.64 x 5/12 = 310,781.10. Realized 3,125.15.
        // The fill is not what was confirmed (a better price, a later settlement), and the history says so.
        events: [
          { type: 'trade.fill', summary: 'Sold 500,000 STRIPS-MAY36 @ 62.78125 USD (realized 3,125.15 USD)', date: '2026-10-14' },
          { type: 'order.fill_variance', summary: /Filled at the bid on a later matching cycle.*62\.78125 against 62\.375 confirmed.*Settles 2026-10-15, not 2026-10-14 as confirmed/s },
        ],
        cash: { account: { USD: { settled: 254_115.36, unsettled: 313_901.25, availableToTrade: 568_016.61 } } }, // 313,906.25 - 5.00
        positions: [{ instrument: 'main', lot: 'lot', qty: 700_000, cost: 435_093.54, avgCost: 62.15622, price: 62.8125,
          value: 439_687.50, // 700,000 x 62.8125 / 100
          unrealized: 4_593.96 }],
        holdings: { main: { long: 700_000, short: 0, net: 700_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-10-15', amount: 313_901.25, into: 'cash' }],
        openOrders: [],
        pnl: { account: { realized: 3_125.15, commissions: -15, unrealized: 4_593.96, total: 7_704.11 } },
        nav: { account: 1_007_704.11, book: 2_007_704.11 },
        balance: { account: { cash: 254_115.36, receivable: 313_901.25, positions: 439_687.50, assets: 1_007_704.11, liabilities: 0, netAssets: 1_007_704.11 } },
      },
    },
    {
      id: 'settle-limit-sale', covers: 'settlement', action: 'clock', to: EDT('2026-10-15'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 313,901.25 USD into settled cash', cash: { USD: 313_901.25 } }],
        cash: { account: { USD: { settled: 568_016.61, unsettled: 0, availableToTrade: 568_016.61 } } },
        pending: [],
        balance: { account: { cash: 568_016.61, receivable: null } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 700_000, estimate: 62.78125, settleDate: '2026-10-16',
          gross: 439_468.75, // 700,000 x 62.78125 / 100
          accrued: 0, cash: 439_468.75, fees: 5 }] }, // 0.1 bp is 4.39: the minimum
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 700_000, avgPrice: 62.78125 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 700,000 STRIPS-MAY36 @ 62.78125 USD (realized 4,375.21 USD)' }], // 439,468.75 - 435,093.54
        cash: { account: { USD: { settled: 568_016.61, unsettled: 439_463.75, availableToTrade: 1_007_480.36 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-10-16', amount: 439_463.75, into: 'cash' }],
        lifecycle: [],
        // Realized in all: 313,906.25 + 439,468.75 - 745,874.64 = 7,500.36. Four orders at the 5.00 minimum.
        pnl: { account: { realized: 7_500.36, couponInterest: 0, commissions: -20, unrealized: 0, total: 7_480.36 } },
        nav: { account: 1_007_480.36, book: 2_007_480.36 },
        balance: { account: { cash: 568_016.61, receivable: 439_463.75, positions: null, assets: 1_007_480.36, liabilities: 0, netAssets: 1_007_480.36 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2026-10-16'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 439,463.75 USD into settled cash', cash: { USD: 439_463.75 } }],
        cash: { account: { USD: { settled: 1_007_480.36, unsettled: 0, availableToTrade: 1_007_480.36 } }, treasury: { USD: { settled: 1_000_000 } } },
        pending: [],
        balance: { account: { cash: 1_007_480.36, receivable: null, assets: 1_007_480.36, liabilities: 0, netAssets: 1_007_480.36 } },
      },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// foreign_gov_bill
// ---------------------------------------------------------------------------------------------
// A UK Treasury bill in sterling, in a Book that reports in US dollars. A discount instrument like
// the US bill, but quoted in its market as a simple yield on ACT/365, converted here by hand:
//     price = 100 / (1 + yield x days from settlement to maturity / 365).
// T+1 on the London calendar. Bought on Thursday 24 December 2026, it settles on Tuesday 29
// December: Christmas Day and the Boxing Day substitute (Monday 28 December) are UK bank holidays,
// and on that Monday New York is open, so the Terminal's day runs while London is shut.
// It matures on Monday 18 January 2027, which is a business day in London and a holiday in New
// York (Martin Luther King Jr. Day): the redemption is paid on the London date all the same.
//
// Reporting currency. Balances are translated at the current GBP/USD rate (a fixture). Income,
// commissions and realized P&L are translated at the rate in force when they were booked;
// unrealized P&L at the current rate. "FX effects" is the rest: what the change of rate did to
// the sterling the Account was funded with and has since earned or spent.
// Commission: 0.1 bp of principal.
const foreignGovBill = {
  productId: 'foreign_gov_bill',
  title: 'UK Treasury bill due 18 January 2027 in sterling, reported in US dollars: UK holidays, a refused settlement date, FX effects, redemption at par',
  matrix: {
    ...BOND_TICKET,
    manualInputs: ['the money-market yield is converted to a price in % of par by hand (the Terminal has no yield quotation)'],
    settlement: 'T+1 on the London calendar (venue country GB); UK bank holidays are skipped; a settlement date stated on a UK holiday is refused on the ticket',
    lifecycle: 'No coupon and no accrual; redemption at par on the maturity date by the London payment calendar, on a day New York is closed',
    accounting: 'Sterling position, cash and settlement; US dollar figures at the current rate for balances and unrealized P&L, at the booking rate for commission and realized P&L; the difference is reported as FX effects',
    collateral: 'None for a long position',
  },
  start: EST('2026-12-24'), // Thursday
  settlementCheck: { lag: 1, holidays: ['2026-12-25', '2026-12-28'] }, // Christmas Day and the Boxing Day substitute: UK bank holidays
  book: {
    name: 'Matrix UK Treasury bill', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'GBP', amount: 2_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'GBP', amount: 1_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.1 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  fx: { 'GBP/USD': 1.26 },
  instruments: {
    main: { productId: 'foreign_gov_bill', name: 'UK Treasury Bill 18-Jan-2027', symbol: 'UKTB-18JAN27', marketView: 'FOREIGN_CASH', venueType: 'otc', venueCountry: 'GB', issuer: 'HM Treasury', domicile: 'GB', underlyingGeo: 'GB', tradingCcy: 'GBP', multiplier: 0.01,
      terms: { couponType: 'zero', maturity: '2027-01-18', issueDate: '2026-10-19', dayCount: 'ACT/365', redemption: 100 } },
  },
  // Settlement 29 Dec, 20 days to maturity. Ask 99.785 is a yield of 3.93%: 100 / (1 + 0.0393 x 20/365) = 99.785. Bid 99.78 is 4.02%.
  quotes: { main: { bid: 99.78, ask: 99.785, last: 99.7825, bidSize: 50_000_000, askSize: 50_000_000 } },
  expectAtStart: {
    ...startState(1_890_000, 1_630_000), // 1,500,000 GBP x 1.26; 1,000,000 USD + 500,000 GBP x 1.26
    cash: { account: { GBP: idle(1_500_000) }, treasury: { USD: idle(1_000_000), GBP: idle(500_000) } },
  },
  steps: [
    {
      // Monday 28 December is the Boxing Day substitute. The ticket checks a stated settlement date against the settlement calendar.
      id: 'settle-on-uk-holiday', covers: 'stated settlement', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, order: { settle: { date: '2026-12-28' } },
      status: 'blocked', reason: 'A stated settlement date must be a business day of the instrument\'s settlement calendar; nothing is moved silently.',
      expect: { refused: 'the stated settlement date 2026-12-28 (Monday) is a holiday on UK, not a business day on the settlement calendar of UKTB-18JAN27' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 99.785, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-12-29', calendar: 'UK',
            gross: 997_850, // 1,000,000 x 99.785 / 100, in sterling
            accrued: 0, cash: -997_850, fees: 9.98 }], // 0.1 bp of 997,850 = 9.9785
          cash: { GBP: { purchases: 997_850, fees: 9.98, required: 997_859.98, available: 1_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 99.785, fills: [{ qty: 1_000_000, price: 99.785, model: 'quoted-bid-ask', settleDate: '2026-12-29', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 UKTB-18JAN27 @ 99.785 GBP', owner: 'account', date: '2026-12-24' }],
        cash: { account: { GBP: { settled: 1_500_000, unsettled: -997_859.98, availableToTrade: 502_140.02 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 99.785, cost: 997_850, price: 99.7825,
          value: 997_825, unrealized: -25, accrued: 0, priceSource: 'Test fixture' }], // sterling
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-12-29', amount: -997_859.98, ccy: 'GBP', into: 'cash' }],
        lifecycle: [{ type: 'bond.maturity', instrument: 'main', dueDate: '2027-01-18', status: 'pending' }],
        // In US dollars at 1.26: commission 9.98 x 1.26 = 12.57; unrealized -25 x 1.26 = -31.50.
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -12.57, fees: 0, borrowFunding: 0, unrealized: -31.50, fx: 0, total: -44.07 } },
        nav: { account: 1_889_955.93, book: 3_519_955.93 }, // (1,500,000 - 997,859.98 + 997,825) x 1.26
        balance: { account: { cash: 1_890_000, positions: 1_257_259.50, payable: 1_257_303.57, assets: 3_147_259.50, liabilities: 1_257_303.57, netAssets: 1_889_955.93, // 997,825 x 1.26; 997,859.98 x 1.26
          local: { GBP: { cash: 1_500_000, positions: 997_825, payable: 997_859.98 } } } },
      },
    },
    // Monday 28 December: New York is open and the Terminal's day runs; London is closed. The purchase has not settled and is still due on the 29th.
    { id: 'london-closed', covers: 'market holiday', action: 'clock', to: EST('2026-12-28'), expect: { events: [] } },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2026-12-29'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 997,859.98 GBP from settled cash', cash: { GBP: -997_859.98 }, date: '2026-12-29' }],
        cash: { account: { GBP: { settled: 502_140.02, unsettled: 0, availableToTrade: 502_140.02 } } },
        pending: [],
        balance: { account: { cash: 632_696.43, payable: null, assets: 1_889_955.93, liabilities: 0, local: { GBP: { cash: 502_140.02, payable: null } } } }, // 502,140.02 x 1.26 = 632,696.4252
      },
    },
    {
      id: 'sterling-rises', covers: 'fx', action: 'fx_rate', pair: 'GBP/USD', rate: 1.28,
      expect: {
        // Net assets 1,499,965.02 GBP x 1.28 = 1,919,955.23. Unrealized -25 x 1.28 = -32.00. Commission stays at its booking rate.
        // FX effects: the 1,500,000 GBP funded gained 0.02 each, 30,000.00; the 9.98 GBP spent gave 0.20 of that back: 29,999.80.
        pnl: { account: { commissions: -12.57, unrealized: -32, fx: 29_999.80, total: 29_955.23 }, book: { fx: 39_999.80 } }, // Treasury's 500,000 GBP gained 10,000.00
        nav: { account: 1_919_955.23, treasury: 1_640_000, book: 3_559_955.23 },
        balance: { account: { cash: 642_739.23, positions: 1_277_216, assets: 1_919_955.23, netAssets: 1_919_955.23 } }, // 502,140.02 x 1.28; 997,825 x 1.28
      },
    },
    {
      // Yields fall. Settlement 30 Dec, 19 days: bid 99.80 is a yield of 3.85%: 100 / (1 + 0.0385 x 19/365) = 99.80.
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 99.80, ask: 99.805, last: 99.8025, bidSize: 50_000_000, askSize: 50_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, price: 99.8025, value: 998_025, unrealized: 175 }], // sterling
        pnl: { account: { unrealized: 224, fx: 29_999.80, total: 30_211.23 } }, // 175 x 1.28; -12.57 + 224 + 29,999.80
        nav: { account: 1_920_211.23, book: 3_560_211.23 }, // (502,140.02 + 998,025) x 1.28
        balance: { account: { positions: 1_277_472, assets: 1_920_211.23, netAssets: 1_920_211.23, local: { GBP: { positions: 998_025 } } } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 400_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 400_000, estimate: 99.80, settleDate: '2026-12-30', calendar: 'UK',
          gross: 399_200, accrued: 0, cash: 399_200, fees: 3.99 }] }, // 400,000 x 99.80 / 100; 0.1 bp = 3.992
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 400_000, avgPrice: 99.80 }] },
        // Realized in sterling: 399,200 - 400,000 x 99.785% = 60.00. In dollars at today's 1.28: 76.80. Commission 3.99 x 1.28 = 5.11.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 400,000 UKTB-18JAN27 @ 99.80 GBP (realized 60.00 GBP)' }],
        cash: { account: { GBP: { settled: 502_140.02, unsettled: 399_196.01, availableToTrade: 901_336.03 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, cost: 598_710, avgCost: 99.785, price: 99.8025, value: 598_815, unrealized: 105 }], // 600,000 x 99.8025%; less 600,000 x 99.785%
        holdings: { main: { long: 600_000, short: 0, net: 600_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-12-30', amount: 399_196.01, ccy: 'GBP', into: 'cash' }],
        pnl: { account: { realized: 76.80, commissions: -17.68, unrealized: 134.40, fx: 29_999.80, total: 30_193.32 } }, // 12.57 + 5.11; 105 x 1.28
        nav: { account: 1_920_193.32, book: 3_560_193.32 }, // (502,140.02 + 399,196.01 + 598,815) x 1.28
        balance: { account: { cash: 642_739.23, receivable: 510_970.89, positions: 766_483.20, assets: 1_920_193.32, liabilities: 0, netAssets: 1_920_193.32, // 399,196.01 x 1.28; 598,815 x 1.28
          local: { GBP: { cash: 502_140.02, receivable: 399_196.01, positions: 598_815 } } } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: EST('2026-12-30'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 399,196.01 GBP into settled cash', cash: { GBP: 399_196.01 } }],
        cash: { account: { GBP: { settled: 901_336.03, unsettled: 0, availableToTrade: 901_336.03 } } },
        pending: [],
        balance: { account: { cash: 1_153_710.12, receivable: null, assets: 1_920_193.32, local: { GBP: { cash: 901_336.03, receivable: null } } } }, // 901,336.03 x 1.28
      },
    },
    {
      id: 'sterling-falls', covers: 'fx', action: 'fx_rate', pair: 'GBP/USD', rate: 1.24,
      expect: {
        // Net assets 1,500,151.03 GBP x 1.24 = 1,860,187.28. Unrealized 105 x 1.24 = 130.20.
        // FX effects: 1,500,000 funded at 1.26 lost 0.02, -30,000.00; the 60.00 realized at 1.28 lost 0.04, -2.40; the
        // commissions spent, 9.98 at 1.26 and 3.99 at 1.28, are worth less too, +0.20 and +0.16: -30,002.04.
        pnl: { account: { realized: 76.80, commissions: -17.68, unrealized: 130.20, fx: -30_002.04, total: -29_812.72 }, book: { fx: -40_002.04 } }, // Treasury's 500,000 GBP lost 10,000.00
        nav: { account: 1_860_187.28, treasury: 1_620_000, book: 3_480_187.28 },
        balance: { account: { cash: 1_117_656.68, positions: 742_530.60, assets: 1_860_187.28, netAssets: 1_860_187.28 } }, // 901,336.03 x 1.24; 598,815 x 1.24
      },
    },
    {
      // Monday 18 January 2027: Martin Luther King Jr. Day in New York, a business day in London. The bill is redeemed.
      id: 'maturity', covers: ['maturity', 'close'], action: 'clock', to: EST('2027-01-18'),
      expect: {
        // Realized in sterling: 600,000 - 598,710 = 1,290.00; in dollars at 1.24: 1,599.60.
        events: [
          { type: 'bond.redemption', summary: 'Redeemed at maturity: 600,000 UKTB-18JAN27 at 100.00% of par', owner: 'account', date: '2027-01-18' },
          { type: 'settlement.receive', summary: 'received 600,000.00 GBP into settled cash', cash: { GBP: 600_000 } },
        ],
        cash: { account: { GBP: { settled: 1_501_336.03, unsettled: 0, availableToTrade: 1_501_336.03 } }, treasury: { USD: { settled: 1_000_000 }, GBP: { settled: 500_000 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        lifecycle: [],
        // Sterling result: 60.00 + 1,290.00 realized - 13.97 commission = 1,336.03. In dollars: 76.80 + 1,599.60 - 17.68, and the FX effect.
        pnl: { account: { realized: 1_676.40, couponInterest: 0, commissions: -17.68, unrealized: 0, fx: -30_002.04, total: -28_343.32 } },
        nav: { account: 1_861_656.68, treasury: 1_620_000, book: 3_481_656.68 }, // 1,501,336.03 x 1.24
        balance: { account: { cash: 1_861_656.68, positions: null, assets: 1_861_656.68, liabilities: 0, netAssets: 1_861_656.68, local: { GBP: { cash: 1_501_336.03, positions: null } } } },
      },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// foreign_gov_bond
// ---------------------------------------------------------------------------------------------
// A 10-year Japanese government bond in yen, a currency with no minor unit, in a Book that reports
// in US dollars. 1.4%, coupons 20 June and 20 December, T+1 on the Tokyo calendar, traded in
// multiples of 50,000 yen. Its accrued interest is counted on ACT/365 (face x 1.4% x days / 365)
// while each coupon is exactly half the annual rate: 0.70 per 100, whatever the length of the period.
// Days from the 20 June 2026 coupon date: to 20 Nov 153, to 23 Nov 156.
// Monday 23 November 2026 is Labour Thanksgiving Day: Tokyo is closed, New York is open, and
// interest accrues all the same. The 20 December coupon date is a Sunday: paid Monday 21 December.
//
// Reporting currency (see foreign_gov_bill): every posting is translated at the rate in force when
// it is booked and rounded to the cent; balances and unrealized P&L at the current rate.
// USD/JPY is 125 at the start (one yen is 0.008 dollars) and 128 later (0.0078125).
// Commission: 0.1 bp of principal. Every yen amount is a whole number.
const foreignGovBond = {
  productId: 'foreign_gov_bond',
  title: 'Japanese government bond 1.4% due 20 December 2035 in yen, reported in US dollars: ACT/365 accrual, a Tokyo holiday, a coupon, FX effects',
  matrix: {
    ...BOND_TICKET,
    manualInputs: ['none'],
    settlement: 'T+1 on the Tokyo calendar (venue country JP); amounts in whole yen',
    lifecycle: 'Daily accrual on ACT/365, on a Tokyo holiday too; semi-annual coupon of exactly half the annual rate, paid on the next Tokyo business day after a Sunday coupon date',
    accounting: 'Yen position, cash, accrued interest and settlement; US dollar figures at the current rate for balances and unrealized P&L, at the booking rate for income, commission and realized P&L; FX effects reported separately',
    collateral: 'None for a long position',
  },
  start: EST('2026-11-19'), // Thursday
  settlementCheck: { lag: 1, holidays: ['2026-11-23'] }, // Labour Thanksgiving Day in Japan
  book: {
    name: 'Matrix Japanese government bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'JPY', amount: 300_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'JPY', amount: 250_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.1 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  fx: { 'USD/JPY': 125 },
  instruments: {
    main: { productId: 'foreign_gov_bond', name: 'Japan Government Bond 1.4% 20-Dec-2035', symbol: 'JGB-1.4-DEC35', marketView: 'FOREIGN_CASH', venueType: 'otc', venueCountry: 'JP', issuer: 'Government of Japan', domicile: 'JP', underlyingGeo: 'JP', tradingCcy: 'JPY', multiplier: 0.01,
      terms: { couponType: 'fixed', couponRate: 0.014, frequency: 2, maturity: '2035-12-20', issueDate: '2025-12-20', dayCount: 'ACT/365', redemption: 100, minDenomination: 50_000 } },
  },
  quotes: { main: { bid: 98.44, ask: 98.46, last: 98.45, bidSize: 5_000_000_000, askSize: 5_000_000_000 } }, // yen per 100 yen face
  expectAtStart: {
    ...startState(2_000_000, 1_400_000), // 250,000,000 JPY / 125; 1,000,000 USD + 50,000,000 JPY / 125
    cash: { account: { JPY: idle(250_000_000) }, treasury: { USD: idle(1_000_000), JPY: idle(50_000_000) } },
  },
  steps: [
    {
      id: 'odd-denomination', covers: 'minimum denomination', action: 'ticket', instrument: 'main', side: 'buy', qty: 200_030_000,
      status: 'blocked', reason: 'The bond trades in multiples of 50,000 yen face; 200,030,000 is not one.',
      expect: { refused: 'quantity must be a multiple of 50000' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 200_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 200_000_000, estimate: 98.46, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-11-20', calendar: 'JP',
            gross: 196_920_000, // 200,000,000 x 98.46 / 100
            accrued: 1_173_699, // settles 20 Nov, 153 days: 200,000,000 x 1.4% x 153/365 = 1,173,698.63
            cash: -198_093_699, fees: 1_969 }], // 0.1 bp of 196,920,000 = 1,969.2
          cash: { JPY: { purchases: 198_093_699, fees: 1_969, required: 198_095_668, available: 250_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 200_000_000, avgPrice: 98.46, fills: [{ qty: 200_000_000, price: 98.46, model: 'quoted-bid-ask', settleDate: '2026-11-20', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 200,000,000 JGB-1.4-DEC35 @ 98.46 JPY', owner: 'account', date: '2026-11-19' }],
        cash: { account: { JPY: { settled: 250_000_000, unsettled: -198_095_668, availableToTrade: 51_904_332 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 200_000_000, avgCost: 98.46, cost: 196_920_000, price: 98.45,
          value: 196_900_000, unrealized: -20_000, accrued: 1_173_699, priceSource: 'Test fixture' }], // yen
        holdings: { main: { long: 200_000_000, short: 0, net: 200_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-11-20', amount: -198_095_668, ccy: 'JPY', into: 'cash' }],
        // 20 Dec 2026 is a Sunday: the coupon is due Monday 21 Dec. 20 Dec 2035 is a Thursday.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2026-12-21', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2035-12-20', status: 'pending' }],
        // In dollars at 0.008: commission 1,969 x 0.008 = 15.75; unrealized -20,000 x 0.008 = -160.
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -15.75, fees: 0, borrowFunding: 0, unrealized: -160, fx: 0, total: -175.75 } },
        nav: { account: 1_999_824.25, book: 3_399_824.25 }, // (250,000,000 - 198,095,668 + 196,900,000 + 1,173,699) x 0.008
        balance: { account: { cash: 2_000_000, accruedIncome: 9_389.59, positions: 1_575_200, payable: 1_584_765.34, assets: 3_584_589.59, liabilities: 1_584_765.34, netAssets: 1_999_824.25, // 1,173,699 x 0.008 = 9,389.592; 198,095,668 x 0.008 = 1,584,765.344
          local: { JPY: { cash: 250_000_000, accruedIncome: 1_173_699, positions: 196_900_000, payable: 198_095_668 } } } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2026-11-20'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 198,095,668 JPY from settled cash', cash: { JPY: -198_095_668 }, date: '2026-11-20' }],
        cash: { account: { JPY: { settled: 51_904_332, unsettled: 0, availableToTrade: 51_904_332 } } },
        pending: [],
        balance: { account: { cash: 415_234.66, payable: null, assets: 1_999_824.25, liabilities: 0, local: { JPY: { cash: 51_904_332, payable: null } } } }, // 51,904,332 x 0.008 = 415,234.656
      },
    },
    {
      // Monday 23 November, 17:30 New York: Tokyo was closed all day, New York was not. End of day 23 Nov: interest to 23 Nov,
      // 156 days: 2,800,000 x 156/365 = 1,196,712.33 -> 1,196,712. Income 23,013 yen for the three days since settlement;
      // in dollars 23,013 x 0.008 = 184.10.
      id: 'tokyo-holiday', covers: ['market holiday', 'accrual'], action: 'clock', to: EST_1730('2026-11-23'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on JGB-1.4-DEC35: 23,013 JPY', date: '2026-11-23' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 200_000_000, accrued: 1_196_712 }],
        pnl: { account: { couponInterest: 184.10, total: 8.35 } },
        nav: { account: 2_000_008.35, book: 3_400_008.35 },
        // Each line is its yen balance at the rate, rounded: 1,196,712 x 0.008 = 9,573.70. The total is the yen total at the rate, rounded.
        balance: { account: { accruedIncome: 9_573.70, assets: 2_000_008.35, netAssets: 2_000_008.35, local: { JPY: { accruedIncome: 1_196_712 } } } },
      },
    },
    {
      id: 'yen-weakens', covers: 'fx', action: 'fx_rate', pair: 'USD/JPY', rate: 128, // one yen is now 0.0078125 dollars
      expect: {
        // Net assets 250,001,044 yen x 0.0078125 = 1,953,133.16. Unrealized -20,000 x 0.0078125 = -156.25.
        // FX effects: the yen balances stand in the books at what they were booked at, cash 415,234.66 + position at cost
        // 1,575,360.00 + accrued 9,573.69 = 2,000,168.35 dollars; at the new rate the same 250,021,044 yen are worth
        // 1,953,289.41: the difference is -46,878.94 (to the cent, from the unrounded 1,953,289.40625).
        pnl: { account: { couponInterest: 184.10, commissions: -15.75, unrealized: -156.25, fx: -46_878.94, total: -46_866.84 }, book: { fx: -56_253.94 } }, // Treasury's 50,000,000 yen: 390,625 - 400,000
        nav: { account: 1_953_133.16, treasury: 1_390_625, book: 3_343_758.16 },
        balance: { account: { cash: 405_502.59, accruedIncome: 9_349.31, positions: 1_538_281.25, assets: 1_953_133.16, netAssets: 1_953_133.16 } }, // 51,904,332; 1,196,712; 196,900,000, each x 0.0078125
      },
    },
    {
      id: 'coupon', covers: 'coupon', action: 'clock', to: EST('2026-12-21'),
      expect: {
        // The coupon of 20 Dec: half of 1.4% on 200,000,000 = 1,400,000 yen (not 2,800,000 x 183/365), paid Monday 21 Dec.
        // Accrued on the books 1,196,712; the coupon exceeds it by 203,288, the income since 23 Nov. In dollars at
        // 0.0078125: 203,288 x 0.0078125 = 1,588.19, so income to date is 184.10 + 1,588.19 = 1,772.29.
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 200,000,000 JGB-1.4-DEC35: 1,400,000 JPY', cash: { JPY: 1_400_000 }, owner: 'account', date: '2026-12-21' },
          { type: 'accrual.coupon', summary: 'Interest accrued on JGB-1.4-DEC35: 203,288 JPY' },
        ],
        cash: { account: { JPY: { settled: 53_304_332, availableToTrade: 53_304_332 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 200_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-06-21', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2035-12-20', status: 'pending' }], // 20 Jun 2027 is a Sunday
        // Rounding each posting to the cent moves the FX line by a cent here: 1,400,000 yen of accrued left the books at 10,937.50 and
        // the 203,288 came in at 1,588.19.
        pnl: { account: { couponInterest: 1_772.29, fx: -46_878.95, total: -45_278.66 }, book: { fx: -56_253.95 } },
        nav: { account: 1_954_721.34, book: 3_345_346.34 }, // (53,304,332 + 196,900,000) x 0.0078125
        balance: { account: { cash: 416_440.09, accruedIncome: null, assets: 1_954_721.34, netAssets: 1_954_721.34, local: { JPY: { cash: 53_304_332, accruedIncome: null } } } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 80_000_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 80_000_000, estimate: 98.44, settleDate: '2026-12-22', calendar: 'JP',
          gross: 78_752_000, // 80,000,000 x 98.44 / 100
          accrued: 6_137, // settles 22 Dec, 2 days: 80,000,000 x 1.4% x 2/365 = 6,136.99
          cash: 78_758_137, fees: 788 }] }, // 0.1 bp of 78,752,000 = 787.52
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 80_000_000, avgPrice: 98.44 }] },
        // Realized in yen: 78,752,000 - 80,000,000 x 98.46% = -16,000; in dollars -125.00. Commission 788 x 0.0078125 = 6.16.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 80,000,000 JGB-1\.4-DEC35 @ 98\.44 JPY \(realized [-−]16,000 JPY\)$/ }],
        cash: { account: { JPY: { settled: 53_304_332, unsettled: 78_757_349, availableToTrade: 132_061_681 } } }, // 78,752,000 + 6,137 - 788
        positions: [{ instrument: 'main', lot: 'lot', qty: 120_000_000, cost: 118_152_000, avgCost: 98.46, price: 98.45, value: 118_140_000, unrealized: -12_000,
          accrued: -6_137 }], // the interest sold, booked ahead of the two days it covers
        holdings: { main: { long: 120_000_000, short: 0, net: 120_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-12-22', amount: 78_757_349, ccy: 'JPY', into: 'cash' }],
        pnl: { account: { realized: -125, couponInterest: 1_772.29, commissions: -21.91, unrealized: -93.75, fx: -46_878.94, total: -45_347.31 }, book: { fx: -56_253.94 } }, // 15.75 + 6.16; -12,000 x 0.0078125
        nav: { account: 1_954_652.69, book: 3_345_277.69 }, // (53,304,332 + 78,757,349 + 118,140,000 - 6,137) x 0.0078125
        balance: { account: { cash: 416_440.09, receivable: 615_291.79, accruedIncome: -47.95, positions: 922_968.75, assets: 1_954_652.69, liabilities: 0, netAssets: 1_954_652.69,
          local: { JPY: { cash: 53_304_332, receivable: 78_757_349, accruedIncome: -6_137, positions: 118_140_000 } } } },
      },
    },
    {
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EST('2026-12-22'),
      expect: {
        // End of day 21 Dec: 200,000,000 was still settled, one day: 2,800,000 x 1/365 = 7,671.23; less the 6,136.99 sold: 1,534.
        // On the books -6,137: income 7,671 yen, 59.93 dollars.
        events: [
          { type: 'settlement.receive', summary: 'received 78,757,349 JPY into settled cash', cash: { JPY: 78_757_349 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on JGB-1.4-DEC35: 7,671 JPY' },
        ],
        cash: { account: { JPY: { settled: 132_061_681, unsettled: 0, availableToTrade: 132_061_681 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 120_000_000, accrued: 1_534 }],
        pending: [],
        pnl: { account: { couponInterest: 1_832.22, total: -45_287.38 } },
        nav: { account: 1_954_712.62, book: 3_345_337.62 },
        balance: { account: { cash: 1_031_731.88, receivable: null, accruedIncome: 11.98, assets: 1_954_712.62, netAssets: 1_954_712.62, local: { JPY: { cash: 132_061_681, receivable: null, accruedIncome: 1_534 } } } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 120_000_000, estimate: 98.44, settleDate: '2026-12-23',
          gross: 118_128_000, // 120,000,000 x 98.44 / 100
          accrued: 13_808, // settles 23 Dec, 3 days: 120,000,000 x 1.4% x 3/365 = 13,808.22
          cash: 118_141_808, fees: 1_181 }] }, // 0.1 bp of 118,128,000 = 1,181.28
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 120_000_000, avgPrice: 98.44 }] },
        // Realized -24,000 yen (-187.50 dollars). Interest: 13,808 sold against 1,534 on the books: 12,274 more income (95.89 dollars).
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 120,000,000 JGB-1\.4-DEC35 @ 98\.44 JPY \(realized [-−]24,000 JPY\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of JGB-1.4-DEC35: 12,274 JPY' },
        ],
        cash: { account: { JPY: { settled: 132_061_681, unsettled: 118_140_627, availableToTrade: 250_202_308 } } }, // 118,128,000 + 13,808 - 1,181
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-12-23', amount: 118_140_627, ccy: 'JPY', into: 'cash' }],
        lifecycle: [],
        // Yen result: interest 23,013 + 203,288 + 7,671 + 12,274 = 246,246; realized -40,000; commissions 3,938: +202,308.
        pnl: { account: { realized: -312.50, couponInterest: 1_928.11, commissions: -31.14, unrealized: 0, fx: -46_878.94, total: -45_294.47 } }, // 21.91 + 1,181 x 0.0078125
        nav: { account: 1_954_705.53, book: 3_345_330.53 }, // 250,202,308 x 0.0078125
        balance: { account: { cash: 1_031_731.88, receivable: 922_973.65, positions: null, accruedIncome: null, assets: 1_954_705.53, liabilities: 0, netAssets: 1_954_705.53,
          local: { JPY: { cash: 132_061_681, receivable: 118_140_627, positions: null, accruedIncome: null } } } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EST('2026-12-23'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 118,140,627 JPY into settled cash', cash: { JPY: 118_140_627 } }],
        cash: { account: { JPY: { settled: 250_202_308, unsettled: 0, availableToTrade: 250_202_308 } }, treasury: { USD: { settled: 1_000_000 }, JPY: { settled: 50_000_000 } } },
        pending: [],
        nav: { account: 1_954_705.53, treasury: 1_390_625, book: 3_345_330.53 },
        balance: { account: { cash: 1_954_705.53, receivable: null, assets: 1_954_705.53, liabilities: 0, netAssets: 1_954_705.53, local: { JPY: { cash: 250_202_308, receivable: null } } } },
      },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// em_local_debt
// ---------------------------------------------------------------------------------------------
// A South African government bond in rand, listed on the JSE, in a Book that reports in US
// dollars. 8.875%, coupons on the last day of February and on 31 August (a month-end schedule:
// 28 or 29 February), accrued on ACT/365, each coupon half the annual rate (4.4375 per 100).
// It settles T+3, set on the instrument itself (the Book's bond default is T+1), and it trades in
// lots of 1,000,000 rand. The Terminal has no holiday calendar for South Africa: every date for
// this bond is worked out on weekends only, the instrument and every preview say so, and rand
// payment dates are flagged as approximate. Local holidays are therefore not tested here.
// 28 Feb 2026 to 31 Aug 2026 is 184 days. Days from 28 Feb: to 27 Aug 180.
// USD/ZAR is 16 at the start (one rand is 0.0625 dollars) and 20 after the rand falls (0.05).
// Commission: 1 bp of principal. Not modelled: the books-closed (ex-coupon) period before a coupon.
const emLocalDebt = {
  productId: 'em_local_debt',
  title: 'South African government bond 8.875% due 28 February 2035 in rand: JSE-listed, T+3 on a weekends-only calendar, month-end coupons, a currency fall',
  matrix: {
    ...BOND_TICKET,
    manualInputs: ['none (local holidays would have to be added by hand in Settings: the calendar is weekends only)'],
    settlement: 'T+3 from the instrument\'s own settlement convention, counted on weekends only because no South African calendar exists; every preview carries the calendar-fallback warning',
    lifecycle: 'Daily accrual on ACT/365; month-end semi-annual coupons of half the annual rate; the books-closed period before a coupon is not modelled',
    accounting: 'Rand position, cash, accrued interest and settlement; US dollar figures at the current rate for balances and unrealized P&L, at the booking rate for income, commission and realized P&L; FX effects reported separately',
    collateral: 'None for a long position',
  },
  start: EDT('2026-08-24'), // Monday
  settlementCheck: { lag: 3, holidays: [] }, // weekends only: no South African holiday is known to the Terminal
  book: {
    name: 'Matrix rand government bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'ZAR', amount: 100_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'ZAR', amount: 80_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 1 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  fx: { 'USD/ZAR': 16 },
  instruments: {
    main: { productId: 'em_local_debt', name: 'Republic of South Africa 8.875% 28-Feb-2035', symbol: 'RSA-8.875-FEB35', marketView: 'FOREIGN_CASH', venueType: 'exchange', venue: 'JSE', venueCountry: 'ZA', issuer: 'Republic of South Africa', domicile: 'ZA', underlyingGeo: 'ZA', tradingCcy: 'ZAR', multiplier: 0.01,
      conventions: { settleLag: 3 },
      terms: { couponType: 'fixed', couponRate: 0.08875, frequency: 2, maturity: '2035-02-28', issueDate: '2010-02-28', dayCount: 'ACT/365', redemption: 100, minDenomination: 1_000_000 } },
  },
  quotes: { main: { bid: 91.2, ask: 91.3, last: 91.25, bidSize: 500_000_000, askSize: 500_000_000 } },
  expectAtStart: {
    ...startState(5_000_000, 2_250_000), // 80,000,000 ZAR / 16; 1,000,000 USD + 20,000,000 ZAR / 16
    cash: { account: { ZAR: idle(80_000_000) }, treasury: { USD: idle(1_000_000), ZAR: idle(20_000_000) } },
  },
  steps: [
    {
      id: 'odd-lot', covers: 'minimum denomination', action: 'ticket', instrument: 'main', side: 'buy', qty: 50_500_000,
      status: 'blocked', reason: 'The bond trades in lots of 1,000,000 rand face; 50,500,000 is not a whole number of them.',
      expect: { refused: 'quantity must be a multiple of 1000000' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 50_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: ['calendar-fallback'], // "the settlement date 2026-08-27 ... was worked out on weekends only"
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 50_000_000, estimate: 91.3, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-08-27', calendar: 'WEEKEND', // Monday + 3 days
            gross: 45_650_000, // 50,000,000 x 91.30 / 100
            accrued: 2_188_356.16, // settles 27 Aug, 180 days: 50,000,000 x 8.875% x 180/365 = 2,188,356.164
            cash: -47_838_356.16, fees: 4_565 }], // 1 bp of 45,650,000
          cash: { ZAR: { purchases: 47_838_356.16, fees: 4_565, required: 47_842_921.16, available: 80_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 50_000_000, avgPrice: 91.3, fills: [{ qty: 50_000_000, price: 91.3, model: 'quoted-bid-ask', settleDate: '2026-08-27', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 50,000,000 RSA-8.875-FEB35 @ 91.30 ZAR', owner: 'account', date: '2026-08-24' }],
        cash: { account: { ZAR: { settled: 80_000_000, unsettled: -47_842_921.16, availableToTrade: 32_157_078.84 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50_000_000, avgCost: 91.3, cost: 45_650_000, price: 91.25,
          value: 45_625_000, unrealized: -25_000, accrued: 2_188_356.16, priceSource: 'Test fixture' }], // rand
        holdings: { main: { long: 50_000_000, short: 0, net: 50_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-08-27', amount: -47_842_921.16, ccy: 'ZAR', into: 'cash' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2026-08-31', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2035-02-28', status: 'pending' }], // a Monday; a Wednesday
        // In dollars at 0.0625: commission 4,565 x 0.0625 = 285.31; unrealized -25,000 x 0.0625 = -1,562.50.
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -285.31, fees: 0, borrowFunding: 0, unrealized: -1_562.50, fx: 0, total: -1_847.81 } },
        nav: { account: 4_998_152.19, book: 7_248_152.19 }, // (80,000,000 - 47,842,921.16 + 45,625,000 + 2,188,356.16) x 0.0625
        balance: { account: { cash: 5_000_000, accruedIncome: 136_772.26, positions: 2_851_562.50, payable: 2_990_182.57, assets: 7_988_334.76, liabilities: 2_990_182.57, netAssets: 4_998_152.19, // each rand line x 0.0625
          local: { ZAR: { cash: 80_000_000, accruedIncome: 2_188_356.16, positions: 45_625_000, payable: 47_842_921.16 } } } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2026-08-27'), // Thursday, T+3
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 47,842,921.16 ZAR from settled cash', cash: { ZAR: -47_842_921.16 }, date: '2026-08-27' }],
        cash: { account: { ZAR: { settled: 32_157_078.84, unsettled: 0, availableToTrade: 32_157_078.84 } } },
        pending: [],
        balance: { account: { cash: 2_009_817.43, payable: null, assets: 4_998_152.19, liabilities: 0, local: { ZAR: { cash: 32_157_078.84, payable: null } } } }, // 32,157,078.84 x 0.0625
      },
    },
    {
      id: 'coupon', covers: 'coupon', action: 'clock', to: EDT('2026-08-31'), // Monday, the coupon date
      expect: {
        // Coupon: half of 8.875% on 50,000,000 = 2,218,750.00 rand, to the face settled on the 27th. Accrued on the books
        // 2,188,356.16; the coupon exceeds it by 30,393.84, the income of the four days held (the period has 184 days, so
        // ACT/365 accrual would overshoot an equal half-year coupon; the coupon is what is paid). In dollars 30,393.84 x 0.0625 = 1,899.62.
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 50,000,000 RSA-8.875-FEB35: 2,218,750.00 ZAR', cash: { ZAR: 2_218_750 }, owner: 'account', date: '2026-08-31' },
          { type: 'accrual.coupon', summary: 'Interest accrued on RSA-8.875-FEB35: 30,393.84 ZAR' },
        ],
        cash: { account: { ZAR: { settled: 34_375_828.84, availableToTrade: 34_375_828.84 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 50_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-03-01', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2035-02-28', status: 'pending' }], // 28 Feb 2027 is a Sunday
        // A cent of rounding sits in FX effects: the accrued left the books at 2,188,356.16 x 0.0625 = 136,772.26 + 1,899.62 = 138,671.88
        // and the coupon arrived as 2,218,750 x 0.0625 = 138,671.875.
        pnl: { account: { couponInterest: 1_899.62, fx: -0.01, total: 51.80 } },
        nav: { account: 5_000_051.80, book: 7_250_051.80 }, // (34,375,828.84 + 45,625,000) x 0.0625
        balance: { account: { cash: 2_148_489.30, accruedIncome: null, assets: 5_000_051.80, netAssets: 5_000_051.80, local: { ZAR: { cash: 34_375_828.84, accruedIncome: null } } } },
      },
    },
    {
      id: 'rand-falls', covers: 'fx', action: 'fx_rate', pair: 'USD/ZAR', rate: 20, // one rand is now 0.05 dollars
      expect: {
        // Net assets 80,000,828.84 rand x 0.05 = 4,000,041.44. Unrealized -25,000 x 0.05 = -1,250.
        // FX effects: the rand cash and the position at cost, 80,025,828.84 rand, were booked at 5,001,614.31 dollars and are
        // worth 4,001,291.44 now: -1,000,322.87. A fifth of the dollar value of the rand is gone.
        pnl: { account: { couponInterest: 1_899.62, commissions: -285.31, unrealized: -1_250, fx: -1_000_322.87, total: -999_958.56 }, book: { fx: -1_250_322.87 } }, // Treasury's 20,000,000 rand: 1,000,000 - 1,250,000
        nav: { account: 4_000_041.44, treasury: 2_000_000, book: 6_000_041.44 },
        balance: { account: { cash: 1_718_791.44, positions: 2_281_250, assets: 4_000_041.44, netAssets: 4_000_041.44 } }, // 34,375,828.84 x 0.05; 45,625,000 x 0.05
      },
    },
    {
      id: 'quote-down', action: 'quote', instrument: 'main', quote: { bid: 90.4, ask: 90.5, last: 90.45, bidSize: 500_000_000, askSize: 500_000_000 }, // yields rise with the currency
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 50_000_000, price: 90.45, value: 45_225_000, unrealized: -425_000 }], // 50,000,000 x 90.45% - 45,650,000
        pnl: { account: { unrealized: -21_250, total: -1_019_958.56 } }, // -425,000 x 0.05
        nav: { account: 3_980_041.44, book: 5_980_041.44 },
        balance: { account: { positions: 2_261_250, assets: 3_980_041.44, netAssets: 3_980_041.44, local: { ZAR: { positions: 45_225_000 } } } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 20_000_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], warnings: ['calendar-fallback'], legs: [{ kind: 'trade', action: 'sell', qty: 20_000_000, estimate: 90.4, settleDate: '2026-09-03', calendar: 'WEEKEND',
          gross: 18_080_000, // 20,000,000 x 90.40 / 100
          accrued: 14_589.04, // settles 3 Sep, 3 days into the new period: 20,000,000 x 8.875% x 3/365 = 14,589.041
          cash: 18_094_589.04, fees: 1_808 }] }, // 1 bp of 18,080,000
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 20_000_000, avgPrice: 90.4 }] },
        // Realized in rand: 18,080,000 - 20,000,000 x 91.30% = -180,000; in dollars at 0.05: -9,000. Commission 1,808 x 0.05 = 90.40.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 20,000,000 RSA-8\.875-FEB35 @ 90\.40 ZAR \(realized [-−]180,000\.00 ZAR\)$/ }],
        cash: { account: { ZAR: { settled: 34_375_828.84, unsettled: 18_092_781.04, availableToTrade: 52_468_609.88 } } }, // 18,080,000 + 14,589.04 - 1,808
        positions: [{ instrument: 'main', lot: 'lot', qty: 30_000_000, cost: 27_390_000, avgCost: 91.3, price: 90.45, value: 27_135_000, unrealized: -255_000,
          accrued: -14_589.04 }], // the interest sold, booked ahead of the three days it covers
        holdings: { main: { long: 30_000_000, short: 0, net: 30_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-09-03', amount: 18_092_781.04, ccy: 'ZAR', into: 'cash' }],
        pnl: { account: { realized: -9_000, couponInterest: 1_899.62, commissions: -375.71, unrealized: -12_750, fx: -1_000_322.87, total: -1_020_548.96 } }, // 285.31 + 90.40; -255,000 x 0.05
        nav: { account: 3_979_451.04, book: 5_979_451.04 }, // (34,375,828.84 + 18,092,781.04 + 27,135,000 - 14,589.04) x 0.05
        balance: { account: { cash: 1_718_791.44, receivable: 904_639.05, accruedIncome: -729.45, positions: 1_356_750, assets: 3_979_451.04, liabilities: 0, netAssets: 3_979_451.04,
          local: { ZAR: { cash: 34_375_828.84, receivable: 18_092_781.04, accruedIncome: -14_589.04, positions: 27_135_000 } } } },
      },
    },
    {
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2026-09-03'), // Thursday
      expect: {
        // End of day 2 Sep: all 50,000,000 was still settled, two days: 4,437,500 x 2/365 = 24,315.07; less the 14,589.04 sold: 9,726.03.
        // On the books -14,589.04: income 24,315.07 rand, 1,215.75 dollars.
        events: [
          { type: 'settlement.receive', summary: 'received 18,092,781.04 ZAR into settled cash', cash: { ZAR: 18_092_781.04 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on RSA-8.875-FEB35: 24,315.07 ZAR' },
        ],
        cash: { account: { ZAR: { settled: 52_468_609.88, unsettled: 0, availableToTrade: 52_468_609.88 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 30_000_000, accrued: 9_726.03 }],
        pending: [],
        pnl: { account: { couponInterest: 3_115.37, fx: -1_000_322.86, total: -1_019_333.20 }, book: { fx: -1_250_322.86 } }, // a cent of posting rounding moves into FX effects and back out at the next step
        nav: { account: 3_980_666.80, book: 5_980_666.80 },
        balance: { account: { cash: 2_623_430.49, receivable: null, accruedIncome: 486.30, assets: 3_980_666.80, netAssets: 3_980_666.80, local: { ZAR: { cash: 52_468_609.88, receivable: null, accruedIncome: 9_726.03 } } } },
      },
    },
    {
      // Thursday 3 Sep. T+3 is Tuesday 8 Sep: Monday 7 Sep is Labor Day in New York, which means nothing to a rand bond.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], warnings: ['calendar-fallback'], legs: [{ kind: 'trade', action: 'sell', qty: 30_000_000, estimate: 90.4, settleDate: '2026-09-08',
          gross: 27_120_000, // 30,000,000 x 90.40 / 100
          accrued: 58_356.16, // settles 8 Sep, 8 days: 30,000,000 x 8.875% x 8/365 = 58,356.164
          cash: 27_178_356.16, fees: 2_712 }] }, // 1 bp of 27,120,000
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 30_000_000, avgPrice: 90.4 }] },
        // Realized -270,000 rand (-13,500 dollars). Interest: 58,356.16 sold against 9,726.03 on the books: 48,630.13 more income (2,431.51 dollars).
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 30,000,000 RSA-8\.875-FEB35 @ 90\.40 ZAR \(realized [-−]270,000\.00 ZAR\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of RSA-8.875-FEB35: 48,630.13 ZAR' },
        ],
        cash: { account: { ZAR: { settled: 52_468_609.88, unsettled: 27_175_644.16, availableToTrade: 79_644_254.04 } } }, // 27,120,000 + 58,356.16 - 2,712
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-09-08', amount: 27_175_644.16, ccy: 'ZAR', into: 'cash' }],
        lifecycle: [],
        // Rand result: interest 30,393.84 + 24,315.07 + 48,630.13 = 103,339.04; realized -450,000; commissions 9,085: -355,745.96.
        pnl: { account: { realized: -22_500, couponInterest: 5_546.88, commissions: -511.31, unrealized: 0, fx: -1_000_322.87, total: -1_017_787.30 }, book: { fx: -1_250_322.87 } },
        nav: { account: 3_982_212.70, book: 5_982_212.70 }, // 79,644,254.04 x 0.05
        balance: { account: { cash: 2_623_430.49, receivable: 1_358_782.21, positions: null, accruedIncome: null, assets: 3_982_212.70, liabilities: 0, netAssets: 3_982_212.70,
          local: { ZAR: { cash: 52_468_609.88, receivable: 27_175_644.16, positions: null, accruedIncome: null } } } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2026-09-08'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 27,175,644.16 ZAR into settled cash', cash: { ZAR: 27_175_644.16 } }],
        cash: { account: { ZAR: { settled: 79_644_254.04, unsettled: 0, availableToTrade: 79_644_254.04 } }, treasury: { USD: { settled: 1_000_000 }, ZAR: { settled: 20_000_000 } } },
        pending: [],
        nav: { account: 3_982_212.70, treasury: 2_000_000, book: 5_982_212.70 },
        balance: { account: { cash: 3_982_212.70, receivable: null, assets: 3_982_212.70, liabilities: 0, netAssets: 3_982_212.70, local: { ZAR: { cash: 79_644_254.04, receivable: null } } } },
      },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// em_hard_debt
// ---------------------------------------------------------------------------------------------
// A US dollar bond of an emerging-market sovereign (a "hard-currency" Eurobond): 6.25%, coupons 15
// March and 15 September, 30/360, T+2 set on the instrument, traded over the counter and settled on
// US dollar payment days (Federal Reserve holidays). It sits in the Foreign Based view although it is
// in dollars. Pieces are multiples of 1,000 (the usual 200,000 minimum piece is not modelled: the
// Terminal has one quantity step, not a minimum and an increment).
//
// 30/360 counts every month as 30 days. From the 15 March coupon date: to 31 August 166 days
// (5 x 30 + 16; the 31st counts as the 31st because the period did not start on a 30th or 31st),
// to 2 September 167 (so 31 August to 2 September is ONE day of interest), to 4 September 169,
// to 8 September 173. A full coupon is 3.125 per 100.
// The Account has 500,000 and buys 1,008,868.44 worth: without funding the trade is refused; with
// "Fund the shortfall from Treasury" on the ticket, Treasury funds exactly the shortfall as part of
// the same package. That is an internal transfer: no Book P&L and no borrowing. It is returned at the end.
// Commission: 0.5 bp of principal.
const emHardDebt = {
  productId: 'em_hard_debt',
  title: 'Republic of Colombia 6.25% US dollar bond due 15 March 2034: 30/360, T+2 over Labor Day, a cash shortfall funded by Treasury from the ticket',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount', '"If cash is short": Fund the shortfall from Treasury, when the Account cannot pay'],
    manualInputs: ['none'],
    settlement: 'T+2 from the instrument\'s own convention on the US dollar payment calendar (OTC, no venue country); Labor Day is skipped',
    lifecycle: 'Daily accrual on 30/360; semi-annual coupon to the face settled before the coupon date; next coupon and maturity scheduled',
    accounting: 'Clean cost at average; accrued interest bought and sold through Accrued income; Treasury funding of the shortfall is an internal transfer (no P&L in the Book, no borrowing), returned by a transfer at the end',
    collateral: 'None for a long position',
  },
  start: EDT('2026-08-27'), // Thursday
  settlementCheck: { lag: 2, holidays: ['2026-09-07'] }, // Labor Day, a Federal Reserve holiday
  book: {
    name: 'Matrix hard-currency sovereign', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'em_hard_debt', name: 'Republic of Colombia 6.25% 15-Mar-2034 USD', symbol: 'COLOM-6.25-MAR34', marketView: 'FOREIGN_CASH', venueType: 'otc', issuer: 'Republic of Colombia', domicile: 'CO', underlyingGeo: 'CO', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settleLag: 2 },
      terms: { couponType: 'fixed', couponRate: 0.0625, frequency: 2, maturity: '2034-03-15', issueDate: '2024-03-15', dayCount: '30/360', redemption: 100, minDenomination: 1_000 } },
  },
  quotes: { main: { bid: 97.75, ask: 98, last: 97.875, bidSize: 20_000_000, askSize: 20_000_000 } },
  expectAtStart: { ...startState(500_000, 2_500_000), cash: { account: usdCash(500_000), treasury: usdCash(2_500_000) } },
  steps: [
    {
      // 980,000.00 principal + 28,819.44 accrued + 49.00 commission = 1,008,868.44 against 500,000.00 of cash.
      id: 'short-of-cash', covers: 'insufficient cash', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000,
      status: 'blocked', reason: 'The Account cannot pay for the purchase and no funding was chosen: nothing is funded silently.',
      expect: { refused: /Alpha is short 508,868\.44 USD: the package needs 1,008,868\.44 USD.*500,000\.00 USD is available/s },
    },
    {
      id: 'open-funded-by-treasury', covers: ['open', 'Treasury funding'], action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot', financing: { mode: 'treasury' },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', action: 'treasury_funding', qty: 508_868.44, cash: 508_868.44 }, // exactly the shortfall
            { kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 98, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-08-31', calendar: 'USD', dependsOn: [1], // Friday, Monday
              gross: 980_000, // 1,000,000 x 98 / 100
              accrued: 28_819.44, // settles 31 Aug, 166 days of 30/360: 1,000,000 x 6.25% x 166/360 = 28,819.444
              cash: -1_008_819.44, fees: 49 }, // 0.5 bp of 980,000
          ],
          cash: { USD: { purchases: 1_008_819.44, fees: 49, financingIn: 508_868.44, required: 1_008_868.44, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [
          { kind: 'funding', action: 'treasury_funding', status: 'filled', filledQty: 508_868.44 },
          { kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 98, fills: [{ qty: 1_000_000, price: 98, model: 'quoted-bid-ask', settleDate: '2026-08-31', source: 'Test fixture' }] },
        ] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 508,868.44 USD from Treasury to Alpha', owner: 'treasury', date: '2026-08-27' },
          { type: 'trade.fill', summary: 'Bought 1,000,000 COLOM-6.25-MAR34 @ 98.00 USD', owner: 'account', date: '2026-08-27' },
        ],
        cash: {
          account: { USD: { settled: 1_008_868.44, unsettled: -1_008_868.44, availableToTrade: 0 } }, // all of it is owed for the purchase
          treasury: { USD: { settled: 1_991_131.56, availableToTrade: 1_991_131.56 } }, // 2,500,000 - 508,868.44
        },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 98, cost: 980_000, price: 97.875,
          value: 978_750, unrealized: -1_250, accrued: 28_819.44, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-08-31', amount: -1_008_868.44, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2026-09-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-03-15', status: 'pending' }], // a Tuesday; a Wednesday
        borrowings: [], // funding from Treasury is not a borrowing
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -49, fees: 0, borrowFunding: 0, unrealized: -1_250, total: -1_299 } },
        // The funding moved net assets from Treasury to the Account; the Book changed only by the commission and the mark.
        nav: { account: 1_007_569.44, treasury: 1_991_131.56, book: 2_998_701 }, // 500,000 + 508,868.44 - 49 - 1,250
        balance: { account: { cash: 1_008_868.44, accruedIncome: 28_819.44, positions: 978_750, payable: 1_008_868.44, assets: 2_016_437.88, liabilities: 1_008_868.44, netAssets: 1_007_569.44 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2026-08-31'), // Monday
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,008,868.44 USD from settled cash', cash: { USD: -1_008_868.44 }, date: '2026-08-31' }],
        cash: { account: null }, // every dollar is in the bond: the Account has no cash balance in any currency, and none is listed
        pending: [],
        balance: { account: { cash: null, payable: null, assets: 1_007_569.44, liabilities: 0 } },
      },
    },
    {
      // Thursday 3 Sep. End of day 2 Sep: 167 days, 1,000,000 x 6.25% x 167/360 = 28,993.06. One day of interest since the 31st.
      id: 'one-day-of-interest', covers: 'accrual', action: 'clock', to: EDT('2026-09-03'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on COLOM-6.25-MAR34: 173.62 USD' }], // 28,993.06 - 28,819.44
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, accrued: 28_993.06 }],
        pnl: { account: { couponInterest: 173.62, total: -1_125.38 } },
        nav: { account: 1_007_743.06, book: 2_998_874.62 },
        balance: { account: { accruedIncome: 28_993.06, assets: 1_007_743.06, netAssets: 1_007_743.06 } },
      },
    },
    {
      // T+2 from Thursday 3 Sep: Friday 4, then Monday 7 is Labor Day, so Tuesday 8 Sep.
      id: 'reduce', covers: ['reduce', 'market holiday'], action: 'ticket', instrument: 'main', side: 'sell', qty: 400_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 400_000, estimate: 97.75, settleDate: '2026-09-08', calendar: 'USD',
          gross: 391_000, // 400,000 x 97.75 / 100
          accrued: 12_013.89, // settles 8 Sep, 173 days: 400,000 x 6.25% x 173/360 = 12,013.889
          cash: 403_013.89, fees: 19.55 }] }, // 0.5 bp of 391,000
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 400_000, avgPrice: 97.75 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 400,000 COLOM-6\.25-MAR34 @ 97\.75 USD \(realized [-−]1,000\.00 USD\)$/ }], // 391,000 - 400,000 x 98%
        cash: { account: { USD: { settled: 0, unsettled: 402_994.34, reserved: 0, restricted: 0, margin: 0, availableToTrade: 402_994.34 } } }, // 391,000 + 12,013.89 - 19.55
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, cost: 588_000, avgCost: 98, price: 97.875, value: 587_250, unrealized: -750,
          accrued: 16_979.17 }], // 28,993.06 - 12,013.89
        holdings: { main: { long: 600_000, short: 0, net: 600_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-09-08', amount: 402_994.34, into: 'cash' }],
        pnl: { account: { realized: -1_000, couponInterest: 173.62, commissions: -68.55, unrealized: -750, total: -1_644.93 } },
        nav: { account: 1_007_223.51, book: 2_998_355.07 },
        balance: { account: { receivable: 402_994.34, accruedIncome: 16_979.17, positions: 587_250, assets: 1_007_223.51, liabilities: 0, netAssets: 1_007_223.51 } },
      },
    },
    {
      // Labor Day, Monday 7 Sep: no dollar payments, so the sale does not settle. The last end of day was Friday 4 Sep: 1,000,000 still
      // settled, 169 days = 29,340.28, less the 12,013.89 sold: 17,326.39. Income 347.22: two 30/360 days on 1,000,000.
      id: 'labor-day', covers: ['market holiday', 'accrual'], action: 'clock', to: EDT('2026-09-07'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on COLOM-6.25-MAR34: 347.22 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, accrued: 17_326.39 }],
        pnl: { account: { couponInterest: 520.84, total: -1_297.71 } },
        nav: { account: 1_007_570.73, book: 2_998_702.29 },
        balance: { account: { accruedIncome: 17_326.39, assets: 1_007_570.73, netAssets: 1_007_570.73 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: EDT('2026-09-08'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 402,994.34 USD into settled cash', cash: { USD: 402_994.34 } }],
        cash: { account: { USD: { settled: 402_994.34, unsettled: 0, availableToTrade: 402_994.34 } } },
        pending: [],
        balance: { account: { cash: 402_994.34, receivable: null } },
      },
    },
    {
      id: 'coupon', covers: 'coupon', action: 'clock', to: EDT('2026-09-15'), // Tuesday
      expect: {
        // Coupon on the 600,000 settled before the 15th: 600,000 x 3.125% = 18,750.00. Accrued on the books 17,326.39;
        // the rest, 1,423.61, is the income since 4 Sep (11 days on 600,000 = 1,145.83, and the four days to 8 Sep on the 400,000 sold = 277.78).
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 600,000 COLOM-6.25-MAR34: 18,750.00 USD', cash: { USD: 18_750 }, owner: 'account', date: '2026-09-15' },
          { type: 'accrual.coupon', summary: 'Interest accrued on COLOM-6.25-MAR34: 1,423.61 USD' },
        ],
        cash: { account: { USD: { settled: 421_744.34, availableToTrade: 421_744.34 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 600_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-03-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-03-15', status: 'pending' }], // a Monday
        pnl: { account: { couponInterest: 1_944.45, total: 125.90 } },
        nav: { account: 1_008_994.34, book: 3_000_125.90 },
        balance: { account: { cash: 421_744.34, accruedIncome: null, assets: 1_008_994.34, netAssets: 1_008_994.34 } },
      },
    },
    {
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 600_000, estimate: 97.75, settleDate: '2026-09-17',
          gross: 586_500, // 600,000 x 97.75 / 100
          accrued: 208.33, // settles 17 Sep, 2 days: 600,000 x 6.25% x 2/360 = 208.333
          cash: 586_708.33, fees: 29.33 }] }, // 0.5 bp of 586,500 = 29.325
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 600_000, avgPrice: 97.75 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 600,000 COLOM-6\.25-MAR34 @ 97\.75 USD \(realized [-−]1,500\.00 USD\)$/ }, // 586,500 - 588,000
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of COLOM-6.25-MAR34: 208.33 USD' },
        ],
        cash: { account: { USD: { settled: 421_744.34, unsettled: 586_679, availableToTrade: 1_008_423.34 } } }, // 586,500 + 208.33 - 29.33
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', dueDate: '2026-09-17', amount: 586_679, into: 'cash' }],
        lifecycle: [],
        // Interest in all: 18,750 coupon + 12,013.89 + 208.33 sold - 28,819.44 bought = 2,152.78.
        pnl: { account: { realized: -2_500, couponInterest: 2_152.78, commissions: -97.88, unrealized: 0, total: -445.10 } }, // 49 + 19.55 + 29.33
        nav: { account: 1_008_423.34, book: 2_999_554.90 },
        balance: { account: { cash: 421_744.34, receivable: 586_679, positions: null, accruedIncome: null, assets: 1_008_423.34, liabilities: 0, netAssets: 1_008_423.34 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2026-09-17'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 586,679.00 USD into settled cash', cash: { USD: 586_679 } }],
        cash: { account: { USD: { settled: 1_008_423.34, unsettled: 0, availableToTrade: 1_008_423.34 } } },
        pending: [],
        balance: { account: { cash: 1_008_423.34, receivable: null, assets: 1_008_423.34, liabilities: 0, netAssets: 1_008_423.34 } },
      },
    },
    {
      // The funding goes back to Treasury, in the Transfer cash dialog. The Account keeps its 500,000 less the 445.10 it lost.
      id: 'return-funding', covers: 'Treasury funding', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 508_868.44,
      expect: {
        events: [{ type: 'transfer.return', summary: 'Return to Treasury: 508,868.44 USD from Alpha to Treasury', owner: 'account' }],
        cash: { account: { USD: { settled: 499_554.90, availableToTrade: 499_554.90 } }, treasury: { USD: { settled: 2_500_000, availableToTrade: 2_500_000 } } },
        pnl: { account: { total: -445.10 }, book: { total: -445.10 } }, // a transfer is not P&L
        nav: { account: 499_554.90, treasury: 2_500_000, book: 2_999_554.90 },
        balance: { account: { cash: 499_554.90, assets: 499_554.90, liabilities: 0, netAssets: 499_554.90 } },
      },
    },
  ],
};

export default [treasuryNote, treasuryBill, treasuryBond, strips, foreignGovBill, foreignGovBond, emLocalDebt, emHardDebt];
