// Swap family, the swaps that are not rate swaps (engine family "swap"): amortizing and accreting swaps,
// equity and equity-index swaps, equity, bond and index total-return swaps, commodity, commodity-basis
// and commodity-index swaps, energy, electricity and freight swaps. One scenario per product, each on its
// own fictional contract registered as exactly that product, with the legs, schedules, calendars and
// collateral terms a real contract of it has. The rate swaps are in swap-rates.mjs (same rules, restated
// there in full); the browser driver is drivers/browser/swap.mjs.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The arithmetic
// is in the comment beside it. Nothing here is copied from what the Terminal prints.
//
// The Terminal's rules these scenarios rely on, restated so the arithmetic can be followed:
//   - A swap is a list of legs. "Enter as written" takes each leg's side as the contract states it; "Enter
//     the opposite side" reverses every leg. Quantity is the notional (for a commodity swap: the quantity
//     of the reference per period, in its unit). A leg's own notional is quantity x its notional factor.
//   - Price is an amount per 100 of notional: the upfront paid by the side that enters as written, and
//     the mark (net present value per 100), entered by hand. The mark is the whole value of the contract;
//     nothing is accrued in the ledger between payment dates.
//   - Periods are rolled back from the maturity date in steps of the leg's frequency. Accrual dates are
//     not adjusted; a payment date that is not a business day of the payment calendar moves to the next
//     one (modified following). Each leg pays on its own (gross).
//   - Notional schedule (amortizing, accreting): the notional of a period is the quantity x the factor the
//     schedule gives for the period's first day. An amortizing or accreting contract must state a factor for
//     the first day of every period of every leg that has a schedule; a period without one is refused at
//     registration. The quantity traded, terminated and quoted per 100 is the schedule's base notional.
//   - Return leg: notional x (fixing at period end / fixing at period start - 1); the fixing of a period
//     boundary is the close of that day (of the last business day before it when it is not one). The next
//     period starts from the fixing the last one ended on. "Notional resets": after each payment the notional
//     of every leg is multiplied by end / start fixing. "Total return": a cash dividend recorded on the
//     reference passes through at once: notional / start fixing (reference units) x dividend per unit.
//   - Price leg: quantity x units x (fixed price, or the floating price). The floating price is the fixing of
//     the period end, or (averaging "daily") the plain average, not rounded, of the fixings of every business
//     day of the leg's pricing calendar from the period's first day up to, not including, its end; a pricing
//     day without its fixing blocks the payment, visibly, naming the days. Delivery hours (electricity): the
//     quantity is also multiplied by the hours of the period (base 24 a calendar day; peak: peak hours a day x
//     pricing days; off-peak: base - peak; clock changes not counted).
//   - Collateral follows the basis the contract states (agreement, position-level terms, uncollateralized).
//     Variation margin moves in the end-of-day pass (17:00 New York) on the mark.
//   - Commission is the Book's fee schedule for swaps: an amount per unit of notional.

export const family = 'swap';

/** 10:00 New York as a UTC instant: 15:00 UTC in winter time, 14:00 UTC in daylight time. */
const dst = (date) => (date >= '2026-03-08' && date < '2026-11-01') || (date >= '2027-03-14' && date < '2027-11-07') || (date >= '2028-03-12' && date < '2028-11-05');
const at = (date, hhmm) => `${date}T${hhmm || (dst(date) ? '14:00' : '15:00')}:00.000Z`;
/** 17:30 New York: after the 17:00 end-of-day cutoff. */
const eod = (date) => at(date, dst(date) ? '21:30' : '22:30');

