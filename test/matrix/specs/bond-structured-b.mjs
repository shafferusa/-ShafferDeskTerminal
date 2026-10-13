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

export default [specifiedPool, absSpec];
