// Bond family (engine family "bond"), structured group B: 13 catalog products marked "partial" in the catalog
// (specified pools, asset-backed securities, CMO, CLO and CDO tranches, credit-linked and structured notes, catastrophe
// bonds, and loans held at a price: syndicated, leveraged, private credit, distressed debt and loan participations).
// One scenario each, on a fictional instrument registered as exactly that product with the terms a real instrument of
// that product has. The events the catalog lists as manual are recorded by hand through the interface, to completion.
//
// Every expected number is a literal worked out by hand from the inputs stated in the same spec. The arithmetic is in
// the comment beside it (the working is kept, independently of the Terminal's code, in the b4 calculators). Nothing
// here is copied from what the Terminal prints.
//
// The general rules for debt securities are those of bond-government.mjs, bond-corporate.mjs and bond-structured-a.mjs,
// restated:
//   - Quantity is face amount (original face for factor-based paper). A price is the clean price in percent of par of the
//     principal outstanding. A market buy fills at the ask, a market sell at the bid, of the quote in force.
//   - Principal outstanding per unit of face = pool factor (1 for a plain bond). A trade settles face x factor x price /
//     100 plus the accrued interest on the same principal to its SETTLEMENT date, each rounded to the cent. Commission
//     comes from the Book's fee schedule on the clean principal and is expensed.
//   - Accrued interest: 30/360 face x factor x coupon x days30 / 360; ACT/360 x actual days / 360.
//   - The position is carried at clean cost with average cost (shown per 100 of the principal outstanding), valued clean
//     at the last price. Accrued interest is a separate asset ("Accrued income"); its growth is coupon and interest income.
//   - At the end of each business day D the accrued balance is trued up to: interest to D on the face settled by D, plus
//     the interest bought (less sold) in trades settling after D, to their settlement dates, plus any coupon whose
//     coupon date has passed and which is not paid yet. The end-of-day run happens once per clock move, for the latest
//     day that has ended.
//   - A coupon belongs to the face settled before its coupon date and is paid on its coupon date (plus the payment delay
//     of securitised paper), moved to the next business day of the payment calendar.
//   - A paydown recorded by hand (factor old -> new, effective from the first day of the period, paid on the payment
//     date) pays each holder its face entitled on the effective date x (old - new) at par; the cost falls in proportion
//     and the difference is realized; the accrued interest of the period already begun is restated on the new factor.
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
// specified_pool
// ---------------------------------------------------------------------------------------------
// A Fannie Mae 30-year 6.00% specified pool: a pool delivered by its stated characteristics rather than as a generic TBA
// (low loan balance, at most 85,000 original loan size; WAC 6.72%; WALA 4 months; FICO 758; LTV 79%; 100% New York),
// which is why it trades at a pay-up over the TBA. Monthly 30/360 from the 1st, 24-day payment delay (paid on the 25th),
// guaranteed by Fannie Mae, T+2 (its own convention), factor 0.9612345 for November 2026.
//   - Registering a specified pool without its characteristics is refused: they are what it is priced on.
//   - Bought on Monday 9 November for settlement on Thursday 12 November (T+2 over Veterans Day, Wednesday 11 November,
//     a bond-market holiday); increased on Wednesday 18 November (settling Friday 20 November); held over Thanksgiving.
//   - December factor 0.9548211 (0.9597012 after scheduled amortisation alone), effective 1 December, principal paid with
//     November's interest on 25 December, Christmas: on Monday 28 December. A loss allocation is refused (guaranteed).
//   - 1,600,000 sold on 7 December (settling 9 December, after the 1 December record date: November's coupon and the
//     December principal still come on the full 5,000,000); the rest sold on 28 December after the payment.
// Commission: 0.25 basis point of clean principal. Days of 30/360 from 1 Nov: to 12 Nov 11, 17 Nov 16, 19 Nov 18, 20 Nov 19,
// 27 Nov 26; from 1 Dec: to 4 Dec 3, 8 Dec 7, 9 Dec 8, 24 Dec 23, 30 Dec 29. A month's coupon is 6% / 12 of current face.
// Current face: 5,000,000 x 0.9612345 = 4,806,172.50 (November); x 0.9548211 = 4,774,105.50 (December).
const specifiedPoolDraft = {
  productId: 'specified_pool', name: 'Fannie Mae 30-Year 6.00% Specified Pool MA9921 (Low Loan Balance 85k, New York)', symbol: 'FN-6.0-MA9921-LLB', marketView: 'US_CASH', venueType: 'otc', issuer: 'Federal National Mortgage Association', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
  conventions: { settleLag: 2 },
  terms: { couponType: 'fixed', couponRate: 0.06, frequency: 12, maturity: '2056-11-01', issueDate: '2026-07-01', dayCount: '30/360', redemption: 100, factor: 0.9612345, paymentDelayDays: 24, guarantor: 'Fannie Mae',
    poolCharacteristics: 'Low loan balance: maximum original loan 85,000; WAC 6.72%; WALA 4 months; FICO 758; LTV 79%; 100% New York; purchase loans' },
};
const specifiedPool = {
  productId: 'specified_pool',
  title: 'Fannie Mae 6.00% low-loan-balance specified pool: registration needs its stated characteristics, bought at a pay-up T+2 over Veterans Day, increased, Thanksgiving, loss allocation refused (guaranteed), December factor and paydown by hand with prepayment split, partial sale after the record date, coupon and principal after the 24-day delay over Christmas, close',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (original face)'],
    manualInputs: ['Registration: Pool characteristics (required), Pool factor, Payment delay 24, Guarantor, Settlement convention 2', 'Paydown recorded by hand on the instrument form (New pool factor, Factor effective from, Principal paid on, Factor after scheduled principal)'],
    settlement: 'T+2 on the US bond calendar (the pool\'s own convention), Veterans Day skipped; current face = original face x factor; accrued 30/360 from the 1st on current face',
    lifecycle: 'Automatic: daily accrual, monthly coupon on the factor of the month paid 24 days after the period ends (next business day), paydown principal receivable settled on its payment date. Manual: the monthly factor and paydown (no factor feed). Refused: loss allocation (guaranteed pool)',
    accounting: 'Cost per 100 of current face (pay-up over par); principal returned at par against a pay-up cost is a realized loss; coupon and interest income; commission expensed',
    collateral: 'None for a long position',
  },
  start: EST('2026-11-09'), // Monday
  settlementCheck: { lag: 2, holidays: ['2026-11-11', '2026-11-26', '2026-12-25'] }, // Veterans Day (bond market), Thanksgiving, Christmas
  book: {
    name: 'Matrix specified pool', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 7_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 6_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.25 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: { main: specifiedPoolDraft },
  quotes: { main: { bid: 101.5, ask: 101.75, last: 101.625, bidSize: 50_000_000, askSize: 50_000_000 } },
  expectAtStart: { ...startState(6_000_000, 1_000_000), cash: { account: usdCash(6_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      // A second pool registered without its characteristics: refused, they are what a specified pool is.
      id: 'register-without-characteristics', covers: 'registration', action: 'register_instrument',
      draft: { ...specifiedPoolDraft, name: 'Fannie Mae 30-Year 6.00% Specified Pool MA9930', symbol: 'FN-6.0-MA9930', terms: { ...specifiedPoolDraft.terms, poolCharacteristics: undefined } },
      status: 'blocked', reason: 'A specified pool cannot be registered without the characteristics it is specified on.',
      expect: { refused: 'needs its stated characteristics' },
    },
    {
      id: 'open', covers: ['open', 'market holiday'], action: 'ticket', instrument: 'main', side: 'buy', qty: 4_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4_000_000, estimate: 101.75, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-11-12', calendar: 'USBOND',
            notional: 3_844_938, // current face: 4,000,000 x 0.9612345
            gross: 3_912_224.42, // 3,844,938 x 101.75 / 100 = 3,912,224.415
            accrued: 7_049.05, // 11 days: 3,844,938 x 6% x 11/360 = 7,049.053
            cash: -3_919_273.47, fees: 97.81 }], // 0.25 bp of 3,912,224.42 = 97.806
          cash: { USD: { purchases: 3_919_273.47, fees: 97.81, required: 3_919_371.28, available: 6_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 4_000_000, avgPrice: 101.75, fills: [{ qty: 4_000_000, price: 101.75, model: 'quoted-bid-ask', settleDate: '2026-11-12', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 4,000,000 FN-6.0-MA9921-LLB @ 101.75 USD', owner: 'account', date: '2026-11-09' }],
        cash: { account: { USD: { settled: 6_000_000, unsettled: -3_919_371.28, availableToTrade: 2_080_628.72 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 4_000_000, avgCost: 101.75, cost: 3_912_224.42, price: 101.625,
          value: 3_907_418.24, unrealized: -4_806.18, accrued: 7_049.05, priceSource: 'Test fixture' }], // 3,844,938 x 101.625 / 100 = 3,907,418.243
        holdings: { main: { long: 4_000_000, short: 0, net: 4_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-11-12', amount: -3_919_371.28, ccy: 'USD', into: 'cash' }],
        // Bought after the October record date: the first coupon is 1 December's (November's interest), paid 24 days later, the
        // 25th, Christmas: on Monday 28 December. Maturity 1 Nov 2056 + 24 days = Saturday 25 Nov 2056: paid Monday 27 November.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2026-12-28', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2056-11-27', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -97.81, fees: 0, borrowFunding: 0, unrealized: -4_806.18, total: -4_903.99 } },
        nav: { account: 5_995_096.01, book: 6_995_096.01 },
        balance: { account: { cash: 6_000_000, accruedIncome: 7_049.05, positions: 3_907_418.24, payable: 3_919_371.28, assets: 9_914_467.29, liabilities: 3_919_371.28, netAssets: 5_995_096.01 } },
      },
    },
    {
      // Thursday 12 November, the day after Veterans Day. End of day Wednesday 11 November (stock market open): nothing settled
      // yet; the interest bought runs to 12 November, 7,049.05, as on the books: no accrual line.
      id: 'settle-open', covers: ['settlement', 'market holiday'], action: 'clock', to: EST('2026-11-12'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 3,919,371.28 USD from settled cash', cash: { USD: -3_919_371.28 }, date: '2026-11-12' }],
        cash: { account: { USD: { settled: 2_080_628.72, unsettled: 0, availableToTrade: 2_080_628.72 } } },
        pending: [],
        balance: { account: { cash: 2_080_628.72, payable: null, assets: 5_995_096.01, liabilities: 0 } },
      },
    },
    {
      // Wednesday 18 November. End of day 17 Nov: 3,844,938 x 6% x 16/360 = 10,253.168; 3,204.12 more.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EST('2026-11-18'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on FN-6.0-MA9921-LLB: 3,204.12 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_000_000, accrued: 10_253.17 }],
        pnl: { account: { couponInterest: 3_204.12, total: -1_699.87 } },
        nav: { account: 5_998_300.13, book: 6_998_300.13 },
        balance: { account: { accruedIncome: 10_253.17, assets: 5_998_300.13, netAssets: 5_998_300.13 } },
      },
    },
    {
      // 1,000,000 more: current face 961,234.50 x 101.75 / 100 = 978,056.104; 19 days to Friday 20 November 3,043.909;
      // 0.25 bp = 24.451.
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.25, // 4,000,000 -> 5,000,000
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, estimate: 101.75, settleDate: '2026-11-20', notional: 961_234.5,
          gross: 978_056.1, accrued: 3_043.91, cash: -981_100.01, fees: 24.45 }],
          cash: { USD: { purchases: 981_100.01, fees: 24.45, required: 981_124.46, available: 2_080_628.72, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 101.75 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 1,000,000 FN-6.0-MA9921-LLB @ 101.75 USD' }],
        cash: { account: { USD: { settled: 2_080_628.72, unsettled: -981_124.46, availableToTrade: 1_099_504.26 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, cost: 4_890_280.52, avgCost: 101.75, price: 101.625, value: 4_884_272.8, unrealized: -6_007.72, accrued: 13_297.08 }], // 4,806,172.50 x 101.625 / 100 = 4,884,272.803
        holdings: { main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-11-20', amount: -981_124.46, into: 'cash' }],
        pnl: { account: { commissions: -122.26, unrealized: -6_007.72, total: -2_925.86 } },
        nav: { account: 5_997_074.14, book: 6_997_074.14 },
        balance: { account: { cash: 2_080_628.72, accruedIncome: 13_297.08, positions: 4_884_272.8, payable: 981_124.46, assets: 6_978_198.6, liabilities: 981_124.46, netAssets: 5_997_074.14 } },
      },
    },
    {
      // Friday 20 November. End of day 19 Nov: 3,844,938 settled x 6% x 18/360 = 11,534.814, plus the 961,234.50 bought to 20 Nov
      // (19 days) 3,043.909: 14,578.72. 1,281.64 more.
      id: 'settle-increase', covers: ['settlement', 'accrual'], action: 'clock', to: EST('2026-11-20'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 981,124.46 USD from settled cash', cash: { USD: -981_124.46 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on FN-6.0-MA9921-LLB: 1,281.64 USD' },
        ],
        cash: { account: { USD: { settled: 1_099_504.26, unsettled: 0, availableToTrade: 1_099_504.26 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, accrued: 14_578.72 }],
        pending: [],
        pnl: { account: { couponInterest: 4_485.76, total: -1_644.22 } },
        nav: { account: 5_998_355.78, book: 6_998_355.78 },
        balance: { account: { cash: 1_099_504.26, payable: null, accruedIncome: 14_578.72, assets: 5_998_355.78, liabilities: 0, netAssets: 5_998_355.78 } },
      },
    },
    {
      // Monday 30 November, after Thanksgiving (Thursday 26th; Friday 27th open). End of day Friday 27 Nov:
      // 4,806,172.50 x 6% x 26/360 = 20,826.748; 6,248.03 more.
      id: 'after-thanksgiving', covers: ['accrual', 'market holiday'], action: 'clock', to: EST('2026-11-30'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on FN-6.0-MA9921-LLB: 6,248.03 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, accrued: 20_826.75 }],
        pnl: { account: { couponInterest: 10_733.79, total: 4_603.81 } },
        nav: { account: 6_004_603.81, book: 7_004_603.81 },
        balance: { account: { accruedIncome: 20_826.75, assets: 6_004_603.81, netAssets: 6_004_603.81 } },
      },
    },
    {
      // Monday 7 December (the factor is published on the 4th business day). End of day Friday 4 Dec: November's coupon (paid on
      // 28 December) 4,806,172.50 x 6% / 12 = 24,030.8625, plus 3 days of December on the November factor 2,403.0863:
      // 26,433.95. 5,607.20 more.
      id: 'factor-day', covers: 'accrual', action: 'clock', to: EST('2026-12-07'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on FN-6.0-MA9921-LLB: 5,607.20 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, accrued: 26_433.95 }],
        pnl: { account: { couponInterest: 16_340.99, total: 10_211.01 } },
        nav: { account: 6_010_211.01, book: 7_010_211.01 },
        balance: { account: { accruedIncome: 26_433.95, assets: 6_010_211.01, netAssets: 6_010_211.01 } },
      },
    },
    {
      // Fannie Mae guarantees principal and interest: a defaulted loan reaches the pool as a prepayment at par, never as a loss.
      id: 'loss-refused', covers: 'loss allocation (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'writedown', newFactor: 0.95, kind: 'loss', effective: '2026-12-01' },
      status: 'blocked', reason: 'Losses cannot be allocated to a pool guaranteed by Fannie Mae.',
      expect: { refused: 'is guaranteed by Fannie Mae' },
    },
    {
      // The December factor, recorded by hand: 0.9612345 to 0.9548211 from 1 December, principal paid on 28 December.
      // Principal 5,000,000 x 0.0064134 = 32,067.00. Scheduled 0.0015333 of original face (0.9612345 - 0.9597012), prepaid
      // 0.0048801 (SMM 0.0048801 / 0.9597012 = 0.5085%). Cost out 4,890,280.52 x 0.0064134 / 0.9612345 = 32,628.17: realized
      // 32,067.00 - 32,628.17 = -561.17 (principal returned at par on a pool bought at a pay-up). December's 3 days restated on
      // 4,774,105.50: 2,387.0528 instead of 2,403.0863; with November's coupon 24,030.8625: 26,417.9153 -> 26,417.92, 16.03 down.
      id: 'factor-and-paydown', covers: ['paydown (by hand)', 'prepayment (by hand)'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'paydown', newFactor: 0.9548211, effective: '2026-12-01', payDate: '2026-12-28', scheduledFactor: 0.9597012 },
      expect: {
        events: [
          { type: 'bond.paydown', summary: 'Principal paydown on FN-6.0-MA9921-LLB: factor 0.9612345 to 0.9548211 from 2026-12-01; scheduled principal 0.0015333, prepaid 0.0048801 of original face (SMM 0.5085%), 32,067.00 USD receivable on 2026-12-28', owner: 'account', date: '2026-12-07' },
          { type: 'accrual.coupon', summary: 'Accrued interest restated on the new factor of FN-6.0-MA9921-LLB, down: 16.03 USD' },
        ],
        cash: { account: { USD: { settled: 1_099_504.26, unsettled: 32_067, availableToTrade: 1_131_571.26 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, cost: 4_857_652.35, avgCost: 101.75, price: 101.625, value: 4_851_684.71, unrealized: -5_967.64, accrued: 26_417.92 }], // 4,774,105.50 x 101.625 / 100 = 4,851,684.714
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-12-28', amount: 32_067, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -561.17, couponInterest: 16_324.96, unrealized: -5_967.64, total: 9_673.89 } },
        nav: { account: 6_009_673.89, book: 7_009_673.89 },
        balance: { account: { receivable: 32_067, accruedIncome: 26_417.92, positions: 4_851_684.71, assets: 6_009_673.89, netAssets: 6_009_673.89 } },
      },
    },
    {
      // 1,600,000 sold at the bid: current face 1,527,713.76 x 101.50 / 100 = 1,550,629.466; 8 days to Wednesday 9 December
      // 2,036.952; 0.25 bp = 38.766. Cost out 4,857,652.35 x 1.6 / 5 = 1,554,448.752: realized 1,550,629.47 - 1,554,448.75 = -3,819.28.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 1_600_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_600_000, estimate: 101.5, settleDate: '2026-12-09', notional: 1_527_713.76,
          gross: 1_550_629.47, accrued: 2_036.95, cash: 1_552_666.42, fees: 38.77 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1_600_000, avgPrice: 101.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 1,600,000 FN-6\.0-MA9921-LLB @ 101\.50 USD \(realized [-−]3,819\.28 USD\)$/ }],
        cash: { account: { USD: { settled: 1_099_504.26, unsettled: 1_584_694.65, availableToTrade: 2_684_198.91 } } }, // 32,067 + 1,552,627.65
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_400_000, cost: 3_303_203.6, avgCost: 101.75, price: 101.625, value: 3_299_145.61, unrealized: -4_057.99, accrued: 24_380.97 }], // 3,246,391.74 x 101.625 / 100 = 3,299,145.606
        holdings: { main: { long: 3_400_000, short: 0, net: 3_400_000 } },
        // The next coupon (1 January, December's interest, paid Monday 25 January) is scheduled with the position change.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2026-12-28', status: 'pending' }, { type: 'bond.coupon', instrument: 'main', dueDate: '2027-01-25', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2056-11-27', status: 'pending' }],
        pending: [
          { instrument: 'main', owner: 'account', dueDate: '2026-12-09', amount: 1_552_627.65, ccy: 'USD', into: 'cash' },
          { instrument: 'main', owner: 'account', dueDate: '2026-12-28', amount: 32_067, ccy: 'USD', into: 'cash' },
        ],
        pnl: { account: { realized: -4_380.45, commissions: -161.03, unrealized: -4_057.99, total: 7_725.49 } },
        nav: { account: 6_007_725.49, book: 7_007_725.49 },
        balance: { account: { receivable: 1_584_694.65, accruedIncome: 24_380.97, positions: 3_299_145.61, assets: 6_007_725.49, netAssets: 6_007_725.49 } },
      },
    },
    {
      // Wednesday 9 December. End of day 8 Dec: November's coupon on the 5,000,000 held at the record date 24,030.8625, plus 7 days
      // of December on 4,774,105.50 (the sale settles today) 5,569.7898, less the 8 days sold 2,036.9517: 27,563.70. 3,182.73 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EST('2026-12-09'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 1,552,627.65 USD into settled cash', cash: { USD: 1_552_627.65 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on FN-6.0-MA9921-LLB: 3,182.73 USD' },
        ],
        cash: { account: { USD: { settled: 2_652_131.91, unsettled: 32_067, availableToTrade: 2_684_198.91 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_400_000, accrued: 27_563.7 }],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-12-28', amount: 32_067, ccy: 'USD', into: 'cash' }],
        pnl: { account: { couponInterest: 19_507.69, total: 10_908.22 } },
        nav: { account: 6_010_908.22, book: 7_010_908.22 },
        balance: { account: { cash: 2_652_131.91, receivable: 32_067, accruedIncome: 27_563.7, assets: 6_010_908.22, netAssets: 6_010_908.22 } },
      },
    },
    {
      // Monday 28 December, after Christmas: the December principal 32,067.00 arrives, and November's coupon on the 5,000,000 held
      // at the record date, on the November factor: 24,030.8625 paid as 24,030.86. The balance left, 27,563.70 - 24,030.86 =
      // 3,532.84, is December's interest to 8 Dec worked whole (5,569.7898 - 2,036.9517 = 3,532.8381): no line. End of day
      // Thursday 24 Dec: 3,246,391.74 x 6% x 23/360 = 12,444.502; 8,911.66 more.
      id: 'coupon-and-principal', covers: ['coupon', 'paydown (by hand)', 'settlement', 'market holiday'], action: 'clock', to: EST('2026-12-28'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 32,067.00 USD into settled cash', cash: { USD: 32_067 }, date: '2026-12-28' },
          { type: 'bond.coupon', summary: 'Coupon received on 5,000,000 FN-6.0-MA9921-LLB (factor 0.9612345: current face 4,806,172.5): 24,030.86 USD', cash: { USD: 24_030.86 }, owner: 'account', date: '2026-12-28' },
          { type: 'accrual.coupon', summary: 'Interest accrued on FN-6.0-MA9921-LLB: 8,911.66 USD' },
        ],
        cash: { account: { USD: { settled: 2_708_229.77, unsettled: 0, availableToTrade: 2_708_229.77 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_400_000, accrued: 12_444.5 }],
        pending: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-01-25', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2056-11-27', status: 'pending' }],
        pnl: { account: { couponInterest: 28_419.35, total: 19_819.88 } },
        nav: { account: 6_019_819.88, book: 7_019_819.88 },
        balance: { account: { cash: 2_708_229.77, receivable: null, accruedIncome: 12_444.5, assets: 6_019_819.88, netAssets: 6_019_819.88 } },
      },
    },
    {
      // The rest sold for settlement on Wednesday 30 December, before the December record date: 3,246,391.74 x 101.50 / 100 =
      // 3,295,087.616; 29 days 15,690.893 (3,246.39 more than on the books); 0.25 bp = 82.377. Realized 3,295,087.62 -
      // 3,303,203.60 = -8,115.98.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 3_400_000, estimate: 101.5, settleDate: '2026-12-30', notional: 3_246_391.74,
          gross: 3_295_087.62, accrued: 15_690.89, cash: 3_310_778.51, fees: 82.38 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 3_400_000, avgPrice: 101.5 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 3,400,000 FN-6\.0-MA9921-LLB @ 101\.50 USD \(realized [-−]8,115\.98 USD\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of FN-6.0-MA9921-LLB: 3,246.39 USD' },
        ],
        cash: { account: { USD: { settled: 2_708_229.77, unsettled: 3_310_696.13, availableToTrade: 6_018_925.9 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-12-30', amount: 3_310_696.13, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -12_496.43, couponInterest: 31_665.74, commissions: -243.41, unrealized: 0, total: 18_925.9 } },
        nav: { account: 6_018_925.9, book: 7_018_925.9 },
        balance: { account: { cash: 2_708_229.77, receivable: 3_310_696.13, positions: null, accruedIncome: null, assets: 6_018_925.9, liabilities: 0, netAssets: 6_018_925.9 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EST('2026-12-30'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 3,310,696.13 USD into settled cash', cash: { USD: 3_310_696.13 } }],
        cash: { account: { USD: { settled: 6_018_925.9, unsettled: 0, availableToTrade: 6_018_925.9 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 6_018_925.9, receivable: null, assets: 6_018_925.9, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// abs
// ---------------------------------------------------------------------------------------------
// An auto-lease asset-backed pass-through: Brightwater Auto Lease Trust 2025-A Class A certificates. The trust passes
// through the lease collections at a gross rate of 5.80% less the servicer's fee of 1.00% a year, deducted before holders
// are paid: holders accrue and are paid 4.80%. Monthly on the 15th, 30/360, no payment delay, no guarantee, T+2 (its own
// convention), factor 0.7342158 for the period from 15 January 2027. Principal is paid down every month as the leases
// amortise and prepay: the servicer's report gives the new factor, recorded by hand on the payment date.
//   - Bought on Wednesday 3 February (settling Friday 5 February), doubled on Friday 5 February (settling Tuesday 9 February).
//   - The 15 February coupon (Presidents' Day, a bond and stock market holiday) is paid on Tuesday 16 February, net of the
//     servicing fee; the February factor 0.7118604 (0.7201345 after scheduled amortisation alone) is recorded that day,
//     effective 15 February, principal paid at once.
//   - 2,500,000 sold on Wednesday 3 March (settling Friday 5 March); on Monday 15 March the coupon (on the 4,500,000 held)
//     and the March factor 0.6893021, paid at once; the rest sold the same day (settling Wednesday 17 March).
// Commission: 0.5 basis point of clean principal. Days of 30/360 from 15 Jan: to 5 Feb 20, 8 Feb 23, 9 Feb 24, 12 Feb 27;
// from 15 Feb: to 2 Mar 17, 4 Mar 19, 5 Mar 20; from 15 Mar: to 17 Mar 2. A month's net coupon is 4.80% / 12 of current
// face, the gross 5.80% / 12, the servicing fee the difference. Current face: 3,500,000 x 0.7342158 = 2,569,755.30;
// 7,000,000 x 0.7342158 = 5,139,510.60; x 0.7118604 = 4,983,022.80; 4,500,000 x 0.7118604 = 3,203,371.80; x 0.6893021 =
// 3,101,859.45.
const absSpec = {
  productId: 'abs',
  title: 'Brightwater Auto Lease Trust 2025-A Class A pass-through (gross 5.80% less a 1.00% servicing fee): bought, increased, coupon net of the servicing fee over Presidents\' Day, two monthly factors and paydowns by hand (prepayment split), partial sale, close',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (original face)'],
    manualInputs: ['Registration: Coupon rate (gross), Servicing fee, Pool factor, Settlement convention 2', 'Paydown recorded by hand each month on the instrument form (New pool factor, Factor effective from, Principal paid on, Factor after scheduled principal)'],
    settlement: 'T+2 on the US bond calendar (the deal\'s own convention); current face = original face x factor; accrued 30/360 at the net rate on current face',
    lifecycle: 'Automatic: daily accrual at the net rate, monthly coupon on the 15th (next business day) net of the servicing fee, the gross interest and the fee named in the history. Manual: the monthly factor and principal paydown from the servicer\'s report (no factor feed)',
    accounting: 'Cost per 100 of current face; principal returned at par against a discount cost is a realized gain; coupon and interest income net of the servicing fee; commission expensed',
    collateral: 'None for a long position',
  },
  start: EST('2027-02-03'), // Wednesday
  settlementCheck: { lag: 2, holidays: ['2027-02-15'] }, // Presidents' Day
  book: {
    name: 'Matrix ABS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 8_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 7_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'abs', name: 'Brightwater Auto Lease Trust 2025-A Class A Pass-Through Certificates', symbol: 'BALT-25A-A', marketView: 'US_CASH', venueType: 'otc', issuer: 'Brightwater Auto Lease Trust 2025-A', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settleLag: 2 },
      terms: { couponType: 'fixed', couponRate: 0.058, servicingFeeRate: 0.01, frequency: 12, maturity: '2030-07-15', issueDate: '2025-07-15', dayCount: '30/360', redemption: 100, factor: 0.7342158, seniority: 'Senior (Class A)' } },
  },
  quotes: { main: { bid: 99.4, ask: 99.55, last: 99.475, bidSize: 50_000_000, askSize: 50_000_000 } },
  expectAtStart: { ...startState(7_000_000, 1_000_000), cash: { account: usdCash(7_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 3_500_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 3_500_000, estimate: 99.55, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-02-05', calendar: 'USBOND',
            notional: 2_569_755.3, // current face: 3,500,000 x 0.7342158
            gross: 2_558_191.4, // 2,569,755.30 x 99.55 / 100 = 2,558,191.401
            accrued: 6_852.68, // 20 days at the NET rate: 2,569,755.30 x 4.80% x 20/360 = 6,852.681
            cash: -2_565_044.08, fees: 127.91 }], // 0.5 bp of 2,558,191.40 = 127.910
          cash: { USD: { purchases: 2_565_044.08, fees: 127.91, required: 2_565_171.99, available: 7_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 3_500_000, avgPrice: 99.55, fills: [{ qty: 3_500_000, price: 99.55, model: 'quoted-bid-ask', settleDate: '2027-02-05', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 3,500,000 BALT-25A-A @ 99.55 USD', owner: 'account', date: '2027-02-03' }],
        cash: { account: { USD: { settled: 7_000_000, unsettled: -2_565_171.99, availableToTrade: 4_434_828.01 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 3_500_000, avgCost: 99.55, cost: 2_558_191.4, price: 99.475,
          value: 2_556_264.08, unrealized: -1_927.32, accrued: 6_852.68, priceSource: 'Test fixture' }], // 2,569,755.30 x 99.475 / 100 = 2,556,264.085
        holdings: { main: { long: 3_500_000, short: 0, net: 3_500_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-02-05', amount: -2_565_171.99, ccy: 'USD', into: 'cash' }],
        // 15 February 2027 is Presidents' Day: the coupon is paid on Tuesday 16 February. 15 July 2030 is a Monday.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-02-16', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-07-15', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -127.91, fees: 0, borrowFunding: 0, unrealized: -1_927.32, total: -2_055.23 } },
        nav: { account: 6_997_944.77, book: 7_997_944.77 },
        balance: { account: { cash: 7_000_000, accruedIncome: 6_852.68, positions: 2_556_264.08, payable: 2_565_171.99, assets: 9_563_116.76, liabilities: 2_565_171.99, netAssets: 6_997_944.77 } },
      },
    },
    {
      // Friday 5 February. End of day 4 Feb: the interest bought runs to 5 Feb, as on the books: no accrual line.
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2027-02-05'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,565,171.99 USD from settled cash', cash: { USD: -2_565_171.99 }, date: '2027-02-05' }],
        cash: { account: { USD: { settled: 4_434_828.01, unsettled: 0, availableToTrade: 4_434_828.01 } } },
        pending: [],
        balance: { account: { cash: 4_434_828.01, payable: null, assets: 6_997_944.77, liabilities: 0 } },
      },
    },
    {
      // Doubled, settling Tuesday 9 February: 3,500,000 more at 99.55, gross as before 2,558,191.40; 24 days at 4.80% on
      // 2,569,755.30 = 8,223.217; 0.5 bp = 127.910.
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 2,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 3_500_000, estimate: 99.55, settleDate: '2027-02-09', notional: 2_569_755.3,
          gross: 2_558_191.4, accrued: 8_223.22, cash: -2_566_414.62, fees: 127.91 }],
          cash: { USD: { purchases: 2_566_414.62, fees: 127.91, required: 2_566_542.53, available: 4_434_828.01, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 3_500_000, avgPrice: 99.55 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 3,500,000 BALT-25A-A @ 99.55 USD' }],
        cash: { account: { USD: { settled: 4_434_828.01, unsettled: -2_566_542.53, availableToTrade: 1_868_285.48 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 7_000_000, cost: 5_116_382.8, avgCost: 99.55, price: 99.475, value: 5_112_528.17, unrealized: -3_854.63, accrued: 15_075.9 }], // 5,139,510.60 x 99.475 / 100 = 5,112,528.169
        holdings: { main: { long: 7_000_000, short: 0, net: 7_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-02-09', amount: -2_566_542.53, ccy: 'USD', into: 'cash' }],
        pnl: { account: { commissions: -255.82, unrealized: -3_854.63, total: -4_110.45 } },
        nav: { account: 6_995_889.55, book: 7_995_889.55 },
        balance: { account: { cash: 4_434_828.01, accruedIncome: 15_075.9, positions: 5_112_528.17, payable: 2_566_542.53, assets: 9_562_432.08, liabilities: 2_566_542.53, netAssets: 6_995_889.55 } },
      },
    },
    {
      // Tuesday 9 February. End of day 8 Feb: 2,569,755.30 settled x 4.80% x 23/360 = 7,880.5829, plus the 2,569,755.30 bought to
      // 9 Feb (24 days) 8,223.2170: 16,103.80. 1,027.90 more.
      id: 'settle-increase', covers: ['settlement', 'accrual'], action: 'clock', to: EST('2027-02-09'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 2,566,542.53 USD from settled cash', cash: { USD: -2_566_542.53 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on BALT-25A-A: 1,027.90 USD' },
        ],
        cash: { account: { USD: { settled: 1_868_285.48, unsettled: 0, availableToTrade: 1_868_285.48 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 7_000_000, accrued: 16_103.8 }],
        pending: [],
        pnl: { account: { couponInterest: 1_027.9, total: -3_082.55 } },
        nav: { account: 6_996_917.45, book: 7_996_917.45 },
        balance: { account: { cash: 1_868_285.48, payable: null, accruedIncome: 16_103.8, assets: 6_996_917.45, liabilities: 0, netAssets: 6_996_917.45 } },
      },
    },
    {
      // Tuesday 16 February, after Presidents' Day. The coupon of 15 Jan to 15 Feb on 5,139,510.60: gross 5.80% / 12 = 24,840.9679,
      // servicing fee 1.00% / 12 = 4,282.9255, net 4.80% / 12 = 20,558.0424: paid 20,558.04 (24,840.97 less 4,282.93). The
      // accrued balance then stands at 15 February, the first day of the new period: 0, so 20,558.04 - 16,103.80 = 4,454.24 is
      // income (the end of day of Friday 12 February is behind the coupon date and is not run again).
      id: 'coupon', covers: ['coupon', 'servicing fee', 'market holiday'], action: 'clock', to: EST('2027-02-16'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 7,000,000 BALT-25A-A (factor 0.7342158: current face 5,139,510.6); gross interest 24,840.97 USD less servicing fee 4,282.93 USD (1.000% a year): 20,558.04 USD', cash: { USD: 20_558.04 }, owner: 'account', date: '2027-02-16' },
          { type: 'accrual.coupon', summary: 'Interest accrued on BALT-25A-A: 4,454.24 USD' },
        ],
        cash: { account: { USD: { settled: 1_888_843.52, availableToTrade: 1_888_843.52 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 7_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-03-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-07-15', status: 'pending' }],
        pnl: { account: { couponInterest: 5_482.14, total: 1_371.69 } },
        nav: { account: 7_001_371.69, book: 8_001_371.69 },
        balance: { account: { cash: 1_888_843.52, accruedIncome: null, assets: 7_001_371.69, netAssets: 7_001_371.69 } },
      },
    },
    {
      // The February factor from the servicer's report, recorded by hand: 0.7342158 to 0.7118604 from 15 February, paid today.
      // Principal 7,000,000 x 0.0223554 = 156,487.80. Scheduled 0.0140813 of original face (0.7342158 - 0.7201345), prepaid
      // 0.0082741 (SMM 0.0082741 / 0.7201345 = 1.1490%). Cost out 5,116,382.80 x 0.0223554 / 0.7342158 = 155,783.596: realized
      // 156,487.80 - 155,783.60 = 704.20. Nothing has accrued yet in the new period: nothing to restate.
      id: 'factor-and-paydown', covers: ['paydown (by hand)', 'prepayment (by hand)'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'paydown', newFactor: 0.7118604, effective: '2027-02-15', payDate: '2027-02-16', scheduledFactor: 0.7201345 },
      expect: {
        events: [{ type: 'bond.paydown', summary: 'Principal paydown on BALT-25A-A: factor 0.7342158 to 0.7118604 from 2027-02-15; scheduled principal 0.0140813, prepaid 0.0082741 of original face (SMM 1.1490%), 156,487.80 USD received', cash: { USD: 156_487.8 }, owner: 'account', date: '2027-02-16' }],
        cash: { account: { USD: { settled: 2_045_331.32, availableToTrade: 2_045_331.32 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 7_000_000, cost: 4_960_599.2, avgCost: 99.55, price: 99.475, value: 4_956_861.93, unrealized: -3_737.27, accrued: 0 }], // 4,983,022.80 x 99.475 / 100 = 4,956,861.930
        pnl: { account: { realized: 704.2, unrealized: -3_737.27, total: 2_193.25 } },
        nav: { account: 7_002_193.25, book: 8_002_193.25 },
        balance: { account: { cash: 2_045_331.32, positions: 4_956_861.93, assets: 7_002_193.25, netAssets: 7_002_193.25 } },
      },
    },
    {
      // Wednesday 3 March. End of day 2 Mar: 4,983,022.80 x 4.80% x 17/360 = 11,294.8517.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EST('2027-03-03'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on BALT-25A-A: 11,294.85 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 7_000_000, accrued: 11_294.85 }],
        pnl: { account: { couponInterest: 16_776.99, total: 13_488.1 } },
        nav: { account: 7_013_488.1, book: 8_013_488.1 },
        balance: { account: { accruedIncome: 11_294.85, assets: 7_013_488.1, netAssets: 7_013_488.1 } },
      },
    },
    {
      // 2,500,000 sold at the bid: current face 1,779,651.00 x 99.40 / 100 = 1,768,973.094; 20 days to Friday 5 March at 4.80%
      // 4,745.736; 0.5 bp = 88.449. Cost out 4,960,599.20 x 2.5 / 7 = 1,771,642.571: realized 1,768,973.09 - 1,771,642.57 = -2,669.48.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 2_500_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 2_500_000, estimate: 99.4, settleDate: '2027-03-05', notional: 1_779_651,
          gross: 1_768_973.09, accrued: 4_745.74, cash: 1_773_718.83, fees: 88.45 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2_500_000, avgPrice: 99.4 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 2,500,000 BALT-25A-A @ 99\.40 USD \(realized [-−]2,669\.48 USD\)$/ }],
        cash: { account: { USD: { settled: 2_045_331.32, unsettled: 1_773_630.38, availableToTrade: 3_818_961.7 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, cost: 3_188_956.63, avgCost: 99.55, price: 99.475, value: 3_186_554.1, unrealized: -2_402.53, accrued: 6_549.11 }], // 3,203,371.80 x 99.475 / 100 = 3,186,554.098
        holdings: { main: { long: 4_500_000, short: 0, net: 4_500_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-03-05', amount: 1_773_630.38, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -1_965.28, commissions: -344.27, unrealized: -2_402.53, total: 12_064.91 } },
        nav: { account: 7_012_064.91, book: 8_012_064.91 },
        balance: { account: { receivable: 1_773_630.38, accruedIncome: 6_549.11, positions: 3_186_554.1, assets: 7_012_064.91, netAssets: 7_012_064.91 } },
      },
    },
    {
      // Friday 5 March. End of day 4 Mar: 4,983,022.80 x 4.80% x 19/360 = 12,623.6578, less the 20 days sold 4,745.7360: 7,877.92.
      // 1,328.81 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EST('2027-03-05'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 1,773,630.38 USD into settled cash', cash: { USD: 1_773_630.38 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on BALT-25A-A: 1,328.81 USD' },
        ],
        cash: { account: { USD: { settled: 3_818_961.7, unsettled: 0, availableToTrade: 3_818_961.7 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, accrued: 7_877.92 }],
        pending: [],
        pnl: { account: { couponInterest: 18_105.8, total: 13_393.72 } },
        nav: { account: 7_013_393.72, book: 8_013_393.72 },
        balance: { account: { cash: 3_818_961.7, receivable: null, accruedIncome: 7_877.92, assets: 7_013_393.72, netAssets: 7_013_393.72 } },
      },
    },
    {
      // Monday 15 March. The coupon of 15 Feb to 15 Mar on the 4,500,000 held, current face 3,203,371.80: gross 15,482.9637,
      // servicing fee 2,669.4765, net 12,813.4872: paid 12,813.49 (15,482.96 less 2,669.47). The balance stands at 15 March: 0;
      // 12,813.49 - 7,877.92 = 4,935.57 is income.
      id: 'coupon-march', covers: ['coupon', 'servicing fee'], action: 'clock', to: EDT('2027-03-15'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 4,500,000 BALT-25A-A (factor 0.7118604: current face 3,203,371.8); gross interest 15,482.96 USD less servicing fee 2,669.47 USD (1.000% a year): 12,813.49 USD', cash: { USD: 12_813.49 }, owner: 'account', date: '2027-03-15' },
          { type: 'accrual.coupon', summary: 'Interest accrued on BALT-25A-A: 4,935.57 USD' },
        ],
        cash: { account: { USD: { settled: 3_831_775.19, availableToTrade: 3_831_775.19 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-04-15', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-07-15', status: 'pending' }],
        pnl: { account: { couponInterest: 23_041.37, total: 18_329.29 } },
        nav: { account: 7_018_329.29, book: 8_018_329.29 },
        balance: { account: { cash: 3_831_775.19, accruedIncome: null, assets: 7_018_329.29, netAssets: 7_018_329.29 } },
      },
    },
    {
      // The March factor: 0.7118604 to 0.6893021 from today, paid today. Principal 4,500,000 x 0.0225583 = 101,512.35. Cost out
      // 3,188,956.63 x 0.0225583 / 0.7118604 = 101,055.541: realized 101,512.35 - 101,055.54 = 456.81.
      id: 'paydown-march', covers: 'paydown (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'paydown', newFactor: 0.6893021 },
      expect: {
        events: [{ type: 'bond.paydown', summary: 'Principal paydown on BALT-25A-A: factor 0.7118604 to 0.6893021, 101,512.35 USD received', cash: { USD: 101_512.35 }, owner: 'account', date: '2027-03-15' }],
        cash: { account: { USD: { settled: 3_933_287.54, availableToTrade: 3_933_287.54 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 4_500_000, cost: 3_087_901.09, avgCost: 99.55, price: 99.475, value: 3_085_574.69, unrealized: -2_326.4, accrued: 0 }], // 3,101,859.45 x 99.475 / 100 = 3,085,574.688
        pnl: { account: { realized: -1_508.47, unrealized: -2_326.4, total: 18_862.23 } },
        nav: { account: 7_018_862.23, book: 8_018_862.23 },
        balance: { account: { cash: 3_933_287.54, positions: 3_085_574.69, assets: 7_018_862.23, netAssets: 7_018_862.23 } },
      },
    },
    {
      // The rest sold at the bid for settlement on Wednesday 17 March: 3,101,859.45 x 99.40 / 100 = 3,083,248.293; 2 days at 4.80%
      // 827.163; 0.5 bp = 154.162. Realized 3,083,248.29 - 3,087,901.09 = -4,652.80. The 827.16 sold is income to disposal.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 4_500_000, estimate: 99.4, settleDate: '2027-03-17', notional: 3_101_859.45,
          gross: 3_083_248.29, accrued: 827.16, cash: 3_084_075.45, fees: 154.16 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 4_500_000, avgPrice: 99.4 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 4,500,000 BALT-25A-A @ 99\.40 USD \(realized [-−]4,652\.80 USD\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of BALT-25A-A: 827.16 USD' },
        ],
        cash: { account: { USD: { settled: 3_933_287.54, unsettled: 3_083_921.29, availableToTrade: 7_017_208.83 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-03-17', amount: 3_083_921.29, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -6_161.27, couponInterest: 23_868.53, commissions: -498.43, unrealized: 0, total: 17_208.83 } },
        nav: { account: 7_017_208.83, book: 8_017_208.83 },
        balance: { account: { cash: 3_933_287.54, receivable: 3_083_921.29, positions: null, accruedIncome: null, assets: 7_017_208.83, liabilities: 0, netAssets: 7_017_208.83 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2027-03-17'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 3,083,921.29 USD into settled cash', cash: { USD: 3_083_921.29 } }],
        cash: { account: { USD: { settled: 7_017_208.83, unsettled: 0, availableToTrade: 7_017_208.83 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 7_017_208.83, receivable: null, assets: 7_017_208.83, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// cmo
// ---------------------------------------------------------------------------------------------
// A sequential-pay CMO class: Fannie Mae REMIC Trust 2026-41 Class A2, 5.00%, monthly 30/360 from the 1st, 24-day delay,
// guaranteed by Fannie Mae, T+3 (its own convention). Principal collected on the collateral goes first to Class A1 (stated
// balance 150,000,000; 4,250,000 left at the start): Class A2 receives interest only, its factor stays 1, until A1 is retired.
//   - Bought on Tuesday 4 May 2027 (settling Friday 7 May), increased on 12 May (settling Monday 17 May).
//   - 25 May: the May remittance pays A1 down to 1,180,000, recorded by hand; a paydown of A2 is refused (A1 outstanding).
//   - 4 June (after Memorial Day): the June factors are out: A1 is retired (recorded by hand: 0), and A2's own factor is
//     recorded, 1 to 0.9856420 from 1 June, principal paid on 25 June.
//   - The price rises; 4,000,000 sold on Tuesday 15 June, settling Monday 21 June (T+3 over Juneteenth, observed Friday 18 June);
//     on Friday 25 June the June principal and May's coupon (on the 10,000,000 held at the record date); the rest sold that day.
// Commission: 0.5 basis point of clean principal. Days of 30/360 from 1 May: to 7 May 6, 11 May 10, 14 May 13, 17 May 16,
// 24 May 23; from 1 Jun: to 3 Jun 2, 14 Jun 13, 17 Jun 16, 21 Jun 20, 24 Jun 23, 30 Jun 29. A month's coupon is 5% / 12 of
// current face. Current face after the June factor: 10,000,000 x 0.985642 = 9,856,420; 4,000,000 x = 3,942,568; 6,000,000 x =
// 5,913,852.
const cmoSpec = {
  productId: 'cmo',
  title: 'Fannie Mae REMIC 2026-41 Class A2 (sequential behind A1): interest only while the senior class is outstanding, its balance recorded by hand, A2 paydown refused until A1 is retired, then A2\'s own factor by hand; Memorial Day, Juneteenth, partial sale, coupon and principal after the 24-day delay, close',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (original face)'],
    manualInputs: ['Registration: Senior tranche, its stated balance and the balance outstanding; Payment delay 24, Guarantor, Settlement convention 3', 'Senior tranche balance recorded by hand from each remittance report (instrument form: Senior tranche now outstanding, Review senior tranche balance)', 'The tranche\'s own factor recorded by hand as a paydown once the senior tranche is retired'],
    settlement: 'T+3 on the US bond calendar (the deal\'s own convention), Juneteenth skipped; current face = original face x the tranche\'s own factor',
    lifecycle: 'Automatic: daily accrual, monthly coupon paid 24 days after the period ends, paydown principal receivable settled on its payment date. Manual: the senior tranche\'s balance and retirement, the tranche\'s own factor. Refused: a paydown of the tranche while the senior tranche is outstanding (principal priority)',
    accounting: 'Cost per 100 of current face; principal returned at par against a premium cost is a realized loss; coupon and interest income; commission expensed',
    collateral: 'None for a long position',
  },
  start: EDT('2027-05-04'), // Tuesday
  settlementCheck: { lag: 3, holidays: ['2027-05-31', '2027-06-18'] }, // Memorial Day, Juneteenth (observed)
  book: {
    name: 'Matrix CMO', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 13_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 12_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'cmo', name: 'Fannie Mae REMIC Trust 2026-41 Class A2 5.00% (sequential)', symbol: 'FNR-26-41-A2', marketView: 'US_CASH', venueType: 'otc', issuer: 'Fannie Mae REMIC Trust 2026-41', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settleLag: 3 },
      terms: { couponType: 'fixed', couponRate: 0.05, frequency: 12, maturity: '2057-05-01', issueDate: '2026-11-01', dayCount: '30/360', redemption: 100, factor: 1, paymentDelayDays: 24, guarantor: 'Fannie Mae', seniority: 'Sequential Class A2',
        seniorTranche: 'Class A1', seniorBalance: 150_000_000, seniorRemaining: 4_250_000 } },
  },
  quotes: { main: { bid: 100, ask: 100.25, last: 100.125, bidSize: 50_000_000, askSize: 50_000_000 } },
  expectAtStart: { ...startState(12_000_000, 1_000_000), cash: { account: usdCash(12_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 8_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 8_000_000, estimate: 100.25, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-05-07', calendar: 'USBOND',
            gross: 8_020_000, // 8,000,000 x 100.25 / 100 (factor 1)
            accrued: 6_666.67, // 6 days: 8,000,000 x 5% x 6/360 = 6,666.667
            cash: -8_026_666.67, fees: 401 }], // 0.5 bp of 8,020,000
          cash: { USD: { purchases: 8_026_666.67, fees: 401, required: 8_027_067.67, available: 12_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 8_000_000, avgPrice: 100.25, fills: [{ qty: 8_000_000, price: 100.25, model: 'quoted-bid-ask', settleDate: '2027-05-07', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 8,000,000 FNR-26-41-A2 @ 100.25 USD', owner: 'account', date: '2027-05-04' }],
        cash: { account: { USD: { settled: 12_000_000, unsettled: -8_027_067.67, availableToTrade: 3_972_932.33 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 8_000_000, avgCost: 100.25, cost: 8_020_000, price: 100.125,
          value: 8_010_000, unrealized: -10_000, accrued: 6_666.67, priceSource: 'Test fixture' }],
        holdings: { main: { long: 8_000_000, short: 0, net: 8_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-05-07', amount: -8_027_067.67, ccy: 'USD', into: 'cash' }],
        // Bought after the April record date: the first coupon is 1 June's (May's interest), paid Friday 25 June. Maturity
        // 1 May 2057 + 24 days = Friday 25 May 2057.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-06-25', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2057-05-25', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -401, fees: 0, borrowFunding: 0, unrealized: -10_000, total: -10_401 } },
        nav: { account: 11_989_599, book: 12_989_599 },
        balance: { account: { cash: 12_000_000, accruedIncome: 6_666.67, positions: 8_010_000, payable: 8_027_067.67, assets: 20_016_666.67, liabilities: 8_027_067.67, netAssets: 11_989_599 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2027-05-07'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 8,027,067.67 USD from settled cash', cash: { USD: -8_027_067.67 }, date: '2027-05-07' }],
        cash: { account: { USD: { settled: 3_972_932.33, unsettled: 0, availableToTrade: 3_972_932.33 } } },
        pending: [],
        balance: { account: { cash: 3_972_932.33, payable: null, assets: 11_989_599, liabilities: 0 } },
      },
    },
    {
      // Wednesday 12 May. End of day 11 May: 8,000,000 x 5% x 10/360 = 11,111.111; 4,444.44 more.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EDT('2027-05-12'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on FNR-26-41-A2: 4,444.44 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 8_000_000, accrued: 11_111.11 }],
        pnl: { account: { couponInterest: 4_444.44, total: -5_956.56 } },
        nav: { account: 11_994_043.44, book: 12_994_043.44 },
        balance: { account: { accruedIncome: 11_111.11, assets: 11_994_043.44, netAssets: 11_994_043.44 } },
      },
    },
    {
      // 2,000,000 more at 100.25 = 2,005,000; 16 days to Monday 17 May 4,444.444; 0.5 bp = 100.25.
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.25,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 2_000_000, estimate: 100.25, settleDate: '2027-05-17', gross: 2_005_000, accrued: 4_444.44, cash: -2_009_444.44, fees: 100.25 }],
          cash: { USD: { purchases: 2_009_444.44, fees: 100.25, required: 2_009_544.69, available: 3_972_932.33, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 2_000_000, avgPrice: 100.25 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 2,000,000 FNR-26-41-A2 @ 100.25 USD' }],
        cash: { account: { USD: { settled: 3_972_932.33, unsettled: -2_009_544.69, availableToTrade: 1_963_387.64 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 10_000_000, cost: 10_025_000, avgCost: 100.25, price: 100.125, value: 10_012_500, unrealized: -12_500, accrued: 15_555.55 }],
        holdings: { main: { long: 10_000_000, short: 0, net: 10_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-05-17', amount: -2_009_544.69, ccy: 'USD', into: 'cash' }],
        pnl: { account: { commissions: -501.25, unrealized: -12_500, total: -8_556.81 } },
        nav: { account: 11_991_443.19, book: 12_991_443.19 },
        balance: { account: { cash: 3_972_932.33, accruedIncome: 15_555.55, positions: 10_012_500, payable: 2_009_544.69, assets: 14_000_987.88, liabilities: 2_009_544.69, netAssets: 11_991_443.19 } },
      },
    },
    {
      // Monday 17 May. End of day Friday 14 May: 8,000,000 x 13 days 14,444.444 + 2,000,000 bought to 17 May (16 days) 4,444.444 =
      // 18,888.89. 3,333.34 more.
      id: 'settle-increase', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2027-05-17'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 2,009,544.69 USD from settled cash', cash: { USD: -2_009_544.69 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on FNR-26-41-A2: 3,333.34 USD' },
        ],
        cash: { account: { USD: { settled: 1_963_387.64, unsettled: 0, availableToTrade: 1_963_387.64 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 10_000_000, accrued: 18_888.89 }],
        pending: [],
        pnl: { account: { couponInterest: 7_777.78, total: -5_223.47 } },
        nav: { account: 11_994_776.53, book: 12_994_776.53 },
        balance: { account: { cash: 1_963_387.64, payable: null, accruedIncome: 18_888.89, assets: 11_994_776.53, liabilities: 0, netAssets: 11_994_776.53 } },
      },
    },
    {
      // Tuesday 25 May. End of day 24 May: 10,000,000 x 5% x 23/360 = 31,944.444; 13,055.55 more. (No coupon today for this
      // position: April's interest belongs to the April record date, before it was bought.)
      id: 'may-distribution', covers: 'accrual', action: 'clock', to: EDT('2027-05-25'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on FNR-26-41-A2: 13,055.55 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 10_000_000, accrued: 31_944.44 }],
        pnl: { account: { couponInterest: 20_833.33, total: 7_832.08 } },
        nav: { account: 12_007_832.08, book: 13_007_832.08 },
        balance: { account: { accruedIncome: 31_944.44, assets: 12_007_832.08, netAssets: 12_007_832.08 } },
      },
    },
    {
      // The May remittance report: Class A1 paid down from 4,250,000 to 1,180,000, recorded by hand. No cash moves for A2.
      id: 'senior-paid-down', covers: 'senior tranche balance (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'senior_balance', remaining: 1_180_000 },
      expect: {
        events: [{ type: 'bond.senior_balance', summary: 'Class A1 (senior to FNR-26-41-A2) balance recorded by hand: 4,250,000 to 1,180,000. FNR-26-41-A2 receives no principal until it is retired', owner: 'account', date: '2027-05-25' }],
      },
    },
    {
      // A paydown of A2 while A1 is outstanding: refused, principal goes to A1 first.
      id: 'paydown-before-senior-retired', covers: 'paydown (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'paydown', newFactor: 0.99, effective: '2027-05-01', payDate: '2027-05-25' },
      status: 'blocked', reason: 'A sequential class receives no principal while the class senior to it is outstanding.',
      expect: { refused: 'receives principal only after Class A1 is retired' },
    },
    {
      // Friday 4 June, after Memorial Day (Monday 31 May). End of day Thursday 3 June: May's coupon (paid 25 June) 10,000,000 x
      // 5% / 12 = 41,666.6667 plus 2 days of June 2,777.7778: 44,444.44. 12,500.00 more.
      id: 'factor-day', covers: ['accrual', 'market holiday'], action: 'clock', to: EDT('2027-06-04'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on FNR-26-41-A2: 12,500.00 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 10_000_000, accrued: 44_444.44 }],
        pnl: { account: { couponInterest: 33_333.33, total: 20_332.08 } },
        nav: { account: 12_020_332.08, book: 13_020_332.08 },
        balance: { account: { accruedIncome: 44_444.44, assets: 12_020_332.08, netAssets: 12_020_332.08 } },
      },
    },
    {
      // The June report: Class A1 is retired.
      id: 'senior-retired', covers: 'senior tranche balance (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'senior_balance', remaining: 0 },
      expect: {
        events: [{ type: 'bond.senior_balance', summary: 'Class A1 (senior to FNR-26-41-A2) balance recorded by hand: 1,180,000 to 0: retired. FNR-26-41-A2 now receives principal; its own factor is recorded as a paydown', owner: 'account', date: '2027-06-04' }],
      },
    },
    {
      // A2's own factor: 1 to 0.985642 from 1 June, principal paid 25 June: 10,000,000 x 0.014358 = 143,580.00 receivable. Cost out
      // 10,025,000 x 0.014358 = 143,938.95: realized -358.95 (par against a 100.25 cost). June's 2 days restated on 9,856,420:
      // 2,737.8944; with May's coupon 41,666.6667: 44,404.56, 39.88 down.
      id: 'own-factor', covers: 'paydown (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'paydown', newFactor: 0.985642, effective: '2027-06-01', payDate: '2027-06-25' },
      expect: {
        events: [
          { type: 'bond.paydown', summary: 'Principal paydown on FNR-26-41-A2: factor 1 to 0.985642 from 2027-06-01, 143,580.00 USD receivable on 2027-06-25', owner: 'account', date: '2027-06-04' },
          { type: 'accrual.coupon', summary: 'Accrued interest restated on the new factor of FNR-26-41-A2, down: 39.88 USD' },
        ],
        cash: { account: { USD: { settled: 1_963_387.64, unsettled: 143_580, availableToTrade: 2_106_967.64 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 10_000_000, cost: 9_881_061.05, avgCost: 100.25, price: 100.125, value: 9_868_740.53, unrealized: -12_320.52, accrued: 44_404.56 }], // 9,856,420 x 100.125 / 100 = 9,868,740.525
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-06-25', amount: 143_580, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -358.95, couponInterest: 33_293.45, unrealized: -12_320.52, total: 20_112.73 } },
        nav: { account: 12_020_112.73, book: 13_020_112.73 },
        balance: { account: { receivable: 143_580, accruedIncome: 44_404.56, positions: 9_868_740.53, assets: 12_020_112.73, netAssets: 12_020_112.73 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 100.5, ask: 100.75, last: 100.625, bidSize: 50_000_000, askSize: 50_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 10_000_000, price: 100.625, value: 9_918_022.63, unrealized: 36_961.58 }], // 9,856,420 x 100.625 / 100 = 9,918,022.625
        pnl: { account: { unrealized: 36_961.58, total: 69_394.83 } },
        nav: { account: 12_069_394.83, book: 13_069_394.83 },
        balance: { account: { positions: 9_918_022.63, assets: 12_069_394.83, netAssets: 12_069_394.83 } },
      },
    },
    {
      // Tuesday 15 June. End of day 14 Jun: May's coupon 41,666.6667 + 9,856,420 x 5% x 13/360 = 17,796.3139: 59,462.98. 15,058.42 more.
      id: 'accrue-june', covers: 'accrual', action: 'clock', to: EDT('2027-06-15'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on FNR-26-41-A2: 15,058.42 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 10_000_000, accrued: 59_462.98 }],
        pnl: { account: { couponInterest: 48_351.87, total: 84_453.25 } },
        nav: { account: 12_084_453.25, book: 13_084_453.25 },
        balance: { account: { accruedIncome: 59_462.98, assets: 12_084_453.25, netAssets: 12_084_453.25 } },
      },
    },
    {
      // 4,000,000 sold at 100.50, settling Monday 21 June (T+3: Wednesday, Thursday, Juneteenth observed Friday, Monday): current
      // face 3,942,568 x 100.50 / 100 = 3,962,280.84; 20 days 10,951.578; 0.5 bp = 198.114. Cost out 9,881,061.05 x 0.4 =
      // 3,952,424.42: realized 9,856.42.
      id: 'reduce', covers: ['reduce', 'market holiday'], action: 'ticket', instrument: 'main', side: 'sell', qty: 4_000_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 4_000_000, estimate: 100.5, settleDate: '2027-06-21', notional: 3_942_568,
          gross: 3_962_280.84, accrued: 10_951.58, cash: 3_973_232.42, fees: 198.11 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 4_000_000, avgPrice: 100.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 4,000,000 FNR-26-41-A2 @ 100.50 USD (realized 9,856.42 USD)' }],
        cash: { account: { USD: { settled: 1_963_387.64, unsettled: 4_116_614.31, availableToTrade: 6_080_001.95 } } }, // 143,580 + 3,973,034.31
        positions: [{ instrument: 'main', lot: 'lot', qty: 6_000_000, cost: 5_928_636.63, avgCost: 100.25, price: 100.625, value: 5_950_813.58, unrealized: 22_176.95, accrued: 48_511.4 }], // 5,913,852 x 100.625 / 100 = 5,950,813.575
        holdings: { main: { long: 6_000_000, short: 0, net: 6_000_000 } },
        // The coupon after (1 July, June's interest) is scheduled with the position change: 25 July is a Sunday, paid Monday 26 July.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-06-25', status: 'pending' }, { type: 'bond.coupon', instrument: 'main', dueDate: '2027-07-26', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2057-05-25', status: 'pending' }],
        pending: [
          { instrument: 'main', owner: 'account', dueDate: '2027-06-21', amount: 3_973_034.31, ccy: 'USD', into: 'cash' },
          { instrument: 'main', owner: 'account', dueDate: '2027-06-25', amount: 143_580, ccy: 'USD', into: 'cash' },
        ],
        pnl: { account: { realized: 9_497.47, commissions: -699.36, unrealized: 22_176.95, total: 79_326.93 } },
        nav: { account: 12_079_326.93, book: 13_079_326.93 },
        balance: { account: { receivable: 4_116_614.31, accruedIncome: 48_511.4, positions: 5_950_813.58, assets: 12_079_326.93, netAssets: 12_079_326.93 } },
      },
    },
    {
      // Monday 21 June. End of day Thursday 17 June (Friday 18th closed): May's coupon 41,666.6667 + 9,856,420 x 16 days 21,903.1556
      // less the 20 days sold 10,951.5778: 52,618.24. 4,106.84 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2027-06-21'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 3,973,034.31 USD into settled cash', cash: { USD: 3_973_034.31 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on FNR-26-41-A2: 4,106.84 USD' },
        ],
        cash: { account: { USD: { settled: 5_936_421.95, unsettled: 143_580, availableToTrade: 6_080_001.95 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 6_000_000, accrued: 52_618.24 }],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-06-25', amount: 143_580, ccy: 'USD', into: 'cash' }],
        pnl: { account: { couponInterest: 52_458.71, total: 83_433.77 } },
        nav: { account: 12_083_433.77, book: 13_083_433.77 },
        balance: { account: { cash: 5_936_421.95, receivable: 143_580, accruedIncome: 52_618.24, assets: 12_083_433.77, netAssets: 12_083_433.77 } },
      },
    },
    {
      // Friday 25 June: the June principal 143,580.00, and May's coupon on the 10,000,000 held at the record date (factor 1):
      // 41,666.6667 paid as 41,666.67. The balance left, 52,618.24 - 41,666.67 = 10,951.57, against June's interest to 17 June
      // worked whole, 21,903.1556 - 10,951.5778 = 10,951.5778 -> 10,951.58: 0.01 more. End of day 24 Jun: 5,913,852 x 5% x
      // 23/360 = 18,891.4717; 7,939.89 more.
      id: 'coupon-and-principal', covers: ['coupon', 'paydown (by hand)', 'settlement'], action: 'clock', to: EDT('2027-06-25'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 143,580.00 USD into settled cash', cash: { USD: 143_580 }, date: '2027-06-25' },
          { type: 'bond.coupon', summary: 'Coupon received on 10,000,000 FNR-26-41-A2: 41,666.67 USD', cash: { USD: 41_666.67 }, owner: 'account', date: '2027-06-25' },
          { type: 'accrual.coupon', summary: 'Interest accrued on FNR-26-41-A2: 0.01 USD' },
          { type: 'accrual.coupon', summary: 'Interest accrued on FNR-26-41-A2: 7,939.89 USD' },
        ],
        cash: { account: { USD: { settled: 6_121_668.62, unsettled: 0, availableToTrade: 6_121_668.62 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 6_000_000, accrued: 18_891.47 }],
        pending: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-07-26', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2057-05-25', status: 'pending' }],
        pnl: { account: { couponInterest: 60_398.61, total: 91_373.67 } },
        nav: { account: 12_091_373.67, book: 13_091_373.67 },
        balance: { account: { cash: 6_121_668.62, receivable: null, accruedIncome: 18_891.47, assets: 12_091_373.67, netAssets: 12_091_373.67 } },
      },
    },
    {
      // The rest sold at 100.50 for settlement on Wednesday 30 June, before the June record date: 5,913,852 x 100.50 / 100 =
      // 5,943,421.26; 29 days 23,819.682 (4,928.21 more than on the books); 0.5 bp = 297.171. Realized 5,943,421.26 -
      // 5,928,636.63 = 14,784.63.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 6_000_000, estimate: 100.5, settleDate: '2027-06-30', notional: 5_913_852,
          gross: 5_943_421.26, accrued: 23_819.68, cash: 5_967_240.94, fees: 297.17 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 6_000_000, avgPrice: 100.5 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 6,000,000 FNR-26-41-A2 @ 100.50 USD (realized 14,784.63 USD)' },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of FNR-26-41-A2: 4,928.21 USD' },
        ],
        cash: { account: { USD: { settled: 6_121_668.62, unsettled: 5_966_943.77, availableToTrade: 12_088_612.39 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-06-30', amount: 5_966_943.77, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: 24_282.1, couponInterest: 65_326.82, commissions: -996.53, unrealized: 0, total: 88_612.39 } },
        nav: { account: 12_088_612.39, book: 13_088_612.39 },
        balance: { account: { cash: 6_121_668.62, receivable: 5_966_943.77, positions: null, accruedIncome: null, assets: 12_088_612.39, liabilities: 0, netAssets: 12_088_612.39 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2027-06-30'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 5,966,943.77 USD into settled cash', cash: { USD: 5_966_943.77 } }],
        cash: { account: { USD: { settled: 12_088_612.39, unsettled: 0, availableToTrade: 12_088_612.39 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 12_088_612.39, receivable: null, assets: 12_088_612.39, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// clo
// ---------------------------------------------------------------------------------------------
// A European CLO mezzanine class in euros, reported in dollars: Lindqvist Park CLO 2025-1 DAC Class D Senior Secured
// Deferrable Floating Rate Notes, listed on Euronext Dublin (TARGET calendar), 3-month EURIBOR + 4.25%, quarterly on 15 January,
// April, July and October, ACT/360 on current face, T+2. Class D is deferrable: when its coverage test fails, its interest is
// paid in kind (added to principal) instead of in cash. The coupon of the period running at registration is entered on the
// form (Current coupon 6.55%: the January fixing 2.30% + 4.25%); later fixings come from the rate fixture standing in for
// Shaffer MarketData (code EURIBOR3M). EUR/USD 1.10 (fixture) throughout.
//   - Bought on Monday 6 March 2028 (settling Wednesday 8 March).
//   - 13 April: the trustee report shows the Class D overcollateralisation test failing: the 15 April coupon is recorded by
//     hand as paid in kind; the April fixing (2.45%) is published.
//   - 15 April is a Saturday, 17 April Easter Monday (TARGET closed; NYSE open): on Tuesday 18 April the coupon is added to
//     principal (factor 1 to 1.0165569444) and the next period runs at 6.70% on the larger current face.
//   - 1 May (TARGET holiday) passes; on Monday 17 July (15 July a Saturday) the coupon is paid in cash on current face; the July
//     fixing does not arrive: interest stops accruing, an alert is raised, and a sale is refused. It arrives (2.60%: 6.85%).
//   - A realized loss is allocated to Class D by hand, factor 1.0165569444 to 0.9148 from 15 July; the price falls; 2,000,000 sold,
//     then the rest.
// Commission: 0.5 basis point of clean principal. Days (ACT/360) from 15 Jan 2028: to 8 Mar 53, 12 Apr 88, 15 Apr 91; from
// 15 Apr: to 17 Apr 2, 1 May 16, 15 Jul 91; from 15 Jul: to 18 Jul 3, 20 Jul 5, 21 Jul 6, 25 Jul 10.
// Dollar figures: every booking is translated at 1.10 and rounded to the cent when it is booked; P&L lines are the sums of the
// translated bookings, balance lines and net asset value the euro figures x 1.10, rounded; the FX effect is what the rounding
// of the translated asset and liability bookings leaves (a cent here and there).
const cloSpec = {
  productId: 'clo',
  title: 'Lindqvist Park CLO 2025-1 Class D (EUR, deferrable, 3M EURIBOR + 4.25%) reported in dollars: coupon paid in kind by hand over Easter, next coupon on the larger current face, missing fixing stops accrual and blocks a sale, fixing arrives, realized loss allocated by hand, partial sale, close',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (original face)'],
    automaticInputs: [...BOND_TICKET.automaticInputs, 'EURIBOR3M fixing of each coupon period (rate fixture standing in for Shaffer MarketData)', 'EUR/USD rate (FX fixture)'],
    manualInputs: ['Registration: Coupon Floating, Reference rate EURIBOR3M, Spread, Current coupon, Interest deferrable (PIK)', 'Coupon paid in kind recorded by hand on the instrument form (Coupon paid in kind, Review, Record)', 'Realized loss allocated by hand (Principal written down to, Kind of write-down, Write-down effective from)'],
    settlement: 'T+2 on the TARGET calendar (Euronext Dublin); Good Friday, Easter Monday and 1 May are not business days; a trade is refused while the period has no fixing',
    lifecycle: 'Automatic: daily accrual on current face at the period rate, quarterly coupon at the fixing plus the spread, reset after each coupon, missing fixing raises an alert and stops accrual. Manual: a coupon paid in kind (capitalised: factor up, cost up, no cash), the loss allocation',
    accounting: 'Euro position; cost per 100 of current face (PIK capitalised into cost); coupon and interest income including the PIK coupon; loss and sales realized; dollar figures translated at 1.10 per booking, FX effect from rounding',
    collateral: 'None for a long position',
  },
  start: EST('2028-03-06'), // Monday
  settlementCheck: { lag: 2, holidays: ['2028-04-14', '2028-04-17', '2028-05-01'] }, // Good Friday, Easter Monday, Labour Day (TARGET)
  book: {
    name: 'Matrix euro CLO', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'EUR', amount: 6_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'EUR', amount: 5_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  fx: { 'EUR/USD': 1.1 },
  instruments: {
    main: { productId: 'clo', name: 'Lindqvist Park CLO 2025-1 DAC Class D Senior Secured Deferrable Floating Rate Notes due 2038', symbol: 'LPARK-25-1-D', marketView: 'FOREIGN_CASH', venueType: 'exchange', venue: 'Euronext Dublin', venueCountry: 'IE', issuer: 'Lindqvist Park CLO 2025-1 DAC', domicile: 'IE', underlyingGeo: 'EU', tradingCcy: 'EUR', multiplier: 0.01,
      conventions: { settleLag: 2 },
      terms: { couponType: 'float', referenceRate: 'EURIBOR3M', spread: 0.0425, currentCoupon: 0.0655, frequency: 4, maturity: '2038-04-15', issueDate: '2025-04-15', dayCount: 'ACT/360', redemption: 100, minDenomination: 1_000, seniority: 'Class D (deferrable mezzanine)', pikAllowed: true } },
  },
  quotes: { main: { bid: 98.25, ask: 98.5, last: 98.375, bidSize: 20_000_000, askSize: 20_000_000 } },
  expectAtStart: {
    ...startState(6_050_000, 1_550_000), // 5,500,000 EUR x 1.10; 1,000,000 USD + 500,000 EUR x 1.10
    cash: { account: { EUR: idle(5_500_000) }, treasury: { USD: idle(1_000_000), EUR: idle(500_000) } }, alerts: [],
  },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 5_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 98.5, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2028-03-08', calendar: 'TARGET',
            gross: 4_925_000, // 5,000,000 x 98.50 / 100
            accrued: 48_215.28, // 53 days at 6.55%: 5,000,000 x 6.55% x 53/360 = 48,215.278
            cash: -4_973_215.28, fees: 246.25 }], // 0.5 bp of 4,925,000
          cash: { EUR: { purchases: 4_973_215.28, fees: 246.25, required: 4_973_461.53, available: 5_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5_000_000, avgPrice: 98.5, fills: [{ qty: 5_000_000, price: 98.5, model: 'quoted-bid-ask', settleDate: '2028-03-08', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 5,000,000 LPARK-25-1-D @ 98.50 EUR', owner: 'account', date: '2028-03-06' }],
        cash: { account: { EUR: { settled: 5_500_000, unsettled: -4_973_461.53, availableToTrade: 526_538.47 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5_000_000, avgCost: 98.5, cost: 4_925_000, price: 98.375,
          value: 4_918_750, unrealized: -6_250, accrued: 48_215.28, priceSource: 'Test fixture' }],
        holdings: { main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-03-08', amount: -4_973_461.53, ccy: 'EUR', into: 'cash' }],
        // 15 April 2028 is a Saturday and Monday 17 April Easter Monday (TARGET): the coupon is due Tuesday 18 April.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-04-18', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2038-04-15', status: 'pending' }],
        // Dollars: commission 246.25 x 1.10 = 270.875 -> 270.88; unrealized -6,250 x 1.10 = -6,875. FX effect -0.01: the payable
        // -4,973,461.53 is booked as -5,470,807.68 (x 1.10 = -5,470,807.683), the accrued 48,215.28 as 53,036.81 (53,036.808):
        // residuals -0.003 and -0.002, -0.005, rounded -0.01.
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -270.88, fees: 0, borrowFunding: 0, unrealized: -6_875, fx: -0.01, total: -7_145.89 } },
        nav: { account: 6_042_854.13, book: 7_592_854.13 }, // 5,493,503.75 EUR x 1.10 = 6,042,854.125
        balance: { account: { cash: 6_050_000, accruedIncome: 53_036.81, positions: 5_410_625, payable: 5_470_807.68, assets: 11_513_661.81, liabilities: 5_470_807.68, netAssets: 6_042_854.13,
          local: { EUR: { cash: 5_500_000, accruedIncome: 48_215.28, positions: 4_918_750, payable: 4_973_461.53 } } } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EST('2028-03-08'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 4,973,461.53 EUR from settled cash', cash: { EUR: -4_973_461.53 }, date: '2028-03-08' }],
        cash: { account: { EUR: { settled: 526_538.47, unsettled: 0, availableToTrade: 526_538.47 } } },
        pending: [],
        balance: { account: { cash: 579_192.32, payable: null, assets: 6_042_854.13, liabilities: 0, local: { EUR: { cash: 526_538.47, payable: null } } } },
      },
    },
    {
      // Thursday 13 April. End of day 12 Apr: 5,000,000 x 6.55% x 88/360 = 80,055.556; 31,840.28 more (35,024.31 dollars).
      id: 'accrue', covers: 'accrual', action: 'clock', to: EDT('2028-04-13'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on LPARK-25-1-D: 31,840.28 EUR' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, accrued: 80_055.56 }],
        pnl: { account: { couponInterest: 35_024.31, total: 27_878.42 } },
        nav: { account: 6_077_878.43, book: 7_627_878.43 },
        balance: { account: { accruedIncome: 88_061.12, assets: 6_077_878.43, netAssets: 6_077_878.43, local: { EUR: { accruedIncome: 80_055.56 } } } },
      },
    },
    {
      // The trustee report: the Class D overcollateralisation test fails, so the 15 April coupon is paid in kind. Recorded by hand.
      id: 'pik-elected', covers: 'coupon paid in kind (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'pik', couponDate: '2028-04-15' },
      expect: {
        events: [{ type: 'bond.pik_election', summary: 'Coupon of 2028-04-15 on LPARK-25-1-D to be paid in kind, recorded by hand: interest is still earned; on 2028-04-18 it is added to principal instead of paid', owner: 'account', date: '2028-04-13' }],
      },
    },
    // The April fixing, 2.45%, published on 13 April (two TARGET days before the period starts): it sets the next period's rate.
    { id: 'april-fixing', covers: 'reset', action: 'rate', code: 'EURIBOR3M', value: 2.45, date: '2028-04-13', expect: { events: [] } },
    {
      // Tuesday 18 April. The coupon of 15 Jan to 15 Apr, 91 days at 6.55%: 5,000,000 x 6.55% x 91/360 = 82,784.722, is paid in kind:
      // added to principal, factor 1 x (1 + 1.6556944%) = 1.0165569444 (current face 5,082,784.72), cost 4,925,000 + 82,784.72 =
      // 5,007,784.72. No cash. The balance then stands at 15 April (0): 82,784.72 - 80,055.56 = 2,729.16 more income. The next
      // period runs at 2.45% + 4.25% = 6.70%. End of day Monday 17 April (Easter Monday: TARGET closed, NYSE open): 2 days on
      // 5,082,784.72 at 6.70% = 1,891.925.
      id: 'coupon-paid-in-kind', covers: ['coupon paid in kind (by hand)', 'reset', 'market holiday'], action: 'clock', to: EDT('2028-04-18'),
      expect: {
        events: [
          { type: 'bond.pik', summary: 'Coupon of 2028-04-15 paid in kind on 5,000,000 LPARK-25-1-D: 82,784.72 EUR added to principal, factor 1 to 1.0165569444', owner: 'account', date: '2028-04-18' },
          { type: 'accrual.coupon', summary: 'Interest accrued on LPARK-25-1-D: 2,729.16 EUR' },
          { type: 'accrual.coupon', summary: 'Interest accrued on LPARK-25-1-D: 1,891.93 EUR' },
        ],
        // avgCost per 100 of current face: 5,007,784.72 / 50,827.8472 = 98.524431. Value 5,082,784.72 x 98.375 / 100 = 5,000,189.469.
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, cost: 5_007_784.72, avgCost: 98.524431, price: 98.375, value: 5_000_189.47, unrealized: -7_595.25, accrued: 1_891.93 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-07-17', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2038-04-15', status: 'pending' }],
        pnl: { account: { couponInterest: 40_107.51, unrealized: -8_354.78, total: 31_481.84 } }, // + (2,729.16 + 1,891.93) x 1.10 per booking: 3,002.08 + 2,081.12
        nav: { account: 6_081_481.86, book: 7_631_481.86 },
        balance: { account: { accruedIncome: 2_081.12, positions: 5_500_208.42, assets: 6_081_481.86, netAssets: 6_081_481.86, local: { EUR: { accruedIncome: 1_891.93, positions: 5_000_189.47 } } } },
      },
    },
    {
      // Tuesday 2 May, after Labour Day (TARGET; NYSE open on 1 May). End of day 1 May: 16 days on 5,082,784.72 at 6.70% =
      // 15,135.403; 13,243.47 more (14,567.82 dollars).
      id: 'accrue-may', covers: ['accrual', 'market holiday'], action: 'clock', to: EDT('2028-05-02'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on LPARK-25-1-D: 13,243.47 EUR' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, accrued: 15_135.4 }],
        pnl: { account: { couponInterest: 54_675.33, total: 46_049.66 } },
        nav: { account: 6_096_049.67, book: 7_646_049.67 },
        balance: { account: { accruedIncome: 16_648.94, assets: 6_096_049.67, netAssets: 6_096_049.67, local: { EUR: { accruedIncome: 15_135.4 } } } },
      },
    },
    {
      // Monday 17 July (15 July a Saturday). The coupon of 15 Apr to 15 Jul, 91 days at 6.70%, on the current face:
      // 5,000,000 x 1.0165569444 x 6.70% x 91/360 = 86,082.607: paid in cash, 86,082.61. The balance stands at 15 July: 0, so
      // 86,082.61 - 15,135.40 = 70,947.21 more. No EURIBOR3M fixing for 15 July: an alert, and no rate for the new period.
      id: 'july-coupon-no-fixing', covers: ['coupon', 'missing fixing'], action: 'clock', to: EDT('2028-07-17'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 5,000,000 LPARK-25-1-D (factor 1.0165569444: current face 5,082,784.72): 86,082.61 EUR', cash: { EUR: 86_082.61 }, owner: 'account', date: '2028-07-17' },
          { type: 'accrual.coupon', summary: 'Interest accrued on LPARK-25-1-D: 70,947.21 EUR' },
        ],
        cash: { account: { EUR: { settled: 612_621.08, availableToTrade: 612_621.08 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-10-16', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2038-04-15', status: 'pending' }],
        alerts: ['bond.fixing'],
        pnl: { account: { couponInterest: 132_717.26, total: 124_091.59 } },
        nav: { account: 6_174_091.61, book: 7_724_091.61 },
        balance: { account: { cash: 673_883.19, accruedIncome: null, assets: 6_174_091.61, netAssets: 6_174_091.61, local: { EUR: { cash: 612_621.08, accruedIncome: null } } } },
      },
    },
    {
      id: 'sell-without-fixing', covers: ['reduce', 'missing fixing'], action: 'ticket', instrument: 'main', side: 'sell', qty: 2_000_000, from: 'lot',
      status: 'blocked', reason: 'The accrued interest of the sale cannot be computed without the period\'s fixing; it is not booked as zero.',
      expect: { refused: 'has no EURIBOR3M fixing for its current coupon period' },
    },
    // The July fixing, 2.60%, arrives from the fixture on 17 July (for 13 July).
    { id: 'july-fixing-arrives', covers: 'reset', action: 'rate', code: 'EURIBOR3M', value: 2.6, date: '2028-07-13', expect: { events: [] } },
    {
      // Wednesday 19 July. The end of day of 18 July takes the July fixing: 2.60% + 4.25% = 6.85%; the alert is resolved.
      // 3 days on 5,082,784.72 at 6.85% = 2,901.423.
      id: 'fixing-taken', covers: ['reset', 'accrual'], action: 'clock', to: EDT('2028-07-19'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on LPARK-25-1-D: 2,901.42 EUR' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, accrued: 2_901.42 }],
        alerts: [],
        pnl: { account: { couponInterest: 135_908.82, total: 127_283.15 } },
        nav: { account: 6_177_283.17, book: 7_727_283.17 },
        balance: { account: { accruedIncome: 3_191.56, assets: 6_177_283.17, netAssets: 6_177_283.17, local: { EUR: { accruedIncome: 2_901.42 } } } },
      },
    },
    {
      // A realized loss allocated to Class D by hand: factor 1.0165569444 to 0.9148 from 15 July. 5,000,000 x 0.1017569444 =
      // 508,784.72 of principal written off. Cost out 5,007,784.72 x 0.1017569444 / 1.0165569444 = 501,277.249: realized
      // -501,277.25 (-551,404.98 dollars). July's 3 days on the principal written off are cancelled: on 4,574,000 at 6.85% they are
      // 2,610.99, 290.43 down.
      id: 'loss-allocated', covers: 'loss allocation (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'writedown', newFactor: 0.9148, kind: 'loss', effective: '2028-07-15' },
      expect: {
        events: [
          { type: 'bond.loss', summary: 'Realized loss allocated by hand to LPARK-25-1-D: factor 1.0165569444 to 0.9148 from 2028-07-15, 508,784.72 of principal written off with no payment (5,000,000 original face); cost 501,277.25 EUR written off as realized loss', owner: 'account', date: '2028-07-19' },
          { type: 'accrual.coupon', summary: 'Accrued interest cancelled with the principal written off on LPARK-25-1-D: 290.43 EUR' },
        ],
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, cost: 4_506_507.47, avgCost: 98.524431, price: 98.375, value: 4_499_672.5, unrealized: -6_834.97, accrued: 2_610.99 }], // 4,574,000 x 98.375 / 100
        pnl: { account: { realized: -551_404.98, couponInterest: 135_589.35, unrealized: -7_518.47, total: -423_604.99 } },
        nav: { account: 5_626_395.03, book: 7_176_395.03 },
        balance: { account: { accruedIncome: 2_872.09, positions: 4_949_639.75, assets: 5_626_395.03, netAssets: 5_626_395.03, local: { EUR: { accruedIncome: 2_610.99, positions: 4_499_672.5 } } } },
      },
    },
    {
      id: 'price-falls', action: 'quote', instrument: 'main', quote: { bid: 91, ask: 91.5, last: 91.25, bidSize: 20_000_000, askSize: 20_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, price: 91.25, value: 4_173_775, unrealized: -332_732.47 }], // 4,574,000 x 91.25 / 100
        pnl: { account: { unrealized: -366_005.72, total: -782_092.24 } },
        nav: { account: 5_267_907.78, book: 6_817_907.78 },
        balance: { account: { positions: 4_591_152.5, assets: 5_267_907.78, netAssets: 5_267_907.78, local: { EUR: { positions: 4_173_775 } } } },
      },
    },
    {
      // 2,000,000 sold at 91.00, settling Friday 21 July: current face 1,829,600 x 91 / 100 = 1,664,936; 6 days at 6.85%
      // 2,088.793; 0.5 bp = 83.247. Cost out 4,506,507.47 x 2 / 5 = 1,802,602.988: realized 1,664,936 - 1,802,602.99 = -137,666.99.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 2_000_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 2_000_000, estimate: 91, settleDate: '2028-07-21', calendar: 'TARGET', notional: 1_829_600,
          gross: 1_664_936, accrued: 2_088.79, cash: 1_667_024.79, fees: 83.25 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2_000_000, avgPrice: 91 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 2,000,000 LPARK-25-1-D @ 91\.00 EUR \(realized [-−]137,666\.99 EUR\)$/ }],
        cash: { account: { EUR: { settled: 612_621.08, unsettled: 1_666_941.54, availableToTrade: 2_279_562.62 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_000_000, cost: 2_703_904.48, avgCost: 98.524431, price: 91.25, value: 2_504_265, unrealized: -199_639.48, accrued: 522.2 }], // 2,744,400 x 91.25 / 100
        holdings: { main: { long: 3_000_000, short: 0, net: 3_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-07-21', amount: 1_666_941.54, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: -702_838.67, commissions: -362.46, unrealized: -219_603.43, fx: 0, total: -787_215.21 } },
        nav: { account: 5_262_784.8, book: 6_812_784.8 },
        balance: { account: { receivable: 1_833_635.69, accruedIncome: 574.42, positions: 2_754_691.5, assets: 5_262_784.8, netAssets: 5_262_784.8, local: { EUR: { receivable: 1_666_941.54, accruedIncome: 522.2, positions: 2_504_265 } } } },
      },
    },
    {
      // Friday 21 July. End of day 20 Jul: 4,574,000 x 6.85% x 5/360 = 4,351.597, less the 6 days sold 2,088.793: 2,262.86.
      // 1,740.66 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2028-07-21'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 1,666,941.54 EUR into settled cash', cash: { EUR: 1_666_941.54 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on LPARK-25-1-D: 1,740.66 EUR' },
        ],
        cash: { account: { EUR: { settled: 2_279_562.62, unsettled: 0, availableToTrade: 2_279_562.62 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_000_000, accrued: 2_262.86 }],
        pending: [],
        pnl: { account: { couponInterest: 137_504.08, total: -785_300.48 } },
        nav: { account: 5_264_699.53, book: 6_814_699.53 },
        balance: { account: { cash: 2_507_518.88, receivable: null, accruedIncome: 2_489.15, assets: 5_264_699.53, netAssets: 5_264_699.53, local: { EUR: { cash: 2_279_562.62, receivable: null, accruedIncome: 2_262.86 } } } },
      },
    },
    {
      // The rest sold at 91.00 for settlement on Tuesday 25 July: 2,744,400 x 91 / 100 = 2,497,404; 10 days at 6.85% 5,221.983
      // (2,959.12 more than on the books); 0.5 bp = 124.870. Realized 2,497,404 - 2,703,904.48 = -206,500.48.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 3_000_000, estimate: 91, settleDate: '2028-07-25', notional: 2_744_400,
          gross: 2_497_404, accrued: 5_221.98, cash: 2_502_625.98, fees: 124.87 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 3_000_000, avgPrice: 91 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 3,000,000 LPARK-25-1-D @ 91\.00 EUR \(realized [-−]206,500\.48 EUR\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of LPARK-25-1-D: 2,959.12 EUR' },
        ],
        cash: { account: { EUR: { settled: 2_279_562.62, unsettled: 2_502_501.11, availableToTrade: 4_782_063.73 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-07-25', amount: 2_502_501.11, ccy: 'EUR', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -929_989.2, couponInterest: 140_759.11, commissions: -499.82, unrealized: 0, fx: 0, total: -789_729.91 } },
        nav: { account: 5_260_270.1, book: 6_810_270.1 },
        balance: { account: { cash: 2_507_518.88, receivable: 2_752_751.22, positions: null, accruedIncome: null, assets: 5_260_270.1, liabilities: 0, netAssets: 5_260_270.1,
          local: { EUR: { receivable: 2_502_501.11, positions: null, accruedIncome: null } } } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2028-07-25'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 2,502,501.11 EUR into settled cash', cash: { EUR: 2_502_501.11 } }],
        cash: { account: { EUR: { settled: 4_782_063.73, unsettled: 0, availableToTrade: 4_782_063.73 } }, treasury: { USD: { settled: 1_000_000 }, EUR: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 5_260_270.1, receivable: null, assets: 5_260_270.1, liabilities: 0, local: { EUR: { cash: 4_782_063.73, receivable: null } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// cdo
// ---------------------------------------------------------------------------------------------
// A structured-finance CDO senior mezzanine class held by Treasury: Pemberton Structured Credit CDO 2024-1 Class B Floating
// Rate Notes, 3-month term SOFR (TSOFR3M) + 2.10%, quarterly on 20 February, May, August and November, ACT/360 on current face,
// T+2, factor 0.6425 (the class has amortised). Class B is not deferrable. The coupon of the period running at registration is
// entered on the form (6.15%: the February fixing 4.05% + 2.10%).
//   - Treasury buys 8,000,000 original face on Tuesday 1 May 2029 (settling Thursday 3 May).
//   - 20 May is a Sunday: on Monday 21 May the coupon is paid on current face; the May fixing does not come: an alert, no
//     accrual, a sale refused. The quarterly paydown is recorded by hand (0.6425 to 0.6012 from 20 May, paid at once). Paying
//     in kind is refused: Class B is not deferrable.
//   - Memorial Day, Juneteenth and Independence Day pass with nothing accruing. On Monday 20 August the coupon is blocked,
//     visibly, waiting for the May fixing. The August fixing comes from the fixture (4.00%), then the May fixing (4.20%) is
//     entered by hand: the coupon is paid at 6.30%, and the next period runs at 6.10%.
//   - A realized loss is allocated by hand (0.6012 to 0.58 from 20 August); the price falls; 3,000,000 sold, then the rest.
// Commission: 0.5 basis point of clean principal. Days (ACT/360): 20 Feb to 3 May 72, to 20 May 89; 20 May to 20 Aug 92;
// from 20 Aug: to 22 Aug 2, 23 Aug 3, 27 Aug 7. Current face: 8,000,000 x 0.6425 = 5,140,000; x 0.6012 = 4,809,600; x 0.58 =
// 4,640,000; 3,000,000 x 0.58 = 1,740,000; 5,000,000 x 0.58 = 2,900,000.
const cdoSpec = {
  productId: 'cdo',
  title: 'Pemberton Structured Credit CDO 2024-1 Class B (3M term SOFR + 2.10%) held by Treasury: coupon on current face, missing fixing stops accrual and refuses a sale, paydown by hand, PIK refused (not deferrable), coupon blocked until the fixing is entered by hand, realized loss allocated, partial sale, close',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account (Treasury)', 'Action', 'Face amount (original face)'],
    automaticInputs: [...BOND_TICKET.automaticInputs, 'TSOFR3M fixing of each coupon period (rate fixture standing in for Shaffer MarketData)'],
    manualInputs: ['Registration: Coupon Floating, Reference rate TSOFR3M, Spread, Current coupon, Pool factor', 'Quarterly paydown recorded by hand (New pool factor, Factor effective from)', 'The missing May fixing entered by hand (Data connection, Manual entries)', 'Realized loss allocated by hand'],
    settlement: 'T+2 on the US bond calendar; a trade is refused while the period has no fixing',
    lifecycle: 'Automatic: daily accrual on current face at the period rate, quarterly coupon on current face, reset after each coupon; a missing fixing raises an alert, stops accrual and blocks the coupon until supplied or entered. Manual: paydown, loss allocation, the fixing entered by hand. Refused: a coupon paid in kind (not deferrable)',
    accounting: 'Treasury\'s position: cost per 100 of current face; paydown at par against a discount cost is a realized gain; loss realized; coupon and interest income (the blocked coupon is income when paid); commission expensed',
    collateral: 'None for a long position',
  },
  start: EDT('2029-05-01'), // Tuesday
  settlementCheck: { lag: 2, holidays: ['2029-05-28', '2029-06-19', '2029-07-04'] },
  book: {
    name: 'Matrix CDO', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 7_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 1_000_000 }] }, // the Account stays idle: Treasury trades
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'cdo', name: 'Pemberton Structured Credit CDO 2024-1 Class B Floating Rate Notes due 2034', symbol: 'PEMB-24-1-B', marketView: 'US_CASH', venueType: 'otc', issuer: 'Pemberton Structured Credit CDO 2024-1 Ltd', domicile: 'KY', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settleLag: 2 },
      terms: { couponType: 'float', referenceRate: 'TSOFR3M', spread: 0.021, currentCoupon: 0.0615, frequency: 4, maturity: '2034-05-20', issueDate: '2024-05-20', dayCount: 'ACT/360', redemption: 100, factor: 0.6425, seniority: 'Class B (senior mezzanine, not deferrable)' } },
  },
  quotes: { main: { bid: 95.5, ask: 96, last: 95.75, bidSize: 20_000_000, askSize: 20_000_000 } },
  expectAtStart: { ...startState(1_000_000, 6_000_000), cash: { account: usdCash(1_000_000), treasury: usdCash(6_000_000) }, alerts: [] },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 8_000_000, as: 'lot', owner: 'treasury',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 8_000_000, estimate: 96, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2029-05-03', calendar: 'USBOND',
            notional: 5_140_000, gross: 4_934_400, // 5,140,000 x 96 / 100
            accrued: 63_222, // 72 days at 6.15%: 5,140,000 x 6.15% x 72/360 = 63,222.00
            cash: -4_997_622, fees: 246.72 }], // 0.5 bp of 4,934,400
          cash: { USD: { purchases: 4_997_622, fees: 246.72, required: 4_997_868.72, available: 6_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 8_000_000, avgPrice: 96, fills: [{ qty: 8_000_000, price: 96, model: 'quoted-bid-ask', settleDate: '2029-05-03', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted', owner: 'treasury' }, { type: 'trade.fill', summary: 'Bought 8,000,000 PEMB-24-1-B @ 96.00 USD', owner: 'treasury', date: '2029-05-01' }],
        cash: { treasury: { USD: { settled: 6_000_000, unsettled: -4_997_868.72, availableToTrade: 1_002_131.28 } }, account: { USD: { settled: 1_000_000, availableToTrade: 1_000_000 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 8_000_000, avgCost: 96, cost: 4_934_400, price: 95.75,
          value: 4_921_550, unrealized: -12_850, accrued: 63_222, priceSource: 'Test fixture' }], // 5,140,000 x 95.75 / 100
        holdings: { main: { long: 8_000_000, short: 0, net: 8_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2029-05-03', amount: -4_997_868.72, ccy: 'USD', into: 'cash' }],
        // 20 May 2029 is a Sunday: the coupon is paid Monday 21 May. 20 May 2034 is a Saturday: redemption Monday 22 May 2034.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2029-05-21', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-05-22', status: 'pending' }],
        pnl: {
          account: { realized: 0, couponInterest: 0, commissions: 0, unrealized: 0, total: 0 },
          book: { realized: 0, couponInterest: 0, commissions: -246.72, fees: 0, borrowFunding: 0, unrealized: -12_850, total: -13_096.72 },
        },
        nav: { account: 1_000_000, treasury: 5_986_903.28, book: 6_986_903.28 },
        balance: {
          account: { cash: 1_000_000, assets: 1_000_000, liabilities: 0, netAssets: 1_000_000 },
          book: { cash: 7_000_000, accruedIncome: 63_222, positions: 4_921_550, payable: 4_997_868.72, assets: 11_984_772, liabilities: 4_997_868.72, netAssets: 6_986_903.28 },
        },
      },
    },
    { id: 'treasury-screens', covers: 'open', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2029-05-03'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 4,997,868.72 USD from settled cash', cash: { USD: -4_997_868.72 }, owner: 'treasury', date: '2029-05-03' }],
        cash: { treasury: { USD: { settled: 1_002_131.28, unsettled: 0, availableToTrade: 1_002_131.28 } } },
        pending: [],
        balance: { book: { cash: 2_002_131.28, payable: null, assets: 6_986_903.28, liabilities: 0 } },
      },
    },
    {
      // Monday 21 May. The coupon of 20 Feb to 20 May, 89 days at 6.15% on 5,140,000: 78,149.417, paid 78,149.42. The balance stands
      // at 20 May: 0, so 78,149.42 - 63,222.00 = 14,927.42 more income. No TSOFR3M fixing for 20 May: an alert, and no rate.
      id: 'coupon-may', covers: ['coupon', 'missing fixing'], action: 'clock', to: EDT('2029-05-21'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 8,000,000 PEMB-24-1-B (factor 0.6425: current face 5,140,000): 78,149.42 USD', cash: { USD: 78_149.42 }, owner: 'treasury', date: '2029-05-21' },
          { type: 'accrual.coupon', summary: 'Interest accrued on PEMB-24-1-B: 14,927.42 USD', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 1_080_280.7, availableToTrade: 1_080_280.7 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 8_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2029-08-20', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-05-22', status: 'pending' }],
        alerts: ['bond.fixing'],
        pnl: { book: { couponInterest: 14_927.42, total: 1_830.7 } },
        nav: { treasury: 6_001_830.7, book: 7_001_830.7 },
        balance: { book: { cash: 2_080_280.7, accruedIncome: null, assets: 7_001_830.7, netAssets: 7_001_830.7 } },
      },
    },
    {
      // The quarterly paydown from the trustee report: 0.6425 to 0.6012 from 20 May, paid today. Principal 8,000,000 x 0.0413 =
      // 330,400.00. Cost out 4,934,400 x 0.0413 / 0.6425 = 317,184.00: realized 13,216.00 (par against a cost of 96).
      id: 'paydown', covers: 'paydown (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'paydown', newFactor: 0.6012, effective: '2029-05-20' },
      expect: {
        events: [{ type: 'bond.paydown', summary: 'Principal paydown on PEMB-24-1-B: factor 0.6425 to 0.6012 from 2029-05-20, 330,400.00 USD received', cash: { USD: 330_400 }, owner: 'treasury', date: '2029-05-21' }],
        cash: { treasury: { USD: { settled: 1_410_680.7, availableToTrade: 1_410_680.7 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 8_000_000, cost: 4_617_216, avgCost: 96, price: 95.75, value: 4_605_192, unrealized: -12_024, accrued: 0 }], // 4,809,600 x 95.75 / 100
        pnl: { book: { realized: 13_216, unrealized: -12_024, total: 15_872.7 } },
        nav: { treasury: 6_015_872.7, book: 7_015_872.7 },
        balance: { book: { cash: 2_410_680.7, positions: 4_605_192, assets: 7_015_872.7, netAssets: 7_015_872.7 } },
      },
    },
    {
      id: 'pik-refused', covers: 'coupon paid in kind (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'pik' },
      status: 'blocked', reason: 'Class B is not deferrable: its coupon cannot be paid in kind.',
      expect: { refused: { engine: 'is not deferrable', api: 'is not deferrable', browser: 'offers no "Review coupon paid in kind"' } },
    },
    // Tuesday 12 June: still no May fixing. Nothing accrues (the rate is unknown, not zero), and a sale is refused.
    { id: 'no-fixing', covers: 'missing fixing', action: 'clock', to: EDT('2029-06-12'), expect: { events: [] } },
    {
      id: 'sell-without-fixing', covers: ['reduce', 'missing fixing'], action: 'ticket', instrument: 'main', side: 'sell', qty: 3_000_000, from: 'lot', owner: 'treasury',
      status: 'blocked', reason: 'The accrued interest of the sale cannot be computed without the period\'s fixing.',
      expect: { refused: 'has no TSOFR3M fixing for its current coupon period' },
    },
    {
      // Monday 20 August, after Juneteenth and Independence Day. The coupon of 20 May to 20 Aug waits, visibly, for the May fixing.
      id: 'coupon-blocked', covers: ['coupon', 'missing fixing', 'market holiday'], action: 'clock', to: EDT('2029-08-20'),
      expect: {
        events: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2029-08-20', status: 'blocked' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-05-22', status: 'pending' }],
      },
    },
    // The August fixing (4.00%) arrives from the fixture: it belongs to the period starting today; the blocked coupon does not use it.
    { id: 'august-fixing-arrives', covers: 'reset', action: 'rate', code: 'TSOFR3M', value: 4, date: '2029-08-16', expect: { events: [] } },
    {
      // The May fixing, 4.20%, entered by hand. The coupon is paid at 4.20% + 2.10% = 6.30% for 92 days on 4,809,600:
      // 77,434.56. Nothing had accrued for the period, so all of it is income now. The next period runs at 4.00% + 2.10% = 6.10%.
      id: 'may-fixing-entered', covers: ['coupon', 'fixing by hand'], action: 'manual_rate', code: 'TSOFR3M', value: 4.2, date: '2029-05-17', note: 'May fixing from the trustee notice',
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 8,000,000 PEMB-24-1-B (factor 0.6012: current face 4,809,600): 77,434.56 USD', cash: { USD: 77_434.56 }, owner: 'treasury', date: '2029-08-20' },
          { type: 'accrual.coupon', summary: 'Interest accrued on PEMB-24-1-B: 77,434.56 USD', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 1_488_115.26, availableToTrade: 1_488_115.26 } } },
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2029-11-20', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2034-05-22', status: 'pending' }],
        alerts: [],
        pnl: { book: { couponInterest: 92_361.98, total: 93_307.26 } },
        nav: { treasury: 6_093_307.26, book: 7_093_307.26 },
        balance: { book: { cash: 2_488_115.26, assets: 7_093_307.26, netAssets: 7_093_307.26 } },
      },
    },
    // Tuesday 21 August. End of day 20 Aug: the first day of the period, nothing accrued yet.
    { id: 'next-day', covers: 'accrual', action: 'clock', to: EDT('2029-08-21'), expect: { events: [] } },
    {
      // A realized loss allocated to Class B by hand: 0.6012 to 0.58 from 20 August. 8,000,000 x 0.0212 = 169,600 written off.
      // Cost out 4,617,216 x 0.0212 / 0.6012 = 162,816.00: realized loss. Nothing has accrued in the period yet: nothing to cancel.
      id: 'loss-allocated', covers: 'loss allocation (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'writedown', newFactor: 0.58, kind: 'loss', effective: '2029-08-20' },
      expect: {
        events: [{ type: 'bond.loss', summary: 'Realized loss allocated by hand to PEMB-24-1-B: factor 0.6012 to 0.58 from 2029-08-20, 169,600 of principal written off with no payment (8,000,000 original face); cost 162,816.00 USD written off as realized loss', owner: 'treasury', date: '2029-08-21' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 8_000_000, cost: 4_454_400, avgCost: 96, price: 95.75, value: 4_442_800, unrealized: -11_600, accrued: 0 }], // 4,640,000 x 95.75 / 100
        pnl: { book: { realized: -149_600, unrealized: -11_600, total: -69_084.74 } },
        nav: { treasury: 5_930_915.26, book: 6_930_915.26 },
        balance: { book: { positions: 4_442_800, assets: 6_930_915.26, netAssets: 6_930_915.26 } },
      },
    },
    {
      id: 'price-falls', action: 'quote', instrument: 'main', quote: { bid: 90, ask: 90.5, last: 90.25, bidSize: 20_000_000, askSize: 20_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 8_000_000, price: 90.25, value: 4_187_600, unrealized: -266_800 }], // 4,640,000 x 90.25 / 100
        pnl: { book: { unrealized: -266_800, total: -324_284.74 } },
        nav: { treasury: 5_675_715.26, book: 6_675_715.26 },
        balance: { book: { positions: 4_187_600, assets: 6_675_715.26, netAssets: 6_675_715.26 } },
      },
    },
    {
      // 3,000,000 sold at 90.00 for Thursday 23 August: current face 1,740,000 x 90 / 100 = 1,566,000; 3 days at 6.10% 884.50; 0.5 bp =
      // 78.30. Cost out 4,454,400 x 3 / 8 = 1,670,400: realized -104,400.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 3_000_000, from: 'lot', owner: 'treasury',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 3_000_000, estimate: 90, settleDate: '2029-08-23', notional: 1_740_000, gross: 1_566_000, accrued: 884.5, cash: 1_566_884.5, fees: 78.3 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 3_000_000, avgPrice: 90 }] },
        events: [{ type: 'strategy.legs_added', owner: 'treasury' }, { type: 'trade.fill', summary: /^Sold 3,000,000 PEMB-24-1-B @ 90\.00 USD \(realized [-−]104,400\.00 USD\)$/, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 1_488_115.26, unsettled: 1_566_806.2, availableToTrade: 3_054_921.46 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, cost: 2_784_000, avgCost: 96, price: 90.25, value: 2_617_250, unrealized: -166_750, accrued: -884.5 }], // 2,900,000 x 90.25 / 100
        holdings: { main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2029-08-23', amount: 1_566_806.2, ccy: 'USD', into: 'cash' }],
        pnl: { book: { realized: -254_000, commissions: -325.02, unrealized: -166_750, total: -328_713.04 } },
        nav: { treasury: 5_671_286.96, book: 6_671_286.96 },
        balance: { book: { receivable: 1_566_806.2, accruedIncome: -884.5, positions: 2_617_250, assets: 6_671_286.96, netAssets: 6_671_286.96 } },
      },
    },
    {
      // Thursday 23 August. End of day 22 Aug: 4,640,000 x 6.10% x 2/360 = 1,572.4444, less the 3 days sold 884.50: 687.94. 1,572.44 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2029-08-23'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 1,566,806.20 USD into settled cash', cash: { USD: 1_566_806.2 }, owner: 'treasury' },
          { type: 'accrual.coupon', summary: 'Interest accrued on PEMB-24-1-B: 1,572.44 USD', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 3_054_921.46, unsettled: 0, availableToTrade: 3_054_921.46 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 5_000_000, accrued: 687.94 }],
        pending: [],
        pnl: { book: { couponInterest: 93_934.42, total: -327_140.6 } },
        nav: { treasury: 5_672_859.4, book: 6_672_859.4 },
        balance: { book: { cash: 4_054_921.46, receivable: null, accruedIncome: 687.94, assets: 6_672_859.4, netAssets: 6_672_859.4 } },
      },
    },
    {
      // The rest sold at 90.00 for Monday 27 August: 2,900,000 x 90 / 100 = 2,610,000; 7 days at 6.10% 3,439.72 (2,751.78 more than on
      // the books); 0.5 bp = 130.50. Realized 2,610,000 - 2,784,000 = -174,000.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 5_000_000, estimate: 90, settleDate: '2029-08-27', notional: 2_900_000, gross: 2_610_000, accrued: 3_439.72, cash: 2_613_439.72, fees: 130.5 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 5_000_000, avgPrice: 90 }] },
        events: [
          { type: 'strategy.legs_added', owner: 'treasury' },
          { type: 'trade.fill', summary: /^Sold 5,000,000 PEMB-24-1-B @ 90\.00 USD \(realized [-−]174,000\.00 USD\)$/, owner: 'treasury' },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of PEMB-24-1-B: 2,751.78 USD', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 3_054_921.46, unsettled: 2_613_309.22, availableToTrade: 5_668_230.68 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2029-08-27', amount: 2_613_309.22, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { book: { realized: -428_000, couponInterest: 96_686.2, commissions: -455.52, unrealized: 0, total: -331_769.32 } },
        nav: { treasury: 5_668_230.68, book: 6_668_230.68 },
        balance: { book: { cash: 4_054_921.46, receivable: 2_613_309.22, positions: null, accruedIncome: null, assets: 6_668_230.68, liabilities: 0, netAssets: 6_668_230.68 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2029-08-27'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 2,613,309.22 USD into settled cash', cash: { USD: 2_613_309.22 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 5_668_230.68, unsettled: 0, availableToTrade: 5_668_230.68 } }, account: usdCash(1_000_000) },
        pending: [],
        balance: { book: { cash: 6_668_230.68, receivable: null, assets: 6_668_230.68, liabilities: 0 } },
      },
    },
    { id: 'treasury-screens-at-end', covers: 'close', action: 'owner_screens', owner: 'treasury', expect: {} },
  ],
};

// ---------------------------------------------------------------------------------------------
// credit_linked_note
// ---------------------------------------------------------------------------------------------
// A credit-linked note: Harrowgate Bank N.A. 7.25% Credit-Linked Notes due 20 December 2030, linked to Calderon Energy Corp.
// The bank pays a 7.25% coupon (quarterly on 20 March, June, September and December, 30/360) and par at maturity unless
// Calderon Energy has a credit event; then the coupon ends (interest ceases from the last coupon date) and principal is
// reduced to the recovery, the final price of Calderon's senior unsecured debt in the credit-event auction, and settled at it.
// T+2 on the US bond calendar, pieces of 1,000.
//   - Bought on Tuesday 14 September 2027 (settling Thursday 16 September); the 20 September coupon is paid.
//   - Calderon's spreads widen; 1,000,000 more bought on Wednesday 6 October (settling Friday 8 October); 1,000,000 sold on
//     Friday 8 October, settling Wednesday 13 October (T+2 over Columbus Day, a bond-market holiday).
//   - Calderon files for bankruptcy; the auction on Thursday 18 November sets the final price at 38.00: the credit event is
//     recorded by hand, recovery 0.38, settling Wednesday 24 November. The interest accrued since 20 September is forfeited,
//     the notes are settled at 38.00, and they can no longer be traded.
// Commission: 0.5 basis point of clean principal. Days of 30/360: 20 Jun to 16 Sep 86; from 20 Sep: to 5 Oct 15, 7 Oct 17,
// 8 Oct 18, 12 Oct 22, 13 Oct 23, 17 Nov 57. A quarter's coupon is 7.25% / 4 of face.
const clnDraft = {
  productId: 'credit_linked_note', name: 'Harrowgate Bank N.A. 7.25% Credit-Linked Notes due 20-Dec-2030 (Calderon Energy Corp)', symbol: 'HARR-CLN-CALD-30', marketView: 'US_CASH', venueType: 'otc', issuer: 'Harrowgate Bank N.A.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
  conventions: { settleLag: 2 },
  terms: { couponType: 'fixed', couponRate: 0.0725, frequency: 4, maturity: '2030-12-20', issueDate: '2025-12-20', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured (credit-linked)', referenceEntity: 'Calderon Energy Corp' },
};
const clnSpec = {
  productId: 'credit_linked_note',
  title: 'Harrowgate Bank 7.25% credit-linked notes on Calderon Energy: registration needs the reference entity, bought, coupon, increased, partial sale over Columbus Day, credit event by hand ends the coupon (accrued forfeited) and settles principal at the 38% recovery, no trading after',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    manualInputs: ['Registration: Reference entity (required)', 'Credit event recorded by hand on the instrument form (Recovery rate, Recovery settles on, Review credit event, Record credit event)'],
    settlement: 'T+2 on the US bond calendar, Columbus Day skipped; after the credit event, the recovery settles on the auction settlement date',
    lifecycle: 'Automatic: daily accrual, quarterly coupon. Manual: the credit event (coupon ends, accrued since the last coupon forfeited, principal settled at the recovery). Refused: trading after the credit event. Not modelled: the auction itself (the recovery is entered), physical settlement by delivery of obligations',
    accounting: 'Cost at average; coupon and interest income (the forfeited accrued reversed out of it); principal settled at the recovery against cost is a realized loss; commission expensed',
    collateral: 'None for a long position (the issuer\'s own credit is not collateralised)',
  },
  start: EDT('2027-09-14'), // Tuesday
  settlementCheck: { lag: 2, holidays: ['2027-10-11'] }, // Columbus Day (bond market)
  book: {
    name: 'Matrix CLN', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 4_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: { main: clnDraft },
  quotes: { main: { bid: 99.25, ask: 99.5, last: 99.375, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(4_000_000, 1_000_000), cash: { account: usdCash(4_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'register-without-reference-entity', covers: 'registration', action: 'register_instrument',
      draft: { ...clnDraft, name: 'Harrowgate Bank N.A. 6.50% Credit-Linked Notes due 2029', symbol: 'HARR-CLN-29', terms: { ...clnDraft.terms, couponRate: 0.065, maturity: '2029-12-20', referenceEntity: undefined } },
      status: 'blocked', reason: 'A credit-linked note cannot be registered without the reference entity its credit event depends on.',
      expect: { refused: 'needs its reference entity' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2_000_000, estimate: 99.5, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-09-16', calendar: 'USBOND',
            gross: 1_990_000, accrued: 34_638.89, // 86 days: 2,000,000 x 7.25% x 86/360 = 34,638.889
            cash: -2_024_638.89, fees: 99.5 }], // 0.5 bp of 1,990,000
          cash: { USD: { purchases: 2_024_638.89, fees: 99.5, required: 2_024_738.39, available: 4_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2_000_000, avgPrice: 99.5, fills: [{ qty: 2_000_000, price: 99.5, model: 'quoted-bid-ask', settleDate: '2027-09-16', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000,000 HARR-CLN-CALD-30 @ 99.50 USD', owner: 'account', date: '2027-09-14' }],
        cash: { account: { USD: { settled: 4_000_000, unsettled: -2_024_738.39, availableToTrade: 1_975_261.61 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2_000_000, avgCost: 99.5, cost: 1_990_000, price: 99.375, value: 1_987_500, unrealized: -2_500, accrued: 34_638.89, priceSource: 'Test fixture' }],
        holdings: { main: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-09-16', amount: -2_024_738.39, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-09-20', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-12-20', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -99.5, fees: 0, borrowFunding: 0, unrealized: -2_500, total: -2_599.5 } },
        nav: { account: 3_997_400.5, book: 4_997_400.5 },
        balance: { account: { cash: 4_000_000, accruedIncome: 34_638.89, positions: 1_987_500, payable: 2_024_738.39, assets: 6_022_138.89, liabilities: 2_024_738.39, netAssets: 3_997_400.5 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2027-09-16'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,024,738.39 USD from settled cash', cash: { USD: -2_024_738.39 }, date: '2027-09-16' }],
        cash: { account: { USD: { settled: 1_975_261.61, unsettled: 0, availableToTrade: 1_975_261.61 } } },
        pending: [],
        balance: { account: { cash: 1_975_261.61, payable: null, assets: 3_997_400.5, liabilities: 0 } },
      },
    },
    {
      // Monday 20 September: the coupon 2,000,000 x 7.25% / 4 = 36,250.00. The balance stands at 20 September: 0; 36,250.00 -
      // 34,638.89 = 1,611.11 more income.
      id: 'coupon', covers: 'coupon', action: 'clock', to: EDT('2027-09-20'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 2,000,000 HARR-CLN-CALD-30: 36,250.00 USD', cash: { USD: 36_250 }, owner: 'account', date: '2027-09-20' },
          { type: 'accrual.coupon', summary: 'Interest accrued on HARR-CLN-CALD-30: 1,611.11 USD' },
        ],
        cash: { account: { USD: { settled: 2_011_511.61, availableToTrade: 2_011_511.61 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-12-20', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2030-12-20', status: 'pending' }],
        pnl: { account: { couponInterest: 1_611.11, total: -988.39 } },
        nav: { account: 3_999_011.61, book: 4_999_011.61 },
        balance: { account: { cash: 2_011_511.61, accruedIncome: null, assets: 3_999_011.61, netAssets: 3_999_011.61 } },
      },
    },
    {
      id: 'spreads-widen', action: 'quote', instrument: 'main', quote: { bid: 97, ask: 97.5, last: 97.25, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, price: 97.25, value: 1_945_000, unrealized: -45_000 }],
        pnl: { account: { unrealized: -45_000, total: -43_488.39 } },
        nav: { account: 3_956_511.61, book: 4_956_511.61 },
        balance: { account: { positions: 1_945_000, assets: 3_956_511.61, netAssets: 3_956_511.61 } },
      },
    },
    {
      // Wednesday 6 October. End of day 5 Oct: 2,000,000 x 7.25% x 15/360 = 6,041.67.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EDT('2027-10-06'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on HARR-CLN-CALD-30: 6,041.67 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 6_041.67 }],
        pnl: { account: { couponInterest: 7_652.78, total: -37_446.72 } },
        nav: { account: 3_962_553.28, book: 4_962_553.28 },
        balance: { account: { accruedIncome: 6_041.67, assets: 3_962_553.28, netAssets: 3_962_553.28 } },
      },
    },
    {
      // 1,000,000 more at 97.50 = 975,000, settling Friday 8 October; 18 days 3,625.00; 0.5 bp = 48.75.
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, estimate: 97.5, settleDate: '2027-10-08', gross: 975_000, accrued: 3_625, cash: -978_625, fees: 48.75 }],
          cash: { USD: { purchases: 978_625, fees: 48.75, required: 978_673.75, available: 2_011_511.61, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 97.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 1,000,000 HARR-CLN-CALD-30 @ 97.50 USD' }],
        cash: { account: { USD: { settled: 2_011_511.61, unsettled: -978_673.75, availableToTrade: 1_032_837.86 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_000_000, cost: 2_965_000, avgCost: 98.8333333, price: 97.25, value: 2_917_500, unrealized: -47_500, accrued: 9_666.67 }],
        holdings: { main: { long: 3_000_000, short: 0, net: 3_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-10-08', amount: -978_673.75, ccy: 'USD', into: 'cash' }],
        pnl: { account: { commissions: -148.25, unrealized: -47_500, total: -39_995.47 } },
        nav: { account: 3_960_004.53, book: 4_960_004.53 },
        balance: { account: { cash: 2_011_511.61, accruedIncome: 9_666.67, positions: 2_917_500, payable: 978_673.75, assets: 4_938_678.28, liabilities: 978_673.75, netAssets: 3_960_004.53 } },
      },
    },
    {
      // Friday 8 October. End of day 7 Oct: 2,000,000 x 17 days 6,847.2222 + 1,000,000 bought to 8 Oct (18 days) 3,625: 10,472.22.
      // 805.55 more.
      id: 'settle-increase', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2027-10-08'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 978,673.75 USD from settled cash', cash: { USD: -978_673.75 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on HARR-CLN-CALD-30: 805.55 USD' },
        ],
        cash: { account: { USD: { settled: 1_032_837.86, unsettled: 0, availableToTrade: 1_032_837.86 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 3_000_000, accrued: 10_472.22 }],
        pending: [],
        pnl: { account: { couponInterest: 8_458.33, total: -39_189.92 } },
        nav: { account: 3_960_810.08, book: 4_960_810.08 },
        balance: { account: { cash: 1_032_837.86, payable: null, accruedIncome: 10_472.22, assets: 3_960_810.08, liabilities: 0, netAssets: 3_960_810.08 } },
      },
    },
    {
      // 1,000,000 sold at 97.00 = 970,000, settling Wednesday 13 October (Columbus Day, Monday 11th, is closed): 23 days 4,631.94;
      // 0.5 bp = 48.50. Cost out 2,965,000 / 3 = 988,333.333: realized 970,000 - 988,333.33 = -18,333.33.
      id: 'reduce', covers: ['reduce', 'market holiday'], action: 'ticket', instrument: 'main', side: 'sell', qty: 1_000_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_000_000, estimate: 97, settleDate: '2027-10-13', gross: 970_000, accrued: 4_631.94, cash: 974_631.94, fees: 48.5 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1_000_000, avgPrice: 97 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 1,000,000 HARR-CLN-CALD-30 @ 97\.00 USD \(realized [-−]18,333\.33 USD\)$/ }],
        cash: { account: { USD: { settled: 1_032_837.86, unsettled: 974_583.44, availableToTrade: 2_007_421.3 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, cost: 1_976_666.67, avgCost: 98.8333335, price: 97.25, value: 1_945_000, unrealized: -31_666.67, accrued: 5_840.28 }],
        holdings: { main: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-10-13', amount: 974_583.44, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -18_333.33, commissions: -196.75, unrealized: -31_666.67, total: -41_738.42 } },
        nav: { account: 3_958_261.58, book: 4_958_261.58 },
        balance: { account: { receivable: 974_583.44, accruedIncome: 5_840.28, positions: 1_945_000, assets: 3_958_261.58, netAssets: 3_958_261.58 } },
      },
    },
    {
      // Wednesday 13 October. End of day 12 Oct: 3,000,000 x 22 days 13,291.6667 less the 23 days sold 4,631.9444: 8,659.72.
      // 2,819.44 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual', 'market holiday'], action: 'clock', to: EDT('2027-10-13'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 974,583.44 USD into settled cash', cash: { USD: 974_583.44 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on HARR-CLN-CALD-30: 2,819.44 USD' },
        ],
        cash: { account: { USD: { settled: 2_007_421.3, unsettled: 0, availableToTrade: 2_007_421.3 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 8_659.72 }],
        pending: [],
        pnl: { account: { couponInterest: 11_277.77, total: -38_918.98 } },
        nav: { account: 3_961_081.02, book: 4_961_081.02 },
        balance: { account: { cash: 2_007_421.3, receivable: null, accruedIncome: 8_659.72, assets: 3_961_081.02, netAssets: 3_961_081.02 } },
      },
    },
    {
      // Thursday 18 November, the auction day. End of day 17 Nov: 2,000,000 x 7.25% x 57/360 = 22,958.33. 14,298.61 more.
      id: 'auction-day', covers: 'accrual', action: 'clock', to: EST('2027-11-18'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on HARR-CLN-CALD-30: 14,298.61 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 22_958.33 }],
        pnl: { account: { couponInterest: 25_576.38, total: -24_620.37 } },
        nav: { account: 3_975_379.63, book: 4_975_379.63 },
        balance: { account: { accruedIncome: 22_958.33, assets: 3_975_379.63, netAssets: 3_975_379.63 } },
      },
    },
    {
      // The credit event, recorded by hand: recovery 0.38 from the auction, settling 24 November. The interest accrued since
      // 20 September, 22,958.33, is forfeited (reversed out of coupon and interest income). Principal is settled at 38.00:
      // 2,000,000 x 38% = 760,000.00 receivable on 24 November; realized 760,000 - 1,976,666.67 = -1,216,666.67. The December
      // coupon and the redemption are cancelled.
      id: 'credit-event', covers: ['credit event (by hand)', 'close'], action: 'instrument_lifecycle', instrument: 'main', body: { action: 'credit_event', recovery: 0.38, settleDate: '2027-11-24' },
      expect: {
        events: [
          { type: 'accrual.coupon', summary: 'Accrued interest forfeited on HARR-CLN-CALD-30: credit event of Calderon Energy Corp, interest ceases from the last coupon date: 22,958.33 USD' },
          { type: 'bond.credit_event', summary: 'Credit event of Calderon Energy Corp recorded by hand: principal reduced to the recovery and settled on 2027-11-24, coupons ended: 2,000,000 HARR-CLN-CALD-30 at 38.00% of par', owner: 'account', date: '2027-11-18' },
        ],
        cash: { account: { USD: { settled: 2_007_421.3, unsettled: 760_000, availableToTrade: 2_767_421.3 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-11-24', amount: 760_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -1_235_000, couponInterest: 2_618.05, unrealized: 0, total: -1_232_578.7 } },
        nav: { account: 2_767_421.3, book: 3_767_421.3 },
        balance: { account: { receivable: 760_000, accruedIncome: null, positions: null, assets: 2_767_421.3, netAssets: 2_767_421.3 } },
      },
    },
    {
      id: 'trade-after-credit-event', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot2',
      status: 'blocked', reason: 'After the credit event the notes were settled at the recovery: nothing is left to trade.',
      expect: { refused: 'can no longer be traded' },
    },
    {
      id: 'recovery-settles', covers: 'settlement', action: 'clock', to: EST('2027-11-24'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 760,000.00 USD into settled cash', cash: { USD: 760_000 } }],
        cash: { account: { USD: { settled: 2_767_421.3, unsettled: 0, availableToTrade: 2_767_421.3 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 2_767_421.3, receivable: null, assets: 2_767_421.3, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// structured_note
// ---------------------------------------------------------------------------------------------
// A contingent income note without principal protection: Ardent Capital Markets Contingent Income Notes linked to the
// Northbridge 100 Index, due 15 September 2028. Initial level 5,000. On each quarterly coupon date (15 December, March, June,
// September) the index is observed: at or above the coupon barrier, 70% of the initial (3,500), the holder is paid a contingent
// coupon of 9.00% a year (2.25% of face), 3 days later; below it, nothing. Nothing accrues in between: the note trades flat.
// At maturity the principal is par if the final observation is at or above the principal barrier, 60% (3,000); below it the
// holder is repaid par x final / initial. The Terminal has no feed for the index: each observation is recorded by hand.
//   - Bought on Monday 8 May 2028 (settling Wednesday 10 May) at 96.00, flat; increased the same day.
//   - 15 June: the index is observed at 4,210.35 (84.21%), recorded by hand: the 2.25% coupon is earned, and paid on Tuesday
//     20 June (18 June a Sunday, 19 June Juneteenth).
//   - The index falls; 400,000 sold at 80.00 on 10 July.
//   - On Monday 18 September (the payment date of the final coupon and the principal) both wait, visibly, for the final
//     observation. It is recorded: 2,850 (57.00%), below both barriers: no coupon, and principal repaid at 57.00% of par.
// Commission: 0.5 basis point of clean principal. The book's figures follow from flat trades: no accrued changes hands.
const structuredNoteSpec = {
  productId: 'structured_note',
  title: 'Ardent contingent income note on the Northbridge 100 Index (not principal protected): flat trades, observations recorded by hand, coupon paid over Juneteenth, partial sale, final coupon and principal blocked until the final observation, below both barriers: no coupon and principal at 57% of par',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 1,000)'],
    automaticInputs: ['bid, ask, last in % of par (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model', 'no accrued interest (contingent coupon, trades flat)', 'settlement date from the instrument convention and settlement calendar', 'commission from the Book fee schedule'],
    manualInputs: ['Registration: Coupon rate (contingent), Linked to, Initial level, Coupon barrier, Principal protected (no), Principal barrier, Payment delay 3', 'Each observation of the index recorded by hand on the instrument form (Observation date, Observed level, Review, Record)'],
    settlement: 'T+2 on the US bond calendar; flat (no accrued interest)',
    lifecycle: 'Automatic: the contingent coupon worked out from the observation (paid 3 days after the coupon date, next business day) and the principal at maturity from the final observation and the barrier. Manual: every observation (no index feed); a coupon or the redemption waits, visibly, for its observation. Not modelled: autocall, memory coupons',
    accounting: 'Cost at average; the contingent coupon is coupon and interest income once its observation is recorded (accrued until paid); principal repaid below par against cost is a realized loss; commission expensed',
    collateral: 'None for a long position',
  },
  start: EDT('2028-05-08'), // Monday
  settlementCheck: { lag: 2, holidays: ['2028-06-19'] }, // Juneteenth
  book: {
    name: 'Matrix structured note', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'structured_note', name: 'Ardent Capital Markets Contingent Income Notes linked to the Northbridge 100 Index due 15-Sep-2028', symbol: 'ARDENT-NB100-28', marketView: 'US_CASH', venueType: 'otc', issuer: 'Ardent Capital Markets LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settleLag: 2 },
      terms: { couponType: 'fixed', couponRate: 0.09, frequency: 4, maturity: '2028-09-15', issueDate: '2026-09-15', dayCount: '30/360', redemption: 100, minDenomination: 1_000, paymentDelayDays: 3,
        linkedTo: 'Northbridge 100 Index', initialLevel: 5_000, couponBarrier: 0.7, principalProtected: false, principalBarrier: 0.6 } },
  },
  quotes: { main: { bid: 95.5, ask: 96, last: 95.75, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(2_000_000, 1_000_000), cash: { account: usdCash(2_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 96, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2028-05-10', calendar: 'USBOND',
            gross: 960_000, accrued: 0, // flat: a contingent coupon does not accrue
            cash: -960_000, fees: 48 }], // 0.5 bp of 960,000
          cash: { USD: { purchases: 960_000, fees: 48, required: 960_048, available: 2_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 96, fills: [{ qty: 1_000_000, price: 96, model: 'quoted-bid-ask', settleDate: '2028-05-10', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000,000 ARDENT-NB100-28 @ 96.00 USD', owner: 'account', date: '2028-05-08' }],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -960_048, availableToTrade: 1_039_952 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 96, cost: 960_000, price: 95.75, value: 957_500, unrealized: -2_500, accrued: 0, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-05-10', amount: -960_048, ccy: 'USD', into: 'cash' }],
        // The 15 June coupon is paid 3 days later, Sunday 18 June: on the next business day after Juneteenth (Monday 19 June),
        // Tuesday 20 June. Maturity 15 September + 3 days = Monday 18 September.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-06-20', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2028-09-18', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -48, fees: 0, borrowFunding: 0, unrealized: -2_500, total: -2_548 } },
        nav: { account: 1_997_452, book: 2_997_452 },
        balance: { account: { cash: 2_000_000, accruedIncome: null, positions: 957_500, payable: 960_048, assets: 2_957_500, liabilities: 960_048, netAssets: 1_997_452 } },
      },
    },
    {
      // 500,000 more at 96.00 = 480,000, settling Wednesday 10 May (T+2); commission 24.00.
      id: 'increase', covers: 'increase', action: 'resize', lot: 'lot', factor: 1.5,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', qty: 500_000, estimate: 96, settleDate: '2028-05-10', gross: 480_000, accrued: 0, cash: -480_000, fees: 24 }],
          cash: { USD: { purchases: 480_000, fees: 24, required: 480_024, available: 1_039_952, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 500_000, avgPrice: 96 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 500,000 ARDENT-NB100-28 @ 96.00 USD' }],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -1_440_072, availableToTrade: 559_928 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, cost: 1_440_000, avgCost: 96, price: 95.75, value: 1_436_250, unrealized: -3_750, accrued: 0 }],
        holdings: { main: { long: 1_500_000, short: 0, net: 1_500_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-05-10', amount: -960_048, ccy: 'USD', into: 'cash' }, { instrument: 'main', owner: 'account', dueDate: '2028-05-10', amount: -480_024, ccy: 'USD', into: 'cash' }],
        pnl: { account: { commissions: -72, unrealized: -3_750, total: -3_822 } },
        nav: { account: 1_996_178, book: 2_996_178 },
        balance: { account: { cash: 2_000_000, positions: 1_436_250, payable: 1_440_072, assets: 3_436_250, liabilities: 1_440_072, netAssets: 1_996_178 } },
      },
    },
    {
      // Wednesday 10 May: both purchases settle. Nothing accrues (contingent coupon).
      id: 'settle', covers: 'settlement', action: 'clock', to: EDT('2028-05-10'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 960,048.00 USD from settled cash', cash: { USD: -960_048 }, date: '2028-05-10' },
          { type: 'settlement.pay', summary: 'paid 480,024.00 USD from settled cash', cash: { USD: -480_024 }, date: '2028-05-10' },
        ],
        cash: { account: { USD: { settled: 559_928, unsettled: 0, availableToTrade: 559_928 } } },
        pending: [],
        balance: { account: { cash: 559_928, payable: null, assets: 1_996_178, liabilities: 0 } },
      },
    },
    // Thursday 15 June, the first observation date in the holding: nothing accrues, nothing is due yet.
    { id: 'observation-day', covers: 'accrual', action: 'clock', to: EDT('2028-06-15'), expect: { events: [] } },
    {
      // The index closes at 4,210.35 on 15 June: 84.21% of 5,000, at or above the coupon barrier 3,500. Recorded by hand.
      id: 'june-observation', covers: 'observation (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'observation', date: '2028-06-15', level: 4_210.35 },
      expect: {
        events: [{ type: 'bond.observation', summary: 'Observation of Northbridge 100 Index on 2028-06-15 recorded by hand: 4,210.35 (84.21% of the initial 5,000): at or above the coupon barrier, the contingent coupon of 2.25% is paid', owner: 'account', date: '2028-06-15' }],
      },
    },
    {
      // Friday 16 June. End of day 15 June: the coupon of 15 June is earned and not yet paid: 1,500,000 x 2.25% = 33,750.00.
      id: 'coupon-earned', covers: ['coupon', 'accrual'], action: 'clock', to: EDT('2028-06-16'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on ARDENT-NB100-28: 33,750.00 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, accrued: 33_750 }],
        pnl: { account: { couponInterest: 33_750, total: 29_928 } },
        nav: { account: 2_029_928, book: 3_029_928 },
        balance: { account: { accruedIncome: 33_750, assets: 2_029_928, netAssets: 2_029_928 } },
      },
    },
    {
      // Tuesday 20 June, after Juneteenth: the contingent coupon 33,750.00 is paid.
      id: 'coupon-paid', covers: ['coupon', 'market holiday'], action: 'clock', to: EDT('2028-06-20'),
      expect: {
        events: [{ type: 'bond.coupon', summary: 'Coupon received on 1,500,000 ARDENT-NB100-28 (contingent coupon: Northbridge 100 Index observed at 4,210.35, at or above the coupon barrier 3,500): 33,750.00 USD', cash: { USD: 33_750 }, owner: 'account', date: '2028-06-20' }],
        cash: { account: { USD: { settled: 593_678, availableToTrade: 593_678 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-09-18', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2028-09-18', status: 'pending' }],
        balance: { account: { cash: 593_678, accruedIncome: null, assets: 2_029_928, netAssets: 2_029_928 } },
      },
    },
    {
      id: 'index-falls', action: 'quote', instrument: 'main', quote: { bid: 80, ask: 81, last: 80.5, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_500_000, price: 80.5, value: 1_207_500, unrealized: -232_500 }],
        pnl: { account: { unrealized: -232_500, total: -198_822 } },
        nav: { account: 1_801_178, book: 2_801_178 },
        balance: { account: { positions: 1_207_500, assets: 1_801_178, netAssets: 1_801_178 } },
      },
    },
    // Monday 10 July: nothing accrues between coupon dates.
    { id: 'july', action: 'clock', to: EDT('2028-07-10'), expect: { events: [] } },
    {
      // 400,000 sold at 80.00 = 320,000 flat, settling Wednesday 12 July; commission 16.00. Cost out 1,440,000 x 4 / 15 = 384,000:
      // realized -64,000.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 400_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 400_000, estimate: 80, settleDate: '2028-07-12', gross: 320_000, accrued: 0, cash: 320_000, fees: 16 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 400_000, avgPrice: 80 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 400,000 ARDENT-NB100-28 @ 80\.00 USD \(realized [-−]64,000\.00 USD\)$/ }],
        cash: { account: { USD: { settled: 593_678, unsettled: 319_984, availableToTrade: 913_662 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_100_000, cost: 1_056_000, avgCost: 96, price: 80.5, value: 885_500, unrealized: -170_500, accrued: 0 }],
        holdings: { main: { long: 1_100_000, short: 0, net: 1_100_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2028-07-12', amount: 319_984, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -64_000, commissions: -88, unrealized: -170_500, total: -200_838 } },
        nav: { account: 1_799_162, book: 2_799_162 },
        balance: { account: { receivable: 319_984, positions: 885_500, assets: 1_799_162, netAssets: 1_799_162 } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: EDT('2028-07-12'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 319,984.00 USD into settled cash', cash: { USD: 319_984 } }],
        cash: { account: { USD: { settled: 913_662, unsettled: 0, availableToTrade: 913_662 } } },
        pending: [],
        balance: { account: { cash: 913_662, receivable: null, assets: 1_799_162, netAssets: 1_799_162 } },
      },
    },
    {
      // Monday 18 September: the final coupon and the principal are due and both wait, visibly, for the final observation.
      id: 'maturity-waits', covers: ['maturity', 'observation (by hand)'], action: 'clock', to: EDT('2028-09-18'),
      expect: {
        events: [],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-09-18', status: 'blocked' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2028-09-18', status: 'blocked' }],
      },
    },
    {
      // The final observation, recorded by hand: 2,850 on 15 September, 57.00% of the initial. Below the coupon barrier: no coupon.
      // Below the principal barrier (60%): principal repaid at 57.00% of par, 1,100,000 x 57% = 627,000.00, against a cost of
      // 1,056,000: realized -429,000.
      id: 'final-observation', covers: ['observation (by hand)', 'coupon', 'maturity', 'close'], action: 'instrument_lifecycle', instrument: 'main', body: { action: 'observation', date: '2028-09-15', level: 2_850 },
      expect: {
        events: [
          { type: 'bond.observation', summary: 'Observation of Northbridge 100 Index on 2028-09-15 recorded by hand: 2,850 (57.00% of the initial 5,000): below the coupon barrier, no coupon; below the principal barrier 60%: principal repaid at 57.00% of par', owner: 'account', date: '2028-09-18' },
          { type: 'bond.contingent_coupon', summary: 'Contingent coupon of 2028-09-15 not paid on 1,100,000 ARDENT-NB100-28: Northbridge 100 Index observed at 2,850, below the coupon barrier 3,500 (70% of the initial 5,000)', owner: 'account', date: '2028-09-18' },
          { type: 'bond.redemption', summary: 'Redeemed at maturity: 1,100,000 ARDENT-NB100-28 at 57.00% of par (final observation 2,850 is 57.00% of the initial 5,000, below the principal barrier 60%: not protected, principal repaid at the underlying\'s performance)', owner: 'account', date: '2028-09-18' },
          { type: 'settlement.receive', summary: 'received 627,000.00 USD into settled cash', cash: { USD: 627_000 } },
        ],
        cash: { account: { USD: { settled: 1_540_662, unsettled: 0, availableToTrade: 1_540_662 } }, treasury: usdCash(1_000_000) },
        positions: [],
        holdings: { main: null },
        pending: [],
        lifecycle: [],
        pnl: { account: { realized: -493_000, unrealized: 0, total: -459_338 } },
        nav: { account: 1_540_662, book: 2_540_662 },
        balance: { account: { cash: 1_540_662, positions: null, assets: 1_540_662, liabilities: 0, netAssets: 1_540_662 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// catastrophe_bond
// ---------------------------------------------------------------------------------------------
// A catastrophe bond: Gulfstream Re 2026-1 Ltd Class A Principal At-Risk Variable Rate Notes (Cayman SPV, 144A, USD), sponsored
// by Harbor Mutual Insurance Company, covering US named-storm losses on an industry-index trigger (PCS losses of 40 billion
// attach, 65 billion exhaust). The 150,000,000 issue's principal is held in a collateral trust account invested in US Treasury
// money-market funds; the coupon passes through the collateral return (3-month T-bill yield, rate code UST3M, from the fixture)
// plus a risk spread of 7.75%, quarterly on 7 January, April, July and October, ACT/360. T+2, pieces of 250,000. When a covered
// event triggers a principal loss (determined by the calculation agent, recorded by hand), principal is reduced from the start
// of the interest period in which it is determined, and that much collateral is released to the sponsor.
//   - Bought on Tuesday 3 August 2027 at 101.00 (settling Thursday 5 August). A hurricane makes landfall: the price falls.
//   - Labor Day passes; the 7 October coupon is paid at 11.65% (3.90% + 7.75%); the next period takes the October T-bill fixing
//     (3.70%: 11.45%).
//   - Monday 18 October: the calculation agent's loss report: 40% of principal is lost (factor 1 to 0.60 from 7 October),
//     60,000,000 of collateral released to the sponsor. The interest accrued since 7 October on the lost principal is cancelled.
//   - The remaining principal is re-priced at 95.50; 1,000,000 original face sold, then the rest.
// Commission: 0.5 basis point of clean principal. Days (ACT/360) from 7 Jul: to 5 Aug 29, 1 Sep 56, 7 Sep 62, 4 Oct 89, 7 Oct 92;
// from 7 Oct: to 15 Oct 8, 19 Oct 12, 20 Oct 13, 22 Oct 15.
const catBondSpec = {
  productId: 'catastrophe_bond',
  title: 'Gulfstream Re 2026-1 Class A cat bond (T-bill collateral return + 7.75%): collateral account term, hurricane price fall, Labor Day, coupon and T-bill reset, covered event by hand cuts principal 40% and releases collateral to the sponsor, partial sale, close',
  matrix: {
    ...BOND_TICKET,
    requiredFields: ['Account', 'Action', 'Face amount (a multiple of 250,000)'],
    automaticInputs: [...BOND_TICKET.automaticInputs, 'UST3M collateral-return fixing of each period (rate fixture standing in for Shaffer MarketData)'],
    manualInputs: ['Registration: Collateral account (required), Issue size, Sponsor, Trigger, Coupon Floating UST3M + spread, Current coupon', 'Covered event recorded by hand on the instrument form (Principal written down to, Kind: Covered event, Write-down effective from)'],
    settlement: 'T+2 on the US bond calendar',
    lifecycle: 'Automatic: daily accrual, quarterly coupon at the collateral return plus the risk spread, reset from the fixing. Manual: the covered event and its principal loss (no catastrophe-loss feed), which releases collateral to the sponsor. Not modelled: the collateral fund\'s own valuation (the account is described with its outstanding balance)',
    accounting: 'Cost per 100 of outstanding principal; principal lost to the covered event written off as a realized loss with the interest accrued on it; coupon and interest income; commission expensed',
    collateral: 'Held by the issuer in its collateral trust account, not by the holder: the account\'s balance and the collateral released to the sponsor are shown on the instrument',
  },
  start: EDT('2027-08-03'), // Tuesday
  settlementCheck: { lag: 2, holidays: ['2027-09-06'] }, // Labor Day
  book: {
    name: 'Matrix cat bond', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 4_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 3_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0.5 } }, fill: FILL, settlement: { bond: 1 }, short: SHORT },
  },
  instruments: {
    main: { productId: 'catastrophe_bond', name: 'Gulfstream Re 2026-1 Ltd Class A Principal At-Risk Variable Rate Notes due 2029', symbol: 'GULF-26-1-A', marketView: 'US_CASH', venueType: 'otc', issuer: 'Gulfstream Re 2026-1 Ltd', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { settleLag: 2 },
      terms: { couponType: 'float', referenceRate: 'UST3M', spread: 0.0775, currentCoupon: 0.1165, frequency: 4, maturity: '2029-04-07', issueDate: '2026-04-07', dayCount: 'ACT/360', redemption: 100, minDenomination: 250_000, seniority: 'Principal at risk (Class A)',
        collateralAccount: 'Collateral trust account at Calloway Trust Company, invested in US Treasury money-market funds', issueSize: 150_000_000, sponsor: 'Harbor Mutual Insurance Company', trigger: 'Industry index (PCS) US named-storm losses: 40 billion attachment, 65 billion exhaustion' } },
  },
  quotes: { main: { bid: 100.5, ask: 101, last: 100.75, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: { ...startState(3_000_000, 1_000_000), cash: { account: usdCash(3_000_000), treasury: usdCash(1_000_000) } },
  steps: [
    {
      id: 'register-without-collateral-account', covers: 'registration', action: 'register_instrument',
      draft: { productId: 'catastrophe_bond', name: 'Gulfstream Re 2026-2 Ltd Class A Notes', symbol: 'GULF-26-2-A', marketView: 'US_CASH', venueType: 'otc', issuer: 'Gulfstream Re 2026-2 Ltd', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
        terms: { couponType: 'float', referenceRate: 'UST3M', spread: 0.08, currentCoupon: 0.119, frequency: 4, maturity: '2029-10-07', issueDate: '2026-10-07', dayCount: 'ACT/360', redemption: 100, minDenomination: 250_000 } },
      status: 'blocked', reason: 'A catastrophe bond cannot be registered without the collateral account its principal is held in.',
      expect: { refused: 'needs its collateral account' },
    },
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2_000_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2_000_000, estimate: 101, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2027-08-05', calendar: 'USBOND',
            gross: 2_020_000, accrued: 18_769.44, // 29 days at 11.65%: 2,000,000 x 11.65% x 29/360 = 18,769.444
            cash: -2_038_769.44, fees: 101 }], // 0.5 bp of 2,020,000
          cash: { USD: { purchases: 2_038_769.44, fees: 101, required: 2_038_870.44, available: 3_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2_000_000, avgPrice: 101, fills: [{ qty: 2_000_000, price: 101, model: 'quoted-bid-ask', settleDate: '2027-08-05', source: 'Test fixture' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000,000 GULF-26-1-A @ 101.00 USD', owner: 'account', date: '2027-08-03' }],
        cash: { account: { USD: { settled: 3_000_000, unsettled: -2_038_870.44, availableToTrade: 961_129.56 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2_000_000, avgCost: 101, cost: 2_020_000, price: 100.75, value: 2_015_000, unrealized: -5_000, accrued: 18_769.44, priceSource: 'Test fixture' }],
        holdings: { main: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-08-05', amount: -2_038_870.44, ccy: 'USD', into: 'cash' }],
        // 7 October 2027 is a Thursday. 7 April 2029 is a Saturday: redemption Monday 9 April 2029.
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2027-10-07', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2029-04-09', status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -101, fees: 0, borrowFunding: 0, unrealized: -5_000, total: -5_101 } },
        nav: { account: 2_994_899, book: 3_994_899 },
        balance: { account: { cash: 3_000_000, accruedIncome: 18_769.44, positions: 2_015_000, payable: 2_038_870.44, assets: 5_033_769.44, liabilities: 2_038_870.44, netAssets: 2_994_899 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: EDT('2027-08-05'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,038,870.44 USD from settled cash', cash: { USD: -2_038_870.44 }, date: '2027-08-05' }],
        cash: { account: { USD: { settled: 961_129.56, unsettled: 0, availableToTrade: 961_129.56 } } },
        pending: [],
        balance: { account: { cash: 961_129.56, payable: null, assets: 2_994_899, liabilities: 0 } },
      },
    },
    {
      // Thursday 2 September. End of day 1 Sep: 2,000,000 x 11.65% x 56/360 = 36,244.44; 17,475.00 more.
      id: 'accrue', covers: 'accrual', action: 'clock', to: EDT('2027-09-02'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on GULF-26-1-A: 17,475.00 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 36_244.44 }],
        pnl: { account: { couponInterest: 17_475, total: 12_374 } },
        nav: { account: 3_012_374, book: 4_012_374 },
        balance: { account: { accruedIncome: 36_244.44, assets: 3_012_374, netAssets: 3_012_374 } },
      },
    },
    {
      // A hurricane makes landfall in the covered area: the bond trades down on the risk of a loss ("live cat").
      id: 'hurricane-landfall', action: 'quote', instrument: 'main', quote: { bid: 70, ask: 75, last: 72.5, bidSize: 5_000_000, askSize: 5_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, price: 72.5, value: 1_450_000, unrealized: -570_000 }],
        pnl: { account: { unrealized: -570_000, total: -552_626 } },
        nav: { account: 2_447_374, book: 3_447_374 },
        balance: { account: { positions: 1_450_000, assets: 2_447_374, netAssets: 2_447_374 } },
      },
    },
    {
      // Wednesday 8 September, after Labor Day. End of day 7 Sep: 62 days = 40,127.78; 3,883.34 more.
      id: 'after-labor-day', covers: ['accrual', 'market holiday'], action: 'clock', to: EDT('2027-09-08'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on GULF-26-1-A: 3,883.34 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 40_127.78 }],
        pnl: { account: { couponInterest: 21_358.34, total: -548_742.66 } },
        nav: { account: 2_451_257.34, book: 3_451_257.34 },
        balance: { account: { accruedIncome: 40_127.78, assets: 2_451_257.34, netAssets: 2_451_257.34 } },
      },
    },
    {
      // Tuesday 5 October. End of day 4 Oct: 89 days = 57,602.78; 17,475.00 more.
      id: 'accrue-october', covers: 'accrual', action: 'clock', to: EDT('2027-10-05'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on GULF-26-1-A: 17,475.00 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 57_602.78 }],
        pnl: { account: { couponInterest: 38_833.34, total: -531_267.66 } },
        nav: { account: 2_468_732.34, book: 3_468_732.34 },
        balance: { account: { accruedIncome: 57_602.78, assets: 2_468_732.34, netAssets: 2_468_732.34 } },
      },
    },
    // The 3-month T-bill fixing for the period from 7 October, 3.70%, from the fixture.
    { id: 'october-tbill-fixing', covers: 'reset', action: 'rate', code: 'UST3M', value: 3.7, date: '2027-10-05', expect: { events: [] } },
    {
      // Thursday 7 October: the coupon, 92 days at 11.65%: 2,000,000 x 11.65% x 92/360 = 59,544.44. The balance stands at 7 October:
      // 0, so 59,544.44 - 57,602.78 = 1,941.66 more. The next period runs at 3.70% + 7.75% = 11.45%.
      id: 'coupon', covers: ['coupon', 'reset'], action: 'clock', to: EDT('2027-10-07'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 2,000,000 GULF-26-1-A: 59,544.44 USD', cash: { USD: 59_544.44 }, owner: 'account', date: '2027-10-07' },
          { type: 'accrual.coupon', summary: 'Interest accrued on GULF-26-1-A: 1,941.66 USD' },
        ],
        cash: { account: { USD: { settled: 1_020_674, availableToTrade: 1_020_674 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'main', dueDate: '2028-01-07', status: 'pending' }, { type: 'bond.maturity', instrument: 'main', dueDate: '2029-04-09', status: 'pending' }],
        pnl: { account: { couponInterest: 40_775, total: -529_326 } },
        nav: { account: 2_470_674, book: 3_470_674 },
        balance: { account: { cash: 1_020_674, accruedIncome: null, assets: 2_470_674, netAssets: 2_470_674 } },
      },
    },
    {
      // Monday 18 October. End of day Friday 15 Oct: 8 days at 11.45% on 2,000,000 = 5,088.89.
      id: 'loss-report-day', covers: 'accrual', action: 'clock', to: EDT('2027-10-18'),
      expect: {
        events: [{ type: 'accrual.coupon', summary: 'Interest accrued on GULF-26-1-A: 5,088.89 USD' }],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, accrued: 5_088.89 }],
        pnl: { account: { couponInterest: 45_863.89, total: -524_237.11 } },
        nav: { account: 2_475_762.89, book: 3_475_762.89 },
        balance: { account: { accruedIncome: 5_088.89, assets: 2_475_762.89, netAssets: 2_475_762.89 } },
      },
    },
    {
      // The calculation agent's loss report: PCS losses put the class at a 40% principal loss. Recorded by hand: factor 1 to 0.60
      // from 7 October. 2,000,000 x 0.40 = 800,000 of principal lost; cost out 2,020,000 x 0.40 = 808,000: realized loss. The
      // collateral account releases 150,000,000 x 0.40 = 60,000,000 to the sponsor. Interest since 7 October on the lost principal is
      // cancelled: 8 days on 1,200,000 at 11.45% = 3,053.33, 2,035.56 down.
      id: 'covered-event', covers: 'trigger event (by hand)', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'writedown', newFactor: 0.6, kind: 'trigger', effective: '2027-10-07' },
      expect: {
        events: [
          { type: 'bond.trigger', summary: 'Covered event recorded by hand on GULF-26-1-A: factor 1 to 0.6 from 2027-10-07, 800,000 of principal written off with no payment (2,000,000 original face); cost 808,000.00 USD written off as realized loss; 60,000,000.00 USD of collateral released from the collateral account to Harbor Mutual Insurance Company', owner: 'account', date: '2027-10-18' },
          { type: 'accrual.coupon', summary: 'Accrued interest cancelled with the principal written off on GULF-26-1-A: 2,035.56 USD' },
        ],
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, cost: 1_212_000, avgCost: 101, price: 72.5, value: 870_000, unrealized: -342_000, accrued: 3_053.33 }], // 1,200,000 x 72.50 / 100
        pnl: { account: { realized: -808_000, couponInterest: 43_828.33, unrealized: -342_000, total: -1_106_272.67 } },
        nav: { account: 1_893_727.33, book: 2_893_727.33 },
        balance: { account: { accruedIncome: 3_053.33, positions: 870_000, assets: 1_893_727.33, netAssets: 1_893_727.33 } },
      },
    },
    {
      // With the loss known and the season ending, the remaining principal is re-priced at 95.50.
      id: 'repriced', action: 'quote', instrument: 'main', quote: { bid: 95, ask: 96, last: 95.5, bidSize: 5_000_000, askSize: 5_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 2_000_000, price: 95.5, value: 1_146_000, unrealized: -66_000 }], // 1,200,000 x 95.50 / 100
        pnl: { account: { unrealized: -66_000, total: -830_272.67 } },
        nav: { account: 2_169_727.33, book: 3_169_727.33 },
        balance: { account: { positions: 1_146_000, assets: 2_169_727.33, netAssets: 2_169_727.33 } },
      },
    },
    {
      // 1,000,000 original face (600,000 outstanding) sold at 95.00 = 570,000, settling Wednesday 20 October; 13 days at 11.45% on
      // 600,000 = 2,480.83; 0.5 bp = 28.50. Cost out 1,212,000 / 2 = 606,000: realized -36,000.
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 1_000_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_000_000, estimate: 95, settleDate: '2027-10-20', notional: 600_000, gross: 570_000, accrued: 2_480.83, cash: 572_480.83, fees: 28.5 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1_000_000, avgPrice: 95 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 1,000,000 GULF-26-1-A @ 95\.00 USD \(realized [-−]36,000\.00 USD\)$/ }],
        cash: { account: { USD: { settled: 1_020_674, unsettled: 572_452.33, availableToTrade: 1_593_126.33 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, cost: 606_000, avgCost: 101, price: 95.5, value: 573_000, unrealized: -33_000, accrued: 572.5 }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-10-20', amount: 572_452.33, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -844_000, commissions: -129.5, unrealized: -33_000, total: -833_301.17 } },
        nav: { account: 2_166_698.83, book: 3_166_698.83 },
        balance: { account: { receivable: 572_452.33, accruedIncome: 572.5, positions: 573_000, assets: 2_166_698.83, netAssets: 2_166_698.83 } },
      },
    },
    {
      // Wednesday 20 October. End of day 19 Oct: 1,200,000 x 11.45% x 12/360 = 4,580.00, less the 13 days sold 2,480.83: 2,099.17.
      // 1,526.67 more.
      id: 'settle-reduce', covers: ['settlement', 'accrual'], action: 'clock', to: EDT('2027-10-20'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 572,452.33 USD into settled cash', cash: { USD: 572_452.33 } },
          { type: 'accrual.coupon', summary: 'Interest accrued on GULF-26-1-A: 1,526.67 USD' },
        ],
        cash: { account: { USD: { settled: 1_593_126.33, unsettled: 0, availableToTrade: 1_593_126.33 } } },
        positions: [{ instrument: 'main', lot: 'lot', qty: 1_000_000, accrued: 2_099.17 }],
        pending: [],
        pnl: { account: { couponInterest: 45_355, total: -831_774.5 } },
        nav: { account: 2_168_225.5, book: 3_168_225.5 },
        balance: { account: { cash: 1_593_126.33, receivable: null, accruedIncome: 2_099.17, assets: 2_168_225.5, netAssets: 2_168_225.5 } },
      },
    },
    {
      // The rest sold at 95.00 for Friday 22 October: 570,000; 15 days on 600,000 at 11.45% = 2,862.50 (763.33 more than on the
      // books); 0.5 bp = 28.50. Realized 570,000 - 606,000 = -36,000.
      id: 'close', covers: 'close', action: 'close', lot: 'lot', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', qty: 1_000_000, estimate: 95, settleDate: '2027-10-22', notional: 600_000, gross: 570_000, accrued: 2_862.5, cash: 572_862.5, fees: 28.5 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1_000_000, avgPrice: 95 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: /^Sold 1,000,000 GULF-26-1-A @ 95\.00 USD \(realized [-−]36,000\.00 USD\)$/ },
          { type: 'accrual.coupon', summary: 'Interest earned to disposal of GULF-26-1-A: 763.33 USD' },
        ],
        cash: { account: { USD: { settled: 1_593_126.33, unsettled: 572_834, availableToTrade: 2_165_960.33 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-10-22', amount: 572_834, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -880_000, couponInterest: 46_118.33, commissions: -158, unrealized: 0, total: -834_039.67 } },
        nav: { account: 2_165_960.33, book: 3_165_960.33 },
        balance: { account: { cash: 1_593_126.33, receivable: 572_834, positions: null, accruedIncome: null, assets: 2_165_960.33, liabilities: 0, netAssets: 2_165_960.33 } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: EDT('2027-10-22'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 572,834.00 USD into settled cash', cash: { USD: 572_834 } }],
        cash: { account: { USD: { settled: 2_165_960.33, unsettled: 0, availableToTrade: 2_165_960.33 } }, treasury: usdCash(1_000_000) },
        pending: [],
        balance: { account: { cash: 2_165_960.33, receivable: null, assets: 2_165_960.33, liabilities: 0 } },
      },
    },
  ],
};

export default [specifiedPool, absSpec, cmoSpec, cloSpec, cdoSpec, clnSpec, structuredNoteSpec, catBondSpec];
