// Swap family, the products the catalog marks as partly supported (engine family "swap"): non-deliverable, CMS spread,
// callable, puttable, quanto, asset, equity-basket, loan total-return and dividend swaps. One scenario per product, each
// on its own fictional contract registered as exactly that product, with what makes it that product worked by hand and
// the inputs no service supplies entered by hand through the interface. s3, 2026-10-13.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec, with the arithmetic in a
// comment beside it. Nothing here is copied from what the Terminal prints.
//
// The general rules of a swap (legs, "Enter as written" / "Enter the opposite side", price per 100 of notional, marks by
// hand, gross leg payments, collateral, commission) are restated at the top of swap-rates.mjs. What these products add
// (server/products/swap-partial.js):
//   - non-deliverable: each leg is worked out in its own currency and paid in the settlement currency at the FX fixing of
//     the fixing date (payment date less the fixing lag, in business days of the payment calendar), entered by hand for
//     that date; the payment waits visibly until it is there; nothing is ever paid in the leg's own currency.
//   - CMS spread: a floating leg pays (index - second index + spread) x notional x fraction, both fixed at the period start.
//   - callable / puttable: the right to end the swap on one of its dates, exercised by hand on that date only; each leg's
//     amount accrued since its last payment is settled, the swap ends at no further cost and its collateral is released.
//   - quanto: the leg is worked out in another currency on the notional at the contract's fixed rate and paid in its own
//     currency at that same rate; spot FX plays no part.
//   - basket: a return leg on a composite whose level at each reset is entered by hand on the payment item.
//   - loan TRS: the reference loan's interest and principal repaid are passed through by hand on the position.
//   - dividend: a leg paying units x the cash dividends per share going ex in the period, as recorded by hand on the stock.

export const family = 'swap';

const dst = (date) => (date >= '2026-03-08' && date < '2026-11-01') || (date >= '2027-03-14' && date < '2027-11-07') || (date >= '2028-03-12' && date < '2028-11-05');
/** 10:00 New York as a UTC instant. */
const at = (date, hhmm) => `${date}T${hhmm || (dst(date) ? '14:00' : '15:00')}:00.000Z`;
/** 17:30 New York: after the 17:00 end-of-day pass. */
const eod = (date) => at(date, dst(date) ? '21:30' : '22:30');

