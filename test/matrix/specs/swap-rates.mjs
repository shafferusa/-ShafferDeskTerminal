// Swap family, rate products (engine family "swap"): interest-rate swaps, overnight-index, basis,
// cross-currency, inflation, constant-maturity and forward-starting swaps, and caps, floors and
// collars. One scenario per product, each on its own fictional contract registered as exactly that
// product, with the legs, schedules, calendars and collateral terms a real contract of it has.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The
// arithmetic is in the comment beside it. Nothing here is copied from what the Terminal prints.
//
// The Terminal's rules these scenarios rely on, restated so the arithmetic can be followed:
//   - A swap is a list of legs. "Enter as written" takes each leg's side as the contract states it;
//     "Enter the opposite side" reverses every leg. Quantity is the notional. A leg's own notional is
//     quantity x its notional factor.
//   - Price is an amount per 100 of notional: the upfront paid by the side that enters as written
//     (premium of a cap or floor, zero for a par swap), and the mark (net present value per 100).
//     The mark is the whole value of the contract, interest accrued so far included: nothing is
//     accrued in the ledger between payment dates, so the balance sheet carries a swap at its mark
//     and shows no accrued line for it. With no mark the position is unpriced and every total that
//     rests on it is provisional.
//   - Periods are rolled back from the maturity date in steps of the leg's frequency. Accrual dates
//     are not adjusted; a payment date that is not a business day of the payment calendar moves to
//     the next one, unless that is in the next month (modified following).
//   - Fixed leg: notional x rate x day-count fraction. Floating leg: notional x (fixing + spread) x
//     fraction, with the fixing of the period's first day (when that day is not a business day of
//     the payment calendar, the fixing of the last business day before it). Only the fixing of
//     exactly that date counts; without it the payment waits, visibly, and is made when it arrives.
//   - Each leg pays on its own (gross): two legs due on one date are two payments.
//   - A position that is increased takes the whole current period on the added notional (the amount
//     paid for the increase is all-in); a termination, in part or in full, is at a stated amount per
//     100 of the notional terminated, all-in, and later payments are on what is left.
//   - Collateral follows the basis the contract states. An independent amount is posted in cash
//     when the position opens and trued up when its notional changes. Variation margin moves in the
//     end-of-day pass (17:00 New York) on the mark: posted when the mark is below minus the
//     threshold, received (restricted cash and a liability) when it is above the threshold, and a
//     transfer smaller than the minimum transfer amount is not made.
//   - Commission is the Book's fee schedule for swaps: an amount per unit of notional.

export const family = 'swap';

/** 10:00 New York as a UTC instant: 15:00 UTC in winter time, 14:00 UTC in daylight time (8 March to 1 November 2026). */
const at = (date, hhmm) => `${date}T${hhmm || ((date >= '2026-03-08' && date < '2026-11-01') || (date >= '2027-03-14' && date < '2027-11-07') || (date >= '2028-03-12' && date < '2028-11-05') ? '14:00' : '15:00')}:00.000Z`;
/** 17:30 New York: after the 17:00 end-of-day cutoff. */
const eod = (date) => at(date, (date >= '2026-03-08' && date < '2026-11-01') || (date >= '2027-03-14' && date < '2027-11-07') || (date >= '2028-03-12' && date < '2028-11-05') ? '21:30' : '22:30');

