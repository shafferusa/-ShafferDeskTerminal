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

// ---------------------------------------------------------------------------------------------
// cms_spread_swap
// ---------------------------------------------------------------------------------------------
// One-year USD constant-maturity spread swap on 20,000,000: receive the 10-year CMS rate less the 2-year CMS rate plus
// 0.10% quarterly ACT/360, pay 0.75% fixed quarterly ACT/360; both CMS fixings are of the period start (USD calendar).
// The CMS rates are supplied as fixings (rate fixtures standing in for Shaffer MarketData); one is missing and is entered
// by hand. Position-level terms: independent amount 1% of notional, no variation margin. Commission 10.00 per million.
//   period 15 April to 15 July (91 days): spread 4.35% - 3.80% + 0.10% = 0.65%: 20,000,000 x 0.65% x 91/360 = 32,861.11
//     received; fixed 20,000,000 x 0.75% x 91/360 = 37,916.67 paid
//   period 15 July to 15 October (92 days): fixed 38,333.33 paid; the 2-year fixing of 15 July is missing: the spread
//     payment waits; entered by hand as 3.70%: 4.50% - 3.70% + 0.10% = 0.90%: 20,000,000 x 0.90% x 92/360 = 46,000.00
//   terminated on Mon 16 November at 0.20: 40,000.00 received; settles Wed 18 November
const CMSS_NAME = 'USD CMS 10Y-2Y spread +0.10% v 0.75% 15 Apr 2027';
const cmsSpreadSwap = {
  productId: 'cms_spread_swap',
  title: 'CMS spread swap: receive CMS10Y - CMS2Y + 0.10% against 0.75% fixed, a missing 2-year fixing entered by hand, terminated',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'spread leg: Index (the 10-year CMS rate code), Minus index (the 2-year CMS rate code), Spread'],
    automaticInputs: ['payment schedule from the contract terms and the USD calendar', 'both CMS fixings of each period start (rate fixtures standing in for Shaffer MarketData)', 'settlement date T+2', 'commission from the Book fee schedule', 'independent amount from the position-level terms'],
    manualInputs: ['upfront and termination amounts (stated fill prices)', 'marks entered by hand', 'a CMS fixing the data service has not supplied, entered by hand'],
    settlement: 'Upfront and termination amounts and commission T+2 on the USD calendar; legs paid on their payment dates',
    lifecycle: 'Spread and fixed payments each quarter; the spread payment waits visibly for a missing 2-year fixing (named) and is made once it is entered by hand; termination at a stated amount; nothing scheduled afterwards',
    accounting: 'Carried at the mark less the upfront; leg payments and the termination result realized; commission expensed',
    collateral: 'Position-level terms: independent amount 1% of notional posted at entry, returned on termination; no variation margin',
  },
  start: at('2026-04-13'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix CMS spread swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Curve', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.00001, minimum: 0, bps: 0 } }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {
    main: {
      productId: 'cms_spread_swap', name: CMSS_NAME, symbol: 'CMSS-10-2-0427', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        effective: '2026-04-15', maturity: '2027-04-15', counterparty: 'Dealer C',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.01 }, variationMargin: false },
        legs: [
          { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.0075, months: 3, dayCount: 'ACT/360' },
          { side: 'receive', type: 'float', ccy: 'USD', index: 'USDCMS10Y', index2: 'USDCMS2Y', spread: 0.001, months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  rates: { USDCMS10Y: { byDate: { '2026-04-15': 4.35, '2026-07-15': 4.50 } }, USDCMS2Y: { byDate: { '2026-04-15': 3.80 } } },
  expectAtStart: usdStart(1_000_000, 2_000_000),
  steps: [
    {
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 20_000_000, as: 'cmss', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 20_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-04-15', calendar: 'USD', cash: 0, fees: 200 }], // 20,000,000 x 0.00001
          cash: { USD: { fees: 200, margin: 200_000, shortfall: 0 } }, // 1% x 20,000,000
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20_000_000, avgPrice: 0 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered as written: 20,000,000 notional of CMSS-10-2-0427 at 0.00 per 100 notional', owner: 'account', date: '2026-04-13' },
          { type: 'swap.collateral', summary: `Collateral posted on ${CMSS_NAME} under its position-level terms: 200,000.00 USD (independent amount, 1.00% of 20,000,000.00 USD notional)`, cash: { USD: -200_000 } },
        ],
        cash: { account: { USD: { settled: 800_000, unsettled: -200, margin: 200_000, availableToTrade: 799_800, availableToWithdraw: 799_800 } } },
        positions: [{ instrument: 'main', lot: 'cmss', owner: 'account', direction: 'as written', qty: 20_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 20_000_000, margin: 200_000 }],
        holdings: { main: { long: 20_000_000, short: 0, net: 20_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-15', amount: -200, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-07-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-15', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'cmss', owner: 'account', qty: 20_000_000, basis: 'position', iaRequired: 200_000, iaPosted: 200_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -200, unrealized: 0, total: -200 } },
        nav: { account: 999_800, book: 2_999_800 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 800_000, margin: 200_000, payable: 200, positions: null, assets: 1_000_000, liabilities: 200, netAssets: 999_800 } },
      },
    },
    {
      id: 'mark-at-par', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0, note: 'Dealer C mark, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'cmss', price: 0, value: 0, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 0, markValue: 0 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-04-15'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 200.00 USD from settled cash', cash: { USD: -200 } }],
        cash: { account: { USD: { settled: 799_800, unsettled: 0, availableToTrade: 799_800, availableToWithdraw: 799_800 } } },
        pending: [],
        balance: { account: { cash: 799_800, payable: null, assets: 999_800, liabilities: 0 } },
      },
    },
    {
      // Both legs, Wed 15 July: fixed 37,916.67 paid; spread (4.35% - 3.80% + 0.10%) x 20,000,000 x 91/360 = 32,861.11 received.
      id: 'first-quarter', covers: ['fixed payment', 'CMS spread payment'], action: 'clock', to: at('2026-07-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${CMSS_NAME}, leg A (fixed), period 2026-04-15 to 2026-07-15: 37,916.67 USD`, cash: { USD: -37_916.67 }, date: '2026-07-15' },
          { type: 'swap.payment', summary: `Swap receipt on ${CMSS_NAME}, leg B (float), period 2026-04-15 to 2026-07-15: 32,861.11 USD`, cash: { USD: 32_861.11 }, date: '2026-07-15' },
        ],
        cash: { account: { USD: { settled: 794_744.44, availableToTrade: 794_744.44, availableToWithdraw: 794_744.44 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-15', status: 'pending' },
        ],
        pnl: { account: { realized: -5_055.56, total: -5_255.56 } },
        nav: { account: 994_744.44, book: 2_994_744.44 },
        balance: { account: { cash: 794_744.44, assets: 994_744.44, netAssets: 994_744.44 } },
      },
    },
    {
      // Thu 15 October: the fixed leg pays 20,000,000 x 0.75% x 92/360 = 38,333.33; the spread leg needs the 2-year fixing of 15 July.
      id: 'second-quarter-spread-waits', covers: ['fixed payment', 'missing fixing'], action: 'clock', to: at('2026-10-15'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${CMSS_NAME}, leg A (fixed), period 2026-07-15 to 2026-10-15: 38,333.33 USD`, cash: { USD: -38_333.33 } }],
        cash: { account: { USD: { settled: 756_411.11, availableToTrade: 756_411.11, availableToWithdraw: 756_411.11 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-15', status: 'blocked', reason: /Awaiting the USDCMS2Y fixing for 2026-07-15/ },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-15', status: 'pending' },
        ],
        pnl: { account: { realized: -43_388.89, total: -43_588.89 } },
        nav: { account: 956_411.11, book: 2_956_411.11 },
        balance: { account: { cash: 756_411.11, assets: 956_411.11, netAssets: 956_411.11 } },
      },
    },
    {
      // Entered by hand: 3.70% for 15 July. (4.50% - 3.70% + 0.10%) x 20,000,000 x 92/360 = 46,000.00 received.
      id: 'two-year-fixing-by-hand', covers: ['missing fixing', 'CMS spread payment'], action: 'manual_rate', code: 'USDCMS2Y', value: 3.70, date: '2026-07-15', note: 'Published 2-year CMS fixing, entered by hand',
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${CMSS_NAME}, leg B (float), period 2026-07-15 to 2026-10-15: 46,000.00 USD`, cash: { USD: 46_000 } }],
        cash: { account: { USD: { settled: 802_411.11, availableToTrade: 802_411.11, availableToWithdraw: 802_411.11 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-04-15', status: 'pending' },
        ],
        pnl: { account: { realized: 2_611.11, total: 2_411.11 } },
        nav: { account: 1_002_411.11, book: 3_002_411.11 },
        balance: { account: { cash: 802_411.11, assets: 1_002_411.11, netAssets: 1_002_411.11 } },
      },
    },
    { id: 'mid-november', action: 'clock', to: at('2026-11-16'), expect: {} },
    {
      id: 'mark-before-termination', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.20, note: 'Dealer C mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cmss', price: 0.2, value: 40_000, unrealized: 40_000 }],
        otc: [{ instrument: 'main', mark: 0.2, markValue: 40_000 }],
        pnl: { account: { unrealized: 40_000, total: 42_411.11 } },
        nav: { account: 1_042_411.11, book: 3_042_411.11 },
        balance: { account: { positions: 40_000, assets: 1_042_411.11, netAssets: 1_042_411.11 } },
      },
    },
    {
      id: 'terminate', covers: ['close', 'full termination', 'collateral'], action: 'close', lot: 'cmss', scope: 'position', percent: 100, order: { statedPrice: 0.20 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 20_000_000, estimate: 0.2, model: 'stated-price', settleDate: '2026-11-18', cash: 40_000, fees: 200 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 20_000_000, avgPrice: 0.2 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated: 20,000,000 notional of CMSS-10-2-0427 at 0.20 per 100 notional (realized 40,000.00 USD)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${CMSS_NAME} under its position-level terms: 200,000.00 USD (independent amount, the position ended)`, cash: { USD: 200_000 } },
        ],
        cash: { account: { USD: { settled: 1_002_411.11, unsettled: 39_800, margin: 0, availableToTrade: 1_042_211.11, availableToWithdraw: 1_002_411.11 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-11-18', amount: 39_800, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 42_611.11, commissions: -400, unrealized: 0, total: 42_211.11 } },
        nav: { account: 1_042_211.11, book: 3_042_211.11 },
        balance: { account: { cash: 1_002_411.11, margin: null, positions: null, receivable: 39_800, assets: 1_042_211.11, liabilities: 0, netAssets: 1_042_211.11 } },
      },
    },
    {
      // 1,000,000 - 200 - 37,916.67 + 32,861.11 - 38,333.33 + 46,000 + 39,800 = 1,042,211.11.
      id: 'settle-termination', covers: ['settlement', 'close'], action: 'clock', to: at('2026-11-18'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 39,800.00 USD into settled cash', cash: { USD: 39_800 } }],
        cash: { account: { USD: { settled: 1_042_211.11, unsettled: 0, availableToTrade: 1_042_211.11, availableToWithdraw: 1_042_211.11 } } },
        pending: [], lifecycle: [], otc: [], alerts: [],
        balance: { account: { cash: 1_042_211.11, receivable: null } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// non_deliverable_swap
// ---------------------------------------------------------------------------------------------
// One-year USD-settled Indian rupee swap: pay 6.40% fixed, receive 6-month MIFOR, both semi-annual ACT/365 on an INR notional
// of 83 rupees per dollar of the USD notional (10,000,000 USD = 830,000,000 INR). Every payment is made in USD at the USD/INR
// fixing two USD business days before the payment date, entered by hand for that date (no service supplies it); nothing is
// ever paid in rupees. Price and marks per 100 of the USD notional. The Terminal has no Mumbai holiday calendar: the USD
// calendar is used for payments and fixings (stated on the contract). Position-level terms: a fixed independent amount of
// 150,000 USD. Commission 20.00 per million; T+2 (USD).
//   period 5 May to 5 November 2026 (184 days): fixed 830,000,000 x 6.40% x 184/365 = 26,778,301.37 INR; floating (MIFOR
//     6.55%) 830,000,000 x 6.55% x 184/365 = 27,405,917.81 INR; the USD/INR fixing of Tue 3 November is not there on Thu
//     5 November: both payments wait; entered by hand as 84.10: 26,778,301.37 / 84.10 = 318,410.24 USD paid,
//     27,405,917.81 / 84.10 = 325,872.98 USD received
//   3,000,000 terminated on Wed 10 February 2027 at 0.15: 4,500.00 received (all-in); settles Fri 12 February
//   period 5 November 2026 to 5 May 2027 (181 days) on 581,000,000 INR: fixed 18,439,189.04 INR; floating (MIFOR 6.30%)
//     18,151,076.71 INR; fixing of Mon 3 May entered in advance as 83.20: 221,624.87 USD paid, 218,161.98 USD received
const NDS_NAME = 'USD-settled INR swap 6.40% v MIFOR6M 5 May 2027';
const nonDeliverableSwap = {
  productId: 'non_deliverable_swap',
  title: 'USD-settled INR swap: legs worked out in rupees and settled in dollars at the USD/INR fixing, entered by hand (one late)',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Settlement currency (non-deliverable)', 'FX fixing lag', 'each leg: Notional factor (rupees per dollar of notional)'],
    automaticInputs: ['payment schedule and the fixing dates (2 USD business days before each payment)', 'MIFOR fixings (rate fixture standing in for Shaffer MarketData)', 'each leg worked out in INR and converted at the fixing', 'settlement date T+2', 'commission', 'fixed independent amount'],
    manualInputs: ['the USD/INR fixing of each fixing date (Data connection, Manual entries, FX rate with its fixing date)', 'upfront and termination amounts (stated fill prices)', 'marks per 100 of the USD notional'],
    settlement: 'Every leg payment in USD on its payment date at the USD/INR fixing of its fixing date; termination amounts and commission T+2 in USD; nothing settles in INR',
    lifecycle: 'Both legs blocked visibly until the late fixing is entered, then paid in USD; partial termination; the second period on the reduced notional with its fixing entered in advance; maturity with collateral returned. The Terminal has no Mumbai calendar: the USD calendar stands in (stated)',
    accounting: 'USD contract: leg payments realized in USD at the fixing; carried at the mark; termination result realized; commission expensed; no INR balance at any time',
    collateral: 'Position-level terms: a fixed independent amount of 150,000 USD posted at entry, returned at maturity; no variation margin',
  },
  start: at('2026-05-01'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix non-deliverable swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'EM rates', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {
    main: {
      productId: 'non_deliverable_swap', name: NDS_NAME, symbol: 'NDS-INR-0527', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'SG', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        effective: '2026-05-05', maturity: '2027-05-05', counterparty: 'Dealer N', settlementCcy: 'USD', fixingLag: 2,
        collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 150_000 }, variationMargin: false },
        legs: [
          { side: 'pay', type: 'fixed', ccy: 'INR', notionalFactor: 83, rate: 0.064, months: 6, dayCount: 'ACT/365' },
          { side: 'receive', type: 'float', ccy: 'INR', notionalFactor: 83, index: 'MIFOR6M', spread: 0, months: 6, dayCount: 'ACT/365' },
        ],
      },
    },
  },
  rates: { MIFOR6M: { currency: 'INR', byDate: { '2026-05-05': 6.55, '2026-11-05': 6.30 } } },
  expectAtStart: usdStart(1_000_000, 2_000_000),
  steps: [
    {
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 10_000_000, as: 'nds', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 10_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-05-05', calendar: 'USD', cash: 0, fees: 200 }],
          cash: { USD: { fees: 200, margin: 150_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000_000, avgPrice: 0 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered as written: 10,000,000 notional of NDS-INR-0527 at 0.00 per 100 notional', owner: 'account', date: '2026-05-01' },
          { type: 'swap.collateral', summary: `Collateral posted on ${NDS_NAME} under its position-level terms: 150,000.00 USD`, cash: { USD: -150_000 } },
        ],
        cash: { account: { USD: { settled: 850_000, unsettled: -200, margin: 150_000, availableToTrade: 849_800, availableToWithdraw: 849_800 } } },
        positions: [{ instrument: 'main', lot: 'nds', owner: 'account', direction: 'as written', qty: 10_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 10_000_000, margin: 150_000 }],
        holdings: { main: { long: 10_000_000, short: 0, net: 10_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-05-05', amount: -200, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-05', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-05-05', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'nds', owner: 'account', qty: 10_000_000, basis: 'position', iaRequired: 150_000, iaPosted: 150_000 }],
        pnl: { account: { realized: 0, commissions: -200, unrealized: 0, total: -200 } },
        nav: { account: 999_800, book: 2_999_800 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 850_000, margin: 150_000, payable: 200, positions: null, assets: 1_000_000, liabilities: 200, netAssets: 999_800 } },
      },
    },
    {
      id: 'mark-at-par', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0, note: 'Dealer N mark per 100 of the USD notional, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'nds', price: 0, value: 0, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 0, markValue: 0 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-05-05'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 200.00 USD from settled cash', cash: { USD: -200 } }],
        cash: { account: { USD: { settled: 849_800, unsettled: 0, availableToTrade: 849_800, availableToWithdraw: 849_800 } } },
        pending: [],
        balance: { account: { cash: 849_800, payable: null, assets: 999_800, liabilities: 0 } },
      },
    },
    {
      // Thu 5 November: both legs are worked out (in INR) but neither can be paid: the USD/INR fixing of Tue 3 November is not there.
      id: 'payments-wait-for-the-fixing', covers: ['missing FX fixing', 'non-deliverable settlement'], action: 'clock', to: at('2026-11-05'),
      expect: {
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-05', status: 'blocked', reason: /Awaiting the USD\/INR settlement fixing of 2026-11-03 for leg A/ },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-05', status: 'blocked', reason: /Awaiting the USD\/INR settlement fixing of 2026-11-03 for leg B/ },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-05-05', status: 'pending' },
        ],
      },
    },
    {
      // Entered by hand: 84.10 rupees per dollar for 3 November. 26,778,301.37 / 84.10 = 318,410.24 paid; 27,405,917.81 / 84.10 = 325,872.98 received.
      id: 'usd-inr-fixing-by-hand', covers: ['missing FX fixing', 'non-deliverable settlement', 'fixed payment', 'floating payment'], action: 'manual_fx', pair: 'USD/INR', rate: 84.10, date: '2026-11-03', note: 'Published USD/INR reference rate, entered by hand',
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${NDS_NAME}, leg A (fixed), period 2026-05-05 to 2026-11-05: 26,778,301.37 INR, settled in USD at the USD/INR fixing of 2026-11-03 (84.1): 318,410.24 USD`, cash: { USD: -318_410.24 }, date: '2026-11-05' },
          { type: 'swap.payment', summary: `Swap receipt on ${NDS_NAME}, leg B (float), period 2026-05-05 to 2026-11-05: 27,405,917.81 INR, settled in USD at the USD/INR fixing of 2026-11-03 (84.1): 325,872.98 USD`, cash: { USD: 325_872.98 }, date: '2026-11-05' },
        ],
        cash: { account: { USD: { settled: 857_262.74, availableToTrade: 857_262.74, availableToWithdraw: 857_262.74 }, INR: null } }, // no rupee balance, ever
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-05-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-05', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-05', status: 'pending' },
        ],
        pnl: { account: { realized: 7_462.74, total: 7_262.74 } },
        nav: { account: 1_007_262.74, book: 3_007_262.74 },
        balance: { account: { cash: 857_262.74, assets: 1_007_262.74, netAssets: 1_007_262.74 } },
      },
    },
    { id: 'february', action: 'clock', to: at('2027-02-10'), expect: {} },
    {
      id: 'mark-before-termination', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.15, note: 'Dealer N mark per 100 of the USD notional, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'nds', price: 0.15, value: 15_000, unrealized: 15_000 }],
        otc: [{ instrument: 'main', mark: 0.15, markValue: 15_000 }],
        pnl: { account: { unrealized: 15_000, total: 22_262.74 } },
        nav: { account: 1_022_262.74, book: 3_022_262.74 },
        balance: { account: { positions: 15_000, assets: 1_022_262.74, netAssets: 1_022_262.74 } },
      },
    },
    {
      // 3,000,000 at 0.15, all-in: 4,500.00 received, realized 4,500.00; commission 60.00. The fixed independent amount stays.
      id: 'partial-termination', covers: ['reduce', 'partial termination'], action: 'close', lot: 'nds', scope: 'strategy', percent: 30, order: { statedPrice: 0.15 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 3_000_000, estimate: 0.15, model: 'stated-price', settleDate: '2027-02-12', cash: 4_500, fees: 60 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 3_000_000, avgPrice: 0.15 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Terminated in part: 3,000,000 of 10,000,000 notional of NDS-INR-0527 at 0.15 per 100 notional (realized 4,500.00 USD)' }],
        cash: { account: { USD: { unsettled: 4_440, availableToTrade: 861_702.74, availableToWithdraw: 857_262.74 } } },
        positions: [{ instrument: 'main', lot: 'nds', qty: 7_000_000, cost: 0, price: 0.15, value: 10_500, unrealized: 10_500, notional: 7_000_000 }],
        holdings: { main: { long: 7_000_000, short: 0, net: 7_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-02-12', amount: 4_440, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 7_000_000, markValue: 10_500, iaRequired: 150_000, iaPosted: 150_000 }],
        pnl: { account: { realized: 11_962.74, commissions: -260, unrealized: 10_500, total: 22_202.74 } },
        nav: { account: 1_022_202.74, book: 3_022_202.74 },
        balance: { account: { receivable: 4_440, positions: 10_500, assets: 1_022_202.74, netAssets: 1_022_202.74 } },
      },
    },
    {
      id: 'settle-termination', covers: 'settlement', action: 'clock', to: at('2027-02-12'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 4,440.00 USD into settled cash', cash: { USD: 4_440 } }],
        cash: { account: { USD: { settled: 861_702.74, unsettled: 0, availableToTrade: 861_702.74, availableToWithdraw: 861_702.74 } } },
        pending: [],
        balance: { account: { cash: 861_702.74, receivable: null } },
      },
    },
    { id: 'fixing-day', action: 'clock', to: at('2027-05-03'), expect: {} },
    { id: 'usd-inr-fixing-in-advance', covers: 'non-deliverable settlement', action: 'manual_fx', pair: 'USD/INR', rate: 83.20, date: '2027-05-03', note: 'Published USD/INR reference rate, entered by hand', expect: {} },
    {
      // 581,000,000 INR: fixed 18,439,189.04 / 83.20 = 221,624.87 paid; floating at 6.30% 18,151,076.71 / 83.20 = 218,161.98 received;
      // then the swap matures and the 150,000 comes back. 1,000,000 - 200 + 7,462.74 + 4,440 - 3,462.89 = 1,008,239.85.
      id: 'second-period-and-maturity', covers: ['non-deliverable settlement', 'fixed payment', 'floating payment', 'maturity', 'collateral'], action: 'clock', to: at('2027-05-05'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${NDS_NAME}, leg A (fixed), period 2026-11-05 to 2027-05-05: 18,439,189.04 INR, settled in USD at the USD/INR fixing of 2027-05-03 (83.2): 221,624.87 USD`, cash: { USD: -221_624.87 } },
          { type: 'swap.payment', summary: `Swap receipt on ${NDS_NAME}, leg B (float), period 2026-11-05 to 2027-05-05: 18,151,076.71 INR, settled in USD at the USD/INR fixing of 2027-05-03 (83.2): 218,161.98 USD`, cash: { USD: 218_161.98 } },
          { type: 'swap.matured', summary: `Swap matured: ${NDS_NAME} (notional 7,000,000)` },
          { type: 'swap.collateral', summary: `Collateral returned on ${NDS_NAME} under its position-level terms: 150,000.00 USD (independent amount, the position ended)`, cash: { USD: 150_000 } },
        ],
        cash: { account: { USD: { settled: 1_008_239.85, margin: 0, availableToTrade: 1_008_239.85, availableToWithdraw: 1_008_239.85 }, INR: null } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pnl: { account: { realized: 8_499.85, commissions: -260, unrealized: 0, total: 8_239.85 } },
        nav: { account: 1_008_239.85, book: 3_008_239.85 },
        balance: { account: { cash: 1_008_239.85, margin: null, positions: null, assets: 1_008_239.85, liabilities: 0, netAssets: 1_008_239.85 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// quanto_swap
// ---------------------------------------------------------------------------------------------
// Six-month quanto equity swap: receive the price return of Kobori Precision Instruments (KOBR, Tokyo Stock Exchange, in
// yen), worked out in yen on the notional at the contract's fixed rate of 0.0068 USD per yen and paid in dollars at that
// same rate; pay 3-month term SOFR + 0.40% quarterly ACT/360 in dollars. USD notional 10,000,000 = 1,470,588,235 yen at
// 0.0068 (whole yen). Resets and payments on the joint USD and Tokyo calendar. Spot USD/JPY moves from 150 to 160 during the
// life: no payment changes (that is the quanto). Position-level terms: independent amount 10% of notional. Commission
// 100.00 per million; T+2 (USD).
//   period 15 June to 15 September: KOBR 4,200 to 4,452 (+6.000%): 1,470,588,235.29 x 6% = 88,235,294 yen x 0.0068 =
//     600,000.00 USD received; financing (4.20% + 0.40%) x 10,000,000 x 92/360 = 117,555.56 paid
//   period 15 September to 15 December: KOBR 4,452 to 4,229.40 (-5.000%): 73,529,412 yen x 0.0068 = 500,000.00 USD paid;
//     financing (4.00% + 0.40%) x 10,000,000 x 91/360 = 111,222.22 paid; maturity
const KOBR = { productId: 'common_stock', name: 'Kobori Precision Instruments K.K.', symbol: 'KOBR', marketView: 'FOREIGN_CASH', venue: 'Tokyo Stock Exchange', venueType: 'exchange', venueCountry: 'JP', issuer: 'Kobori Precision Instruments K.K.', domicile: 'JP', underlyingGeo: 'JP', tradingCcy: 'JPY', terms: {} };
const QS_NAME = 'Quanto equity swap KOBR in USD at 0.0068 v TSFR3M + 0.40% 15 Dec 2026';
const quantoSwap = {
  productId: 'quanto_swap',
  title: 'Quanto equity swap: the return of a Tokyo stock worked out in yen and paid in dollars at a fixed rate, against term SOFR',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'return leg: Reference asset (the Tokyo stock), Quanto currency (JPY), Fixed conversion rate (USD per JPY)'],
    automaticInputs: ['reset and payment schedule on the USD and Tokyo calendars', 'KOBR closes for each reset date (close fixture standing in for Shaffer MarketData)', 'TSFR3M fixings (rate fixture)', 'the return in yen and its conversion at the fixed rate', 'settlement date T+2', 'commission', 'independent amount'],
    manualInputs: ['the reference stock, registered as a Tokyo common stock', 'upfront amount (stated fill price)', 'marks entered by hand'],
    settlement: 'Upfront and commission T+2 on the USD calendar; each leg paid in USD on its payment date',
    lifecycle: 'Return and financing each quarter; the return worked out in yen and converted at the fixed 0.0068, unchanged by the move of spot USD/JPY; maturity with collateral returned',
    accounting: 'USD contract: payments realized in USD; no yen balance; carried at the mark; commission expensed',
    collateral: 'Position-level terms: independent amount 10% of notional posted at entry, returned at maturity; no variation margin',
  },
  start: at('2026-06-11'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix quanto swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Global equity', funding: [{ ccy: 'USD', amount: 3_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.0001, minimum: 0, bps: 0 }, equity: NO_FEE }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {
    kobr: KOBR,
    main: {
      productId: 'quanto_swap', name: QS_NAME, symbol: 'QEQS-KOBR-1226', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'JP', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD+JP' },
      terms: {
        effective: '2026-06-15', maturity: '2026-12-15', counterparty: 'Dealer Q',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.10 }, variationMargin: false },
        legs: [
          { side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: '$inst:kobr', passDividends: false, resetNotional: false, quantoCcy: 'JPY', quantoRate: 0.0068 },
          { side: 'pay', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0.004, months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  fx: { 'USD/JPY': 150 },
  rates: { TSFR3M: { byDate: { '2026-06-15': 4.20, '2026-09-15': 4.00 } } },
  closes: { kobr: { '2026-06-15': 4_200 } },
  expectAtStart: usdStart(3_000_000, 2_000_000),
  steps: [
    {
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 10_000_000, as: 'qs', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 10_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-06-15', calendar: 'USD', cash: 0, fees: 1_000 }],
          cash: { USD: { fees: 1_000, margin: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000_000, avgPrice: 0 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered as written: 10,000,000 notional of QEQS-KOBR-1226 at 0.00 per 100 notional', owner: 'account', date: '2026-06-11' },
          { type: 'swap.collateral', summary: `Collateral posted on ${QS_NAME} under its position-level terms: 1,000,000.00 USD (independent amount, 10.00% of 10,000,000.00 USD notional)`, cash: { USD: -1_000_000 } },
        ],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -1_000, margin: 1_000_000, availableToTrade: 1_999_000, availableToWithdraw: 1_999_000 } } },
        positions: [{ instrument: 'main', lot: 'qs', owner: 'account', direction: 'as written', qty: 10_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 10_000_000, margin: 1_000_000 }],
        holdings: { main: { long: 10_000_000, short: 0, net: 10_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-06-15', amount: -1_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'qs', owner: 'account', qty: 10_000_000, basis: 'position', iaRequired: 1_000_000, iaPosted: 1_000_000 }],
        pnl: { account: { realized: 0, commissions: -1_000, unrealized: 0, total: -1_000 } },
        nav: { account: 2_999_000, book: 4_999_000 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 2_000_000, margin: 1_000_000, payable: 1_000, positions: null, assets: 3_000_000, liabilities: 1_000, netAssets: 2_999_000 } },
      },
    },
    {
      id: 'mark-at-par', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0, note: 'Dealer Q mark, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'qs', price: 0, value: 0, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 0, markValue: 0 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-06-15'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,000.00 USD from settled cash', cash: { USD: -1_000 } }],
        cash: { account: { USD: { settled: 1_999_000, unsettled: 0, availableToTrade: 1_999_000, availableToWithdraw: 1_999_000 } } },
        pending: [],
        balance: { account: { cash: 1_999_000, payable: null, assets: 2_999_000, liabilities: 0 } },
      },
    },
    { id: 'kobr-september-close', covers: 'reset fixing', action: 'close_price', instrument: 'kobr', date: '2026-09-15', value: 4_452, expect: {} },
    {
      // +6.000% on 1,470,588,235 yen = 88,235,294 yen, at the fixed 0.0068 = 600,000.00 USD received; financing 117,555.56 paid.
      // After the close of 15 September (a close exists once the day's close has passed): both legs are paid that day.
      id: 'first-quarter', covers: ['quanto return', 'floating payment'], action: 'clock', to: eod('2026-09-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${QS_NAME}, leg A (return), period 2026-06-15 to 2026-09-15: 600,000.00 USD (worked out in JPY: 88,235,294 JPY, return +6.000% on 1,470,588,235 JPY, converted at the fixed rate 0.0068)`, cash: { USD: 600_000 }, date: '2026-09-15' },
          { type: 'swap.payment', summary: `Swap payment on ${QS_NAME}, leg B (float), period 2026-06-15 to 2026-09-15: 117,555.56 USD`, cash: { USD: -117_555.56 }, date: '2026-09-15' },
        ],
        cash: { account: { USD: { settled: 2_481_444.44, availableToTrade: 2_481_444.44, availableToWithdraw: 2_481_444.44 }, JPY: null } },
        lifecycle: [
          { type: 'swap.maturity', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
        ],
        pnl: { account: { realized: 482_444.44, total: 481_444.44 } },
        nav: { account: 3_481_444.44, book: 5_481_444.44 },
        balance: { account: { cash: 2_481_444.44, assets: 3_481_444.44, netAssets: 3_481_444.44 } },
      },
    },
    // Spot USD/JPY 150 to 160: the Book holds no yen and the swap pays at its fixed rate, so nothing changes.
    { id: 'yen-weakens', covers: 'quanto: spot FX plays no part', action: 'fx_rate', pair: 'USD/JPY', rate: 160, expect: {} },
    { id: 'kobr-december-close', covers: 'reset fixing', action: 'close_price', instrument: 'kobr', date: '2026-12-15', value: 4_229.40, expect: {} },
    {
      // -5.000% on 1,470,588,235 yen = 73,529,412 yen, at 0.0068 = 500,000.00 USD paid; financing 111,222.22 paid; maturity.
      // 3,000,000 - 1,000 + 600,000 - 117,555.56 - 500,000 - 111,222.22 = 2,870,222.22.
      id: 'second-quarter-and-maturity', covers: ['quanto return', 'floating payment', 'maturity', 'collateral'], action: 'clock', to: eod('2026-12-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap payment on ${QS_NAME}, leg A (return), period 2026-09-15 to 2026-12-15: 500,000.00 USD (worked out in JPY: 73,529,412 JPY, return -5.000% on 1,470,588,235 JPY, converted at the fixed rate 0.0068)`, cash: { USD: -500_000 } },
          { type: 'swap.payment', summary: `Swap payment on ${QS_NAME}, leg B (float), period 2026-09-15 to 2026-12-15: 111,222.22 USD`, cash: { USD: -111_222.22 } },
          { type: 'swap.matured', summary: `Swap matured: ${QS_NAME} (notional 10,000,000)` },
          { type: 'swap.collateral', summary: `Collateral returned on ${QS_NAME} under its position-level terms: 1,000,000.00 USD (independent amount, the position ended)`, cash: { USD: 1_000_000 } },
        ],
        cash: { account: { USD: { settled: 2_870_222.22, margin: 0, availableToTrade: 2_870_222.22, availableToWithdraw: 2_870_222.22 }, JPY: null } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pnl: { account: { realized: -128_777.78, commissions: -1_000, unrealized: 0, total: -129_777.78 } },
        nav: { account: 2_870_222.22, book: 4_870_222.22 },
        balance: { account: { cash: 2_870_222.22, margin: null, positions: null, assets: 2_870_222.22, liabilities: 0, netAssets: 2_870_222.22 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// callable_swap
// ---------------------------------------------------------------------------------------------
// Three-year USD swap callable by us: pay 4.10% fixed annual 30/360, receive 3-month Term SOFR quarterly ACT/360, on
// 15,000,000 from Wed 20 May 2026 to Sun 20 May 2029 (paid Mon 21 May). The party entering it as written may end it at no
// cost on 22 February 2027, 20 August 2027 or 22 February 2028; on exercise the amount each leg has accrued since its last
// payment is settled. Position-level terms: variation margin with no threshold and a 25,000 minimum transfer. Commission
// 20.00 per million; T+2 (USD).
//   float receipts: 20 May to 20 August (92 days) at 4.25%: 162,916.67; 20 August to 20 November (92) at 4.10%:
//     157,166.67; 20 November to 20 February (92, paid Mon 22 February) at 3.90%: 149,500.00
//   mark -0.80 on 20 August: -120,000.00: 120,000.00 posted at the end of the day
//   exercise on Fri 20 November refused (not a call date); on Mon 22 February 2027 the counterparty cannot exercise (the
//     call is ours); our exercise settles the fixed leg 20 May 2026 to 22 February 2027 (30/360: 272 days):
//     15,000,000 x 4.10% x 272/360 = 464,666.67 paid, and the float leg 20 to 22 February (2 days) at the 3.70% fixing of
//     19 February: 15,000,000 x 3.70% x 2/360 = 3,083.33 received; the swap ends at 0.00 and the 120,000.00 comes back
//   cash: 2,000,000 - 300 + 162,916.67 + 157,166.67 + 149,500 - 464,666.67 + 3,083.33 = 2,007,700.00
const CS_NAME = 'USD 4.10% v TSFR3M callable swap 20 May 2029';
const callableSwap = {
  productId: 'callable_swap',
  title: 'Callable swap: pay fixed against Term SOFR with a Bermudan right to cancel held by us, exercised by hand on a call date',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Exercise dates (the call dates)', 'Right held by (the side entered as written, or the opposite side)'],
    automaticInputs: ['payment schedule from the contract terms and the USD calendar', 'Term SOFR fixings (rate fixtures standing in for Shaffer MarketData)', 'the amounts accrued on each leg at exercise', 'settlement date T+2', 'commission from the Book fee schedule', 'variation margin from the position-level terms'],
    manualInputs: ['upfront (stated fill price)', 'marks entered by hand', 'the exercise of the call, recorded by hand on the position on a call date (Lifecycle, "Call exercised")'],
    settlement: 'Upfront and commission T+2 on the USD calendar; legs paid on their payment dates; the accrued amounts settled on the exercise date',
    lifecycle: 'Quarterly floating receipts; an exercise on a date that is not a call date refused; the counterparty\'s exercise refused (the call is ours); our exercise on a call date settles the accrued amounts and ends the swap at no cost; nothing scheduled afterwards',
    accounting: 'Carried at the mark less the upfront; leg payments and the accrued amounts settled at exercise realized; commission expensed',
    collateral: 'Position-level terms: variation margin at end of day against the mark, no threshold, 25,000 minimum transfer; returned when the swap ends',
  },
  start: at('2026-05-18'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix callable swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 4_000_000 }],
    account: { name: 'Rates', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {
    main: {
      productId: 'callable_swap', name: CS_NAME, symbol: 'CALL-410-0529', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        effective: '2026-05-20', maturity: '2029-05-20', counterparty: 'Dealer K',
        collateralBasis: { type: 'position', independentAmount: { type: 'none' }, variationMargin: true, threshold: 0, minimumTransfer: 25_000 },
        callRight: { kind: 'call', by: 'written', dates: '2027-02-22; 2027-08-20; 2028-02-22' },
        legs: [
          { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.041, months: 12, dayCount: '30/360' },
          { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  rates: { TSFR3M: { byDate: { '2026-05-20': 4.25, '2026-08-20': 4.10, '2026-11-20': 3.90, '2027-02-19': 3.70 } } },
  expectAtStart: usdStart(2_000_000, 2_000_000),
  steps: [
    {
      id: 'open', covers: ['open'], action: 'ticket', instrument: 'main', side: 'buy', qty: 15_000_000, as: 'cs', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 15_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-05-20', calendar: 'USD', cash: 0, fees: 300 }], // 15,000,000 x 0.00002
          cash: { USD: { fees: 300, margin: 0, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 15_000_000, avgPrice: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Entered as written: 15,000,000 notional of CALL-410-0529 at 0.00 per 100 notional', owner: 'account', date: '2026-05-18' }],
        cash: { account: { USD: { unsettled: -300, availableToTrade: 1_999_700, availableToWithdraw: 1_999_700 } } },
        positions: [{ instrument: 'main', lot: 'cs', owner: 'account', direction: 'as written', qty: 15_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 15_000_000 }],
        holdings: { main: { long: 15_000_000, short: 0, net: 15_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-05-20', amount: -300, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-08-20', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-20', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2029-05-21', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'cs', owner: 'account', qty: 15_000_000, basis: 'position', mark: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -300, unrealized: 0, total: -300 } },
        nav: { account: 1_999_700, book: 3_999_700 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 2_000_000, payable: 300, positions: null, assets: 2_000_000, liabilities: 300, netAssets: 1_999_700 } },
      },
    },
    {
      id: 'mark-at-par', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0, note: 'Dealer K mark, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'cs', price: 0, value: 0, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 0, markValue: 0 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-05-20'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 300.00 USD from settled cash', cash: { USD: -300 } }],
        cash: { account: { USD: { settled: 1_999_700, unsettled: 0, availableToTrade: 1_999_700, availableToWithdraw: 1_999_700 } } },
        pending: [],
        balance: { account: { cash: 1_999_700, payable: null, assets: 1_999_700, liabilities: 0 } },
      },
    },
    {
      // 15,000,000 x 4.25% x 92/360 = 162,916.67 received; the fixed leg pays once a year.
      id: 'first-quarter', covers: 'floating payment', action: 'clock', to: at('2026-08-20'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${CS_NAME}, leg B (float), period 2026-05-20 to 2026-08-20: 162,916.67 USD`, cash: { USD: 162_916.67 }, date: '2026-08-20' }],
        cash: { account: { USD: { settled: 2_162_616.67, availableToTrade: 2_162_616.67, availableToWithdraw: 2_162_616.67 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-11-20', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-20', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2029-05-21', status: 'pending' },
        ],
        pnl: { account: { realized: 162_916.67, total: 162_616.67 } },
        nav: { account: 2_162_616.67, book: 4_162_616.67 },
        balance: { account: { cash: 2_162_616.67, assets: 2_162_616.67, netAssets: 2_162_616.67 } },
      },
    },
    {
      // 15,000,000 x -0.80 / 100 = -120,000.00.
      id: 'mark-lower', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.80, note: 'Dealer K mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cs', price: -0.8, value: -120_000, unrealized: -120_000 }],
        otc: [{ instrument: 'main', mark: -0.8, markValue: -120_000 }],
        pnl: { account: { unrealized: -120_000, total: 42_616.67 } },
        nav: { account: 2_042_616.67, book: 4_042_616.67 },
        balance: { account: { positions: -120_000, assets: 2_042_616.67, netAssets: 2_042_616.67 } },
      },
    },
    {
      // No threshold: the whole 120,000 is called, above the 25,000 minimum transfer.
      id: 'variation-margin-posted', covers: 'variation margin', action: 'clock', to: eod('2026-08-20'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 120,000.00 USD posted. Netting set of 1 position marked at -120,000.00 USD; threshold 0.00 USD.', cash: { USD: -120_000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 2_042_616.67, margin: 120_000, availableToTrade: 2_042_616.67, availableToWithdraw: 2_042_616.67 } } },
        otc: [{ instrument: 'main', vmPosted: 120_000, vmExposure: -120_000, vmStatus: 'ok' }],
        nav: { account: 2_042_616.67 },
        balance: { account: { cash: 2_042_616.67, margin: 120_000, assets: 2_042_616.67, netAssets: 2_042_616.67 } },
      },
    },
    {
      // 15,000,000 x 4.10% x 92/360 = 157,166.67.
      id: 'second-quarter', covers: 'floating payment', action: 'clock', to: at('2026-11-20'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${CS_NAME}, leg B (float), period 2026-08-20 to 2026-11-20: 157,166.67 USD`, cash: { USD: 157_166.67 } }],
        cash: { account: { USD: { settled: 2_199_783.34, availableToTrade: 2_199_783.34, availableToWithdraw: 2_199_783.34 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-02-22', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-20', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2029-05-21', status: 'pending' },
        ],
        pnl: { account: { realized: 320_083.34, total: 199_783.34 } },
        nav: { account: 2_199_783.34, book: 4_199_783.34 },
        balance: { account: { cash: 2_199_783.34, assets: 2_199_783.34, netAssets: 2_199_783.34 } },
      },
    },
    {
      id: 'exercise-off-date-refused', covers: ['call exercise', 'refusal'], action: 'lifecycle', lot: 'cs', body: { action: 'call_exercise', by: 'us' },
      status: 'blocked', reason: 'A Bermudan call: exercise is allowed on the call dates only, and 20 November 2026 is not one.',
      expect: { refused: 'CALL-410-0529 can be called only on its call dates (2027-02-22, 2027-08-20, 2028-02-22); today is 2026-11-20.' },
    },
    {
      // 20 November to 20 February is 92 days (the period ends on the 20th; paid Monday 22nd): 15,000,000 x 3.90% x 92/360.
      id: 'third-quarter', covers: 'floating payment', action: 'clock', to: at('2027-02-22'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${CS_NAME}, leg B (float), period 2026-11-20 to 2027-02-20: 149,500.00 USD`, cash: { USD: 149_500 } }],
        cash: { account: { USD: { settled: 2_349_283.34, availableToTrade: 2_349_283.34, availableToWithdraw: 2_349_283.34 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-20', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-05-20', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2029-05-21', status: 'pending' },
        ],
        pnl: { account: { realized: 469_583.34, total: 349_283.34 } },
        nav: { account: 2_349_283.34, book: 4_349_283.34 },
        balance: { account: { cash: 2_349_283.34, assets: 2_349_283.34, netAssets: 2_349_283.34 } },
      },
    },
    {
      id: 'mark-before-exercise', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.50, note: 'Dealer K mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cs', price: -0.5, value: -75_000, unrealized: -75_000 }],
        otc: [{ instrument: 'main', mark: -0.5, markValue: -75_000, vmPosted: 120_000 }],
        pnl: { account: { unrealized: -75_000, total: 394_283.34 } },
        nav: { account: 2_394_283.34, book: 4_394_283.34 },
        balance: { account: { positions: -75_000, assets: 2_394_283.34, netAssets: 2_394_283.34 } },
      },
    },
    {
      id: 'counterparty-exercise-refused', covers: ['call exercise', 'refusal'], action: 'lifecycle', lot: 'cs', body: { action: 'call_exercise', by: 'counterparty' },
      status: 'blocked', reason: 'The call belongs to the side entered as written (this position): the counterparty holds no right to end the swap.',
      expect: { refused: 'The call on CALL-410-0529 belongs to this position: the counterparty cannot exercise it. Record our own exercise instead.' },
    },
    {
      // Fixed 464,666.67 paid, float 3,083.33 received (see the header); the swap ends at 0.00 against a cost of 0.00; the
      // 120,000.00 posted comes back at once. Realized 162,916.67 + 157,166.67 + 149,500 - 464,666.67 + 3,083.33 = 8,000.00.
      // Cash 1,999,700 + 8,000 = 2,007,700.00.
      id: 'call-exercised', covers: ['call exercise', 'close', 'collateral'], action: 'lifecycle', lot: 'cs', body: { action: 'call_exercise', by: 'us' },
      expect: {
        events: [
          { type: 'swap.exercise', summary: `Call of CALL-410-0529 exercised by us on 2027-02-22, recorded by hand: accrued amounts settled, leg A (fixed) 2026-05-20 to 2027-02-22 paid 464,666.67 USD; leg B (float) 2027-02-20 to 2027-02-22 received 3,083.33 USD`, cash: { USD: -461_583.34 } },
          { type: 'swap.terminated', summary: 'Terminated on the exercise of the call by us: 15,000,000 notional of CALL-410-0529 at 0.00 per 100 notional' },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 120,000.00 USD returned to us. The last position of the netting set ended.', cash: { USD: 120_000 } },
        ],
        cash: { account: { USD: { settled: 2_007_700, margin: 0, unsettled: 0, availableToTrade: 2_007_700, availableToWithdraw: 2_007_700 } } },
        positions: [], holdings: { main: null }, pending: [], lifecycle: [], otc: [],
        pnl: { account: { realized: 8_000, commissions: -300, unrealized: 0, total: 7_700 } },
        nav: { account: 2_007_700, book: 4_007_700 },
        balance: { account: { cash: 2_007_700, margin: null, positions: null, assets: 2_007_700, liabilities: 0, netAssets: 2_007_700 } },
      },
    },
    {
      // Nothing is left to happen: no payment, no collateral, no alert.
      id: 'after-the-exercise', covers: 'close', action: 'clock', to: eod('2027-05-20'),
      expect: { events: [], cash: { account: { USD: { settled: 2_007_700 } } }, positions: [], pending: [], lifecycle: [], otc: [], alerts: [] },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// puttable_swap
// ---------------------------------------------------------------------------------------------
// Five-year USD swap written as pay 3.60% fixed semi-annual 30/360, receive 3-month Term SOFR quarterly ACT/360, on
// 10,000,000 from Mon 15 June 2026; the side entered opposite (the fixed receiver) may put it back at no cost on
// 1 February 2027 or 15 June 2028. We enter the opposite side: we receive the fixed rate, pay Term SOFR and hold the put.
// Position-level terms: independent amount 0.5% of notional; no variation margin. Commission 20.00 per million; T+2 (USD).
//   float paid 15 June to 15 September (92 days) at 4.30%: 10,000,000 x 4.30% x 92/360 = 109,888.89
//   4,000,000 terminated on Thu 15 October at -0.30 (we buy back the opposite side): 4,000,000 x 0.30 / 100 = 12,000.00
//     received (all-in), commission 80.00, settles Mon 19 October; independent amount trued down to 30,000.00
//   Tue 15 December on 6,000,000: fixed 15 June to 15 December (30/360, 180 days) 6,000,000 x 3.60% x 180/360 =
//     108,000.00 received; float 15 September to 15 December (91 days) at 4.15%: 6,000,000 x 4.15% x 91/360 = 62,941.67 paid
//   put exercised by us on Mon 1 February 2027: fixed 15 December to 1 February (30/360, 46 days) 6,000,000 x 3.60% x
//     46/360 = 27,600.00 received; float 15 December to 1 February (48 days) at 3.95%: 6,000,000 x 3.95% x 48/360 =
//     31,600.00 paid; the swap ends at 0.00 and the 30,000.00 comes back
//   cash: 1,000,000 - 200 - 109,888.89 + 11,920 + 108,000 - 62,941.67 + 27,600 - 31,600 = 942,889.44
const PS_NAME = 'USD 3.60% v TSFR3M puttable swap 15 Jun 2031';
const puttableSwap = {
  productId: 'puttable_swap',
  title: 'Puttable swap entered on the opposite side: receive fixed with a Bermudan right to put, partly terminated, put exercised by hand',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Exercise dates (the put dates)', 'Right held by (the opposite side here)'],
    automaticInputs: ['payment schedule from the contract terms and the USD calendar', 'Term SOFR fixings (rate fixtures standing in for Shaffer MarketData)', 'the amounts accrued on each leg at exercise, on the notional left', 'settlement date T+2', 'commission from the Book fee schedule', 'independent amount from the position-level terms, trued to the notional left'],
    manualInputs: ['upfront and termination amounts (stated fill prices)', 'marks entered by hand', 'the exercise of the put, recorded by hand on the position on a put date (Lifecycle, "Put exercised")'],
    settlement: 'Upfront, termination and commission T+2 on the USD calendar; legs paid on their payment dates; the accrued amounts settled on the exercise date',
    lifecycle: 'Floating paid quarterly, fixed received half-yearly; partial termination at a stated amount; the put exercised by the opposite side on a put date in the middle of both periods: accrued amounts settled, swap ended at no cost; nothing scheduled afterwards',
    accounting: 'Carried at the mark less the upfront; leg payments, the termination result and the accrued amounts settled at exercise realized; commission expensed',
    collateral: 'Position-level terms: independent amount 0.5% of notional posted at entry, trued down on the partial termination and returned on exercise',
  },
  start: at('2026-06-11'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix puttable swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Rates', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {
    main: {
      productId: 'puttable_swap', name: PS_NAME, symbol: 'PUT-360-0631', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        effective: '2026-06-15', maturity: '2031-06-15', counterparty: 'Dealer P',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.005 }, variationMargin: false },
        callRight: { kind: 'put', by: 'opposite', dates: '2027-02-01; 2028-06-15' },
        legs: [
          { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.036, months: 6, dayCount: '30/360' },
          { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  rates: { TSFR3M: { byDate: { '2026-06-15': 4.30, '2026-09-15': 4.15, '2026-12-15': 3.95 } } },
  expectAtStart: usdStart(1_000_000, 2_000_000),
  steps: [
    {
      id: 'open-opposite', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'sell', qty: 10_000_000, as: 'ps', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 10_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-06-15', calendar: 'USD', cash: 0, fees: 200 }], // 10,000,000 x 0.00002
          cash: { USD: { fees: 200, margin: 50_000, shortfall: 0 } }, // 0.5% x 10,000,000
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000_000, avgPrice: 0 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered on the opposite side: 10,000,000 notional of PUT-360-0631 at 0.00 per 100 notional', owner: 'account', date: '2026-06-11' },
          { type: 'swap.collateral', summary: `Collateral posted on ${PS_NAME} under its position-level terms: 50,000.00 USD (independent amount, 0.50% of 10,000,000.00 USD notional)`, cash: { USD: -50_000 } },
        ],
        cash: { account: { USD: { settled: 950_000, unsettled: -200, margin: 50_000, availableToTrade: 949_800, availableToWithdraw: 949_800 } } },
        positions: [{ instrument: 'main', lot: 'ps', owner: 'account', direction: 'opposite side', qty: -10_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 10_000_000, margin: 50_000 }],
        holdings: { main: { long: 0, short: 10_000_000, net: -10_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-06-15', amount: -200, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2031-06-16', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'ps', owner: 'account', qty: -10_000_000, basis: 'position', iaRequired: 50_000, iaPosted: 50_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -200, unrealized: 0, total: -200 } },
        nav: { account: 999_800, book: 2_999_800 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 950_000, margin: 50_000, payable: 200, positions: null, assets: 1_000_000, liabilities: 200, netAssets: 999_800 } },
      },
    },
    {
      id: 'mark-at-par', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0, note: 'Dealer P mark, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'ps', price: 0, value: 0, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 0, markValue: 0 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-06-15'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 200.00 USD from settled cash', cash: { USD: -200 } }],
        cash: { account: { USD: { settled: 949_800, unsettled: 0, availableToTrade: 949_800, availableToWithdraw: 949_800 } } },
        pending: [],
        balance: { account: { cash: 949_800, payable: null, assets: 999_800, liabilities: 0 } },
      },
    },
    {
      // We pay the floating leg (opposite side): 10,000,000 x 4.30% x 92/360 = 109,888.89.
      id: 'first-quarter', covers: 'floating payment', action: 'clock', to: at('2026-09-15'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${PS_NAME}, leg B (float), period 2026-06-15 to 2026-09-15: 109,888.89 USD`, cash: { USD: -109_888.89 }, date: '2026-09-15' }],
        cash: { account: { USD: { settled: 839_911.11, availableToTrade: 839_911.11, availableToWithdraw: 839_911.11 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2031-06-16', status: 'pending' },
        ],
        pnl: { account: { realized: -109_888.89, total: -110_088.89 } },
        nav: { account: 889_911.11, book: 2_889_911.11 },
        balance: { account: { cash: 839_911.11, assets: 889_911.11, netAssets: 889_911.11 } },
      },
    },
    { id: 'mid-october', action: 'clock', to: at('2026-10-15'), expect: {} },
    {
      // The written side is marked at -0.30: worth +0.30 to the opposite side: -10,000,000 x -0.30 / 100 = +30,000.
      id: 'mark-before-termination', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.30, note: 'Dealer P mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'ps', price: -0.3, value: 30_000, unrealized: 30_000 }],
        otc: [{ instrument: 'main', mark: -0.3, markValue: 30_000 }],
        pnl: { account: { unrealized: 30_000, total: -80_088.89 } },
        nav: { account: 919_911.11, book: 2_919_911.11 },
        balance: { account: { positions: 30_000, assets: 919_911.11, netAssets: 919_911.11 } },
      },
    },
    {
      // Buy back 4,000,000 at -0.30: 12,000.00 received, commission 80.00; the independent amount on 6,000,000 is 30,000.
      id: 'partial-termination', covers: ['reduce', 'partial termination', 'collateral'], action: 'close', lot: 'ps', scope: 'strategy', percent: 40, order: { statedPrice: -0.30 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4_000_000, estimate: -0.3, model: 'stated-price', settleDate: '2026-10-19', cash: 12_000, fees: 80 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 4_000_000, avgPrice: -0.3 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated in part: 4,000,000 of 10,000,000 notional of PUT-360-0631 at -0.30 per 100 notional (realized 12,000.00 USD)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${PS_NAME} under its position-level terms: 20,000.00 USD (independent amount, 0.50% of 6,000,000.00 USD notional)`, cash: { USD: 20_000 } },
        ],
        cash: { account: { USD: { settled: 859_911.11, unsettled: 11_920, margin: 30_000, availableToTrade: 871_831.11, availableToWithdraw: 859_911.11 } } },
        positions: [{ instrument: 'main', lot: 'ps', qty: -6_000_000, cost: 0, price: -0.3, value: 18_000, unrealized: 18_000, notional: 6_000_000, margin: 30_000 }],
        holdings: { main: { long: 0, short: 6_000_000, net: -6_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-10-19', amount: 11_920, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -6_000_000, iaRequired: 30_000, iaPosted: 30_000, markValue: 18_000 }],
        pnl: { account: { realized: -97_888.89, commissions: -280, unrealized: 18_000, total: -80_168.89 } },
        nav: { account: 919_831.11, book: 2_919_831.11 },
        balance: { account: { cash: 859_911.11, margin: 30_000, receivable: 11_920, positions: 18_000, assets: 919_831.11, liabilities: 0, netAssets: 919_831.11 } },
      },
    },
    {
      id: 'settle-termination', covers: 'settlement', action: 'clock', to: at('2026-10-19'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 11,920.00 USD into settled cash', cash: { USD: 11_920 } }],
        cash: { account: { USD: { settled: 871_831.11, unsettled: 0, availableToTrade: 871_831.11, availableToWithdraw: 871_831.11 } } },
        pending: [],
        balance: { account: { cash: 871_831.11, receivable: null, assets: 919_831.11 } },
      },
    },
    {
      // On 6,000,000: fixed 108,000.00 received, float 62,941.67 paid (see the header).
      id: 'december-payments', covers: ['fixed payment', 'floating payment'], action: 'clock', to: at('2026-12-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${PS_NAME}, leg A (fixed), period 2026-06-15 to 2026-12-15: 108,000.00 USD`, cash: { USD: 108_000 }, date: '2026-12-15' },
          { type: 'swap.payment', summary: `Swap payment on ${PS_NAME}, leg B (float), period 2026-09-15 to 2026-12-15: 62,941.67 USD`, cash: { USD: -62_941.67 }, date: '2026-12-15' },
        ],
        cash: { account: { USD: { settled: 916_889.44, availableToTrade: 916_889.44, availableToWithdraw: 916_889.44 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-03-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-06-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2031-06-16', status: 'pending' },
        ],
        pnl: { account: { realized: -52_830.56, total: -35_110.56 } },
        nav: { account: 964_889.44, book: 2_964_889.44 },
        balance: { account: { cash: 916_889.44, assets: 964_889.44, netAssets: 964_889.44 } },
      },
    },
    { id: 'put-date', action: 'clock', to: at('2027-02-01'), expect: {} },
    {
      // Fixed 27,600.00 received, float 31,600.00 paid (see the header); ended at 0.00 against a cost of 0.00; the 30,000.00
      // independent amount comes back. Realized -52,830.56 + 27,600 - 31,600 = -56,830.56.
      id: 'put-exercised', covers: ['put exercise', 'close', 'collateral'], action: 'lifecycle', lot: 'ps', body: { action: 'put_exercise', by: 'us' },
      expect: {
        events: [
          { type: 'swap.exercise', summary: 'Put of PUT-360-0631 exercised by us on 2027-02-01, recorded by hand: accrued amounts settled, leg A (fixed) 2026-12-15 to 2027-02-01 received 27,600.00 USD; leg B (float) 2026-12-15 to 2027-02-01 paid 31,600.00 USD', cash: { USD: -4_000 } },
          { type: 'swap.terminated', summary: 'Terminated on the exercise of the put by us: 6,000,000 notional of PUT-360-0631 at 0.00 per 100 notional' },
          { type: 'swap.collateral', summary: `Collateral returned on ${PS_NAME} under its position-level terms: 30,000.00 USD (independent amount, the position ended)`, cash: { USD: 30_000 } },
        ],
        cash: { account: { USD: { settled: 942_889.44, margin: 0, unsettled: 0, availableToTrade: 942_889.44, availableToWithdraw: 942_889.44 } } },
        positions: [], holdings: { main: null }, pending: [], lifecycle: [], otc: [],
        pnl: { account: { realized: -56_830.56, commissions: -280, unrealized: 0, total: -57_110.56 } },
        nav: { account: 942_889.44, book: 2_942_889.44 },
        balance: { account: { cash: 942_889.44, margin: null, positions: null, assets: 942_889.44, liabilities: 0, netAssets: 942_889.44 } },
      },
    },
    {
      id: 'after-the-exercise', covers: 'close', action: 'clock', to: eod('2027-03-15'),
      expect: { events: [], cash: { account: { USD: { settled: 942_889.44 } } }, positions: [], pending: [], lifecycle: [], otc: [], alerts: [] },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// equity_basket_swap
// ---------------------------------------------------------------------------------------------
// One-year total-return swap on a custom basket of four US consumer stocks (weights 30/30/25/15, initial level 100.00):
// receive the basket return quarterly on 20,000,000 (notional not reset), pay 3-month Term SOFR + 0.40% quarterly ACT/360,
// from Wed 1 July 2026. No service supplies the composite: its level at each reset is entered by hand on the payment item
// (Accounting, Pending), and the payment waits visibly until it is. Position-level terms: a fixed independent amount of
// 400,000; no variation margin. Commission 10.00 per million; T+2 (USD).
//   1 July to 1 October (92 days): financing (4.20% + 0.40%) x 20,000,000 x 92/360 = 235,111.11 paid; basket 100.00 to
//     103.50 entered by hand: 20,000,000 x (103.50 / 100.00 - 1) = 700,000.00 received
//   1 October to 1 January 2027 (92 days; New Year's Day: paid Mon 4 January, level of Thu 31 December): financing
//     (4.00% + 0.40%) x 20,000,000 x 92/360 = 224,888.89 paid; basket 103.50 to 101.43: 20,000,000 x (101.43 / 103.50 - 1)
//     = 20,000,000 x -2.00% = 400,000.00 paid
//   terminated on Wed 20 January at -0.40: 20,000,000 x 0.40 / 100 = 80,000.00 paid (all-in), settles Fri 22 January
//   cash: 2,000,000 - 200 - 235,111.11 + 700,000 - 224,888.89 - 400,000 - 80,200 = 1,759,600.00
const BASKET = 'HRBR: 0.30; LMNT: 0.30; CDRS: 0.25; PKWY: 0.15';
const EBS_NAME = 'US consumer basket TRS v TSFR3M+0.40% 1 Jul 2027';
const equityBasketSwap = {
  productId: 'equity_basket_swap',
  title: 'Equity basket total-return swap: basket levels entered by hand on each payment item, financing at Term SOFR + 0.40%, terminated',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'return leg: Basket instead of a reference asset (names and weights adding up to 1), Initial basket level', 'financing leg: Index, Spread'],
    automaticInputs: ['payment schedule from the contract terms and the USD calendar', 'Term SOFR fixings (rate fixtures standing in for Shaffer MarketData)', 'the basket return from the levels entered', 'settlement date T+2', 'commission from the Book fee schedule', 'independent amount from the position-level terms'],
    manualInputs: ['the basket level at each reset, entered on the payment item (no service supplies the composite)', 'upfront and termination amounts (stated fill prices)', 'marks entered by hand'],
    settlement: 'Upfront, termination and commission T+2 on the USD calendar; each leg paid on its payment date',
    lifecycle: 'Financing paid each quarter; the basket payment waits for its level (named on the item) and is made once it is entered; the next period starts from that level; a period ending on a holiday is paid the next business day with the level of the business day before; termination at a stated amount',
    accounting: 'Carried at the mark less the upfront; leg payments and the termination result realized; commission expensed',
    collateral: 'Position-level terms: a fixed independent amount of 400,000 posted at entry and returned on termination',
  },
  start: at('2026-06-29'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix equity basket swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 4_000_000 }],
    account: { name: 'Equity derivatives', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.00001, minimum: 0, bps: 0 } }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {
    main: {
      productId: 'equity_basket_swap', name: EBS_NAME, symbol: 'EBS-CONS-0727', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        effective: '2026-07-01', maturity: '2027-07-01', counterparty: 'Dealer E',
        collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 400_000 }, variationMargin: false },
        legs: [
          { side: 'receive', type: 'return', ccy: 'USD', months: 3, basket: BASKET, initialLevel: 100, passDividends: false, resetNotional: false },
          { side: 'pay', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0.004, months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  rates: { TSFR3M: { byDate: { '2026-07-01': 4.20, '2026-10-01': 4.00 } } },
  expectAtStart: usdStart(2_000_000, 2_000_000),
  steps: [
    {
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 20_000_000, as: 'ebs', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 20_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-07-01', calendar: 'USD', cash: 0, fees: 200 }], // 20,000,000 x 0.00001
          cash: { USD: { fees: 200, margin: 400_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20_000_000, avgPrice: 0 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered as written: 20,000,000 notional of EBS-CONS-0727 at 0.00 per 100 notional', owner: 'account', date: '2026-06-29' },
          { type: 'swap.collateral', summary: `Collateral posted on ${EBS_NAME} under its position-level terms: 400,000.00 USD (independent amount, fixed amount for the position)`, cash: { USD: -400_000 } },
        ],
        cash: { account: { USD: { settled: 1_600_000, unsettled: -200, margin: 400_000, availableToTrade: 1_599_800, availableToWithdraw: 1_599_800 } } },
        positions: [{ instrument: 'main', lot: 'ebs', owner: 'account', direction: 'as written', qty: 20_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 20_000_000, margin: 400_000 }],
        holdings: { main: { long: 20_000_000, short: 0, net: 20_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-07-01', amount: -200, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-01', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-01', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-07-01', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'ebs', owner: 'account', qty: 20_000_000, basis: 'position', iaRequired: 400_000, iaPosted: 400_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -200, unrealized: 0, total: -200 } },
        nav: { account: 1_999_800, book: 3_999_800 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_600_000, margin: 400_000, payable: 200, positions: null, assets: 2_000_000, liabilities: 200, netAssets: 1_999_800 } },
      },
    },
    {
      id: 'mark-at-par', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0, note: 'Dealer E mark, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'ebs', price: 0, value: 0, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 0, markValue: 0 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-07-01'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 200.00 USD from settled cash', cash: { USD: -200 } }],
        cash: { account: { USD: { settled: 1_599_800, unsettled: 0, availableToTrade: 1_599_800, availableToWithdraw: 1_599_800 } } },
        pending: [],
        balance: { account: { cash: 1_599_800, payable: null, assets: 1_999_800, liabilities: 0 } },
      },
    },
    {
      // Financing 235,111.11 paid; the basket payment waits for its level.
      id: 'first-quarter-basket-waits', covers: ['financing payment', 'missing basket level'], action: 'clock', to: at('2026-10-01'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${EBS_NAME}, leg B (float), period 2026-07-01 to 2026-10-01: 235,111.11 USD`, cash: { USD: -235_111.11 }, date: '2026-10-01' }],
        cash: { account: { USD: { settled: 1_364_688.89, availableToTrade: 1_364_688.89, availableToWithdraw: 1_364_688.89 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-01', status: 'blocked', reason: /Awaiting the basket level of 2026-10-01 for leg A/ },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-04', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-07-01', status: 'pending' },
        ],
        pnl: { account: { realized: -235_111.11, total: -235_311.11 } },
        nav: { account: 1_764_688.89, book: 3_764_688.89 },
        balance: { account: { cash: 1_364_688.89, assets: 1_764_688.89, netAssets: 1_764_688.89 } },
      },
    },
    {
      // 103.50 entered by hand: 20,000,000 x 3.50% = 700,000.00 received.
      id: 'basket-level-by-hand', covers: ['basket level', 'basket return'], action: 'basket_level', lot: 'ebs', value: 103.50,
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${EBS_NAME}, leg A (return), period 2026-07-01 to 2026-10-01: 700,000.00 USD`, cash: { USD: 700_000 } }],
        cash: { account: { USD: { settled: 2_064_688.89, availableToTrade: 2_064_688.89, availableToWithdraw: 2_064_688.89 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-04', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-04', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-07-01', status: 'pending' },
        ],
        pnl: { account: { realized: 464_888.89, total: 464_688.89 } },
        nav: { account: 2_464_688.89, book: 4_464_688.89 },
        balance: { account: { cash: 2_064_688.89, assets: 2_464_688.89, netAssets: 2_464_688.89 } },
      },
    },
    {
      // New Year's Day: both legs fall due Mon 4 January; financing 224,888.89 paid; the basket waits for the level of 31 December.
      id: 'second-quarter-basket-waits', covers: ['financing payment', 'missing basket level', 'holiday'], action: 'clock', to: at('2027-01-04'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${EBS_NAME}, leg B (float), period 2026-10-01 to 2027-01-01: 224,888.89 USD`, cash: { USD: -224_888.89 } }],
        cash: { account: { USD: { settled: 1_839_800, availableToTrade: 1_839_800, availableToWithdraw: 1_839_800 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-04', status: 'blocked', reason: /Awaiting the basket level of 2026-12-31 for leg A/ },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-07-01', status: 'pending' },
        ],
        pnl: { account: { realized: 240_000, total: 239_800 } },
        nav: { account: 2_239_800, book: 4_239_800 },
        balance: { account: { cash: 1_839_800, assets: 2_239_800, netAssets: 2_239_800 } },
      },
    },
    {
      // 101.43 from 103.50: -2.00% on 20,000,000 = 400,000.00 paid.
      id: 'basket-level-lower', covers: ['basket level', 'basket return'], action: 'basket_level', lot: 'ebs', value: 101.43,
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap payment on ${EBS_NAME}, leg A (return), period 2026-10-01 to 2027-01-01: 400,000.00 USD`, cash: { USD: -400_000 } }],
        cash: { account: { USD: { settled: 1_439_800, availableToTrade: 1_439_800, availableToWithdraw: 1_439_800 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-04-01', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-07-01', status: 'pending' },
        ],
        pnl: { account: { realized: -160_000, total: -160_200 } },
        nav: { account: 1_839_800, book: 3_839_800 },
        balance: { account: { cash: 1_439_800, assets: 1_839_800, netAssets: 1_839_800 } },
      },
    },
    { id: 'late-january', action: 'clock', to: at('2027-01-20'), expect: {} },
    {
      id: 'mark-before-termination', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.40, note: 'Dealer E mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'ebs', price: -0.4, value: -80_000, unrealized: -80_000 }],
        otc: [{ instrument: 'main', mark: -0.4, markValue: -80_000 }],
        pnl: { account: { unrealized: -80_000, total: -240_200 } },
        nav: { account: 1_759_800, book: 3_759_800 },
        balance: { account: { positions: -80_000, assets: 1_759_800, netAssets: 1_759_800 } },
      },
    },
    {
      // 80,000.00 paid, realized -80,000.00 against a cost of 0; commission 200.00; the 400,000 comes back.
      id: 'terminate', covers: ['close', 'full termination', 'collateral'], action: 'close', lot: 'ebs', scope: 'position', percent: 100, order: { statedPrice: -0.40 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 20_000_000, estimate: -0.4, model: 'stated-price', settleDate: '2027-01-22', cash: -80_000, fees: 200 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 20_000_000, avgPrice: -0.4 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated: 20,000,000 notional of EBS-CONS-0727 at -0.40 per 100 notional (realized -80,000.00 USD)' },
          { type: 'swap.collateral', summary: `Collateral returned on ${EBS_NAME} under its position-level terms: 400,000.00 USD (independent amount, the position ended)`, cash: { USD: 400_000 } },
        ],
        cash: { account: { USD: { settled: 1_839_800, unsettled: -80_200, margin: 0, availableToTrade: 1_759_600, availableToWithdraw: 1_759_600 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2027-01-22', amount: -80_200, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -240_000, commissions: -400, unrealized: 0, total: -240_400 } },
        nav: { account: 1_759_600, book: 3_759_600 },
        balance: { account: { cash: 1_839_800, margin: null, positions: null, payable: 80_200, assets: 1_839_800, liabilities: 80_200, netAssets: 1_759_600 } },
      },
    },
    {
      // 2,000,000 - 200 - 235,111.11 + 700,000 - 224,888.89 - 400,000 - 80,200 = 1,759,600.00.
      id: 'settle-termination', covers: ['settlement', 'close'], action: 'clock', to: at('2027-01-22'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 80,200.00 USD from settled cash', cash: { USD: -80_200 } }],
        cash: { account: { USD: { settled: 1_759_600, unsettled: 0, availableToTrade: 1_759_600, availableToWithdraw: 1_759_600 } } },
        pending: [], lifecycle: [], otc: [], alerts: [],
        balance: { account: { cash: 1_759_600, payable: null, assets: 1_759_600, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// loan_trs
// ---------------------------------------------------------------------------------------------
// One-year total-return swap on 10,000,000 of the Tamberlane Foods Term Loan B (a leveraged loan registered in the bond
// family, never traded here): receive the loan's price return quarterly, pay 3-month Term SOFR + 1.50% quarterly ACT/360,
// from Wed 15 July 2026. The loan's closes for the reset dates are fixtures standing in for Shaffer MarketData; its interest
// and principal repayments are passed through by hand on the position (Lifecycle, "Loan pass-through") on the day the loan
// pays them: no service publishes a loan's cash flows. Position-level terms: independent amount 10% of notional.
// Commission 50.00 per million; T+2 (USD).
//   Wed 30 September, the loan's quarterly payment: interest 1.85 per 100: 10,000,000 x 1.85 / 100 = 185,000.00 received;
//     2% of the loan repaid at par: 200,000 of the swap leaves at 100.00 against the starting close 97.50:
//     200,000 x (100 / 97.50 - 1) = 5,128.21 received, with its financing 15 July to 30 September (77 days) at 4.25% + 1.50%:
//     200,000 x 5.75% x 77/360 = 2,459.72 paid; the notional falls to 9,800,000
//   15 July to 15 October (92 days) on 9,800,000: return 97.50 to 98.20: 9,800,000 x (98.20 / 97.50 - 1) = 70,358.97
//     received; financing 9,800,000 x 5.75% x 92/360 = 144,005.56 paid
//   terminated on Mon 16 November at 0.50: 9,800,000 x 0.50 / 100 = 49,000.00 received (all-in), commission 490.00
//   cash: 3,000,000 - 500 + 185,000 + 5,128.21 - 2,459.72 + 70,358.97 - 144,005.56 + 48,510 = 3,162,031.90
const TMBR = { productId: 'leveraged_loan', name: 'Tamberlane Foods Term Loan B due 15-Jan-2031', symbol: 'TMBR-TLB-31', marketView: 'US_CASH', venueType: 'otc', issuer: 'Tamberlane Foods Holdings LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
  conventions: { settleLag: 7 },
  terms: { couponType: 'float', referenceRate: 'TSOFR3M', spread: 0.0325, currentCoupon: 0.074, frequency: 4, maturity: '2031-01-15', issueDate: '2024-01-15', dayCount: 'ACT/360', redemption: 100, factor: 1, minDenomination: 1_000, seniority: 'Senior secured first lien (B / B2)', tradingDocs: 'par' } };
const LTRS_NAME = 'TMBR TLB total-return swap v TSFR3M+1.50% 15 Jul 2027';
const loanTrs = {
  productId: 'loan_trs',
  title: 'Loan total-return swap: price return on a term loan, its interest and a repayment passed through by hand, terminated',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'return leg: Leg type "Return on a reference asset", Reference asset (the loan, registered as a leveraged loan)', 'financing leg: Index, Spread'],
    automaticInputs: ['payment schedule from the contract terms and the USD calendar', 'the loan\'s closes for the reset dates (close fixtures standing in for Shaffer MarketData)', 'Term SOFR fixings (rate fixtures)', 'the financing accrued on a repaid part', 'settlement date T+2', 'commission from the Book fee schedule', 'independent amount from the position-level terms'],
    manualInputs: ['the reference loan, registered as a leveraged loan', 'each interest payment of the loan, passed through by hand (per 100 of notional)', 'each principal repayment of the loan, passed through by hand (share repaid, price)', 'upfront and termination amounts (stated fill prices)', 'marks entered by hand'],
    settlement: 'Upfront, termination and commission T+2 on the USD calendar; legs paid on their payment dates; pass-throughs settled the day they are recorded',
    lifecycle: 'The loan\'s interest passed through; a 2% repayment at par passed through with its return and the financing accrued on it, the notional falling to 9,800,000; the quarterly return and financing on the notional left; termination at a stated amount',
    accounting: 'Carried at the mark less the upfront; pass-throughs, leg payments and the termination result realized; commission expensed',
    collateral: 'Position-level terms: independent amount 10% of notional posted at entry, returned on termination',
  },
  start: at('2026-07-13'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix loan TRS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Credit', funding: [{ ccy: 'USD', amount: 3_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.00005, minimum: 0, bps: 0 }, bond: NO_FEE }, fill: FILL, settlement: { swap: 2 } },
  },
  instruments: {
    loan: TMBR,
    main: {
      productId: 'loan_trs', name: LTRS_NAME, symbol: 'LTRS-TMBR-0727', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        effective: '2026-07-15', maturity: '2027-07-15', counterparty: 'Dealer L',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.10 }, variationMargin: false },
        legs: [
          { side: 'receive', type: 'return', ccy: 'USD', months: 3, underlyingId: '$inst:loan', passDividends: false, resetNotional: false },
          { side: 'pay', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0.015, months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  closes: { loan: { '2026-07-15': 97.50, '2026-10-15': 98.20 } },
  rates: { TSFR3M: { byDate: { '2026-07-15': 4.25, '2026-10-15': 4.05 } } },
  expectAtStart: usdStart(3_000_000, 2_000_000),
  steps: [
    {
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 10_000_000, as: 'ltrs', order: { statedPrice: 0 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 10_000_000, estimate: 0, model: 'stated-price', settleDate: '2026-07-15', calendar: 'USD', cash: 0, fees: 500 }], // 10,000,000 x 0.00005
          cash: { USD: { fees: 500, margin: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000_000, avgPrice: 0 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Entered as written: 10,000,000 notional of LTRS-TMBR-0727 at 0.00 per 100 notional', owner: 'account', date: '2026-07-13' },
          { type: 'swap.collateral', summary: `Collateral posted on ${LTRS_NAME} under its position-level terms: 1,000,000.00 USD (independent amount, 10.00% of 10,000,000.00 USD notional)`, cash: { USD: -1_000_000 } },
        ],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -500, margin: 1_000_000, availableToTrade: 1_999_500, availableToWithdraw: 1_999_500 } } },
        positions: [{ instrument: 'main', lot: 'ltrs', owner: 'account', direction: 'as written', qty: 10_000_000, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, notional: 10_000_000, margin: 1_000_000 }],
        holdings: { main: { long: 10_000_000, short: 0, net: 10_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-07-15', amount: -500, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-10-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-07-15', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'ltrs', owner: 'account', qty: 10_000_000, basis: 'position', iaRequired: 1_000_000, iaPosted: 1_000_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -500, unrealized: 0, total: -500 } },
        nav: { account: 2_999_500, book: 4_999_500 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 2_000_000, margin: 1_000_000, payable: 500, positions: null, assets: 3_000_000, liabilities: 500, netAssets: 2_999_500 } },
      },
    },
    {
      id: 'mark-at-par', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0, note: 'Dealer L mark, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'ltrs', price: 0, value: 0, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 0, markValue: 0 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-commission', covers: 'settlement', action: 'clock', to: at('2026-07-15'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 500.00 USD from settled cash', cash: { USD: -500 } }],
        cash: { account: { USD: { settled: 1_999_500, unsettled: 0, availableToTrade: 1_999_500, availableToWithdraw: 1_999_500 } } },
        pending: [],
        balance: { account: { cash: 1_999_500, payable: null, assets: 2_999_500, liabilities: 0 } },
      },
    },
    { id: 'loan-payment-date', action: 'clock', to: at('2026-09-30'), expect: {} },
    {
      // 10,000,000 x 1.85 / 100 = 185,000.00 received.
      id: 'interest-passed-through', covers: ['interest pass-through'], action: 'lifecycle', lot: 'ltrs', body: { action: 'pass_through', kind: 'interest', amount: 1.85, note: 'TMBR TLB quarterly interest' },
      expect: {
        events: [{ type: 'swap.pass_through', summary: 'Interest of TMBR-TLB-31 passed through on LTRS-TMBR-0727, recorded by hand (TMBR TLB quarterly interest): 1.85 per 100 of 10,000,000.00 USD, received 185,000.00 USD', cash: { USD: 185_000 } }],
        cash: { account: { USD: { settled: 2_184_500, availableToTrade: 2_184_500, availableToWithdraw: 2_184_500 } } },
        pnl: { account: { realized: 185_000, total: 184_500 } },
        nav: { account: 3_184_500, book: 5_184_500 },
        balance: { account: { cash: 2_184_500, assets: 3_184_500, netAssets: 3_184_500 } },
      },
    },
    {
      // 2% repaid at par: return 5,128.21 received, financing 2,459.72 paid on the 200,000 (see the header): net 2,668.49;
      // the independent amount on 9,800,000 is 980,000: 20,000 comes back.
      id: 'repayment-passed-through', covers: ['principal pass-through'], action: 'lifecycle', lot: 'ltrs', body: { action: 'pass_through', kind: 'principal', share: 0.02, price: 100, note: 'TMBR TLB scheduled amortization' },
      expect: {
        events: [
          { type: 'swap.pass_through', summary: 'Principal of TMBR-TLB-31 repaid and passed through on LTRS-TMBR-0727, recorded by hand (TMBR TLB scheduled amortization): 2.00% of the notional, 200,000.00 USD, at 100 against the last fixing 97.5: return received 5,128.21 USD; leg B (float) accrued 2026-07-15 to 2026-09-30 on it paid 2,459.72 USD; cost of the repaid part 0.00 USD realized; the notional falls to 9,800,000.00 USD', cash: { USD: 2_668.49 } },
          { type: 'swap.collateral', summary: `Collateral returned on ${LTRS_NAME} under its position-level terms: 20,000.00 USD (independent amount, 10.00% of 9,800,000.00 USD notional)`, cash: { USD: 20_000 } },
        ],
        cash: { account: { USD: { settled: 2_207_168.49, margin: 980_000, availableToTrade: 2_207_168.49, availableToWithdraw: 2_207_168.49 } } },
        otc: [{ instrument: 'main', qty: 9_800_000, iaRequired: 980_000, iaPosted: 980_000 }],
        positions: [{ instrument: 'main', lot: 'ltrs', qty: 9_800_000, cost: 0, price: 0, value: 0, notional: 9_800_000 }],
        holdings: { main: { long: 9_800_000, short: 0, net: 9_800_000 } },
        pnl: { account: { realized: 187_668.49, total: 187_168.49 } },
        nav: { account: 3_187_168.49, book: 5_187_168.49 },
        balance: { account: { cash: 2_207_168.49, margin: 980_000, assets: 3_187_168.49, netAssets: 3_187_168.49 } },
      },
    },
    {
      // On 9,800,000: return 70,358.97 received, financing 144,005.56 paid (see the header); the close of 15 October is known
      // after the market closes.
      id: 'first-quarter', covers: ['loan return', 'financing payment'], action: 'clock', to: eod('2026-10-15'),
      expect: {
        events: [
          { type: 'swap.payment', summary: `Swap receipt on ${LTRS_NAME}, leg A (return), period 2026-07-15 to 2026-10-15: 70,358.97 USD`, cash: { USD: 70_358.97 } },
          { type: 'swap.payment', summary: `Swap payment on ${LTRS_NAME}, leg B (float), period 2026-07-15 to 2026-10-15: 144,005.56 USD`, cash: { USD: -144_005.56 } },
        ],
        cash: { account: { USD: { settled: 2_133_521.90, availableToTrade: 2_133_521.90, availableToWithdraw: 2_133_521.90 } } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2027-01-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2027-07-15', status: 'pending' },
        ],
        pnl: { account: { realized: 114_021.90, total: 113_521.90 } },
        nav: { account: 3_113_521.90, book: 5_113_521.90 },
        balance: { account: { cash: 2_133_521.90, assets: 3_113_521.90, netAssets: 3_113_521.90 } },
      },
    },
    { id: 'mid-november', action: 'clock', to: at('2026-11-16'), expect: {} },
    {
      id: 'mark-before-termination', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.50, note: 'Dealer L mark, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'ltrs', price: 0.5, value: 49_000, unrealized: 49_000 }],
        otc: [{ instrument: 'main', mark: 0.5, markValue: 49_000 }],
        pnl: { account: { unrealized: 49_000, total: 162_521.90 } },
        nav: { account: 3_162_521.90, book: 5_162_521.90 },
        balance: { account: { positions: 49_000, assets: 3_162_521.90, netAssets: 3_162_521.90 } },
      },
    },
    {
      // 49,000.00 received, commission 490.00, settles Wed 18 November; the independent amount comes back.
      id: 'terminate', covers: ['close', 'full termination', 'collateral'], action: 'close', lot: 'ltrs', scope: 'position', percent: 100, order: { statedPrice: 0.50 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 9_800_000, estimate: 0.5, model: 'stated-price', settleDate: '2026-11-18', cash: 49_000, fees: 490 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 9_800_000, avgPrice: 0.5 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Terminated: 9,800,000 notional of LTRS-TMBR-0727 at 0.50 per 100 notional (realized 49,000.00 USD)' },
          { type: 'swap.collateral', summary: /^Collateral returned on .* under its position-level terms: 980,000.00 USD \(independent amount, the position ended\)$/, cash: { USD: 980_000 } },
        ],
        cash: { account: { USD: { settled: 3_113_521.90, unsettled: 48_510, margin: 0, availableToTrade: 3_162_031.90, availableToWithdraw: 3_113_521.90 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-11-18', amount: 48_510, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 163_021.90, commissions: -990, unrealized: 0, total: 162_031.90 } },
        nav: { account: 3_162_031.90, book: 5_162_031.90 },
        balance: { account: { cash: 3_113_521.90, margin: null, positions: null, receivable: 48_510, assets: 3_162_031.90, liabilities: 0, netAssets: 3_162_031.90 } },
      },
    },
    {
      id: 'settle-termination', covers: ['settlement', 'close'], action: 'clock', to: at('2026-11-18'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 48,510.00 USD into settled cash', cash: { USD: 48_510 } }],
        cash: { account: { USD: { settled: 3_162_031.90, unsettled: 0, availableToTrade: 3_162_031.90, availableToWithdraw: 3_162_031.90 } } },
        pending: [], lifecycle: [], otc: [], alerts: [],
        balance: { account: { cash: 3_162_031.90, receivable: null, assets: 3_162_031.90 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// asset_swap
// ---------------------------------------------------------------------------------------------
// Par asset swap package, bought on Thu 13 August 2026 for settlement Mon 17 August: 5,000,000 face of the Brightwater
// Utilities 4.50% notes of 15 June 2029 (semi-annual 30/360) at the quoted ask of 96.25, and a swap on the same notional
// from 17 August to 15 June 2029: pay the bond's 4.50% (semi-annual 30/360 on the bond's coupon dates, short first period
// to 15 December), receive 3-month Term SOFR + 1.80% quarterly ACT/360 (short first period to 15 September). The swap's
// upfront is 100 less the bond's dirty price, so the package costs par: accrued 15 June to 17 August (62 days of 30/360)
// 4.50% x 62/360 = 0.775; dirty 97.025; upfront 2.975 per 100 = 148,750.00 paid. Both are legs of one package
// (Strategies page, custom template, two instrument legs); each is closed on its own position. Swap position-level terms:
// a fixed independent amount of 50,000; no variation margin. Swap commission 20.00 per million; bonds free; T+2.
//   bond: 5,000,000 x 96.25 / 100 = 4,812,500.00 + accrued 5,000,000 x 0.775% = 38,750.00 = 4,851,250.00
//   15 September: float 17 August to 15 September (29 days) at 4.20% + 1.80%: 5,000,000 x 6.00% x 29/360 = 24,166.67
//   15 December: bond coupon 5,000,000 x 4.50% / 2 = 112,500.00 (38,750.00 of it bought); swap fixed 17 August to
//     15 December (118 days of 30/360): 5,000,000 x 4.50% x 118/360 = 73,750.00 paid; float 15 September to 15 December
//     (91 days) at 4.10% + 1.80%: 5,000,000 x 5.90% x 91/360 = 74,569.44 received
//   Wed 20 January 2027: bond sold at the bid of 97.10: 4,855,000.00 + accrued 15 December to 22 January (37 days)
//     5,000,000 x 4.50% x 37/360 = 23,125.00; swap terminated at -0.60: 30,000.00 paid, commission 100.00
//   cash: 6,000,000 - 5,000,100 + 24,166.67 + 112,500 - 73,750 + 74,569.44 + 4,878,125 - 30,100 = 5,985,411.11
const BWU = { productId: 'corporate_bond', name: 'Brightwater Utilities 4.50% Notes 15-Jun-2029', symbol: 'BWU-4.5-JUN29', marketView: 'US_CASH', venueType: 'otc', issuer: 'Brightwater Utilities Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
  terms: { couponType: 'fixed', couponRate: 0.045, frequency: 2, maturity: '2029-06-15', issueDate: '2024-06-15', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured' } };
const ASW_NAME = 'BWU 4.50% 2029 par asset swap TSFR3M+1.80%';
const assetSwap = {
  productId: 'asset_swap',
  title: 'Par asset swap: the bond and the swap bought as one package at par, coupons and swap legs, each leg closed on its own',
  matrix: {
    ticket: 'Strategies page, custom template: two instrument legs (Add a leg): the bond (Quantity, at the quoted ask) and the swap registered first in the registry (Notional, State a fill price: the upfront); the strategy instance for each position\'s Close',
    requiredFields: ['bond: registered as a corporate bond (coupon, frequency, day count, maturity)', 'swap: Effective date (the bond\'s settlement date), Maturity (the bond\'s), fixed leg at the bond coupon on the bond\'s dates, floating leg Index and Spread, Collateral basis', 'each leg: Side, Quantity or Notional; the swap leg: State a fill price (100 less the bond\'s dirty price)'],
    automaticInputs: ['bond price from its quote (fixture standing in for Shaffer MarketData)', 'bond accrued interest at settlement', 'swap payment schedule (short first periods) on the USD calendar', 'Term SOFR fixings (rate fixtures)', 'bond coupon', 'settlement dates T+2', 'commission from the Book fee schedule', 'swap independent amount'],
    manualInputs: ['the swap upfront, worked out by hand as 100 less the dirty price', 'marks of the swap entered by hand'],
    settlement: 'Bond purchase and sale with accrued interest, swap upfront and termination amounts and commission, all T+2 on the USD calendar; swap legs on their payment dates',
    lifecycle: 'Float stub received; bond coupon received and swap fixed stub paid on the same day; floating received; the bond sold at the bid and the swap terminated at a stated amount, each on its own position',
    accounting: 'Bond at clean cost with accrued interest as income; the swap at its upfront cost, carried at the mark; swap legs realized; both closing results realized; commission expensed',
    collateral: 'Swap position-level terms: a fixed independent amount of 50,000 posted at entry and returned on termination; none for the long bond',
  },
  start: at('2026-08-13'),
  settlementCheck: false,
  book: {
    name: 'Matrix asset swap', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 8_000_000 }],
    account: { name: 'Credit', funding: [{ ccy: 'USD', amount: 6_000_000 }] },
    settings: { fees: { swap: { perUnit: 0.00002, minimum: 0, bps: 0 }, bond: NO_FEE }, fill: FILL, settlement: { swap: 2, bond: 2 } },
  },
  instruments: {
    bond: BWU,
    main: {
      productId: 'asset_swap', name: ASW_NAME, symbol: 'ASW-BWU-0629', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        effective: '2026-08-17', maturity: '2029-06-15', counterparty: 'Dealer A',
        collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 50_000 }, variationMargin: false },
        legs: [
          { side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.045, months: 6, dayCount: '30/360' },
          { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0.018, months: 3, dayCount: 'ACT/360' },
        ],
      },
    },
  },
  quotes: { bond: { bid: 96.05, ask: 96.25, last: 96.25, bidSize: 20_000_000, askSize: 20_000_000 } },
  rates: { TSFR3M: { byDate: { '2026-08-17': 4.20, '2026-09-15': 4.10, '2026-12-15': 3.95 } } },
  expectAtStart: usdStart(6_000_000, 2_000_000),
  steps: [
    {
      id: 'open-package', covers: ['open', 'package', 'collateral'], action: 'package', as: 'asw', instrument: 'main',
      input: { template: 'custom', origin: 'strategy_page', legs: [
        { kind: 'trade', action: 'buy', purpose: 'primary', role: 'leg', instrumentId: '$inst:bond', qty: 5_000_000, orderType: 'market' },
        { kind: 'trade', action: 'buy', purpose: 'primary', role: 'leg', instrumentId: '$inst:main', qty: 5_000_000, orderType: 'market', statedPrice: 2.975 },
      ] },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'bond', qty: 5_000_000, estimate: 96.25, model: 'quoted-bid-ask', settleDate: '2026-08-17', gross: 4_812_500, accrued: 38_750, cash: -4_851_250, fees: 0 },
            { kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 2.975, model: 'stated-price', settleDate: '2026-08-17', cash: -148_750, fees: 100 },
          ],
          cash: { USD: { fees: 100, margin: 50_000, shortfall: 0 } },
        },
        result: { status: 'open' },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 5,000,000 BWU-4.5-JUN29 @ 96.25 USD', owner: 'account', date: '2026-08-13' },
          { type: 'trade.fill', summary: 'Entered as written: 5,000,000 notional of ASW-BWU-0629 at 2.975 per 100 notional', owner: 'account', date: '2026-08-13' },
          { type: 'swap.collateral', summary: `Collateral posted on ${ASW_NAME} under its position-level terms: 50,000.00 USD (independent amount, fixed amount for the position)`, cash: { USD: -50_000 } },
        ],
        cash: { account: { USD: { settled: 5_950_000, unsettled: -5_000_100, margin: 50_000, availableToTrade: 949_900 } } },
        positions: [
          { instrument: 'bond', lot: 'asw', owner: 'account', direction: 'long', qty: 5_000_000, avgCost: 96.25, cost: 4_812_500, price: 96.25, value: 4_812_500, unrealized: 0, accrued: 38_750 },
          { instrument: 'main', lot: 'asw', owner: 'account', direction: 'as written', qty: 5_000_000, avgCost: 2.975, cost: 148_750, price: null, value: null, unrealized: null, provisional: true, notional: 5_000_000, margin: 50_000 },
        ],
        pending: [
          { instrument: 'bond', owner: 'account', dueDate: '2026-08-17', amount: -4_851_250, ccy: 'USD', into: 'cash' },
          { instrument: 'main', owner: 'account', dueDate: '2026-08-17', amount: -148_850, ccy: 'USD', into: 'cash' },
        ],
        holdings: { bond: { long: 5_000_000, short: 0, net: 5_000_000 }, main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        lifecycle: [
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-09-15', status: 'pending' },
          { type: 'bond.coupon', instrument: 'bond', dueDate: '2026-12-15', status: 'pending' },
          { type: 'swap.payment', instrument: 'main', dueDate: '2026-12-15', status: 'pending' },
          { type: 'bond.maturity', instrument: 'bond', dueDate: '2029-06-15', status: 'pending' },
          { type: 'swap.maturity', instrument: 'main', dueDate: '2029-06-15', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'asw', owner: 'account', qty: 5_000_000, basis: 'position', mark: null, iaRequired: 50_000, iaPosted: 50_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, couponInterest: 0, commissions: -100, unrealized: 0, total: -100 } },
        nav: { account: 5_999_900, book: 7_999_900 },
        provisional: { account: true, book: true },
        // Positions: the bond at 4,812,500 and the swap carried at its upfront cost until it is marked.
        balance: { account: { cash: 5_950_000, margin: 50_000, accruedIncome: 38_750, positions: 4_961_250, payable: 5_000_100, assets: 11_000_000, liabilities: 5_000_100, netAssets: 5_999_900 } },
      },
    },
    {
      id: 'mark-swap', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 2.975, note: 'Dealer A mark, by hand',
      expect: {
        positions: [{ instrument: 'bond', lot: 'asw' }, { instrument: 'main', lot: 'asw', price: 2.975, value: 148_750, unrealized: 0, provisional: false }],
        otc: [{ instrument: 'main', mark: 2.975, markValue: 148_750 }],
        provisional: { account: false, book: false },
      },
    },
    {
      id: 'settle-package', covers: 'settlement', action: 'clock', to: at('2026-08-17'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 4,851,250.00 USD from settled cash', cash: { USD: -4_851_250 } },
          { type: 'settlement.pay', summary: 'paid 148,850.00 USD from settled cash', cash: { USD: -148_850 } },
        ],
        cash: { account: { USD: { settled: 949_900, unsettled: 0, availableToTrade: 949_900, availableToWithdraw: 949_900 } } },
        pending: [],
        balance: { account: { cash: 949_900, payable: null, assets: 5_999_900, liabilities: 0 } },
      },
    },
    {
      // Float 17 August to 15 September: 24,166.67 received (see the header).
      id: 'float-stub', covers: 'floating payment', action: 'clock', to: at('2026-09-15'),
      expect: {
        events: [{ type: 'swap.payment', summary: `Swap receipt on ${ASW_NAME}, leg B (float), period 2026-08-17 to 2026-09-15: 24,166.67 USD`, cash: { USD: 24_166.67 } }],
        cash: { account: { USD: { settled: 974_066.67, availableToTrade: 974_066.67, availableToWithdraw: 974_066.67 } } },
      },
    },
    {
      // Bond coupon 112,500.00; fixed stub 73,750.00 paid; float 74,569.44 received (see the header).
      id: 'december-coupon-and-legs', covers: ['coupon', 'fixed payment', 'floating payment'], action: 'clock', to: at('2026-12-15'),
      expect: {
        events: [],
        cash: { account: { USD: { settled: 1_087_386.11, availableToTrade: 1_087_386.11, availableToWithdraw: 1_087_386.11 } } },
      },
    },
  ],
};

export default [dividendSwap, cmsSpreadSwap, nonDeliverableSwap, quantoSwap, callableSwap, puttableSwap, equityBasketSwap, loanTrs, assetSwap];
