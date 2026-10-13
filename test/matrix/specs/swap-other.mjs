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
    collateral: 'Position-level terms: fixed independent amount 100,000 (posted at entry, unchanged by the increase and the partial termination, returned at maturity); variation margin at end of day on the mark entered by hand, threshold 25,000, minimum transfer 5,000. A percentage independent amount would be on the base notional, not on the amortized notional (not exercised here)',
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

export default [amortizingSwap];