const FILL = { halfSpreadBps: { swap: 0, equity: 0, manual: 0 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const NO_FEE = { perUnit: 0, minimum: 0, bps: 0 };

const OTC_TICKET = {
  ticket: 'Registry form (Instruments, New instrument) for the contract: legs, schedules, calendars and the required Collateral terms group; then the instrument drawer, Trade tab (Enter as written / Enter the opposite side, Notional, State a fill price); the strategy instance for increase and termination',
  requiredFields: ['Effective date', 'Maturity', 'each leg: Side, Leg type, Currency, rate or index, Payment, Day count', 'Collateral basis', 'Account', 'Action', 'Notional', 'State a fill price (no executable quote exists for an OTC contract)'],
};

// ---------------------------------------------------------------------------------------------
// interest_rate_swap
// ---------------------------------------------------------------------------------------------
// Pay fixed 4.00% semi-annual 30/360, receive 3-month term SOFR flat quarterly ACT/360, one year,
// New York (Federal Reserve) business days, on 10,000,000 then 15,000,000 then 9,000,000.
// Position-level collateral terms: independent amount 2% of notional, variation margin with a
// threshold of 50,000 and a minimum transfer of 10,000.
//
// Schedule (effective Thursday 5 March 2026, maturity Friday 5 March 2027):
//   fixed     2026-03-05 to 2026-09-05 (180 days 30/360), paid Tuesday 8 September: the 5th is a Saturday and Monday the 7th is Labor Day
//             2026-09-05 to 2027-03-05, paid 5 March 2027
//   floating  2026-03-05 to 2026-06-05 (92 days), paid Friday 5 June;      fixing of 5 March
//             2026-06-05 to 2026-09-05 (92 days), paid Tuesday 8 September; fixing of 5 June
//             2026-09-05 to 2026-12-05 (91 days), paid Monday 7 December;   fixing of Friday 4 September (the 5th is a Saturday)
//             2026-12-05 to 2027-03-05 (90 days), paid 5 March 2027
const IRS_NAME = 'USD IRS 4.00% v TSFR3M 5 Mar 2027';
const interestRateSwap = {
  productId: 'interest_rate_swap',
  title: 'USD 1-year swap, pay 4.00% fixed against 3-month term SOFR, position-level collateral terms',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['payment schedule of each leg from the contract terms and the USD payment calendar', 'TSFR3M fixings (rate fixture standing in for Shaffer MarketData)', 'settlement date, T+2 on the USD calendar', 'commission from the Book fee schedule', 'independent amount and variation margin from the position-level terms'],
    manualInputs: ['upfront amount of a new position (stated fill price)', 'mark of the contract, entered by hand (it can be negative)', 'a fixing the data service has not supplied, entered by hand', 'settlement amount of a termination (stated fill price in the preview)'],
    settlement: 'Upfront amount and commission settle T+2 on the USD calendar; leg payments are cash on their payment date',
    lifecycle: 'Fixed and floating payments on their adjusted payment dates; a floating payment whose fixing is missing is blocked until the fixing is supplied; increase; partial and full termination at stated amounts; nothing is scheduled after termination',
    accounting: 'Carried at the mark (per 100 notional) less the upfront amounts paid; leg payments and termination results are realized P&L; commission expensed; no accrual between payment dates (the mark includes it); unpriced and provisional until a mark is entered',
    collateral: 'Position-level terms: independent amount 2% of notional in margin (posted at entry, trued up on increase, returned on termination); variation margin at end of day against the mark, threshold 50,000, minimum transfer 10,000; collateral received is restricted cash with a liability, never spendable',
  },
  start: at('2026-03-03'),
  settlementCheck: { lag: 2, holidays: ['2026-09-07', '2026-10-12', '2027-01-18'] }, // Labor Day, Columbus Day, Martin Luther King Jr. Day (Federal Reserve holidays)
  book: {
    name: 'Matrix interest-rate swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Rates', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.000025, minimum: 0, bps: 0 } }, fill: FILL, settlement: { swap: 2 } }, // 0.25 basis point of notional: 25.00 per million
  },
  instruments: {
    main: {
      productId: 'interest_rate_swap', name: IRS_NAME, symbol: 'IRS-TSFR-0327', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        effective: '2026-03-05', maturity: '2027-03-05', counterparty: 'Dealer A',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: true, threshold: 50_000, minimumTransfer: 10_000 },
        legs: [
          { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' },
          { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0, months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  rates: { TSFR3M: { byDate: { '2026-03-05': 4.30 } } }, // the first period's fixing; later ones arrive (or do not) in the steps
  expectAtStart: {
    cash: {
      account: { USD: { settled: 2_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 2_000_000 } },
      treasury: { USD: { settled: 3_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 3_000_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 2_000_000, treasury: 3_000_000, book: 5_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      // 2% of 120,000,000 is 2,400,000; the Account has 2,000,000.
      id: 'too-large', covers: 'collateral', action: 'ticket', instrument: 'main', side: 'buy', qty: 120_000_000, order: { statedPrice: 0 },
      status: 'blocked', reason: 'The independent amount must be posted from free settled cash when the position opens; it is not there.',
      expect: { refused: /independent amount of 2,400,000\.00 USD on IRS-TSFR-0327 cannot be posted: Rates has 2,000,000\.00 USD of settled USD cash free/ },
    },
    {
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 10_000_000, as: 'swap', order: { statedPrice: 0 }, // a par swap: no upfront amount
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 10_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-03-05', calendar: 'USD',
            cash: 0, // 10,000,000 x 0 / 100
            fees: 250 }], // 10,000,000 x 0.000025
          cash: { USD: { purchases: 0, fees: 250, margin: 200_000, required: 200_250, available: 2_000_000, shortfall: 0 } }, // independent amount 2% x 10,000,000
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000_000, avgPrice: 0, fills: [{ qty: 10_000_000, price: 0, model: 'stated-price', settleDate: '2026-03-05' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered as written: 10,000,000 notional of IRS-TSFR-0327 at 0.00 per 100 notional', owner: 'account', date: '2026-03-03' },
          { type: 'swap.collateral', summary: `Collateral posted on ${IRS_NAME} under its position-level terms: 200,000.00 USD (independent amount, 2.00% of 10,000,000.00 USD notional)`, cash: { USD: -200_000 }, owner: 'account' },
        ],
        // The independent amount leaves settled cash at once; the commission is owed until settlement.
        cash: { account: { USD: { settled: 1_800_000, unsettled: -250, margin: 200_000, restricted: 0, availableToTrade: 1_799_750, availableToWithdraw: 1_799_750 } } },
        positions: [{ instrument: 'main', lot: 'swap', owner: 'account', direction: 'as written', qty: 10_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 10_000_000, margin: 200_000, accrued: 0 }],
        holdings: { main: { long: 10_000_000, short: 0, net: 10_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-03-05', amount: -250, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-06-05', status: 'pending' }, // floating, first quarter
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-08', status: 'pending' }, // fixed, first half-year
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-05', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'swap', owner: 'account', qty: 10_000_000, basis: 'position', mark: null, iaRequired: 200_000, iaPosted: 200_000, vmPosted: 0, vmHeld: 0, vmStatus: 'not_valued_yet' }],
        pnl: { account: { realized: 0, commissions: -250, fees: 0, borrowFunding: 0, couponInterest: 0, unrealized: 0, total: -250 } },
        nav: { account: 1_999_750, book: 4_999_750 },
        provisional: { account: true, book: true }, // no mark: the swap is unpriced
        balance: { account: { cash: 1_800_000, margin: 200_000, payable: 250, positions: null, accruedIncome: null, accruedExpense: null, assets: 2_000_000, liabilities: 250, netAssets: 1_999_750 } },
      },
    },
    {
      // The end-of-day pass for 3 March runs with no mark: no variation margin can be called, and that is said.
      id: 'no-mark-no-call', covers: 'variation margin', action: 'clock', to: at('2026-03-04'),
      expect: { otc: [{ instrument: 'main', vmStatus: 'cannot_value', vmReason: /IRS-TSFR-0327 has no mark/, vmPosted: 0 }], alerts: ['collateral.unvalued'] },
    },
    {
      id: 'mark-negative', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.85, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'swap', qty: 10_000_000, price: -0.85, value: -85_000, unrealized: -85_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }], // 10,000,000 x -0.85 / 100
        otc: [{ instrument: 'main', mark: -0.85, markValue: -85_000 }],
        pnl: { account: { unrealized: -85_000, total: -85_250 } },
        nav: { account: 1_914_750, book: 4_914_750 },
        provisional: { account: false, book: false },
        balance: { account: { positions: -85_000, assets: 1_915_000, liabilities: 250, netAssets: 1_914_750 } },
      },
    },
    {
      // Mark -85,000 is 35,000 beyond the 50,000 threshold: 35,000 is posted (more than the 10,000 minimum transfer).
      id: 'variation-margin-call', covers: 'variation margin', action: 'clock', to: eod('2026-03-04'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 35,000.00 USD posted. Netting set of 1 position marked at -85,000.00 USD; threshold 50,000.00 USD.', cash: { USD: -35_000 }, owner: 'account', date: '2026-03-04' }],
        cash: { account: { USD: { settled: 1_765_000, margin: 235_000, availableToTrade: 1_764_750, availableToWithdraw: 1_764_750 } } },
        otc: [{ instrument: 'main', vmPosted: 35_000, vmHeld: 0, vmExposure: -85_000, vmStatus: 'ok' }],
        alerts: [],
        balance: { account: { cash: 1_765_000, margin: 235_000 } },
      },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-03-05'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 250.00 USD from settled cash', cash: { USD: -250 }, date: '2026-03-05' }],
        cash: { account: { USD: { settled: 1_764_750, unsettled: 0, availableToTrade: 1_764_750, availableToWithdraw: 1_764_750 } } },
        pending: [],
        balance: { account: { cash: 1_764_750, payable: null, assets: 1_914_750, liabilities: 0 } },
      },
    },
    {
      id: 'mark-a-little-lower', action: 'manual_price', instrument: 'main', value: -0.90, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'swap', price: -0.9, value: -90_000, unrealized: -90_000 }],
        otc: [{ instrument: 'main', mark: -0.9, markValue: -90_000 }],
        pnl: { account: { unrealized: -90_000, total: -90_250 } },
        nav: { account: 1_909_750, book: 4_909_750 },
        balance: { account: { positions: -90_000, assets: 1_909_750, netAssets: 1_909_750 } },
      },
    },
    {
      // -90,000 calls for 40,000; 35,000 is posted. The 5,000 difference is below the 10,000 minimum transfer: nothing moves.
      id: 'below-minimum-transfer', covers: 'variation margin', action: 'clock', to: eod('2026-03-05'),
      expect: { events: [], otc: [{ instrument: 'main', vmPosted: 35_000, vmExposure: -90_000, vmStatus: 'ok', vmReason: /5,000\.00 USD would be due\. It is below the minimum transfer amount of 10,000\.00 USD/ }] },
    },
    { id: 'friday-morning', action: 'clock', to: at('2026-03-06'), expect: {} },
    {
      id: 'mark-recovers', action: 'manual_price', instrument: 'main', value: 0.20, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'swap', price: 0.2, value: 20_000, unrealized: 20_000 }],
        otc: [{ instrument: 'main', mark: 0.2, markValue: 20_000 }],
        pnl: { account: { unrealized: 20_000, total: 19_750 } },
        nav: { account: 2_019_750, book: 5_019_750 },
        balance: { account: { positions: 20_000, assets: 2_019_750, netAssets: 2_019_750 } },
      },
    },
    {
      // +20,000 is inside the threshold: nothing is required and the 35,000 comes back.
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-03-06'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 35,000.00 USD returned to us. Netting set of 1 position marked at 20,000.00 USD; threshold 50,000.00 USD.', cash: { USD: 35_000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 1_799_750, margin: 200_000, availableToTrade: 1_799_750, availableToWithdraw: 1_799_750 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 0, vmExposure: 20_000, vmStatus: 'ok', vmReason: null }],
        balance: { account: { cash: 1_799_750, margin: 200_000 } },
      },
    },
    { id: 'monday-morning', action: 'clock', to: at('2026-03-09'), expect: {} },
    {
      // 10,000,000 to 15,000,000 at the mark (0.20 per 100): the added 5,000,000 costs 10,000 and takes the whole current period.
      id: 'increase', covers: ['increase', 'collateral'], action: 'resize', lot: 'swap', factor: 1.5,
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 0.2, model: 'manual-mark', priceSource: 'Manual entry', settleDate: '2026-03-11',
            cash: -10_000, // 5,000,000 x 0.20 / 100
            fees: 125 }], // 5,000,000 x 0.000025
          cash: { USD: { purchases: 10_000, fees: 125, margin: 100_000, required: 110_125, available: 1_799_750, shortfall: 0 } }, // 2% x 15,000,000 = 300,000, less the 200,000 posted
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 5_000_000, avgPrice: 0.2, fills: [{ qty: 5_000_000, price: 0.2, model: 'manual-mark', settleDate: '2026-03-11', source: 'Manual entry', status: 'manual' }] }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Increased as written: 5,000,000 notional of IRS-TSFR-0327 at 0.20 per 100 notional' },
          { type: 'swap.collateral', summary: `Collateral posted on ${IRS_NAME} under its position-level terms: 100,000.00 USD (independent amount, 2.00% of 15,000,000.00 USD notional)`, cash: { USD: -100_000 } },
        ],
        cash: { account: { USD: { settled: 1_699_750, unsettled: -10_125, margin: 300_000, availableToTrade: 1_689_625, availableToWithdraw: 1_689_625 } } },
        positions: [{ instrument: 'main', lot: 'swap', qty: 15_000_000, cost: 10_000, avgCost: 0.0666667, // 10,000 / (15,000,000 / 100)
          price: 0.2, value: 30_000, // 15,000,000 x 0.20 / 100
          unrealized: 20_000, notional: 15_000_000, margin: 300_000 }],
        holdings: { main: { long: 15_000_000, short: 0, net: 15_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-03-11', amount: -10_125, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 15_000_000, markValue: 30_000, iaRequired: 300_000, iaPosted: 300_000 }],
        pnl: { account: { commissions: -375, unrealized: 20_000, total: 19_625 } },
        nav: { account: 2_019_625, book: 5_019_625 },
        balance: { account: { cash: 1_699_750, margin: 300_000, positions: 30_000, payable: 10_125, assets: 2_029_750, liabilities: 10_125, netAssets: 2_019_625 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-03-11'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 10,125.00 USD from settled cash', cash: { USD: -10_125 } }],
        cash: { account: { USD: { settled: 1_689_625, unsettled: 0, availableToTrade: 1_689_625, availableToWithdraw: 1_689_625 } } },
        pending: [],
        balance: { account: { cash: 1_689_625, payable: null, assets: 2_019_625, liabilities: 0 } },
      },
    },
    {
      id: 'mark-high', action: 'manual_price', instrument: 'main', value: 0.75, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'swap', price: 0.75, value: 112_500, unrealized: 102_500 }], // 15,000,000 x 0.75 / 100, less the 10,000 paid
        otc: [{ instrument: 'main', mark: 0.75, markValue: 112_500 }],
        pnl: { account: { unrealized: 102_500, total: 102_125 } },
        nav: { account: 2_102_125, book: 5_102_125 },
        balance: { account: { positions: 112_500, assets: 2_102_125, netAssets: 2_102_125 } },
      },
    },
    {
      // +112,500 is 62,500 beyond the threshold: the counterparty posts 62,500. It is restricted cash and a liability.
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-03-11'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 62,500.00 USD received. Netting set of 1 position marked at 112,500.00 USD; threshold 50,000.00 USD.', owner: 'account' }],
        cash: { account: { USD: { settled: 1_689_625, restricted: 62_500, margin: 300_000, availableToTrade: 1_689_625, availableToWithdraw: 1_689_625 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 62_500, vmExposure: 112_500, vmStatus: 'ok' }],
        nav: { account: 2_102_125, book: 5_102_125 }, // unchanged: the cash received is owed back
        balance: { account: { restricted: 62_500, collateralReceived: 62_500, assets: 2_164_625, liabilities: 62_500, netAssets: 2_102_125 } },
      },
    },
    {
      // Settled 1,689,625 plus the 62,500 held would cover 1,700,000. It is refused: collateral received is not the Account's to move.
      id: 'spend-collateral-received', covers: 'variation margin', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 1_700_000,
      status: 'blocked', reason: 'Cash collateral received from the counterparty is restricted: it is owed back and cannot be spent or moved.',
      expect: { refused: 'Rates has 1,689,625.00 USD of settled USD available; 1,700,000.00 USD requested' },
    },
    { id: 'thursday-morning', action: 'clock', to: at('2026-03-12'), expect: {} },
    {
      id: 'mark-falls-back', action: 'manual_price', instrument: 'main', value: 0.10, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'swap', price: 0.1, value: 15_000, unrealized: 5_000 }],
        otc: [{ instrument: 'main', mark: 0.1, markValue: 15_000 }],
        pnl: { account: { unrealized: 5_000, total: 4_625 } },
        nav: { account: 2_004_625, book: 5_004_625 },
        balance: { account: { positions: 15_000, assets: 2_067_125, netAssets: 2_004_625 } }, // cash 1,689,625 + restricted 62,500 + margin 300,000 + 15,000
      },
    },
    {
      id: 'collateral-given-back', covers: 'variation margin', action: 'clock', to: eod('2026-03-12'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 62,500.00 USD returned to the counterparty. Netting set of 1 position marked at 15,000.00 USD; threshold 50,000.00 USD.', owner: 'account' }],
        cash: { account: { USD: { settled: 1_689_625, restricted: 0, margin: 300_000, availableToTrade: 1_689_625 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 0, vmExposure: 15_000 }],
        balance: { account: { restricted: null, collateralReceived: null, assets: 2_004_625, liabilities: 0, netAssets: 2_004_625 } },
      },
    },
    {
      // First floating payment, received: 15,000,000 x 4.30% x 92/360 = 164,833.33 (the fixing of 5 March).
      id: 'first-floating-payment', covers: 'floating payment', action: 'clock', to: at('2026-06-05'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${IRS_NAME}, leg B (float), period 2026-03-05 to 2026-06-05: 164,833.33 USD`, cash: { USD: 164_833.33 }, owner: 'account', date: '2026-06-05' }],
        cash: { account: { USD: { settled: 1_854_458.33, availableToTrade: 1_854_458.33, availableToWithdraw: 1_854_458.33 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-08', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-08', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-05', status: 'pending' },
        ],
        pnl: { account: { realized: 164_833.33, total: 169_458.33 } }, // -375 + 164,833.33 + 5,000
        nav: { account: 2_169_458.33, book: 5_169_458.33 },
        balance: { account: { cash: 1_854_458.33, accruedIncome: null, accruedExpense: null, assets: 2_169_458.33, netAssets: 2_169_458.33 } },
      },
    },
    {
      // Tuesday 8 September (Monday was Labor Day). Fixed, paid: 15,000,000 x 4.00% x 180/360 = 300,000.00.
      // The floating payment of the same date needs the fixing of 5 June, which has not been supplied: it waits.
      id: 'fixed-paid-floating-blocked', covers: ['fixed payment', 'missing fixing', 'payment across a holiday'], action: 'clock', to: at('2026-09-08'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${IRS_NAME}, leg A (fixed), period 2026-03-05 to 2026-09-05: 300,000.00 USD`, cash: { USD: -300_000 }, owner: 'account', date: '2026-09-08' }],
        cash: { account: { USD: { settled: 1_554_458.33, availableToTrade: 1_554_458.33, availableToWithdraw: 1_554_458.33 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-08', status: 'blocked', reason: /Awaiting the TSFR3M fixing for 2026-06-05/ },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-05', status: 'pending' },
        ],
        pnl: { account: { realized: -135_166.67, total: -130_541.67 } }, // 164,833.33 - 300,000; then - 375 + 5,000
        nav: { account: 1_869_458.33, book: 4_869_458.33 },
        balance: { account: { cash: 1_554_458.33, assets: 1_869_458.33, netAssets: 1_869_458.33 } },
      },
    },
    {
      // The fixing is entered by hand: 4.10% for 5 June. The payment is made: 15,000,000 x 4.10% x 92/360 = 157,166.67.
      // Net of the two legs for the half-year to 5 September: 157,166.67 - 300,000.00 = -142,833.33.
      id: 'fixing-entered-by-hand', covers: ['missing fixing', 'floating payment'], action: 'manual_rate', code: 'TSFR3M', value: 4.10, date: '2026-06-05', note: 'Published fixing, entered by hand',
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${IRS_NAME}, leg B (float), period 2026-06-05 to 2026-09-05: 157,166.67 USD`, cash: { USD: 157_166.67 }, owner: 'account', date: '2026-09-08' }],
        cash: { account: { USD: { settled: 1_711_625, availableToTrade: 1_711_625, availableToWithdraw: 1_711_625 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-07', status: 'pending' }, // 5 December is a Saturday
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-05', status: 'pending' },
        ],
        pnl: { account: { realized: 22_000, total: 26_625 } }, // -135,166.67 + 157,166.67; then - 375 + 5,000
        nav: { account: 2_026_625, book: 5_026_625 },
        balance: { account: { cash: 1_711_625, assets: 2_026_625, netAssets: 2_026_625 } },
      },
    },
    // The third floating period starts on Saturday 5 September: its fixing is Friday 4 September's.
    { id: 'september-fixing', action: 'rate', code: 'TSFR3M', value: 3.95, date: '2026-09-04', expect: {} },
    { id: 'mid-october', action: 'clock', to: at('2026-10-15'), expect: {} },
    {
      // 40% of 15,000,000 is terminated at a settlement amount of 0.35 per 100, received: 6,000,000 x 0.35 / 100 = 21,000.
      // Cost removed at the average: 10,000 x 6/15 = 4,000. Realized 17,000. Settles Monday 19 October (T+2).
      id: 'partial-termination', covers: ['reduce', 'partial termination', 'collateral'], action: 'close', lot: 'swap', scope: 'strategy', percent: 40, order: { statedPrice: 0.35 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 6_000_000, estimate: 0.35, model: 'stated-price', settleDate: '2026-10-19', cash: 21_000, fees: 150 }] }, // 6,000,000 x 0.000025
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 6_000_000, avgPrice: 0.35, fills: [{ qty: 6_000_000, price: 0.35, model: 'stated-price', settleDate: '2026-10-19' }] }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated in part: 6,000,000 of 15,000,000 notional of IRS-TSFR-0327 at 0.35 per 100 notional (realized 17,000.00 USD)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${IRS_NAME} under its position-level terms: 120,000.00 USD (independent amount, 2.00% of 9,000,000.00 USD notional)`, cash: { USD: 120_000 } }, // 300,000 - 2% x 9,000,000
        ],
        cash: { account: { USD: { settled: 1_831_625, unsettled: 20_850, margin: 180_000, availableToTrade: 1_852_475, availableToWithdraw: 1_831_625 } } }, // 21,000 - 150 owed to the Account
        positions: [{ instrument: 'main', lot: 'swap', qty: 9_000_000, cost: 6_000, avgCost: 0.0666667, price: 0.1, value: 9_000, unrealized: 3_000, notional: 9_000_000, margin: 180_000 }],
        holdings: { main: { long: 9_000_000, short: 0, net: 9_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-10-19', amount: 20_850, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 9_000_000, markValue: 9_000, iaRequired: 180_000, iaPosted: 180_000 }],
        pnl: { account: { realized: 39_000, commissions: -525, unrealized: 3_000, total: 41_475 } },
        nav: { account: 2_041_475, book: 5_041_475 },
        balance: { account: { cash: 1_831_625, margin: 180_000, receivable: 20_850, positions: 9_000, assets: 2_041_475, liabilities: 0, netAssets: 2_041_475 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2026-10-19'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 20,850.00 USD into settled cash', cash: { USD: 20_850 } }],
        cash: { account: { USD: { settled: 1_852_475, unsettled: 0, availableToTrade: 1_852_475, availableToWithdraw: 1_852_475 } } },
        pending: [],
        balance: { account: { cash: 1_852_475, receivable: null } },
      },
    },
    {
      // Monday 7 December (the 5th is a Saturday). On the 9,000,000 left: 9,000,000 x 3.95% x 91/360 = 89,862.50.
      id: 'third-floating-payment', covers: 'floating payment', action: 'clock', to: at('2026-12-07'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${IRS_NAME}, leg B (float), period 2026-09-05 to 2026-12-05: 89,862.50 USD`, cash: { USD: 89_862.50 }, date: '2026-12-07' }],
        cash: { account: { USD: { settled: 1_942_337.50, availableToTrade: 1_942_337.50, availableToWithdraw: 1_942_337.50 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-05', status: 'pending' },
        ],
        pnl: { account: { realized: 128_862.50, total: 131_337.50 } }, // 39,000 + 89,862.50; then - 525 + 3,000
        nav: { account: 2_131_337.50, book: 5_131_337.50 },
        balance: { account: { cash: 1_942_337.50, assets: 2_131_337.50, netAssets: 2_131_337.50 } },
      },
    },
    { id: 'mid-january', action: 'clock', to: at('2027-01-15'), expect: {} },
    {
      // The rest is terminated at -0.15 per 100, paid: 9,000,000 x 0.15 / 100 = 13,500. With the 6,000 of cost left, realized -19,500.
      // Friday 15 January, T+2 across Martin Luther King Jr. Day (Monday 18th): settles Wednesday 20 January.
      id: 'full-termination', covers: ['close', 'full termination', 'collateral', 'settlement across a holiday'], action: 'close', lot: 'swap', scope: 'position', percent: 100, order: { statedPrice: -0.15 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 9_000_000, estimate: -0.15, model: 'stated-price', settleDate: '2027-01-20', cash: -13_500, fees: 225 }] }, // 9,000,000 x 0.000025
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 9_000_000, avgPrice: -0.15 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated: 9,000,000 notional of IRS-TSFR-0327 at -0.15 per 100 notional (realized -19,500.00 USD)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${IRS_NAME} under its position-level terms: 180,000.00 USD (independent amount, the position ended)`, cash: { USD: 180_000 } },
        ],
        cash: { account: { USD: { settled: 2_122_337.50, unsettled: -13_725, margin: 0, restricted: 0, availableToTrade: 2_108_612.50, availableToWithdraw: 2_108_612.50 } } }, // 13,500 + 225 owed
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-01-20', amount: -13_725, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 109_362.50, commissions: -750, unrealized: 0, total: 108_612.50 } }, // 128,862.50 - 19,500
        nav: { account: 2_108_612.50, book: 5_108_612.50 },
        balance: { account: { cash: 2_122_337.50, margin: null, positions: null, payable: 13_725, assets: 2_122_337.50, liabilities: 13_725, netAssets: 2_108_612.50 } },
      },
    },
    {
      id: 'settle-full-termination', covers: 'settlement', action: 'clock', to: at('2027-01-20'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 13,725.00 USD from settled cash', cash: { USD: -13_725 } }],
        cash: { account: { USD: { settled: 2_108_612.50, unsettled: 0, availableToTrade: 2_108_612.50, availableToWithdraw: 2_108_612.50 } } },
        pending: [],
        balance: { account: { cash: 2_108_612.50, payable: null, assets: 2_108_612.50, liabilities: 0, netAssets: 2_108_612.50 } },
      },
    },
    {
      // The contract's own maturity date: the position is gone, so nothing is paid, scheduled, posted or accrued.
      // 2,000,000 + 164,833.33 - 300,000 + 157,166.67 + 89,862.50 - 10,000 + 21,000 - 13,500 - 750 = 2,108,612.50.
      id: 'nothing-left-at-maturity', covers: 'close', action: 'clock', to: at('2027-03-05'),
      expect: {
        events: [], lifecycle: [], positions: [], pending: [], otc: [], alerts: [],
        cash: { account: { USD: { settled: 2_108_612.50, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 2_108_612.50 } }, treasury: { USD: { settled: 3_000_000 } } },
        nav: { account: 2_108_612.50, treasury: 3_000_000, book: 5_108_612.50 },
      },
    },
  ],
};

export default [interestRateSwap];