const FILL = { halfSpreadBps: { swap: 0, equity: 0, manual: 0 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const NO_FEE = { perUnit: 0, minimum: 0, bps: 0 };
const USD_CALENDARS = { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' };

const OTC_TICKET = {
  ticket: 'Registry form (Instruments, New instrument) for the contract: legs, schedules, calendars and the required Collateral terms group; then the instrument drawer, Trade tab (Enter as written / Enter the opposite side, Notional, State a fill price); the strategy instance for increase and termination',
  requiredFields: ['Effective date', 'Maturity', 'each leg: Side, Leg type, Currency, terms of its type, Payment', 'Collateral basis', 'Account', 'Action', 'Notional', 'State a fill price (no executable quote exists for an OTC contract)'],
};

/** A Book with `capital` in Treasury, `funding` of it moved to the Account. */
const bookOf = (name, accountName, ccy, capital, funding, fee = NO_FEE, otherFees = {}) => ({
  name, reportingCcy: ccy,
  capital: [{ ccy, amount: capital }],
  account: { name: accountName, funding: [{ ccy, amount: funding }] },
  settings: { fees: { swap: fee, ...otherFees }, fill: FILL, settlement: { swap: 2 } },
});
const startOf = (ccy, capital, funding) => ({
  cash: {
    account: { [ccy]: { settled: funding, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: funding } },
    treasury: { [ccy]: { settled: capital - funding, unsettled: 0, reserved: 0, restricted: 0, margin: 0 } },
  },
  positions: [], pending: [], openOrders: [], lifecycle: [], lifecycleFailures: [], borrowings: [], otc: [], alerts: [],
  nav: { account: funding, treasury: capital - funding, book: capital },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
});

// ---------------------------------------------------------------------------------------------
// amortizing_swap
// ---------------------------------------------------------------------------------------------
// Pay 3.80% fixed quarterly 30/360, receive 3-month term SOFR flat quarterly ACT/360, one year, USD (Federal
// Reserve) payment calendar. The notional amortizes: factor 1.00, 0.75, 0.50, 0.25 of the base notional for
// the four quarters, on both legs. Position-level collateral terms: a fixed independent amount of 100,000 and
// variation margin with a threshold of 25,000 and a minimum transfer of 5,000.
//
// Schedule (effective Monday 15 June 2026, maturity Tuesday 15 June 2027; no payment date needs adjusting):
//   period 1  2026-06-15 to 2026-09-15  92 days, 90/360  factor 1.00  fixing of 15 June
//   period 2  2026-09-15 to 2026-12-15  91 days, 90/360  factor 0.75  fixing of 15 September
//   period 3  2026-12-15 to 2027-03-15  90 days, 90/360  factor 0.50  fixing of 15 December (missing; entered by hand)
//   period 4  2027-03-15 to 2027-06-15  92 days, 90/360  factor 0.25  fixing of 15 March 2027
// Base notional 16,000,000, increased to 20,000,000 before the start, 40% terminated in October (12,000,000 left).
const AMORT_NAME = 'USD amortizing swap 3.80% v TSFR3M 15 Jun 2027';
const AMORT_SCHEDULE = [{ from: '2026-06-15', factor: 1 }, { from: '2026-09-15', factor: 0.75 }, { from: '2026-12-15', factor: 0.5 }, { from: '2027-03-15', factor: 0.25 }];
const amortDraft = (scheduleA, extra = {}) => ({
  productId: 'amortizing_swap', name: AMORT_NAME, symbol: 'AMORT-TSFR-0627', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
  conventions: USD_CALENDARS,
  terms: {
    effective: '2026-06-15', maturity: '2027-06-15', counterparty: 'Dealer M',
    collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 100_000 }, variationMargin: true, threshold: 25_000, minimumTransfer: 5_000 },
    legs: [
      { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.038, months: 3, dayCount: '30/360', notionalSchedule: scheduleA },
      { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0, months: 3, dayCount: 'ACT/360', notionalSchedule: AMORT_SCHEDULE },
    ],
  },
  ...extra,
});
const amortizingSwap = {
  productId: 'amortizing_swap',
  title: 'USD 1-year amortizing swap, pay 3.80% fixed against 3-month term SOFR on a notional falling by a quarter each quarter',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'each leg: Notional schedule (the first day of every period and its factor)'],
    automaticInputs: ['notional of each period from the schedule', 'payment schedule of each leg on the USD payment calendar', 'TSFR3M fixings (rate fixture standing in for Shaffer MarketData)', 'settlement date, T+2 on the USD calendar', 'commission from the Book fee schedule', 'independent amount and variation margin from the position-level terms'],
    manualInputs: ['notional schedule of each leg (contract form)', 'upfront amount of the increase and settlement amount of the partial termination (stated fill prices)', 'mark of the contract, entered by hand', 'a fixing the data service has not supplied, entered by hand'],
    settlement: 'Upfront and termination amounts and commission settle T+2 on the USD calendar; leg payments are cash on their payment date',
    lifecycle: 'A schedule missing a period is refused at registration; fixed and floating amounts each quarter on that quarter\'s notional; a floating payment whose fixing is missing waits until it is entered by hand; increase before the start; partial termination at a stated amount; maturity; nothing left afterwards',
    accounting: 'Carried at the mark less the upfront amounts paid; leg payments and the termination result are realized P&L; the upfront still carried is written off at maturity; commission expensed; no accrual between payment dates',
    collateral: 'Position-level terms: fixed independent amount 100,000 (posted at entry, unchanged by the increase and the partial termination, returned at maturity); variation margin at end of day on the mark entered by hand, threshold 25,000, minimum transfer 5,000. A percentage independent amount would follow the notional of the current period (exercised in accreting_swap)',
  },
  start: at('2026-06-11'),
  settlementCheck: { lag: 2, holidays: [] }, // no Federal Reserve holiday in the settlement windows used (11 to 16 June, 15 to 19 October 2026)
  book: bookOf('Matrix amortizing swap', 'Rates', 'USD', 5_000_000, 2_000_000, { perUnit: 0.00002, minimum: 0, bps: 0 }), // 20.00 per million of notional
  instruments: { main: amortDraft(AMORT_SCHEDULE) },
  rates: { TSFR3M: { byDate: { '2026-06-15': 4.20 } } },
  expectAtStart: startOf('USD', 5_000_000, 2_000_000),
  steps: [
    {
      // The fixed leg's schedule leaves out the third quarter (15 December): refused, with the date named. Nothing is registered.
      id: 'schedule-step-missing', covers: 'notional schedule', action: 'register_instrument',
      draft: amortDraft([{ from: '2026-06-15', factor: 1 }, { from: '2026-09-15', factor: 0.75 }, { from: '2027-03-15', factor: 0.25 }], { name: 'USD amortizing swap with a gap', symbol: 'AMORT-GAP' }),
      status: 'blocked', reason: 'An amortizing swap states the notional of every period; a period without its step is refused.',
      expect: { refused: 'Leg A: the notional schedule has no step for the period starting 2026-12-15. An amortizing swap states the notional of every period.' },
    },
    {
      // 16,000,000 base notional as written, no upfront. Commission 16,000,000 x 0.00002 = 320, settling Monday 15 June. Independent amount 100,000 fixed.
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 16_000_000, as: 'amort', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 16_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-06-15', calendar: 'USD', cash: 0, fees: 320 }],
          cash: { USD: { purchases: 0, fees: 320, margin: 100_000, required: 100_320, available: 2_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 16_000_000, avgPrice: 0, fills: [{ qty: 16_000_000, price: 0, model: 'stated-price', settleDate: '2026-06-15' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered as written: 16,000,000 notional of AMORT-TSFR-0627 at 0.00 per 100 notional', owner: 'account', date: '2026-06-11' },
          { type: 'swap.collateral', summary: `Collateral posted on ${AMORT_NAME} under its position-level terms: 100,000.00 USD (independent amount, fixed amount for the position)`, cash: { USD: -100_000 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 1_900_000, unsettled: -320, margin: 100_000, restricted: 0, availableToTrade: 1_899_680, availableToWithdraw: 1_899_680 } } },
        positions: [{ instrument: 'main', lot: 'amort', owner: 'account', direction: 'as written', qty: 16_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 16_000_000, margin: 100_000, accrued: 0 }],
        holdings: { main: { long: 16_000_000, short: 0, net: 16_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-06-15', amount: -320, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-15', status: 'pending' }, // fixed, first quarter
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-15', status: 'pending' }, // floating, first quarter
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'amort', owner: 'account', qty: 16_000_000, basis: 'position', mark: null, iaRequired: 100_000, iaPosted: 100_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -320, fees: 0, unrealized: 0, total: -320 } },
        nav: { account: 1_999_680, book: 4_999_680 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_900_000, margin: 100_000, payable: 320, positions: null, accruedIncome: null, accruedExpense: null, assets: 2_000_000, liabilities: 320, netAssets: 1_999_680 } },
      },
    },
    {
      // The end-of-day pass for 11 June runs with no mark: no variation margin can be called, and that is said.
      id: 'no-mark-no-call', covers: 'variation margin', action: 'clock', to: at('2026-06-12'),
      expect: { otc: [{ instrument: 'main', vmStatus: 'cannot_value', vmReason: /AMORT-TSFR-0627 has no mark/, vmPosted: 0 }], alerts: ['collateral.unvalued'] },
    },
    {
      // 16,000,000 to 20,000,000 at 0.02 per 100: 4,000,000 x 0.02 / 100 = 800 paid; commission 80; settles Tuesday 16 June.
      // Before the effective date, so the added notional takes every period. The fixed independent amount does not change.
      id: 'increase', covers: ['increase'], action: 'resize', lot: 'amort', factor: 1.25, order: { statedPrice: 0.02 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4_000_000, estimate: 0.02, model: 'stated-price', settleDate: '2026-06-16', cash: -800, fees: 80 }],
          cash: { USD: { purchases: 800, fees: 80, margin: 0, required: 880, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 4_000_000, avgPrice: 0.02 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Increased as written: 4,000,000 notional of AMORT-TSFR-0627 at 0.02 per 100 notional' }],
        cash: { account: { USD: { settled: 1_900_000, unsettled: -1_200, availableToTrade: 1_898_800, availableToWithdraw: 1_898_800 } } },
        positions: [{ instrument: 'main', lot: 'amort', qty: 20_000_000, cost: 800, avgCost: 0.004, price: null, value: null, notional: 20_000_000, margin: 100_000 }], // 800 / (20,000,000 / 100)
        holdings: { main: { long: 20_000_000, short: 0, net: 20_000_000 } },
        pending: [{ instrument: 'main', dueDate: '2026-06-15', amount: -320, ccy: 'USD', into: 'cash' }, { instrument: 'main', dueDate: '2026-06-16', amount: -880, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 20_000_000, iaRequired: 100_000, iaPosted: 100_000 }],
        pnl: { account: { commissions: -400, total: -400 } },
        nav: { account: 1_999_600, book: 4_999_600 }, // carried at the 800 paid
        balance: { account: { payable: 1_200, positions: 800, assets: 2_000_800, liabilities: 1_200, netAssets: 1_999_600 } },
      },
    },
    {
      // 20,000,000 x -0.20 / 100 = -40,000; 40,800 below the 800 paid.
      id: 'mark-negative', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.20, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'amort', price: -0.2, value: -40_000, unrealized: -40_800, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: -0.2, markValue: -40_000 }],
        pnl: { account: { unrealized: -40_800, total: -41_200 } },
        nav: { account: 1_958_800, book: 4_958_800 },
        provisional: { account: false, book: false },
        balance: { account: { positions: -40_000, assets: 1_960_000, netAssets: 1_958_800 } },
      },
    },
    {
      // -40,000 is 15,000 beyond the 25,000 threshold (more than the 5,000 minimum transfer): 15,000 posted.
      id: 'variation-margin-call', covers: 'variation margin', action: 'clock', to: eod('2026-06-12'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 15,000.00 USD posted. Netting set of 1 position marked at -40,000.00 USD; threshold 25,000.00 USD.', cash: { USD: -15_000 }, owner: 'account', date: '2026-06-12' }],
        cash: { account: { USD: { settled: 1_885_000, margin: 115_000, availableToTrade: 1_883_800, availableToWithdraw: 1_883_800 } } },
        otc: [{ instrument: 'main', vmPosted: 15_000, vmHeld: 0, vmExposure: -40_000, vmStatus: 'ok' }],
        alerts: [],
        balance: { account: { cash: 1_885_000, margin: 115_000 } },
      },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-06-15'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 320.00 USD from settled cash', cash: { USD: -320 }, date: '2026-06-15' }],
        cash: { account: { USD: { settled: 1_884_680, unsettled: -880, availableToTrade: 1_883_800, availableToWithdraw: 1_883_800 } } },
        pending: [{ instrument: 'main', dueDate: '2026-06-16', amount: -880, ccy: 'USD', into: 'cash' }],
        balance: { account: { cash: 1_884_680, payable: 880, assets: 1_959_680, liabilities: 880 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-06-16'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 880.00 USD from settled cash', cash: { USD: -880 } }],
        cash: { account: { USD: { settled: 1_883_800, unsettled: 0, availableToTrade: 1_883_800, availableToWithdraw: 1_883_800 } } },
        pending: [],
        balance: { account: { cash: 1_883_800, payable: null, assets: 1_958_800, liabilities: 0 } },
      },
    },
    {
      // 20,000,000 x 0.05 / 100 = 10,000; 9,200 above the 800 paid.
      id: 'mark-recovers', action: 'manual_price', instrument: 'main', value: 0.05, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'amort', price: 0.05, value: 10_000, unrealized: 9_200 }],
        otc: [{ instrument: 'main', mark: 0.05, markValue: 10_000 }],
        pnl: { account: { unrealized: 9_200, total: 8_800 } },
        nav: { account: 2_008_800, book: 5_008_800 },
        balance: { account: { positions: 10_000, assets: 2_008_800, netAssets: 2_008_800 } },
      },
    },
    {
      // +10,000 is inside the threshold: nothing is required and the 15,000 comes back.
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-06-16'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 15,000.00 USD returned to us. Netting set of 1 position marked at 10,000.00 USD; threshold 25,000.00 USD.', cash: { USD: 15_000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 1_898_800, margin: 100_000, availableToTrade: 1_898_800, availableToWithdraw: 1_898_800 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 0, vmExposure: 10_000, vmStatus: 'ok' }],
        balance: { account: { cash: 1_898_800, margin: 100_000 } },
      },
    },
    {
      // First quarter, factor 1.00: notional 20,000,000.
      //   fixed, paid:     20,000,000 x 3.80% x 90/360 = 190,000.00
      //   float, received: 20,000,000 x 4.20% x 92/360 = 214,666.67
      id: 'first-quarter', covers: ['fixed payment', 'floating payment', 'notional schedule'], action: 'clock', to: at('2026-09-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${AMORT_NAME}, leg A (fixed), period 2026-06-15 to 2026-09-15: 190,000.00 USD`, cash: { USD: -190_000 }, owner: 'account', date: '2026-09-15' },
          { type: 'swap.payment', summary: `Swap receipt on ${AMORT_NAME}, leg B (float), period 2026-06-15 to 2026-09-15: 214,666.67 USD`, cash: { USD: 214_666.67 }, owner: 'account', date: '2026-09-15' },
        ],
        cash: { account: { USD: { settled: 1_923_466.67, availableToTrade: 1_923_466.67, availableToWithdraw: 1_923_466.67 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
        ],
        pnl: { account: { realized: 24_666.67, total: 33_466.67 } }, // 214,666.67 - 190,000; then - 400 + 9,200
        nav: { account: 2_033_466.67, book: 5_033_466.67 },
        balance: { account: { cash: 1_923_466.67, accruedIncome: null, accruedExpense: null, assets: 2_033_466.67, netAssets: 2_033_466.67 } },
      },
    },
    { id: 'september-fixing', action: 'rate', code: 'TSFR3M', value: 4.00, date: '2026-09-15', expect: {} },
    { id: 'mid-october', action: 'clock', to: at('2026-10-15'), expect: {} },
    {
      // 40% of the 20,000,000 base notional (8,000,000) terminated at 0.10 per 100, received: 8,000,000 x 0.10 / 100 = 8,000.
      // Commission 160. Upfront carried on it: 800 x 40% = 320. Realized 7,680. Thursday 15 October, settles Monday 19 October.
      // Left: 12,000,000 base notional carrying 480, marked 0.05: 6,000, 5,520 up. The fixed independent amount stays 100,000.
      id: 'partial-termination', covers: ['reduce', 'partial termination'], action: 'close', lot: 'amort', scope: 'strategy', percent: 40, order: { statedPrice: 0.10 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 8_000_000, estimate: 0.1, model: 'stated-price', settleDate: '2026-10-19', cash: 8_000, fees: 160 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 8_000_000, avgPrice: 0.1 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Terminated in part: 8,000,000 of 20,000,000 notional of AMORT-TSFR-0627 at 0.10 per 100 notional (realized 7,680.00 USD)' }],
        cash: { account: { USD: { settled: 1_923_466.67, unsettled: 7_840, availableToTrade: 1_931_306.67, availableToWithdraw: 1_923_466.67 } } },
        positions: [{ instrument: 'main', lot: 'amort', qty: 12_000_000, cost: 480, avgCost: 0.004, price: 0.05, value: 6_000, unrealized: 5_520, notional: 12_000_000, margin: 100_000 }],
        holdings: { main: { long: 12_000_000, short: 0, net: 12_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-10-19', amount: 7_840, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 12_000_000, markValue: 6_000, iaRequired: 100_000, iaPosted: 100_000 }],
        pnl: { account: { realized: 32_346.67, commissions: -560, unrealized: 5_520, total: 37_306.67 } },
        nav: { account: 2_037_306.67, book: 5_037_306.67 },
        balance: { account: { cash: 1_923_466.67, margin: 100_000, receivable: 7_840, positions: 6_000, assets: 2_037_306.67, liabilities: 0, netAssets: 2_037_306.67 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2026-10-19'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 7,840.00 USD into settled cash', cash: { USD: 7_840 } }],
        cash: { account: { USD: { settled: 1_931_306.67, unsettled: 0, availableToTrade: 1_931_306.67, availableToWithdraw: 1_931_306.67 } } },
        pending: [],
        balance: { account: { cash: 1_931_306.67, receivable: null } },
      },
    },
    {
      // Second quarter, factor 0.75 of the 12,000,000 left: 9,000,000.
      //   fixed, paid:     9,000,000 x 3.80% x 90/360 = 85,500.00
      //   float, received: 9,000,000 x 4.00% x 91/360 = 91,000.00
      id: 'second-quarter', covers: ['fixed payment', 'floating payment', 'notional schedule'], action: 'clock', to: at('2026-12-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${AMORT_NAME}, leg A (fixed), period 2026-09-15 to 2026-12-15: 85,500.00 USD`, cash: { USD: -85_500 }, date: '2026-12-15' },
          { type: 'swap.payment', summary: `Swap receipt on ${AMORT_NAME}, leg B (float), period 2026-09-15 to 2026-12-15: 91,000.00 USD`, cash: { USD: 91_000 }, date: '2026-12-15' },
        ],
        cash: { account: { USD: { settled: 1_936_806.67, availableToTrade: 1_936_806.67, availableToWithdraw: 1_936_806.67 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
        ],
        pnl: { account: { realized: 37_846.67, total: 42_806.67 } }, // 32,346.67 + 5,500; then - 560 + 5,520
        nav: { account: 2_042_806.67, book: 5_042_806.67 },
        balance: { account: { cash: 1_936_806.67, assets: 2_042_806.67, netAssets: 2_042_806.67 } },
      },
    },
    {
      // Third quarter, factor 0.50: 6,000,000. Fixed, paid: 6,000,000 x 3.80% x 90/360 = 57,000.00.
      // The floating amount needs the fixing of 15 December, which has not been supplied: it waits. No rate is assumed.
      id: 'third-quarter-fixing-missing', covers: ['fixed payment', 'missing fixing', 'notional schedule'], action: 'clock', to: at('2027-03-15'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${AMORT_NAME}, leg A (fixed), period 2026-12-15 to 2027-03-15: 57,000.00 USD`, cash: { USD: -57_000 }, date: '2027-03-15' }],
        cash: { account: { USD: { settled: 1_879_806.67, availableToTrade: 1_879_806.67, availableToWithdraw: 1_879_806.67 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-15', status: 'blocked', reason: /Awaiting the TSFR3M fixing for 2026-12-15/ },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
        ],
        pnl: { account: { realized: -19_153.33, total: -14_193.33 } }, // 37,846.67 - 57,000; then - 560 + 5,520
        nav: { account: 1_985_806.67, book: 4_985_806.67 },
        balance: { account: { cash: 1_879_806.67, assets: 1_985_806.67, netAssets: 1_985_806.67 } },
      },
    },
    {
      // 3.75% for 15 December, by hand. Float, received: 6,000,000 x 3.75% x 90/360 = 56,250.00.
      id: 'fixing-entered-by-hand', covers: ['missing fixing', 'floating payment'], action: 'manual_rate', code: 'TSFR3M', value: 3.75, date: '2026-12-15', note: 'Published fixing, entered by hand',
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${AMORT_NAME}, leg B (float), period 2026-12-15 to 2027-03-15: 56,250.00 USD`, cash: { USD: 56_250 }, date: '2027-03-15' }],
        cash: { account: { USD: { settled: 1_936_056.67, availableToTrade: 1_936_056.67, availableToWithdraw: 1_936_056.67 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
        ],
        pnl: { account: { realized: 37_096.67, total: 42_056.67 } }, // -19,153.33 + 56,250
        nav: { account: 2_042_056.67, book: 5_042_056.67 },
        balance: { account: { cash: 1_936_056.67, assets: 2_042_056.67, netAssets: 2_042_056.67 } },
      },
    },
    { id: 'march-fixing', action: 'rate', code: 'TSFR3M', value: 3.60, date: '2027-03-15', expect: {} },
    {
      // Last quarter, factor 0.25: 3,000,000.
      //   fixed, paid:     3,000,000 x 3.80% x 90/360 = 28,500.00
      //   float, received: 3,000,000 x 3.60% x 92/360 = 27,600.00
      // The swap matures: the 480 of upfront still carried is written off, and the 100,000 independent amount comes back.
      // 2,000,000 - 400 - 800 + 8,000 - 160 + 24,666.67 + 5,500 - 57,000 + 56,250 - 900 = 2,035,156.67.
      id: 'last-quarter-and-maturity', covers: ['fixed payment', 'floating payment', 'notional schedule', 'maturity', 'close', 'collateral'], action: 'clock', to: at('2027-06-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${AMORT_NAME}, leg A (fixed), period 2027-03-15 to 2027-06-15: 28,500.00 USD`, cash: { USD: -28_500 }, date: '2027-06-15' },
          { type: 'swap.payment', summary: `Swap receipt on ${AMORT_NAME}, leg B (float), period 2027-03-15 to 2027-06-15: 27,600.00 USD`, cash: { USD: 27_600 }, date: '2027-06-15' },
          { type: 'swap.matured', summary: `Swap matured: ${AMORT_NAME} (notional 12,000,000)`, owner: 'account' },
          { type: 'swap.collateral', summary: `Collateral returned on ${AMORT_NAME} under its position-level terms: 100,000.00 USD (independent amount, the position ended)`, cash: { USD: 100_000 } },
        ],
        cash: { account: { USD: { settled: 2_035_156.67, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 2_035_156.67, availableToWithdraw: 2_035_156.67 } }, treasury: { USD: { settled: 3_000_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        pnl: { account: { realized: 35_716.67, commissions: -560, unrealized: 0, total: 35_156.67 } }, // 37,096.67 - 900 - 480
        nav: { account: 2_035_156.67, treasury: 3_000_000, book: 5_035_156.67 },
        balance: { account: { cash: 2_035_156.67, margin: null, positions: null, assets: 2_035_156.67, liabilities: 0, netAssets: 2_035_156.67 } },
      },
    },
    {
      // The next end of day and morning: nothing is paid, posted, accrued or scheduled.
      id: 'nothing-left', action: 'clock', to: at('2027-06-16'),
      expect: { events: [], lifecycle: [], positions: [], pending: [], otc: [], alerts: [], cash: { account: { USD: { settled: 2_035_156.67, margin: 0, restricted: 0 } } } },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// accreting_swap
// ---------------------------------------------------------------------------------------------
// The contract is written "pay 3.50% fixed quarterly 30/360, receive 3-month term SOFR quarterly ACT/360" on a
// notional that accretes: factor 0.40, 0.70, 1.00, 1.00 of the base notional for the four quarters, both legs (a
// construction-loan hedge seen from the lender's side). The Account enters the opposite side: it receives the fixed
// amount and pays the floating amount. Collateral under a bilateral agreement of the Book: independent amount 2%
// of the notional of the current period, variation margin with no threshold and a minimum transfer of 10,000.
//
// Schedule (effective Friday 4 September 2026, maturity Saturday 4 September 2027, USD payment calendar):
//   period 1  2026-09-04 to 2026-12-04  91 days, 90/360  factor 0.40  paid Friday 4 December
//   period 2  2026-12-04 to 2027-03-04  90 days, 90/360  factor 0.70  paid Thursday 4 March
//   period 3  2027-03-04 to 2027-06-04  92 days, 90/360  factor 1.00  paid Friday 4 June
//   period 4  2027-06-04 to 2027-09-04  92 days, 90/360  factor 1.00  paid Tuesday 7 September: the 4th is a Saturday, Monday the 6th Labor Day
// The independent amount follows the notional of the period: it is trued up when the payment ending a period is made.
const ACCR_NAME = 'USD accreting swap 3.50% v TSFR3M 4 Sep 2027';
const ACCR_SCHEDULE = [{ from: '2026-09-04', factor: 0.4 }, { from: '2026-12-04', factor: 0.7 }, { from: '2027-03-04', factor: 1 }, { from: '2027-06-04', factor: 1 }];
const accrDraft = (scheduleB, extra = {}) => ({
  productId: 'accreting_swap', name: ACCR_NAME, symbol: 'ACCR-TSFR-0927', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
  conventions: USD_CALENDARS,
  terms: {
    effective: '2026-09-04', maturity: '2027-09-04', counterparty: 'Dealer N',
    collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' },
    legs: [
      { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.035, months: 3, dayCount: '30/360', notionalSchedule: ACCR_SCHEDULE },
      { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0, months: 3, dayCount: 'ACT/360', notionalSchedule: scheduleB },
    ],
  },
  ...extra,
});
const accretingSwap = {
  productId: 'accreting_swap',
  title: 'USD 1-year accreting swap, receive 3.50% fixed and pay 3-month term SOFR (opposite side) on a notional rising from 40% to 100%, under a collateral agreement',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'each leg: Notional schedule (the first day of every period and its factor)'],
    automaticInputs: ['notional of each period from the schedule', 'payment schedule of each leg on the USD payment calendar', 'TSFR3M fixings (rate fixture standing in for Shaffer MarketData)', 'settlement date, T+2 on the USD calendar', 'commission from the Book fee schedule', 'independent amount on the notional of the current period, and variation margin, from the agreement'],
    manualInputs: ['collateral agreement (Treasury, Collateral)', 'notional schedule of each leg (contract form)', 'upfront amounts (stated fill prices)', 'mark of the contract, entered by hand', 'a fixing the data service has not supplied, entered by hand'],
    settlement: 'Upfront and termination amounts and commission settle T+2 on the USD calendar; leg payments are cash on their payment date',
    lifecycle: 'A schedule step that is not the first day of a period is refused at registration; fixed and floating amounts each quarter on that quarter\'s notional; increase inside a period (takes the whole period); partial termination; a final payment across Labor Day; a missing fixing holds the last payment and the maturity until entered by hand; nothing left afterwards',
    accounting: 'Opposite side carried at the mark less the upfront received; leg payments and the termination result are realized P&L; the upfront still carried is earned at maturity; commission expensed',
    collateral: 'Bilateral agreement: independent amount 2% of the current period\'s notional (posted at entry on 40%, trued up on the increase, at the payments that start the 70% and 100% periods, on the partial termination, returned at maturity); variation margin on the mark entered by hand, no threshold, minimum transfer 10,000: received (restricted), returned and replaced by a posting, returned when the contract ends',
  },
  start: at('2026-09-02'),
  settlementCheck: { lag: 2, holidays: [] }, // no Federal Reserve holiday in the settlement windows used (2 to 4 September, 15 to 19 October 2026, 15 to 19 April 2027)
  book: bookOf('Matrix accreting swap', 'Lending desk', 'USD', 3_000_000, 1_500_000, { perUnit: 0.00001, minimum: 0, bps: 0 }), // 10.00 per million of notional
  instruments: {},
  tradedOn: 'The contract is registered by the step register-under-agreement (registry form), after the collateral agreement it names has been recorded: an agreement must exist before a contract can refer to it.',
  rates: { TSFR3M: { byDate: { '2026-09-04': 4.10 } } },
  expectAtStart: startOf('USD', 3_000_000, 1_500_000),
  steps: [
    {
      id: 'record-agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer N', counterparty: 'Dealer N', kind: 'bilateral', covers: ['account'], independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: true, threshold: 0, minimumTransfer: 10_000, baseCcy: 'USD', postingCcy: 'USD', haircut: 0, nettingScope: 'position' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer N with Dealer N (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    {
      // The floating leg's second step is put on 4 January 2027, which starts no period of a quarterly leg from 4 September: refused.
      id: 'schedule-step-off-period', covers: 'notional schedule', action: 'register_instrument',
      draft: accrDraft([{ from: '2026-09-04', factor: 0.4 }, { from: '2027-01-04', factor: 0.7 }, { from: '2027-03-04', factor: 1 }, { from: '2027-06-04', factor: 1 }], { name: 'USD accreting swap, step off the periods', symbol: 'ACCR-OFF' }),
      status: 'blocked', reason: 'A schedule step must be the first day of a period of its leg.',
      expect: { refused: 'Leg B: the notional schedule step from 2027-01-04 is not the start of a period of this leg (periods start on 2026-09-04, 2026-12-04, 2027-03-04, 2027-06-04).' },
    },
    { id: 'register-under-agreement', covers: 'registration', action: 'register_instrument', as: 'main', draft: accrDraft(ACCR_SCHEDULE), expect: {} },
    {
      // Opposite side, 25,000,000 base notional at 0.03 per 100: 25,000,000 x 0.03 / 100 = 7,500 received; commission 250; settles Friday 4 September.
      // Independent amount: 2% of the first period's notional, 0.40 x 25,000,000 = 10,000,000: 200,000.
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'sell', qty: 25_000_000, as: 'accr', order: { statedPrice: 0.03 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 25_000_000, estimate: 0.03, model: 'stated-price', settleDate: '2026-09-04', calendar: 'USD', cash: 7_500, fees: 250 }],
          cash: { USD: { proceeds: 7_500, fees: 250, margin: 200_000, available: 1_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 25_000_000, avgPrice: 0.03, fills: [{ qty: 25_000_000, price: 0.03, model: 'stated-price', settleDate: '2026-09-04' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered on the opposite side: 25,000,000 notional of ACCR-TSFR-0927 at 0.03 per 100 notional', owner: 'account', date: '2026-09-02' },
          { type: 'swap.collateral', summary: `Collateral posted on ${ACCR_NAME} under "CSA Dealer N" (Dealer N): 200,000.00 USD (independent amount, 2.00% of 10,000,000.00 USD notional)`, cash: { USD: -200_000 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 1_300_000, unsettled: 7_250, margin: 200_000, restricted: 0, availableToTrade: 1_307_250, availableToWithdraw: 1_300_000 } } },
        positions: [{ instrument: 'main', lot: 'accr', owner: 'account', direction: 'opposite side', qty: -25_000_000, avgCost: 0.03, cost: -7_500, price: null, value: null, unrealized: null, provisional: true, notional: 25_000_000, margin: 200_000 }],
        holdings: { main: { long: 0, short: 25_000_000, net: -25_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-09-04', amount: 7_250, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-04', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-04', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-07', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'accr', owner: 'account', qty: -25_000_000, basis: 'agreement', agreement: 'CSA Dealer N', mark: null, iaRequired: 200_000, iaPosted: 200_000, vmPosted: 0, vmHeld: 0, vmStatus: 'not_valued_yet' }],
        pnl: { account: { realized: 0, commissions: -250, unrealized: 0, total: -250 } },
        nav: { account: 1_499_750, book: 2_999_750 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_300_000, margin: 200_000, receivable: 7_250, positions: -7_500, assets: 1_499_750, liabilities: 0, netAssets: 1_499_750 } },
      },
    },
    {
      // Two end-of-day passes without a mark (2 and 3 September): nothing can be called, and it is said.
      id: 'settle-upfront', covers: 'settlement', action: 'clock', to: at('2026-09-04'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 7,250.00 USD into settled cash', cash: { USD: 7_250 }, date: '2026-09-04' }],
        cash: { account: { USD: { settled: 1_307_250, unsettled: 0, availableToTrade: 1_307_250, availableToWithdraw: 1_307_250 } } },
        pending: [],
        otc: [{ instrument: 'main', vmStatus: 'cannot_value', vmReason: /ACCR-TSFR-0927 has no mark/ }], alerts: ['collateral.unvalued'],
        balance: { account: { cash: 1_307_250, receivable: null } },
      },
    },
    {
      // The mark is of the contract as written. On the opposite side: -25,000,000 x -0.08 / 100 = +20,000; 27,500 above the -7,500 carried.
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.08, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'accr', price: -0.08, value: 20_000, unrealized: 27_500, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: -0.08, markValue: 20_000 }],
        pnl: { account: { unrealized: 27_500, total: 27_250 } },
        nav: { account: 1_527_250, book: 3_027_250 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 20_000, assets: 1_527_250, netAssets: 1_527_250 } },
      },
    },
    {
      // +20,000 above a zero threshold: the counterparty posts 20,000 (more than the 10,000 minimum). Restricted cash and a liability.
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-09-04'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer N" (Dealer N): 20,000.00 USD received. Netting set of 1 position marked at 20,000.00 USD; threshold 0.00 USD.', owner: 'account', date: '2026-09-04' }],
        cash: { account: { USD: { settled: 1_307_250, restricted: 20_000, margin: 200_000, availableToTrade: 1_307_250, availableToWithdraw: 1_307_250 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 20_000, vmExposure: 20_000, vmStatus: 'ok' }],
        alerts: [],
        balance: { account: { restricted: 20_000, collateralReceived: 20_000, assets: 1_547_250, liabilities: 20_000, netAssets: 1_527_250 } },
      },
    },
    { id: 'mid-october', action: 'clock', to: at('2026-10-15'), expect: {} },
    {
      // 25,000,000 to 30,000,000 on the opposite side at the mark, -0.08 per 100: 5,000,000 x 0.08 / 100 = 4,000 paid; commission 50; settles Monday 19 October.
      // Cost -7,500 + 4,000 = -3,500 (average 3,500 / 300,000 = 0.0116667 per 100). Value -30,000,000 x -0.08 / 100 = 24,000; unrealized still 27,500.
      // Independent amount 2% x 0.40 x 30,000,000 = 240,000: 40,000 more. The added notional takes the whole first period.
      id: 'increase', covers: ['increase', 'collateral'], action: 'resize', lot: 'accr', factor: 1.2, order: { statedPrice: -0.08 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 5_000_000, estimate: -0.08, model: 'stated-price', settleDate: '2026-10-19', cash: -4_000, fees: 50 }], cash: { USD: { fees: 50, margin: 40_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 5_000_000, avgPrice: -0.08 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Increased on the opposite side: 5,000,000 notional of ACCR-TSFR-0927 at -0.08 per 100 notional' },
          { type: 'swap.collateral', summary: `Collateral posted on ${ACCR_NAME} under "CSA Dealer N" (Dealer N): 40,000.00 USD (independent amount, 2.00% of 12,000,000.00 USD notional)`, cash: { USD: -40_000 } },
        ],
        cash: { account: { USD: { settled: 1_267_250, unsettled: -4_050, margin: 240_000, restricted: 20_000, availableToTrade: 1_263_200, availableToWithdraw: 1_263_200 } } },
        positions: [{ instrument: 'main', lot: 'accr', qty: -30_000_000, cost: -3_500, avgCost: 0.0116667, price: -0.08, value: 24_000, unrealized: 27_500, notional: 30_000_000, margin: 240_000 }],
        holdings: { main: { long: 0, short: 30_000_000, net: -30_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-10-19', amount: -4_050, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -30_000_000, markValue: 24_000, iaRequired: 240_000, iaPosted: 240_000 }],
        pnl: { account: { commissions: -300, unrealized: 27_500, total: 27_200 } },
        nav: { account: 1_527_200, book: 3_027_200 },
        balance: { account: { cash: 1_267_250, margin: 240_000, payable: 4_050, positions: 24_000, assets: 1_551_250, liabilities: 24_050, netAssets: 1_527_200 } },
      },
    },
    {
      // 24,000 marked, 20,000 held: 4,000 more would be due, below the 10,000 minimum transfer, at each end of day until then.
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-10-19'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 4,050.00 USD from settled cash', cash: { USD: -4_050 } }],
        cash: { account: { USD: { settled: 1_263_200, unsettled: 0, availableToTrade: 1_263_200, availableToWithdraw: 1_263_200 } } },
        pending: [],
        otc: [{ instrument: 'main', vmHeld: 20_000, vmExposure: 24_000 }],
        balance: { account: { cash: 1_263_200, payable: null, assets: 1_547_200, liabilities: 20_000 } },
      },
    },
    {
      // First quarter, factor 0.40 of 30,000,000: 12,000,000 (the increase took the whole period).
      //   fixed, received: 12,000,000 x 3.50% x 90/360 = 105,000.00
      //   float, paid:     12,000,000 x 4.10% x 91/360 = 124,366.67
      // The next period's notional is 0.70 x 30,000,000 = 21,000,000: independent amount 420,000, 180,000 more, posted when the first payment is made.
      id: 'first-quarter', covers: ['fixed payment', 'floating payment', 'notional schedule', 'collateral'], action: 'clock', to: at('2026-12-04'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${ACCR_NAME}, leg A (fixed), period 2026-09-04 to 2026-12-04: 105,000.00 USD`, cash: { USD: 105_000 }, owner: 'account', date: '2026-12-04' },
          { type: 'swap.collateral', summary: `Collateral posted on ${ACCR_NAME} under "CSA Dealer N" (Dealer N): 180,000.00 USD (independent amount, 2.00% of 21,000,000.00 USD notional)`, cash: { USD: -180_000 } },
          { type: 'swap.payment', summary: `Swap payment on ${ACCR_NAME}, leg B (float), period 2026-09-04 to 2026-12-04: 124,366.67 USD`, cash: { USD: -124_366.67 }, owner: 'account', date: '2026-12-04' },
        ],
        cash: { account: { USD: { settled: 1_063_833.33, margin: 420_000, availableToTrade: 1_063_833.33, availableToWithdraw: 1_063_833.33 } } },
        positions: [{ instrument: 'main', lot: 'accr', margin: 420_000 }],
        otc: [{ instrument: 'main', iaRequired: 420_000, iaPosted: 420_000 }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-04', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-04', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-07', status: 'pending' },
        ],
        pnl: { account: { realized: -19_366.67, total: 7_833.33 } }, // 105,000 - 124,366.67; then - 300 + 27,500
        nav: { account: 1_507_833.33, book: 3_007_833.33 },
        balance: { account: { cash: 1_063_833.33, margin: 420_000, assets: 1_527_833.33, netAssets: 1_507_833.33 } },
      },
    },
    { id: 'december-fixing', action: 'rate', code: 'TSFR3M', value: 3.90, date: '2026-12-04', expect: {} },
    {
      // -30,000,000 x 0.02 / 100 = -6,000; 2,500 below the -3,500 carried.
      id: 'mark-turns', action: 'manual_price', instrument: 'main', value: 0.02, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'accr', price: 0.02, value: -6_000, unrealized: -2_500 }],
        otc: [{ instrument: 'main', mark: 0.02, markValue: -6_000 }],
        pnl: { account: { unrealized: -2_500, total: -22_166.67 } },
        nav: { account: 1_477_833.33, book: 2_977_833.33 },
        balance: { account: { positions: -6_000, assets: 1_497_833.33, netAssets: 1_477_833.33 } },
      },
    },
    {
      // -6,000 with no threshold: the 20,000 held goes back and 6,000 is posted (26,000 in all, above the minimum transfer).
      id: 'variation-margin-turns', covers: 'variation margin', action: 'clock', to: eod('2026-12-04'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer N" (Dealer N): 20,000.00 USD returned to the counterparty and 6,000.00 USD posted. Netting set of 1 position marked at -6,000.00 USD; threshold 0.00 USD.', owner: 'account' }],
        cash: { account: { USD: { settled: 1_057_833.33, restricted: 0, margin: 426_000, availableToTrade: 1_057_833.33, availableToWithdraw: 1_057_833.33 } } },
        otc: [{ instrument: 'main', vmPosted: 6_000, vmHeld: 0, vmExposure: -6_000 }],
        balance: { account: { cash: 1_057_833.33, margin: 426_000, restricted: null, collateralReceived: null, assets: 1_477_833.33, liabilities: 0 } },
      },
    },
    {
      // Second quarter, factor 0.70: 21,000,000.
      //   fixed, received: 21,000,000 x 3.50% x 90/360 = 183,750.00
      //   float, paid:     21,000,000 x 3.90% x 90/360 = 204,750.00
      // Next period factor 1.00: 30,000,000, independent amount 600,000, 180,000 more.
      id: 'second-quarter', covers: ['fixed payment', 'floating payment', 'notional schedule', 'collateral'], action: 'clock', to: at('2027-03-04'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${ACCR_NAME}, leg A (fixed), period 2026-12-04 to 2027-03-04: 183,750.00 USD`, cash: { USD: 183_750 }, date: '2027-03-04' },
          { type: 'swap.collateral', summary: `Collateral posted on ${ACCR_NAME} under "CSA Dealer N" (Dealer N): 180,000.00 USD (independent amount, 2.00% of 30,000,000.00 USD notional)`, cash: { USD: -180_000 } },
          { type: 'swap.payment', summary: `Swap payment on ${ACCR_NAME}, leg B (float), period 2026-12-04 to 2027-03-04: 204,750.00 USD`, cash: { USD: -204_750 }, date: '2027-03-04' },
        ],
        cash: { account: { USD: { settled: 856_833.33, margin: 606_000, availableToTrade: 856_833.33, availableToWithdraw: 856_833.33 } } },
        positions: [{ instrument: 'main', lot: 'accr', margin: 600_000 }],
        otc: [{ instrument: 'main', iaRequired: 600_000, iaPosted: 600_000 }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-06-04', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-06-04', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-07', status: 'pending' },
        ],
        pnl: { account: { realized: -40_366.67, total: -43_166.67 } }, // -19,366.67 - 21,000; then - 300 - 2,500
        nav: { account: 1_456_833.33, book: 2_956_833.33 },
        balance: { account: { cash: 856_833.33, margin: 606_000, assets: 1_456_833.33, netAssets: 1_456_833.33 } },
      },
    },
    { id: 'march-fixing', action: 'rate', code: 'TSFR3M', value: 3.70, date: '2027-03-04', expect: {} },
    { id: 'mid-april', action: 'clock', to: at('2027-04-15'), expect: {} },
    {
      // Half (15,000,000) terminated at -0.04 per 100 as written: closing the opposite side at -0.04 receives 15,000,000 x 0.04 / 100 = 6,000; commission 150.
      // Upfront carried on that half: 3,500 / 2 = 1,750 received. Realized 1,750 + 6,000 = 7,750. Settles Monday 19 April.
      // Independent amount 2% x 15,000,000 = 300,000: 300,000 back. Left: -15,000,000 carrying -1,750, marked 0.02: -3,000, 1,250 down.
      // Variation margin: -3,000 marked, 6,000 posted: 3,000 would come back, below the minimum transfer.
      id: 'partial-termination', covers: ['reduce', 'partial termination', 'collateral'], action: 'close', lot: 'accr', scope: 'strategy', percent: 50, order: { statedPrice: -0.04 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 15_000_000, estimate: -0.04, model: 'stated-price', settleDate: '2027-04-19', cash: 6_000, fees: 150 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 15_000_000, avgPrice: -0.04 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated in part: 15,000,000 of 30,000,000 notional of ACCR-TSFR-0927 at -0.04 per 100 notional (realized 7,750.00 USD)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${ACCR_NAME} under "CSA Dealer N" (Dealer N): 300,000.00 USD (independent amount, 2.00% of 15,000,000.00 USD notional)`, cash: { USD: 300_000 } },
        ],
        cash: { account: { USD: { settled: 1_156_833.33, unsettled: 5_850, margin: 306_000, availableToTrade: 1_162_683.33, availableToWithdraw: 1_156_833.33 } } },
        positions: [{ instrument: 'main', lot: 'accr', qty: -15_000_000, cost: -1_750, avgCost: 0.0116667, price: 0.02, value: -3_000, unrealized: -1_250, notional: 15_000_000, margin: 300_000 }],
        holdings: { main: { long: 0, short: 15_000_000, net: -15_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-04-19', amount: 5_850, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -15_000_000, markValue: -3_000, iaRequired: 300_000, iaPosted: 300_000 }],
        pnl: { account: { realized: -32_616.67, commissions: -450, unrealized: -1_250, total: -34_316.67 } },
        nav: { account: 1_465_683.33, book: 2_965_683.33 },
        balance: { account: { cash: 1_156_833.33, margin: 306_000, receivable: 5_850, positions: -3_000, assets: 1_465_683.33, liabilities: 0, netAssets: 1_465_683.33 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2027-04-19'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 5,850.00 USD into settled cash', cash: { USD: 5_850 } }],
        cash: { account: { USD: { settled: 1_162_683.33, unsettled: 0, availableToTrade: 1_162_683.33, availableToWithdraw: 1_162_683.33 } } },
        pending: [],
        otc: [{ instrument: 'main', vmPosted: 6_000, vmExposure: -3_000 }],
        balance: { account: { cash: 1_162_683.33, receivable: null } },
      },
    },
    {
      // Third quarter, factor 1.00 of the 15,000,000 left.
      //   fixed, received: 15,000,000 x 3.50% x 90/360 = 131,250.00
      //   float, paid:     15,000,000 x 3.70% x 92/360 = 141,833.33
      // The last period's factor is also 1.00: the independent amount does not move.
      id: 'third-quarter', covers: ['fixed payment', 'floating payment', 'notional schedule'], action: 'clock', to: at('2027-06-04'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${ACCR_NAME}, leg A (fixed), period 2027-03-04 to 2027-06-04: 131,250.00 USD`, cash: { USD: 131_250 }, date: '2027-06-04' },
          { type: 'swap.payment', summary: `Swap payment on ${ACCR_NAME}, leg B (float), period 2027-03-04 to 2027-06-04: 141,833.33 USD`, cash: { USD: -141_833.33 }, date: '2027-06-04' },
        ],
        cash: { account: { USD: { settled: 1_152_100, availableToTrade: 1_152_100, availableToWithdraw: 1_152_100 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-07', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-07', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-07', status: 'pending' },
        ],
        pnl: { account: { realized: -43_200, total: -44_900 } }, // -32,616.67 - 10,583.33; then - 450 - 1,250
        nav: { account: 1_455_100, book: 2_955_100 },
        balance: { account: { cash: 1_152_100, assets: 1_455_100, netAssets: 1_455_100 } },
      },
    },
    {
      // Labor Day: the payment calendar is closed. Nothing is paid, though the period has ended (Saturday the 4th).
      id: 'labor-day', covers: 'payment across a holiday', action: 'clock', to: at('2027-09-06'),
      expect: { events: [], cash: { account: { USD: { settled: 1_152_100 } } } },
    },
    {
      // Tuesday 7 September. Fixed, received: 15,000,000 x 3.50% x 90/360 = 131,250.00.
      // The floating amount needs the fixing of 4 June, never supplied: it waits, and so does the maturity.
      id: 'last-fixed-floating-missing', covers: ['fixed payment', 'payment across a holiday', 'missing fixing'], action: 'clock', to: at('2027-09-07'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${ACCR_NAME}, leg A (fixed), period 2027-06-04 to 2027-09-04: 131,250.00 USD`, cash: { USD: 131_250 }, date: '2027-09-07' }],
        cash: { account: { USD: { settled: 1_283_350, availableToTrade: 1_283_350, availableToWithdraw: 1_283_350 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-09-07', status: 'blocked', reason: /Waiting for the final leg payments/ },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-09-07', status: 'blocked', reason: /Awaiting the TSFR3M fixing for 2027-06-04/ },
        ],
        pnl: { account: { realized: 88_050, total: 86_350 } }, // -43,200 + 131,250; then - 450 - 1,250
        nav: { account: 1_586_350, book: 3_086_350 },
        balance: { account: { cash: 1_283_350, assets: 1_586_350, netAssets: 1_586_350 } },
      },
    },
    {
      // 3.55% for 4 June, by hand. Float, paid: 15,000,000 x 3.55% x 92/360 = 136,083.33. The swap then matures: the -1,750 still carried is earned
      // (+1,750), the 300,000 independent amount and the 6,000 of variation margin come back.
      // 1,500,000 + 7,500 - 4,000 + 6,000 - 450 - 19,366.67 - 21,000 - 10,583.33 + 131,250 - 136,083.33 = 1,453,266.67.
      id: 'fixing-by-hand-and-maturity', covers: ['missing fixing', 'floating payment', 'maturity', 'close', 'collateral'], action: 'manual_rate', code: 'TSFR3M', value: 3.55, date: '2027-06-04', note: 'Published fixing, entered by hand',
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${ACCR_NAME}, leg B (float), period 2027-06-04 to 2027-09-04: 136,083.33 USD`, cash: { USD: -136_083.33 }, date: '2027-09-07' },
          { type: 'swap.matured', summary: `Swap matured: ${ACCR_NAME} (notional 15,000,000)`, owner: 'account' },
          { type: 'swap.collateral', summary: `Collateral returned on ${ACCR_NAME} under "CSA Dealer N" (Dealer N): 300,000.00 USD (independent amount, the position ended)`, cash: { USD: 300_000 } },
          { type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer N" (Dealer N): 6,000.00 USD returned to us. The last position of the netting set ended.', cash: { USD: 6_000 } },
        ],
        cash: { account: { USD: { settled: 1_453_266.67, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 1_453_266.67, availableToWithdraw: 1_453_266.67 } }, treasury: { USD: { settled: 1_500_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        pnl: { account: { realized: -46_283.33, commissions: -450, unrealized: 0, total: -46_733.33 } }, // 88,050 - 136,083.33 + 1,750
        nav: { account: 1_453_266.67, treasury: 1_500_000, book: 2_953_266.67 },
        balance: { account: { cash: 1_453_266.67, margin: null, positions: null, assets: 1_453_266.67, liabilities: 0, netAssets: 1_453_266.67 } },
      },
    },
    {
      id: 'nothing-left', action: 'clock', to: at('2027-09-08'),
      expect: { events: [], lifecycle: [], positions: [], pending: [], otc: [], alerts: [], cash: { account: { USD: { settled: 1_453_266.67, margin: 0, restricted: 0 } } } },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// equity_swap
// ---------------------------------------------------------------------------------------------
// A six-month single-stock equity swap: receive the price return of Halvorsen Robotics (HLVR, NASDAQ), pay
// 3-month term SOFR + 0.50% ACT/360 on the same notional, quarterly. Price return only: a dividend on HLVR is
// not passed through. The notional resets at each period: after each payment it is multiplied by end / start
// price, and the financing of the next period is on the reset notional. Position-level collateral terms: an
// independent amount of 10% of the (reset) notional, no variation margin.
//
// Payment calendar US+USD (a day both NASDAQ and the Federal Reserve are open): the reset dates are exchange days. Both legs
// are paid 2 business days after the period end (the closing price of the reset date is known only after the close).
//   period 1  2026-04-01 to 2026-07-01  91 days  HLVR 80.00 to 86.00   TSFR3M 4.30% for 1 April
//             paid Monday 6 July: Thursday 2 July is the first business day, Friday 3 July NASDAQ is closed (Independence Day observed)
//   period 2  2026-07-01 to 2026-10-01  92 days  would be paid Monday 5 October (terminated before: in part on 13 August, in full on 10 September)
const HLVR = { productId: 'common_stock', name: 'Halvorsen Robotics Inc.', symbol: 'HLVR', marketView: 'US_CASH', venue: 'NASDAQ', venueType: 'exchange', venueCountry: 'US', issuer: 'Halvorsen Robotics Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} };
const EQS_NAME = 'Equity swap HLVR price return v TSFR3M + 0.50% 1 Oct 2026';
const equitySwap = {
  productId: 'equity_swap',
  title: 'Six-month single-stock equity swap on HLVR: receive the price return, pay term SOFR + 0.50% on a notional that resets quarterly',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'return leg: Leg type "Return on a reference asset", Reference asset (the stock), Reset and payment, Options "Notional resets" (and not "Total return")', 'financing leg: Index, Spread, Day count', 'both legs: Payment lag (business days) 2'],
    automaticInputs: ['reset and payment schedule on the US+USD calendar', 'HLVR closes for each reset date (close fixture standing in for Shaffer MarketData)', 'TSFR3M fixings (rate fixture)', 'notional reset after each payment, and the financing on it', 'settlement date, T+2', 'commission from the Book fee schedule', 'independent amount on the reset notional'],
    manualInputs: ['the reference stock, registered as a common stock', 'upfront and termination amounts (stated fill prices)', 'mark of the contract, entered by hand', 'the dividend on the reference, recorded by hand (not passed through: price return)'],
    settlement: 'Upfront and termination amounts and commission settle T+2 on the US+USD calendar; leg payments are cash on their payment date',
    lifecycle: 'Return and financing amounts each quarter, paid 2 business days after the reset date (across Independence Day observed); the notional resets after each payment and the next financing is on it; a dividend on the reference is not passed through on a price-return leg; partial termination and full termination at stated amounts; nothing paid or scheduled afterwards',
    accounting: 'Carried at the mark; return and financing payments and termination results are realized P&L; commission expensed',
    collateral: 'Position-level terms: independent amount 10% of the notional (trued up when the notional resets and on the partial termination, returned on the full termination); no variation margin',
  },
  start: at('2026-03-30'),
  settlementCheck: { lag: 2, holidays: [] }, // no NASDAQ or Federal Reserve holiday in the windows used (30 March to 1 April, 13 to 17 August, 10 to 14 September 2026)
  book: bookOf('Matrix equity swap', 'Equity derivatives', 'USD', 3_000_000, 1_500_000, { perUnit: 0.0001, minimum: 0, bps: 0 }, { equity: NO_FEE }), // 100.00 per million of notional; the stock is never traded
  instruments: {
    hlvr: HLVR,
    main: {
      productId: 'equity_swap', name: EQS_NAME, symbol: 'EQS-HLVR-1026', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'US', settlementCalendar: 'US+USD', paymentCalendar: 'US+USD' },
      terms: {
        effective: '2026-04-01', maturity: '2026-10-01', counterparty: 'Prime broker P',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.10 }, variationMargin: false },
        legs: [
          { side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: '$inst:hlvr', passDividends: false, resetNotional: true, paymentLag: 2 },
          { side: 'pay', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0.005, months: 3, dayCount: 'ACT/360', paymentLag: 2 },
        ],
      },
    },
  },
  rates: { TSFR3M: { byDate: { '2026-04-01': 4.30 } } },
  expectAtStart: startOf('USD', 3_000_000, 1_500_000),
  steps: [
    {
      // 5,000,000 as written, no upfront. Commission 5,000,000 x 0.0001 = 500, settling Wednesday 1 April. Independent amount 10% x 5,000,000 = 500,000.
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 5_000_000, as: 'eqs', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-04-01', cash: 0, fees: 500 }],
          cash: { USD: { purchases: 0, fees: 500, margin: 500_000, required: 500_500, available: 1_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5_000_000, avgPrice: 0, fills: [{ qty: 5_000_000, price: 0, model: 'stated-price', settleDate: '2026-04-01' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered as written: 5,000,000 notional of EQS-HLVR-1026 at 0.00 per 100 notional', owner: 'account', date: '2026-03-30' },
          { type: 'swap.collateral', summary: `Collateral posted on ${EQS_NAME} under its position-level terms: 500,000.00 USD (independent amount, 10.00% of 5,000,000.00 USD notional)`, cash: { USD: -500_000 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -500, margin: 500_000, restricted: 0, availableToTrade: 999_500, availableToWithdraw: 999_500 } } },
        positions: [{ instrument: 'main', lot: 'eqs', owner: 'account', direction: 'as written', qty: 5_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 5_000_000, margin: 500_000 }],
        holdings: { main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-01', amount: -500, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-06', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-06', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-10-05', status: 'pending' }, // the last payment date
        ],
        otc: [{ instrument: 'main', lot: 'eqs', owner: 'account', qty: 5_000_000, basis: 'position', mark: null, iaRequired: 500_000, iaPosted: 500_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -500, unrealized: 0, total: -500 } },
        nav: { account: 1_499_500, book: 2_999_500 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_000_000, margin: 500_000, payable: 500, positions: null, assets: 1_500_000, liabilities: 500, netAssets: 1_499_500 } },
      },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-04-01'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 500.00 USD from settled cash', cash: { USD: -500 }, date: '2026-04-01' }],
        cash: { account: { USD: { settled: 999_500, unsettled: 0, availableToTrade: 999_500, availableToWithdraw: 999_500 } } },
        pending: [],
        balance: { account: { cash: 999_500, payable: null, assets: 1_499_500, liabilities: 0 } },
      },
    },
    // HLVR closes at 80.00 on the effective date: the start of the first period.
    { id: 'start-price', covers: 'reset fixing', action: 'close_price', instrument: 'hlvr', date: '2026-04-01', value: 80, expect: {} },
    {
      // 5,000,000 x 1.20 / 100 = 60,000.
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 1.20, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'eqs', price: 1.2, value: 60_000, unrealized: 60_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: 1.2, markValue: 60_000 }],
        pnl: { account: { unrealized: 60_000, total: 59_500 } },
        nav: { account: 1_559_500, book: 3_059_500 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 60_000, assets: 1_559_500, netAssets: 1_559_500 } },
      },
    },
    { id: 'dividend-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'hlvr', type: 'cash_dividend', exDate: '2026-05-14', amount: 0.50, expect: {} },
    {
      // HLVR goes ex 0.50. The return leg is price return only: nothing is passed through, nothing is paid or received.
      id: 'dividend-not-passed-through', covers: 'dividend', action: 'clock', to: at('2026-05-14'),
      expect: { events: [], cash: { account: { USD: { settled: 999_500 } } } },
    },
    // HLVR closes at 86.00 on 1 July: the end of the first period.
    { id: 'reset-price', covers: 'reset fixing', action: 'close_price', instrument: 'hlvr', date: '2026-07-01', value: 86, expect: {} },
    {
      // Friday 3 July: NASDAQ is closed for Independence Day (observed), so the joint calendar is closed. Nothing is paid yet.
      id: 'independence-day', covers: 'payment across a holiday', action: 'clock', to: at('2026-07-03'),
      expect: { events: [], cash: { account: { USD: { settled: 999_500 } } } },
    },
    {
      // First period, notional 5,000,000:
      //   return, received:    5,000,000 x (86 / 80 - 1) = 5,000,000 x 7.5% = 375,000.00
      //   financing, paid:     5,000,000 x (4.30% + 0.50%) x 91/360 = 60,666.67 (on the notional of the period, before the reset)
      // The notional resets to 5,000,000 x 86 / 80 = 5,375,000: independent amount 537,500, 37,500 more.
      id: 'first-reset', covers: ['return payment', 'financing payment', 'notional reset', 'collateral', 'payment across a holiday'], action: 'clock', to: at('2026-07-06'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${EQS_NAME}, leg A (return), period 2026-04-01 to 2026-07-01: 375,000.00 USD`, cash: { USD: 375_000 }, owner: 'account', date: '2026-07-06' },
          { type: 'swap.collateral', summary: `Collateral posted on ${EQS_NAME} under its position-level terms: 37,500.00 USD (independent amount, 10.00% of 5,375,000.00 USD notional)`, cash: { USD: -37_500 } },
          { type: 'swap.payment', summary: `Swap payment on ${EQS_NAME}, leg B (float), period 2026-04-01 to 2026-07-01: 60,666.67 USD`, cash: { USD: -60_666.67 }, owner: 'account', date: '2026-07-06' },
        ],
        cash: { account: { USD: { settled: 1_276_333.33, margin: 537_500, availableToTrade: 1_276_333.33, availableToWithdraw: 1_276_333.33 } } },
        positions: [{ instrument: 'main', lot: 'eqs', notional: 5_375_000, margin: 537_500 }],
        otc: [{ instrument: 'main', iaRequired: 537_500, iaPosted: 537_500 }],
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-10-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-05', status: 'pending' },
        ],
        pnl: { account: { realized: 314_333.33, total: 373_833.33 } }, // 375,000 - 60,666.67; then - 500 + 60,000
        nav: { account: 1_873_833.33, book: 3_373_833.33 },
        balance: { account: { cash: 1_276_333.33, margin: 537_500, assets: 1_873_833.33, netAssets: 1_873_833.33 } },
      },
    },
    { id: 'july-fixing', action: 'rate', code: 'TSFR3M', value: 4.10, date: '2026-07-01', expect: {} },
    {
      id: 'mark-after-reset', action: 'manual_price', instrument: 'main', value: 0.80, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'eqs', price: 0.8, value: 40_000, unrealized: 40_000 }],
        otc: [{ instrument: 'main', mark: 0.8, markValue: 40_000 }],
        pnl: { account: { unrealized: 40_000, total: 353_833.33 } },
        nav: { account: 1_853_833.33, book: 3_353_833.33 },
        balance: { account: { positions: 40_000, assets: 1_853_833.33, netAssets: 1_853_833.33 } },
      },
    },
    { id: 'mid-august', action: 'clock', to: at('2026-08-13'), expect: {} },
    {
      // 40% (2,000,000 of 5,000,000) terminated at 0.90 per 100: 18,000 received; commission 200; nothing carried, so realized 18,000. Settles Monday 17 August.
      // Left: 3,000,000 x the reset 86 / 80 = 3,225,000 of notional; independent amount 322,500, 215,000 back. Marked 0.80: 24,000.
      id: 'partial-termination', covers: ['reduce', 'partial termination', 'collateral'], action: 'close', lot: 'eqs', scope: 'strategy', percent: 40, order: { statedPrice: 0.90 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2_000_000, estimate: 0.9, model: 'stated-price', settleDate: '2026-08-17', cash: 18_000, fees: 200 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2_000_000, avgPrice: 0.9 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated in part: 2,000,000 of 5,000,000 notional of EQS-HLVR-1026 at 0.90 per 100 notional (realized 18,000.00 USD)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${EQS_NAME} under its position-level terms: 215,000.00 USD (independent amount, 10.00% of 3,225,000.00 USD notional)`, cash: { USD: 215_000 } },
        ],
        cash: { account: { USD: { settled: 1_491_333.33, unsettled: 17_800, margin: 322_500, availableToTrade: 1_509_133.33, availableToWithdraw: 1_491_333.33 } } },
        positions: [{ instrument: 'main', lot: 'eqs', qty: 3_000_000, cost: 0, avgCost: 0, price: 0.8, value: 24_000, unrealized: 24_000, notional: 3_225_000, margin: 322_500 }],
        holdings: { main: { long: 3_000_000, short: 0, net: 3_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-08-17', amount: 17_800, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 3_000_000, markValue: 24_000, iaRequired: 322_500, iaPosted: 322_500 }],
        pnl: { account: { realized: 332_333.33, commissions: -700, unrealized: 24_000, total: 355_633.33 } },
        nav: { account: 1_855_633.33, book: 3_355_633.33 },
        balance: { account: { cash: 1_491_333.33, margin: 322_500, receivable: 17_800, positions: 24_000, assets: 1_855_633.33, liabilities: 0, netAssets: 1_855_633.33 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2026-08-17'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 17,800.00 USD into settled cash', cash: { USD: 17_800 } }],
        cash: { account: { USD: { settled: 1_509_133.33, unsettled: 0, availableToTrade: 1_509_133.33, availableToWithdraw: 1_509_133.33 } } },
        pending: [],
        balance: { account: { cash: 1_509_133.33, receivable: null } },
      },
    },
    { id: 'mid-september', action: 'clock', to: at('2026-09-10'), expect: {} },
    {
      // The rest (3,000,000) terminated at 0.50 per 100: 15,000 received; commission 300; realized 15,000. Settles Monday 14 September.
      // The second period's return and financing are not paid: the termination amount is all-in. The 322,500 comes back.
      id: 'full-termination', covers: ['close', 'full termination', 'collateral'], action: 'close', lot: 'eqs', scope: 'position', percent: 100, order: { statedPrice: 0.50 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 3_000_000, estimate: 0.5, model: 'stated-price', settleDate: '2026-09-14', cash: 15_000, fees: 300 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 3_000_000, avgPrice: 0.5 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated: 3,000,000 notional of EQS-HLVR-1026 at 0.50 per 100 notional (realized 15,000.00 USD)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${EQS_NAME} under its position-level terms: 322,500.00 USD (independent amount, the position ended)`, cash: { USD: 322_500 } },
        ],
        cash: { account: { USD: { settled: 1_831_633.33, unsettled: 14_700, margin: 0, restricted: 0, availableToTrade: 1_846_333.33, availableToWithdraw: 1_831_633.33 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-09-14', amount: 14_700, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 347_333.33, commissions: -1_000, unrealized: 0, total: 346_333.33 } },
        nav: { account: 1_846_333.33, book: 3_346_333.33 },
        balance: { account: { cash: 1_831_633.33, margin: null, positions: null, receivable: 14_700, assets: 1_846_333.33, liabilities: 0, netAssets: 1_846_333.33 } },
      },
    },
    {
      id: 'settle-full-termination', covers: 'settlement', action: 'clock', to: at('2026-09-14'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 14,700.00 USD into settled cash', cash: { USD: 14_700 } }],
        cash: { account: { USD: { settled: 1_846_333.33, unsettled: 0, availableToTrade: 1_846_333.33, availableToWithdraw: 1_846_333.33 } } },
        pending: [],
        balance: { account: { cash: 1_846_333.33, receivable: null } },
      },
    },
    {
      // The contract's last payment date: nothing is paid, posted or scheduled. 1,500,000 - 500 + 375,000 - 60,666.67 + 18,000 - 200 + 15,000 - 300 = 1,846,333.33.
      id: 'nothing-left-at-maturity', covers: 'close', action: 'clock', to: at('2026-10-05'),
      expect: { events: [], lifecycle: [], positions: [], pending: [], otc: [], alerts: [], cash: { account: { USD: { settled: 1_846_333.33, margin: 0, restricted: 0 } }, treasury: { USD: { settled: 1_500_000 } } }, nav: { account: 1_846_333.33, treasury: 1_500_000, book: 3_346_333.33 } },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// equity_index_swap
// ---------------------------------------------------------------------------------------------
// A six-month equity-index swap owned by Treasury. The contract is written "receive the price return of the
// Meridian 500 index, pay 3-month term SOFR - 0.20% ACT/360", quarterly, on a fixed notional (no reset), both legs
// paid 2 business days after each reset date (US+USD calendar). Treasury enters the opposite side: it pays the
// index return (and so receives it when the index falls) and receives the financing. Collateral under a bilateral
// agreement covering Treasury: a fixed independent amount of 250,000 and variation margin with no threshold and a
// minimum transfer of 25,000.
//
// The catalog has no index product: the index level is carried by a reference instrument registered as an ETF
// (never traded), whose closes for the reset dates are the index fixings, as in the index option scenario.
//   period 1  2026-01-20 to 2026-04-20  90 days  index 5,000.00 to 4,800.00 (-4%)  TSFR3M 3.90% for 20 January   paid Wednesday 22 April
//   period 2  2026-04-20 to 2026-07-20  91 days  index 4,800.00 to 5,040.00 (+5%)  TSFR3M 3.80% for 20 April     paid Wednesday 22 July
const MER500 = { productId: 'etf', name: 'Meridian 500 Index (reference level)', symbol: 'MER500', marketView: 'US_CASH', venue: 'Meridian Indices', venueType: 'exchange', venueCountry: 'US', issuer: 'Meridian Indices LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} };
const EIS_NAME = 'Equity-index swap MER500 price return v TSFR3M - 0.20% 20 Jul 2026';
const EIS_DRAFT = {
  productId: 'equity_index_swap', name: EIS_NAME, symbol: 'EIS-MER500-0726', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
  conventions: { tradingCalendar: 'US', settlementCalendar: 'US+USD', paymentCalendar: 'US+USD' },
  terms: {
    effective: '2026-01-20', maturity: '2026-07-20', counterparty: 'Dealer Q',
    collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' },
    legs: [
      { side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: '$inst:index', passDividends: false, resetNotional: false, paymentLag: 2 },
      { side: 'pay', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: -0.002, months: 3, dayCount: 'ACT/360', paymentLag: 2 },
    ],
  },
};
const equityIndexSwap = {
  productId: 'equity_index_swap',
  title: 'Six-month equity-index swap owned by Treasury: pay the Meridian 500 price return, receive term SOFR - 0.20% (opposite side), under a collateral agreement',
  matrix: {
    ...OTC_TICKET,
    ticket: `${OTC_TICKET.ticket}. Owner chosen on the ticket: Treasury`,
    requiredFields: [...OTC_TICKET.requiredFields, 'return leg: Reference asset (the index level), Reset and payment, no "Notional resets", no "Total return"', 'financing leg: Index, Spread (negative), Day count', 'both legs: Payment lag (business days) 2'],
    automaticInputs: ['reset and payment schedule on the US+USD calendar, 2 business days after each reset date', 'index closes for each reset date (close fixture standing in for Shaffer MarketData)', 'TSFR3M fixings (rate fixture)', 'settlement date, T+2', 'commission from the Book fee schedule', 'independent amount and variation margin from the agreement, posted and received by Treasury'],
    manualInputs: ['collateral agreement (Treasury, Collateral)', 'the index level, registered as a reference instrument because the catalog has no index product', 'upfront amount of the increase (stated fill price)', 'mark of the contract, entered by hand'],
    settlement: 'Upfront amounts and commission settle T+2 on the US+USD calendar; leg payments are cash on their payment date',
    lifecycle: 'Return and financing each quarter on a fixed notional: the index return received when the index falls and paid when it rises (opposite side); increase inside the first period (takes the whole period); held to maturity; nothing left afterwards',
    accounting: 'Treasury\'s position: carried at the mark less the upfront paid; payments realized; the upfront still carried written off at maturity; commission expensed; the figures are Treasury\'s and the Book\'s, compared on Treasury\'s own screens',
    collateral: 'Bilateral agreement covering Treasury: fixed independent amount 250,000; variation margin on the mark entered by hand, no threshold, minimum transfer 25,000: posted, returned and replaced by collateral received, then posted again; everything returned at maturity',
  },
  start: at('2026-01-14'),
  settlementCheck: { lag: 2, holidays: [] }, // no NASDAQ or Federal Reserve holiday in the windows used (14 to 16 January, 18 to 20 February 2026; Martin Luther King Jr. Day is 19 January)
  book: bookOf('Matrix equity-index swap', 'Equity desk', 'USD', 20_000_000, 1_000_000, { perUnit: 0.00005, minimum: 0, bps: 0 }, { equity: NO_FEE }), // 50.00 per million of notional; the index stand-in is never traded
  instruments: { index: MER500 },
  tradedOn: 'The contract is registered by the step register-under-agreement (registry form), after the collateral agreement it names has been recorded.',
  rates: { TSFR3M: { byDate: { '2026-01-20': 3.90, '2026-04-20': 3.80 } } },
  expectAtStart: startOf('USD', 20_000_000, 1_000_000),
  steps: [
    {
      id: 'record-agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer Q', counterparty: 'Dealer Q', kind: 'bilateral', covers: ['treasury'], independentAmount: { type: 'fixed', amount: 250_000 }, variationMargin: true, threshold: 0, minimumTransfer: 25_000, baseCcy: 'USD', postingCcy: 'USD', haircut: 0, nettingScope: 'position' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer Q with Dealer Q (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    { id: 'register-under-agreement', covers: 'registration', action: 'register_instrument', as: 'main', draft: EIS_DRAFT, expect: {} },
    {
      // Treasury, opposite side, 10,000,000, no upfront. Commission 10,000,000 x 0.00005 = 500, settling Friday 16 January. Independent amount 250,000 from Treasury.
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', owner: 'treasury', instrument: 'main', side: 'sell', qty: 10_000_000, as: 'eis', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 10_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-01-16', cash: 0, fees: 500 }],
          cash: { USD: { fees: 500, margin: 250_000, available: 19_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000_000, avgPrice: 0, fills: [{ qty: 10_000_000, price: 0, model: 'stated-price', settleDate: '2026-01-16' }] }] },
        events: [
          { type: 'strategy.submitted', owner: 'treasury' },
          { type: 'trade.fill', summary: 'Entered on the opposite side: 10,000,000 notional of EIS-MER500-0726 at 0.00 per 100 notional', owner: 'treasury', date: '2026-01-14' },
          { type: 'swap.collateral', summary: `Collateral posted on ${EIS_NAME} under "CSA Dealer Q" (Dealer Q): 250,000.00 USD (independent amount, fixed amount for the position)`, cash: { USD: -250_000 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 18_750_000, unsettled: -500, margin: 250_000, restricted: 0, availableToTrade: 18_749_500, availableToWithdraw: 18_749_500 } } },
        positions: [{ instrument: 'main', lot: 'eis', owner: 'treasury', direction: 'opposite side', qty: -10_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 10_000_000, margin: 250_000 }],
        holdings: { main: { long: 0, short: 10_000_000, net: -10_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2026-01-16', amount: -500, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-04-22', status: 'pending', owner: 'treasury' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-04-22', status: 'pending', owner: 'treasury' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-07-22', status: 'pending', owner: 'treasury' },
        ],
        otc: [{ instrument: 'main', lot: 'eis', owner: 'treasury', qty: -10_000_000, basis: 'agreement', agreement: 'CSA Dealer Q', mark: null, iaRequired: 250_000, iaPosted: 250_000, vmPosted: 0, vmHeld: 0, vmStatus: 'not_valued_yet' }],
        pnl: { account: { total: 0 }, book: { realized: 0, commissions: -500, unrealized: 0, total: -500 } },
        nav: { account: 1_000_000, treasury: 18_999_500, book: 19_999_500 },
        provisional: { account: false, book: true },
        balance: { treasury: { cash: 18_750_000, margin: 250_000, payable: 500, positions: null, assets: 19_000_000, liabilities: 500, netAssets: 18_999_500 } },
      },
    },
    { id: 'treasury-screens-after-open', covers: 'open', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-01-16'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 500.00 USD from settled cash', cash: { USD: -500 }, owner: 'treasury', date: '2026-01-16' }],
        cash: { treasury: { USD: { settled: 18_749_500, unsettled: 0, availableToTrade: 18_749_500, availableToWithdraw: 18_749_500 } } },
        pending: [],
        otc: [{ instrument: 'main', vmStatus: 'cannot_value', vmReason: /EIS-MER500-0726 has no mark/ }], alerts: ['collateral.unvalued'],
        balance: { treasury: { cash: 18_749_500, payable: null, assets: 18_999_500, liabilities: 0 } },
      },
    },
    {
      // The mark is of the contract as written. On the opposite side: -10,000,000 x 0.40 / 100 = -40,000.
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.40, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'eis', price: 0.4, value: -40_000, unrealized: -40_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: 0.4, markValue: -40_000 }],
        pnl: { book: { unrealized: -40_000, total: -40_500 } },
        nav: { treasury: 18_959_500, book: 19_959_500 },
        provisional: { account: false, book: false },
        balance: { treasury: { positions: -40_000, assets: 18_959_500, netAssets: 18_959_500 } },
      },
    },
    {
      // -40,000 with no threshold: 40,000 posted by Treasury (above the 25,000 minimum transfer).
      id: 'variation-margin-posted', covers: 'variation margin', action: 'clock', to: eod('2026-01-16'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer Q" (Dealer Q): 40,000.00 USD posted. Netting set of 1 position marked at -40,000.00 USD; threshold 0.00 USD.', cash: { USD: -40_000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 18_709_500, margin: 290_000, availableToTrade: 18_709_500, availableToWithdraw: 18_709_500 } } },
        otc: [{ instrument: 'main', vmPosted: 40_000, vmHeld: 0, vmExposure: -40_000, vmStatus: 'ok' }],
        alerts: [],
        balance: { treasury: { cash: 18_709_500, margin: 290_000 } },
      },
    },
    // The index closes at 5,000.00 on the effective date.
    { id: 'start-level', covers: 'reset fixing', action: 'close_price', instrument: 'index', date: '2026-01-20', value: 5_000, expect: {} },
    { id: 'mid-february', action: 'clock', to: at('2026-02-18'), expect: {} },
    {
      // The index has fallen: the contract as written is marked -0.20 per 100. Opposite side: -10,000,000 x -0.20 / 100 = +20,000.
      id: 'mark-falls', action: 'manual_price', instrument: 'main', value: -0.20, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'eis', price: -0.2, value: 20_000, unrealized: 20_000 }],
        otc: [{ instrument: 'main', mark: -0.2, markValue: 20_000 }],
        pnl: { book: { unrealized: 20_000, total: 19_500 } },
        nav: { treasury: 19_019_500, book: 20_019_500 },
        balance: { treasury: { positions: 20_000, assets: 19_019_500, netAssets: 19_019_500 } },
      },
    },
    {
      // 5,000,000 more on the opposite side at -0.20 per 100: 5,000,000 x 0.20 / 100 = 10,000 paid; commission 250; settles Friday 20 February.
      // Cost +10,000. Value -15,000,000 x -0.20 / 100 = 30,000; unrealized 20,000. The added notional takes the whole first period. The fixed independent amount does not change.
      id: 'increase', covers: ['increase'], action: 'resize', owner: 'treasury', lot: 'eis', factor: 1.5, order: { statedPrice: -0.20 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 5_000_000, estimate: -0.2, model: 'stated-price', settleDate: '2026-02-20', cash: -10_000, fees: 250 }], cash: { USD: { fees: 250, margin: 0, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 5_000_000, avgPrice: -0.2 }] },
        events: [{ type: 'strategy.legs_added', owner: 'treasury' }, { type: 'trade.fill', summary: 'Increased on the opposite side: 5,000,000 notional of EIS-MER500-0726 at -0.20 per 100 notional', owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 18_709_500, unsettled: -10_250, availableToTrade: 18_699_250, availableToWithdraw: 18_699_250 } } },
        positions: [{ instrument: 'main', lot: 'eis', qty: -15_000_000, cost: 10_000, avgCost: -0.0666667, price: -0.2, value: 30_000, unrealized: 20_000, notional: 15_000_000, margin: 250_000 }], // 10,000 / (-15,000,000 / 100)
        holdings: { main: { long: 0, short: 15_000_000, net: -15_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2026-02-20', amount: -10_250, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -15_000_000, markValue: 30_000, iaRequired: 250_000, iaPosted: 250_000 }],
        pnl: { book: { commissions: -750, unrealized: 20_000, total: 19_250 } },
        nav: { treasury: 19_019_250, book: 20_019_250 },
        balance: { treasury: { cash: 18_709_500, payable: 10_250, positions: 30_000, assets: 19_029_500, liabilities: 10_250, netAssets: 19_019_250 } },
      },
    },
    {
      // +30,000 with no threshold: the 40,000 posted comes back and the counterparty posts 30,000 (restricted, a liability).
      id: 'variation-margin-turns', covers: 'variation margin', action: 'clock', to: eod('2026-02-18'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer Q" (Dealer Q): 40,000.00 USD returned to us and 30,000.00 USD received. Netting set of 1 position marked at 30,000.00 USD; threshold 0.00 USD.', owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 18_749_500, restricted: 30_000, margin: 250_000, availableToTrade: 18_739_250, availableToWithdraw: 18_739_250 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 30_000, vmExposure: 30_000 }],
        balance: { treasury: { cash: 18_749_500, restricted: 30_000, margin: 250_000, collateralReceived: 30_000, assets: 19_059_500, liabilities: 40_250, netAssets: 19_019_250 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-02-20'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 10,250.00 USD from settled cash', cash: { USD: -10_250 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 18_739_250, unsettled: 0, availableToTrade: 18_739_250, availableToWithdraw: 18_739_250 } } },
        pending: [],
        balance: { treasury: { cash: 18_739_250, payable: null, assets: 19_049_250, liabilities: 30_000 } },
      },
    },
    // The index closes at 4,800.00 on Monday 20 April: the end of the first period.
    { id: 'first-reset-level', covers: 'reset fixing', action: 'close_price', instrument: 'index', date: '2026-04-20', value: 4_800, expect: {} },
    {
      // First period, notional 15,000,000 (the increase took the whole period):
      //   index return: 15,000,000 x (4,800 / 5,000 - 1) = -600,000.00 for the side as written; Treasury, opposite, receives 600,000.00
      //   financing:    15,000,000 x (3.90% - 0.20%) x 90/360 = 138,750.00, received
      id: 'first-period', covers: ['return payment', 'financing payment'], action: 'clock', to: at('2026-04-22'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${EIS_NAME}, leg A (return), period 2026-01-20 to 2026-04-20: 600,000.00 USD`, cash: { USD: 600_000 }, owner: 'treasury', date: '2026-04-22' },
          { type: 'swap.payment', summary: `Swap receipt on ${EIS_NAME}, leg B (float), period 2026-01-20 to 2026-04-20: 138,750.00 USD`, cash: { USD: 138_750 }, owner: 'treasury', date: '2026-04-22' },
        ],
        cash: { treasury: { USD: { settled: 19_478_000, availableToTrade: 19_478_000, availableToWithdraw: 19_478_000 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-07-22', status: 'pending', owner: 'treasury' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-22', status: 'pending', owner: 'treasury' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-22', status: 'pending', owner: 'treasury' },
        ],
        pnl: { book: { realized: 738_750, total: 758_000 } }, // 600,000 + 138,750; then - 750 + 20,000
        nav: { treasury: 19_758_000, book: 20_758_000 },
        balance: { treasury: { cash: 19_478_000, assets: 19_788_000, netAssets: 19_758_000 } },
      },
    },
    { id: 'treasury-screens-after-first-period', covers: 'return payment', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      // The index has rallied: the contract as written is marked 1.50. Opposite side: -15,000,000 x 1.50 / 100 = -225,000; 235,000 below the 10,000 paid.
      id: 'mark-rallies', action: 'manual_price', instrument: 'main', value: 1.50, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'eis', price: 1.5, value: -225_000, unrealized: -235_000 }],
        otc: [{ instrument: 'main', mark: 1.5, markValue: -225_000 }],
        pnl: { book: { unrealized: -235_000, total: 503_000 } },
        nav: { treasury: 19_503_000, book: 20_503_000 },
        balance: { treasury: { positions: -225_000, assets: 19_533_000, netAssets: 19_503_000 } },
      },
    },
    {
      id: 'variation-margin-posted-again', covers: 'variation margin', action: 'clock', to: eod('2026-04-22'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer Q" (Dealer Q): 30,000.00 USD returned to the counterparty and 225,000.00 USD posted. Netting set of 1 position marked at -225,000.00 USD; threshold 0.00 USD.', owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 19_253_000, restricted: 0, margin: 475_000, availableToTrade: 19_253_000, availableToWithdraw: 19_253_000 } } },
        otc: [{ instrument: 'main', vmPosted: 225_000, vmHeld: 0, vmExposure: -225_000 }],
        balance: { treasury: { cash: 19_253_000, restricted: null, margin: 475_000, collateralReceived: null, assets: 19_503_000, liabilities: 0, netAssets: 19_503_000 } },
      },
    },
    // The index closes at 5,040.00 on Monday 20 July: the end of the second period.
    { id: 'second-reset-level', covers: 'reset fixing', action: 'close_price', instrument: 'index', date: '2026-07-20', value: 5_040, expect: {} },
    {
      // Second period, 15,000,000:
      //   index return: 15,000,000 x (5,040 / 4,800 - 1) = 750,000.00 for the side as written; Treasury pays it
      //   financing:    15,000,000 x (3.80% - 0.20%) x 91/360 = 136,500.00, received
      // The swap matures: the 10,000 of upfront carried is written off; the 250,000 independent amount and the 225,000 posted come back.
      // 19,000,000 - 750 - 10,000 + 600,000 + 138,750 - 750,000 + 136,500 = 19,114,500.
      id: 'second-period-and-maturity', covers: ['return payment', 'financing payment', 'maturity', 'close', 'collateral'], action: 'clock', to: at('2026-07-22'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${EIS_NAME}, leg A (return), period 2026-04-20 to 2026-07-20: 750,000.00 USD`, cash: { USD: -750_000 }, owner: 'treasury', date: '2026-07-22' },
          { type: 'swap.payment', summary: `Swap receipt on ${EIS_NAME}, leg B (float), period 2026-04-20 to 2026-07-20: 136,500.00 USD`, cash: { USD: 136_500 }, owner: 'treasury', date: '2026-07-22' },
          { type: 'swap.matured', summary: `Swap matured: ${EIS_NAME} (notional 15,000,000)`, owner: 'treasury' },
          { type: 'swap.collateral', summary: `Collateral returned on ${EIS_NAME} under "CSA Dealer Q" (Dealer Q): 250,000.00 USD (independent amount, the position ended)`, cash: { USD: 250_000 }, owner: 'treasury' },
          { type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer Q" (Dealer Q): 225,000.00 USD returned to us. The last position of the netting set ended.', cash: { USD: 225_000 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 19_114_500, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 19_114_500, availableToWithdraw: 19_114_500 } }, account: { USD: { settled: 1_000_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        pnl: { book: { realized: 115_250, commissions: -750, unrealized: 0, total: 114_500 } }, // 738,750 - 750,000 + 136,500 - 10,000
        nav: { account: 1_000_000, treasury: 19_114_500, book: 20_114_500 },
        provisional: { account: false, book: false },
        balance: { treasury: { cash: 19_114_500, margin: null, positions: null, assets: 19_114_500, liabilities: 0, netAssets: 19_114_500 } },
      },
    },
    { id: 'treasury-screens-after-maturity', covers: 'maturity', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      id: 'nothing-left', action: 'clock', to: at('2026-07-23'),
      expect: { events: [], lifecycle: [], positions: [], pending: [], otc: [], alerts: [], cash: { treasury: { USD: { settled: 19_114_500, margin: 0, restricted: 0 } } } },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// equity_trs
// ---------------------------------------------------------------------------------------------
// A six-month euro equity total-return swap on Valcourt Industries (VALC, Euronext Paris), in a Book that reports
// in US dollars. Receive the total return (price return each quarter, and every cash dividend passed through when
// the stock goes ex), pay 3-month EURIBOR + 0.60% ACT/360, on a fixed notional; both legs paid 2 TARGET business
// days after each reset date. Uncollateralized (paper assumption).
//
//   period 1  2026-04-01 to 2026-07-01  91 days  VALC 40.00 to 42.00 (+5%)    EURIBOR3M 2.10%   paid Friday 3 July
//   period 2  2026-07-01 to 2026-10-01  92 days  VALC 42.00 to 39.90 (-5%)    EURIBOR3M 2.00%   paid Monday 5 October
//   dividend  1.20 EUR, ex-date Wednesday 20 May: reference units = notional / start fixing of the period = 5,000,000 / 40 = 125,000
// Reporting currency: EUR balances at the EUR/USD fixture (1.10, then 1.12 from 6 July); ledger entries keep the rate of
// their day and the difference is the FX effect. The trade on Monday 30 March settles Wednesday 1 April (T+2 TARGET).
const VALC = { productId: 'common_stock', name: 'Valcourt Industries SA', symbol: 'VALC', marketView: 'FOREIGN_CASH', venue: 'Euronext Paris', venueType: 'exchange', venueCountry: 'FR', issuer: 'Valcourt Industries SA', domicile: 'FR', underlyingGeo: 'FR', tradingCcy: 'EUR', terms: {} };
const ETRS_NAME = 'EUR equity TRS VALC v EURIBOR3M + 0.60% 1 Oct 2026';
const equityTrs = {
  productId: 'equity_trs',
  title: 'Six-month euro equity total-return swap on a Euronext Paris stock, dividends passed through, in a USD-reporting Book',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'return leg: Reference asset (the stock), Options "Total return (pass income through)"', 'financing leg: Index (EURIBOR3M), Spread, Day count', 'both legs: Payment lag (business days) 2'],
    automaticInputs: ['reset and payment schedule on the TARGET calendar', 'VALC closes for the reset dates (close fixture standing in for Shaffer MarketData)', 'EURIBOR3M fixings (rate fixture)', 'dividend pass-through: reference units from the period\'s start fixing, paid when the stock goes ex', 'EUR/USD rate (FX fixture) for the reporting-currency figures', 'settlement date, T+2 TARGET', 'commission from the Book fee schedule'],
    manualInputs: ['the reference stock, registered as a common stock', 'upfront amount of the increase (stated fill price)', 'mark of the contract, entered by hand', 'the cash dividend on VALC, recorded by hand on the stock (Instrument drawer, Dividends and corporate actions)'],
    settlement: 'Upfront amounts and commission settle T+2 on TARGET; leg payments are cash on their payment date; a dividend passes through on its ex-date (the form has no separate pay date)',
    lifecycle: 'Total return: price return each quarter and the dividend passed through when the stock goes ex (in the first period, before any reset); increase inside the first period; across Good Friday and Easter Monday; a negative return paid in the second period; maturity; nothing left afterwards',
    accounting: 'Euro amounts in a USD-reporting Book: realized and unrealized P&L at the rate of their day, the revaluation of euro balances is the FX effect; the dividend pass-through is realized P&L; the upfront carried is written off at maturity',
    collateral: 'Uncollateralized (paper assumption): nothing is posted or received, whatever the mark',
  },
  start: at('2026-03-30'),
  settlementCheck: { lag: 2, holidays: [] }, // TARGET: no holiday in the windows used (30 March to 1 April, 6 to 8 May 2026)
  book: {
    name: 'Matrix equity TRS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }, { ccy: 'EUR', amount: 1_000_000 }],
    account: { name: 'Equity finance', funding: [{ ccy: 'EUR', amount: 800_000 }] },
    settings: { fees: { swap: { perUnit: 0.00005, minimum: 0, bps: 0 }, equity: NO_FEE }, fill: FILL, settlement: { swap: 2 } }, // 50.00 EUR per million of notional
  },
  instruments: {
    valc: VALC,
    main: {
      productId: 'equity_trs', name: ETRS_NAME, symbol: 'ETRS-VALC-1026', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'FR', tradingCcy: 'EUR', multiplier: 0.01,
      conventions: { tradingCalendar: 'TARGET', settlementCalendar: 'TARGET', paymentCalendar: 'TARGET' },
      terms: {
        effective: '2026-04-01', maturity: '2026-10-01', counterparty: 'Banque R', collateralBasis: { type: 'uncollateralized' },
        legs: [
          { side: 'receive', type: 'return', ccy: 'EUR', months: 3, underlyingId: '$inst:valc', passDividends: true, resetNotional: false, paymentLag: 2 },
          { side: 'pay', type: 'float', ccy: 'EUR', index: 'EURIBOR3M', spread: 0.006, months: 3, dayCount: 'ACT/360', paymentLag: 2 },
        ],
      },
    },
  },
  fx: { 'EUR/USD': 1.10 },
  rates: { EURIBOR3M: { currency: 'EUR', byDate: { '2026-04-01': 2.10 } } },
  expectAtStart: {
    cash: {
      account: { EUR: { settled: 800_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 800_000 } },
      treasury: { USD: { settled: 2_000_000, unsettled: 0 }, EUR: { settled: 200_000, unsettled: 0 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], lifecycleFailures: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 880_000, treasury: 2_220_000, book: 3_100_000 }, // 800,000 EUR x 1.10; 2,000,000 + 200,000 x 1.10
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      // 4,000,000 EUR as written, no upfront. Commission 4,000,000 x 0.00005 = 200 EUR (220 USD), settling Wednesday 1 April.
      id: 'open', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 4_000_000, as: 'trs', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-04-01', calendar: 'TARGET', cash: 0, fees: 200 }],
          cash: { EUR: { purchases: 0, fees: 200, margin: 0, required: 200, available: 800_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 4_000_000, avgPrice: 0, fills: [{ qty: 4_000_000, price: 0, model: 'stated-price', settleDate: '2026-04-01' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Entered as written: 4,000,000 notional of ETRS-VALC-1026 at 0.00 per 100 notional', owner: 'account', date: '2026-03-30' }],
        cash: { account: { EUR: { settled: 800_000, unsettled: -200, margin: 0, restricted: 0, availableToTrade: 799_800, availableToWithdraw: 799_800 } } },
        positions: [{ instrument: 'main', lot: 'trs', owner: 'account', direction: 'as written', qty: 4_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 4_000_000, margin: 0 }],
        holdings: { main: { long: 4_000_000, short: 0, net: 4_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-01', amount: -200, ccy: 'EUR', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-03', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-03', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-10-05', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'trs', owner: 'account', qty: 4_000_000, basis: 'uncollateralized', agreement: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -220, unrealized: 0, fx: 0, total: -220 } },
        nav: { account: 879_780, book: 3_099_780 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 880_000, payable: 220, positions: null, assets: 880_000, liabilities: 220, netAssets: 879_780 } },
      },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-04-01'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 200.00 EUR from settled cash', cash: { EUR: -200 }, date: '2026-04-01' }],
        cash: { account: { EUR: { settled: 799_800, unsettled: 0, availableToTrade: 799_800, availableToWithdraw: 799_800 } } },
        pending: [],
        balance: { account: { cash: 879_780, payable: null, assets: 879_780, liabilities: 0 } },
      },
    },
    { id: 'start-price', covers: 'reset fixing', action: 'close_price', instrument: 'valc', date: '2026-04-01', value: 40, expect: {} },
    {
      // 4,000,000 x 0.60 / 100 = 24,000 EUR = 26,400 USD.
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.60, note: 'Dealer mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'trs', price: 0.6, value: 24_000, unrealized: 24_000, provisional: false, priceSource: 'Manual entry', priceStatus: 'manual' }],
        otc: [{ instrument: 'main', mark: 0.6, markValue: 24_000 }],
        pnl: { account: { unrealized: 26_400, total: 26_180 } },
        nav: { account: 906_180, book: 3_126_180 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 26_400, assets: 906_180, netAssets: 906_180 } },
      },
    },
    { id: 'after-easter', covers: 'holiday', action: 'clock', to: at('2026-05-06'), expect: { events: [] } }, // Good Friday 3 April, Easter Monday 6 April, 1 May: TARGET closed, nothing due
    {
      // 1,000,000 more at 0.50 per 100: 5,000 EUR paid; commission 50; settles Friday 8 May. Cost 5,000; value 5,000,000 x 0.60 / 100 = 30,000; unrealized 25,000 EUR = 27,500 USD.
      // The added notional takes the whole first period (its return from the 1 April fixing).
      id: 'increase', covers: 'increase', action: 'resize', lot: 'trs', factor: 1.25, order: { statedPrice: 0.50 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 0.5, model: 'stated-price', settleDate: '2026-05-08', cash: -5_000, fees: 50 }], cash: { EUR: { purchases: 5_000, fees: 50, required: 5_050, available: 799_800, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 0.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Increased as written: 1,000,000 notional of ETRS-VALC-1026 at 0.50 per 100 notional' }],
        cash: { account: { EUR: { settled: 799_800, unsettled: -5_050, availableToTrade: 794_750, availableToWithdraw: 794_750 } } },
        positions: [{ instrument: 'main', lot: 'trs', qty: 5_000_000, cost: 5_000, avgCost: 0.1, price: 0.6, value: 30_000, unrealized: 25_000, notional: 5_000_000 }],
        holdings: { main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-05-08', amount: -5_050, ccy: 'EUR', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 5_000_000, markValue: 30_000 }],
        pnl: { account: { commissions: -275, unrealized: 27_500, total: 27_225 } },
        nav: { account: 907_225, book: 3_127_225 }, // (799,800 - 5,050 + 30,000) x 1.10
        balance: { account: { cash: 879_780, payable: 5_555, positions: 33_000, assets: 912_780, liabilities: 5_555, netAssets: 907_225 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-05-08'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 5,050.00 EUR from settled cash', cash: { EUR: -5_050 } }],
        cash: { account: { EUR: { settled: 794_750, unsettled: 0, availableToTrade: 794_750, availableToWithdraw: 794_750 } } },
        pending: [],
        balance: { account: { cash: 874_225, payable: null, assets: 907_225, liabilities: 0 } },
      },
    },
    { id: 'dividend-recorded', covers: 'dividend', action: 'corporate_action', instrument: 'valc', type: 'cash_dividend', exDate: '2026-05-20', amount: 1.20, expect: {} },
    {
      // VALC goes ex 1.20 EUR. Reference units 5,000,000 / 40.00 = 125,000; passed through, received: 125,000 x 1.20 = 150,000.00 EUR (165,000 USD).
      id: 'dividend-passed-through', covers: ['dividend', 'dividend pass-through'], action: 'clock', to: at('2026-05-20'),
      expect: {
        events: [{ type: 'swap.dividend', summary: `Dividend pass-through on ${ETRS_NAME}: received 150,000.00 EUR (125,000 reference shares x 1.2)`, cash: { EUR: 150_000 }, owner: 'account' }],
        cash: { account: { EUR: { settled: 944_750, availableToTrade: 944_750, availableToWithdraw: 944_750 } } },
        pnl: { account: { realized: 165_000, total: 192_225 } },
        nav: { account: 1_072_225, book: 3_292_225 }, // (944,750 + 30,000) x 1.10
        balance: { account: { cash: 1_039_225, assets: 1_072_225, netAssets: 1_072_225 } },
      },
    },
    { id: 'first-reset-price', covers: 'reset fixing', action: 'close_price', instrument: 'valc', date: '2026-07-01', value: 42, expect: {} },
    {
      // First period, 5,000,000 EUR:
      //   return, received:  5,000,000 x (42 / 40 - 1) = 250,000.00 EUR
      //   financing, paid:   5,000,000 x (2.10% + 0.60%) x 91/360 = 34,125.00 EUR
      id: 'first-period', covers: ['return payment', 'financing payment'], action: 'clock', to: at('2026-07-03'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${ETRS_NAME}, leg A (return), period 2026-04-01 to 2026-07-01: 250,000.00 EUR`, cash: { EUR: 250_000 }, owner: 'account', date: '2026-07-03' },
          { type: 'swap.payment', summary: `Swap payment on ${ETRS_NAME}, leg B (float), period 2026-04-01 to 2026-07-01: 34,125.00 EUR`, cash: { EUR: -34_125 }, owner: 'account', date: '2026-07-03' },
        ],
        cash: { account: { EUR: { settled: 1_160_625, availableToTrade: 1_160_625, availableToWithdraw: 1_160_625 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-10-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-05', status: 'pending' },
        ],
        pnl: { account: { realized: 402_462.50, total: 429_687.50 } }, // (150,000 + 250,000 - 34,125) x 1.10; then - 275 + 27,500
        nav: { account: 1_309_687.50, book: 3_529_687.50 },
        balance: { account: { cash: 1_276_687.50, assets: 1_309_687.50, netAssets: 1_309_687.50 } },
      },
    },
    { id: 'july-fixing', action: 'rate', code: 'EURIBOR3M', value: 2.00, date: '2026-07-01', currency: 'EUR', expect: {} },
    {
      // The euro rises to 1.12. The Account's euro net assets, 1,160,625 + 30,000 = 1,190,625, gain 1,190,625 x 0.02 = 23,812.50 USD:
      // 500 of it is the unrealized result now worth more (25,000 x 1.12 = 28,000), the rest, 23,312.50, is the FX effect.
      // Treasury's 200,000 EUR gain 4,000 more: the Book's FX effect is 27,312.50.
      id: 'euro-rises', covers: 'reporting currency', action: 'fx_rate', pair: 'EUR/USD', rate: 1.12,
      expect: {
        pnl: { account: { realized: 402_462.50, commissions: -275, unrealized: 28_000, fx: 23_312.50, total: 453_500 }, book: { fx: 27_312.50, total: 457_500 } },
        nav: { account: 1_333_500, treasury: 2_224_000, book: 3_557_500 },
        balance: { account: { cash: 1_299_900, positions: 33_600, assets: 1_333_500, netAssets: 1_333_500 } }, // 1,160,625 x 1.12; 30,000 x 1.12
      },
    },
    { id: 'second-reset-price', covers: 'reset fixing', action: 'close_price', instrument: 'valc', date: '2026-10-01', value: 39.90, expect: {} },
    {
      // Second period, 5,000,000 EUR, starting from the 42.00 the first period ended on:
      //   return, paid:      5,000,000 x (39.90 / 42 - 1) = -250,000.00 EUR, paid
      //   financing, paid:   5,000,000 x (2.00% + 0.60%) x 92/360 = 33,222.22 EUR
      // The swap matures: the 5,000 EUR still carried is written off. At 1.12: -280,000.00, -37,208.89 and -5,600.00 USD.
      // Euro cash: 800,000 - 200 - 5,000 - 50 + 150,000 + 250,000 - 34,125 - 250,000 - 33,222.22 = 877,402.78 EUR = 982,691.11 USD.
      id: 'second-period-and-maturity', covers: ['return payment', 'financing payment', 'negative return', 'maturity', 'close'], action: 'clock', to: at('2026-10-05'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${ETRS_NAME}, leg A (return), period 2026-07-01 to 2026-10-01: 250,000.00 EUR`, cash: { EUR: -250_000 }, owner: 'account', date: '2026-10-05' },
          { type: 'swap.payment', summary: `Swap payment on ${ETRS_NAME}, leg B (float), period 2026-07-01 to 2026-10-01: 33,222.22 EUR`, cash: { EUR: -33_222.22 }, owner: 'account', date: '2026-10-05' },
          { type: 'swap.matured', summary: `Swap matured: ${ETRS_NAME} (notional 5,000,000)`, owner: 'account' },
        ],
        cash: { account: { EUR: { settled: 877_402.78, unsettled: 0, margin: 0, restricted: 0, reserved: 0, availableToTrade: 877_402.78, availableToWithdraw: 877_402.78 } }, treasury: { EUR: { settled: 200_000 }, USD: { settled: 2_000_000 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [], pending: [], alerts: [],
        pnl: { account: { realized: 79_653.61, commissions: -275, unrealized: 0, fx: 23_312.50, total: 102_691.11 }, book: { fx: 27_312.50, total: 106_691.11 } }, // 402,462.50 - 280,000 - 37,208.89 - 5,600
        nav: { account: 982_691.11, treasury: 2_224_000, book: 3_206_691.11 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 982_691.11, positions: null, assets: 982_691.11, liabilities: 0, netAssets: 982_691.11 } },
      },
    },
    {
      id: 'nothing-left', action: 'clock', to: at('2026-10-06'),
      expect: { events: [], lifecycle: [], positions: [], pending: [], otc: [], alerts: [], cash: { account: { EUR: { settled: 877_402.78, margin: 0, restricted: 0 } } } },
    },
  ],
};

export default [amortizingSwap, accretingSwap, equitySwap, equityIndexSwap, equityTrs];
