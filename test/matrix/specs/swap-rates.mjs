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

export default [interestRateSwap, overnightIndexSwap, basisSwap, interestRateCap];
