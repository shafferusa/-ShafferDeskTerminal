// Credit derivatives (engine family "cds"): single-name, sovereign and index credit default swaps, credit baskets, index
// tranches, loan and ABS credit default swaps. One scenario per product, each on its own fictional contract registered
// as exactly that product, with the coupon, dates, credit events, settlement terms and collateral terms a real contract
// of it has. s3, 2026-10-13.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec, with the arithmetic in a
// comment beside it. Nothing here is copied from what the Terminal prints.
//
// The Terminal's rules these scenarios rely on (server/products/credit.js), restated so the arithmetic can be followed:
//   - Quantity is the notional; price is the upfront per 100 of notional outstanding, paid by the protection buyer
//     (negative when the buyer receives it). "Buy protection" pays the running premium, "Sell protection" receives it.
//     A position is terminated by trading the other way at a stated upfront (the settlement amount agreed with the dealer).
//   - Outstanding notional = notional x factor (index factor, tranche outstanding share, ABS reference factor; 1 otherwise).
//     Upfront, premium, mark value and a percentage independent amount are on the outstanding notional.
//   - Standard convention (SNAC/STEC): fixed coupon (25, 100, 300, 500, 750 or 1000 bp); roll dates the IMM 20ths, each
//     coupon date moved to the next business day of the payment calendar; an accrual period runs from one adjusted coupon
//     date (included) to the next (excluded), the last one to maturity included; ACT/360. Every coupon is a full coupon:
//     a trade exchanges the premium accrued from the start of the period to the step-in date (trade date + 1 calendar
//     day), the protection seller paying the buyer, with the upfront and on its settlement date. The buyer carries what it
//     received as owed back (accrued expense) until the coupon; a seller carries what it paid as accrued income.
//   - Bespoke convention: periods from the effective date to the IMM 20ths after it (first period a short stub, or a long
//     stub to the second roll date), accrual dates not adjusted, premium of a new position from its trade date; nothing
//     is exchanged at trade.
//   - Credit event, recorded by hand on the contract (instrument form, Lifecycle events recorded by hand): only a credit
//     event the terms name; recovery = the auction final price (or a stated recovery); protection = affected notional x
//     (1 - recovery) to the buyer; the buyer pays the premium accrued on the affected notional from the start of the
//     current period to the event date (included under the standard convention, excluded under the bespoke one); the
//     position's cost on the affected part is realized. Physical settlement only where the terms say so: simulated on
//     paper, the obligation delivered against par and taken as bought (buyer) or sold (seller) at the final price.
//   - Collateral follows the basis the contract states: an independent amount posted in cash when the position opens and
//     trued up when the outstanding notional changes; variation margin in the 17:00 New York end-of-day pass against the
//     mark value (notional outstanding x mark / 100): received (restricted cash and a liability) above the threshold,
//     posted below minus the threshold, nothing moved below the minimum transfer amount.
//   - Commission is the Book's fee schedule for credit default swaps: an amount per unit of notional.
//   - Marks are entered by hand (a dealer's upfront per 100) and labelled Manual entry: the Terminal values nothing itself.

export const family = 'cds';

const dst = (date) => (date >= '2026-03-08' && date < '2026-11-01') || (date >= '2027-03-14' && date < '2027-11-07') || (date >= '2028-03-12' && date < '2028-11-05');
/** 10:00 New York as a UTC instant. */
const at = (date, hhmm) => `${date}T${hhmm || (dst(date) ? '14:00' : '15:00')}:00.000Z`;
/** 17:30 New York: after the 17:00 end-of-day pass. */
const eod = (date) => at(date, dst(date) ? '21:30' : '22:30');