const FILL = { halfSpreadBps: { swap: 0, equity: 0, bond: 0, manual: 0 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const NO_FEE = { perUnit: 0, minimum: 0, bps: 0 };

const OTC_TICKET = {
  ticket: 'Registry form (Instruments, New instrument) for the contract: legs, schedules, calendars and the required Collateral terms group; then the instrument drawer, Trade tab (Enter as written / Enter the opposite side, Notional, State a fill price); the strategy instance for increase and termination',
  requiredFields: ['Effective date', 'Maturity', 'each leg: Side, Leg type, Currency, rate, index or reference asset, Payment, Day count', 'Collateral basis', 'Trading owner', 'Action', 'Notional', 'State a fill price (no executable quote exists for an OTC contract)'],
};
const usdStart = (account, treasury) => ({
  cash: {
    account: { USD: { settled: account, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: account, availableToWithdraw: account } },
    treasury: { USD: { settled: treasury } },
  },
  positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
  nav: { account, treasury, book: account + treasury },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
});

// ---------------------------------------------------------------------------------------------
// dividend_swap
// ---------------------------------------------------------------------------------------------
// One-year dividend swap on Norland Breweries (NRB, NYSE) over 500,000 shares, two semi-annual periods (1 April to 1 October
// 2026, 1 October 2026 to 1 April 2027): pay a fixed 1.10 per share per period (a price leg at a fixed price), receive the
// cash dividends per share that go ex in the period, recorded by hand on NRB as they are declared (Instrument drawer,
// Dividends and corporate actions); a dividend going ex on a period's last day belongs to the next period. Quantity is the
// number of shares; price per 100 shares. Position-level terms: variation margin over a 25,000 threshold, 5,000 minimum
// transfer. Commission 0.001 per share; T+2 (USD calendar).
//   period 1: dividends 0.55 (ex 14 May) + 0.60 (ex 13 August) = 1.15: receive 500,000 x 1.15 = 575,000.00,
//     pay 500,000 x 1.10 = 550,000.00 on Thu 1 October
//   200,000 shares terminated on Tue 15 December at -3.00 per 100: 200,000 x 3.00 / 100 = 6,000.00 paid (+ 200.00)
//   period 2 on 300,000 shares: dividends 0.60 (ex 12 November) + 0.40 (ex 11 February 2027) = 1.00: receive 300,000.00,
//     pay 330,000.00 on Thu 1 April 2027; the 0.05 going ex on 1 April 2027 is not in it
const NRB = { productId: 'common_stock', name: 'Norland Breweries Inc.', symbol: 'NRB', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Norland Breweries Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} };
const DIVS_NAME = 'NRB dividend swap 1.10 per share per half-year to 1 Apr 2027';
const dividendSwap = {
  productId: 'dividend_swap',
  title: 'Single-stock dividend swap: realised dividends recorded by hand on the stock against a fixed 1.10 per share per half-year',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'dividend leg: Leg type "Realised dividends of a stock", Reference asset (the stock), Units per unit of notional', 'fixed leg: Leg type "Price of a reference asset", Fixed price'],
    automaticInputs: ['payment schedule from the contract terms and the USD calendar', 'the sum of the cash dividends per share going ex in each period, from the dividends recorded on the stock', 'settlement date T+2', 'commission from the Book fee schedule', 'variation margin from the position-level terms'],
    manualInputs: ['the reference stock, registered as a common stock', 'each cash dividend of the stock (ex-date, amount), recorded by hand on it', 'upfront and termination amounts (stated fill prices)', 'marks per 100 shares entered by hand'],
    settlement: 'Upfront and termination amounts and commission T+2 on the USD calendar; each leg paid on the period end',
    lifecycle: 'Realised dividends of each period received, the fixed amount paid (gross, each leg on its own); partial termination at a stated amount; the second period on the remaining shares; a dividend going ex on the last day left to the next period; maturity',
    accounting: 'Carried at the mark less the upfront; leg payments and the termination result are realized P&L; commission expensed',
    collateral: 'Position-level terms: variation margin at end of day against the mark over a 25,000 threshold, 5,000 minimum transfer; received collateral restricted and owed back',
  },
  start: at('2026-03-30'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix dividend swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Equity derivatives', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.001, minimum: 0, bps: 0 }, equity: NO_FEE }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {
    nrb: NRB,
    main: {
      productId: 'dividend_swap', name: DIVS_NAME, symbol: 'DIVS-NRB-0427', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        effective: '2026-04-01', maturity: '2027-04-01', counterparty: 'Dealer D',
        collateralBasis: { type: 'position', independentAmount: { type: 'none' }, variationMargin: true, threshold: 25_000, minimumTransfer: 5_000 },
        legs: [
          { side: 'pay', type: 'price', ccy: 'USD', units: 1, fixedPrice: 1.10, months: 6 },
          { side: 'receive', type: 'dividend', ccy: 'USD', underlyingId: '$inst:nrb', units: 1, months: 6 },
        ],
      },
    },
  },
  expectAtStart: usdStart(1_000_000, 2_000_000),
  steps: [
    {
      id: 'open', covers: ['open'], action: 'ticket', instrument: 'main', side: 'buy', qty: 500_000, as: 'divs', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 500_000, estimate: 0, model: 'stated-price', settleDate: '2026-04-01', calendar: 'USD', cash: 0, fees: 500 }], // 500,000 x 0.001
          cash: { USD: { fees: 500, margin: 0, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 500_000, avgPrice: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Entered as written: 500,000 notional of DIVS-NRB-0427 at 0.00 per 100 notional', owner: 'account', date: '2026-03-30' }],
        cash: { account: { USD: { unsettled: -500, availableToTrade: 999_500, availableToWithdraw: 999_500 } } },
        positions: [{ instrument: 'main', lot: 'divs', owner: 'account', direction: 'as written', qty: 500_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 500_000 }],
        holdings: { main: { long: 500_000, short: 0, net: 500_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-01', amount: -500, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-01', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-01', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'divs', owner: 'account', qty: 500_000, basis: 'position', mark: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -500, unrealized: 0, total: -500 } },
        nav: { account: 999_500, book: 2_999_500 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_000_000, payable: 500, positions: null, assets: 1_000_000, liabilities: 500, netAssets: 999_500 } },
      },
    },
    {
      id: 'mark-at-par', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0, note: 'Dealer D mark per 100 shares, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'divs', price: 0, value: 0, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 0, markValue: 0 }], provisional: { account: false, book: false }, balance: { account: { positions: null } } }, // a zero line is not shown
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-04-01'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 500.00 USD from settled cash', cash: { USD: -500 } }],
        cash: { account: { USD: { settled: 999_500, unsettled: 0, availableToTrade: 999_500, availableToWithdraw: 999_500 } } },
        pending: [],
        balance: { account: { cash: 999_500, payable: null, assets: 999_500, liabilities: 0 } },
      },
    },
    { id: 'may-ex-date', action: 'clock', to: at('2026-05-14'), expect: {} },
    { id: 'first-dividend', covers: 'realised dividend', action: 'corporate_action', instrument: 'nrb', type: 'cash_dividend', exDate: '2026-05-14', amount: 0.55, expect: {} },
    { id: 'august-ex-date', action: 'clock', to: at('2026-08-13'), expect: {} },
    { id: 'second-dividend', covers: 'realised dividend', action: 'corporate_action', instrument: 'nrb', type: 'cash_dividend', exDate: '2026-08-13', amount: 0.60, expect: {} },
    {
      // 500,000 x 6.00 / 100 = 30,000 to us.
      id: 'mark-after-dividends', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 6.00, note: 'Dealer D mark per 100 shares, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'divs', price: 6, value: 30_000, unrealized: 30_000 }],
        otc: [{ instrument: 'main', mark: 6, markValue: 30_000 }],
        pnl: { account: { unrealized: 30_000, total: 29_500 } },
        nav: { account: 1_029_500, book: 3_029_500 },
        balance: { account: { positions: 30_000, assets: 1_029_500, netAssets: 1_029_500 } },
      },
    },
    {
      // 30,000 is 5,000 over the 25,000 threshold: Dealer D posts 5,000 (the minimum transfer).
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-08-13'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 5,000.00 USD received. Netting set of 1 position marked at 30,000.00 USD; threshold 25,000.00 USD.', owner: 'account' }],
        cash: { account: { USD: { restricted: 5_000 } } },
        otc: [{ instrument: 'main', vmHeld: 5_000, vmExposure: 30_000, vmStatus: 'ok' }],
        balance: { account: { restricted: 5_000, collateralReceived: 5_000, assets: 1_034_500, liabilities: 5_000 } },
      },
    },
    {
      // Period 1: the fixed 1.10 x 500,000 = 550,000.00 paid; the realised 0.55 + 0.60 = 1.15 x 500,000 = 575,000.00 received.
      id: 'first-period', covers: ['fixed amount', 'realised dividends'], action: 'clock', to: at('2026-10-01'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${DIVS_NAME}, leg A (price), period 2026-04-01 to 2026-10-01: 550,000.00 USD`, cash: { USD: -550_000 }, date: '2026-10-01' },
          { type: 'swap.payment', summary: `Swap receipt on ${DIVS_NAME}, leg B (dividend), period 2026-04-01 to 2026-10-01: 575,000.00 USD`, cash: { USD: 575_000 }, date: '2026-10-01' },
        ],
        cash: { account: { USD: { settled: 1_024_500, availableToTrade: 1_024_500, availableToWithdraw: 1_024_500 } } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
        ],
        pnl: { account: { realized: 25_000, total: 54_500 } },
        nav: { account: 1_054_500, book: 3_054_500 },
        balance: { account: { cash: 1_024_500, assets: 1_059_500, netAssets: 1_054_500 } },
      },
    },
    { id: 'november-ex-date', action: 'clock', to: at('2026-11-12'), expect: {} },
    { id: 'third-dividend', covers: 'realised dividend', action: 'corporate_action', instrument: 'nrb', type: 'cash_dividend', exDate: '2026-11-12', amount: 0.60, expect: {} },
    { id: 'mid-december', action: 'clock', to: at('2026-12-15'), expect: {} },
    {
      id: 'mark-lower', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -3.00, note: 'Dealer D mark per 100 shares, by hand (a dividend cut is expected)',
      expect: {
        positions: [{ instrument: 'main', lot: 'divs', price: -3, value: -15_000, unrealized: -15_000 }],
        otc: [{ instrument: 'main', mark: -3, markValue: -15_000 }],
        pnl: { account: { unrealized: -15_000, total: 9_500 } },
        nav: { account: 1_009_500, book: 3_009_500 },
        balance: { account: { positions: -15_000, assets: 1_014_500, netAssets: 1_009_500 } },
      },
    },
    {
      // 200,000 shares terminated at -3.00 per 100: 6,000.00 paid, realized -6,000.00; commission 200.00. Settles Thu 17 December.
      id: 'partial-termination', covers: ['reduce', 'partial termination'], action: 'close', lot: 'divs', scope: 'strategy', percent: 40, order: { statedPrice: -3.00 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 200_000, estimate: -3, model: 'stated-price', settleDate: '2026-12-17', cash: -6_000, fees: 200 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 200_000, avgPrice: -3 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Terminated in part: 200,000 of 500,000 notional of DIVS-NRB-0427 at -3.00 per 100 notional (realized -6,000.00 USD)' }],
        cash: { account: { USD: { unsettled: -6_200, availableToTrade: 1_018_300, availableToWithdraw: 1_018_300 } } },
        positions: [{ instrument: 'main', lot: 'divs', qty: 300_000, cost: 0, price: -3, value: -9_000, unrealized: -9_000, notional: 300_000 }],
        holdings: { main: { long: 300_000, short: 0, net: 300_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-12-17', amount: -6_200, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 300_000, markValue: -9_000 }],
        pnl: { account: { realized: 19_000, commissions: -700, unrealized: -9_000, total: 9_300 } },
        nav: { account: 1_009_300, book: 3_009_300 },
        balance: { account: { payable: 6_200, positions: -9_000, assets: 1_020_500, liabilities: 11_200, netAssets: 1_009_300 } },
      },
    },
    {
      // -9,000 is inside the threshold: the 5,000 held goes back.
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-12-15'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 5,000.00 USD returned to the counterparty.' }],
        cash: { account: { USD: { restricted: 0 } } },
        otc: [{ instrument: 'main', vmHeld: 0, vmExposure: -9_000 }],
        balance: { account: { restricted: null, collateralReceived: null, assets: 1_015_500, liabilities: 6_200 } },
      },
    },
    {
      id: 'settle-termination', covers: 'settlement', action: 'clock', to: at('2026-12-17'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 6,200.00 USD from settled cash', cash: { USD: -6_200 } }],
        cash: { account: { USD: { settled: 1_018_300, unsettled: 0, availableToTrade: 1_018_300, availableToWithdraw: 1_018_300 } } },
        pending: [],
        balance: { account: { cash: 1_018_300, payable: null, assets: 1_009_300, liabilities: 0 } },
      },
    },
    { id: 'february-ex-date', action: 'clock', to: at('2027-02-11'), expect: {} },
    { id: 'cut-dividend', covers: 'realised dividend', action: 'corporate_action', instrument: 'nrb', type: 'cash_dividend', exDate: '2027-02-11', amount: 0.40, expect: {} },
    { id: 'day-before-maturity', action: 'clock', to: at('2027-03-31'), expect: {} },
    // Declared now, going ex on 1 April 2027, the last day of period 2: it belongs to the period that would start that day.
    { id: 'dividend-ex-on-the-last-day', covers: 'realised dividend', action: 'corporate_action', instrument: 'nrb', type: 'cash_dividend', exDate: '2027-04-01', amount: 0.05, expect: {} },
    {
      // Period 2 on 300,000 shares: fixed 330,000.00 paid; realised 0.60 + 0.40 = 1.00 x 300,000 = 300,000.00 received; the swap matures.
      // 1,000,000 - 500 + 25,000 - 6,200 - 30,000 = 988,300.
      id: 'second-period-and-maturity', covers: ['fixed amount', 'realised dividends', 'maturity'], action: 'clock', to: at('2027-04-01'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${DIVS_NAME}, leg A (price), period 2026-10-01 to 2027-04-01: 330,000.00 USD`, cash: { USD: -330_000 } },
          { type: 'swap.payment', summary: `Swap receipt on ${DIVS_NAME}, leg B (dividend), period 2026-10-01 to 2027-04-01: 300,000.00 USD`, cash: { USD: 300_000 } },
          { type: 'swap.matured', summary: `Swap matured: ${DIVS_NAME} (notional 300,000)` },
        ],
        cash: { account: { USD: { settled: 988_300, availableToTrade: 988_300, availableToWithdraw: 988_300 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pnl: { account: { realized: -11_000, commissions: -700, unrealized: 0, total: -11_700 } }, // 19,000 - 30,000
        nav: { account: 988_300, book: 2_988_300 },
        balance: { account: { cash: 988_300, positions: null, assets: 988_300, liabilities: 0, netAssets: 988_300 } },
      },
    },
  ],
};

export default [dividendSwap];
