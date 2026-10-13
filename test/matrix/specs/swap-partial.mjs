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

export default [dividendSwap, cmsSpreadSwap, nonDeliverableSwap, quantoSwap];