const FILL = { halfSpreadBps: { cds: 0, equity: 0, bond: 0, swap: 0 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const NO_FEE = { perUnit: 0, minimum: 0, bps: 0 };

const OTC_TICKET = {
  ticket: 'Registry form (Instruments, New instrument) for the contract: reference entity, coupon, dates, premium convention, credit events, settlement after a credit event, product terms and the required Collateral terms group; then the instrument drawer, Trade tab (Buy protection / Sell protection, Notional, State a fill price); the strategy instance for increase, termination and roll; the instrument form, Lifecycle events recorded by hand, for credit events and the other events of the reference',
  requiredFields: ['Reference entity or index', 'Running coupon', 'Maturity', 'Premium convention', 'Credit events', 'Settlement after a credit event', 'Collateral basis', 'Trading owner', 'Action', 'Notional', 'State a fill price (the upfront per 100 agreed with the dealer: no executable quote exists)'],
};
const otcTicket = ({ instrument, side, qty, upfront, ...rest }) => ({ action: 'ticket', instrument, side, qty, order: { statedPrice: upfront }, ...rest });

// ---------------------------------------------------------------------------------------------
// cds_single_name
// ---------------------------------------------------------------------------------------------
// Five-year standard contract on Halvorsen Freight Lines Inc. (senior unsecured), 100 bp, maturity 20 June 2031, North
// American corporate terms without restructuring (credit events: bankruptcy, failure to pay), settled at the auction
// final price. Dealer K; position-level collateral terms: independent amount 1% of notional, variation margin with no
// threshold and a 10,000 minimum transfer. Commission 20.00 per million; upfront and accrued settle T+3 (USD calendar).
//
// Dates: the period containing 7 April 2026 runs from Friday 20 March to 20 June, a Saturday, so to Monday 22 June
// (94 days); the next to 20 September, a Sunday, so Monday 21 September.
//   bought 10,000,000 on Tue 7 April at 1.40: step-in 8 April, accrued 20 March to 8 April = 19 days
//     10,000,000 x 1% x 19/360 = 5,277.78 received; upfront 140,000.00 paid; settles Fri 10 April
//   increased by 5,000,000 on Tue 14 April at 1.60: step-in 15 April, 26 days: 5,000,000 x 1% x 26/360 = 3,611.11
//     received; upfront 80,000.00; settles Fri 17 April
//   coupon Mon 22 June: 15,000,000 x 1% x 94/360 = 39,166.67 paid; the 8,888.89 received at trade is settled with it,
//     so the premium cost is 30,277.78 = 10,000,000 x 75/360 x 1% (8 April to 22 June) + 5,000,000 x 68/360 x 1%
//   40% terminated on Wed 15 July at 0.90: 6,000,000 x 0.90 / 100 = 54,000.00 received; step-in 16 July, 24 days:
//     6,000,000 x 1% x 24/360 = 4,000.00 paid, the premium for the time the 6,000,000 was held: realized at once;
//     settles Mon 20 July
//   failure to pay on Thu 27 August, auction final price 32.5 recorded on Tue 15 September, settling Fri 18 September:
//     protection 9,000,000 x (1 - 0.325) = 6,075,000.00; accrued premium 22 June to 27 August included = 67 days:
//     9,000,000 x 1% x 67/360 = 16,750.00; net receivable 6,058,250.00
const HFL_NAME = 'Halvorsen Freight Lines 5Y CDS 100bp 20 Jun 2031';
const cdsSingleName = {
  productId: 'cds_single_name',
  title: 'Standard five-year single-name CDS, 100 bp, bought, increased, partly terminated, then a failure to pay settled at the auction final price',
  matrix: {
    ...OTC_TICKET,
    automaticInputs: ['coupon dates from the IMM roll dates and the USD payment calendar', 'premium accrued to the step-in date, exchanged at trade', 'full quarterly coupon on the outstanding notional', 'settlement date T+3 on the USD calendar', 'commission from the Book fee schedule', 'independent amount and variation margin from the position-level terms', 'premium accrued to the credit event date, protection amount, release of collateral when the contract ends'],
    manualInputs: ['upfront of each trade (stated fill price)', 'marks per 100 entered by hand (dealer)', 'credit event: kind (from the contract\'s credit events), event date, auction final price, settlement date'],
    settlement: 'Upfront, accrued premium and commission settle T+3 on the USD calendar; coupons in cash on the adjusted coupon date; the credit event settlement on the stated auction settlement date',
    lifecycle: 'Open, increase, partial termination at a stated upfront; quarterly full coupon; restructuring refused (not a credit event under these terms); physical settlement refused (auction terms); failure to pay with the auction final price ends the contract; nothing scheduled afterwards; a trade on the ended contract refused',
    accounting: 'Carried at the mark (upfront per 100 x outstanding notional) less the upfronts paid; accrued premium received at trade carried as owed back until the coupon; coupons, termination results and the credit event settlement are realized P&L; commission expensed; unpriced until a mark is entered',
    collateral: 'Position-level terms: independent amount 1% of notional posted at entry, trued up on increase and termination, returned when the contract ends; variation margin at end of day on the mark, no threshold, 10,000 minimum transfer; collateral received is restricted cash with a liability, returned at the end',
  },
  start: at('2026-04-07'),
  settlementCheck: { lag: 3, holidays: [] },
  book: {
    name: 'Matrix single-name CDS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Credit', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { cds: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { cds: 3 } }, // 20.00 per million of notional
  },
  instruments: {
    main: {
      productId: 'cds_single_name', name: HFL_NAME, symbol: 'HFL-CDS-0631', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        referenceEntity: 'Halvorsen Freight Lines Inc.', seniority: 'Senior unsecured', coupon: 0.01, effective: '2026-03-20', maturity: '2031-06-20', recovery: 0.4,
        convention: 'standard', creditEventSet: 'corporate_xr', settlement: 'auction', counterparty: 'Dealer K',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.01 }, variationMargin: true, threshold: 0, minimumTransfer: 10_000 },
      },
    },
  },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 2_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 2_000_000, availableToWithdraw: 2_000_000 } },
      treasury: { USD: { settled: 3_000_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 2_000_000, treasury: 3_000_000, book: 5_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    otcTicket({
      id: 'buy-protection', covers: ['open', 'buy protection', 'accrued at trade', 'collateral'], instrument: 'main', side: 'buy', qty: 10_000_000, upfront: 1.40, as: 'cds',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 10_000_000, estimate: 1.4, model: 'stated-price', settleDate: '2026-04-10', calendar: 'USD',
            cash: -134_722.22, // -10,000,000 x 1.40 / 100 + 5,277.78 accrued received
            accrued: -5_277.78, // accrued premium, received by the buyer (negative: not paid)
            fees: 200 }], // 10,000,000 x 0.00002
          cash: { USD: { fees: 200, margin: 100_000, available: 2_000_000, shortfall: 0 } }, // independent amount 1% x 10,000,000
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000_000, avgPrice: 1.4, fills: [{ qty: 10_000_000, price: 1.4, model: 'stated-price', settleDate: '2026-04-10' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 10,000,000 HFL-CDS-0631 @ 1.40 USD; premium accrued from 2026-03-20 to the step-in date 2026-04-08 (19 days), 5,277.78 USD, received from the counterparty with the settlement', owner: 'account', date: '2026-04-07' },
          { type: 'cds.accrued', summary: 'Premium accrued since the last coupon date, received at trade on HFL-CDS-0631: 5,277.78 USD carried as owed back with the next coupon' },
          { type: 'cds.collateral', summary: `Collateral posted on ${HFL_NAME} under its position-level terms: 100,000.00 USD (independent amount, 1.00% of 10,000,000.00 USD notional)`, cash: { USD: -100_000 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 1_900_000, unsettled: -134_922.22, margin: 100_000, availableToTrade: 1_765_077.78, availableToWithdraw: 1_765_077.78 } } }, // 2,000,000 - 100,000; -134,722.22 - 200
        positions: [{ instrument: 'main', lot: 'cds', owner: 'account', direction: 'protection bought', qty: 10_000_000, avgCost: 1.4, cost: 140_000, price: null, value: null, unrealized: null, provisional: true, notional: 10_000_000, margin: 100_000, accrued: -5_277.78 }],
        holdings: { main: { long: 10_000_000, short: 0, net: 10_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-10', amount: -134_922.22, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-06-22', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2031-06-20', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'cds', owner: 'account', qty: 10_000_000, basis: 'position', mark: null, iaRequired: 100_000, iaPosted: 100_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -200, fees: 0, unrealized: 0, total: -200 } },
        nav: { account: 1_999_800, book: 4_999_800 }, // the position at its cost while it has no mark
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_900_000, margin: 100_000, positions: 140_000, payable: 134_922.22, accruedExpense: 5_277.78, assets: 2_140_000, liabilities: 140_200, netAssets: 1_999_800 } },
      },
    }),
    {
      id: 'mark-at-trade', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 1.40, note: 'Dealer K upfront per 100, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cds', price: 1.4, value: 140_000, unrealized: 0, provisional: false, priceSource: 'Manual entry' }], // 10,000,000 x 1.40 / 100
        otc: [{ instrument: 'main', mark: 1.4, markValue: 140_000 }],
        provisional: { account: false, book: false },
      },
    },
    {
      // The contract is worth +140,000 to the protection buyer: Dealer K posts all of it (no threshold).
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-04-07'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 140,000.00 USD received. Netting set of 1 position marked at 140,000.00 USD; threshold 0.00 USD.', owner: 'account', date: '2026-04-07' }],
        cash: { account: { USD: { restricted: 140_000 } } },
        otc: [{ instrument: 'main', vmPosted: 0, vmHeld: 140_000, vmExposure: 140_000, vmStatus: 'ok' }],
        balance: { account: { restricted: 140_000, collateralReceived: 140_000, assets: 2_280_000, liabilities: 280_200, netAssets: 1_999_800 } },
      },
    },
    { id: 'wednesday', action: 'clock', to: at('2026-04-08'), expect: {} },
    {
      id: 'spread-widens', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 1.55, note: 'Dealer K upfront per 100, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cds', price: 1.55, value: 155_000, unrealized: 15_000 }], // 10,000,000 x 1.55 / 100
        otc: [{ instrument: 'main', mark: 1.55, markValue: 155_000 }],
        pnl: { account: { unrealized: 15_000, total: 14_800 } },
        nav: { account: 2_014_800, book: 5_014_800 },
        balance: { account: { positions: 155_000, assets: 2_295_000, netAssets: 2_014_800 } },
      },
    },
    {
      // 155,000 required, 140,000 held: 15,000 more, above the 10,000 minimum transfer.
      id: 'variation-margin-topped-up', covers: 'variation margin', action: 'clock', to: eod('2026-04-08'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 15,000.00 USD received. Netting set of 1 position marked at 155,000.00 USD; threshold 0.00 USD.', owner: 'account' }],
        cash: { account: { USD: { restricted: 155_000 } } },
        otc: [{ instrument: 'main', vmHeld: 155_000, vmExposure: 155_000 }],
        balance: { account: { restricted: 155_000, collateralReceived: 155_000, assets: 2_310_000, liabilities: 295_200 } },
      },
    },
    {
      id: 'settle-upfront', covers: 'settlement', action: 'clock', to: at('2026-04-10'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 134,922.22 USD from settled cash', cash: { USD: -134_922.22 }, date: '2026-04-10' }],
        cash: { account: { USD: { settled: 1_765_077.78, unsettled: 0, availableToTrade: 1_765_077.78, availableToWithdraw: 1_765_077.78 } } },
        pending: [],
        balance: { account: { cash: 1_765_077.78, payable: null, assets: 2_175_077.78, liabilities: 160_277.78 } }, // 5,277.78 + 155,000
      },
    },
    { id: 'tuesday-14-april', action: 'clock', to: at('2026-04-14'), expect: {} },
    {
      // 10,000,000 to 15,000,000 at a stated 1.60: upfront 80,000.00; accrued 3,611.11 received (26 days to 15 April).
      id: 'increase', covers: ['increase', 'accrued at trade', 'collateral'], action: 'resize', lot: 'cds', factor: 1.5, order: { statedPrice: 1.60 },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 1.6, model: 'stated-price', settleDate: '2026-04-17',
            cash: -76_388.89, // -80,000 + 3,611.11
            accrued: -3_611.11,
            fees: 100 }],
          cash: { USD: { fees: 100, margin: 50_000, shortfall: 0 } }, // 1% x 15,000,000 = 150,000, less the 100,000 posted
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 5_000_000, avgPrice: 1.6, fills: [{ qty: 5_000_000, price: 1.6, model: 'stated-price', settleDate: '2026-04-17' }] }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 5,000,000 HFL-CDS-0631 @ 1.60 USD; premium accrued from 2026-03-20 to the step-in date 2026-04-15 (26 days), 3,611.11 USD, received from the counterparty with the settlement' },
          { type: 'cds.accrued', summary: '3,611.11 USD carried as owed back with the next coupon' },
          { type: 'cds.collateral', summary: `Collateral posted on ${HFL_NAME} under its position-level terms: 50,000.00 USD (independent amount, 1.00% of 15,000,000.00 USD notional)`, cash: { USD: -50_000 } },
        ],
        cash: { account: { USD: { settled: 1_715_077.78, unsettled: -76_488.89, margin: 150_000, availableToTrade: 1_638_588.89, availableToWithdraw: 1_638_588.89 } } },
        positions: [{ instrument: 'main', lot: 'cds', qty: 15_000_000, cost: 220_000, avgCost: 1.4666667, // 220,000 / (15,000,000 / 100)
          price: 1.55, value: 232_500, unrealized: 12_500, notional: 15_000_000, margin: 150_000, accrued: -8_888.89 }], // 5,277.78 + 3,611.11
        holdings: { main: { long: 15_000_000, short: 0, net: 15_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-17', amount: -76_488.89, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 15_000_000, markValue: 232_500, iaRequired: 150_000, iaPosted: 150_000 }],
        pnl: { account: { commissions: -300, unrealized: 12_500, total: 12_200 } },
        nav: { account: 2_012_200, book: 5_012_200 },
        balance: { account: { cash: 1_715_077.78, margin: 150_000, positions: 232_500, payable: 76_488.89, accruedExpense: 8_888.89, assets: 2_252_577.78, liabilities: 240_377.78, netAssets: 2_012_200 } },
      },
    },
    {
      id: 'variation-margin-on-the-increase', covers: 'variation margin', action: 'clock', to: eod('2026-04-14'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 77,500.00 USD received. Netting set of 1 position marked at 232,500.00 USD; threshold 0.00 USD.' }], // 232,500 - 155,000
        cash: { account: { USD: { restricted: 232_500 } } },
        otc: [{ instrument: 'main', vmHeld: 232_500, vmExposure: 232_500 }],
        balance: { account: { restricted: 232_500, collateralReceived: 232_500, assets: 2_330_077.78, liabilities: 317_877.78 } },
      },
    },
    {
      id: 'settle-increase', covers: 'settlement', action: 'clock', to: at('2026-04-17'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 76,488.89 USD from settled cash', cash: { USD: -76_488.89 } }],
        cash: { account: { USD: { settled: 1_638_588.89, unsettled: 0, availableToTrade: 1_638_588.89, availableToWithdraw: 1_638_588.89 } } },
        pending: [],
        balance: { account: { cash: 1_638_588.89, payable: null, assets: 2_253_588.89, liabilities: 241_388.89 } },
      },
    },
    {
      // Monday 22 June (20 June is a Saturday): the full coupon for 20 March to 21 June, 94 days, on 15,000,000.
      id: 'first-coupon', covers: ['premium', 'payment across a weekend roll date'], action: 'clock', to: at('2026-06-22'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium paid on ${HFL_NAME} for 2026-03-20 to 2026-06-21 included (94 days on 15,000,000.00 USD): 39,166.67 USD; the accrued premium of 8,888.89 USD exchanged at trade is settled with it`, cash: { USD: -39_166.67 }, owner: 'account', date: '2026-06-22' }],
        cash: { account: { USD: { settled: 1_599_422.22, availableToTrade: 1_599_422.22, availableToWithdraw: 1_599_422.22 } } },
        positions: [{ instrument: 'main', lot: 'cds', accrued: 0 }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-09-21', status: 'pending' }, // 20 September is a Sunday
          { type: 'cds.maturity', instrument: 'main', dueDate: '2031-06-20', status: 'pending' },
        ],
        pnl: { account: { realized: -30_277.78, total: -18_077.78 } }, // 39,166.67 - 8,888.89; then -300 + 12,500
        nav: { account: 1_981_922.22, book: 4_981_922.22 },
        balance: { account: { cash: 1_599_422.22, accruedExpense: null, assets: 2_214_422.22, liabilities: 232_500, netAssets: 1_981_922.22 } },
      },
    },
    { id: 'mid-july', action: 'clock', to: at('2026-07-15'), expect: {} },
    {
      id: 'spread-tightens', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.90, note: 'Dealer K upfront per 100, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cds', price: 0.9, value: 135_000, unrealized: -85_000 }], // 15,000,000 x 0.90 / 100, less 220,000
        otc: [{ instrument: 'main', mark: 0.9, markValue: 135_000 }],
        pnl: { account: { unrealized: -85_000, total: -115_577.78 } },
        nav: { account: 1_884_422.22, book: 4_884_422.22 },
        balance: { account: { positions: 135_000, assets: 2_116_922.22, netAssets: 1_884_422.22 } },
      },
    },
    {
      // 6,000,000 terminated at 0.90: 54,000.00 received; cost out 220,000 x 6/15 = 88,000.00; realized -34,000.00.
      // Accrued 22 June to the step-in date 16 July, 24 days, paid: 6,000,000 x 1% x 24/360 = 4,000.00, premium for the time
      // the terminated part was held: realized with the termination (nothing is carried to the next coupon). Settles Mon 20 July.
      id: 'partial-termination', covers: ['reduce', 'partial termination', 'accrued at trade', 'collateral'], action: 'close', lot: 'cds', scope: 'strategy', percent: 40, order: { statedPrice: 0.90 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 6_000_000, estimate: 0.9, model: 'stated-price', settleDate: '2026-07-20', cash: 50_000, accrued: -4_000, fees: 120 }] }, // 54,000 - 4,000 accrued paid by the closing buyer; 6,000,000 x 0.00002
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 6_000_000, avgPrice: 0.9 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 6,000,000 HFL-CDS-0631 @ 0.90 USD (realized -34,000.00 USD); premium accrued from 2026-06-22 to the step-in date 2026-07-16 (24 days), 4,000.00 USD, paid to the counterparty with the settlement' },
          { type: 'cds.accrued', summary: 'Premium accrued on the 6,000,000 terminated on HFL-CDS-0631, 4,000.00 USD, paid with the termination: realized as premium for the time it was held' },
          { type: 'cds.collateral', summary: `Collateral returned on ${HFL_NAME} under its position-level terms: 60,000.00 USD (independent amount, 1.00% of 9,000,000.00 USD notional)`, cash: { USD: 60_000 } },
        ],
        cash: { account: { USD: { settled: 1_659_422.22, unsettled: 49_880, margin: 90_000, availableToTrade: 1_709_302.22, availableToWithdraw: 1_659_422.22 } } }, // 50,000 - 120
        positions: [{ instrument: 'main', lot: 'cds', qty: 9_000_000, cost: 132_000, avgCost: 1.4666667, price: 0.9, value: 81_000, unrealized: -51_000, notional: 9_000_000, margin: 90_000, accrued: 0 }],
        holdings: { main: { long: 9_000_000, short: 0, net: 9_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-07-20', amount: 49_880, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 9_000_000, markValue: 81_000, iaRequired: 90_000, iaPosted: 90_000 }],
        pnl: { account: { realized: -68_277.78, commissions: -420, unrealized: -51_000, total: -119_697.78 } }, // -30,277.78 - 34,000 - 4,000
        nav: { account: 1_880_302.22, book: 4_880_302.22 },
        balance: { account: { cash: 1_659_422.22, margin: 90_000, receivable: 49_880, positions: 81_000, assets: 2_112_802.22, liabilities: 232_500, netAssets: 1_880_302.22 } },
      },
    },
    {
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-07-15'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 151,500.00 USD returned to the counterparty. Netting set of 1 position marked at 81,000.00 USD; threshold 0.00 USD.' }], // 232,500 - 81,000
        cash: { account: { USD: { restricted: 81_000 } } },
        otc: [{ instrument: 'main', vmHeld: 81_000, vmExposure: 81_000 }],
        balance: { account: { restricted: 81_000, collateralReceived: 81_000, assets: 1_961_302.22, liabilities: 81_000 } },
      },
    },
    {
      id: 'settle-partial-termination', covers: 'settlement', action: 'clock', to: at('2026-07-20'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 49,880.00 USD into settled cash', cash: { USD: 49_880 } }],
        cash: { account: { USD: { settled: 1_709_302.22, unsettled: 0, availableToTrade: 1_709_302.22, availableToWithdraw: 1_709_302.22 } } },
        pending: [],
        balance: { account: { cash: 1_709_302.22, receivable: null } },
      },
    },
    {
      id: 'restructuring-not-a-credit-event', covers: 'credit event', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'credit_event', eventType: 'restructuring', recovery: 0.4 },
      status: 'blocked', reason: 'North American corporate terms without restructuring: restructuring is not one of the contract\'s credit events.',
      expect: { refused: { engine: 'Restructuring is not a credit event under the terms of HFL-CDS-0631. Its credit events: Bankruptcy, Failure to pay.', api: 'Restructuring is not a credit event under the terms of HFL-CDS-0631', browser: '"Kind of credit event" does not offer "restructuring" for HFL-CDS-0631: it offers Bankruptcy, Failure to pay.' } },
    },
    {
      id: 'physical-settlement-refused', covers: ['credit event', 'physical settlement'], action: 'instrument_lifecycle', instrument: 'main', body: { action: 'credit_event', eventType: 'failure_to_pay', recovery: 0.325, settlement: 'physical' },
      status: 'blocked', reason: 'The contract settles at the auction final price; physical settlement is not one of its settlement methods.',
      expect: { refused: { engine: 'HFL-CDS-0631 does not settle physically: its terms settle in cash at the auction final price.', api: 'HFL-CDS-0631 does not settle physically', browser: '"Settled by" does not offer "physical" for HFL-CDS-0631' } },
    },
    { id: 'auction-day', action: 'clock', to: at('2026-09-15'), expect: {} },
    {
      // Failure to pay on 27 August; auction final price 32.5 (recovery 0.325); auction settlement Friday 18 September.
      // Protection 9,000,000 x 0.675 = 6,075,000.00; accrued premium 22 June to 27 August included, 67 days:
      // 9,000,000 x 1% x 67/360 = 16,750.00; receivable 6,058,250.00. The cost left, 132,000, is realized with it:
      // 6,058,250 - 132,000 = 5,926,250.00 realized.
      id: 'failure-to-pay', covers: ['credit event', 'cash settlement', 'collateral'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'credit_event', eventType: 'failure_to_pay', eventDate: '2026-08-27', recovery: 0.325, settlement: 'auction', settleDate: '2026-09-18' },
      expect: {
        events: [
          { type: 'cds.credit_event', summary: 'Failure to pay of Halvorsen Freight Lines Inc. on 2026-08-27 recorded by hand for HFL-CDS-0631, auction final price 32.500%; protection 6,075,000.00 USD (9,000,000.00 USD x 67.500%); accrued premium 16,750.00 USD; receivable 6,058,250.00 USD on 2026-09-18', owner: 'account', date: '2026-09-15' },
          { type: 'cds.terminated', summary: 'HFL-CDS-0631 ended for this position: credit event of Halvorsen Freight Lines Inc., settled' },
          { type: 'cds.collateral', summary: `Collateral returned on ${HFL_NAME} under its position-level terms: 90,000.00 USD (independent amount, the position ended)`, cash: { USD: 90_000 } },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 81,000.00 USD returned to the counterparty. The last position of the netting set ended.' },
        ],
        cash: { account: { USD: { settled: 1_799_302.22, unsettled: 6_058_250, margin: 0, restricted: 0, availableToTrade: 7_857_552.22, availableToWithdraw: 1_799_302.22 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-09-18', amount: 6_058_250, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 5_857_972.22, commissions: -420, unrealized: 0, total: 5_857_552.22 } }, // -68,277.78 + 5,926,250
        nav: { account: 7_857_552.22, book: 10_857_552.22 },
        balance: { account: { cash: 1_799_302.22, receivable: 6_058_250, margin: null, restricted: null, collateralReceived: null, positions: null, assets: 7_857_552.22, liabilities: 0, netAssets: 7_857_552.22 } },
      },
    },
    {
      id: 'settle-credit-event', covers: 'settlement', action: 'clock', to: at('2026-09-18'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 6,058,250.00 USD into settled cash', cash: { USD: 6_058_250 } }],
        cash: { account: { USD: { settled: 7_857_552.22, unsettled: 0, availableToTrade: 7_857_552.22, availableToWithdraw: 7_857_552.22 } } },
        pending: [],
        balance: { account: { cash: 7_857_552.22, receivable: null } },
      },
    },
    otcTicket({
      id: 'ended-contract-not-traded', covers: 'open', instrument: 'main', side: 'buy', qty: 1_000_000, upfront: 50,
      status: 'blocked', reason: 'The contract ended with the credit event: nothing can be traded on it.',
      expect: { refused: 'HFL-CDS-0631 has ended (2026-08-27: credit event of Halvorsen Freight Lines Inc., settled). It cannot be traded.' },
    }),
    {
      // The next coupon date passes: nothing is paid or scheduled. 2,000,000 - 134,922.22 - 76,488.89 - 39,166.67 + 49,880 + 6,058,250 = 7,857,552.22.
      id: 'nothing-left', covers: 'close', action: 'clock', to: at('2026-09-21'),
      expect: { events: [], positions: [], pending: [], lifecycle: [], otc: [], alerts: [], cash: { account: { USD: { settled: 7_857_552.22, margin: 0, restricted: 0 } } } },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// cds_sovereign
// ---------------------------------------------------------------------------------------------
// One-year standard contract on the Republic of Valmora (a euro-area sovereign), in euros, 100 bp, maturity 20 June 2027,
// Western European sovereign terms: credit events failure to pay, repudiation/moratorium, restructuring and obligation
// acceleration; no bankruptcy (a sovereign is not a company). Settled at the auction final price. TARGET calendar for
// settlement (T+3) and coupons. The spread is tight: the upfront is negative (the protection buyer receives it).
// Protection is SOLD, under a collateral agreement recorded first: CSA Dealer M, variation margin in EUR cash, no
// threshold, 25,000 EUR minimum transfer, no independent amount. Book reporting currency USD: EUR/USD 1.10, then 1.12.
//
// Dates (Monday 21 September 2026 opens the period: 20 September is a Sunday; the coupon dates are Monday 21 December
// 2026, Monday 22 March 2027 (20 March is a Saturday), and maturity, Sunday 20 June 2027, paid Monday 21 June):
//   sold 10,000,000 on Tue 6 October 2026 at -0.60: we pay 10,000,000 x 0.60 / 100 = 60,000.00 and the accrued premium
//     from 21 September to the step-in date 7 October, 16 days: 10,000,000 x 1% x 16/360 = 4,444.44; settles Fri 9 October
//   coupon 21 December: 10,000,000 x 1% x 91/360 = 25,277.78 received; less the 4,444.44 paid at trade: 20,833.34
//   4,000,000 bought back on Wed 23 December at -0.45: 4,000,000 x 0.45 / 100 = 18,000.00 received and 3 days of accrued
//     (to the step-in date 24 December): 4,000,000 x 1% x 3/360 = 333.33 received; settles Tue 29 December, T+3 across the
//     TARGET Christmas holiday (25 December; 26 December is a Saturday)
//   coupon 22 March 2027: 6,000,000 x 1% x 91/360 = 15,166.67; last period 22 March to 20 June included (to 21 June),
//     91 days: 15,166.67 on 21 June, then the contract matures. Good Friday and Easter Monday (26 and 29 March) pass.
const VALM_NAME = 'Republic of Valmora 1Y CDS 100bp 20 Jun 2027 (EUR)';
const VALM_DRAFT = {
  productId: 'cds_sovereign', name: VALM_NAME, symbol: 'VALM-CDS-0627', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'GB', tradingCcy: 'EUR', multiplier: 0.01,
  conventions: { tradingCalendar: 'TARGET', settlementCalendar: 'TARGET', paymentCalendar: 'TARGET' },
  terms: {
    referenceEntity: 'Republic of Valmora', seniority: 'Senior unsecured (sovereign)', coupon: 0.01, effective: '2026-09-21', maturity: '2027-06-20', recovery: 0.4,
    convention: 'standard', creditEventSet: 'sovereign', settlement: 'auction', counterparty: 'Dealer M',
    collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' },
  },
};
const cdsSovereign = {
  productId: 'cds_sovereign',
  title: 'Euro-area sovereign CDS in EUR, protection sold under a CSA, USD reporting, partly bought back across Christmas, run to maturity',
  matrix: {
    ...OTC_TICKET,
    ticket: `${OTC_TICKET.ticket}; the agreement is recorded first under Treasury, Collateral`,
    automaticInputs: ['coupon dates from the IMM roll dates and the TARGET calendar', 'premium accrued to the step-in date, exchanged at trade', 'full quarterly coupons', 'settlement date T+3 on the TARGET calendar', 'commission from the Book fee schedule', 'variation margin from the agreement', 'EUR/USD rate (FX fixture) for the reporting-currency figures', 'maturity with collateral returned'],
    manualInputs: ['the agreement (counterparty, minimum transfer, currency)', 'upfront of each trade (stated fill price; negative: received by the buyer)', 'marks per 100 entered by hand', 'a credit event would be recorded by hand (a bankruptcy is refused: not a sovereign credit event)'],
    settlement: 'Upfront, accrued premium and commission settle T+3 on the TARGET calendar (across 25 December); coupons on the adjusted coupon dates',
    lifecycle: 'Sell protection, full coupons received, partial buy-back across the Christmas holiday, bankruptcy refused (sovereign terms), coupons through Easter, maturity at 20 June 2027 (paid Monday 21 June); nothing scheduled afterwards',
    accounting: 'EUR contract in a USD Book: P&L entries at the rate of the day, unrealized at the current rate, the difference the FX effect; carried at the mark; the accrued premium paid at trade carried as accrued income until the coupon; the cost written off at maturity',
    collateral: 'Agreement "CSA Dealer M": variation margin in EUR cash on the mark, no threshold, 25,000 EUR minimum transfer, no independent amount; received collateral restricted and owed back; returned at maturity',
  },
  start: at('2026-10-06'),
  settlementCheck: { lag: 3, holidays: ['2026-12-25'] }, // TARGET: Christmas Day (26 December 2026 is a Saturday)
  book: {
    name: 'Matrix sovereign CDS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }, { ccy: 'EUR', amount: 1_500_000 }],
    account: { name: 'Sovereign credit', funding: [{ ccy: 'USD', amount: 500_000 }, { ccy: 'EUR', amount: 1_000_000 }] },
    settings: { fees: { cds: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { cds: 3 } }, // 20.00 EUR per million of notional
  },
  instruments: {},
  tradedOn: 'The contract is registered by the step "register-under-agreement" (registry form), once the agreement it names is recorded: an agreement basis needs the agreement first.',
  fx: { 'EUR/USD': 1.10 },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 500_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 500_000 }, EUR: { settled: 1_000_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 1_000_000 } },
      treasury: { USD: { settled: 1_500_000 }, EUR: { settled: 500_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 1_600_000, treasury: 2_050_000, book: 3_650_000 }, // 500,000 + 1,000,000 EUR at 1.10; 1,500,000 + 500,000 EUR at 1.10
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      id: 'record-agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer M', counterparty: 'Dealer M', kind: 'bilateral', covers: ['account'], independentAmount: { type: 'none' }, variationMargin: true, threshold: 0, minimumTransfer: 25_000, baseCcy: 'EUR', postingCcy: 'EUR', haircut: 0, nettingScope: 'position' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer M with Dealer M (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    { id: 'register-under-agreement', covers: 'registration', action: 'register_instrument', as: 'main', draft: VALM_DRAFT, expect: {} },
    otcTicket({
      // Sold at -0.60: we pay 60,000.00 and the 4,444.44 accrued; commission 200 EUR. Nothing to post: no independent amount.
      id: 'sell-protection', covers: ['open', 'sell protection', 'accrued at trade'], instrument: 'main', side: 'sell', qty: 10_000_000, upfront: -0.60, as: 'cds',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 10_000_000, estimate: -0.6, model: 'stated-price', settleDate: '2026-10-09', calendar: 'TARGET',
            cash: -64_444.44, // 10,000,000 x -0.60 / 100 - 4,444.44
            accrued: -4_444.44, fees: 200 }],
          cash: { EUR: { fees: 200, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000_000, avgPrice: -0.6, fills: [{ qty: 10_000_000, price: -0.6, model: 'stated-price', settleDate: '2026-10-09' }] }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 10,000,000 VALM-CDS-0627 @ -0.60 EUR; premium accrued from 2026-09-21 to the step-in date 2026-10-07 (16 days), 4,444.44 EUR, paid to the counterparty with the settlement', owner: 'account', date: '2026-10-06' },
        ],
        cash: { account: { EUR: { settled: 1_000_000, unsettled: -64_644.44, availableToTrade: 935_355.56, availableToWithdraw: 935_355.56 } } },
        positions: [{ instrument: 'main', lot: 'cds', owner: 'account', direction: 'protection sold', qty: -10_000_000, avgCost: -0.6, cost: 60_000, price: null, value: null, unrealized: null, provisional: true, notional: 10_000_000, margin: 0, accrued: 4_444.44 }],
        holdings: { main: { long: 0, short: 10_000_000, net: -10_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-10-09', amount: -64_644.44, ccy: 'EUR', into: 'cash' }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-12-21', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2027-06-21', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'cds', owner: 'account', qty: -10_000_000, basis: 'agreement', agreement: 'CSA Dealer M', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0, vmStatus: 'not_valued_yet' }],
        pnl: { account: { realized: 0, commissions: -220, unrealized: 0, fx: 0, total: -220 } }, // 200 EUR at 1.10
        nav: { account: 1_599_780, book: 3_649_780 },
        provisional: { account: true, book: true },
        // At 1.10: cash 500,000 + 1,100,000; payable 64,644.44 EUR = 71,108.88; position at cost 60,000 EUR = 66,000; accrued 4,444.44 EUR = 4,888.88.
        balance: { account: { cash: 1_600_000, payable: 71_108.88, positions: 66_000, accruedIncome: 4_888.88, assets: 1_670_888.88, liabilities: 71_108.88, netAssets: 1_599_780 } },
      },
    }),
    {
      // The contract as written (the buyer's side) is marked at -0.55; our side is worth -10,000,000 x -0.55 / 100 = 55,000 EUR,
      // against 60,000 paid: unrealized -5,000 EUR = -5,500 USD.
      id: 'mark', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.55, note: 'Dealer M upfront per 100, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cds', price: -0.55, value: 55_000, unrealized: -5_000, provisional: false, priceSource: 'Manual entry' }],
        otc: [{ instrument: 'main', mark: -0.55, markValue: 55_000 }],
        pnl: { account: { unrealized: -5_500, total: -5_720 } },
        nav: { account: 1_594_280, book: 3_644_280 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 60_500, assets: 1_665_388.88, netAssets: 1_594_280 } },
      },
    },
    {
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-10-06'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer M" (Dealer M): 55,000.00 EUR received. Netting set of 1 position marked at 55,000.00 EUR; threshold 0.00 EUR.', owner: 'account', date: '2026-10-06' }],
        cash: { account: { EUR: { restricted: 55_000 } } },
        otc: [{ instrument: 'main', vmHeld: 55_000, vmExposure: 55_000, vmStatus: 'ok' }],
        balance: { account: { restricted: 60_500, collateralReceived: 60_500, assets: 1_725_888.88, liabilities: 131_608.88 } },
      },
    },
    {
      id: 'settle-upfront', covers: 'settlement', action: 'clock', to: at('2026-10-09'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 64,644.44 EUR from settled cash', cash: { EUR: -64_644.44 }, date: '2026-10-09' }],
        cash: { account: { EUR: { settled: 935_355.56, unsettled: 0, availableToTrade: 935_355.56, availableToWithdraw: 935_355.56 } } },
        pending: [],
        balance: { account: { cash: 1_528_891.12, payable: null, assets: 1_654_780, liabilities: 60_500 } }, // 500,000 + 935,355.56 x 1.10
      },
    },
    {
      // EUR/USD 1.12: the account's euro net assets, 994,800.00 EUR, are worth 1,114,176.00; Treasury's 500,000 EUR 560,000.
      // FX effect: (1.12 - 1.10) x 999,800 EUR of balances carried at 1.10 = 19,996.00; unrealized -5,000 EUR is now -5,600 USD.
      id: 'euro-strengthens', covers: 'fx', action: 'fx_rate', pair: 'EUR/USD', rate: 1.12,
      expect: {
        pnl: { account: { unrealized: -5_600, fx: 19_996, total: 14_176 } },
        nav: { account: 1_614_176, treasury: 2_060_000, book: 3_674_176 },
        balance: { account: { cash: 1_547_598.23, restricted: 61_600, collateralReceived: 61_600, positions: 61_600, accruedIncome: 4_977.77, assets: 1_675_776, liabilities: 61_600, netAssets: 1_614_176 } },
      },
    },
    {
      id: 'bankruptcy-not-a-sovereign-credit-event', covers: 'credit event', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'credit_event', eventType: 'bankruptcy', recovery: 0.3 },
      status: 'blocked', reason: 'A sovereign does not go bankrupt: bankruptcy is not a credit event of sovereign terms.',
      expect: { refused: { engine: 'Bankruptcy is not a credit event under the terms of VALM-CDS-0627. Its credit events: Failure to pay, Repudiation/moratorium, Restructuring, Obligation acceleration.', api: 'Bankruptcy is not a credit event under the terms of VALM-CDS-0627', browser: '"Kind of credit event" does not offer "bankruptcy" for VALM-CDS-0627: it offers Failure to pay, Repudiation/moratorium, Restructuring, Obligation acceleration.' } },
    },
    {
      // 21 September to 20 December included, 91 days: 25,277.78 EUR received; with the 4,444.44 paid at trade, 20,833.34 EUR
      // of premium income, booked at 1.12: 23,333.34 USD.
      id: 'first-coupon', covers: ['premium', 'payment across a weekend roll date'], action: 'clock', to: at('2026-12-21'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium received on ${VALM_NAME} for 2026-09-21 to 2026-12-20 included (91 days on 10,000,000.00 EUR): 25,277.78 EUR; the accrued premium of 4,444.44 EUR exchanged at trade is settled with it`, cash: { EUR: 25_277.78 }, owner: 'account', date: '2026-12-21' }],
        cash: { account: { EUR: { settled: 960_633.34, availableToTrade: 960_633.34, availableToWithdraw: 960_633.34 } } },
        positions: [{ instrument: 'main', lot: 'cds', accrued: 0 }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2027-03-22', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2027-06-21', status: 'pending' },
        ],
        pnl: { account: { realized: 23_333.34, total: 37_509.34 } },
        nav: { account: 1_637_509.34, book: 3_697_509.34 }, // 1,015,633.34 EUR x 1.12 + 500,000
        balance: { account: { cash: 1_575_909.34, accruedIncome: null, assets: 1_699_109.34, netAssets: 1_637_509.34 } },
      },
    },
    { id: 'christmas-week', action: 'clock', to: at('2026-12-23'), expect: {} },
    {
      id: 'mark-before-buy-back', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: -0.45, note: 'Dealer M upfront per 100, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'cds', price: -0.45, value: 45_000, unrealized: -15_000 }], // -10,000,000 x -0.45 / 100
        otc: [{ instrument: 'main', mark: -0.45, markValue: 45_000 }],
        pnl: { account: { unrealized: -16_800, total: 26_309.34 } },
        nav: { account: 1_626_309.34, book: 3_686_309.34 },
        balance: { account: { positions: 50_400, assets: 1_687_909.34, netAssets: 1_626_309.34 } },
      },
    },
    {
      // 4,000,000 bought back at -0.45: 18,000.00 received; cost out 60,000 x 4/10 = 24,000.00: realized -6,000.00 EUR.
      // Accrued 21 to 24 December, 3 days, received: 333.33 EUR, premium earned on the part bought back (realized at once).
      // Settles Tue 29 December: T+3 on TARGET skipping Christmas Day.
      id: 'partial-buy-back', covers: ['reduce', 'partial termination', 'accrued at trade', 'settlement across a holiday'], action: 'close', lot: 'cds', scope: 'strategy', percent: 40, order: { statedPrice: -0.45 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 4_000_000, estimate: -0.45, model: 'stated-price', settleDate: '2026-12-29', cash: 18_333.33, accrued: -333.33, fees: 80 }] },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 4_000_000, avgPrice: -0.45 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 4,000,000 VALM-CDS-0627 @ -0.45 EUR (realized -6,000.00 EUR); premium accrued from 2026-12-21 to the step-in date 2026-12-24 (3 days), 333.33 EUR, received from the counterparty with the settlement' },
          { type: 'cds.accrued', summary: 'Premium accrued on the 4,000,000 terminated on VALM-CDS-0627, 333.33 EUR, received with the termination: realized as premium for the time it was held' },
        ],
        cash: { account: { EUR: { settled: 960_633.34, unsettled: 18_253.33, availableToTrade: 978_886.67, availableToWithdraw: 960_633.34 } } }, // 18,333.33 - 80
        positions: [{ instrument: 'main', lot: 'cds', qty: -6_000_000, cost: 36_000, avgCost: -0.6, price: -0.45, value: 27_000, unrealized: -9_000, notional: 6_000_000, accrued: 0 }],
        holdings: { main: { long: 0, short: 6_000_000, net: -6_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-12-29', amount: 18_253.33, ccy: 'EUR', into: 'cash' }],
        otc: [{ instrument: 'main', qty: -6_000_000, markValue: 27_000 }],
        // At 1.12: realized 23,333.34 - 6,720.00 + 373.33; commission 220 + 89.60; unrealized -9,000 EUR = -10,080.
        pnl: { account: { realized: 16_986.67, commissions: -309.6, unrealized: -10_080, fx: 19_996, total: 26_593.07 } },
        nav: { account: 1_626_593.07, book: 3_686_593.07 }, // 1,005,886.67 EUR x 1.12 + 500,000
        balance: { account: { cash: 1_575_909.34, receivable: 20_443.73, positions: 30_240, assets: 1_688_193.07, liabilities: 61_600, netAssets: 1_626_593.07 } },
      },
    },
    {
      // 27,000 required, 55,000 held: 28,000 goes back, above the 25,000 minimum transfer.
      id: 'variation-margin-returned', covers: 'variation margin', action: 'clock', to: eod('2026-12-23'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer M" (Dealer M): 28,000.00 EUR returned to the counterparty. Netting set of 1 position marked at 27,000.00 EUR; threshold 0.00 EUR.' }],
        cash: { account: { EUR: { restricted: 27_000 } } },
        otc: [{ instrument: 'main', vmHeld: 27_000, vmExposure: 27_000 }],
        balance: { account: { restricted: 30_240, collateralReceived: 30_240, assets: 1_656_833.07, liabilities: 30_240 } },
      },
    },
    { id: 'still-pending-after-christmas', covers: 'settlement across a holiday', action: 'clock', to: at('2026-12-28'), expect: {} },
    {
      id: 'settle-buy-back', covers: ['settlement', 'settlement across a holiday'], action: 'clock', to: at('2026-12-29'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 18,253.33 EUR into settled cash', cash: { EUR: 18_253.33 }, date: '2026-12-29' }],
        cash: { account: { EUR: { settled: 978_886.67, unsettled: 0, availableToTrade: 978_886.67, availableToWithdraw: 978_886.67 } } },
        pending: [],
        balance: { account: { cash: 1_596_353.07, receivable: null } }, // 500,000 + 978,886.67 x 1.12
      },
    },
    {
      // 21 December to 21 March included, 91 days, on 6,000,000: 15,166.67 EUR = 16,986.67 USD at 1.12.
      id: 'second-coupon', covers: 'premium', action: 'clock', to: at('2027-03-22'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium received on ${VALM_NAME} for 2026-12-21 to 2027-03-21 included (91 days on 6,000,000.00 EUR): 15,166.67 EUR`, cash: { EUR: 15_166.67 }, date: '2027-03-22' }],
        cash: { account: { EUR: { settled: 994_053.34, availableToTrade: 994_053.34, availableToWithdraw: 994_053.34 } } },
        lifecycle: [
          { type: 'cds.maturity', instrument: 'main', dueDate: '2027-06-21', status: 'pending' }, // same day: listed by type
          { type: 'cds.premium', instrument: 'main', dueDate: '2027-06-21', status: 'pending' },
        ],
        pnl: { account: { realized: 33_973.34, total: 43_579.74 } },
        nav: { account: 1_643_579.74, book: 3_703_579.74 },
        balance: { account: { cash: 1_613_339.74, assets: 1_673_819.74, netAssets: 1_643_579.74 } },
      },
    },
    { id: 'across-easter', covers: 'holding across a holiday', action: 'clock', to: at('2027-03-30'), expect: {} }, // Good Friday 26 March and Easter Monday 29 March: TARGET closed
    {
      // Last period 22 March to 20 June included, 91 days: 15,166.67 EUR received; then the contract matures, the 36,000 EUR
      // of cost left is written off (realized -40,320.00 USD at 1.12) and the 27,000 EUR held goes back to Dealer M.
      id: 'final-coupon-and-maturity', covers: ['premium', 'maturity', 'collateral'], action: 'clock', to: at('2027-06-21'),
      expect: {
        events: [
          { type: 'cds.premium', summary: `CDS premium received on ${VALM_NAME} for 2027-03-22 to 2027-06-20 included (91 days on 6,000,000.00 EUR): 15,166.67 EUR`, cash: { EUR: 15_166.67 }, date: '2027-06-21' },
          { type: 'cds.matured', summary: `CDS matured without a credit event: ${VALM_NAME}` },
          { type: 'collateral.variation', summary: 'Variation margin under "CSA Dealer M" (Dealer M): 27,000.00 EUR returned to the counterparty. The last position of the netting set ended.' },
        ],
        cash: { account: { EUR: { settled: 1_009_220.01, restricted: 0, availableToTrade: 1_009_220.01, availableToWithdraw: 1_009_220.01 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pnl: { account: { realized: 10_640.01, unrealized: 0, total: 30_326.41 } }, // 33,973.34 + 16,986.67 - 40,320.00
        nav: { account: 1_630_326.41, book: 3_690_326.41 }, // 1,009,220.01 EUR x 1.12 + 500,000
        balance: { account: { cash: 1_630_326.41, restricted: null, collateralReceived: null, positions: null, assets: 1_630_326.41, liabilities: 0, netAssets: 1_630_326.41 } },
      },
    },
    {
      // 1,000,000 - 64,644.44 + 25,277.78 + 18,253.33 + 15,166.67 + 15,166.67 = 1,009,220.01 EUR. Nothing is scheduled or held.
      id: 'nothing-left', covers: 'close', action: 'clock', to: at('2027-06-22'),
      expect: { events: [], positions: [], pending: [], lifecycle: [], otc: [], alerts: [] },
    },
  ],
};

export default [cdsSingleName, cdsSovereign];
