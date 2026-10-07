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


// ---------------------------------------------------------------------------------------------
// ois
// ---------------------------------------------------------------------------------------------
// A one-month sterling overnight-index swap, entered on the opposite side: the contract is written
// as "pay 3.80% fixed, receive compounded SONIA", so this Account receives the fixed amount and
// pays the compounded overnight amount, once, at maturity. Both legs ACT/365, London business days.
//
// The Terminal's definition of the compounded leg, checked by hand below: for each business day d
// of the payment calendar from the effective date up to (not including) the maturity date, the
// fixing of d applies for the n calendar days to the next business day (or to maturity);
//     growth = product of (1 + fixing(d) x n / 365)        (365 for an ACT/365 leg, otherwise 360)
//     amount = notional x (growth - 1)  + notional x spread x day-count fraction
// Every business day needs its own fixing. A day whose fixing is missing blocks the payment.
//
// 5 March to 7 April 2026 (33 days; 3 April is Good Friday and 6 April Easter Monday in London):
//   3.72% on 5, 9, 10, 11, 12, 16, 17 and 18 March (1 day each) and on 6 and 13 March (Fridays, 3 days each)
//   3.47% on 19, 23, 24, 25, 26, 30 and 31 March and 1 April (1 day each), on 20 March (3 days) and 2 April (5 days)
//   27 March (3 days): not supplied by the data service; entered by hand as 3.46% when the payment is blocked
//   growth = (1 + 0.0372/365)^8 x (1 + 3 x 0.0372/365)^2 x (1 + 0.0347/365)^8 x (1 + 3 x 0.0347/365) x (1 + 3 x 0.0346/365) x (1 + 5 x 0.0347/365)
//          = 1.0014277325 x 1.0018068797 = 1.0032371920
//   compounded amount = 40,000,000 x 0.0032371920 = 129,487.68      (simple interest would be 129,293.15)
//   fixed amount      = 40,000,000 x 3.80% x 33/365 = 137,424.66
//
// Collateral: a bilateral agreement in the Book. Independent amount 0.50% of notional, variation margin
// with no threshold and a 25,000 minimum transfer, base currency GBP, collateral in USD cash at a 2%
// haircut. One USD of collateral is worth (1 / GBPUSD) x 0.98 in GBP: 0.784 at 1.25, 0.98/1.27 at 1.27.
// Reporting currency USD: sterling balances at the current GBP/USD fixture; ledger entries keep the
// rate of the day they were posted, and the difference is the FX effect.
const OIS_NAME = 'GBP OIS 3.80% v SONIA 7 Apr 2026';
const OIS_DRAFT = {
  productId: 'ois', name: OIS_NAME, symbol: 'OIS-SONIA-0426', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'GB', tradingCcy: 'GBP', multiplier: 0.01,
  conventions: { tradingCalendar: 'UK', settlementCalendar: 'UK', paymentCalendar: 'UK' },
  terms: {
    effective: '2026-03-05', maturity: '2026-04-07', counterparty: 'Dealer B',
    collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' },
    legs: [
      { side: 'pay', type: 'fixed', ccy: 'GBP', rate: 0.038, months: 0, dayCount: 'ACT/365' },
      { side: 'receive', type: 'ois', ccy: 'GBP', index: 'SONIA', spread: 0, months: 0, dayCount: 'ACT/365' },
    ],
  },
};
const SONIA = Object.fromEntries([
  ...['2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-16', '2026-03-17', '2026-03-18'].map((d) => [d, 3.72]),
  ...['2026-03-19', '2026-03-20', '2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', /* 27 March is missing */ '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02'].map((d) => [d, 3.47]),
]);
const overnightIndexSwap = {
  productId: 'ois',
  title: 'GBP 1-month overnight-index swap, receive 3.80% fixed against compounded SONIA, under a collateral agreement',
  matrix: {
    ...OTC_TICKET,
    ticket: `${OTC_TICKET.ticket}; the agreement is recorded first under Treasury, Collateral`,
    automaticInputs: ['daily SONIA fixings (rate fixture standing in for Shaffer MarketData)', 'compounding over London business days', 'GBP/USD rate (FX fixture) for reporting-currency figures and for collateral in USD', 'settlement date, T+2 on the UK calendar', 'independent amount and variation margin from the agreement'],
    manualInputs: ['the agreement itself (counterparty, amounts, currencies, haircut)', 'upfront amount (stated fill price)', 'mark of the contract, entered by hand', 'the one daily fixing the data service did not supply, entered by hand'],
    settlement: 'Upfront amount settles T+2 on the UK calendar; both legs pay once, at maturity',
    lifecycle: 'Fixed and compounded overnight amounts at maturity; the compounded payment is blocked while one daily fixing is missing, and maturity waits for it; the position ends at maturity and its collateral is returned',
    accounting: 'GBP contract in a USD Book: realized P&L at the rate of the payment date, unrealized at the current rate, FX effect on sterling balances; carried at the mark; the upfront amount received is realized at maturity',
    collateral: 'Agreement "CSA Dealer B": independent amount 0.50% of notional and variation margin (no threshold, minimum transfer 25,000 GBP), posted in USD cash at a 2% haircut; the independent amount is trued up when GBP/USD moves; everything is returned at maturity',
  },
  start: at('2026-03-03'),
  settlementCheck: { lag: 2, holidays: [] }, // London: no holiday between 3 and 5 March 2026
  book: {
    name: 'Matrix overnight-index swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }, { ccy: 'GBP', amount: 2_000_000 }],
    account: { name: 'Sterling', funding: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'GBP', amount: 500_000 }] },
    settings: { fees: { swap: NO_FEE }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {
    // The same contract with no collateral basis chosen: the Terminal must refuse to open it.
    bare: { ...OIS_DRAFT, name: 'GBP OIS 3.80% v SONIA 7 Apr 2026, no collateral terms', symbol: 'OIS-SONIA-BARE', terms: { ...OIS_DRAFT.terms, collateralBasis: undefined } },
  },
  fx: { 'GBP/USD': 1.25 },
  rates: { SONIA: { currency: 'GBP', byDate: SONIA } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 1_000_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 1_000_000 }, GBP: { settled: 500_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 500_000 } },
      treasury: { USD: { settled: 2_000_000 }, GBP: { settled: 1_500_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 1_625_000, treasury: 3_875_000, book: 5_500_000 }, // 500,000 and 1,500,000 GBP at 1.25
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      id: 'no-collateral-terms', covers: 'collateral', action: 'ticket', instrument: 'bare', side: 'sell', qty: 40_000_000, order: { statedPrice: 0 },
      status: 'blocked', reason: 'A contract that states no collateral basis cannot be opened: nothing is assumed from the product.',
      expect: { refused: /OIS-SONIA-BARE states no collateral terms\. Choose a collateral agreement, enter position-level terms, or choose "Uncollateralized \(paper assumption\)"/ },
    },
    {
      id: 'record-agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer B', counterparty: 'Dealer B', kind: 'bilateral', covers: ['account'], independentAmount: { type: 'pct', pct: 0.005 }, variationMargin: true, threshold: 0, minimumTransfer: 25_000, baseCcy: 'GBP', postingCcy: 'USD', haircut: 0.02, nettingScope: 'position' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer B with Dealer B (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    { id: 'register-under-agreement', covers: 'registration', action: 'register_instrument', as: 'main', draft: OIS_DRAFT, expect: {} },
    {
      // Opposite side at 0.0125 per 100: the upfront 40,000,000 x 0.0125 / 100 = 5,000 GBP is received.
      // Independent amount: 0.50% x 40,000,000 = 200,000 GBP of value; in USD at a 2% haircut: 200,000 / 0.784 = 255,102.04.
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'sell', qty: 40_000_000, as: 'ois', order: { statedPrice: 0.0125 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 40_000_000, estimate: 0.0125, model: 'stated-price', settleDate: '2026-03-05', calendar: 'UK', cash: 5_000, fees: 0 }],
          cash: { GBP: { proceeds: 5_000, fees: 0, shortfall: 0 }, USD: { margin: 255_102.04, required: 255_102.04, available: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 40_000_000, avgPrice: 0.0125, fills: [{ qty: 40_000_000, price: 0.0125, model: 'stated-price', settleDate: '2026-03-05' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered on the opposite side: 40,000,000 notional of OIS-SONIA-0426 at 0.0125 per 100 notional', owner: 'account', date: '2026-03-03' },
          { type: 'swap.collateral', summary: `Collateral posted on ${OIS_NAME} under "CSA Dealer B" (Dealer B): 255,102.04 USD (independent amount, 0.50% of 40,000,000.00 GBP notional)`, cash: { USD: -255_102.04 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 744_897.96, margin: 255_102.04, availableToTrade: 744_897.96 }, GBP: { settled: 500_000, unsettled: 5_000, availableToTrade: 505_000 } } },
        positions: [{ instrument: 'main', lot: 'ois', owner: 'account', direction: 'opposite side', qty: -40_000_000, avgCost: 0.0125, cost: -5_000, price: null, value: null, unrealized: null, provisional: true, notional: 40_000_000 }],
        holdings: { main: { long: 0, short: 40_000_000, net: -40_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-03-05', amount: 5_000, ccy: 'GBP', into: 'cash' }],
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-04-07', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-04-07', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-04-07', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'ois', owner: 'account', qty: -40_000_000, basis: 'agreement', agreement: 'CSA Dealer B', iaRequired: 255_102.04, iaPosted: 255_102.04, iaCcy: 'USD', vmPosted: 0, vmHeld: 0, vmStatus: 'not_valued_yet' }],
        pnl: { account: { realized: 0, commissions: 0, unrealized: 0, fx: 0, total: 0 } },
        nav: { account: 1_625_000, book: 5_500_000 }, // unpriced: carried at cost, the upfront receivable against it
        provisional: { account: true, book: true },
        // USD: 744,897.96 cash and 255,102.04 posted. GBP at 1.25: cash 500,000 (625,000), receivable 5,000 (6,250), position at cost -5,000 (-6,250).
        balance: { account: { cash: 1_369_897.96, margin: 255_102.04, receivable: 6_250, positions: -6_250, assets: 1_625_000, liabilities: 0, netAssets: 1_625_000 } },
      },
    },
    {
      // 40,000,000 to 50,000,000 on the same terms: 1,250 GBP more is received up front (10,000,000 x 0.0125 / 100).
      // Independent amount: 0.50% x 50,000,000 = 250,000 GBP of value = 318,877.55 USD; 63,775.51 more is posted.
      id: 'increase', covers: ['increase', 'collateral'], action: 'resize', lot: 'ois', factor: 1.25, order: { statedPrice: 0.0125 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 10_000_000, estimate: 0.0125, model: 'stated-price', settleDate: '2026-03-05', cash: 1_250, fees: 0 }],
          cash: { GBP: { proceeds: 1_250, shortfall: 0 }, USD: { margin: 63_775.51, required: 63_775.51, available: 744_897.96, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 10_000_000, avgPrice: 0.0125 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Increased on the opposite side: 10,000,000 notional of OIS-SONIA-0426 at 0.0125 per 100 notional' },
          { type: 'swap.collateral', summary: `Collateral posted on ${OIS_NAME} under "CSA Dealer B" (Dealer B): 63,775.51 USD (independent amount, 0.50% of 50,000,000.00 GBP notional)`, cash: { USD: -63_775.51 } },
        ],
        cash: { account: { USD: { settled: 681_122.45, margin: 318_877.55, availableToTrade: 681_122.45 }, GBP: { settled: 500_000, unsettled: 6_250, availableToTrade: 506_250 } } },
        positions: [{ instrument: 'main', lot: 'ois', qty: -50_000_000, avgCost: 0.0125, cost: -6_250, notional: 50_000_000 }],
        holdings: { main: { long: 0, short: 50_000_000, net: -50_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-05', amount: 1_250, ccy: 'GBP', into: 'cash' }, { instrument: 'main', dueDate: '2026-03-05', amount: 5_000, ccy: 'GBP', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -50_000_000, iaRequired: 318_877.55, iaPosted: 318_877.55 }],
        balance: { account: { cash: 1_306_122.45, margin: 318_877.55, receivable: 7_812.50, positions: -7_812.50, assets: 1_625_000, netAssets: 1_625_000 } }, // 681,122.45 + 625,000; 6,250 GBP at 1.25
      },
    },
    {
      // A fifth of the 50,000,000 is terminated at the same 0.0125: 1,250 GBP is paid back, nothing is realized,
      // and the independent amount returns to 255,102.04 USD.
      id: 'reduce', covers: ['reduce', 'partial termination', 'collateral'], action: 'close', lot: 'ois', scope: 'strategy', percent: 20, order: { statedPrice: 0.0125 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 10_000_000, estimate: 0.0125, model: 'stated-price', settleDate: '2026-03-05', cash: -1_250, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 10_000_000, avgPrice: 0.0125 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated in part: 10,000,000 of 50,000,000 notional of OIS-SONIA-0426 at 0.0125 per 100 notional (realized 0.00 GBP)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${OIS_NAME} under "CSA Dealer B" (Dealer B): 63,775.51 USD (independent amount, 0.50% of 40,000,000.00 GBP notional)`, cash: { USD: 63_775.51 } },
        ],
        cash: { account: { USD: { settled: 744_897.96, margin: 255_102.04, availableToTrade: 744_897.96 }, GBP: { settled: 500_000, unsettled: 5_000, availableToTrade: 505_000 } } },
        positions: [{ instrument: 'main', lot: 'ois', qty: -40_000_000, avgCost: 0.0125, cost: -5_000, notional: 40_000_000 }],
        holdings: { main: { long: 0, short: 40_000_000, net: -40_000_000 } },
        pending: [
          { instrument: 'main', dueDate: '2026-03-05', amount: -1_250, ccy: 'GBP', into: 'cash' },
          { instrument: 'main', dueDate: '2026-03-05', amount: 1_250, ccy: 'GBP', into: 'cash' },
          { instrument: 'main', dueDate: '2026-03-05', amount: 5_000, ccy: 'GBP', into: 'cash' },
        ],
        otc: [{ instrument: 'main', qty: -40_000_000, iaRequired: 255_102.04, iaPosted: 255_102.04 }],
        pnl: { account: { realized: 0, total: 0 } },
        balance: { account: { cash: 1_369_897.96, margin: 255_102.04, receivable: 7_812.50, payable: 1_562.50, positions: -6_250, assets: 1_626_562.50, liabilities: 1_562.50, netAssets: 1_625_000 } },
      },
    },
    {
      id: 'no-mark-no-call', covers: 'variation margin', action: 'clock', to: at('2026-03-04'),
      expect: { otc: [{ instrument: 'main', vmStatus: 'cannot_value', vmPosted: 0 }], alerts: ['collateral.unvalued'] },
    },
    {
      // The mark is of the contract as written. On the opposite side its value is -40,000,000 x 0.10 / 100 = -40,000 GBP;
      // against the 5,000 received up front, unrealized -35,000 GBP = -43,750 USD at 1.25.
      id: 'mark-against-us', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.10, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'ois', qty: -40_000_000, price: 0.1, value: -40_000, unrealized: -35_000, provisional: false, priceSource: 'Manual entry' }],
        otc: [{ instrument: 'main', mark: 0.1, markValue: -40_000 }],
        pnl: { account: { unrealized: -43_750, total: -43_750 } },
        nav: { account: 1_581_250, book: 5_456_250 },
        provisional: { account: false, book: false },
        balance: { account: { positions: -50_000, assets: 1_582_812.50, liabilities: 1_562.50, netAssets: 1_581_250 } }, // (-5,000 - 35,000) x 1.25
      },
    },
    {
      // -40,000 GBP with no threshold calls for 40,000 GBP of value: 40,000 / 0.784 = 51,020.41 USD.
      id: 'variation-margin-call', covers: 'variation margin', action: 'clock', to: eod('2026-03-04'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer B" (Dealer B): 51,020.41 USD posted. Netting set of 1 position marked at -40,000.00 GBP; threshold 0.00 GBP.', cash: { USD: -51_020.41 }, owner: 'account', date: '2026-03-04' }],
        cash: { account: { USD: { settled: 693_877.55, margin: 306_122.45, availableToTrade: 693_877.55 } } },
        otc: [{ instrument: 'main', vmPosted: 51_020.41, vmCcy: 'USD', vmExposure: -40_000, vmStatus: 'ok' }],
        alerts: [],
        balance: { account: { cash: 1_318_877.55, margin: 306_122.45 } }, // 693,877.55 + 625,000
      },
    },
    {
      id: 'settle-upfront', covers: 'settlement', action: 'clock', to: at('2026-03-05'),
      expect: {
        // The three upfront amounts settle: 5,000 and 1,250 received, 1,250 paid.
        events: [
          { type: 'settlement.receive', summary: 'received 5,000.00 GBP into settled cash', cash: { GBP: 5_000 }, date: '2026-03-05' },
          { type: 'settlement.receive', summary: 'received 1,250.00 GBP into settled cash', cash: { GBP: 1_250 } },
          { type: 'settlement.pay', summary: 'paid 1,250.00 GBP from settled cash', cash: { GBP: -1_250 } },
        ],
        cash: { account: { GBP: { settled: 505_000, unsettled: 0, availableToTrade: 505_000 } } },
        pending: [],
        balance: { account: { cash: 1_325_127.55, receivable: null, payable: null, assets: 1_581_250, liabilities: 0 } }, // 693,877.55 + 505,000 x 1.25
      },
    },
    {
      // Sterling rises to 1.27. Sterling net assets of the Account: 505,000 cash - 5,000 position cost - 35,000 unrealized = 465,000.
      // 1,000,000 + 465,000 x 1.27 = 1,590,550. FX effect on the booked balances: (505,000 - 5,000) x (1.27 - 1.25) = 10,000.
      id: 'sterling-rises', covers: 'reporting currency', action: 'fx_rate', pair: 'GBP/USD', rate: 1.27,
      expect: {
        pnl: { account: { unrealized: -44_450, fx: 10_000, total: -34_450 } }, // -35,000 x 1.27
        nav: { account: 1_590_550, treasury: 3_905_000, book: 5_495_550 }, // Treasury: 2,000,000 + 1,500,000 x 1.27
        balance: { account: { cash: 1_335_227.55, positions: -50_800, assets: 1_590_550, netAssets: 1_590_550 } }, // 693,877.55 + 505,000 x 1.27; -40,000 x 1.27
      },
    },
    {
      // At 1.27 one USD of collateral is worth 0.98 / 1.27 GBP. Independent amount: 200,000 x 1.27 / 0.98 = 259,183.67 USD; 4,081.63 more is posted.
      // Variation margin: the 51,020.41 held is now worth 39,370.08 GBP against 40,000 required; 629.92 is below the minimum transfer.
      id: 'independent-amount-trued-up', covers: 'collateral', action: 'clock', to: eod('2026-03-05'),
      expect: {
        events: [{ type: 'swap.collateral', summary: `Collateral posted on ${OIS_NAME} under "CSA Dealer B" (Dealer B): 4,081.63 USD (independent amount, 0.50% of 40,000,000.00 GBP notional)`, cash: { USD: -4_081.63 }, owner: 'account' }],
        cash: { account: { USD: { settled: 689_795.92, margin: 310_204.08, availableToTrade: 689_795.92 } } },
        otc: [{ instrument: 'main', iaRequired: 259_183.67, iaPosted: 259_183.67, vmPosted: 51_020.41, vmReason: /629\.92 GBP would be due\. It is below the minimum transfer amount of 25,000\.00 GBP/ }],
        balance: { account: { cash: 1_331_145.92, margin: 310_204.08 } },
      },
    },
    { id: 'friday-morning', action: 'clock', to: at('2026-03-06'), expect: {} },
    {
      id: 'mark-improves', action: 'manual_price', instrument: 'main', value: 0.02, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'ois', price: 0.02, value: -8_000, unrealized: -3_000 }], // -40,000,000 x 0.02 / 100, less the -5,000 cost
        otc: [{ instrument: 'main', mark: 0.02, markValue: -8_000 }],
        pnl: { account: { unrealized: -3_810, fx: 10_000, total: 6_190 } }, // -3,000 x 1.27
        nav: { account: 1_631_190, book: 5_536_190 }, // 1,000,000 + (505,000 - 5,000 - 3,000) x 1.27
        balance: { account: { positions: -10_160, assets: 1_631_190, netAssets: 1_631_190 } }, // -8,000 x 1.27
      },
    },
    {
      // 8,000 GBP is now required: 8,000 x 1.27 / 0.98 = 10,367.35 USD. 51,020.41 - 10,367.35 = 40,653.06 comes back.
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-03-06'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer B" (Dealer B): 40,653.06 USD returned to us. Netting set of 1 position marked at -8,000.00 GBP; threshold 0.00 GBP.', cash: { USD: 40_653.06 }, owner: 'account' }],
        cash: { account: { USD: { settled: 730_448.98, margin: 269_551.02, availableToTrade: 730_448.98 } } }, // 259,183.67 + 10,367.35 stay posted
        otc: [{ instrument: 'main', vmPosted: 10_367.35, vmExposure: -8_000, vmStatus: 'ok', vmReason: null }],
        balance: { account: { cash: 1_371_798.98, margin: 269_551.02 } }, // 730,448.98 + 641,350
      },
    },
    {
      // Maturity, 7 April. The fixed amount is received: 40,000,000 x 3.80% x 33/365 = 137,424.66 GBP (174,529.32 USD at 1.27).
      // The compounded amount cannot be worked out: the fixing of 27 March is missing. It waits, and so does maturity.
      id: 'maturity-fixing-missing', covers: ['fixed payment', 'missing fixing'], action: 'clock', to: at('2026-04-07'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${OIS_NAME}, leg A (fixed), period 2026-03-05 to 2026-04-07: 137,424.66 GBP`, cash: { GBP: 137_424.66 }, owner: 'account', date: '2026-04-07' }],
        cash: { account: { GBP: { settled: 642_424.66, availableToTrade: 642_424.66 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-04-07', status: 'blocked', reason: /Waiting for the final leg payments/ },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-04-07', status: 'blocked', reason: /Awaiting the SONIA fixing for 2026-03-27/ },
        ],
        positions: [{ instrument: 'main', lot: 'ois', qty: -40_000_000, value: -8_000, unrealized: -3_000 }],
        // FX effect: cash 642,424.66 x 1.27 = 815,879.32 against 631,250 + 174,529.32 booked: 10,100.00; position cost -5,000: -100.00.
        pnl: { account: { realized: 174_529.32, unrealized: -3_810, fx: 10_000, total: 180_719.32 } },
        nav: { account: 1_805_719.32, book: 5_710_719.32 }, // 1,000,000 + (642,424.66 - 5,000 - 3,000) x 1.27
        balance: { account: { cash: 1_546_328.30, positions: -10_160, margin: 269_551.02, assets: 1_805_719.32, netAssets: 1_805_719.32 } }, // 730,448.98 + 815,879.32
      },
    },
    {
      // 3.46% for 27 March, by hand. The compounded amount is paid: 129,487.68 GBP (164,449.35 USD). Net of the two legs: +7,936.98 GBP.
      // The contract then matures: the 5,000 received up front is realized (6,350.00 USD at 1.27) and all collateral comes back.
      id: 'fixing-entered-and-matured', covers: ['missing fixing', 'compounded payment', 'maturity', 'collateral'], action: 'manual_rate', code: 'SONIA', value: 3.46, date: '2026-03-27', note: 'Published fixing, entered by hand',
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${OIS_NAME}, leg B (ois), period 2026-03-05 to 2026-04-07: 129,487.68 GBP`, cash: { GBP: -129_487.68 }, owner: 'account', date: '2026-04-07' },
          { type: 'swap.matured', summary: `Swap matured: ${OIS_NAME} (notional 40,000,000)`, owner: 'account' },
          { type: 'swap.collateral', summary: `Collateral returned on ${OIS_NAME} under "CSA Dealer B" (Dealer B): 259,183.67 USD (independent amount, the position ended)`, cash: { USD: 259_183.67 } },
          { type: 'collateral.variation', summary: /Variation margin under "CSA Dealer B" \(Dealer B\): 10,367\.35 USD returned to us\./, cash: { USD: 10_367.35 } },
        ],
        cash: { account: { USD: { settled: 1_000_000, margin: 0, restricted: 0, availableToTrade: 1_000_000 }, GBP: { settled: 512_936.98, unsettled: 0, margin: 0, availableToTrade: 512_936.98 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        // Realized: 174,529.32 - 164,449.35 + 6,350.00. FX effect: 512,936.98 x 1.27 = 651,429.96 against 641,329.97 booked, less 100.00 on the closed position.
        pnl: { account: { realized: 16_429.97, unrealized: 0, fx: 9_999.99, total: 26_429.96 } },
        nav: { account: 1_651_429.96, treasury: 3_905_000, book: 5_556_429.96 },
        balance: { account: { cash: 1_651_429.96, margin: null, positions: null, receivable: null, assets: 1_651_429.96, liabilities: 0, netAssets: 1_651_429.96 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// basis_swap
// ---------------------------------------------------------------------------------------------
// A euro "3s6s" basis swap in a Book that reports in EUR: pay 6-month EURIBOR flat semi-annually,
// receive 3-month EURIBOR plus 9.5 basis points quarterly, both ACT/360 on TARGET business days.
// Explicitly uncollateralized. 20,000,000, increased to 25,000,000 before the effective date, cut to
// 20,000,000 after the first half-year, then held to maturity.
//
// Schedule, rolled back from the maturity date Monday 1 February 2027 (effective Monday 2 February 2026):
//   3-month leg  2026-02-02 to 2026-05-01 (88 days), paid Monday 4 May: 1 May is a TARGET holiday.  Fixing of 2 February: 2.40%
//                2026-05-01 to 2026-08-01 (92 days), paid Monday 3 August (the 1st is a Saturday).  Fixing of Thursday 30 April: 2.35%
//                2026-08-01 to 2026-11-01 (92 days), paid Monday 2 November.                        Fixing of Friday 31 July: 2.30%
//                2026-11-01 to 2027-02-01 (92 days), paid 1 February 2027.                          Fixing of Friday 30 October: 2.20%
//   6-month leg  2026-02-02 to 2026-08-01 (180 days), paid Monday 3 August.                         Fixing of 2 February: 2.60%
//                2026-08-01 to 2027-02-01 (184 days), paid 1 February 2027.                         Fixing of Friday 31 July: 2.45%
const BASIS_NAME = 'EUR basis swap 3M EURIBOR + 9.5bp v 6M EURIBOR 1 Feb 2027';
const basisSwap = {
  productId: 'basis_swap',
  title: 'EUR 1-year 3s6s basis swap in a EUR Book, pay 6-month EURIBOR, receive 3-month EURIBOR + 9.5 bp, uncollateralized',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['payment schedule of each floating leg from the contract terms and the TARGET calendar', 'EURIBOR3M and EURIBOR6M fixings (rate fixtures standing in for Shaffer MarketData)', 'settlement date, T+2 on TARGET', 'commission from the Book fee schedule'],
    manualInputs: ['upfront amount of a new position (stated fill price)', 'mark of the contract, entered by hand', 'settlement amount of a partial termination (stated fill price in the preview)', 'cash moved from Treasury when a payment cannot be made'],
    settlement: 'Commission and termination amount settle T+2 on TARGET; leg payments are cash on their payment date',
    lifecycle: 'Two floating legs, each on its own index, spread and frequency; a payment the Account cannot fund fails visibly and is made once the cash is there; partial termination; final payments and maturity',
    accounting: 'EUR reporting currency; leg payments and the termination result are realized P&L; commission expensed; carried at the mark once one is entered, provisional before',
    collateral: 'Uncollateralized (paper assumption): nothing is posted or received, whatever the mark',
  },
  start: at('2026-01-29'),
  settlementCheck: { lag: 2, holidays: [] }, // TARGET: no holiday in the settlement windows used (29 January to 3 February, 5 to 7 August 2026)
  book: {
    name: 'Matrix basis swap', reportingCcy: 'EUR',
    capital: [{ ccy: 'EUR', amount: 1_000_000 }],
    account: { name: 'Euro rates', funding: [{ ccy: 'EUR', amount: 10_000 }] }, // deliberately thin: the first 6-month payment cannot be funded
    settings: { fees: { swap: { perUnit: 0.00001, minimum: 0, bps: 0 } }, fill: FILL, settlement: { swap: 2 } }, // 0.1 basis point of notional: 10.00 per million
  },
  instruments: {
    main: {
      productId: 'basis_swap', name: BASIS_NAME, symbol: 'BASIS-EUR-3S6S', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'DE', tradingCcy: 'EUR', multiplier: 0.01,
      conventions: { tradingCalendar: 'TARGET', settlementCalendar: 'TARGET', paymentCalendar: 'TARGET' },
      terms: {
        effective: '2026-02-02', maturity: '2027-02-01', counterparty: 'Dealer C', collateralBasis: { type: 'uncollateralized' }, collateral: 'No credit support annex',
        legs: [
          { side: 'pay', type: 'float', ccy: 'EUR', index: 'EURIBOR6M', spread: 0, months: 6, dayCount: 'ACT/360' },
          { side: 'receive', type: 'float', ccy: 'EUR', index: 'EURIBOR3M', spread: 0.00095, months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  rates: {
    EURIBOR3M: { currency: 'EUR', byDate: { '2026-02-02': 2.40, '2026-04-30': 2.35, '2026-07-31': 2.30, '2026-10-30': 2.20 } },
    EURIBOR6M: { currency: 'EUR', byDate: { '2026-02-02': 2.60, '2026-07-31': 2.45 } },
  },
  expectAtStart: {
    cash: { account: { EUR: { settled: 10_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 10_000 } }, treasury: { EUR: { settled: 990_000 } } },
    positions: [], pending: [], openOrders: [], lifecycle: [], lifecycleFailures: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 10_000, treasury: 990_000, book: 1_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 20_000_000, as: 'basis', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 20_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-02-02', calendar: 'TARGET', cash: 0, fees: 200 }], // 20,000,000 x 0.00001
          cash: { EUR: { purchases: 0, fees: 200, margin: 0, required: 200, available: 10_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20_000_000, avgPrice: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Entered as written: 20,000,000 notional of BASIS-EUR-3S6S at 0.00 per 100 notional', owner: 'account', date: '2026-01-29' }], // no collateral event
        cash: { account: { EUR: { settled: 10_000, unsettled: -200, margin: 0, restricted: 0, availableToTrade: 9_800, availableToWithdraw: 9_800 } } },
        positions: [{ instrument: 'main', lot: 'basis', owner: 'account', direction: 'as written', qty: 20_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 20_000_000, margin: 0 }],
        holdings: { main: { long: 20_000_000, short: 0, net: 20_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-02-02', amount: -200, ccy: 'EUR', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-05-04', status: 'pending' }, // 3-month leg
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-08-03', status: 'pending' }, // 6-month leg
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-02-01', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'basis', owner: 'account', basis: 'uncollateralized', agreement: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -200, unrealized: 0, fx: 0, total: -200 } },
        nav: { account: 9_800, book: 999_800 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 10_000, payable: 200, margin: null, positions: null, assets: 10_000, liabilities: 200, netAssets: 9_800 } },
      },
    },
    { id: 'next-day', action: 'clock', to: at('2026-01-30'), expect: {} },
    {
      // Before the effective date: the added 5,000,000 takes every period, like the first 20,000,000.
      id: 'increase', covers: 'increase', action: 'resize', lot: 'basis', factor: 1.25, order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-02-03', cash: 0, fees: 50 }], cash: { EUR: { fees: 50, required: 50, available: 9_800, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 5_000_000, avgPrice: 0 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Increased as written: 5,000,000 notional of BASIS-EUR-3S6S at 0.00 per 100 notional' }],
        cash: { account: { EUR: { unsettled: -250, availableToTrade: 9_750, availableToWithdraw: 9_750 } } },
        positions: [{ instrument: 'main', lot: 'basis', qty: 25_000_000, cost: 0, notional: 25_000_000 }],
        holdings: { main: { long: 25_000_000, short: 0, net: 25_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-02-02', amount: -200, ccy: 'EUR', into: 'cash' }, { instrument: 'main', dueDate: '2026-02-03', amount: -50, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { commissions: -250, total: -250 } },
        nav: { account: 9_750, book: 999_750 },
        balance: { account: { payable: 250, liabilities: 250, netAssets: 9_750 } },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: at('2026-02-02'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 200.00 EUR from settled cash', cash: { EUR: -200 } }],
        cash: { account: { EUR: { settled: 9_800, unsettled: -50 } } },
        pending: [{ instrument: 'main', dueDate: '2026-02-03', amount: -50, ccy: 'EUR', into: 'cash' }],
        balance: { account: { cash: 9_800, payable: 50, assets: 9_800, liabilities: 50 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-02-03'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 50.00 EUR from settled cash', cash: { EUR: -50 } }],
        cash: { account: { EUR: { settled: 9_750, unsettled: 0, availableToTrade: 9_750, availableToWithdraw: 9_750 } } },
        pending: [],
        balance: { account: { cash: 9_750, payable: null, assets: 9_750, liabilities: 0 } },
      },
    },
    {
      // Monday 4 May (1 May is a TARGET holiday). 3-month leg, received: 25,000,000 x (2.40% + 0.095%) x 88/360 = 152,472.22.
      id: 'first-quarter', covers: ['floating payment', 'payment across a holiday'], action: 'clock', to: at('2026-05-04'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${BASIS_NAME}, leg B (float), period 2026-02-02 to 2026-05-01: 152,472.22 EUR`, cash: { EUR: 152_472.22 }, owner: 'account', date: '2026-05-04' }],
        cash: { account: { EUR: { settled: 162_222.22, availableToTrade: 162_222.22, availableToWithdraw: 162_222.22 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-08-03', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-08-03', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-02-01', status: 'pending' },
        ],
        pnl: { account: { realized: 152_472.22, total: 152_222.22 } },
        nav: { account: 162_222.22, book: 1_152_222.22 },
        balance: { account: { cash: 162_222.22, assets: 162_222.22, netAssets: 162_222.22 } },
      },
    },
    {
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.05, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'basis', qty: 25_000_000, price: 0.05, value: 12_500, unrealized: 12_500, provisional: false, priceSource: 'Manual entry' }], // 25,000,000 x 0.05 / 100
        pnl: { account: { unrealized: 12_500, total: 164_722.22 } },
        nav: { account: 174_722.22, book: 1_164_722.22 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 12_500, assets: 174_722.22, netAssets: 174_722.22 } },
      },
    },
    {
      // Monday 3 August, two payments. 6-month leg, to pay: 25,000,000 x 2.60% x 180/360 = 325,000.00. The Account has 162,222.22: it fails.
      // 3-month leg, received: 25,000,000 x (2.35% + 0.095%) x 92/360 = 156,208.33. With it the Account has 318,430.55: still short.
      id: 'payment-cannot-be-funded', covers: ['floating payment', 'insufficient cash'], action: 'clock', to: at('2026-08-03'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${BASIS_NAME}, leg B (float), period 2026-05-01 to 2026-08-01: 156,208.33 EUR`, cash: { EUR: 156_208.33 }, date: '2026-08-03' }],
        cash: { account: { EUR: { settled: 318_430.55, availableToTrade: 318_430.55, availableToWithdraw: 318_430.55 } } },
        // The failed payment is listed with the failed items (Failed tab), not with the pending ones, and is retried every cycle.
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-02', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-02-01', status: 'pending' },
        ],
        lifecycleFailures: [{ type: 'swap.payment', instrument: 'main', dueDate: '2026-08-03', status: 'failed', owner: 'account', reason: /Swap payment of 325,000\.00 EUR on .* \(leg A\) could not be paid: insufficient settled EUR cash in Euro rates/ }],
        alerts: ['funding.failed'],
        failed: { lifecycle: 1 },
        pnl: { account: { realized: 308_680.55, total: 320_930.55 } },
        nav: { account: 330_930.55, book: 1_320_930.55 },
        balance: { account: { cash: 318_430.55, assets: 330_930.55, netAssets: 330_930.55 } },
      },
    },
    {
      // Treasury funds the Account with 200,000; the payment is then made. Net of the two legs for the half-year: 152,472.22 + 156,208.33 - 325,000.00 = -16,319.45.
      id: 'funded-and-paid', covers: ['floating payment', 'insufficient cash'], action: 'transfer', from: 'treasury', to: 'account', ccy: 'EUR', amount: 200_000,
      expect: {
        events: [
          { type: 'transfer.funding' },
          { type: 'swap.payment', summary: `Swap payment on ${BASIS_NAME}, leg A (float), period 2026-02-02 to 2026-08-01: 325,000.00 EUR`, cash: { EUR: -325_000 }, owner: 'account', date: '2026-08-03' },
        ],
        cash: { account: { EUR: { settled: 193_430.55, availableToTrade: 193_430.55, availableToWithdraw: 193_430.55 } }, treasury: { EUR: { settled: 790_000 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-02', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-02-01', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-02-01', status: 'pending' },
        ],
        alerts: [],
        failed: { lifecycle: 0 }, lifecycleFailures: [],
        pnl: { account: { realized: -16_319.45, total: -4_069.45 } }, // - 250 - 16,319.45 + 12,500
        nav: { account: 205_930.55, treasury: 790_000, book: 995_930.55 }, // 10,000 + 200,000 funded - 4,069.45
        balance: { account: { cash: 193_430.55, assets: 205_930.55, netAssets: 205_930.55 } },
      },
    },
    { id: 'two-days-later', action: 'clock', to: at('2026-08-05'), expect: {} },
    {
      // A fifth (5,000,000) is terminated at -0.02 per 100, paid: 5,000,000 x 0.02 / 100 = 1,000. Nothing was paid to enter, so realized -1,000.
      id: 'partial-termination', covers: ['reduce', 'partial termination'], action: 'close', lot: 'basis', scope: 'strategy', percent: 20, order: { statedPrice: -0.02 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 5_000_000, estimate: -0.02, model: 'stated-price', settleDate: '2026-08-07', cash: -1_000, fees: 50 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 5_000_000, avgPrice: -0.02 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Terminated in part: 5,000,000 of 25,000,000 notional of BASIS-EUR-3S6S at -0.02 per 100 notional (realized -1,000.00 EUR)' }],
        cash: { account: { EUR: { settled: 193_430.55, unsettled: -1_050, availableToTrade: 192_380.55, availableToWithdraw: 192_380.55 } } },
        positions: [{ instrument: 'main', lot: 'basis', qty: 20_000_000, cost: 0, price: 0.05, value: 10_000, unrealized: 10_000, notional: 20_000_000 }],
        holdings: { main: { long: 20_000_000, short: 0, net: 20_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-08-07', amount: -1_050, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: -17_319.45, commissions: -300, unrealized: 10_000, total: -7_619.45 } },
        nav: { account: 202_380.55, book: 992_380.55 },
        balance: { account: { positions: 10_000, payable: 1_050, assets: 203_430.55, liabilities: 1_050, netAssets: 202_380.55 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2026-08-07'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,050.00 EUR from settled cash', cash: { EUR: -1_050 } }],
        cash: { account: { EUR: { settled: 192_380.55, unsettled: 0, availableToTrade: 192_380.55, availableToWithdraw: 192_380.55 } } },
        pending: [],
        balance: { account: { cash: 192_380.55, payable: null, assets: 202_380.55, liabilities: 0 } },
      },
    },
    {
      // Monday 2 November, on the 20,000,000 left: 20,000,000 x (2.30% + 0.095%) x 92/360 = 122,411.11.
      id: 'third-quarter', covers: 'floating payment', action: 'clock', to: at('2026-11-02'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${BASIS_NAME}, leg B (float), period 2026-08-01 to 2026-11-01: 122,411.11 EUR`, cash: { EUR: 122_411.11 }, date: '2026-11-02' }],
        cash: { account: { EUR: { settled: 314_791.66, availableToTrade: 314_791.66, availableToWithdraw: 314_791.66 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-02-01', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-02-01', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-02-01', status: 'pending' },
        ],
        pnl: { account: { realized: 105_091.66, total: 114_791.66 } }, // -17,319.45 + 122,411.11; then - 300 + 10,000
        nav: { account: 324_791.66, book: 1_114_791.66 },
        balance: { account: { cash: 314_791.66, assets: 324_791.66, netAssets: 324_791.66 } },
      },
    },
    {
      // Maturity, 1 February 2027. 6-month leg, paid: 20,000,000 x 2.45% x 184/360 = 250,444.44.
      // 3-month leg, received: 20,000,000 x (2.20% + 0.095%) x 92/360 = 117,300.00. Then the contract matures; its mark of 10,000 was never cash.
      // 10,000 + 200,000 - 250 - 1,050 + 152,472.22 + 156,208.33 - 325,000 + 122,411.11 - 250,444.44 + 117,300 = 181,647.22.
      id: 'final-payments-and-maturity', covers: ['floating payment', 'maturity', 'close'], action: 'clock', to: at('2027-02-01'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${BASIS_NAME}, leg A (float), period 2026-08-01 to 2027-02-01: 250,444.44 EUR`, cash: { EUR: -250_444.44 }, date: '2027-02-01' },
          { type: 'swap.payment', summary: `Swap receipt on ${BASIS_NAME}, leg B (float), period 2026-11-01 to 2027-02-01: 117,300.00 EUR`, cash: { EUR: 117_300 } },
          { type: 'swap.matured', summary: `Swap matured: ${BASIS_NAME} (notional 20,000,000)`, owner: 'account' },
        ],
        cash: { account: { EUR: { settled: 181_647.22, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 181_647.22, availableToWithdraw: 181_647.22 } }, treasury: { EUR: { settled: 790_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        pnl: { account: { realized: -28_052.78, commissions: -300, unrealized: 0, total: -28_352.78 } }, // 105,091.66 - 250,444.44 + 117,300.00
        nav: { account: 181_647.22, treasury: 790_000, book: 971_647.22 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 181_647.22, positions: null, assets: 181_647.22, liabilities: 0, netAssets: 181_647.22 } },
      },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// Shared by the US dollar scenarios below
// ---------------------------------------------------------------------------------------------
const USD_CALENDARS = { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' };
/** A 1,000,000 USD Book whose Account is funded with `funding`; no commission on swaps unless `fee` is given. */
const usdBook = (name, accountName, funding, fee = NO_FEE) => ({
  name, reportingCcy: 'USD',
  capital: [{ ccy: 'USD', amount: 1_000_000 }],
  account: { name: accountName, funding: [{ ccy: 'USD', amount: funding }] },
  settings: { fees: { swap: fee }, fill: FILL, settlement: { swap: 2 } },
});
const usdStart = (funding) => ({
  cash: {
    account: { USD: { settled: funding, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: funding } },
    treasury: { USD: { settled: 1_000_000 - funding, unsettled: 0, reserved: 0, restricted: 0, margin: 0 } },
  },
  positions: [], pending: [], openOrders: [], lifecycle: [], lifecycleFailures: [], borrowings: [], otc: [], alerts: [],
  nav: { account: funding, treasury: 1_000_000 - funding, book: 1_000_000 },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
});

// ---------------------------------------------------------------------------------------------
// interest_rate_cap
// ---------------------------------------------------------------------------------------------
// A one-year cap at 4.25% on 3-month term SOFR, bought: a premium is paid at entry and each quarter
// the caplet pays notional x max(fixing - 4.25%, 0) x days/360. Uncollateralized: the buyer owes
// nothing after the premium. The premium is the price: an amount per 100 of notional.
//
// Schedule (effective Monday 16 March 2026, maturity Tuesday 16 March 2027), every payment date a business day:
//   2026-03-16 to 2026-06-16 (92 days)  fixing of 16 March 4.30%      in the money by 0.05%
//   2026-06-16 to 2026-09-16 (92 days)  fixing of 16 June 4.10%       below the strike: nothing due
//   2026-09-16 to 2026-12-16 (91 days)  fixing of 16 September 4.75%  in the money by 0.50%
//   2026-12-16 to 2027-03-16 (90 days)  fixing of 16 December: not supplied; entered by hand as 4.55% (0.30% in the money)
const CAP_NAME = 'USD cap 4.25% on TSFR3M 16 Mar 2027';
const interestRateCap = {
  productId: 'interest_rate_cap',
  title: 'USD 1-year cap at 4.25% on 3-month term SOFR, bought for a premium, uncollateralized, held to maturity',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['caplet schedule from the contract terms and the USD payment calendar', 'TSFR3M fixings (rate fixture standing in for Shaffer MarketData)', 'settlement date of the premium, T+2 on the USD calendar'],
    manualInputs: ['premium (stated fill price, per 100 notional)', 'mark of the cap, entered by hand', 'settlement amount of a partial termination (stated fill price in the preview)', 'a fixing the data service has not supplied, entered by hand'],
    settlement: 'Premium and termination amount settle T+2 on the USD calendar; caplet payments are cash on their payment date',
    lifecycle: 'Each quarter the caplet pays when the fixing is above the strike and is recorded as nothing due when it is not; a caplet whose fixing is missing is blocked until the fixing is supplied, and maturity waits for it; at maturity the cap ends and the premium still carried is written off',
    accounting: 'Carried at the premium paid until a mark is entered (provisional), then at the mark; caplet receipts are realized P&L; a partial termination realizes the difference from the average premium; at maturity the remaining premium is a realized loss',
    collateral: 'Uncollateralized (paper assumption): nothing is posted or received, whatever the mark',
  },
  start: at('2026-03-12'),
  settlementCheck: { lag: 2, holidays: [] }, // no Federal Reserve holiday in the settlement windows used (12 to 17 March, 8 to 10 July 2026)
  book: usdBook('Matrix interest-rate cap', 'Rates', 500_000),
  instruments: {
    main: {
      productId: 'interest_rate_cap', name: CAP_NAME, symbol: 'CAP-TSFR-425', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: USD_CALENDARS,
      terms: {
        effective: '2026-03-16', maturity: '2027-03-16', counterparty: 'Dealer A', collateralBasis: { type: 'uncollateralized' },
        legs: [{ side: 'receive', type: 'cap', ccy: 'USD', index: 'TSFR3M', strike: 0.0425, months: 3, dayCount: 'ACT/360' }],
      },
    },
  },
  rates: { TSFR3M: { byDate: { '2026-03-16': 4.30, '2026-06-16': 4.10, '2026-09-16': 4.75 } } }, // 16 December is deliberately missing
  expectAtStart: usdStart(500_000),
  steps: [
    {
      // 200,000,000 at a premium of 0.42 per 100 is 840,000; the Account has 500,000: 340,000 short.
      id: 'too-large', covers: 'insufficient cash', action: 'ticket', instrument: 'main', side: 'buy', qty: 200_000_000, order: { statedPrice: 0.42 },
      status: 'blocked', reason: 'The premium must be covered by the Account\'s cash.',
      expect: { refused: /Rates is short 340,000\.00 USD: the package needs 840,000\.00 USD \(purchases 840,000\.00 USD, fees 0\.00 USD, margin and collateral 0\.00 USD, reserved 0\.00 USD\) and 500,000\.00 USD is available/ },
    },
    {
      // Premium 20,000,000 x 0.42 / 100 = 84,000, settling Monday 16 March (T+2). Until a mark is entered the cap is carried at what was paid.
      id: 'open', covers: ['open', 'premium'], action: 'ticket', instrument: 'main', side: 'buy', qty: 20_000_000, as: 'cap', order: { statedPrice: 0.42 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 20_000_000, estimate: 0.42, model: 'stated-price', settleDate: '2026-03-16', calendar: 'USD', cash: -84_000, fees: 0 }],
          cash: { USD: { purchases: 84_000, fees: 0, margin: 0, required: 84_000, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20_000_000, avgPrice: 0.42, fills: [{ qty: 20_000_000, price: 0.42, model: 'stated-price', settleDate: '2026-03-16' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Entered as written: 20,000,000 notional of CAP-TSFR-425 at 0.42 per 100 notional', owner: 'account', date: '2026-03-12' }], // no collateral event
        cash: { account: { USD: { settled: 500_000, unsettled: -84_000, margin: 0, restricted: 0, availableToTrade: 416_000, availableToWithdraw: 416_000 } } },
        positions: [{ instrument: 'main', lot: 'cap', owner: 'account', direction: 'as written', qty: 20_000_000, avgCost: 0.42, cost: 84_000, price: null, value: null, unrealized: null, provisional: true, notional: 20_000_000, margin: 0 }],
        holdings: { main: { long: 20_000_000, short: 0, net: 20_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-03-16', amount: -84_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-06-16', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-16', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'cap', owner: 'account', qty: 20_000_000, basis: 'uncollateralized', agreement: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: 0, unrealized: 0, total: 0 } },
        nav: { account: 500_000, book: 1_000_000 }, // carried at cost, the premium owed against it
        provisional: { account: true, book: true },
        balance: { account: { cash: 500_000, payable: 84_000, margin: null, positions: 84_000, accruedIncome: null, accruedExpense: null, assets: 584_000, liabilities: 84_000, netAssets: 500_000 } },
      },
    },
    { id: 'friday', action: 'clock', to: at('2026-03-13'), expect: {} },
    {
      // 10,000,000 more at 0.40: 40,000, settling Tuesday 17 March. Average premium (84,000 + 40,000) / 300,000 = 0.4133333 per 100.
      id: 'increase', covers: ['increase', 'premium'], action: 'resize', lot: 'cap', factor: 1.5, order: { statedPrice: 0.40 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 10_000_000, estimate: 0.4, model: 'stated-price', settleDate: '2026-03-17', cash: -40_000, fees: 0 }],
          cash: { USD: { purchases: 40_000, required: 40_000, available: 416_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 10_000_000, avgPrice: 0.4 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Increased as written: 10,000,000 notional of CAP-TSFR-425 at 0.40 per 100 notional' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -124_000, availableToTrade: 376_000, availableToWithdraw: 376_000 } } },
        positions: [{ instrument: 'main', lot: 'cap', qty: 30_000_000, cost: 124_000, avgCost: 0.4133333, price: null, value: null, notional: 30_000_000 }],
        holdings: { main: { long: 30_000_000, short: 0, net: 30_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-03-16', amount: -84_000, ccy: 'USD', into: 'cash' }, { instrument: 'main', dueDate: '2026-03-17', amount: -40_000, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 30_000_000 }],
        nav: { account: 500_000, book: 1_000_000 },
        balance: { account: { payable: 124_000, positions: 124_000, assets: 624_000, liabilities: 124_000, netAssets: 500_000 } },
      },
    },
    {
      id: 'settle-premium', covers: 'settlement', action: 'clock', to: at('2026-03-16'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 84,000.00 USD from settled cash', cash: { USD: -84_000 }, date: '2026-03-16' }],
        cash: { account: { USD: { settled: 416_000, unsettled: -40_000, availableToTrade: 376_000, availableToWithdraw: 376_000 } } },
        pending: [{ instrument: 'main', dueDate: '2026-03-17', amount: -40_000, ccy: 'USD', into: 'cash' }],
        balance: { account: { cash: 416_000, payable: 40_000, assets: 540_000, liabilities: 40_000 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-03-17'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 40,000.00 USD from settled cash', cash: { USD: -40_000 } }],
        cash: { account: { USD: { settled: 376_000, unsettled: 0, availableToTrade: 376_000, availableToWithdraw: 376_000 } } },
        pending: [],
        balance: { account: { cash: 376_000, payable: null, assets: 500_000, liabilities: 0 } },
      },
    },
    {
      // 30,000,000 x 0.35 / 100 = 105,000 against 124,000 paid: 19,000 down.
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.35, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cap', qty: 30_000_000, price: 0.35, value: 105_000, unrealized: -19_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: 0.35, markValue: 105_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { unrealized: -19_000, total: -19_000 } },
        nav: { account: 481_000, book: 981_000 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 105_000, assets: 481_000, netAssets: 481_000 } },
      },
    },
    {
      // Uncollateralized: the end-of-day pass moves nothing, whatever the mark.
      id: 'no-collateral-moves', covers: 'collateral', action: 'clock', to: eod('2026-03-17'),
      expect: { events: [], otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 0, iaPosted: 0 }], alerts: [], cash: { account: { USD: { settled: 376_000, margin: 0, restricted: 0 } } } },
    },
    {
      // First caplet: 30,000,000 x (4.30% - 4.25%) x 92/360 = 3,833.33.
      id: 'first-caplet', covers: 'caplet payment', action: 'clock', to: at('2026-06-16'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${CAP_NAME}, leg A (cap), period 2026-03-16 to 2026-06-16: 3,833.33 USD`, cash: { USD: 3_833.33 }, owner: 'account', date: '2026-06-16' }],
        cash: { account: { USD: { settled: 379_833.33, availableToTrade: 379_833.33, availableToWithdraw: 379_833.33 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-16', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-16', status: 'pending' },
        ],
        pnl: { account: { realized: 3_833.33, unrealized: -19_000, total: -15_166.67 } },
        nav: { account: 484_833.33, book: 984_833.33 },
        balance: { account: { cash: 379_833.33, accruedIncome: null, assets: 484_833.33, netAssets: 484_833.33 } },
      },
    },
    { id: 'early-july', action: 'clock', to: at('2026-07-08'), expect: {} },
    {
      // 40% (12,000,000) is terminated for 0.30 per 100, received: 36,000. Premium carried on it: 124,000 x 12/30 = 49,600. Realized -13,600.
      // Left: 18,000,000 carrying 74,400, marked 0.35: 63,000, 11,400 down. Settles Friday 10 July.
      id: 'partial-termination', covers: ['reduce', 'partial termination'], action: 'close', lot: 'cap', scope: 'strategy', percent: 40, order: { statedPrice: 0.30 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 12_000_000, estimate: 0.3, model: 'stated-price', settleDate: '2026-07-10', cash: 36_000, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 12_000_000, avgPrice: 0.3 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Terminated in part: 12,000,000 of 30,000,000 notional of CAP-TSFR-425 at 0.30 per 100 notional (realized -13,600.00 USD)' }],
        cash: { account: { USD: { settled: 379_833.33, unsettled: 36_000, availableToTrade: 415_833.33, availableToWithdraw: 379_833.33 } } },
        positions: [{ instrument: 'main', lot: 'cap', qty: 18_000_000, cost: 74_400, avgCost: 0.4133333, price: 0.35, value: 63_000, unrealized: -11_400, notional: 18_000_000 }],
        holdings: { main: { long: 18_000_000, short: 0, net: 18_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-07-10', amount: 36_000, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 18_000_000, markValue: 63_000 }],
        pnl: { account: { realized: -9_766.67, unrealized: -11_400, total: -21_166.67 } }, // 3,833.33 - 13,600
        nav: { account: 478_833.33, book: 978_833.33 },
        balance: { account: { cash: 379_833.33, receivable: 36_000, positions: 63_000, assets: 478_833.33, liabilities: 0, netAssets: 478_833.33 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2026-07-10'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 36,000.00 USD into settled cash', cash: { USD: 36_000 } }],
        cash: { account: { USD: { settled: 415_833.33, unsettled: 0, availableToTrade: 415_833.33, availableToWithdraw: 415_833.33 } } },
        pending: [],
        balance: { account: { cash: 415_833.33, receivable: null } },
      },
    },
    {
      // Second caplet: the fixing of 16 June, 4.10%, is below the 4.25% strike. Nothing is due, and that is recorded.
      id: 'caplet-out-of-the-money', covers: 'caplet payment', action: 'clock', to: at('2026-09-16'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Nothing due on ${CAP_NAME}, leg A (cap), period 2026-06-16 to 2026-09-16: the TSFR3M fixing 4.100% is not above the strike 4.250%`, owner: 'account', date: '2026-09-16' }],
        cash: { account: { USD: { settled: 415_833.33, availableToTrade: 415_833.33 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-16', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-16', status: 'pending' },
        ],
        pnl: { account: { realized: -9_766.67, total: -21_166.67 } },
        nav: { account: 478_833.33, book: 978_833.33 },
      },
    },
    {
      // Third caplet, on the 18,000,000 left: 18,000,000 x (4.75% - 4.25%) x 91/360 = 22,750.00.
      id: 'third-caplet', covers: 'caplet payment', action: 'clock', to: at('2026-12-16'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${CAP_NAME}, leg A (cap), period 2026-09-16 to 2026-12-16: 22,750.00 USD`, cash: { USD: 22_750 }, date: '2026-12-16' }],
        cash: { account: { USD: { settled: 438_583.33, availableToTrade: 438_583.33, availableToWithdraw: 438_583.33 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-16', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-16', status: 'pending' },
        ],
        pnl: { account: { realized: 12_983.33, total: 1_583.33 } }, // -9,766.67 + 22,750; then - 11,400
        nav: { account: 501_583.33, book: 1_001_583.33 },
        balance: { account: { cash: 438_583.33, assets: 501_583.33, netAssets: 501_583.33 } },
      },
    },
    {
      // Maturity date. The last caplet needs the fixing of 16 December, which was never supplied: it waits, and so does maturity. No rate is assumed.
      id: 'last-caplet-blocked', covers: 'missing fixing', action: 'clock', to: at('2027-03-16'),
      expect: {
        events: [],
        cash: { account: { USD: { settled: 438_583.33 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-16', status: 'blocked', reason: /Waiting for the final leg payments/ },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-16', status: 'blocked', reason: /Awaiting the TSFR3M fixing for 2026-12-16/ },
        ],
        positions: [{ instrument: 'main', lot: 'cap', qty: 18_000_000, value: 63_000 }],
        nav: { account: 501_583.33, book: 1_001_583.33 },
      },
    },
    {
      // 4.55% for 16 December, by hand: 18,000,000 x (4.55% - 4.25%) x 90/360 = 13,500.00.
      id: 'fixing-entered-by-hand', covers: ['missing fixing', 'caplet payment'], action: 'manual_rate', code: 'TSFR3M', value: 4.55, date: '2026-12-16', note: 'Published fixing, entered by hand',
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${CAP_NAME}, leg A (cap), period 2026-12-16 to 2027-03-16: 13,500.00 USD`, cash: { USD: 13_500 }, owner: 'account', date: '2027-03-16' }],
        cash: { account: { USD: { settled: 452_083.33, availableToTrade: 452_083.33, availableToWithdraw: 452_083.33 } } },
        // Maturity was looked at before the payment in this pass, so it is still shown as waiting; the next pass ends the contract.
        lifecycle: [{ type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-16', status: 'blocked', reason: /Waiting for the final leg payments/ }],
        pnl: { account: { realized: 26_483.33, total: 15_083.33 } }, // 12,983.33 + 13,500; then - 11,400
        nav: { account: 515_083.33, book: 1_015_083.33 },
        balance: { account: { cash: 452_083.33, assets: 515_083.33, netAssets: 515_083.33 } },
      },
    },
    {
      // The cap ends. The 74,400 of premium still carried is written off; the mark of 63,000 was never cash.
      // 500,000 - 84,000 - 40,000 + 3,833.33 + 36,000 + 22,750 + 13,500 = 452,083.33.
      id: 'matured', covers: ['maturity', 'close'], action: 'cycle',
      expect: {
        events: [{ type: 'swap.matured', summary: `Swap matured: ${CAP_NAME} (notional 18,000,000)`, owner: 'account' }],
        cash: { account: { USD: { settled: 452_083.33, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 452_083.33, availableToWithdraw: 452_083.33 } }, treasury: { USD: { settled: 500_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        pnl: { account: { realized: -47_916.67, commissions: 0, unrealized: 0, total: -47_916.67 } }, // 26,483.33 - 74,400
        nav: { account: 452_083.33, treasury: 500_000, book: 952_083.33 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 452_083.33, positions: null, assets: 452_083.33, liabilities: 0, netAssets: 452_083.33 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// interest_rate_floor
// ---------------------------------------------------------------------------------------------
// A one-year floor at 3.75% on 3-month term SOFR, sold. The contract is written from the buyer's side
// ("receive the floor"), so the Account enters the opposite side: it receives the premium and each
// quarter pays notional x max(3.75% - fixing, 0) x days/360. Position-level collateral terms: a fixed
// independent amount of 100,000 and no variation margin.
//
// Schedule (effective Wednesday 1 April 2026, maturity Thursday 1 April 2027):
//   2026-04-01 to 2026-07-01 (91 days), paid 1 July          fixing of 1 April 3.90%     above the strike: nothing due
//   2026-07-01 to 2026-10-01 (92 days), paid 1 October       fixing of 1 July 3.60%      0.15% below
//   2026-10-01 to 2027-01-01 (92 days), paid Monday 4 January 2027 (New Year's Day is a holiday)   fixing of 1 October 3.20%   0.55% below
//   2027-01-01 to 2027-04-01 (90 days), paid 1 April 2027    fixing of Thursday 31 December 2026 (1 January is not a business day) 3.75%: at the strike, nothing due
const FLOOR_NAME = 'USD floor 3.75% on TSFR3M 1 Apr 2027';
const interestRateFloor = {
  productId: 'interest_rate_floor',
  title: 'USD 1-year floor at 3.75% on 3-month term SOFR, sold for a premium, fixed independent amount, held to maturity',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['floorlet schedule from the contract terms and the USD payment calendar', 'TSFR3M fixings (rate fixture standing in for Shaffer MarketData)', 'settlement date of the premium, T+2 on the USD calendar', 'independent amount from the position-level terms'],
    manualInputs: ['premium (stated fill price, per 100 notional)', 'mark of the floor, entered by hand', 'amount paid to buy part of it back (stated fill price in the preview)'],
    settlement: 'Premium and buy-back amount settle T+2 on the USD calendar; floorlet payments are cash on their payment date',
    lifecycle: 'Each quarter the seller pays the floorlet when the fixing is below the strike and nothing when it is at or above it (recorded as nothing due); a payment date on a holiday moves to the next business day; at maturity the floor ends and the premium still carried is earned',
    accounting: 'A sold floor is a negative position carried at the premium received until a mark is entered, then at the mark; floorlet payments are realized P&L; a buy-back realizes the difference from the average premium; at maturity the remaining premium is a realized gain',
    collateral: 'Position-level terms: a fixed independent amount of 100,000 posted when the position opens, unchanged by an increase or a partial buy-back, returned when the position ends; no variation margin',
  },
  start: at('2026-03-30'),
  settlementCheck: { lag: 2, holidays: [] }, // no Federal Reserve holiday in the settlement windows used (30 March to 2 April, 14 to 18 August 2026)
  book: usdBook('Matrix interest-rate floor', 'Rates', 300_000),
  instruments: {
    main: {
      productId: 'interest_rate_floor', name: FLOOR_NAME, symbol: 'FLOOR-TSFR-375', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: USD_CALENDARS,
      terms: {
        effective: '2026-04-01', maturity: '2027-04-01', counterparty: 'Dealer A',
        collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 100_000 }, variationMargin: false },
        legs: [{ side: 'receive', type: 'floor', ccy: 'USD', index: 'TSFR3M', strike: 0.0375, months: 3, dayCount: 'ACT/360' }],
      },
    },
  },
  rates: { TSFR3M: { byDate: { '2026-04-01': 3.90, '2026-07-01': 3.60, '2026-10-01': 3.20, '2026-12-31': 3.75 } } },
  expectAtStart: usdStart(300_000),
  steps: [
    {
      // Sold: the premium 15,000,000 x 0.30 / 100 = 45,000 is received, settling Wednesday 1 April (T+2). The 100,000 is posted at once.
      id: 'open', covers: ['open', 'premium', 'collateral'], action: 'ticket', instrument: 'main', side: 'sell', qty: 15_000_000, as: 'floor', order: { statedPrice: 0.30 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 15_000_000, estimate: 0.3, model: 'stated-price', settleDate: '2026-04-01', calendar: 'USD', cash: 45_000, fees: 0 }],
          cash: { USD: { proceeds: 45_000, fees: 0, margin: 100_000, required: 100_000, available: 300_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 15_000_000, avgPrice: 0.3, fills: [{ qty: 15_000_000, price: 0.3, model: 'stated-price', settleDate: '2026-04-01' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered on the opposite side: 15,000,000 notional of FLOOR-TSFR-375 at 0.30 per 100 notional', owner: 'account', date: '2026-03-30' },
          { type: 'swap.collateral', summary: `Collateral posted on ${FLOOR_NAME} under its position-level terms: 100,000.00 USD (independent amount, fixed amount for the position)`, cash: { USD: -100_000 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 200_000, unsettled: 45_000, margin: 100_000, restricted: 0, availableToTrade: 245_000, availableToWithdraw: 200_000 } } },
        positions: [{ instrument: 'main', lot: 'floor', owner: 'account', direction: 'opposite side', qty: -15_000_000, avgCost: 0.3, cost: -45_000, price: null, value: null, unrealized: null, provisional: true, notional: 15_000_000, margin: 100_000 }],
        holdings: { main: { long: 0, short: 15_000_000, net: -15_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-01', amount: 45_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-01', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'floor', owner: 'account', qty: -15_000_000, basis: 'position', mark: null, iaRequired: 100_000, iaPosted: 100_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: 0, unrealized: 0, total: 0 } },
        nav: { account: 300_000, book: 1_000_000 }, // carried at the premium received, the receivable against it
        provisional: { account: true, book: true },
        balance: { account: { cash: 200_000, margin: 100_000, receivable: 45_000, positions: -45_000, payable: null, accruedIncome: null, accruedExpense: null, assets: 300_000, liabilities: 0, netAssets: 300_000 } },
      },
    },
    { id: 'tuesday', action: 'clock', to: at('2026-03-31'), expect: {} },
    {
      // 3,000,000 more is sold at 0.32: 9,600 received, settling Thursday 2 April. Average premium (45,000 + 9,600) / 180,000 = 0.3033333 per 100.
      // The independent amount is a fixed amount for the position: it does not change.
      id: 'increase', covers: ['increase', 'premium', 'collateral'], action: 'resize', lot: 'floor', factor: 1.2, order: { statedPrice: 0.32 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 3_000_000, estimate: 0.32, model: 'stated-price', settleDate: '2026-04-02', cash: 9_600, fees: 0 }],
          cash: { USD: { proceeds: 9_600, margin: 0, required: 0, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 3_000_000, avgPrice: 0.32 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Increased on the opposite side: 3,000,000 notional of FLOOR-TSFR-375 at 0.32 per 100 notional' }],
        cash: { account: { USD: { settled: 200_000, unsettled: 54_600, margin: 100_000, availableToTrade: 254_600, availableToWithdraw: 200_000 } } },
        positions: [{ instrument: 'main', lot: 'floor', qty: -18_000_000, cost: -54_600, avgCost: 0.3033333, price: null, value: null, notional: 18_000_000, margin: 100_000 }],
        holdings: { main: { long: 0, short: 18_000_000, net: -18_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-04-01', amount: 45_000, ccy: 'USD', into: 'cash' }, { instrument: 'main', dueDate: '2026-04-02', amount: 9_600, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -18_000_000, iaRequired: 100_000, iaPosted: 100_000 }],
        nav: { account: 300_000, book: 1_000_000 },
        balance: { account: { receivable: 54_600, positions: -54_600, assets: 300_000, netAssets: 300_000 } },
      },
    },
    {
      id: 'settle-premium', covers: 'settlement', action: 'clock', to: at('2026-04-01'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 45,000.00 USD into settled cash', cash: { USD: 45_000 }, date: '2026-04-01' }],
        cash: { account: { USD: { settled: 245_000, unsettled: 9_600, availableToTrade: 254_600, availableToWithdraw: 245_000 } } },
        pending: [{ instrument: 'main', dueDate: '2026-04-02', amount: 9_600, ccy: 'USD', into: 'cash' }],
        balance: { account: { cash: 245_000, receivable: 9_600 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-04-02'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 9,600.00 USD into settled cash', cash: { USD: 9_600 } }],
        cash: { account: { USD: { settled: 254_600, unsettled: 0, availableToTrade: 254_600, availableToWithdraw: 254_600 } } },
        pending: [],
        balance: { account: { cash: 254_600, receivable: null } },
      },
    },
    {
      // The mark is of the contract as written. Sold: -18,000,000 x 0.45 / 100 = -81,000, against 54,600 received: 26,400 down.
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.45, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'floor', qty: -18_000_000, price: 0.45, value: -81_000, unrealized: -26_400, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: 0.45, markValue: -81_000 }],
        pnl: { account: { unrealized: -26_400, total: -26_400 } },
        nav: { account: 273_600, book: 973_600 }, // 254,600 + 100,000 - 81,000
        provisional: { account: false, book: false },
        balance: { account: { positions: -81_000, assets: 273_600, netAssets: 273_600 } },
      },
    },
    {
      // The terms state no variation margin: the end-of-day pass calls nothing, though the mark is 81,000 against the Account.
      id: 'no-variation-margin', covers: 'collateral', action: 'clock', to: eod('2026-04-02'),
      expect: { events: [], otc: [{ instrument: 'main', iaPosted: 100_000, vmPosted: 0, vmHeld: 0 }], alerts: [], cash: { account: { USD: { settled: 254_600, margin: 100_000, restricted: 0 } } } },
    },
    {
      // First floorlet: the fixing of 1 April, 3.90%, is above the 3.75% strike. Nothing is due.
      id: 'floorlet-out-of-the-money', covers: 'floorlet payment', action: 'clock', to: at('2026-07-01'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Nothing due on ${FLOOR_NAME}, leg A (floor), period 2026-04-01 to 2026-07-01: the TSFR3M fixing 3.900% is not below the strike 3.750%`, owner: 'account', date: '2026-07-01' }],
        cash: { account: { USD: { settled: 254_600, availableToTrade: 254_600 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-01', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
        ],
        pnl: { account: { realized: 0, total: -26_400 } },
        nav: { account: 273_600, book: 973_600 },
      },
    },
    { id: 'mid-august', action: 'clock', to: at('2026-08-14'), expect: {} },
    {
      // Half (9,000,000) is bought back for 0.50 per 100: 45,000 paid. Premium received on it: 54,600 / 2 = 27,300. Realized -17,700.
      // Left: -9,000,000 carrying -27,300, marked 0.45: -40,500, 13,200 down. Friday 14 August, settles Tuesday 18 August.
      id: 'partial-buy-back', covers: ['reduce', 'partial termination', 'collateral'], action: 'close', lot: 'floor', scope: 'strategy', percent: 50, order: { statedPrice: 0.50 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 9_000_000, estimate: 0.5, model: 'stated-price', settleDate: '2026-08-18', cash: -45_000, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 9_000_000, avgPrice: 0.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Terminated in part: 9,000,000 of 18,000,000 notional of FLOOR-TSFR-375 at 0.50 per 100 notional (realized -17,700.00 USD)' }], // the fixed independent amount stays
        cash: { account: { USD: { settled: 254_600, unsettled: -45_000, margin: 100_000, availableToTrade: 209_600, availableToWithdraw: 209_600 } } },
        positions: [{ instrument: 'main', lot: 'floor', qty: -9_000_000, cost: -27_300, avgCost: 0.3033333, price: 0.45, value: -40_500, unrealized: -13_200, notional: 9_000_000, margin: 100_000 }],
        holdings: { main: { long: 0, short: 9_000_000, net: -9_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-08-18', amount: -45_000, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -9_000_000, markValue: -40_500, iaRequired: 100_000, iaPosted: 100_000 }],
        pnl: { account: { realized: -17_700, unrealized: -13_200, total: -30_900 } },
        nav: { account: 269_100, book: 969_100 }, // 254,600 + 100,000 - 45,000 - 40,500
        balance: { account: { cash: 254_600, margin: 100_000, payable: 45_000, positions: -40_500, assets: 314_100, liabilities: 45_000, netAssets: 269_100 } },
      },
    },
    {
      id: 'settle-buy-back', covers: 'settlement', action: 'clock', to: at('2026-08-18'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 45,000.00 USD from settled cash', cash: { USD: -45_000 } }],
        cash: { account: { USD: { settled: 209_600, unsettled: 0, availableToTrade: 209_600, availableToWithdraw: 209_600 } } },
        pending: [],
        balance: { account: { cash: 209_600, payable: null, assets: 269_100, liabilities: 0 } },
      },
    },
    {
      // Second floorlet, paid: 9,000,000 x (3.75% - 3.60%) x 92/360 = 3,450.00.
      id: 'floorlet-paid', covers: 'floorlet payment', action: 'clock', to: at('2026-10-01'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${FLOOR_NAME}, leg A (floor), period 2026-07-01 to 2026-10-01: 3,450.00 USD`, cash: { USD: -3_450 }, owner: 'account', date: '2026-10-01' }],
        cash: { account: { USD: { settled: 206_150, availableToTrade: 206_150, availableToWithdraw: 206_150 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-04', status: 'pending' }, // 1 January is a holiday
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
        ],
        pnl: { account: { realized: -21_150, total: -34_350 } },
        nav: { account: 265_650, book: 965_650 },
        balance: { account: { cash: 206_150, assets: 265_650, netAssets: 265_650 } },
      },
    },
    {
      // Nothing is paid on the holiday itself.
      id: 'new-years-day', covers: 'payment across a holiday', action: 'clock', to: at('2027-01-01'),
      expect: { events: [], cash: { account: { USD: { settled: 206_150 } } }, lifecycle: [{ type: 'swap.payment', instrument: 'main', dueDate: '2027-01-04', status: 'pending' }, { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-01', status: 'pending' }] },
    },
    {
      // Third floorlet, paid Monday 4 January: 9,000,000 x (3.75% - 3.20%) x 92/360 = 12,650.00.
      id: 'floorlet-paid-after-holiday', covers: ['floorlet payment', 'payment across a holiday'], action: 'clock', to: at('2027-01-04'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${FLOOR_NAME}, leg A (floor), period 2026-10-01 to 2027-01-01: 12,650.00 USD`, cash: { USD: -12_650 }, date: '2027-01-04' }],
        cash: { account: { USD: { settled: 193_500, availableToTrade: 193_500, availableToWithdraw: 193_500 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
        ],
        pnl: { account: { realized: -33_800, total: -47_000 } },
        nav: { account: 253_000, book: 953_000 },
        balance: { account: { cash: 193_500, assets: 253_000, netAssets: 253_000 } },
      },
    },
    {
      // Maturity. The last period started on a holiday, so its fixing is 31 December's: 3.75%, exactly the strike. Nothing is due.
      // The floor ends: the 27,300 of premium still carried is earned, and the 100,000 comes back.
      // 300,000 + 45,000 + 9,600 - 45,000 - 3,450 - 12,650 = 293,500.
      id: 'maturity', covers: ['floorlet payment', 'maturity', 'close', 'collateral'], action: 'clock', to: at('2027-04-01'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Nothing due on ${FLOOR_NAME}, leg A (floor), period 2027-01-01 to 2027-04-01: the TSFR3M fixing 3.750% is not below the strike 3.750%`, date: '2027-04-01' },
          { type: 'swap.matured', summary: `Swap matured: ${FLOOR_NAME} (notional 9,000,000)`, owner: 'account' },
          { type: 'swap.collateral', summary: `Collateral returned on ${FLOOR_NAME} under its position-level terms: 100,000.00 USD (independent amount, the position ended)`, cash: { USD: 100_000 } },
        ],
        cash: { account: { USD: { settled: 293_500, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 293_500, availableToWithdraw: 293_500 } }, treasury: { USD: { settled: 700_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        pnl: { account: { realized: -6_500, commissions: 0, unrealized: 0, total: -6_500 } }, // -33,800 + 27,300
        nav: { account: 293_500, treasury: 700_000, book: 993_500 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 293_500, margin: null, positions: null, assets: 293_500, liabilities: 0, netAssets: 293_500 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// interest_rate_collar
// ---------------------------------------------------------------------------------------------
// A one-year collar on 3-month term SOFR: the Account buys a cap at 4.50% (leg A, received) and sells
// a floor at 3.50% (leg B, paid), for a small net premium. Each quarter, on the notional:
//   fixing above 4.50%: the cap leg pays the Account (fixing - 4.50%) x days/360;
//   fixing below 3.50%: the Account pays (3.50% - fixing) x days/360 on the floor leg;
//   in between: nothing is due on either leg. Each leg is its own payment record.
// Position-level collateral terms: no independent amount; variation margin with a 20,000 threshold
// and a 5,000 minimum transfer.
//
// Schedule (effective Monday 15 June 2026, maturity Tuesday 15 June 2027), every payment date a business day:
//   2026-06-15 to 2026-09-15 (92 days)  fixing of 15 June 4.80%       cap 0.30% in the money
//   2026-09-15 to 2026-12-15 (91 days)  fixing of 15 September 4.00%  between the strikes
//   2026-12-15 to 2027-03-15 (90 days)  fixing of 15 December 3.10%   floor 0.40% in the money
//   2027-03-15 to 2027-06-15 (92 days)  terminated before it is paid
const COLLAR_NAME = 'USD collar 3.50% / 4.50% on TSFR3M 15 Jun 2027';
const interestRateCollar = {
  productId: 'interest_rate_collar',
  title: 'USD 1-year collar on 3-month term SOFR, cap bought at 4.50% and floor sold at 3.50%, variation margin under position-level terms',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['schedule of both legs from the contract terms and the USD payment calendar', 'TSFR3M fixings (rate fixture standing in for Shaffer MarketData)', 'settlement date, T+2 on the USD calendar', 'variation margin from the position-level terms'],
    manualInputs: ['net premium (stated fill price, per 100 notional)', 'mark of the collar, entered by hand (negative when the floor is worth more than the cap)', 'settlement amounts of the partial and the full termination (stated fill price in the preview)'],
    settlement: 'Net premium and termination amounts settle T+2 on the USD calendar; leg payments are cash on their payment date',
    lifecycle: 'Two legs with their own strikes: the cap leg pays above 4.50%, the floor leg is paid below 3.50%, and between the strikes both legs record that nothing is due; partial termination; full termination before maturity, after which nothing is scheduled',
    accounting: 'Carried at the net premium until a mark is entered, then at the mark, which can be negative; leg payments and termination results are realized P&L',
    collateral: 'Position-level terms with no independent amount: variation margin at end of day against the mark, threshold 20,000, minimum transfer 5,000; posted when the mark is against the Account, received (restricted, owed back) when it is in its favour, reduced after a partial termination and returned at once on full termination',
  },
  start: at('2026-06-11'),
  settlementCheck: { lag: 2, holidays: [] }, // no Federal Reserve holiday in the settlement windows used (11 to 16 June, 1 to 5 October 2026, 1 to 5 April 2027)
  book: usdBook('Matrix interest-rate collar', 'Rates', 400_000),
  instruments: {
    main: {
      productId: 'interest_rate_collar', name: COLLAR_NAME, symbol: 'COLLAR-TSFR-350-450', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: USD_CALENDARS,
      terms: {
        effective: '2026-06-15', maturity: '2027-06-15', counterparty: 'Dealer A',
        collateralBasis: { type: 'position', independentAmount: { type: 'none' }, variationMargin: true, threshold: 20_000, minimumTransfer: 5_000 },
        legs: [
          { side: 'receive', type: 'cap', ccy: 'USD', index: 'TSFR3M', strike: 0.045, months: 3, dayCount: 'ACT/360' },
          { side: 'pay', type: 'floor', ccy: 'USD', index: 'TSFR3M', strike: 0.035, months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  rates: { TSFR3M: { byDate: { '2026-06-15': 4.80, '2026-09-15': 4.00, '2026-12-15': 3.10, '2027-03-15': 4.50 } } },
  expectAtStart: usdStart(400_000),
  steps: [
    {
      // Net premium 20,000,000 x 0.05 / 100 = 10,000, settling Monday 15 June (T+2). No independent amount is called for.
      id: 'open', covers: ['open', 'premium', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 20_000_000, as: 'collar', order: { statedPrice: 0.05 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 20_000_000, estimate: 0.05, model: 'stated-price', settleDate: '2026-06-15', calendar: 'USD', cash: -10_000, fees: 0 }],
          cash: { USD: { purchases: 10_000, fees: 0, margin: 0, required: 10_000, available: 400_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20_000_000, avgPrice: 0.05, fills: [{ qty: 20_000_000, price: 0.05, model: 'stated-price', settleDate: '2026-06-15' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Entered as written: 20,000,000 notional of COLLAR-TSFR-350-450 at 0.05 per 100 notional', owner: 'account', date: '2026-06-11' }], // nothing is posted
        cash: { account: { USD: { settled: 400_000, unsettled: -10_000, margin: 0, restricted: 0, availableToTrade: 390_000, availableToWithdraw: 390_000 } } },
        positions: [{ instrument: 'main', lot: 'collar', owner: 'account', direction: 'as written', qty: 20_000_000, avgCost: 0.05, cost: 10_000, price: null, value: null, unrealized: null, provisional: true, notional: 20_000_000, margin: 0 }],
        holdings: { main: { long: 20_000_000, short: 0, net: 20_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-06-15', amount: -10_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-15', status: 'pending' }, // cap leg
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-15', status: 'pending' }, // floor leg
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'collar', owner: 'account', qty: 20_000_000, basis: 'position', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0, vmStatus: 'not_valued_yet' }],
        pnl: { account: { realized: 0, commissions: 0, unrealized: 0, total: 0 } },
        nav: { account: 400_000, book: 1_000_000 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 400_000, payable: 10_000, margin: null, positions: 10_000, accruedIncome: null, accruedExpense: null, assets: 410_000, liabilities: 10_000, netAssets: 400_000 } },
      },
    },
    {
      // The end-of-day pass for 11 June has no mark to work with: no variation margin can be called, and that is said.
      id: 'no-mark-no-call', covers: 'variation margin', action: 'clock', to: at('2026-06-12'),
      expect: { otc: [{ instrument: 'main', vmStatus: 'cannot_value', vmReason: /COLLAR-TSFR-350-450 has no mark/, vmPosted: 0 }], alerts: ['collateral.unvalued'] },
    },
    {
      // 5,000,000 more on the same terms: 2,500, settling Tuesday 16 June.
      id: 'increase', covers: ['increase', 'premium'], action: 'resize', lot: 'collar', factor: 1.25, order: { statedPrice: 0.05 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 0.05, model: 'stated-price', settleDate: '2026-06-16', cash: -2_500, fees: 0 }], cash: { USD: { purchases: 2_500, margin: 0, required: 2_500, available: 390_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 5_000_000, avgPrice: 0.05 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Increased as written: 5,000,000 notional of COLLAR-TSFR-350-450 at 0.05 per 100 notional' }],
        cash: { account: { USD: { settled: 400_000, unsettled: -12_500, availableToTrade: 387_500, availableToWithdraw: 387_500 } } },
        positions: [{ instrument: 'main', lot: 'collar', qty: 25_000_000, cost: 12_500, avgCost: 0.05, price: null, value: null, notional: 25_000_000 }],
        holdings: { main: { long: 25_000_000, short: 0, net: 25_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-06-15', amount: -10_000, ccy: 'USD', into: 'cash' }, { instrument: 'main', dueDate: '2026-06-16', amount: -2_500, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 25_000_000, iaRequired: 0, iaPosted: 0 }],
        nav: { account: 400_000, book: 1_000_000 },
        balance: { account: { payable: 12_500, positions: 12_500, assets: 412_500, liabilities: 12_500, netAssets: 400_000 } },
      },
    },
    {
      id: 'settle-premium', covers: 'settlement', action: 'clock', to: at('2026-06-15'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 10,000.00 USD from settled cash', cash: { USD: -10_000 }, date: '2026-06-15' }],
        cash: { account: { USD: { settled: 390_000, unsettled: -2_500, availableToTrade: 387_500, availableToWithdraw: 387_500 } } },
        pending: [{ instrument: 'main', dueDate: '2026-06-16', amount: -2_500, ccy: 'USD', into: 'cash' }],
        balance: { account: { cash: 390_000, payable: 2_500, assets: 402_500, liabilities: 2_500 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-06-16'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,500.00 USD from settled cash', cash: { USD: -2_500 } }],
        cash: { account: { USD: { settled: 387_500, unsettled: 0, availableToTrade: 387_500, availableToWithdraw: 387_500 } } },
        pending: [],
        balance: { account: { cash: 387_500, payable: null, assets: 400_000, liabilities: 0 } },
      },
    },
    {
      // Rates have fallen: the floor sold is worth more than the cap bought. 25,000,000 x -0.20 / 100 = -50,000; 62,500 below the 12,500 paid.
      id: 'mark-negative', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.20, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'collar', qty: 25_000_000, price: -0.2, value: -50_000, unrealized: -62_500, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: -0.2, markValue: -50_000 }],
        pnl: { account: { unrealized: -62_500, total: -62_500 } },
        nav: { account: 337_500, book: 937_500 }, // 387,500 - 50,000
        provisional: { account: false, book: false },
        balance: { account: { positions: -50_000, assets: 337_500, netAssets: 337_500 } },
      },
    },
    {
      // -50,000 is 30,000 beyond the 20,000 threshold: 30,000 is posted.
      id: 'variation-margin-call', covers: 'variation margin', action: 'clock', to: eod('2026-06-16'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 30,000.00 USD posted. Netting set of 1 position marked at -50,000.00 USD; threshold 20,000.00 USD.', cash: { USD: -30_000 }, owner: 'account', date: '2026-06-16' }],
        cash: { account: { USD: { settled: 357_500, margin: 30_000, availableToTrade: 357_500, availableToWithdraw: 357_500 } } },
        otc: [{ instrument: 'main', vmPosted: 30_000, vmHeld: 0, vmExposure: -50_000, vmStatus: 'ok' }],
        positions: [{ instrument: 'main', lot: 'collar', margin: 0 }], // the position's own margin figure is its independent amount; variation margin belongs to the netting set and shows under collateral
        alerts: [],
        balance: { account: { cash: 357_500, margin: 30_000 } },
      },
    },
    { id: 'wednesday-morning', action: 'clock', to: at('2026-06-17'), expect: {} },
    {
      // Rates jump: 25,000,000 x 0.30 / 100 = 75,000; 62,500 above the 12,500 paid.
      id: 'mark-positive', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.30, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'collar', price: 0.3, value: 75_000, unrealized: 62_500 }],
        otc: [{ instrument: 'main', mark: 0.3, markValue: 75_000 }],
        pnl: { account: { unrealized: 62_500, total: 62_500 } },
        nav: { account: 462_500, book: 1_062_500 }, // 357,500 + 30,000 posted + 75,000
        balance: { account: { positions: 75_000, assets: 462_500, netAssets: 462_500 } },
      },
    },
    {
      // +75,000 is 55,000 beyond the threshold, in the Account's favour: its own 30,000 comes back and the counterparty posts 55,000,
      // which is restricted cash and a liability.
      id: 'variation-margin-swings', covers: 'variation margin', action: 'clock', to: eod('2026-06-17'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 30,000.00 USD returned to us and 55,000.00 USD received. Netting set of 1 position marked at 75,000.00 USD; threshold 20,000.00 USD.', owner: 'account', date: '2026-06-17' }],
        cash: { account: { USD: { settled: 387_500, margin: 0, restricted: 55_000, availableToTrade: 387_500, availableToWithdraw: 387_500 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 55_000, vmExposure: 75_000, vmStatus: 'ok' }],
        nav: { account: 462_500, book: 1_062_500 }, // unchanged: what was received is owed back
        balance: { account: { cash: 387_500, margin: null, restricted: 55_000, collateralReceived: 55_000, assets: 517_500, liabilities: 55_000, netAssets: 462_500 } },
      },
    },
    {
      // First period, fixing 4.80%. Cap leg, received: 25,000,000 x (4.80% - 4.50%) x 92/360 = 19,166.67. Floor leg: 4.80% is not below 3.50%.
      id: 'cap-leg-pays', covers: ['caplet payment', 'floorlet payment'], action: 'clock', to: at('2026-09-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${COLLAR_NAME}, leg A (cap), period 2026-06-15 to 2026-09-15: 19,166.67 USD`, cash: { USD: 19_166.67 }, owner: 'account', date: '2026-09-15' },
          { type: 'swap.payment', summary: `Nothing due on ${COLLAR_NAME}, leg B (floor), period 2026-06-15 to 2026-09-15: the TSFR3M fixing 4.800% is not below the strike 3.500%`, owner: 'account', date: '2026-09-15' },
        ],
        cash: { account: { USD: { settled: 406_666.67, restricted: 55_000, availableToTrade: 406_666.67, availableToWithdraw: 406_666.67 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
        ],
        pnl: { account: { realized: 19_166.67, unrealized: 62_500, total: 81_666.67 } },
        nav: { account: 481_666.67, book: 1_081_666.67 },
        balance: { account: { cash: 406_666.67, assets: 536_666.67, liabilities: 55_000, netAssets: 481_666.67 } },
      },
    },
    { id: 'first-of-october', action: 'clock', to: at('2026-10-01'), expect: {} },
    {
      // 40% (10,000,000) is terminated for 0.25 per 100, received: 25,000. Premium carried on it: 12,500 x 40% = 5,000. Realized 20,000.
      // Left: 15,000,000 carrying 7,500, marked 0.30: 45,000, 37,500 up. Thursday 1 October, settles Monday 5 October.
      id: 'partial-termination', covers: ['reduce', 'partial termination'], action: 'close', lot: 'collar', scope: 'strategy', percent: 40, order: { statedPrice: 0.25 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 10_000_000, estimate: 0.25, model: 'stated-price', settleDate: '2026-10-05', cash: 25_000, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 10_000_000, avgPrice: 0.25 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Terminated in part: 10,000,000 of 25,000,000 notional of COLLAR-TSFR-350-450 at 0.25 per 100 notional (realized 20,000.00 USD)' }],
        cash: { account: { USD: { settled: 406_666.67, unsettled: 25_000, restricted: 55_000, availableToTrade: 431_666.67, availableToWithdraw: 406_666.67 } } },
        positions: [{ instrument: 'main', lot: 'collar', qty: 15_000_000, cost: 7_500, avgCost: 0.05, price: 0.3, value: 45_000, unrealized: 37_500, notional: 15_000_000 }],
        holdings: { main: { long: 15_000_000, short: 0, net: 15_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-10-05', amount: 25_000, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 15_000_000, markValue: 45_000, vmHeld: 55_000 }], // the collateral held is looked at again at the end of the day
        pnl: { account: { realized: 39_166.67, unrealized: 37_500, total: 76_666.67 } },
        nav: { account: 476_666.67, book: 1_076_666.67 },
        balance: { account: { cash: 406_666.67, restricted: 55_000, receivable: 25_000, positions: 45_000, collateralReceived: 55_000, assets: 531_666.67, liabilities: 55_000, netAssets: 476_666.67 } },
      },
    },
    {
      // +45,000 is 25,000 beyond the threshold: of the 55,000 held, 30,000 goes back to the counterparty.
      id: 'collateral-partly-given-back', covers: ['variation margin', 'collateral'], action: 'clock', to: eod('2026-10-01'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 30,000.00 USD returned to the counterparty. Netting set of 1 position marked at 45,000.00 USD; threshold 20,000.00 USD.', owner: 'account', date: '2026-10-01' }],
        cash: { account: { USD: { settled: 406_666.67, restricted: 25_000, availableToTrade: 431_666.67, availableToWithdraw: 406_666.67 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 25_000, vmExposure: 45_000, vmStatus: 'ok' }],
        nav: { account: 476_666.67, book: 1_076_666.67 },
        balance: { account: { restricted: 25_000, collateralReceived: 25_000, assets: 501_666.67, liabilities: 25_000, netAssets: 476_666.67 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2026-10-05'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 25,000.00 USD into settled cash', cash: { USD: 25_000 } }],
        cash: { account: { USD: { settled: 431_666.67, unsettled: 0, restricted: 25_000, availableToTrade: 431_666.67, availableToWithdraw: 431_666.67 } } },
        pending: [],
        balance: { account: { cash: 431_666.67, receivable: null } },
      },
    },
    {
      // Second period, fixing 4.00%: between the strikes. Nothing is due on either leg, and each leg says so.
      id: 'between-the-strikes', covers: ['caplet payment', 'floorlet payment'], action: 'clock', to: at('2026-12-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Nothing due on ${COLLAR_NAME}, leg A (cap), period 2026-09-15 to 2026-12-15: the TSFR3M fixing 4.000% is not above the strike 4.500%`, date: '2026-12-15' },
          { type: 'swap.payment', summary: `Nothing due on ${COLLAR_NAME}, leg B (floor), period 2026-09-15 to 2026-12-15: the TSFR3M fixing 4.000% is not below the strike 3.500%`, date: '2026-12-15' },
        ],
        cash: { account: { USD: { settled: 431_666.67, restricted: 25_000 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
        ],
        pnl: { account: { realized: 39_166.67, total: 76_666.67 } },
        nav: { account: 476_666.67, book: 1_076_666.67 },
      },
    },
    {
      // Third period, fixing 3.10%. Cap leg: nothing. Floor leg, paid: 15,000,000 x (3.50% - 3.10%) x 90/360 = 15,000.00.
      id: 'floor-leg-is-paid', covers: ['caplet payment', 'floorlet payment'], action: 'clock', to: at('2027-03-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Nothing due on ${COLLAR_NAME}, leg A (cap), period 2026-12-15 to 2027-03-15: the TSFR3M fixing 3.100% is not above the strike 4.500%`, date: '2027-03-15' },
          { type: 'swap.payment', summary: `Swap payment on ${COLLAR_NAME}, leg B (floor), period 2026-12-15 to 2027-03-15: 15,000.00 USD`, cash: { USD: -15_000 }, owner: 'account', date: '2027-03-15' },
        ],
        cash: { account: { USD: { settled: 416_666.67, restricted: 25_000, availableToTrade: 416_666.67, availableToWithdraw: 416_666.67 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
        ],
        pnl: { account: { realized: 24_166.67, total: 61_666.67 } },
        nav: { account: 461_666.67, book: 1_061_666.67 },
        balance: { account: { cash: 416_666.67, assets: 486_666.67, liabilities: 25_000, netAssets: 461_666.67 } },
      },
    },
    { id: 'first-of-april', action: 'clock', to: at('2027-04-01'), expect: {} },
    {
      // The rest is terminated at -0.10 per 100, paid: 15,000,000 x 0.10 / 100 = 15,000. With the 7,500 still carried, realized -22,500.
      // The 25,000 held is no longer owed to anything: it goes back to the counterparty at once. Thursday 1 April, settles Monday 5 April.
      id: 'full-termination', covers: ['close', 'full termination', 'collateral'], action: 'close', lot: 'collar', scope: 'position', percent: 100, order: { statedPrice: -0.10 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 15_000_000, estimate: -0.1, model: 'stated-price', settleDate: '2027-04-05', cash: -15_000, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 15_000_000, avgPrice: -0.1 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated: 15,000,000 notional of COLLAR-TSFR-350-450 at -0.10 per 100 notional (realized -22,500.00 USD)' },
          { type: 'collateral.variation', summary: /Variation margin under position-level terms: 25,000\.00 USD returned to the counterparty\./, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 416_666.67, unsettled: -15_000, margin: 0, restricted: 0, availableToTrade: 401_666.67, availableToWithdraw: 401_666.67 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-04-05', amount: -15_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 1_666.67, commissions: 0, unrealized: 0, total: 1_666.67 } }, // 24,166.67 - 22,500
        nav: { account: 401_666.67, book: 1_001_666.67 },
        balance: { account: { cash: 416_666.67, restricted: null, collateralReceived: null, positions: null, payable: 15_000, assets: 416_666.67, liabilities: 15_000, netAssets: 401_666.67 } },
      },
    },
    {
      id: 'settle-full-termination', covers: 'settlement', action: 'clock', to: at('2027-04-05'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 15,000.00 USD from settled cash', cash: { USD: -15_000 } }],
        cash: { account: { USD: { settled: 401_666.67, unsettled: 0, availableToTrade: 401_666.67, availableToWithdraw: 401_666.67 } } },
        pending: [],
        balance: { account: { cash: 401_666.67, payable: null, assets: 401_666.67, liabilities: 0, netAssets: 401_666.67 } },
      },
    },
    {
      // The contract's own maturity date: nothing is paid, scheduled, posted or held.
      // 400,000 - 10,000 - 2,500 + 19,166.67 + 25,000 - 15,000 - 15,000 = 401,666.67.
      id: 'nothing-left-at-maturity', covers: 'close', action: 'clock', to: at('2027-06-15'),
      expect: {
        events: [], lifecycle: [], positions: [], pending: [], otc: [], alerts: [],
        cash: { account: { USD: { settled: 401_666.67, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 401_666.67 } }, treasury: { USD: { settled: 600_000 } } },
        nav: { account: 401_666.67, treasury: 600_000, book: 1_001_666.67 },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// forward_starting_swap
// ---------------------------------------------------------------------------------------------
// A one-year US dollar swap agreed on 10 March 2026 that only starts on 15 September 2026. The contract is
// written "pay 3.60% fixed annually ACT/360, receive 3-month term SOFR quarterly ACT/360"; the Account
// enters the opposite side: it receives the fixed amount and pays the floating amounts.
// Before the effective date nothing is paid, nothing is exchanged and no fixing is used; the contract
// still has a value (the mark), and collateral follows that value from the trade date.
// Position-level collateral terms: independent amount 1% of notional; variation margin with a 25,000
// threshold and a 5,000 minimum transfer. Commission: 20.00 per million of notional.
//
// Schedule (effective Tuesday 15 September 2026, maturity Wednesday 15 September 2027), every payment date a business day:
//   fixed     2026-09-15 to 2027-09-15 (365 days), paid 15 September 2027
//   floating  2026-09-15 to 2026-12-15 (91 days)  fixing of 15 September 2026: 3.70%
//             2026-12-15 to 2027-03-15 (90 days)  fixing of 15 December 2026: 3.55%
//             2027-03-15 to 2027-06-15 (92 days)  fixing of 15 March 2027: 3.40%
//             2027-06-15 to 2027-09-15 (92 days)  fixing of 15 June 2027: 3.25%
//   The 4.90% published on 1 June 2026, before the swap starts, must play no part.
const FWD_NAME = 'USD forward-starting IRS 3.60% v TSFR3M 15 Sep 2026 to 15 Sep 2027';
const forwardStartingSwap = {
  productId: 'forward_starting_swap',
  title: 'USD swap starting six months forward, receive 3.60% fixed against 3-month term SOFR, held to maturity',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['payment schedule of each leg from the effective date, the maturity and the USD payment calendar', 'TSFR3M fixings from the effective date on (rate fixture standing in for Shaffer MarketData)', 'settlement date, T+2 on the USD calendar', 'commission from the Book fee schedule', 'independent amount and variation margin from the position-level terms'],
    manualInputs: ['upfront amount (stated fill price)', 'mark of the contract, entered by hand, from the trade date', 'settlement amount of a partial termination (stated fill price in the preview)'],
    settlement: 'Upfront amounts and commission settle T+2 on the USD calendar; leg payments are cash on their payment date',
    lifecycle: 'Nothing is paid or fixed between the trade date and the effective date, and nothing happens on the effective date itself; floating payments each quarter after it; the fixed amount once, at maturity; increase before the start; partial termination after it; maturity',
    accounting: 'Carried at the mark from the trade date (a forward-starting swap has a value before it starts); leg payments and the termination result are realized P&L; commission expensed',
    collateral: 'Position-level terms: independent amount 1% of notional from the trade date, trued up on increase and partial termination, returned at maturity; variation margin at end of day against the mark, threshold 25,000, minimum transfer 5,000, called and returned before the swap has started',
  },
  start: at('2026-03-10'),
  settlementCheck: { lag: 2, holidays: [] }, // no Federal Reserve holiday in the settlement windows used (10 to 12 March, 1 to 3 June 2026, 12 to 14 January 2027)
  book: usdBook('Matrix forward-starting swap', 'Rates', 500_000, { perUnit: 0.00002, minimum: 0, bps: 0 }),
  instruments: {
    main: {
      productId: 'forward_starting_swap', name: FWD_NAME, symbol: 'FWD-IRS-0927', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: USD_CALENDARS,
      terms: {
        effective: '2026-09-15', maturity: '2027-09-15', counterparty: 'Dealer A',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.01 }, variationMargin: true, threshold: 25_000, minimumTransfer: 5_000 },
        legs: [
          { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.036, months: 12, dayCount: 'ACT/360' },
          { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0, months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  rates: { TSFR3M: { byDate: { '2026-06-01': 4.90, '2026-09-15': 3.70, '2026-12-15': 3.55, '2027-03-15': 3.40, '2027-06-15': 3.25 } } },
  expectAtStart: usdStart(500_000),
  steps: [
    {
      // Opposite side, 8,000,000, no upfront amount. Independent amount 1% x 8,000,000 = 80,000, posted now, six months before the start.
      // Commission 8,000,000 x 0.00002 = 160, settling Thursday 12 March. The first payments scheduled are those after the effective date.
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'sell', qty: 8_000_000, as: 'fwd', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 8_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-03-12', calendar: 'USD', cash: 0, fees: 160 }],
          cash: { USD: { fees: 160, margin: 80_000, required: 80_160, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 8_000_000, avgPrice: 0, fills: [{ qty: 8_000_000, price: 0, model: 'stated-price', settleDate: '2026-03-12' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered on the opposite side: 8,000,000 notional of FWD-IRS-0927 at 0.00 per 100 notional', owner: 'account', date: '2026-03-10' },
          { type: 'swap.collateral', summary: `Collateral posted on ${FWD_NAME} under its position-level terms: 80,000.00 USD (independent amount, 1.00% of 8,000,000.00 USD notional)`, cash: { USD: -80_000 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 420_000, unsettled: -160, margin: 80_000, restricted: 0, availableToTrade: 419_840, availableToWithdraw: 419_840 } } },
        positions: [{ instrument: 'main', lot: 'fwd', owner: 'account', direction: 'opposite side', qty: -8_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 8_000_000, margin: 80_000, accrued: 0 }],
        holdings: { main: { long: 0, short: 8_000_000, net: -8_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-03-12', amount: -160, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' }, // first floating payment, three months after the start
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-15', status: 'pending' }, // the fixed amount
        ],
        otc: [{ instrument: 'main', lot: 'fwd', owner: 'account', qty: -8_000_000, basis: 'position', mark: null, iaRequired: 80_000, iaPosted: 80_000, vmPosted: 0, vmHeld: 0, vmStatus: 'not_valued_yet' }],
        pnl: { account: { realized: 0, commissions: -160, fees: 0, unrealized: 0, total: -160 } },
        nav: { account: 499_840, book: 999_840 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 420_000, margin: 80_000, payable: 160, positions: null, accruedIncome: null, accruedExpense: null, assets: 500_000, liabilities: 160, netAssets: 499_840 } },
      },
    },
    {
      id: 'no-mark-no-call', covers: 'variation margin', action: 'clock', to: at('2026-03-11'),
      expect: { otc: [{ instrument: 'main', vmStatus: 'cannot_value', vmReason: /FWD-IRS-0927 has no mark/, vmPosted: 0 }], alerts: ['collateral.unvalued'] },
    },
    {
      // The mark is of the contract as written (pay fixed). On the opposite side: -8,000,000 x 0.40 / 100 = -32,000, six months before the start.
      id: 'mark-before-the-start', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.40, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'fwd', qty: -8_000_000, price: 0.4, value: -32_000, unrealized: -32_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: 0.4, markValue: -32_000 }],
        pnl: { account: { unrealized: -32_000, total: -32_160 } },
        nav: { account: 467_840, book: 967_840 },
        provisional: { account: false, book: false },
        balance: { account: { positions: -32_000, assets: 468_000, liabilities: 160, netAssets: 467_840 } },
      },
    },
    {
      // -32,000 is 7,000 beyond the 25,000 threshold: 7,000 is posted (more than the 5,000 minimum transfer).
      id: 'variation-margin-call', covers: 'variation margin', action: 'clock', to: eod('2026-03-11'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 7,000.00 USD posted. Netting set of 1 position marked at -32,000.00 USD; threshold 25,000.00 USD.', cash: { USD: -7_000 }, owner: 'account', date: '2026-03-11' }],
        cash: { account: { USD: { settled: 413_000, margin: 87_000, availableToTrade: 412_840, availableToWithdraw: 412_840 } } },
        otc: [{ instrument: 'main', vmPosted: 7_000, vmHeld: 0, vmExposure: -32_000, vmStatus: 'ok' }],
        alerts: [],
        balance: { account: { cash: 413_000, margin: 87_000 } },
      },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-03-12'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 160.00 USD from settled cash', cash: { USD: -160 }, date: '2026-03-12' }],
        cash: { account: { USD: { settled: 412_840, unsettled: 0, availableToTrade: 412_840, availableToWithdraw: 412_840 } } },
        pending: [],
        balance: { account: { cash: 412_840, payable: null, assets: 467_840, liabilities: 0 } },
      },
    },
    {
      id: 'mark-improves', action: 'manual_price', instrument: 'main', value: 0.10, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'fwd', price: 0.1, value: -8_000, unrealized: -8_000 }], // -8,000,000 x 0.10 / 100
        otc: [{ instrument: 'main', mark: 0.1, markValue: -8_000 }],
        pnl: { account: { unrealized: -8_000, total: -8_160 } },
        nav: { account: 491_840, book: 991_840 },
        balance: { account: { positions: -8_000, assets: 491_840, netAssets: 491_840 } },
      },
    },
    {
      // -8,000 is inside the threshold: the 7,000 comes back.
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-03-12'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 7,000.00 USD returned to us. Netting set of 1 position marked at -8,000.00 USD; threshold 25,000.00 USD.', cash: { USD: 7_000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 419_840, margin: 80_000, availableToTrade: 419_840, availableToWithdraw: 419_840 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 0, vmExposure: -8_000, vmStatus: 'ok', vmReason: null }],
        balance: { account: { cash: 419_840, margin: 80_000 } },
      },
    },
    {
      // Eleven weeks pass. A fixing is published on 1 June; the swap has not started and takes no notice of it.
      id: 'nothing-before-the-start', covers: 'before the effective date', action: 'clock', to: at('2026-06-01'),
      expect: {
        events: [],
        cash: { account: { USD: { settled: 419_840, unsettled: 0, margin: 80_000, restricted: 0 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
        ],
        positions: [{ instrument: 'main', lot: 'fwd', qty: -8_000_000, value: -8_000, accrued: 0 }],
        alerts: [], pending: [],
        nav: { account: 491_840, book: 991_840 },
      },
    },
    {
      // 4,000,000 more on the opposite side at 0.10 per 100: 4,000 is received. Commission 4,000,000 x 0.00002 = 80. Settles Wednesday 3 June.
      // Independent amount 1% x 12,000,000 = 120,000: 40,000 more. Average upfront 4,000 / 120,000 = 0.0333333 per 100.
      id: 'increase-before-the-start', covers: ['increase', 'collateral', 'before the effective date'], action: 'resize', lot: 'fwd', factor: 1.5, order: { statedPrice: 0.10 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 4_000_000, estimate: 0.1, model: 'stated-price', settleDate: '2026-06-03', cash: 4_000, fees: 80 }],
          cash: { USD: { proceeds: 4_000, fees: 80, margin: 40_000, required: 40_080, available: 419_840, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 4_000_000, avgPrice: 0.1 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Increased on the opposite side: 4,000,000 notional of FWD-IRS-0927 at 0.10 per 100 notional' },
          { type: 'swap.collateral', summary: `Collateral posted on ${FWD_NAME} under its position-level terms: 40,000.00 USD (independent amount, 1.00% of 12,000,000.00 USD notional)`, cash: { USD: -40_000 } },
        ],
        cash: { account: { USD: { settled: 379_840, unsettled: 3_920, margin: 120_000, availableToTrade: 383_760, availableToWithdraw: 379_840 } } },
        positions: [{ instrument: 'main', lot: 'fwd', qty: -12_000_000, cost: -4_000, avgCost: 0.0333333, price: 0.1, value: -12_000, unrealized: -8_000, notional: 12_000_000, margin: 120_000 }],
        holdings: { main: { long: 0, short: 12_000_000, net: -12_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-06-03', amount: 3_920, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -12_000_000, markValue: -12_000, iaRequired: 120_000, iaPosted: 120_000 }],
        pnl: { account: { commissions: -240, unrealized: -8_000, total: -8_240 } },
        nav: { account: 491_760, book: 991_760 },
        balance: { account: { cash: 379_840, margin: 120_000, receivable: 3_920, positions: -12_000, assets: 491_760, liabilities: 0, netAssets: 491_760 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-06-03'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 3,920.00 USD into settled cash', cash: { USD: 3_920 } }],
        cash: { account: { USD: { settled: 383_760, unsettled: 0, availableToTrade: 383_760, availableToWithdraw: 383_760 } } },
        pending: [],
        balance: { account: { cash: 383_760, receivable: null } },
      },
    },
    {
      // The effective date itself: a single-currency swap exchanges nothing, and the first amounts fall due three and twelve months later.
      id: 'effective-date', covers: 'before the effective date', action: 'clock', to: at('2026-09-15'),
      expect: {
        events: [],
        cash: { account: { USD: { settled: 383_760, unsettled: 0, margin: 120_000, restricted: 0 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
        ],
        pnl: { account: { realized: 0, commissions: -240, unrealized: -8_000, total: -8_240 } },
        nav: { account: 491_760, book: 991_760 },
      },
    },
    {
      // First floating amount, paid, at the fixing of 15 September (3.70%), not the 4.90% of June: 12,000,000 x 3.70% x 91/360 = 112,233.33.
      id: 'first-floating-payment', covers: 'floating payment', action: 'clock', to: at('2026-12-15'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${FWD_NAME}, leg B (float), period 2026-09-15 to 2026-12-15: 112,233.33 USD`, cash: { USD: -112_233.33 }, owner: 'account', date: '2026-12-15' }],
        cash: { account: { USD: { settled: 271_526.67, availableToTrade: 271_526.67, availableToWithdraw: 271_526.67 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
        ],
        pnl: { account: { realized: -112_233.33, total: -120_473.33 } },
        nav: { account: 379_526.67, book: 879_526.67 },
        balance: { account: { cash: 271_526.67, accruedIncome: null, accruedExpense: null, assets: 379_526.67, netAssets: 379_526.67 } },
      },
    },
    { id: 'mid-january', action: 'clock', to: at('2027-01-12'), expect: {} },
    {
      // A quarter (3,000,000) is bought back at 0.20 per 100: 6,000 paid, commission 60, settling Thursday 14 January.
      // Upfront carried on it: 4,000 x 25% = 1,000 received. Realized 1,000 - 6,000 = -5,000. Independent amount 1% x 9,000,000 = 90,000: 30,000 returns.
      id: 'partial-termination', covers: ['reduce', 'partial termination', 'collateral'], action: 'close', lot: 'fwd', scope: 'strategy', percent: 25, order: { statedPrice: 0.20 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 3_000_000, estimate: 0.2, model: 'stated-price', settleDate: '2027-01-14', cash: -6_000, fees: 60 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 3_000_000, avgPrice: 0.2 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated in part: 3,000,000 of 12,000,000 notional of FWD-IRS-0927 at 0.20 per 100 notional (realized -5,000.00 USD)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${FWD_NAME} under its position-level terms: 30,000.00 USD (independent amount, 1.00% of 9,000,000.00 USD notional)`, cash: { USD: 30_000 } },
        ],
        cash: { account: { USD: { settled: 301_526.67, unsettled: -6_060, margin: 90_000, availableToTrade: 295_466.67, availableToWithdraw: 295_466.67 } } },
        positions: [{ instrument: 'main', lot: 'fwd', qty: -9_000_000, cost: -3_000, avgCost: 0.0333333, price: 0.1, value: -9_000, unrealized: -6_000, notional: 9_000_000, margin: 90_000 }],
        holdings: { main: { long: 0, short: 9_000_000, net: -9_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-01-14', amount: -6_060, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -9_000_000, markValue: -9_000, iaRequired: 90_000, iaPosted: 90_000 }],
        pnl: { account: { realized: -117_233.33, commissions: -300, unrealized: -6_000, total: -123_533.33 } },
        nav: { account: 376_466.67, book: 876_466.67 },
        balance: { account: { cash: 301_526.67, margin: 90_000, positions: -9_000, payable: 6_060, assets: 382_526.67, liabilities: 6_060, netAssets: 376_466.67 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2027-01-14'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 6,060.00 USD from settled cash', cash: { USD: -6_060 } }],
        cash: { account: { USD: { settled: 295_466.67, unsettled: 0, availableToTrade: 295_466.67, availableToWithdraw: 295_466.67 } } },
        pending: [],
        balance: { account: { cash: 295_466.67, payable: null, assets: 376_466.67, liabilities: 0 } },
      },
    },
    {
      // Second floating amount, on the 9,000,000 left: 9,000,000 x 3.55% x 90/360 = 79,875.00.
      id: 'second-floating-payment', covers: 'floating payment', action: 'clock', to: at('2027-03-15'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${FWD_NAME}, leg B (float), period 2026-12-15 to 2027-03-15: 79,875.00 USD`, cash: { USD: -79_875 }, date: '2027-03-15' }],
        cash: { account: { USD: { settled: 215_591.67, availableToTrade: 215_591.67, availableToWithdraw: 215_591.67 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
        ],
        pnl: { account: { realized: -197_108.33, total: -203_408.33 } },
        nav: { account: 296_591.67, book: 796_591.67 },
        balance: { account: { cash: 215_591.67, assets: 296_591.67, netAssets: 296_591.67 } },
      },
    },
    {
      // Third floating amount: 9,000,000 x 3.40% x 92/360 = 78,200.00.
      id: 'third-floating-payment', covers: 'floating payment', action: 'clock', to: at('2027-06-15'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${FWD_NAME}, leg B (float), period 2027-03-15 to 2027-06-15: 78,200.00 USD`, cash: { USD: -78_200 }, date: '2027-06-15' }],
        cash: { account: { USD: { settled: 137_391.67, availableToTrade: 137_391.67, availableToWithdraw: 137_391.67 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-15', status: 'pending' },
        ],
        pnl: { account: { realized: -275_308.33, total: -281_608.33 } },
        nav: { account: 218_391.67, book: 718_391.67 },
        balance: { account: { cash: 137_391.67, assets: 218_391.67, netAssets: 218_391.67 } },
      },
    },
    {
      // Maturity. Fixed amount, received once: 9,000,000 x 3.60% x 365/360 = 328,500.00. Last floating amount, paid: 9,000,000 x 3.25% x 92/360 = 74,750.00.
      // The swap ends: the 3,000 of upfront still carried is earned and the 90,000 comes back.
      // 500,000 + 4,000 - 6,000 - 300 - 112,233.33 - 79,875 - 78,200 + 328,500 - 74,750 = 481,141.67.
      id: 'final-payments-and-maturity', covers: ['fixed payment', 'floating payment', 'maturity', 'close', 'collateral'], action: 'clock', to: at('2027-09-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${FWD_NAME}, leg A (fixed), period 2026-09-15 to 2027-09-15: 328,500.00 USD`, cash: { USD: 328_500 }, owner: 'account', date: '2027-09-15' },
          { type: 'swap.payment', summary: `Swap payment on ${FWD_NAME}, leg B (float), period 2027-06-15 to 2027-09-15: 74,750.00 USD`, cash: { USD: -74_750 }, date: '2027-09-15' },
          { type: 'swap.matured', summary: `Swap matured: ${FWD_NAME} (notional 9,000,000)`, owner: 'account' },
          { type: 'swap.collateral', summary: `Collateral returned on ${FWD_NAME} under its position-level terms: 90,000.00 USD (independent amount, the position ended)`, cash: { USD: 90_000 } },
        ],
        cash: { account: { USD: { settled: 481_141.67, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 481_141.67, availableToWithdraw: 481_141.67 } }, treasury: { USD: { settled: 500_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        pnl: { account: { realized: -18_558.33, commissions: -300, unrealized: 0, total: -18_858.33 } }, // -275,308.33 + 328,500 - 74,750 + 3,000
        nav: { account: 481_141.67, treasury: 500_000, book: 981_141.67 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 481_141.67, margin: null, positions: null, assets: 481_141.67, liabilities: 0, netAssets: 481_141.67 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// constant_maturity_swap
// ---------------------------------------------------------------------------------------------
// A one-year US dollar constant-maturity swap: pay 3-month term SOFR + 0.25% (ACT/360), receive the
// 5-year constant-maturity swap rate (rate code USDCMS5Y, 30/360), both quarterly. The CMS rate is a
// fixing like any other: the one published for the first day of the period (or the last business day
// before it). The Terminal applies no convexity adjustment and says so on the product.
//
// Entered on the Strategies page (template Custom, Add a leg, New OTC contract), not through the
// registry: that ticket has no market-view or calendar fields, so the contract is a US Derivatives
// contract on the US market calendar (New York Stock Exchange rules). Its payment dates then use that
// calendar together with the Federal Reserve's, the calendar of US dollar payments: a business day is a
// day on which both are open.
//
// Schedule (effective Monday 12 January 2026, maturity Tuesday 12 January 2027):
//   2026-01-12 to 2026-04-12 (90 days; 90 on 30/360), paid Monday 13 April (the 12th is a Sunday)    fixings of 12 January
//   2026-04-12 to 2026-07-12 (91 days; 90 on 30/360), paid Monday 13 July (the 12th is a Sunday)     fixings of Friday 10 April
//   2026-07-12 to 2026-10-12 (92 days; 90 on 30/360), paid Tuesday 13 October: Monday the 12th is
//                                                     Columbus Day, a Federal Reserve holiday        fixings of Friday 10 July
//   2026-10-12 to 2027-01-12 (92 days; 90 on 30/360), paid 12 January 2027                           fixings of Friday 9 October
//   TSFR3M: 3.65%, 3.60%, 3.50%, 3.45%.  USDCMS5Y: 3.95%, 4.05%, 3.70%, and 9 October not supplied (entered by hand: 3.60%).
//
// Collateral: a cleared agreement in the Book. Independent amount 1% of notional; variation margin
// exchanged in full every day (no threshold, no minimum transfer), in USD cash.
const CMS_NAME = 'USD CMS 5Y v TSFR3M + 25bp 12 Jan 2027';
const CMS_CONTRACT = {
  productId: 'constant_maturity_swap', name: CMS_NAME, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', tags: [], externalIds: {},
  multiplier: 0.01, // not on the ticket: every swap is priced per 100 of notional. Stated here so that the spec audit can check cash = notional x price / 100.
  terms: {
    effective: '2026-01-12', maturity: '2027-01-12', counterparty: 'Clearing broker D',
    collateralBasis: { type: 'agreement', agreementId: '$agreement:ccp' },
    legs: [
      { side: 'pay', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0.0025, months: 3, dayCount: 'ACT/360' },
      { side: 'receive', type: 'float', ccy: 'USD', index: 'USDCMS5Y', spread: 0, months: 3, dayCount: '30/360' },
    ],
  },
};
const constantMaturitySwap = {
  productId: 'constant_maturity_swap',
  title: 'USD 1-year constant-maturity swap entered on the Strategies page, receive the 5-year CMS rate against 3-month term SOFR + 0.25%, under a cleared agreement',
  matrix: {
    ticket: 'Strategies page: Execution template "Custom", Add a leg, "New OTC contract", product, contract name, currency, the contract form (dates, counterparty, Collateral terms, each leg), Side, Notional, State a fill price; Preview package. The agreement is recorded first under Treasury, Collateral. Increase and termination from the strategy instance.',
    requiredFields: ['Account', 'Execution template', 'Leg: New OTC contract', 'Product', 'Contract name', 'Currency', 'Effective date', 'Maturity', 'each leg: Side, Leg type, Currency, Index, Spread, Payment, Day count', 'Collateral basis', 'Side (Enter as written / Enter the opposite side)', 'Notional', 'State a fill price'],
    automaticInputs: ['market view (US Derivatives) and calendars (US market calendar; payments on it and the Federal Reserve calendar together): the ticket has no fields for them', 'payment schedule of each leg', 'TSFR3M and USDCMS5Y fixings (rate fixtures standing in for Shaffer MarketData)', 'settlement date, T+2', 'independent amount and variation margin from the agreement'],
    manualInputs: ['the agreement itself', 'the whole contract, typed into the ticket', 'upfront amount (stated fill price)', 'mark of the contract, entered by hand', 'the CMS fixing the data service did not supply, entered by hand', 'settlement amount of a partial termination'],
    settlement: 'Upfront and termination amounts settle T+2 on the US market calendar; leg payments are cash on their payment date',
    lifecycle: 'Two floating legs: one on the money-market index plus a spread, one on the CMS rate, each paid on its own; a payment date on a Federal Reserve holiday moves to the next day; the CMS payment whose fixing is missing is blocked until it is entered; partial termination; maturity',
    accounting: 'Carried at the mark; leg payments and the termination result are realized P&L; no convexity adjustment is made, and none is implied by the figures',
    collateral: 'Agreement "Clearing terms Broker D" (cleared): independent amount 1% of notional, trued up on increase and partial termination; variation margin in full each day, received when the mark is in the Account\'s favour (restricted, owed back) and posted when it is against it; everything returned at maturity',
  },
  tradedOn: 'A constant-maturity swap can also be registered under Instruments like the other swaps of this file. This scenario enters it on the Strategies page instead (template Custom, Add a leg, New OTC contract): the contract registers itself when the package is confirmed.',
  start: at('2026-01-08'),
  settlementCheck: { lag: 2, holidays: [] }, // no New York Stock Exchange holiday in the settlement windows used (8 to 12 January, 11 to 13 August 2026)
  book: usdBook('Matrix constant-maturity swap', 'Rates', 300_000),
  instruments: {},
  rates: {
    TSFR3M: { byDate: { '2026-01-12': 3.65, '2026-04-10': 3.60, '2026-07-10': 3.50, '2026-10-09': 3.45 } },
    USDCMS5Y: { byDate: { '2026-01-12': 3.95, '2026-04-10': 4.05, '2026-07-10': 3.70 } }, // 9 October is deliberately missing
  },
  expectAtStart: usdStart(300_000),
  steps: [
    {
      id: 'record-agreement', covers: 'collateral', action: 'agreement', as: 'ccp',
      agreement: { name: 'Clearing terms Broker D', counterparty: 'Clearing broker D', kind: 'cleared', covers: ['account'], independentAmount: { type: 'pct', pct: 0.01 }, variationMargin: true, threshold: 0, minimumTransfer: 0, baseCcy: 'USD', postingCcy: 'USD', haircut: 0, nettingScope: 'account' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: Clearing terms Broker D with Clearing broker D (Cleared)', owner: 'treasury' }] },
    },
    {
      // The whole contract is typed into the ticket. 6,000,000 as written, no upfront amount. Independent amount 1% x 6,000,000 = 60,000.
      // Thursday 8 January: any amount would settle Monday 12 January.
      id: 'open', covers: ['open', 'collateral', 'registration'], action: 'package', as: 'cms', contractAs: 'main',
      input: { template: 'custom', origin: 'strategy_page', legs: [{ kind: 'trade', action: 'buy', purpose: 'primary', role: 'leg', qty: 6_000_000, orderType: 'market', statedPrice: 0, contract: CMS_CONTRACT }] },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', qty: 6_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-01-12', calendar: 'US', cash: 0, fees: 0 }],
          cash: { USD: { purchases: 0, fees: 0, margin: 60_000, required: 60_000, available: 300_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 6_000_000, avgPrice: 0, fills: [{ qty: 6_000_000, price: 0, model: 'stated-price', settleDate: '2026-01-12' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: `Entered as written: 6,000,000 notional of ${CMS_NAME} at 0.00 per 100 notional`, owner: 'account', date: '2026-01-08' },
          { type: 'swap.collateral', summary: `Collateral posted on ${CMS_NAME} under "Clearing terms Broker D" (Clearing broker D): 60,000.00 USD (independent amount, 1.00% of 6,000,000.00 USD notional)`, cash: { USD: -60_000 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 240_000, unsettled: 0, margin: 60_000, restricted: 0, availableToTrade: 240_000, availableToWithdraw: 240_000 } } },
        positions: [{ instrument: 'main', lot: 'cms', owner: 'account', direction: 'as written', qty: 6_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 6_000_000, margin: 60_000 }],
        holdings: { main: { long: 6_000_000, short: 0, net: 6_000_000 } },
        pending: [],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-04-13', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-04-13', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-01-12', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'cms', owner: 'account', qty: 6_000_000, basis: 'agreement', agreement: 'Clearing terms Broker D', mark: null, iaRequired: 60_000, iaPosted: 60_000, iaCcy: 'USD', vmPosted: 0, vmHeld: 0, vmStatus: 'not_valued_yet' }],
        pnl: { account: { realized: 0, commissions: 0, unrealized: 0, total: 0 } },
        nav: { account: 300_000, book: 1_000_000 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 240_000, margin: 60_000, payable: null, positions: null, accruedIncome: null, accruedExpense: null, assets: 300_000, liabilities: 0, netAssets: 300_000 } },
      },
    },
    {
      id: 'no-mark-no-call', covers: 'variation margin', action: 'clock', to: at('2026-01-09'),
      expect: { otc: [{ instrument: 'main', vmStatus: 'cannot_value', vmPosted: 0 }], alerts: ['collateral.unvalued'] },
    },
    {
      // 1,500,000 more on the same terms. Independent amount 1% x 7,500,000 = 75,000: 15,000 more.
      id: 'increase', covers: ['increase', 'collateral'], action: 'resize', lot: 'cms', factor: 1.25, order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_500_000, estimate: 0, model: 'stated-price', settleDate: '2026-01-13', cash: 0, fees: 0 }], cash: { USD: { margin: 15_000, required: 15_000, available: 240_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1_500_000, avgPrice: 0 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: `Increased as written: 1,500,000 notional of ${CMS_NAME} at 0.00 per 100 notional` },
          { type: 'swap.collateral', summary: `Collateral posted on ${CMS_NAME} under "Clearing terms Broker D" (Clearing broker D): 15,000.00 USD (independent amount, 1.00% of 7,500,000.00 USD notional)`, cash: { USD: -15_000 } },
        ],
        cash: { account: { USD: { settled: 225_000, margin: 75_000, availableToTrade: 225_000, availableToWithdraw: 225_000 } } },
        positions: [{ instrument: 'main', lot: 'cms', qty: 7_500_000, cost: 0, notional: 7_500_000, margin: 75_000 }],
        holdings: { main: { long: 7_500_000, short: 0, net: 7_500_000 } },
        otc: [{ instrument: 'main', qty: 7_500_000, iaRequired: 75_000, iaPosted: 75_000 }],
        nav: { account: 300_000, book: 1_000_000 },
        balance: { account: { cash: 225_000, margin: 75_000, assets: 300_000, netAssets: 300_000 } },
      },
    },
    { id: 'effective-date', action: 'clock', to: at('2026-01-12'), expect: {} },
    {
      id: 'mark-positive', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.12, note: 'Clearing broker mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cms', qty: 7_500_000, price: 0.12, value: 9_000, unrealized: 9_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }], // 7,500,000 x 0.12 / 100
        otc: [{ instrument: 'main', mark: 0.12, markValue: 9_000 }],
        pnl: { account: { unrealized: 9_000, total: 9_000 } },
        nav: { account: 309_000, book: 1_009_000 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 9_000, assets: 309_000, netAssets: 309_000 } },
      },
    },
    {
      // Cleared: the whole 9,000 is received. It is restricted cash and a liability.
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-01-12'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "Clearing terms Broker D" (Clearing broker D): 9,000.00 USD received. Netting set of 1 position marked at 9,000.00 USD; threshold 0.00 USD.', owner: 'account', date: '2026-01-12' }],
        cash: { account: { USD: { settled: 225_000, restricted: 9_000, margin: 75_000, availableToTrade: 225_000, availableToWithdraw: 225_000 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 9_000, vmExposure: 9_000, vmStatus: 'ok' }],
        alerts: [],
        nav: { account: 309_000, book: 1_009_000 },
        balance: { account: { restricted: 9_000, collateralReceived: 9_000, assets: 318_000, liabilities: 9_000, netAssets: 309_000 } },
      },
    },
    { id: 'tuesday-morning', action: 'clock', to: at('2026-01-13'), expect: {} },
    {
      id: 'mark-negative', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.08, note: 'Clearing broker mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cms', price: -0.08, value: -6_000, unrealized: -6_000 }], // 7,500,000 x -0.08 / 100
        otc: [{ instrument: 'main', mark: -0.08, markValue: -6_000 }],
        pnl: { account: { unrealized: -6_000, total: -6_000 } },
        nav: { account: 294_000, book: 994_000 },
        balance: { account: { positions: -6_000, assets: 303_000, liabilities: 9_000, netAssets: 294_000 } }, // 225,000 + 9,000 held + 75,000 - 6,000
      },
    },
    {
      // The 9,000 held goes back and 6,000 is posted.
      id: 'variation-margin-swings', covers: 'variation margin', action: 'clock', to: eod('2026-01-13'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "Clearing terms Broker D" (Clearing broker D): 9,000.00 USD returned to the counterparty and 6,000.00 USD posted. Netting set of 1 position marked at -6,000.00 USD; threshold 0.00 USD.', owner: 'account', date: '2026-01-13' }],
        cash: { account: { USD: { settled: 219_000, restricted: 0, margin: 81_000, availableToTrade: 219_000, availableToWithdraw: 219_000 } } },
        otc: [{ instrument: 'main', vmPosted: 6_000, vmHeld: 0, vmExposure: -6_000, vmStatus: 'ok' }],
        balance: { account: { cash: 219_000, margin: 81_000, restricted: null, collateralReceived: null, assets: 294_000, liabilities: 0, netAssets: 294_000 } },
      },
    },
    {
      // Monday 13 April, on 7,500,000. Leg A, paid: 7,500,000 x (3.65% + 0.25%) x 90/360 = 73,125.00.
      // Leg B, the CMS leg, received: 7,500,000 x 3.95% x 90/360 = 74,062.50.
      id: 'first-quarter', covers: ['floating payment', 'CMS payment'], action: 'clock', to: at('2026-04-13'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${CMS_NAME}, leg A (float), period 2026-01-12 to 2026-04-12: 73,125.00 USD`, cash: { USD: -73_125 }, owner: 'account', date: '2026-04-13' },
          { type: 'swap.payment', summary: `Swap receipt on ${CMS_NAME}, leg B (float), period 2026-01-12 to 2026-04-12: 74,062.50 USD`, cash: { USD: 74_062.50 }, owner: 'account', date: '2026-04-13' },
        ],
        cash: { account: { USD: { settled: 219_937.50, availableToTrade: 219_937.50, availableToWithdraw: 219_937.50 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-13', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-13', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-01-12', status: 'pending' },
        ],
        pnl: { account: { realized: 937.50, unrealized: -6_000, total: -5_062.50 } },
        nav: { account: 294_937.50, book: 994_937.50 },
        balance: { account: { cash: 219_937.50, assets: 294_937.50, netAssets: 294_937.50 } },
      },
    },
    {
      // Monday 13 July, fixings of Friday 10 April. Leg A: 7,500,000 x (3.60% + 0.25%) x 91/360 = 72,989.58. Leg B: 7,500,000 x 4.05% x 90/360 = 75,937.50.
      id: 'second-quarter', covers: ['floating payment', 'CMS payment'], action: 'clock', to: at('2026-07-13'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${CMS_NAME}, leg A (float), period 2026-04-12 to 2026-07-12: 72,989.58 USD`, cash: { USD: -72_989.58 }, date: '2026-07-13' },
          { type: 'swap.payment', summary: `Swap receipt on ${CMS_NAME}, leg B (float), period 2026-04-12 to 2026-07-12: 75,937.50 USD`, cash: { USD: 75_937.50 }, date: '2026-07-13' },
        ],
        cash: { account: { USD: { settled: 222_885.42, availableToTrade: 222_885.42, availableToWithdraw: 222_885.42 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-13', status: 'pending' }, // 12 October is Columbus Day
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-13', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-01-12', status: 'pending' },
        ],
        pnl: { account: { realized: 3_885.42, total: -2_114.58 } }, // 937.50 - 72,989.58 + 75,937.50; then - 6,000
        nav: { account: 297_885.42, book: 997_885.42 },
        balance: { account: { cash: 222_885.42, assets: 297_885.42, netAssets: 297_885.42 } },
      },
    },
    { id: 'mid-august', action: 'clock', to: at('2026-08-11'), expect: {} },
    {
      // A fifth (1,500,000) is terminated at -0.10 per 100, paid: 1,500. Nothing was paid to enter, so realized -1,500. Settles Thursday 13 August.
      // Left: 6,000,000, marked -0.08: -4,800. Independent amount 1% x 6,000,000 = 60,000: 15,000 returns.
      id: 'partial-termination', covers: ['reduce', 'partial termination', 'collateral'], action: 'close', lot: 'cms', instrument: 'main', scope: 'strategy', percent: 20, order: { statedPrice: -0.10 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 1_500_000, estimate: -0.1, model: 'stated-price', settleDate: '2026-08-13', cash: -1_500, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1_500_000, avgPrice: -0.1 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: `Terminated in part: 1,500,000 of 7,500,000 notional of ${CMS_NAME} at -0.10 per 100 notional (realized -1,500.00 USD)` },
          { type: 'swap.collateral', summary: `Collateral returned on ${CMS_NAME} under "Clearing terms Broker D" (Clearing broker D): 15,000.00 USD (independent amount, 1.00% of 6,000,000.00 USD notional)`, cash: { USD: 15_000 } },
        ],
        cash: { account: { USD: { settled: 237_885.42, unsettled: -1_500, margin: 66_000, availableToTrade: 236_385.42, availableToWithdraw: 236_385.42 } } }, // 60,000 independent amount + 6,000 variation margin
        positions: [{ instrument: 'main', lot: 'cms', qty: 6_000_000, cost: 0, price: -0.08, value: -4_800, unrealized: -4_800, notional: 6_000_000, margin: 60_000 }],
        holdings: { main: { long: 6_000_000, short: 0, net: 6_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-08-13', amount: -1_500, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 6_000_000, markValue: -4_800, iaRequired: 60_000, iaPosted: 60_000, vmPosted: 6_000 }],
        pnl: { account: { realized: 2_385.42, unrealized: -4_800, total: -2_414.58 } },
        nav: { account: 297_585.42, book: 997_585.42 },
        balance: { account: { cash: 237_885.42, margin: 66_000, positions: -4_800, payable: 1_500, assets: 299_085.42, liabilities: 1_500, netAssets: 297_585.42 } },
      },
    },
    {
      // 4,800 is now required against 6,000 posted: 1,200 comes back (no minimum transfer).
      id: 'variation-margin-trimmed', covers: 'variation margin', action: 'clock', to: eod('2026-08-11'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "Clearing terms Broker D" (Clearing broker D): 1,200.00 USD returned to us. Netting set of 1 position marked at -4,800.00 USD; threshold 0.00 USD.', cash: { USD: 1_200 }, owner: 'account' }],
        cash: { account: { USD: { settled: 239_085.42, margin: 64_800, availableToTrade: 237_585.42, availableToWithdraw: 237_585.42 } } },
        otc: [{ instrument: 'main', vmPosted: 4_800, vmHeld: 0, vmExposure: -4_800, vmStatus: 'ok' }],
        balance: { account: { cash: 239_085.42, margin: 64_800 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2026-08-13'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,500.00 USD from settled cash', cash: { USD: -1_500 } }],
        cash: { account: { USD: { settled: 237_585.42, unsettled: 0, availableToTrade: 237_585.42, availableToWithdraw: 237_585.42 } } },
        pending: [],
        balance: { account: { cash: 237_585.42, payable: null, assets: 297_585.42, liabilities: 0 } },
      },
    },
    {
      // Columbus Day: the stock exchange is open, the Federal Reserve is not. No US dollar payment is made.
      id: 'columbus-day', covers: 'payment across a holiday', action: 'clock', to: at('2026-10-12'),
      expect: { events: [], cash: { account: { USD: { settled: 237_585.42 } } } },
    },
    {
      // Tuesday 13 October, on 6,000,000, fixings of Friday 10 July. Leg A: 6,000,000 x (3.50% + 0.25%) x 92/360 = 57,500.00. Leg B: 6,000,000 x 3.70% x 90/360 = 55,500.00.
      id: 'third-quarter', covers: ['floating payment', 'CMS payment', 'payment across a holiday'], action: 'clock', to: at('2026-10-13'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${CMS_NAME}, leg A (float), period 2026-07-12 to 2026-10-12: 57,500.00 USD`, cash: { USD: -57_500 }, date: '2026-10-13' },
          { type: 'swap.payment', summary: `Swap receipt on ${CMS_NAME}, leg B (float), period 2026-07-12 to 2026-10-12: 55,500.00 USD`, cash: { USD: 55_500 }, date: '2026-10-13' },
        ],
        cash: { account: { USD: { settled: 235_585.42, availableToTrade: 235_585.42, availableToWithdraw: 235_585.42 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-01-12', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-12', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-12', status: 'pending' },
        ],
        pnl: { account: { realized: 385.42, total: -4_414.58 } },
        nav: { account: 295_585.42, book: 995_585.42 },
        balance: { account: { cash: 235_585.42, assets: 295_585.42, netAssets: 295_585.42 } },
      },
    },
    {
      // Maturity date, fixings of Friday 9 October. Leg A is paid: 6,000,000 x (3.45% + 0.25%) x 92/360 = 56,733.33.
      // The CMS fixing for 9 October was never supplied: leg B waits, and so does maturity. The CMS rate of July is not reused.
      id: 'cms-fixing-missing', covers: ['floating payment', 'missing fixing'], action: 'clock', to: at('2027-01-12'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${CMS_NAME}, leg A (float), period 2026-10-12 to 2027-01-12: 56,733.33 USD`, cash: { USD: -56_733.33 }, date: '2027-01-12' }],
        cash: { account: { USD: { settled: 178_852.09, availableToTrade: 178_852.09, availableToWithdraw: 178_852.09 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-01-12', status: 'blocked', reason: /Waiting for the final leg payments/ },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-12', status: 'blocked', reason: /Awaiting the USDCMS5Y fixing for 2026-10-09/ },
        ],
        pnl: { account: { realized: -56_347.91, total: -61_147.91 } },
        nav: { account: 238_852.09, book: 938_852.09 },
        balance: { account: { cash: 178_852.09, assets: 238_852.09, netAssets: 238_852.09 } },
      },
    },
    {
      // 3.60% for 9 October, by hand. Leg B is received: 6,000,000 x 3.60% x 90/360 = 54,000.00.
      id: 'cms-fixing-entered-by-hand', covers: ['missing fixing', 'CMS payment'], action: 'manual_rate', code: 'USDCMS5Y', value: 3.60, date: '2026-10-09', note: 'Published CMS fixing, entered by hand',
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${CMS_NAME}, leg B (float), period 2026-10-12 to 2027-01-12: 54,000.00 USD`, cash: { USD: 54_000 }, owner: 'account', date: '2027-01-12' }],
        cash: { account: { USD: { settled: 232_852.09, availableToTrade: 232_852.09, availableToWithdraw: 232_852.09 } } },
        lifecycle: [{ type: 'swap.maturity', instrument: 'main', dueDate: '2027-01-12', status: 'blocked', reason: /Waiting for the final leg payments/ }], // looked at before the payment in this pass; the next pass ends the contract
        pnl: { account: { realized: -2_347.91, total: -7_147.91 } },
        nav: { account: 292_852.09, book: 992_852.09 },
        balance: { account: { cash: 232_852.09, assets: 292_852.09, netAssets: 292_852.09 } },
      },
    },
    {
      // The swap ends. Nothing was paid to enter it; the mark of -4,800 was never cash. The 60,000 and the 4,800 posted come back.
      // 300,000 - 73,125 + 74,062.50 - 72,989.58 + 75,937.50 - 1,500 - 57,500 + 55,500 - 56,733.33 + 54,000 = 297,652.09.
      id: 'matured', covers: ['maturity', 'close', 'collateral'], action: 'cycle',
      expect: {
        events: [
          { type: 'swap.matured', summary: `Swap matured: ${CMS_NAME} (notional 6,000,000)`, owner: 'account' },
          { type: 'swap.collateral', summary: `Collateral returned on ${CMS_NAME} under "Clearing terms Broker D" (Clearing broker D): 60,000.00 USD (independent amount, the position ended)`, cash: { USD: 60_000 } },
          { type: 'collateral.variation', summary: /Variation margin under "Clearing terms Broker D" \(Clearing broker D\): 4,800\.00 USD returned to us\./, cash: { USD: 4_800 } },
        ],
        cash: { account: { USD: { settled: 297_652.09, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 297_652.09, availableToWithdraw: 297_652.09 } }, treasury: { USD: { settled: 700_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        pnl: { account: { realized: -2_347.91, commissions: 0, unrealized: 0, total: -2_347.91 } },
        nav: { account: 297_652.09, treasury: 700_000, book: 997_652.09 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 297_652.09, margin: null, positions: null, assets: 297_652.09, liabilities: 0, netAssets: 297_652.09 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// cross_currency_swap
// ---------------------------------------------------------------------------------------------
// Owned by Treasury, in a Book that reports in US dollars. A one-year fixed-for-fixed euro / dollar swap
// with exchange of principal: the contract is written "pay 2.40% on the euro notional, annually; receive
// 4.10% on the dollar notional, semi-annually", both 30/360, with the dollar notional 1.10 times the euro
// notional (the EUR/USD rate when it was agreed). Quantity and price are in euros: the euro notional, and
// an amount per 100 of it.
//
// Principal, as the Terminal books it:
//   - Entered as written, Treasury receives the euro notional at the start and owes it back (an amount
//     borrowed), and pays the dollar notional and is owed it back (an amount lent). Both go back the other
//     way at maturity. They are cash movements against those two balances, not profit or loss.
//   - The exchange is made in both currencies or in neither. If the cash to be paid is not there, nothing
//     moves, the exchange is listed as failed and it is made as soon as the cash is there.
//   - A change agreed after the start (an increase, a termination) exchanges its principal when it settles.
//   - The mark is the value of the rest of the contract. The principal exchanged is on the balance sheet at
//     the current rate, so a mark entered by hand must not include it a second time.
// Reporting currency: euro balances at the current EUR/USD fixture; each entry keeps the rate of its day;
// the difference is the FX effect. Realized amounts are converted at the rate of the day they are booked.
//
// Schedule (effective Monday 11 May 2026, maturity Tuesday 11 May 2027; payments on days when both TARGET and the Federal Reserve are open):
//   leg A, EUR fixed  2026-05-11 to 2027-05-11 (360 days 30/360), paid 11 May 2027
//   leg B, USD fixed  2026-05-11 to 2026-11-11 (180 days), paid Thursday 12 November: the 11th is Veterans Day, a Federal Reserve holiday
//                     2026-11-11 to 2027-05-11 (180 days), paid 11 May 2027
const XCCY_NAME = 'EUR/USD cross-currency swap 2.40% EUR v 4.10% USD 11 May 2027';
const crossCurrencySwap = {
  productId: 'cross_currency_swap',
  title: 'EUR/USD 1-year fixed-for-fixed cross-currency swap owned by Treasury, principal exchanged at start and maturity, reported in USD',
  matrix: {
    ...OTC_TICKET,
    ticket: `${OTC_TICKET.ticket}. Owner chosen on the ticket: Treasury`,
    requiredFields: [...OTC_TICKET.requiredFields, 'each leg: Notional factor, Notional exchanged'],
    automaticInputs: ['payment schedule of each leg; payment dates on the TARGET and Federal Reserve calendars together', 'principal exchanged at the start, on the settlement of a later change, and back at maturity', 'EUR/USD rate (FX fixture) for the reporting-currency figures', 'settlement date, T+2 on TARGET', 'commission from the Book fee schedule'],
    manualInputs: ['upfront amount (stated fill price, in euros per 100 of euro notional)', 'mark of the contract, entered by hand, excluding the principal already on the balance sheet', 'settlement amount of a partial termination', 'cash moved to Treasury when the principal cannot be paid'],
    settlement: 'Upfront amount and commission settle T+2 on TARGET; principal for a change made after the start moves on that settlement date; leg payments are cash on their payment date',
    lifecycle: 'Initial exchange of principal on the effective date (failed visibly for want of dollars, then made once funded); dollar interest semi-annually (moved over Veterans Day); a trade that could not pay its principal is refused; partial termination returns part of the principal on its settlement date; euro interest, last dollar interest, maturity and the final exchange',
    accounting: 'Principal received is cash and an amount owed; principal paid is an amount lent: neither is P&L. Interest and the termination result are realized P&L at the rate of their day; euro balances are revalued at the current rate and the difference is the FX effect; the figures are Treasury\'s and the Book\'s',
    collateral: 'Uncollateralized (paper assumption): nothing is posted or received, whatever the mark',
  },
  start: at('2026-05-05'),
  settlementCheck: { lag: 2, holidays: [] }, // TARGET: no holiday in the settlement windows used (5 to 11 May, 15 to 17 June, 1 to 3 December 2026)
  book: {
    name: 'Matrix cross-currency swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 6_000_000 }, { ccy: 'EUR', amount: 500_000 }],
    account: { name: 'Rates', funding: [{ ccy: 'USD', amount: 1_000_000 }] }, // the Account does not trade; Treasury is left 500,000 USD short of the dollar principal
    settings: { fees: { swap: { perUnit: 0.00001, minimum: 0, bps: 0 } }, fill: FILL, settlement: { swap: 2 } }, // 10.00 per million of euro notional, in euros
  },
  instruments: {
    main: {
      productId: 'cross_currency_swap', name: XCCY_NAME, symbol: 'XCCY-EURUSD-0527', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'DE', tradingCcy: 'EUR', multiplier: 0.01,
      conventions: { tradingCalendar: 'TARGET', settlementCalendar: 'TARGET', paymentCalendar: 'TARGET+USD' },
      terms: {
        effective: '2026-05-11', maturity: '2027-05-11', counterparty: 'Dealer E', collateralBasis: { type: 'uncollateralized' },
        legs: [
          { side: 'pay', type: 'fixed', ccy: 'EUR', rate: 0.024, months: 12, dayCount: '30/360', exchangeNotional: true },
          { side: 'receive', type: 'fixed', ccy: 'USD', rate: 0.041, months: 6, dayCount: '30/360', notionalFactor: 1.1, exchangeNotional: true },
        ],
      },
    },
  },
  fx: { 'EUR/USD': 1.10 },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 1_000_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 1_000_000 } },
      treasury: { USD: { settled: 5_000_000, unsettled: 0, borrowed: 0, lent: 0, availableToTrade: 5_000_000 }, EUR: { settled: 500_000, unsettled: 0, borrowed: 0, lent: 0, availableToTrade: 500_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], lifecycleFailures: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 1_000_000, treasury: 5_550_000, book: 6_550_000 }, // 500,000 EUR at 1.10 = 550,000
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      // 4,000,000 EUR as written, no upfront amount. Commission 4,000,000 x 0.00001 = 40.00 EUR (44.00 USD), settling Thursday 7 May.
      // The swap has not started: no principal moves and none is required today.
      id: 'open', covers: ['open', 'before the effective date'], action: 'ticket', owner: 'treasury', instrument: 'main', side: 'buy', qty: 4_000_000, as: 'xccy', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-05-07', calendar: 'TARGET', cash: 0, fees: 40, otherCash: {} }],
          cash: { EUR: { purchases: 0, proceeds: 0, fees: 40, margin: 0, required: 40, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 4_000_000, avgPrice: 0, fills: [{ qty: 4_000_000, price: 0, model: 'stated-price', settleDate: '2026-05-07' }] }] },
        events: [{ type: 'strategy.submitted', owner: 'treasury' }, { type: 'trade.fill', summary: 'Entered as written: 4,000,000 notional of XCCY-EURUSD-0527 at 0.00 per 100 notional', owner: 'treasury', date: '2026-05-05' }],
        cash: { treasury: { EUR: { settled: 500_000, unsettled: -40, availableToTrade: 499_960 }, USD: { settled: 5_000_000, availableToTrade: 5_000_000 } } },
        positions: [{ instrument: 'main', lot: 'xccy', owner: 'treasury', direction: 'as written', qty: 4_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 4_000_000, margin: 0 }],
        holdings: { main: { long: 4_000_000, short: 0, net: 4_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2026-05-07', amount: -40, ccy: 'EUR', into: 'cash' }],
        lifecycle: [
          { type: 'swap.notional', instrument: 'main', dueDate: '2026-05-11', status: 'pending', owner: 'treasury' }, // the initial exchange of principal
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-12', status: 'pending', owner: 'treasury' },  // dollar interest; 11 November is Veterans Day
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-05-11', status: 'pending', owner: 'treasury' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-11', status: 'pending', owner: 'treasury' },  // euro interest
        ],
        otc: [{ instrument: 'main', lot: 'xccy', owner: 'treasury', qty: 4_000_000, basis: 'uncollateralized', agreement: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { total: 0 }, book: { realized: 0, commissions: -44, unrealized: 0, fx: 0, total: -44 } }, // 40 EUR x 1.10
        nav: { account: 1_000_000, treasury: 5_549_956, book: 6_549_956 },
        provisional: { account: false, book: true },
        balance: { treasury: { cash: 5_550_000, payable: 44, positions: null, lent: null, borrowed: null, assets: 5_550_000, liabilities: 44, netAssets: 5_549_956 } },
      },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-05-07'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 40.00 EUR from settled cash', cash: { EUR: -40 }, owner: 'treasury', date: '2026-05-07' }],
        cash: { treasury: { EUR: { settled: 499_960, unsettled: 0, availableToTrade: 499_960 } } },
        pending: [],
        balance: { treasury: { cash: 5_549_956, payable: null, assets: 5_549_956, liabilities: 0 } }, // 5,000,000 + 499,960 x 1.10
      },
    },
    {
      // 1,000,000 EUR more at 0.02 per 100: 200.00 EUR, commission 10.00 EUR. It settles Monday 11 May, the effective date, so its
      // principal is exchanged with that settlement and is part of what the trade needs: 1,100,000 USD to pay, 1,000,000 EUR to receive.
      id: 'increase', covers: ['increase', 'notional exchange'], action: 'resize', owner: 'treasury', lot: 'xccy', factor: 1.25, order: { statedPrice: 0.02 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 0.02, model: 'stated-price', settleDate: '2026-05-11', cash: -200, fees: 10, otherCash: { EUR: 1_000_000, USD: -1_100_000 } }],
          cash: { EUR: { purchases: 200, proceeds: 1_000_000, fees: 10, required: 210, available: 499_960, shortfall: 0 }, USD: { purchases: 1_100_000, proceeds: 0, required: 1_100_000, available: 5_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 0.02 }] },
        events: [{ type: 'strategy.legs_added', owner: 'treasury' }, { type: 'trade.fill', summary: 'Increased as written: 1,000,000 notional of XCCY-EURUSD-0527 at 0.02 per 100 notional', owner: 'treasury' }],
        cash: { treasury: { EUR: { settled: 499_960, unsettled: -210, availableToTrade: 499_750 }, USD: { settled: 5_000_000 } } },
        positions: [{ instrument: 'main', lot: 'xccy', owner: 'treasury', qty: 5_000_000, cost: 200, avgCost: 0.004, price: null, value: null, notional: 5_000_000 }], // 200 / 50,000
        holdings: { main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2026-05-11', amount: -210, ccy: 'EUR', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 5_000_000 }],
        pnl: { book: { commissions: -55, total: -55 } }, // 50 EUR x 1.10
        nav: { treasury: 5_549_945, book: 6_549_945 }, // 5,000,000 + (499,960 - 210 + 200 carried at cost) x 1.10
        balance: { treasury: { cash: 5_549_956, positions: 220, payable: 231, assets: 5_550_176, liabilities: 231, netAssets: 5_549_945 } },
      },
    },
    {
      // The effective date. The 210.00 EUR settles. The principal is due: 5,500,000 USD to pay (5,000,000 x 1.10) and 5,000,000 EUR to receive.
      // Treasury has 5,000,000 USD. Nothing is exchanged in either currency, cash does not go below zero, and the exchange is listed as failed.
      id: 'initial-exchange-unfunded', covers: ['notional exchange', 'insufficient cash'], action: 'clock', to: at('2026-05-11'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 210.00 EUR from settled cash', cash: { EUR: -210 }, owner: 'treasury', date: '2026-05-11' }],
        cash: { treasury: { EUR: { settled: 499_750, unsettled: 0, borrowed: 0, availableToTrade: 499_750 }, USD: { settled: 5_000_000, lent: 0, availableToTrade: 5_000_000 } } },
        pending: [],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-12', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
        ],
        lifecycleFailures: [{ type: 'swap.notional', instrument: 'main', dueDate: '2026-05-11', status: 'failed', owner: 'treasury', reason: /Notional exchange on .* could not be made: 5,500,000\.00 USD is to be paid and Treasury has 5,000,000\.00 USD of settled USD cash\. Nothing was exchanged in either currency\./ }],
        alerts: ['funding.failed'],
        failed: { lifecycle: 1 },
        nav: { treasury: 5_549_945, book: 6_549_945 },
        balance: { treasury: { cash: 5_549_725, payable: null, positions: 220, lent: null, borrowed: null, assets: 5_549_945, liabilities: 0, netAssets: 5_549_945 } }, // 5,000,000 + 499,750 x 1.10
      },
    },
    {
      // The Account returns 600,000 USD to Treasury. The exchange is then made: 5,000,000 EUR received and owed back, 5,500,000 USD paid and owed to Treasury.
      // Net assets do not change: cash 100,000 USD + 5,499,750 EUR, lent 5,500,000 USD, owed 5,000,000 EUR.
      id: 'funded-and-exchanged', covers: ['notional exchange', 'insufficient cash'], action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 600_000,
      expect: {
        events: [
          { type: 'transfer.return' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XCCY_NAME}: received 5,000,000.00 EUR`, cash: { EUR: 5_000_000 }, owner: 'treasury', date: '2026-05-11' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XCCY_NAME}: paid 5,500,000.00 USD`, cash: { USD: -5_500_000 }, owner: 'treasury', date: '2026-05-11' },
        ],
        cash: {
          account: { USD: { settled: 400_000, availableToTrade: 400_000 } },
          treasury: { EUR: { settled: 5_499_750, borrowed: 5_000_000, lent: 0, availableToTrade: 5_499_750 }, USD: { settled: 100_000, lent: 5_500_000, borrowed: 0, availableToTrade: 100_000 } },
        },
        lifecycleFailures: [], alerts: [], failed: { lifecycle: 0 },
        pnl: { book: { realized: 0, commissions: -55, fx: 0, total: -55 } }, // principal is not profit or loss
        nav: { account: 400_000, treasury: 6_149_945, book: 6_549_945 }, // 100,000 + 5,500,000 lent + (5,499,750 - 5,000,000 + 200) x 1.10
        balance: { treasury: { cash: 6_149_725, lent: 5_500_000, borrowed: 5_500_000, positions: 220, assets: 11_649_945, liabilities: 5_500_000, netAssets: 6_149_945 } }, // cash 100,000 + 5,499,750 x 1.10
      },
    },
    { id: 'treasury-screens-after-exchange', covers: 'notional exchange', action: 'owner_screens', owner: 'treasury', expect: {} },
    { id: 'mid-june', action: 'clock', to: at('2026-06-15'), expect: { events: [] } },
    {
      // Doubling the swap now would exchange another 5,500,000 USD when the trade settles. Treasury has 100,000 USD: refused, 5,400,000 short.
      id: 'increase-without-the-dollars', covers: ['notional exchange', 'insufficient cash'], action: 'resize', owner: 'treasury', lot: 'xccy', factor: 2, order: { statedPrice: 0 },
      status: 'blocked', reason: 'The principal a trade exchanges at its settlement is part of the cash the trade needs.',
      expect: { refused: /Treasury is short 5,400,000\.00 USD: the package needs 5,500,000\.00 USD \(purchases 5,500,000\.00 USD, fees 0\.00 USD, margin and collateral 0\.00 USD, reserved 0\.00 USD\) and 100,000\.00 USD is available/ },
    },
    {
      // The euro rises to 1.12. Treasury's euro net assets: cash 5,499,750 - owed 5,000,000 + 200 carried = 499,950 EUR.
      // FX effect: 499,950 x (1.12 - 1.10) = 9,999.00. The dollars lent do not move.
      id: 'euro-rises', covers: 'reporting currency', action: 'fx_rate', pair: 'EUR/USD', rate: 1.12,
      expect: {
        pnl: { book: { realized: 0, commissions: -55, unrealized: 0, fx: 9_999, total: 9_944 } },
        nav: { account: 400_000, treasury: 6_159_944, book: 6_559_944 }, // 5,600,000 + 499,950 x 1.12
        balance: { treasury: { cash: 6_259_720, lent: 5_500_000, borrowed: 5_600_000, positions: 224, assets: 11_759_944, liabilities: 5_600_000, netAssets: 6_159_944 } }, // 100,000 + 5,499,750 x 1.12; 5,000,000 x 1.12; 200 x 1.12
      },
    },
    {
      // Mark 0.30 per 100 of euro notional: 5,000,000 x 0.30 / 100 = 15,000 EUR, 14,800 above the 200 paid: 16,576.00 USD at 1.12.
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.30, note: 'Dealer mark, by hand, excluding the principal',
      expect: {
        positions: [{ instrument: 'main', lot: 'xccy', owner: 'treasury', qty: 5_000_000, price: 0.3, value: 15_000, unrealized: 14_800, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: 0.3, markValue: 15_000 }],
        pnl: { book: { unrealized: 16_576, fx: 9_999, total: 26_520 } },
        nav: { treasury: 6_176_520, book: 6_576_520 },
        provisional: { account: false, book: false },
        balance: { treasury: { positions: 16_800, assets: 11_776_520, netAssets: 6_176_520 } }, // 15,000 x 1.12
      },
    },
    {
      // Veterans Day: TARGET is open, the Federal Reserve is not. The dollar interest is not paid today.
      id: 'veterans-day', covers: 'payment across a holiday', action: 'clock', to: at('2026-11-11'),
      expect: { events: [], cash: { treasury: { USD: { settled: 100_000 } } }, lifecycle: [
        { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-12', status: 'pending' },
        { type: 'swap.maturity', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
        { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
      ] },
    },
    {
      // Dollar interest, received on Thursday 12 November: 5,500,000 x 4.10% x 180/360 = 112,750.00 USD.
      id: 'dollar-interest', covers: ['fixed payment', 'payment across a holiday'], action: 'clock', to: at('2026-11-12'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${XCCY_NAME}, leg B (fixed), period 2026-05-11 to 2026-11-11: 112,750.00 USD`, cash: { USD: 112_750 }, owner: 'treasury', date: '2026-11-12' }],
        cash: { treasury: { USD: { settled: 212_750, availableToTrade: 212_750 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
        ],
        pnl: { book: { realized: 112_750, total: 139_270 } },
        nav: { treasury: 6_289_270, book: 6_689_270 },
        balance: { treasury: { cash: 6_372_470, assets: 11_889_270, netAssets: 6_289_270 } },
      },
    },
    { id: 'first-of-december', action: 'clock', to: at('2026-12-01'), expect: { events: [] } },
    {
      // 40% (2,000,000 EUR) is terminated for 0.25 per 100, received: 5,000.00 EUR; commission 20.00 EUR. Settles Thursday 3 December.
      // Upfront carried on it: 200 x 40% = 80. Realized 4,920.00 EUR = 5,510.40 USD at 1.12. Commission 22.40 USD.
      // Its principal goes back with that settlement: 2,000,000 EUR to pay, 2,200,000 USD to receive. Nothing of it moves today.
      // Left: 3,000,000 EUR carrying 120, marked 0.30: 9,000 EUR, 8,880 up = 9,945.60 USD.
      id: 'partial-termination', covers: ['reduce', 'partial termination', 'notional exchange'], action: 'close', owner: 'treasury', lot: 'xccy', scope: 'strategy', percent: 40, order: { statedPrice: 0.25 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2_000_000, estimate: 0.25, model: 'stated-price', settleDate: '2026-12-03', cash: 5_000, fees: 20, otherCash: { EUR: -2_000_000, USD: 2_200_000 } }],
          cash: { EUR: { purchases: 2_000_000, proceeds: 5_000, fees: 20, required: 2_000_020, available: 5_499_750, shortfall: 0 }, USD: { purchases: 0, proceeds: 2_200_000, required: 0, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2_000_000, avgPrice: 0.25 }] },
        events: [{ type: 'strategy.legs_added', owner: 'treasury' }, { type: 'trade.fill', summary: 'Terminated in part: 2,000,000 of 5,000,000 notional of XCCY-EURUSD-0527 at 0.25 per 100 notional (realized 4,920.00 EUR)', owner: 'treasury' }],
        cash: { treasury: { EUR: { settled: 5_499_750, unsettled: 4_980, borrowed: 5_000_000, availableToTrade: 5_504_730 }, USD: { settled: 212_750, lent: 5_500_000 } } },
        positions: [{ instrument: 'main', lot: 'xccy', owner: 'treasury', qty: 3_000_000, cost: 120, avgCost: 0.004, price: 0.3, value: 9_000, unrealized: 8_880, notional: 3_000_000 }],
        holdings: { main: { long: 3_000_000, short: 0, net: 3_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2026-12-03', amount: 4_980, ccy: 'EUR', into: 'cash' }],
        lifecycle: [
          { type: 'swap.notional', instrument: 'main', dueDate: '2026-12-03', status: 'pending', owner: 'treasury' }, // the principal of the part terminated
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
        ],
        otc: [{ instrument: 'main', qty: 3_000_000, markValue: 9_000 }],
        pnl: { book: { realized: 118_260.40, commissions: -77.40, unrealized: 9_945.60, fx: 9_999, total: 138_127.60 } },
        nav: { treasury: 6_288_127.60, book: 6_688_127.60 }, // 212,750 + 5,500,000 + (5,499,750 + 4,980 - 5,000,000 + 9,000) x 1.12
        balance: { treasury: { cash: 6_372_470, receivable: 5_577.60, lent: 5_500_000, borrowed: 5_600_000, positions: 10_080, assets: 11_888_127.60, liabilities: 5_600_000, netAssets: 6_288_127.60 } },
      },
    },
    {
      // Thursday 3 December: the 4,980.00 EUR settles, and the principal of the part terminated goes back: 2,000,000 EUR paid, 2,200,000 USD received.
      // Left: 3,000,000 EUR owed, 3,300,000 USD lent. Net assets do not change.
      id: 'termination-settles-with-its-principal', covers: ['settlement', 'notional exchange'], action: 'clock', to: at('2026-12-03'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 4,980.00 EUR into settled cash', cash: { EUR: 4_980 }, owner: 'treasury', date: '2026-12-03' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XCCY_NAME}: paid 2,000,000.00 EUR`, cash: { EUR: -2_000_000 }, owner: 'treasury', date: '2026-12-03' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XCCY_NAME}: received 2,200,000.00 USD`, cash: { USD: 2_200_000 }, owner: 'treasury', date: '2026-12-03' },
        ],
        cash: { treasury: { EUR: { settled: 3_504_730, unsettled: 0, borrowed: 3_000_000, availableToTrade: 3_504_730 }, USD: { settled: 2_412_750, lent: 3_300_000, availableToTrade: 2_412_750 } } },
        pending: [],
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-11', status: 'pending' },
        ],
        pnl: { book: { realized: 118_260.40, commissions: -77.40, unrealized: 9_945.60, fx: 9_999, total: 138_127.60 } },
        nav: { treasury: 6_288_127.60, book: 6_688_127.60 },
        // cash 2,412,750 + 3,504,730 x 1.12 = 6,338,047.60; owed 3,000,000 x 1.12
        balance: { treasury: { cash: 6_338_047.60, receivable: null, lent: 3_300_000, borrowed: 3_360_000, positions: 10_080, assets: 9_648_127.60, liabilities: 3_360_000, netAssets: 6_288_127.60 } },
      },
    },
    { id: 'treasury-screens-after-termination', covers: 'partial termination', action: 'owner_screens', owner: 'treasury', expect: {} },
    { id: 'mid-january', action: 'clock', to: at('2027-01-15'), expect: { events: [] } },
    {
      // The euro falls to 1.07. Euro net assets: 3,504,730 - 3,000,000 + 9,000 = 513,730 EUR = 549,691.10 USD.
      // FX effect since the entries were booked: cash 3,504,730 x 1.07 = 3,750,061.10 against 3,815,302.60 booked (6,049,725 + 5,577.60 - 2,240,000): -65,241.50;
      // the 3,000,000 owed: 3,210,000 against 3,260,000 booked (5,500,000 - 2,240,000): +50,000.00; the 120 carried: 128.40 against 130.40: -2.00. Total -15,243.50.
      id: 'euro-falls', covers: 'reporting currency', action: 'fx_rate', pair: 'EUR/USD', rate: 1.07,
      expect: {
        pnl: { book: { realized: 118_260.40, commissions: -77.40, unrealized: 9_501.60, fx: -15_243.50, total: 112_441.10 } }, // 8,880 x 1.07
        nav: { treasury: 6_262_441.10, book: 6_662_441.10 }, // 2,412,750 + 3,300,000 + 549,691.10
        balance: { treasury: { cash: 6_162_811.10, lent: 3_300_000, borrowed: 3_210_000, positions: 9_630, assets: 9_472_441.10, liabilities: 3_210_000, netAssets: 6_262_441.10 } },
      },
    },
    {
      // Maturity, 11 May 2027. Euro interest, paid: 3,000,000 x 2.40% x 360/360 = 72,000.00 EUR (77,040.00 USD at 1.07).
      // Dollar interest, received: 3,300,000 x 4.10% x 180/360 = 67,650.00 USD. The swap ends: the 120 EUR still carried is written off (128.40 USD),
      // and the principal goes back: 3,000,000 EUR paid, 3,300,000 USD received.
      // Treasury ends with 5,000,000 + 600,000 + 112,750 + 67,650 = 5,780,400.00 USD and 500,000 - 40 - 210 + 4,980 - 72,000 = 432,730.00 EUR.
      id: 'final-interest-maturity-and-exchange', covers: ['fixed payment', 'maturity', 'close', 'notional exchange'], action: 'clock', to: at('2027-05-11'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${XCCY_NAME}, leg A (fixed), period 2026-05-11 to 2027-05-11: 72,000.00 EUR`, cash: { EUR: -72_000 }, owner: 'treasury', date: '2027-05-11' },
          { type: 'swap.payment', summary: `Swap receipt on ${XCCY_NAME}, leg B (fixed), period 2026-11-11 to 2027-05-11: 67,650.00 USD`, cash: { USD: 67_650 }, owner: 'treasury', date: '2027-05-11' },
          { type: 'swap.matured', summary: `Swap matured: ${XCCY_NAME} (notional 3,000,000)`, owner: 'treasury' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XCCY_NAME}: paid 3,000,000.00 EUR`, cash: { EUR: -3_000_000 }, owner: 'treasury', date: '2027-05-11' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XCCY_NAME}: received 3,300,000.00 USD`, cash: { USD: 3_300_000 }, owner: 'treasury', date: '2027-05-11' },
        ],
        cash: { treasury: { EUR: { settled: 432_730, unsettled: 0, borrowed: 0, lent: 0, availableToTrade: 432_730 }, USD: { settled: 5_780_400, lent: 0, borrowed: 0, availableToTrade: 5_780_400 } }, account: { USD: { settled: 400_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], lifecycleFailures: [], otc: [], pending: [], alerts: [],
        // Realized 118,260.40 - 77,040.00 + 67,650.00 - 128.40. FX effect unchanged at 1.07: cash 432,730 x 1.07 = 463,021.10 against 528,262.60 booked (-65,241.50),
        // +50,000.00 on the principal repaid, -2.00 on the upfront written off.
        pnl: { book: { realized: 108_742, commissions: -77.40, unrealized: 0, fx: -15_243.50, total: 93_421.10 } },
        nav: { account: 400_000, treasury: 6_243_421.10, book: 6_643_421.10 }, // 5,780,400 + 432,730 x 1.07
        provisional: { account: false, book: false },
        balance: { treasury: { cash: 6_243_421.10, lent: null, borrowed: null, positions: null, assets: 6_243_421.10, liabilities: 0, netAssets: 6_243_421.10 } },
      },
    },
    { id: 'treasury-screens-after-maturity', covers: 'maturity', action: 'owner_screens', owner: 'treasury', expect: {} },
  ],
};

// ---------------------------------------------------------------------------------------------
// cross_currency_basis_swap
// ---------------------------------------------------------------------------------------------
// A one-year US dollar / yen basis swap in a Book that reports in dollars, held by the Account. The
// contract is written "pay 3-month TORF less 0.35% on the yen notional (ACT/365), receive 3-month term
// SOFR flat on the dollar notional (ACT/360)", quarterly, principal exchanged, yen notional 150 times the
// dollar notional. Quantity and price are in dollars. The Account enters the opposite side: it lends its
// yen and borrows dollars. At the start it pays the yen notional and receives the dollar notional; each
// quarter it receives the yen interest and pays the dollar interest; at maturity the principal goes back.
// Yen amounts have no decimals.
//
// Schedule (effective Monday 23 March 2026, maturity Tuesday 23 March 2027; payments on days when both the
// Federal Reserve and Tokyo are open). The fixing of a period is the one of its first day or, when that is
// not such a day, of the last one before it.
//   2026-03-23 to 2026-06-23 (92 days), paid 23 June        fixings of 23 March:  TSFR3M 4.20%, TORF3M 0.75%
//   2026-06-23 to 2026-09-23 (92 days), paid Thursday 24 September: the 23rd is the autumn equinox in Tokyo
//                                                           fixings of 23 June:   TSFR3M 4.05%, TORF3M 0.80%
//   2026-09-23 to 2026-12-23 (91 days), paid 23 December    fixings of Friday 18 September (the 21st, 22nd and 23rd are holidays in Tokyo): 3.90%, 0.85%
//   2026-12-23 to 2027-03-23 (90 days), paid 23 March 2027  fixings of 23 December: 3.75%, 0.90%
//
// Collateral: a bilateral agreement that covers the Account and Treasury and is posted by Treasury (shared
// netting): no independent amount, variation margin in full in USD cash. The Account's swap is marked;
// Treasury's cash moves.
//
// Reporting currency, by hand. USD/JPY is 150, then 156, then 144; a yen amount is worth amount / rate.
// Each entry keeps the dollar value of its day. FX effect = yen balances at today's rate less what the
// entries were booked at, over the Account's two yen balances (cash, and the principal lent):
//   booked: cash 1,560,000,000 (10,400,000.00) - 1,500,000,000 (10,000,000.00) + 1,512,329 at 150 (10,082.19)
//           + 1,701,370 at 156 (10,906.22) + 600,000,000 at 156 (3,846,153.85) + 1,121,918 at 156 (7,191.78) + 1,220,548 at 144 (8,476.03)
//           + 900,000,000 at 144 (6,250,000.00);  lent 10,000,000.00 - 3,846,153.85 - 6,250,000.00
const XBS_NAME = 'USD/JPY cross-currency basis swap TSFR3M v TORF3M - 35bp 23 Mar 2027';
const XBS_DRAFT = {
  productId: 'cross_currency_basis_swap', name: XBS_NAME, symbol: 'XCCY-USDJPY-0327', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
  conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD+JP' },
  terms: {
    effective: '2026-03-23', maturity: '2027-03-23', counterparty: 'Dealer F',
    collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' },
    legs: [
      { side: 'pay', type: 'float', ccy: 'JPY', index: 'TORF3M', spread: -0.0035, months: 3, dayCount: 'ACT/365', notionalFactor: 150, exchangeNotional: true },
      { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0, months: 3, dayCount: 'ACT/360', exchangeNotional: true },
    ],
  },
};
const crossCurrencyBasisSwap = {
  productId: 'cross_currency_basis_swap',
  title: 'USD/JPY 1-year cross-currency basis swap, yen lent against dollars (opposite side), collateral posted by Treasury under a shared agreement, reported in USD',
  matrix: {
    ...OTC_TICKET,
    ticket: `${OTC_TICKET.ticket}; the agreement is recorded first under Treasury, Collateral`,
    requiredFields: [...OTC_TICKET.requiredFields, 'Trading currency (the currency of the notional and the price)', 'each leg: Notional factor, Spread, Notional exchanged'],
    automaticInputs: ['payment schedule of each leg; payment dates on the Federal Reserve and Tokyo calendars together', 'TSFR3M and TORF3M fixings (rate fixtures standing in for Shaffer MarketData)', 'principal exchanged at the start, on the settlement of a termination, and back at maturity', 'USD/JPY rate (FX fixture) for the reporting-currency figures', 'settlement date, T+2 on the USD calendar', 'variation margin from the agreement, moved by Treasury'],
    manualInputs: ['the agreement itself', 'mark of the contract, entered by hand, in dollars per 100 of dollar notional', 'settlement amount of a partial termination', 'cash moved from Treasury when the principal cannot be repaid at maturity'],
    settlement: 'Termination amount settles T+2 on the USD calendar, and the principal of the part terminated with it; leg payments are cash on their payment date; yen in whole yen',
    lifecycle: 'Initial exchange on the effective date; yen interest received and dollar interest paid each quarter, each leg on its own index, spread and day count; a payment date that is a holiday in Tokyo moves to the next day and its fixings are the last ones before the holidays; partial termination; at maturity the final exchange fails visibly for want of dollars, and the swap matures once the Account is funded',
    accounting: 'Principal paid is an amount lent (in yen), principal received an amount owed (in dollars); interest is realized P&L at the rate of its day; yen balances are revalued at the current rate and the difference is the FX effect; price amounts (mark, termination) are in dollars, the trading currency stated on the contract',
    collateral: 'Agreement "CSA Dealer F" covering the Account and Treasury, posted by Treasury: variation margin in full, in USD, from Treasury\'s cash against the Account\'s swap; reduced after the partial termination; returned at maturity',
  },
  tradedOn: 'The contract names a collateral agreement, so a step registers it (Instruments, New instrument) once the agreement exists; it is then traded from the instrument drawer like the other registered swaps of this file.',
  start: at('2026-03-18'),
  settlementCheck: { lag: 2, holidays: [] }, // no Federal Reserve holiday in the settlement windows used (18 to 23 March, 6 to 8 October 2026)
  book: {
    name: 'Matrix cross-currency basis swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'JPY', amount: 1_560_000_000 }],
    account: { name: 'Yen desk', funding: [{ ccy: 'USD', amount: 200_000 }, { ccy: 'JPY', amount: 1_560_000_000 }] },
    settings: { fees: { swap: NO_FEE }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {},
  fx: { 'USD/JPY': 150 },
  rates: {
    TSFR3M: { byDate: { '2026-03-23': 4.20, '2026-06-23': 4.05, '2026-09-18': 3.90, '2026-12-23': 3.75 } },
    TORF3M: { currency: 'JPY', byDate: { '2026-03-23': 0.75, '2026-06-23': 0.80, '2026-09-18': 0.85, '2026-12-23': 0.90 } },
  },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 200_000, unsettled: 0, margin: 0, restricted: 0, borrowed: 0, lent: 0, availableToTrade: 200_000 }, JPY: { settled: 1_560_000_000, unsettled: 0, borrowed: 0, lent: 0, availableToTrade: 1_560_000_000 } },
      treasury: { USD: { settled: 800_000, unsettled: 0, margin: 0, availableToTrade: 800_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], lifecycleFailures: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 10_600_000, treasury: 800_000, book: 11_400_000 }, // 200,000 + 1,560,000,000 / 150
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      id: 'record-agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer F', counterparty: 'Dealer F', kind: 'bilateral', covers: ['account', 'treasury'], postedBy: 'treasury', independentAmount: { type: 'none' }, variationMargin: true, threshold: 0, minimumTransfer: 0, baseCcy: 'USD', postingCcy: 'USD', haircut: 0, nettingScope: 'shared' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer F with Dealer F (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    { id: 'register-under-agreement', covers: 'registration', action: 'register_instrument', as: 'main', draft: XBS_DRAFT, expect: {} },
    {
      // Opposite side, 8,000,000 USD of notional, no upfront amount. The swap starts on Monday: no principal moves and none is required today.
      id: 'open', covers: ['open', 'before the effective date'], action: 'ticket', instrument: 'main', side: 'sell', qty: 8_000_000, as: 'basis', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 8_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-03-20', calendar: 'USD', cash: 0, fees: 0, otherCash: {} }],
          cash: { USD: { purchases: 0, proceeds: 0, fees: 0, margin: 0, required: 0, available: 200_000, shortfall: 0 } }, // the price is in dollars, the currency stated on the contract
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 8_000_000, avgPrice: 0, fills: [{ qty: 8_000_000, price: 0, model: 'stated-price', settleDate: '2026-03-20' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Entered on the opposite side: 8,000,000 notional of XCCY-USDJPY-0327 at 0.00 per 100 notional', owner: 'account', date: '2026-03-18' }],
        cash: { account: { USD: { settled: 200_000, unsettled: 0 }, JPY: { settled: 1_560_000_000, unsettled: 0 } } },
        positions: [{ instrument: 'main', lot: 'basis', owner: 'account', direction: 'opposite side', qty: -8_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 8_000_000, margin: 0 }],
        holdings: { main: { long: 0, short: 8_000_000, net: -8_000_000 } },
        pending: [],
        lifecycle: [
          { type: 'swap.notional', instrument: 'main', dueDate: '2026-03-23', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-06-23', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-06-23', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-23', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'basis', owner: 'account', qty: -8_000_000, basis: 'agreement', agreement: 'CSA Dealer F', postedBy: 'treasury', iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0, vmCcy: 'USD', vmStatus: 'not_valued_yet' }],
        pnl: { account: { realized: 0, commissions: 0, unrealized: 0, fx: 0, total: 0 } },
        nav: { account: 10_600_000, treasury: 800_000, book: 11_400_000 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 10_600_000, positions: null, lent: null, borrowed: null, assets: 10_600_000, liabilities: 0, netAssets: 10_600_000 } },
      },
    },
    {
      id: 'no-mark-no-call', covers: 'variation margin', action: 'clock', to: at('2026-03-19'),
      expect: { otc: [{ instrument: 'main', vmStatus: 'cannot_value', vmPosted: 0 }], alerts: ['collateral.unvalued'] },
    },
    {
      // 2,000,000 more on the same terms. It settles Monday 23 March, the effective date, so its principal is exchanged with that settlement
      // and is part of what the trade needs: 2,000,000 x 150 = 300,000,000 JPY to pay, 2,000,000 USD to receive.
      id: 'increase', covers: ['increase', 'notional exchange'], action: 'resize', lot: 'basis', factor: 1.25, order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-03-23', cash: 0, fees: 0, otherCash: { JPY: -300_000_000, USD: 2_000_000 } }],
          cash: { JPY: { purchases: 300_000_000, proceeds: 0, required: 300_000_000, available: 1_560_000_000, shortfall: 0 }, USD: { purchases: 0, proceeds: 2_000_000, required: 0, available: 200_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2_000_000, avgPrice: 0 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Increased on the opposite side: 2,000,000 notional of XCCY-USDJPY-0327 at 0.00 per 100 notional' }],
        positions: [{ instrument: 'main', lot: 'basis', qty: -10_000_000, cost: 0, notional: 10_000_000 }],
        holdings: { main: { long: 0, short: 10_000_000, net: -10_000_000 } },
        otc: [{ instrument: 'main', qty: -10_000_000 }],
        nav: { account: 10_600_000, book: 11_400_000 },
      },
    },
    {
      // The effective date. Principal: 10,000,000 x 150 = 1,500,000,000 JPY paid (an amount lent), 10,000,000 USD received (an amount owed).
      // Net assets do not change: 10,200,000 - 10,000,000 owed + (60,000,000 + 1,500,000,000) / 150.
      id: 'initial-exchange', covers: 'notional exchange', action: 'clock', to: at('2026-03-23'),
      expect: {
        events: [
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XBS_NAME}: paid 1,500,000,000 JPY`, cash: { JPY: -1_500_000_000 }, owner: 'account', date: '2026-03-23' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XBS_NAME}: received 10,000,000.00 USD`, cash: { USD: 10_000_000 }, owner: 'account', date: '2026-03-23' },
        ],
        cash: { account: { JPY: { settled: 60_000_000, lent: 1_500_000_000, borrowed: 0, availableToTrade: 60_000_000 }, USD: { settled: 10_200_000, borrowed: 10_000_000, lent: 0, availableToTrade: 10_200_000 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-06-23', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-06-23', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-23', status: 'pending' },
        ],
        pnl: { account: { realized: 0, fx: 0, total: 0 } },
        nav: { account: 10_600_000, book: 11_400_000 },
        balance: { account: { cash: 10_600_000, lent: 10_000_000, borrowed: 10_000_000, assets: 20_600_000, liabilities: 10_000_000, netAssets: 10_600_000 } }, // cash 10,200,000 + 60,000,000 / 150
      },
    },
    {
      // The mark is of the contract as written, in dollars per 100 of dollar notional. On the opposite side: -10,000,000 x 0.10 / 100 = -10,000 USD.
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.10, note: 'Dealer mark, by hand, excluding the principal',
      expect: {
        positions: [{ instrument: 'main', lot: 'basis', qty: -10_000_000, price: 0.1, value: -10_000, unrealized: -10_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: 0.1, markValue: -10_000 }],
        pnl: { account: { unrealized: -10_000, total: -10_000 } },
        nav: { account: 10_590_000, book: 11_390_000 },
        provisional: { account: false, book: false },
        balance: { account: { positions: -10_000, assets: 20_590_000, netAssets: 10_590_000 } },
      },
    },
    {
      // No threshold: the whole 10,000 is posted, and it is Treasury's cash that moves. The Account's cash is untouched.
      id: 'variation-margin-posted-by-treasury', covers: ['variation margin', 'collateral'], action: 'clock', to: eod('2026-03-23'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer F" (Dealer F): 10,000.00 USD posted. Netting set of 1 position marked at -10,000.00 USD; threshold 0.00 USD. Moved by Treasury.', cash: { USD: -10_000 }, date: '2026-03-23' }],
        cash: { treasury: { USD: { settled: 790_000, margin: 10_000, availableToTrade: 790_000 } }, account: { USD: { settled: 10_200_000, margin: 0 } } },
        otc: [{ instrument: 'main', postedBy: 'treasury', vmPosted: 10_000, vmHeld: 0, vmExposure: -10_000, vmStatus: 'ok' }],
        alerts: [],
        nav: { account: 10_590_000, treasury: 800_000, book: 11_390_000 },
        balance: { treasury: { cash: 790_000, margin: 10_000, assets: 800_000, liabilities: 0, netAssets: 800_000 } },
      },
    },
    {
      // First quarter. Yen leg, received: 1,500,000,000 x (0.75% - 0.35%) x 92/365 = 1,512,328.77, in whole yen 1,512,329 (10,082.19 USD at 150).
      // Dollar leg, paid: 10,000,000 x 4.20% x 92/360 = 107,333.33.
      id: 'first-quarter', covers: 'floating payment', action: 'clock', to: at('2026-06-23'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${XBS_NAME}, leg A (float), period 2026-03-23 to 2026-06-23: 1,512,329 JPY`, cash: { JPY: 1_512_329 }, owner: 'account', date: '2026-06-23' },
          { type: 'swap.payment', summary: `Swap payment on ${XBS_NAME}, leg B (float), period 2026-03-23 to 2026-06-23: 107,333.33 USD`, cash: { USD: -107_333.33 }, owner: 'account', date: '2026-06-23' },
        ],
        cash: { account: { JPY: { settled: 61_512_329, availableToTrade: 61_512_329 }, USD: { settled: 10_092_666.67, availableToTrade: 10_092_666.67 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-24', status: 'pending' }, // 23 September is a holiday in Tokyo
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-24', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-23', status: 'pending' },
        ],
        pnl: { account: { realized: -97_251.14, unrealized: -10_000, fx: 0, total: -107_251.14 } }, // 10,082.19 - 107,333.33
        nav: { account: 10_492_748.86, book: 11_292_748.86 },
        balance: { account: { cash: 10_502_748.86, assets: 20_492_748.86, netAssets: 10_492_748.86 } }, // 10,092,666.67 + 61,512,329 / 150
      },
    },
    { id: 'mid-july', action: 'clock', to: at('2026-07-15'), expect: { events: [] } },
    {
      // The yen weakens to 156. Cash 61,512,329 / 156 = 394,309.80 against 410,082.19 booked: -15,772.39. Lent 1,500,000,000 / 156 = 9,615,384.62 against 10,000,000: -384,615.38.
      // FX effect -400,387.77. The dollars owed do not move.
      id: 'yen-weakens', covers: 'reporting currency', action: 'fx_rate', pair: 'USD/JPY', rate: 156,
      expect: {
        pnl: { account: { realized: -97_251.14, unrealized: -10_000, fx: -400_387.77, total: -507_638.91 } },
        nav: { account: 10_092_361.09, treasury: 800_000, book: 10_892_361.09 }, // 10,092,666.67 - 10,000,000 - 10,000 + 1,561,512,329 / 156
        balance: { account: { cash: 10_486_976.47, lent: 9_615_384.62, borrowed: 10_000_000, positions: -10_000, assets: 20_092_361.09, liabilities: 10_000_000, netAssets: 10_092_361.09 } },
      },
    },
    {
      // The autumn equinox: the Federal Reserve is open, Tokyo is not. Nothing is paid in either currency today.
      id: 'holiday-in-tokyo', covers: 'payment across a holiday', action: 'clock', to: at('2026-09-23'),
      expect: { events: [], cash: { account: { JPY: { settled: 61_512_329 }, USD: { settled: 10_092_666.67 } } } },
    },
    {
      // Thursday 24 September. Yen leg: 1,500,000,000 x (0.80% - 0.35%) x 92/365 = 1,701,369.86, 1,701,370 yen (10,906.22 USD at 156). Dollar leg: 10,000,000 x 4.05% x 92/360 = 103,500.00.
      id: 'second-quarter', covers: ['floating payment', 'payment across a holiday'], action: 'clock', to: at('2026-09-24'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${XBS_NAME}, leg A (float), period 2026-06-23 to 2026-09-23: 1,701,370 JPY`, cash: { JPY: 1_701_370 }, date: '2026-09-24' },
          { type: 'swap.payment', summary: `Swap payment on ${XBS_NAME}, leg B (float), period 2026-06-23 to 2026-09-23: 103,500.00 USD`, cash: { USD: -103_500 }, date: '2026-09-24' },
        ],
        cash: { account: { JPY: { settled: 63_213_699, availableToTrade: 63_213_699 }, USD: { settled: 9_989_166.67, availableToTrade: 9_989_166.67 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-23', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-23', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-23', status: 'pending' },
        ],
        // FX effect: cash 63,213,699 / 156 = 405,216.019 against 420,988.41 booked, lent as before: -400,387.775, shown as -400,387.78.
        pnl: { account: { realized: -189_844.92, unrealized: -10_000, fx: -400_387.78, total: -600_232.70 } }, // -97,251.14 + 10,906.22 - 103,500
        nav: { account: 9_999_767.30, book: 10_799_767.30 }, // 9,989,166.67 - 10,000,000 - 10,000 + 1,563,213,699 / 156
        // Net assets are the NAV: yen converted once, 1,563,213,699 / 156 = 10,020,600.63. The two yen lines are each rounded on their own (405,216.02 and 9,615,384.62).
        balance: { account: { cash: 10_394_382.69, lent: 9_615_384.62, borrowed: 10_000_000, positions: -10_000, assets: 19_999_767.30, liabilities: 10_000_000, netAssets: 9_999_767.30 } }, // cash 9,989,166.67 + 405,216.02
      },
    },
    { id: 'early-october', action: 'clock', to: at('2026-10-06'), expect: { events: [] } },
    {
      // 40% (4,000,000 USD) is terminated at -0.05 per 100 as written: on the opposite side 4,000,000 x 0.05 / 100 = 2,000 USD is received. Settles Thursday 8 October.
      // Its principal goes back with that settlement: 4,000,000 USD to pay, 600,000,000 JPY to receive. Left: 6,000,000, marked 0.10: -6,000.
      id: 'partial-termination', covers: ['reduce', 'partial termination', 'notional exchange'], action: 'close', lot: 'basis', scope: 'strategy', percent: 40, order: { statedPrice: -0.05 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4_000_000, estimate: -0.05, model: 'stated-price', settleDate: '2026-10-08', cash: 2_000, fees: 0, otherCash: { JPY: 600_000_000, USD: -4_000_000 } }],
          cash: { USD: { purchases: 4_000_000, proceeds: 2_000, required: 4_000_000, available: 9_989_166.67, shortfall: 0 }, JPY: { purchases: 0, proceeds: 600_000_000, required: 0, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 4_000_000, avgPrice: -0.05 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Terminated in part: 4,000,000 of 10,000,000 notional of XCCY-USDJPY-0327 at -0.05 per 100 notional (realized 2,000.00 USD)' }],
        cash: { account: { USD: { settled: 9_989_166.67, unsettled: 2_000, borrowed: 10_000_000, availableToTrade: 9_991_166.67 }, JPY: { settled: 63_213_699, lent: 1_500_000_000 } } },
        positions: [{ instrument: 'main', lot: 'basis', qty: -6_000_000, cost: 0, price: 0.1, value: -6_000, unrealized: -6_000, notional: 6_000_000 }],
        holdings: { main: { long: 0, short: 6_000_000, net: -6_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-10-08', amount: 2_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.notional', instrument: 'main', dueDate: '2026-10-08', status: 'pending' }, // the principal of the part terminated
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-23', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-23', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-23', status: 'pending' },
        ],
        otc: [{ instrument: 'main', qty: -6_000_000, markValue: -6_000, vmPosted: 10_000 }],
        pnl: { account: { realized: -187_844.92, unrealized: -6_000, fx: -400_387.78, total: -594_232.70 } },
        nav: { account: 10_005_767.30, book: 10_805_767.30 }, // 9,999,767.30 + 2,000 received + 4,000 less of the mark
        balance: { account: { cash: 10_394_382.69, receivable: 2_000, positions: -6_000, lent: 9_615_384.62, borrowed: 10_000_000, assets: 20_005_767.30, liabilities: 10_000_000, netAssets: 10_005_767.30 } },
      },
    },
    {
      // -6,000 now calls for 6,000: 4,000 of the 10,000 comes back to Treasury.
      id: 'variation-margin-trimmed', covers: 'variation margin', action: 'clock', to: eod('2026-10-06'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer F" (Dealer F): 4,000.00 USD returned to us. Netting set of 1 position marked at -6,000.00 USD; threshold 0.00 USD. Moved by Treasury.', cash: { USD: 4_000 } }],
        cash: { treasury: { USD: { settled: 794_000, margin: 6_000, availableToTrade: 794_000 } } },
        otc: [{ instrument: 'main', vmPosted: 6_000, vmExposure: -6_000, vmStatus: 'ok' }],
        nav: { treasury: 800_000 },
        balance: { treasury: { cash: 794_000, margin: 6_000, assets: 800_000, netAssets: 800_000 } },
      },
    },
    {
      // Thursday 8 October: the 2,000 USD settles and the principal of the part terminated goes back: 600,000,000 JPY received (3,846,153.85 USD at 156), 4,000,000 USD paid.
      // Left: 900,000,000 JPY lent, 6,000,000 USD owed. Net assets do not change.
      id: 'termination-settles-with-its-principal', covers: ['settlement', 'notional exchange'], action: 'clock', to: at('2026-10-08'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 2,000.00 USD into settled cash', cash: { USD: 2_000 }, date: '2026-10-08' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XBS_NAME}: received 600,000,000 JPY`, cash: { JPY: 600_000_000 }, owner: 'account', date: '2026-10-08' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XBS_NAME}: paid 4,000,000.00 USD`, cash: { USD: -4_000_000 }, owner: 'account', date: '2026-10-08' },
        ],
        cash: { account: { USD: { settled: 5_991_166.67, unsettled: 0, borrowed: 6_000_000, availableToTrade: 5_991_166.67 }, JPY: { settled: 663_213_699, lent: 900_000_000, availableToTrade: 663_213_699 } } },
        pending: [],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-23', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-23', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-23', status: 'pending' },
        ],
        pnl: { account: { realized: -187_844.92, unrealized: -6_000, fx: -400_387.78, total: -594_232.70 } },
        nav: { account: 10_005_767.30, book: 10_805_767.30 }, // 5,991,166.67 - 6,000,000 - 6,000 + 1,563,213,699 / 156
        balance: { account: { cash: 10_242_536.54, receivable: null, lent: 5_769_230.77, borrowed: 6_000_000, positions: -6_000, assets: 16_005_767.30, liabilities: 6_000_000, netAssets: 10_005_767.30 } }, // 5,991,166.67 + 663,213,699 / 156; 900,000,000 / 156
      },
    },
    {
      // Third quarter, on what is left, at the fixings of Friday 18 September. Yen leg: 900,000,000 x (0.85% - 0.35%) x 91/365 = 1,121,917.81, 1,121,918 yen (7,191.78 USD at 156).
      // Dollar leg: 6,000,000 x 3.90% x 91/360 = 59,150.00.
      id: 'third-quarter', covers: 'floating payment', action: 'clock', to: at('2026-12-23'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${XBS_NAME}, leg A (float), period 2026-09-23 to 2026-12-23: 1,121,918 JPY`, cash: { JPY: 1_121_918 }, date: '2026-12-23' },
          { type: 'swap.payment', summary: `Swap payment on ${XBS_NAME}, leg B (float), period 2026-09-23 to 2026-12-23: 59,150.00 USD`, cash: { USD: -59_150 }, date: '2026-12-23' },
        ],
        cash: { account: { JPY: { settled: 664_335_617, availableToTrade: 664_335_617 }, USD: { settled: 5_932_016.67, availableToTrade: 5_932_016.67 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-23', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-23', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-23', status: 'pending' },
        ],
        // FX effect: cash 664,335,617 / 156 = 4,258,561.647 against 4,274,334.04 booked; lent 5,769,230.769 against 6,153,846.15: -400,387.774, shown as -400,387.77.
        pnl: { account: { realized: -239_803.14, unrealized: -6_000, fx: -400_387.77, total: -646_190.91 } }, // -187,844.92 + 7,191.78 - 59,150
        nav: { account: 9_953_809.09, book: 10_753_809.09 },
        balance: { account: { cash: 10_190_578.32, assets: 15_953_809.09, liabilities: 6_000_000, netAssets: 9_953_809.09 } }, // 5,932,016.67 + 4,258,561.65
      },
    },
    { id: 'mid-february', action: 'clock', to: at('2027-02-10'), expect: { events: [] } },
    {
      // The yen strengthens to 144. Cash 664,335,617 / 144 = 4,613,441.78 against 4,274,334.04 booked: +339,107.74. Lent 900,000,000 / 144 = 6,250,000.00 against 6,153,846.15: +96,153.85.
      // FX effect +435,261.59.
      id: 'yen-strengthens', covers: 'reporting currency', action: 'fx_rate', pair: 'USD/JPY', rate: 144,
      expect: {
        pnl: { account: { realized: -239_803.14, unrealized: -6_000, fx: 435_261.59, total: 189_458.45 } },
        nav: { account: 10_789_458.45, treasury: 800_000, book: 11_589_458.45 }, // 5,932,016.67 - 6,000,000 - 6,000 + 1,564,335,617 / 144
        balance: { account: { cash: 10_545_458.45, lent: 6_250_000, borrowed: 6_000_000, positions: -6_000, assets: 16_789_458.45, liabilities: 6_000_000, netAssets: 10_789_458.45 } },
      },
    },
    {
      // Maturity date. Yen leg: 900,000,000 x (0.90% - 0.35%) x 90/365 = 1,220,547.95, 1,220,548 yen (8,476.03 USD at 144). Dollar leg: 6,000,000 x 3.75% x 90/360 = 56,250.00.
      // The principal must now go back: 6,000,000 USD to pay. The Account has paid its dollar interest out of the dollars and has 5,875,766.67 left.
      // The final exchange is not made in either currency, the swap is not ended, and the reason is shown.
      id: 'final-exchange-unfunded', covers: ['floating payment', 'notional exchange', 'insufficient cash'], action: 'clock', to: at('2027-03-23'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${XBS_NAME}, leg A (float), period 2026-12-23 to 2027-03-23: 1,220,548 JPY`, cash: { JPY: 1_220_548 }, date: '2027-03-23' },
          { type: 'swap.payment', summary: `Swap payment on ${XBS_NAME}, leg B (float), period 2026-12-23 to 2027-03-23: 56,250.00 USD`, cash: { USD: -56_250 }, date: '2027-03-23' },
        ],
        cash: { account: { JPY: { settled: 665_556_165, lent: 900_000_000, availableToTrade: 665_556_165 }, USD: { settled: 5_875_766.67, borrowed: 6_000_000, availableToTrade: 5_875_766.67 } } },
        positions: [{ instrument: 'main', lot: 'basis', qty: -6_000_000, value: -6_000 }],
        lifecycle: [],
        lifecycleFailures: [{ type: 'swap.maturity', instrument: 'main', dueDate: '2027-03-23', status: 'failed', owner: 'account', reason: /Final notional exchange on .* could not be made: 6,000,000\.00 USD is to be paid and Yen desk has 5,875,766\.67 USD of settled USD cash\. Nothing was exchanged in either currency\./ }],
        alerts: ['funding.failed'],
        failed: { lifecycle: 1 },
        pnl: { account: { realized: -287_577.11, unrealized: -6_000, fx: 435_261.59, total: 141_684.48 } }, // -239,803.14 + 8,476.03 - 56,250
        nav: { account: 10_741_684.48, book: 11_541_684.48 },
        balance: { account: { cash: 10_497_684.48, lent: 6_250_000, borrowed: 6_000_000, positions: -6_000, assets: 16_741_684.48, liabilities: 6_000_000, netAssets: 10_741_684.48 } }, // 5,875,766.67 + 665,556,165 / 144
      },
    },
    {
      // Treasury funds the Account with 150,000 USD. The swap then matures: 900,000,000 JPY comes back (6,250,000.00 USD at 144), 6,000,000 USD is repaid,
      // and the 6,000 of variation margin returns to Treasury.
      // The Account ends with 200,000 + 150,000 + 2,000 - 107,333.33 - 103,500 - 59,150 - 56,250 = 25,766.67 USD
      // and 1,560,000,000 + 1,512,329 + 1,701,370 + 1,121,918 + 1,220,548 = 1,565,556,165 JPY (10,871,917.81 USD at 144).
      id: 'funded-matured-and-exchanged', covers: ['maturity', 'close', 'notional exchange', 'collateral', 'insufficient cash'], action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 150_000,
      expect: {
        events: [
          { type: 'transfer.funding' },
          { type: 'swap.matured', summary: `Swap matured: ${XBS_NAME} (notional 6,000,000)`, owner: 'account' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XBS_NAME}: received 900,000,000 JPY`, cash: { JPY: 900_000_000 }, owner: 'account', date: '2027-03-23' },
          { type: 'swap.notional_exchange', summary: `Notional exchange on ${XBS_NAME}: paid 6,000,000.00 USD`, cash: { USD: -6_000_000 }, owner: 'account', date: '2027-03-23' },
          { type: 'collateral.variation', summary: /Variation margin under "CSA Dealer F" \(Dealer F\): 6,000\.00 USD returned to us\..*Moved by Treasury\./, cash: { USD: 6_000 } },
        ],
        cash: {
          account: { USD: { settled: 25_766.67, unsettled: 0, borrowed: 0, lent: 0, margin: 0, availableToTrade: 25_766.67 }, JPY: { settled: 1_565_556_165, lent: 0, borrowed: 0, availableToTrade: 1_565_556_165 } },
          treasury: { USD: { settled: 650_000, margin: 0, availableToTrade: 650_000 } },
        },
        positions: [], holdings: { main: null }, lifecycle: [], lifecycleFailures: [], otc: [], pending: [], alerts: [],
        failed: { lifecycle: 0 },
        // FX effect unchanged: cash 1,565,556,165 / 144 = 10,871,917.81 against 10,532,810.07 booked: +339,107.74; +96,153.85 on the principal that came back.
        pnl: { account: { realized: -287_577.11, unrealized: 0, fx: 435_261.59, total: 147_684.48 } },
        nav: { account: 10_897_684.48, treasury: 650_000, book: 11_547_684.48 }, // 25,766.67 + 10,871,917.81
        provisional: { account: false, book: false },
        balance: { account: { cash: 10_897_684.48, lent: null, borrowed: null, positions: null, assets: 10_897_684.48, liabilities: 0, netAssets: 10_897_684.48 }, treasury: { cash: 650_000, margin: null, assets: 650_000, netAssets: 650_000 } },
      },
    },
  ],
};

export default [interestRateSwap, overnightIndexSwap, basisSwap, interestRateCap, interestRateFloor, interestRateCollar, forwardStartingSwap, constantMaturitySwap, crossCurrencySwap, crossCurrencyBasisSwap];
