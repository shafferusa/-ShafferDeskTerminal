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

// ---------------------------------------------------------------------------------------------
// cds_index
// ---------------------------------------------------------------------------------------------
// MCX North America Investment Grade, Series 46, five years (125 names, equal weights of 0.8%), standard contract, 100 bp,
// maturity 20 June 2031; protection bought by TREASURY, cleared: margin account at Meridian Clearing House (initial margin
// 2% of the notional outstanding, full variation margin both ways, no minimum transfer), posted and received by Treasury.
// Commission 20.00 per million of notional traded; T+3 on the USD calendar.
//   bought 25,000,000 on Wed 6 May 2026 at 0.50: upfront 125,000.00; accrued 20 March to the step-in date 7 May, 48 days:
//     25,000,000 x 1% x 48/360 = 33,333.33 received; settles Mon 11 May
//   Brightwater Paper Co. (weight 0.8%) fails to pay on Wed 10 June; auction final price 30 recorded Mon 15 June,
//     settling Thu 18 June: affected 25,000,000 x 0.008 = 200,000.00; protection 200,000 x 0.70 = 140,000.00; accrued
//     premium 20 March to 10 June included, 83 days: 200,000 x 1% x 83/360 = 461.11; net receivable 139,538.89. The
//     defaulted part's share of the accrued received at trade, 33,333.33 x 0.008 = 266.67, and of the cost,
//     125,000 x 0.008 = 1,000.00, go with it: realized 139,538.89 - 1,000.00 + 266.67 = 138,805.56. Index factor 0.992:
//     24,800,000 outstanding; initial margin 2% of it, 496,000.00 (4,000.00 back)
//   coupon Mon 22 June: 24,800,000 x 1% x 94/360 = 64,755.56; with the 33,066.66 still carried from the trade, a premium
//     cost of 31,688.90; coupon Mon 21 September: 24,800,000 x 1% x 91/360 = 62,688.89
//   rolled on Tue 22 September into Series 47 (maturity 20 December 2031) at the marks entered by hand: Series 46 sold at
//     0.60 on its outstanding notional, 24,800,000 x 0.60 / 100 = 148,800.00 received against the 124,000.00 of cost
//     left (realized 24,800.00), and 2 days of accrued paid (21 to 23 September), 24,800,000 x 1% x 2/360 = 1,377.78,
//     realized; Series 47 bought on 24,800,000 at 0.95, 235,600.00 paid, 1,377.78 accrued received (carried). Commission
//     500.00 (25,000,000 traded) and 496.00 (24,800,000). Both settle Fri 25 September
//   Series 47 terminated on Thu 15 October at 0.80: 198,400.00 received; cost 235,600.00, realized -37,200.00; accrued
//     21 September to 16 October, 25 days, paid: 24,800,000 x 1% x 25/360 = 17,222.22, realized; the 1,377.78 carried
//     from the roll is premium income for the time held; settles Tue 20 October
const IG46_NAME = 'MCX NA IG Series 46 5Y index CDS 100bp 20 Jun 2031';
const IG47_NAME = 'MCX NA IG Series 47 5Y index CDS 100bp 20 Dec 2031';
const ccpBasis = { type: 'agreement', agreementId: '$agreement:ccp' };
const IG46_DRAFT = {
  productId: 'cds_index', name: IG46_NAME, symbol: 'MCXIG-S46', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
  conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
  terms: { referenceEntity: 'MCX North America Investment Grade Index, Series 46 (125 names, 0.8% each)', coupon: 0.01, effective: '2026-03-20', maturity: '2031-06-20', recovery: 0.4, indexFactor: 1, convention: 'standard', creditEventSet: 'corporate_xr', settlement: 'auction', counterparty: 'Meridian Clearing House', collateralBasis: ccpBasis },
};
const IG47_DRAFT = { ...IG46_DRAFT, name: IG47_NAME, symbol: 'MCXIG-S47', terms: { ...IG46_DRAFT.terms, referenceEntity: 'MCX North America Investment Grade Index, Series 47 (125 names, 0.8% each)', effective: '2026-09-21', maturity: '2031-12-20' } };
const cdsIndex = {
  productId: 'cds_index',
  title: 'Index CDS bought by Treasury, cleared: a constituent\'s failure to pay reduces the index factor and the contract goes on; rolled into the new series; terminated',
  matrix: {
    ...OTC_TICKET,
    ticket: `${OTC_TICKET.ticket}; the clearing account is recorded first under Treasury, Collateral; Trading owner Treasury; the strategy instance's Roll for the new series`,
    automaticInputs: ['coupon dates from the IMM roll dates and the USD calendar', 'premium accrued to the step-in date, exchanged at trade', 'full coupons on the notional outstanding (index factor)', 'upfront on the notional outstanding', 'settlement date T+3 on the USD calendar', 'commission from the Book fee schedule', 'initial margin and variation margin from the clearing terms', 'the roll package: old series terminated, the notional outstanding entered in the new series'],
    manualInputs: ['the clearing account (initial margin, currency)', 'upfront of each trade (stated fill price) and the roll at the marks entered by hand', 'marks per 100 entered by hand for each series', 'a constituent\'s credit event: kind, event date, auction final price, weight in the index, settlement date'],
    settlement: 'Upfronts, accrued premium and commission settle T+3 on the USD calendar; coupons on the adjusted coupon dates; the constituent\'s auction settlement on its stated date',
    lifecycle: 'Buy protection; a constituent\'s failure to pay settled at the auction final price on its weight, the index factor falls to 0.992 and the contract goes on with smaller coupons; roll into Series 47 (one package: terminate Series 46, enter Series 47); terminate Series 47; nothing scheduled afterwards',
    accounting: 'Carried at the mark on the notional outstanding less the upfronts paid; the defaulted part\'s cost and carried accrued realized with its settlement; accrued premium received at trade carried until the coupon; coupons, the roll and the termination are realized P&L; commission expensed',
    collateral: 'Cleared account "Meridian Clearing House" posted by Treasury: initial margin 2% of the notional outstanding (trued up when the index factor falls, moved from the old to the new series in the roll, returned at the end); variation margin on the mark each end of day, no minimum transfer, received collateral restricted',
  },
  start: at('2026-05-06'),
  settlementCheck: { lag: 3, holidays: [] },
  book: {
    name: 'Matrix index CDS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 10_000_000 }],
    account: { name: 'Index desk', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { cds: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { cds: 3 } },
  },
  instruments: {},
  tradedOn: 'Both series are registered by steps (registry form) once the clearing account they name is recorded.',
  expectAtStart: {
    cash: {
      account: { USD: { settled: 1_000_000 } },
      treasury: { USD: { settled: 9_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 9_000_000, availableToWithdraw: 9_000_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 1_000_000, treasury: 9_000_000, book: 10_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      id: 'record-clearing-account', covers: 'collateral', action: 'agreement', as: 'ccp',
      agreement: { name: 'Cleared CDS account', counterparty: 'Meridian Clearing House', kind: 'cleared', covers: ['treasury'], postedBy: 'treasury', independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: true, minimumTransfer: 0, baseCcy: 'USD', postingCcy: 'USD', haircut: 0, nettingScope: 'position' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: Cleared CDS account with Meridian Clearing House (Cleared)', owner: 'treasury' }] },
    },
    { id: 'register-series-46', covers: 'registration', action: 'register_instrument', as: 'main', draft: IG46_DRAFT, expect: {} },
    { id: 'register-series-47', covers: 'registration', action: 'register_instrument', as: 's47', draft: IG47_DRAFT, expect: {} },
    otcTicket({
      id: 'treasury-buys-protection', covers: ['open', 'buy protection', 'accrued at trade', 'collateral'], owner: 'treasury', instrument: 'main', side: 'buy', qty: 25_000_000, upfront: 0.50, as: 'idx',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 25_000_000, estimate: 0.5, model: 'stated-price', settleDate: '2026-05-11', calendar: 'USD',
            cash: -91_666.67, accrued: -33_333.33, fees: 500, notional: 25_000_000 }], // -125,000 + 33,333.33; 25,000,000 x 0.00002
          cash: { USD: { fees: 500, margin: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 25_000_000, avgPrice: 0.5 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 25,000,000 MCXIG-S46 @ 0.50 USD; premium accrued from 2026-03-20 to the step-in date 2026-05-07 (48 days), 33,333.33 USD, received from the counterparty with the settlement', owner: 'treasury', date: '2026-05-06' },
          { type: 'cds.accrued', summary: '33,333.33 USD carried as owed back with the next coupon', owner: 'treasury' },
          { type: 'cds.collateral', summary: `Collateral posted on ${IG46_NAME} under "Cleared CDS account" (Meridian Clearing House): 500,000.00 USD`, cash: { USD: -500_000 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 8_500_000, unsettled: -92_166.67, margin: 500_000, availableToTrade: 8_407_833.33, availableToWithdraw: 8_407_833.33 } } },
        positions: [{ instrument: 'main', lot: 'idx', owner: 'treasury', direction: 'protection bought', qty: 25_000_000, avgCost: 0.5, cost: 125_000, price: null, value: null, unrealized: null, provisional: true, notional: 25_000_000, margin: 500_000, accrued: -33_333.33 }],
        holdings: { main: { long: 25_000_000, short: 0, net: 25_000_000 } },
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2026-05-11', amount: -92_166.67, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-06-22', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2031-06-20', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'idx', owner: 'treasury', qty: 25_000_000, basis: 'agreement', agreement: 'Cleared CDS account', mark: null, iaRequired: 500_000, iaPosted: 500_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { treasury: { realized: 0, commissions: -500, unrealized: 0, total: -500 } },
        nav: { treasury: 8_999_500, book: 9_999_500 },
        provisional: { book: true },
        balance: { treasury: { cash: 8_500_000, margin: 500_000, positions: 125_000, payable: 92_166.67, accruedExpense: 33_333.33, assets: 9_125_000, liabilities: 125_500, netAssets: 8_999_500 } },
      },
    }),
    { id: 'treasury-screens-after-the-trade', covers: 'owner screens', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      id: 'mark-at-trade', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.50, note: 'Clearing house settlement price per 100, entered by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'idx', price: 0.5, value: 125_000, unrealized: 0, provisional: false, priceSource: 'Manual entry' }],
        otc: [{ instrument: 'main', mark: 0.5, markValue: 125_000 }],
        provisional: { book: false },
      },
    },
    {
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-05-06'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "Cleared CDS account" (Meridian Clearing House): 125,000.00 USD received.', owner: 'treasury', date: '2026-05-06' }],
        cash: { treasury: { USD: { restricted: 125_000 } } },
        otc: [{ instrument: 'main', vmHeld: 125_000, vmExposure: 125_000, vmStatus: 'ok' }],
        balance: { treasury: { restricted: 125_000, collateralReceived: 125_000, assets: 9_250_000, liabilities: 250_500 } },
      },
    },
    { id: 'thursday', action: 'clock', to: at('2026-05-07'), expect: {} },
    {
      id: 'mark-wider', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.55, note: 'Clearing house settlement price per 100, entered by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'idx', price: 0.55, value: 137_500, unrealized: 12_500 }],
        otc: [{ instrument: 'main', mark: 0.55, markValue: 137_500 }],
        pnl: { treasury: { unrealized: 12_500, total: 12_000 } },
        nav: { treasury: 9_012_000, book: 10_012_000 },
        balance: { treasury: { positions: 137_500, assets: 9_262_500, netAssets: 9_012_000 } },
      },
    },
    {
      id: 'variation-margin-topped-up', covers: 'variation margin', action: 'clock', to: eod('2026-05-07'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "Cleared CDS account" (Meridian Clearing House): 12,500.00 USD received.', owner: 'treasury' }],
        cash: { treasury: { USD: { restricted: 137_500 } } },
        otc: [{ instrument: 'main', vmHeld: 137_500, vmExposure: 137_500 }],
        balance: { treasury: { restricted: 137_500, collateralReceived: 137_500, assets: 9_275_000, liabilities: 263_000 } },
      },
    },
    {
      id: 'settle-upfront', covers: 'settlement', action: 'clock', to: at('2026-05-11'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 92,166.67 USD from settled cash', cash: { USD: -92_166.67 }, owner: 'treasury', date: '2026-05-11' }],
        cash: { treasury: { USD: { settled: 8_407_833.33, unsettled: 0, availableToTrade: 8_407_833.33, availableToWithdraw: 8_407_833.33 } } },
        pending: [],
        balance: { treasury: { cash: 8_407_833.33, payable: null, assets: 9_182_833.33, liabilities: 170_833.33 } },
      },
    },
    { id: 'auction-day', action: 'clock', to: at('2026-06-15'), expect: {} },
    {
      id: 'constituent-fails-to-pay', covers: ['credit event', 'index factor', 'cash settlement', 'collateral'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'credit_event', eventType: 'failure_to_pay', eventDate: '2026-06-10', recovery: 0.30, entity: 'Brightwater Paper Co.', weight: 0.008, settlement: 'auction', settleDate: '2026-06-18' },
      expect: {
        events: [
          { type: 'cds.credit_event', summary: 'Failure to pay of Brightwater Paper Co. on 2026-06-10 recorded by hand for MCXIG-S46, auction final price 30.000%; index factor 1 to 0.992; protection 140,000.00 USD (200,000.00 USD x 70.000%); accrued premium 461.11 USD; receivable 139,538.89 USD on 2026-06-18', owner: 'treasury', date: '2026-06-15' },
          { type: 'cds.collateral', summary: `Collateral returned on ${IG46_NAME} under "Cleared CDS account" (Meridian Clearing House): 4,000.00 USD`, cash: { USD: 4_000 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 8_411_833.33, unsettled: 139_538.89, margin: 496_000, availableToTrade: 8_551_372.22, availableToWithdraw: 8_411_833.33 } } },
        positions: [{ instrument: 'main', lot: 'idx', qty: 25_000_000, cost: 124_000, avgCost: 0.5, // 124,000 / (24,800,000 / 100)
          price: 0.55, value: 136_400, unrealized: 12_400, notional: 24_800_000, margin: 496_000, accrued: -33_066.66 }], // 24,800,000 x 0.55 / 100; 33,333.33 - 266.67
        pending: [{ instrument: 'main', owner: 'treasury', dueDate: '2026-06-18', amount: 139_538.89, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', markValue: 136_400, iaRequired: 496_000, iaPosted: 496_000 }],
        pnl: { treasury: { realized: 138_805.56, unrealized: 12_400, total: 150_705.56 } },
        nav: { treasury: 9_150_705.56, book: 10_150_705.56 },
        balance: { treasury: { cash: 8_411_833.33, margin: 496_000, receivable: 139_538.89, positions: 136_400, accruedExpense: 33_066.66, assets: 9_321_272.22, liabilities: 170_566.66, netAssets: 9_150_705.56 } },
      },
    },
    {
      id: 'variation-margin-on-the-smaller-index', covers: 'variation margin', action: 'clock', to: eod('2026-06-15'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "Cleared CDS account" (Meridian Clearing House): 1,100.00 USD returned to the counterparty.' }], // 137,500 - 136,400
        cash: { treasury: { USD: { restricted: 136_400 } } },
        otc: [{ instrument: 'main', vmHeld: 136_400, vmExposure: 136_400 }],
        balance: { treasury: { restricted: 136_400, collateralReceived: 136_400, assets: 9_320_172.22, liabilities: 169_466.66 } },
      },
    },
    {
      id: 'auction-settlement', covers: 'settlement', action: 'clock', to: at('2026-06-18'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 139,538.89 USD into settled cash', cash: { USD: 139_538.89 } }],
        cash: { treasury: { USD: { settled: 8_551_372.22, unsettled: 0, availableToTrade: 8_551_372.22, availableToWithdraw: 8_551_372.22 } } },
        pending: [],
        balance: { treasury: { cash: 8_551_372.22, receivable: null } },
      },
    },
    {
      id: 'coupon-on-the-smaller-index', covers: ['premium', 'index factor'], action: 'clock', to: at('2026-06-22'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium paid on ${IG46_NAME} for 2026-03-20 to 2026-06-21 included (94 days on 24,800,000.00 USD): 64,755.56 USD; the accrued premium of 33,066.66 USD exchanged at trade is settled with it`, cash: { USD: -64_755.56 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 8_486_616.66, availableToTrade: 8_486_616.66, availableToWithdraw: 8_486_616.66 } } },
        positions: [{ instrument: 'main', lot: 'idx', accrued: 0 }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-09-21', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2031-06-20', status: 'pending' },
        ],
        pnl: { treasury: { realized: 107_116.66, total: 119_016.66 } }, // 138,805.56 - 31,688.90
        nav: { treasury: 9_119_016.66, book: 10_119_016.66 },
        balance: { treasury: { cash: 8_486_616.66, accruedExpense: null, assets: 9_255_416.66, liabilities: 136_400, netAssets: 9_119_016.66 } },
      },
    },
    {
      id: 'september-coupon', covers: 'premium', action: 'clock', to: at('2026-09-21'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium paid on ${IG46_NAME} for 2026-06-22 to 2026-09-20 included (91 days on 24,800,000.00 USD): 62,688.89 USD`, cash: { USD: -62_688.89 } }],
        cash: { treasury: { USD: { settled: 8_423_927.77, availableToTrade: 8_423_927.77, availableToWithdraw: 8_423_927.77 } } },
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-12-21', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2031-06-20', status: 'pending' },
        ],
        pnl: { treasury: { realized: 44_427.77, total: 56_327.77 } },
        nav: { treasury: 9_056_327.77, book: 10_056_327.77 },
        balance: { treasury: { cash: 8_423_927.77, assets: 9_192_727.77, netAssets: 9_056_327.77 } },
      },
    },
    { id: 'roll-day', action: 'clock', to: at('2026-09-22'), expect: {} },
    {
      id: 'mark-series-46', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.60, note: 'Clearing house settlement price per 100, entered by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'idx', price: 0.6, value: 148_800, unrealized: 24_800 }], // 24,800,000 x 0.60 / 100
        otc: [{ instrument: 'main', mark: 0.6, markValue: 148_800 }],
        pnl: { treasury: { unrealized: 24_800, total: 68_727.77 } },
        nav: { treasury: 9_068_727.77, book: 10_068_727.77 },
        balance: { treasury: { positions: 148_800, assets: 9_205_127.77, netAssets: 9_068_727.77 } },
      },
    },
    { id: 'mark-series-47', covers: 'manual mark', action: 'manual_price', instrument: 's47', value: 0.95, note: 'Clearing house settlement price per 100, entered by hand', expect: {} },
    {
      // One package: Series 46 terminated at its mark, the 24,800,000 outstanding entered in Series 47 at its mark.
      id: 'roll-into-series-47', covers: ['roll', 'close', 'open', 'accrued at trade', 'collateral'], action: 'roll', lot: 'idx', into: 's47',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'trade', action: 'sell', instrument: 'main', qty: 25_000_000, estimate: 0.6, model: 'manual-mark', priceSource: 'Manual entry', settleDate: '2026-09-25', cash: 147_422.22, accrued: -1_377.78, fees: 500, notional: 24_800_000 }, // 148,800 - 1,377.78
            { kind: 'trade', action: 'buy', instrument: 's47', qty: 24_800_000, estimate: 0.95, model: 'manual-mark', priceSource: 'Manual entry', settleDate: '2026-09-25', cash: -234_222.22, accrued: -1_377.78, fees: 496, notional: 24_800_000 }, // -235,600 + 1,377.78
          ],
        },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 25_000_000, avgPrice: 0.6 }, { action: 'buy', status: 'filled', filledQty: 24_800_000, avgPrice: 0.95 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 25,000,000 MCXIG-S46 @ 0.60 USD (realized 24,800.00 USD); premium accrued from 2026-09-21 to the step-in date 2026-09-23 (2 days), 1,377.78 USD, paid to the counterparty with the settlement', owner: 'treasury' },
          { type: 'cds.accrued', summary: 'Premium accrued on the 25,000,000 terminated on MCXIG-S46, 1,377.78 USD, paid with the termination: realized as premium for the time it was held' },
          { type: 'cds.collateral', summary: `Collateral returned on ${IG46_NAME} under "Cleared CDS account" (Meridian Clearing House): 496,000.00 USD`, cash: { USD: 496_000 } },
          { type: 'collateral.variation', summary: 'Variation margin under "Cleared CDS account" (Meridian Clearing House): 136,400.00 USD returned to the counterparty. The last position of the netting set ended.' },
          { type: 'trade.fill', summary: 'Bought 24,800,000 MCXIG-S47 @ 0.95 USD; premium accrued from 2026-09-21 to the step-in date 2026-09-23 (2 days), 1,377.78 USD, received from the counterparty with the settlement' },
          { type: 'cds.accrued', summary: '1,377.78 USD carried as owed back with the next coupon' },
          { type: 'cds.collateral', summary: `Collateral posted on ${IG47_NAME} under "Cleared CDS account" (Meridian Clearing House): 496,000.00 USD`, cash: { USD: -496_000 } },
        ],
        // Available to withdraw counts the payable but not the receivable: 8,423,927.77 - 234,718.22.
        cash: { treasury: { USD: { settled: 8_423_927.77, unsettled: -87_796, restricted: 0, margin: 496_000, availableToTrade: 8_336_131.77, availableToWithdraw: 8_189_209.55 } } }, // 146,922.22 - 234,718.22
        positions: [{ instrument: 's47', lot: 'idx', owner: 'treasury', direction: 'protection bought', qty: 24_800_000, avgCost: 0.95, cost: 235_600, price: 0.95, value: 235_600, unrealized: 0, provisional: false, notional: 24_800_000, margin: 496_000, accrued: -1_377.78 }],
        holdings: { main: null, s47: { long: 24_800_000, short: 0, net: 24_800_000 } },
        pending: [
          { instrument: 'main', owner: 'treasury', dueDate: '2026-09-25', amount: 146_922.22, ccy: 'USD', into: 'cash' },
          { instrument: 's47', owner: 'treasury', dueDate: '2026-09-25', amount: -234_718.22, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [
          { type: 'cds.premium', instrument: 's47', dueDate: '2026-12-21', status: 'pending' },
          { type: 'cds.maturity', instrument: 's47', dueDate: '2031-12-22', status: 'pending' }, // 20 December 2031 is a Saturday
        ],
        otc: [{ instrument: 's47', lot: 'idx', owner: 'treasury', qty: 24_800_000, basis: 'agreement', mark: 0.95, markValue: 235_600, iaRequired: 496_000, iaPosted: 496_000, vmHeld: 0 }],
        pnl: { treasury: { realized: 67_849.99, commissions: -1_496, unrealized: 0, total: 66_353.99 } }, // 44,427.77 + 24,800 - 1,377.78
        nav: { treasury: 9_066_353.99, book: 10_066_353.99 },
        balance: { treasury: { cash: 8_423_927.77, margin: 496_000, restricted: null, collateralReceived: null, receivable: 146_922.22, payable: 234_718.22, positions: 235_600, accruedExpense: 1_377.78, assets: 9_302_449.99, liabilities: 236_096, netAssets: 9_066_353.99 } },
      },
    },
    {
      id: 'variation-margin-on-series-47', covers: 'variation margin', action: 'clock', to: eod('2026-09-22'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under "Cleared CDS account" (Meridian Clearing House): 235,600.00 USD received.' }],
        cash: { treasury: { USD: { restricted: 235_600 } } },
        otc: [{ instrument: 's47', vmHeld: 235_600, vmExposure: 235_600 }],
        balance: { treasury: { restricted: 235_600, collateralReceived: 235_600, assets: 9_538_049.99, liabilities: 471_696 } },
      },
    },
    {
      id: 'settle-roll', covers: 'settlement', action: 'clock', to: at('2026-09-25'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 146,922.22 USD into settled cash', cash: { USD: 146_922.22 } },
          { type: 'settlement.pay', summary: 'paid 234,718.22 USD from settled cash', cash: { USD: -234_718.22 } },
        ],
        cash: { treasury: { USD: { settled: 8_336_131.77, unsettled: 0, availableToTrade: 8_336_131.77, availableToWithdraw: 8_336_131.77 } } },
        pending: [],
        balance: { treasury: { cash: 8_336_131.77, receivable: null, payable: null, assets: 9_303_331.77, liabilities: 236_977.78 } },
      },
    },
    { id: 'mid-october', action: 'clock', to: at('2026-10-15'), expect: {} },
    {
      id: 'mark-series-47-lower', covers: 'manual mark', action: 'manual_price', instrument: 's47', value: 0.80, note: 'Clearing house settlement price per 100, entered by hand',
      expect: {
        positions: [{ instrument: 's47', lot: 'idx', price: 0.8, value: 198_400, unrealized: -37_200 }],
        otc: [{ instrument: 's47', mark: 0.8, markValue: 198_400 }],
        pnl: { treasury: { unrealized: -37_200, total: 29_153.99 } },
        nav: { treasury: 9_029_153.99, book: 10_029_153.99 },
        balance: { treasury: { positions: 198_400, assets: 9_266_131.77, netAssets: 9_029_153.99 } },
      },
    },
    {
      // 198,400.00 received against 235,600.00 of cost: realized -37,200.00; accrued 25 days paid, 17,222.22, realized; the
      // 1,377.78 carried from the roll is income for the time held. Settles Tue 20 October.
      id: 'terminate-series-47', covers: ['close', 'full termination', 'accrued at trade', 'collateral'], action: 'close', lot: 'idx', instrument: 's47', owner: 'treasury', scope: 'position', percent: 100, order: { statedPrice: 0.80 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 's47', qty: 24_800_000, estimate: 0.8, model: 'stated-price', settleDate: '2026-10-20', cash: 181_177.78, accrued: -17_222.22, fees: 496 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 24_800_000, avgPrice: 0.8 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 24,800,000 MCXIG-S47 @ 0.80 USD (realized -37,200.00 USD); premium accrued from 2026-09-21 to the step-in date 2026-10-16 (25 days), 17,222.22 USD, paid to the counterparty with the settlement', owner: 'treasury' },
          { type: 'cds.accrued', summary: 'Premium accrued on the 24,800,000 terminated on MCXIG-S47, 17,222.22 USD, paid with the termination' },
          { type: 'cds.accrued', summary: 'Accrued premium on MCXIG-S47 settled with the termination: 1,377.78 USD premium income for the time held' },
          { type: 'cds.collateral', summary: `Collateral returned on ${IG47_NAME} under "Cleared CDS account" (Meridian Clearing House): 496,000.00 USD`, cash: { USD: 496_000 } },
          { type: 'collateral.variation', summary: 'Variation margin under "Cleared CDS account" (Meridian Clearing House): 235,600.00 USD returned to the counterparty. The last position of the netting set ended.' },
        ],
        cash: { treasury: { USD: { settled: 8_832_131.77, unsettled: 180_681.78, margin: 0, restricted: 0, availableToTrade: 9_012_813.55, availableToWithdraw: 8_832_131.77 } } },
        positions: [], holdings: { s47: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 's47', owner: 'treasury', dueDate: '2026-10-20', amount: 180_681.78, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 14_805.55, commissions: -1_992, unrealized: 0, total: 12_813.55 } }, // 67,849.99 - 37,200 - 17,222.22 + 1,377.78
        nav: { treasury: 9_012_813.55, book: 10_012_813.55 },
        balance: { treasury: { cash: 8_832_131.77, margin: null, restricted: null, collateralReceived: null, positions: null, accruedExpense: null, receivable: 180_681.78, assets: 9_012_813.55, liabilities: 0, netAssets: 9_012_813.55 } },
      },
    },
    {
      // -92,166.67 + 139,538.89 - 64,755.56 - 62,688.89 + 146,922.22 - 234,718.22 + 180,681.78 = +12,813.55 on 9,000,000.
      id: 'settle-termination', covers: ['settlement', 'close'], action: 'clock', to: at('2026-10-20'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 180,681.78 USD into settled cash', cash: { USD: 180_681.78 } }],
        cash: { treasury: { USD: { settled: 9_012_813.55, unsettled: 0, availableToTrade: 9_012_813.55, availableToWithdraw: 9_012_813.55 } } },
        pending: [], lifecycle: [], otc: [], alerts: [],
        balance: { treasury: { cash: 9_012_813.55, receivable: null } },
      },
    },
    { id: 'treasury-screens-at-the-end', covers: 'owner screens', action: 'owner_screens', owner: 'treasury', expect: {} },
  ],
};

// ---------------------------------------------------------------------------------------------
// credit_basket_swap
// ---------------------------------------------------------------------------------------------
// A bespoke first-to-default basket on five names, 500 bp a year, effective Wednesday 15 April 2026, maturity 20 June 2028,
// physically settled: on the first credit event the protection buyer delivers obligations of the defaulted name against
// par (simulated on paper). Bespoke premium convention: periods from the effective date to the IMM 20ths (first period a
// short stub, 15 April to 20 June), accrual dates not adjusted, payment on the next business day, premium from the trade
// date, nothing exchanged at trade; a termination is at an all-in settlement amount. Dealer P; position-level terms: a
// fixed independent amount of 250,000, no variation margin. Commission 20.00 per million; T+3 (USD calendar).
//   bought 5,000,000 on Tue 14 April at 2.00: 100,000.00 paid; settles Fri 17 April. Premium from 15 April (effective).
//   coupon Mon 22 June (20 June is a Saturday): 15 April to 20 June, 66 days: 5,000,000 x 5% x 66/360 = 45,833.33
//   2,000,000 terminated on Wed 15 July at 2.40, all-in: 48,000.00 received; cost out 100,000 x 2/5 = 40,000: realized 8,000
//   Pellworth Retail plc goes bankrupt on Mon 3 August: the first default, so protection on the whole 3,000,000 left;
//     final price 20 recorded Thu 20 August, physical settlement on Tue 25 August: 3,000,000 face delivered against par,
//     3,000,000.00, the obligations taken as bought at the final price, 600,000.00; premium 20 June to 3 August (excluded),
//     44 days: 3,000,000 x 5% x 44/360 = 18,333.33; net receivable 2,381,666.67; the basket then ends
const FTD_NAME = 'Five-name first-to-default basket 500bp 20 Jun 2028 (Dealer P)';
const cdsBasket = {
  productId: 'credit_basket_swap',
  title: 'Bespoke first-to-default basket, physically settled: short first stub, partial termination, the first default settles in full and ends the basket',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Basket reference entities', 'Protection on default number', 'Deliverable obligation (physical settlement)'],
    automaticInputs: ['premium schedule from the effective date to the IMM roll dates (short first stub) on the USD payment calendar', 'premium from the effective date for a trade dealt the day before', 'settlement date T+3', 'commission from the Book fee schedule', 'fixed independent amount from the position-level terms', 'count of defaults against the trigger; on the trigger, protection on the whole notional and the end of the contract'],
    manualInputs: ['the basket names and the trigger (first default)', 'upfront and the all-in termination amount (stated fill prices)', 'marks per 100 entered by hand', 'credit event: the defaulted name (chosen from the basket), kind, date, final price, settlement date'],
    settlement: 'Upfront and termination amounts T+3 on the USD calendar; quarterly premium on the next business day after each roll date; physical settlement of the trigger simulated on paper on the stated date',
    lifecycle: 'Buy protection on the basket; first period a short stub; partial termination at an all-in amount; a name outside the basket refused; the first default (bankruptcy) settles physically on the whole notional and ends the basket; a second default refused',
    accounting: 'Carried at the mark less the upfront; premiums and the settlement realized; the physical settlement shown as par received for the obligations delivered and the obligations taken at the final price (simulated: no bond position is created or delivered)',
    collateral: 'Position-level terms: a fixed independent amount of 250,000 posted at entry, unchanged by the partial termination, returned when the basket ends; no variation margin',
  },
  start: at('2026-04-14'),
  settlementCheck: { lag: 3, holidays: [] },
  book: {
    name: 'Matrix credit basket', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Correlation', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { cds: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { cds: 3 } },
  },
  instruments: {
    main: {
      productId: 'credit_basket_swap', name: FTD_NAME, symbol: 'FTD5-0628', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        referenceEntity: 'First-to-default basket of five North American and European names', coupon: 0.05, effective: '2026-04-15', maturity: '2028-06-20', recovery: 0.4,
        convention: 'bespoke', firstStub: 'short', creditEventSet: 'corporate', settlement: 'physical', deliverable: 'Senior unsecured bonds or loans of the defaulted name (Bond or Loan)',
        basket: ['Corvane Chemicals Inc.', 'Ostrava Shipping AS', 'Pellworth Retail plc', 'Quillon Media Corp.', 'Ravensmoor Energy Ltd.'], nth: 1, counterparty: 'Dealer P',
        collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 250_000 }, variationMargin: false, threshold: 0, minimumTransfer: 0 },
      },
    },
  },
  expectAtStart: {
    cash: { account: { USD: { settled: 2_000_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 2_000_000, availableToWithdraw: 2_000_000 } }, treasury: { USD: { settled: 3_000_000 } } },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 2_000_000, treasury: 3_000_000, book: 5_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    otcTicket({
      id: 'buy-basket-protection', covers: ['open', 'buy protection', 'collateral'], instrument: 'main', side: 'buy', qty: 5_000_000, upfront: 2.00, as: 'ftd',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 2, model: 'stated-price', settleDate: '2026-04-17', calendar: 'USD', cash: -100_000, accrued: 0, fees: 100 }], // 5,000,000 x 2.00 / 100; 5,000,000 x 0.00002
          cash: { USD: { fees: 100, margin: 250_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5_000_000, avgPrice: 2 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 5,000,000 FTD5-0628 @ 2.00 USD', owner: 'account', date: '2026-04-14' },
          { type: 'cds.collateral', summary: `Collateral posted on ${FTD_NAME} under its position-level terms: 250,000.00 USD`, cash: { USD: -250_000 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 1_750_000, unsettled: -100_100, margin: 250_000, availableToTrade: 1_649_900, availableToWithdraw: 1_649_900 } } },
        positions: [{ instrument: 'main', lot: 'ftd', owner: 'account', direction: 'protection bought', qty: 5_000_000, avgCost: 2, cost: 100_000, price: null, value: null, unrealized: null, provisional: true, notional: 5_000_000, margin: 250_000, accrued: 0 }],
        holdings: { main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-17', amount: -100_100, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-06-22', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2028-06-20', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'ftd', owner: 'account', qty: 5_000_000, basis: 'position', iaRequired: 250_000, iaPosted: 250_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -100, unrealized: 0, total: -100 } },
        nav: { account: 1_999_900, book: 4_999_900 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_750_000, margin: 250_000, positions: 100_000, payable: 100_100, assets: 2_100_000, liabilities: 100_100, netAssets: 1_999_900 } },
      },
    }),
    {
      id: 'mark-at-trade', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 2.00, note: 'Dealer P upfront per 100, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'ftd', price: 2, value: 100_000, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 2, markValue: 100_000 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-upfront', covers: 'settlement', action: 'clock', to: at('2026-04-17'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 100,100.00 USD from settled cash', cash: { USD: -100_100 } }],
        cash: { account: { USD: { settled: 1_649_900, unsettled: 0, availableToTrade: 1_649_900, availableToWithdraw: 1_649_900 } } },
        pending: [],
        balance: { account: { cash: 1_649_900, payable: null, assets: 1_999_900, liabilities: 0 } },
      },
    },
    {
      // The short first stub: 15 April (effective) to 20 June, 66 days: 5,000,000 x 5% x 66/360 = 45,833.33, paid Mon 22 June.
      id: 'first-premium-short-stub', covers: ['premium', 'short first stub'], action: 'clock', to: at('2026-06-22'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium paid on ${FTD_NAME} for 2026-04-15 to 2026-06-20: 45,833.33 USD`, cash: { USD: -45_833.33 }, owner: 'account', date: '2026-06-22' }],
        cash: { account: { USD: { settled: 1_604_066.67, availableToTrade: 1_604_066.67, availableToWithdraw: 1_604_066.67 } } },
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-09-21', status: 'pending' }, // 20 September is a Sunday
          { type: 'cds.maturity', instrument: 'main', dueDate: '2028-06-20', status: 'pending' },
        ],
        pnl: { account: { realized: -45_833.33, total: -45_933.33 } },
        nav: { account: 1_954_066.67, book: 4_954_066.67 },
        balance: { account: { cash: 1_604_066.67, assets: 1_954_066.67, netAssets: 1_954_066.67 } },
      },
    },
    {
      id: 'name-outside-the-basket', covers: 'credit event', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'credit_event', eventType: 'bankruptcy', recovery: 0.3, entity: 'Zephyr Holdings Inc.' },
      status: 'blocked', reason: 'Only a credit event of one of the five reference entities counts for the basket.',
      expect: { refused: { engine: 'Zephyr Holdings Inc. is not in the basket of FTD5-0628 (Corvane Chemicals Inc.; Ostrava Shipping AS; Pellworth Retail plc; Quillon Media Corp.; Ravensmoor Energy Ltd.).', api: 'Zephyr Holdings Inc. is not in the basket of FTD5-0628', browser: '"Defaulted name" does not offer "Zephyr Holdings Inc." for FTD5-0628: it offers Corvane Chemicals Inc., Ostrava Shipping AS, Pellworth Retail plc, Quillon Media Corp., Ravensmoor Energy Ltd.' } },
    },
    { id: 'mid-july', action: 'clock', to: at('2026-07-15'), expect: {} },
    {
      id: 'mark-wider', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 2.40, note: 'Dealer P upfront per 100, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'ftd', price: 2.4, value: 120_000, unrealized: 20_000 }],
        otc: [{ instrument: 'main', mark: 2.4, markValue: 120_000 }],
        pnl: { account: { unrealized: 20_000, total: -25_933.33 } },
        nav: { account: 1_974_066.67, book: 4_974_066.67 },
        balance: { account: { positions: 120_000, assets: 1_974_066.67, netAssets: 1_974_066.67 } },
      },
    },
    {
      // 2,000,000 terminated at 2.40, all-in (bespoke: no accrued premium is exchanged): 48,000.00 received; cost out
      // 40,000.00; realized 8,000.00. The fixed independent amount does not change. Settles Mon 20 July.
      id: 'partial-termination', covers: ['reduce', 'partial termination'], action: 'close', lot: 'ftd', scope: 'strategy', percent: 40, order: { statedPrice: 2.40 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2_000_000, estimate: 2.4, model: 'stated-price', settleDate: '2026-07-20', cash: 48_000, accrued: 0, fees: 40 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2_000_000, avgPrice: 2.4 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2,000,000 FTD5-0628 @ 2.40 USD (realized 8,000.00 USD)' }],
        cash: { account: { USD: { settled: 1_604_066.67, unsettled: 47_960, availableToTrade: 1_652_026.67, availableToWithdraw: 1_604_066.67 } } },
        positions: [{ instrument: 'main', lot: 'ftd', qty: 3_000_000, cost: 60_000, avgCost: 2, price: 2.4, value: 72_000, unrealized: 12_000, notional: 3_000_000, margin: 250_000 }],
        holdings: { main: { long: 3_000_000, short: 0, net: 3_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-07-20', amount: 47_960, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 3_000_000, markValue: 72_000, iaRequired: 250_000, iaPosted: 250_000 }],
        pnl: { account: { realized: -37_833.33, commissions: -140, unrealized: 12_000, total: -25_973.33 } },
        nav: { account: 1_974_026.67, book: 4_974_026.67 },
        balance: { account: { cash: 1_604_066.67, margin: 250_000, receivable: 47_960, positions: 72_000, assets: 1_974_026.67, liabilities: 0, netAssets: 1_974_026.67 } },
      },
    },
    {
      id: 'settle-termination', covers: 'settlement', action: 'clock', to: at('2026-07-20'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 47,960.00 USD into settled cash', cash: { USD: 47_960 } }],
        cash: { account: { USD: { settled: 1_652_026.67, unsettled: 0, availableToTrade: 1_652_026.67, availableToWithdraw: 1_652_026.67 } } },
        pending: [],
        balance: { account: { cash: 1_652_026.67, receivable: null } },
      },
    },
    { id: 'final-price-day', action: 'clock', to: at('2026-08-20'), expect: {} },
    {
      id: 'first-default-physical', covers: ['credit event', 'first to default', 'physical settlement', 'collateral'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'credit_event', eventType: 'bankruptcy', eventDate: '2026-08-03', recovery: 0.20, entity: 'Pellworth Retail plc', settlement: 'physical', settleDate: '2026-08-25' },
      expect: {
        events: [
          { type: 'cds.credit_event', summary: 'Bankruptcy of Pellworth Retail plc on 2026-08-03 recorded by hand for FTD5-0628, physical settlement (simulated on paper), final price 20.000%; deliverable obligation Senior unsecured bonds or loans of the defaulted name (Bond or Loan), 3,000,000.00 USD face delivered against par (simulated on paper: the Terminal moves no securities; the obligation is taken as bought at the final price, 600,000.00 USD); accrued premium 18,333.33 USD; receivable 2,381,666.67 USD on 2026-08-25', owner: 'account', date: '2026-08-20' },
          { type: 'cds.terminated', summary: 'FTD5-0628 ended for this position: 1st default in the basket (Pellworth Retail plc), settled in full' },
          { type: 'cds.collateral', summary: `Collateral returned on ${FTD_NAME} under its position-level terms: 250,000.00 USD (independent amount, the position ended)`, cash: { USD: 250_000 } },
        ],
        cash: { account: { USD: { settled: 1_902_026.67, unsettled: 2_381_666.67, margin: 0, availableToTrade: 4_283_693.34, availableToWithdraw: 1_902_026.67 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-08-25', amount: 2_381_666.67, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 2_283_833.34, commissions: -140, unrealized: 0, total: 2_283_693.34 } }, // -37,833.33 + 2,381,666.67 - 60,000
        nav: { account: 4_283_693.34, book: 7_283_693.34 },
        balance: { account: { cash: 1_902_026.67, margin: null, receivable: 2_381_666.67, positions: null, assets: 4_283_693.34, liabilities: 0, netAssets: 4_283_693.34 } },
      },
    },
    {
      id: 'second-default-refused', covers: 'credit event', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'credit_event', eventType: 'failure_to_pay', recovery: 0.35, entity: 'Quillon Media Corp.' },
      status: 'blocked', reason: 'A first-to-default basket ends at its first default: nothing is left to protect.',
      expect: { refused: { engine: 'FTD5-0628 has ended (2026-08-03: 1st default in the basket (Pellworth Retail plc), settled in full). No further credit event is recorded on it.', api: 'FTD5-0628 has ended', browser: 'FTD5-0628 ended on 2026-08-03: 1st default in the basket (Pellworth Retail plc), settled in full. No further event is recorded on it.' } },
    },
    {
      // 2,000,000 - 100,100 - 45,833.33 + 47,960 + 2,381,666.67 = 4,283,693.34.
      id: 'physical-settlement-date', covers: ['settlement', 'physical settlement'], action: 'clock', to: at('2026-08-25'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 2,381,666.67 USD into settled cash', cash: { USD: 2_381_666.67 } }],
        cash: { account: { USD: { settled: 4_283_693.34, unsettled: 0, availableToTrade: 4_283_693.34, availableToWithdraw: 4_283_693.34 } } },
        pending: [],
        balance: { account: { cash: 4_283_693.34, receivable: null } },
      },
    },
    { id: 'nothing-left', covers: 'close', action: 'clock', to: at('2026-09-21'), expect: { events: [], positions: [], pending: [], lifecycle: [], otc: [], alerts: [] } },
  ],
};

// ---------------------------------------------------------------------------------------------
// cds_index_tranche
// ---------------------------------------------------------------------------------------------
// The 3%-7% tranche of a bespoke index of 25 names (4% each), standard contract, 500 bp running plus an upfront, maturity
// 20 June 2031. Protection SOLD on 10,000,000 of tranche notional to Dealer Q. Position-level terms: independent amount
// 10% of the tranche notional outstanding, no variation margin. Commission 20.00 per million; T+3 (USD calendar).
// Losses: index loss = weight x (1 - recovery) for each default; the tranche loses (loss - 3%) / 4% of its notional
// between the points, nothing below 3%, all of it at 7%. The tranche's outstanding share is its factor.
//   sold on Tue 21 April at 12.50: 1,250,000.00 received; accrued 20 March to the step-in date 22 April, 33 days, paid:
//     10,000,000 x 5% x 33/360 = 45,833.33; net 1,204,166.67 less 200.00 commission, settles Fri 24 April
//   Aldine Paper Co. bankrupt (11 May, recovery 0.50): index loss 2%, below the 3% attachment: nothing happens to the tranche
//   coupon Mon 22 June: 10,000,000 x 5% x 94/360 = 130,555.56 received (less the 45,833.33 paid at trade: 84,722.23)
//   Brennick Steel Corp. fails to pay (7 July, recovery 0.50): index loss 4%: (4% - 3%) / 4% = 25% of the tranche written
//     down: 2,500,000.00 paid to the buyer; the buyer pays the premium accrued on it from 22 June to 7 July included,
//     16 days: 2,500,000 x 5% x 16/360 = 5,555.56; net paid 2,494,444.44; cost share 1,250,000 x 25% = 312,500 realized;
//     factor 0.75; independent amount 10% x 7,500,000 = 750,000.00 (250,000.00 back)
//   coupon Mon 21 September: 7,500,000 x 5% x 91/360 = 94,791.67
//   Carrow Logistics plc bankrupt (13 October, recovery 0.25): index loss 4% + 3% = 7%, the detachment point: the 75% left is
//     written down, 7,500,000.00 paid; accrued 21 September to 13 October included, 23 days: 7,500,000 x 5% x 23/360 =
//     23,958.33 received; net paid 7,476,041.67; the tranche is exhausted and ends
const TR_NAME = 'MCX Bespoke 25 3-7% tranche 500bp 20 Jun 2031';
const cdsTranche = {
  productId: 'cds_index_tranche',
  title: 'Index tranche 3%-7%, protection sold: a default below the attachment leaves it untouched, the next writes it down by 25%, the third exhausts it',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Attachment point', 'Detachment point'],
    automaticInputs: ['coupon dates and full coupons on the tranche notional outstanding', 'premium accrued to the step-in date, exchanged at trade', 'index loss, the tranche writedown between the points, the tranche factor and its end when exhausted', 'premium accrued on the written-down part to the event date', 'settlement date T+3', 'commission', 'independent amount trued up on the outstanding notional'],
    manualInputs: ['attachment and detachment points', 'upfront per 100 (stated fill price)', 'marks per 100 of the outstanding notional entered by hand', 'each constituent credit event: kind, date, final price, weight in the index'],
    settlement: 'Upfront, accrued and commission T+3 on the USD calendar; coupons on the adjusted coupon dates; writedowns settled in cash on the day they are recorded',
    lifecycle: 'Sell protection on the tranche; a default whose loss stays below the attachment point changes nothing; a default inside the tranche writes it down by 25% (factor 0.75, smaller coupons); the default that takes the index loss to the detachment point exhausts the tranche and ends it',
    accounting: 'Carried at the mark per 100 of the notional outstanding less the upfront received; writedowns paid and the cost share of the written-down part realized; coupons realized; accrued premium paid at trade carried as accrued income until the coupon',
    collateral: 'Position-level terms: independent amount 10% of the tranche notional outstanding, posted at entry, a quarter returned with the writedown, the rest when the tranche is exhausted; no variation margin',
  },
  start: at('2026-04-21'),
  settlementCheck: { lag: 3, holidays: [] },
  book: {
    name: 'Matrix index tranche', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 15_000_000 }],
    account: { name: 'Structured credit', funding: [{ ccy: 'USD', amount: 10_000_000 }] },
    settings: { fees: { cds: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { cds: 3 } },
  },
  instruments: {
    main: {
      productId: 'cds_index_tranche', name: TR_NAME, symbol: 'MCXB25-3-7', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        referenceEntity: 'MCX Bespoke 25 (25 names, 4% each)', coupon: 0.05, effective: '2026-03-20', maturity: '2031-06-20', recovery: 0.4,
        convention: 'standard', creditEventSet: 'corporate', settlement: 'auction', attachment: 0.03, detachment: 0.07, counterparty: 'Dealer Q',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.10 }, variationMargin: false, threshold: 0, minimumTransfer: 0 },
      },
    },
  },
  expectAtStart: {
    cash: { account: { USD: { settled: 10_000_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 10_000_000, availableToWithdraw: 10_000_000 } }, treasury: { USD: { settled: 5_000_000 } } },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 10_000_000, treasury: 5_000_000, book: 15_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    otcTicket({
      id: 'sell-tranche-protection', covers: ['open', 'sell protection', 'accrued at trade', 'collateral'], instrument: 'main', side: 'sell', qty: 10_000_000, upfront: 12.50, as: 'tranche',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 10_000_000, estimate: 12.5, model: 'stated-price', settleDate: '2026-04-24', calendar: 'USD', cash: 1_204_166.67, accrued: -45_833.33, fees: 200 }], // 1,250,000 - 45,833.33
          cash: { USD: { fees: 200, margin: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000_000, avgPrice: 12.5 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 10,000,000 MCXB25-3-7 @ 12.50 USD; premium accrued from 2026-03-20 to the step-in date 2026-04-22 (33 days), 45,833.33 USD, paid to the counterparty with the settlement', owner: 'account', date: '2026-04-21' },
          { type: 'cds.collateral', summary: `Collateral posted on ${TR_NAME} under its position-level terms: 1,000,000.00 USD (independent amount, 10.00% of 10,000,000.00 USD notional)`, cash: { USD: -1_000_000 } },
        ],
        cash: { account: { USD: { settled: 9_000_000, unsettled: 1_203_966.67, margin: 1_000_000, availableToTrade: 10_203_966.67, availableToWithdraw: 9_000_000 } } },
        positions: [{ instrument: 'main', lot: 'tranche', owner: 'account', direction: 'protection sold', qty: -10_000_000, avgCost: 12.5, cost: -1_250_000, price: null, value: null, unrealized: null, provisional: true, notional: 10_000_000, margin: 1_000_000, accrued: 45_833.33 }],
        holdings: { main: { long: 0, short: 10_000_000, net: -10_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-04-24', amount: 1_203_966.67, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-06-22', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2031-06-20', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'tranche', owner: 'account', qty: -10_000_000, basis: 'position', iaRequired: 1_000_000, iaPosted: 1_000_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -200, unrealized: 0, total: -200 } },
        nav: { account: 9_999_800, book: 14_999_800 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 9_000_000, margin: 1_000_000, receivable: 1_203_966.67, positions: -1_250_000, accruedIncome: 45_833.33, assets: 9_999_800, liabilities: 0, netAssets: 9_999_800 } },
      },
    }),
    {
      id: 'mark-at-trade', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 12.50, note: 'Dealer Q upfront per 100 of tranche notional, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'tranche', price: 12.5, value: -1_250_000, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 12.5, markValue: -1_250_000 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-upfront', covers: 'settlement', action: 'clock', to: at('2026-04-24'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,203,966.67 USD into settled cash', cash: { USD: 1_203_966.67 } }],
        cash: { account: { USD: { settled: 10_203_966.67, unsettled: 0, availableToTrade: 10_203_966.67, availableToWithdraw: 10_203_966.67 } } },
        pending: [],
        balance: { account: { cash: 10_203_966.67, receivable: null } },
      },
    },
    { id: 'may', action: 'clock', to: at('2026-05-12'), expect: {} },
    {
      id: 'default-below-attachment', covers: ['credit event', 'loss below the attachment point'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'credit_event', eventType: 'bankruptcy', eventDate: '2026-05-11', recovery: 0.50, entity: 'Aldine Paper Co.', weight: 0.04, settlement: 'auction' },
      expect: {
        events: [{ type: 'cds.credit_event', summary: 'Bankruptcy of Aldine Paper Co. on 2026-05-11 recorded by hand for MCXB25-3-7, auction final price 50.000%; index loss 0.0000% to 2.0000%, below the attachment point 3.00%: the tranche is untouched; nothing paid', owner: 'account', date: '2026-05-12' }],
      },
    },
    {
      id: 'first-coupon', covers: 'premium', action: 'clock', to: at('2026-06-22'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium received on ${TR_NAME} for 2026-03-20 to 2026-06-21 included (94 days on 10,000,000.00 USD): 130,555.56 USD; the accrued premium of 45,833.33 USD exchanged at trade is settled with it`, cash: { USD: 130_555.56 } }],
        cash: { account: { USD: { settled: 10_334_522.23, availableToTrade: 10_334_522.23, availableToWithdraw: 10_334_522.23 } } },
        positions: [{ instrument: 'main', lot: 'tranche', accrued: 0 }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-09-21', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2031-06-20', status: 'pending' },
        ],
        pnl: { account: { realized: 84_722.23, total: 84_522.23 } },
        nav: { account: 10_084_522.23, book: 15_084_522.23 },
        balance: { account: { cash: 10_334_522.23, accruedIncome: null, assets: 10_084_522.23, netAssets: 10_084_522.23 } },
      },
    },
    { id: 'july', action: 'clock', to: at('2026-07-08'), expect: {} },
    {
      id: 'default-inside-the-tranche', covers: ['credit event', 'tranche writedown', 'collateral'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'credit_event', eventType: 'failure_to_pay', eventDate: '2026-07-07', recovery: 0.50, entity: 'Brennick Steel Corp.', weight: 0.04, settlement: 'auction' },
      expect: {
        events: [
          { type: 'cds.credit_event', summary: 'Failure to pay of Brennick Steel Corp. on 2026-07-07 recorded by hand for MCXB25-3-7, auction final price 50.000%; index loss 2.0000% to 4.0000%; 25.0000% of the tranche written down; outstanding 100.0000% to 75.0000%; protection 2,500,000.00 USD (2,500,000.00 USD x 100.000%); accrued premium 5,555.56 USD; paid 2,494,444.44 USD', owner: 'account' },
          { type: 'cds.collateral', summary: `Collateral returned on ${TR_NAME} under its position-level terms: 250,000.00 USD (independent amount, 10.00% of 7,500,000.00 USD notional)`, cash: { USD: 250_000 } },
        ],
        cash: { account: { USD: { settled: 8_090_077.79, margin: 750_000, availableToTrade: 8_090_077.79, availableToWithdraw: 8_090_077.79 } } }, // 10,334,522.23 - 2,494,444.44 + 250,000
        positions: [{ instrument: 'main', lot: 'tranche', qty: -10_000_000, cost: -937_500, avgCost: 12.5, price: 12.5, value: -937_500, unrealized: 0, notional: 7_500_000, margin: 750_000 }], // -1,250,000 + 312,500; -10,000,000 x 0.75 x 12.50 / 100
        otc: [{ instrument: 'main', markValue: -937_500, iaRequired: 750_000, iaPosted: 750_000 }],
        pnl: { account: { realized: -2_097_222.21, total: -2_097_422.21 } }, // 84,722.23 - 2,494,444.44 + 312,500
        nav: { account: 7_902_577.79, book: 12_902_577.79 },
        balance: { account: { cash: 8_090_077.79, margin: 750_000, positions: -937_500, assets: 7_902_577.79, netAssets: 7_902_577.79 } },
      },
    },
    {
      id: 'mark-after-the-writedown', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 40.00, note: 'Dealer Q upfront per 100 of tranche notional outstanding, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'tranche', price: 40, value: -3_000_000, unrealized: -2_062_500 }], // -10,000,000 x 0.75 x 40 / 100
        otc: [{ instrument: 'main', mark: 40, markValue: -3_000_000 }],
        pnl: { account: { unrealized: -2_062_500, total: -4_159_922.21 } },
        nav: { account: 5_840_077.79, book: 10_840_077.79 },
        balance: { account: { positions: -3_000_000, assets: 5_840_077.79, netAssets: 5_840_077.79 } },
      },
    },
    {
      id: 'coupon-on-the-written-down-tranche', covers: ['premium', 'tranche factor'], action: 'clock', to: at('2026-09-21'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium received on ${TR_NAME} for 2026-06-22 to 2026-09-20 included (91 days on 7,500,000.00 USD): 94,791.67 USD`, cash: { USD: 94_791.67 } }],
        cash: { account: { USD: { settled: 8_184_869.46, availableToTrade: 8_184_869.46, availableToWithdraw: 8_184_869.46 } } },
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-12-21', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2031-06-20', status: 'pending' },
        ],
        pnl: { account: { realized: -2_002_430.54, total: -4_065_130.54 } },
        nav: { account: 5_934_869.46, book: 10_934_869.46 },
        balance: { account: { cash: 8_184_869.46, assets: 5_934_869.46, netAssets: 5_934_869.46 } },
      },
    },
    { id: 'october', action: 'clock', to: at('2026-10-14'), expect: {} },
    {
      id: 'default-exhausts-the-tranche', covers: ['credit event', 'tranche exhausted', 'collateral', 'close'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'credit_event', eventType: 'bankruptcy', eventDate: '2026-10-13', recovery: 0.25, entity: 'Carrow Logistics plc', weight: 0.04, settlement: 'auction' },
      expect: {
        events: [
          { type: 'cds.credit_event', summary: 'Bankruptcy of Carrow Logistics plc on 2026-10-13 recorded by hand for MCXB25-3-7, auction final price 25.000%; index loss 4.0000% to 7.0000%; 75.0000% of the tranche written down; outstanding 75.0000% to 0.0000%; protection 7,500,000.00 USD (7,500,000.00 USD x 100.000%); accrued premium 23,958.33 USD; paid 7,476,041.67 USD' },
          { type: 'cds.terminated', summary: 'MCXB25-3-7 ended for this position: the tranche is exhausted (index loss 7.0000% reached the detachment point 7.00%)' },
          { type: 'cds.collateral', summary: `Collateral returned on ${TR_NAME} under its position-level terms: 750,000.00 USD (independent amount, the position ended)`, cash: { USD: 750_000 } },
        ],
        cash: { account: { USD: { settled: 1_458_827.79, margin: 0, availableToTrade: 1_458_827.79, availableToWithdraw: 1_458_827.79 } } }, // 8,184,869.46 - 7,476,041.67 + 750,000
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pnl: { account: { realized: -8_540_972.21, commissions: -200, unrealized: 0, total: -8_541_172.21 } }, // -2,002,430.54 - 7,476,041.67 + 937,500
        nav: { account: 1_458_827.79, book: 6_458_827.79 },
        balance: { account: { cash: 1_458_827.79, margin: null, positions: null, assets: 1_458_827.79, liabilities: 0, netAssets: 1_458_827.79 } },
      },
    },
    {
      // 1,250,000 upfront; premium -45,833.33 + 130,555.56 + 5,555.56 + 94,791.67 + 23,958.33; writedowns -10,000,000; commission -200.
      id: 'nothing-left', covers: 'close', action: 'clock', to: at('2026-12-21'),
      expect: { events: [], positions: [], pending: [], lifecycle: [], otc: [], alerts: [] },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// loan_cds
// ---------------------------------------------------------------------------------------------
// A bespoke US loan CDS on the syndicated secured first-lien term loan of Tamarind Foods Holdings LLC, 500 bp, effective
// Thursday 28 May 2026, maturity 20 June 2029; credit events bankruptcy and failure to pay; settled at the loan auction's
// final price; cancellable: if the reference loans are repaid and not replaced, the contract is cancelled with no
// protection payment (recorded by hand). The first roll date, 20 June, is only 23 days after the effective date, so the
// contract takes a LONG first stub, to 20 September. Bespoke convention: accrual dates not adjusted, premium from the
// effective date for a trade dealt the day before, nothing exchanged at trade, terminations at an all-in amount.
// Explicitly uncollateralized (paper assumption). Commission 20.00 per million; T+3 (USD calendar).
//   bought 8,000,000 on Wed 27 May at 1.00: 80,000.00; settles Mon 1 June
//   long first stub, 28 May to 20 September, 115 days: 8,000,000 x 5% x 115/360 = 127,777.78, paid Mon 21 September
//   2,000,000 terminated on Wed 14 October at 0.75 all-in: 15,000.00 received against 20,000.00 of cost: realized -5,000
//   cancelled on refinancing on Mon 16 November (recorded Wed 18 November): premium 20 September to 16 November (excluded),
//     57 days on 6,000,000: 47,500.00 paid; no protection; the 60,000.00 of cost left realized
const LCDS_NAME = 'Tamarind Foods 1L term loan LCDS 500bp 20 Jun 2029';
const loanCds = {
  productId: 'loan_cds',
  title: 'Bespoke cancellable loan CDS with a long first stub, uncollateralized: premium, partial termination, cancelled on refinancing',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'First period (long stub)', 'Cancellable on refinancing'],
    automaticInputs: ['premium schedule from the effective date with a long first stub, on the USD calendar', 'premium from the effective date for a trade dealt the day before', 'settlement date T+3', 'commission', 'premium accrued to the cancellation date'],
    manualInputs: ['the long first stub and cancellability (contract terms)', 'upfront and the all-in termination amount (stated fill prices)', 'marks per 100 entered by hand', 'the cancellation on refinancing: date and note'],
    settlement: 'Upfront and termination amounts T+3 on the USD calendar; premium on the next business day after each roll date; the accrued premium of the cancellation in cash on the day it is recorded',
    lifecycle: 'Buy protection; long first stub; partial termination; cancellation on refinancing recorded by hand ends the contract with no protection payment; a credit event afterwards refused',
    accounting: 'Carried at the mark less the upfront; premiums realized; on cancellation the accrued premium is paid and the cost left is realized; commission expensed',
    collateral: 'Uncollateralized, stated on the contract as an explicit paper assumption: nothing posted or received',
  },
  start: at('2026-05-27'),
  settlementCheck: { lag: 3, holidays: [] },
  book: {
    name: 'Matrix loan CDS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Leveraged loans', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { cds: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { cds: 3 } },
  },
  instruments: {
    main: {
      productId: 'loan_cds', name: LCDS_NAME, symbol: 'TMRND-LCDS-0629', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        referenceEntity: 'Tamarind Foods Holdings LLC', seniority: 'Syndicated secured first-lien term loan', coupon: 0.05, effective: '2026-05-28', maturity: '2029-06-20', recovery: 0.7,
        convention: 'bespoke', firstStub: 'long', creditEventSet: 'corporate_xr', settlement: 'auction', cancellable: true, counterparty: 'Dealer L',
        collateralBasis: { type: 'uncollateralized' },
      },
    },
  },
  expectAtStart: {
    cash: { account: { USD: { settled: 1_000_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 1_000_000, availableToWithdraw: 1_000_000 } }, treasury: { USD: { settled: 2_000_000 } } },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 1_000_000, treasury: 2_000_000, book: 3_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    otcTicket({
      id: 'buy-loan-protection', covers: ['open', 'buy protection'], instrument: 'main', side: 'buy', qty: 8_000_000, upfront: 1.00, as: 'lcds',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 8_000_000, estimate: 1, model: 'stated-price', settleDate: '2026-06-01', calendar: 'USD', cash: -80_000, accrued: 0, fees: 160 }],
          cash: { USD: { fees: 160, margin: 0, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 8_000_000, avgPrice: 1 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 8,000,000 TMRND-LCDS-0629 @ 1.00 USD', owner: 'account', date: '2026-05-27' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -80_160, availableToTrade: 919_840, availableToWithdraw: 919_840 } } },
        positions: [{ instrument: 'main', lot: 'lcds', owner: 'account', direction: 'protection bought', qty: 8_000_000, avgCost: 1, cost: 80_000, price: null, value: null, unrealized: null, provisional: true, notional: 8_000_000, margin: 0, accrued: 0 }],
        holdings: { main: { long: 8_000_000, short: 0, net: 8_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-06-01', amount: -80_160, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-09-21', status: 'pending' }, // the long first stub: no payment on 22 June
          { type: 'cds.maturity', instrument: 'main', dueDate: '2029-06-20', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'lcds', owner: 'account', qty: 8_000_000, basis: 'uncollateralized', iaRequired: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }], // nothing is required under the paper assumption
        pnl: { account: { realized: 0, commissions: -160, unrealized: 0, total: -160 } },
        nav: { account: 999_840, book: 2_999_840 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_000_000, positions: 80_000, payable: 80_160, assets: 1_080_000, liabilities: 80_160, netAssets: 999_840 } },
      },
    }),
    {
      id: 'mark-at-trade', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 1.00, note: 'Dealer L upfront per 100, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'lcds', price: 1, value: 80_000, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 1, markValue: 80_000 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-upfront', covers: 'settlement', action: 'clock', to: at('2026-06-01'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 80,160.00 USD from settled cash', cash: { USD: -80_160 } }],
        cash: { account: { USD: { settled: 919_840, unsettled: 0, availableToTrade: 919_840, availableToWithdraw: 919_840 } } },
        pending: [],
        balance: { account: { cash: 919_840, payable: null, assets: 999_840, liabilities: 0 } },
      },
    },
    { id: 'no-payment-on-the-first-roll-date', covers: 'long first stub', action: 'clock', to: at('2026-06-23'), expect: {} },
    {
      // 28 May to 20 September, 115 days: 8,000,000 x 5% x 115/360 = 127,777.78, paid Mon 21 September (20th a Sunday).
      id: 'first-premium-long-stub', covers: ['premium', 'long first stub'], action: 'clock', to: at('2026-09-21'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium paid on ${LCDS_NAME} for 2026-05-28 to 2026-09-20: 127,777.78 USD`, cash: { USD: -127_777.78 }, owner: 'account', date: '2026-09-21' }],
        cash: { account: { USD: { settled: 792_062.22, availableToTrade: 792_062.22, availableToWithdraw: 792_062.22 } } },
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-12-21', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2029-06-20', status: 'pending' },
        ],
        pnl: { account: { realized: -127_777.78, total: -127_937.78 } },
        nav: { account: 872_062.22, book: 2_872_062.22 },
        balance: { account: { cash: 792_062.22, assets: 872_062.22, netAssets: 872_062.22 } },
      },
    },
    { id: 'mid-october', action: 'clock', to: at('2026-10-14'), expect: {} },
    {
      id: 'mark-tighter', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 0.75, note: 'Dealer L upfront per 100, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'lcds', price: 0.75, value: 60_000, unrealized: -20_000 }],
        otc: [{ instrument: 'main', mark: 0.75, markValue: 60_000 }],
        pnl: { account: { unrealized: -20_000, total: -147_937.78 } },
        nav: { account: 852_062.22, book: 2_852_062.22 },
        balance: { account: { positions: 60_000, assets: 852_062.22, netAssets: 852_062.22 } },
      },
    },
    {
      id: 'partial-termination', covers: ['reduce', 'partial termination'], action: 'close', lot: 'lcds', scope: 'strategy', percent: 25, order: { statedPrice: 0.75 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2_000_000, estimate: 0.75, model: 'stated-price', settleDate: '2026-10-19', cash: 15_000, accrued: 0, fees: 40 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2_000_000, avgPrice: 0.75 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2,000,000 TMRND-LCDS-0629 @ 0.75 USD (realized -5,000.00 USD)' }],
        cash: { account: { USD: { settled: 792_062.22, unsettled: 14_960, availableToTrade: 807_022.22, availableToWithdraw: 792_062.22 } } },
        positions: [{ instrument: 'main', lot: 'lcds', qty: 6_000_000, cost: 60_000, avgCost: 1, price: 0.75, value: 45_000, unrealized: -15_000, notional: 6_000_000 }],
        holdings: { main: { long: 6_000_000, short: 0, net: 6_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-10-19', amount: 14_960, ccy: 'USD', into: 'cash' }],
        otc: [{ instrument: 'main', qty: 6_000_000, markValue: 45_000 }],
        pnl: { account: { realized: -132_777.78, commissions: -200, unrealized: -15_000, total: -147_977.78 } },
        nav: { account: 852_022.22, book: 2_852_022.22 },
        balance: { account: { cash: 792_062.22, receivable: 14_960, positions: 45_000, assets: 852_022.22, netAssets: 852_022.22 } },
      },
    },
    {
      id: 'settle-termination', covers: 'settlement', action: 'clock', to: at('2026-10-19'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 14,960.00 USD into settled cash', cash: { USD: 14_960 } }],
        cash: { account: { USD: { settled: 807_022.22, unsettled: 0, availableToTrade: 807_022.22, availableToWithdraw: 807_022.22 } } },
        pending: [],
        balance: { account: { cash: 807_022.22, receivable: null } },
      },
    },
    { id: 'refinancing-known', action: 'clock', to: at('2026-11-18'), expect: {} },
    {
      // 20 September to 16 November, 57 days, on 6,000,000: 47,500.00 paid; no protection; 60,000.00 of cost realized.
      id: 'cancelled-on-refinancing', covers: ['cancellation on refinancing', 'close'], action: 'instrument_lifecycle', instrument: 'main',
      body: { action: 'cancel', date: '2026-11-16', note: 'Refinanced by a new term loan B arranged by Dealer L' },
      expect: {
        events: [
          { type: 'cds.cancelled', summary: `TMRND-LCDS-0629 cancelled on 2026-11-16, recorded by hand: the reference loans of Tamarind Foods Holdings LLC were repaid and not replaced (Refinanced by a new term loan B arranged by Dealer L). No protection is paid; accrued premium 47,500.00 USD to the cancellation date; paid 47,500.00 USD`, cash: { USD: -47_500 }, owner: 'account', date: '2026-11-18' },
          { type: 'cds.terminated', summary: 'TMRND-LCDS-0629 ended for this position: cancelled on refinancing: the reference loans of Tamarind Foods Holdings LLC were repaid and not replaced' },
        ],
        cash: { account: { USD: { settled: 759_522.22, availableToTrade: 759_522.22, availableToWithdraw: 759_522.22 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pnl: { account: { realized: -240_277.78, unrealized: 0, total: -240_477.78 } }, // -132,777.78 - 47,500 - 60,000
        nav: { account: 759_522.22, book: 2_759_522.22 },
        balance: { account: { cash: 759_522.22, positions: null, assets: 759_522.22, liabilities: 0, netAssets: 759_522.22 } },
      },
    },
    {
      id: 'credit-event-after-cancellation', covers: 'credit event', action: 'instrument_lifecycle', instrument: 'main', body: { action: 'credit_event', eventType: 'bankruptcy', recovery: 0.6 },
      status: 'blocked', reason: 'A cancelled loan CDS gives no further protection.',
      expect: { refused: { engine: 'TMRND-LCDS-0629 has ended (2026-11-16: cancelled on refinancing: the reference loans of Tamarind Foods Holdings LLC were repaid and not replaced (Refinanced by a new term loan B arranged by Dealer L)). No further credit event is recorded on it.', api: 'TMRND-LCDS-0629 has ended', browser: 'TMRND-LCDS-0629 ended on 2026-11-16: cancelled on refinancing' } },
    },
    {
      // 1,000,000 - 80,160 - 127,777.78 + 14,960 - 47,500 = 759,522.22.
      id: 'nothing-left', covers: 'close', action: 'clock', to: at('2026-12-21'),
      expect: { events: [], positions: [], pending: [], lifecycle: [], otc: [], alerts: [] },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// abs_cds
// ---------------------------------------------------------------------------------------------
// A pay-as-you-go CDS on the class M5 notes of Harrow Mortgage Trust 2006-HE2 (subprime RMBS mezzanine), 500 bp, effective
// Thursday 25 June 2026, legal final 25 June 2036. ABS conventions: the premium is paid MONTHLY on the 25th (the
// reference obligation's distribution day; the next business day when the 25th is not one), on the outstanding notional
// (notional x the factor of the reference obligation); the reference obligation's writedowns, principal and interest
// shortfalls are paid by the protection seller as they happen, their reimbursements by the buyer, and its amortization
// reduces the notional with nothing paid: each recorded by hand. Bespoke: accrual dates not adjusted, premium from the
// effective date, terminations all-in. Dealer R; position-level terms: independent amount 20% of the notional outstanding.
// Commission 20.00 per million of notional; T+3 (USD calendar).
//   bought 5,000,000 on Wed 24 June at 10.00: 500,000.00; settles Mon 29 June
//   premium Mon 27 July (25th a Saturday): 25 June to 25 July, 30 days: 5,000,000 x 5% x 30/360 = 20,833.33
//   interest shortfall 0.12 per 100 (10 August): 5,000,000 x 0.12 / 100 = 6,000.00 from the seller
//   premium Tue 25 August: 31 days: 21,527.78; writedown of 4.00 per 100 with the 25 August distribution: 200,000.00 from
//     the seller, factor 0.96 (no premium accrued since that day's payment); cost 500,000 x 4% = 20,000 realized
//   writedown reimbursement 1.00 per 100 (10 September): 50,000.00 to the seller, factor back to 0.97
//   premium Fri 25 September on 4,850,000, 31 days: 4,850,000 x 5% x 31/360 = 20,881.94; the reference obligation amortizes
//     from 0.97 to 0.90 with that distribution: nothing paid; the cost of the amortized part, 480,000 x 0.07/0.97 =
//     34,639.18, realized
//   terminated on Wed 14 October at 30.00 per 100 of the 4,500,000 outstanding, all-in: 1,350,000.00 received against the
//     445,360.82 of cost left: realized 904,639.18; settles Mon 19 October
const ABS_NAME = 'Harrow Mortgage Trust 2006-HE2 M5 PAYGO CDS 500bp';
const absCds = {
  productId: 'abs_cds',
  title: 'Pay-as-you-go ABS CDS: monthly premium on the outstanding notional; interest shortfall, writedown, reimbursement and amortization recorded by hand; terminated',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Reference obligation', 'Monthly payment day'],
    automaticInputs: ['monthly premium dates on the 25th (next business day) and the amount on the outstanding notional', 'premium from the effective date', 'settlement date T+3', 'commission', 'independent amount trued up on the outstanding notional'],
    manualInputs: ['reference obligation and the monthly payment day', 'upfront and the all-in termination amount (stated fill prices)', 'marks per 100 of the outstanding notional entered by hand', 'each pay-as-you-go event: kind, amount per 100 of original notional (or the new factor), date'],
    settlement: 'Upfront and termination T+3 on the USD calendar; monthly premium on the 25th or the next business day; pay-as-you-go amounts in cash on the day they are recorded',
    lifecycle: 'Buy protection; monthly premiums; an interest shortfall paid by the seller; a writedown paid by the seller (factor down); its partial reimbursement paid by the buyer (factor up); amortization of the reference obligation (factor down, nothing paid); termination at a stated amount; nothing scheduled afterwards',
    accounting: 'Carried at the mark per 100 of the outstanding notional less the upfront; shortfalls, writedowns, reimbursements and premiums realized; the cost of written-down and amortized notional realized; commission expensed',
    collateral: 'Position-level terms: independent amount 20% of the notional outstanding, trued up after each change of factor (40,000 back, 10,000 posted, 70,000 back) and returned on termination; no variation margin',
  },
  start: at('2026-06-24'),
  settlementCheck: { lag: 3, holidays: [] },
  book: {
    name: 'Matrix ABS CDS', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Securitised credit', funding: [{ ccy: 'USD', amount: 3_000_000 }] },
    settings: { fees: { cds: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: { cds: 3 } },
  },
  instruments: {
    main: {
      productId: 'abs_cds', name: ABS_NAME, symbol: 'HMT06-M5-CDS', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
      conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
      terms: {
        referenceEntity: 'Harrow Mortgage Trust 2006-HE2', referenceObligation: 'Harrow Mortgage Trust 2006-HE2 class M5 notes (subprime RMBS mezzanine)', coupon: 0.05, effective: '2026-06-25', maturity: '2036-06-25', recovery: 0.4,
        convention: 'bespoke', firstStub: 'short', paymentDay: 25, creditEventSet: 'abs', settlement: 'cash', counterparty: 'Dealer R',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.20 }, variationMargin: false, threshold: 0, minimumTransfer: 0 },
      },
    },
  },
  expectAtStart: {
    cash: { account: { USD: { settled: 3_000_000, unsettled: 0, margin: 0, restricted: 0, availableToTrade: 3_000_000, availableToWithdraw: 3_000_000 } }, treasury: { USD: { settled: 2_000_000 } } },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
    nav: { account: 3_000_000, treasury: 2_000_000, book: 5_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    otcTicket({
      id: 'buy-abs-protection', covers: ['open', 'buy protection', 'collateral'], instrument: 'main', side: 'buy', qty: 5_000_000, upfront: 10.00, as: 'abs',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 10, model: 'stated-price', settleDate: '2026-06-29', calendar: 'USD', cash: -500_000, accrued: 0, fees: 100 }],
          cash: { USD: { fees: 100, margin: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5_000_000, avgPrice: 10 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 5,000,000 HMT06-M5-CDS @ 10.00 USD', owner: 'account', date: '2026-06-24' },
          { type: 'cds.collateral', summary: `Collateral posted on ${ABS_NAME} under its position-level terms: 1,000,000.00 USD (independent amount, 20.00% of 5,000,000.00 USD notional)`, cash: { USD: -1_000_000 } },
        ],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -500_100, margin: 1_000_000, availableToTrade: 1_499_900, availableToWithdraw: 1_499_900 } } },
        positions: [{ instrument: 'main', lot: 'abs', owner: 'account', direction: 'protection bought', qty: 5_000_000, avgCost: 10, cost: 500_000, price: null, value: null, unrealized: null, provisional: true, notional: 5_000_000, margin: 1_000_000, accrued: 0 }],
        holdings: { main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-06-29', amount: -500_100, ccy: 'USD', into: 'cash' }],
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-07-27', status: 'pending' }, // 25 July is a Saturday
          { type: 'cds.maturity', instrument: 'main', dueDate: '2036-06-25', status: 'pending' },
        ],
        otc: [{ instrument: 'main', lot: 'abs', owner: 'account', qty: 5_000_000, basis: 'position', iaRequired: 1_000_000, iaPosted: 1_000_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -100, unrealized: 0, total: -100 } },
        nav: { account: 2_999_900, book: 4_999_900 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 2_000_000, margin: 1_000_000, positions: 500_000, payable: 500_100, assets: 3_500_000, liabilities: 500_100, netAssets: 2_999_900 } },
      },
    }),
    {
      id: 'mark-at-trade', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 10.00, note: 'Dealer R upfront per 100 of the outstanding notional, by hand',
      expect: { positions: [{ instrument: 'main', lot: 'abs', price: 10, value: 500_000, unrealized: 0, provisional: false }], otc: [{ instrument: 'main', mark: 10, markValue: 500_000 }], provisional: { account: false, book: false } },
    },
    {
      id: 'settle-upfront', covers: 'settlement', action: 'clock', to: at('2026-06-29'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 500,100.00 USD from settled cash', cash: { USD: -500_100 } }],
        cash: { account: { USD: { settled: 1_499_900, unsettled: 0, availableToTrade: 1_499_900, availableToWithdraw: 1_499_900 } } },
        pending: [],
        balance: { account: { cash: 1_499_900, payable: null, assets: 2_999_900, liabilities: 0 } },
      },
    },
    {
      id: 'july-premium', covers: ['premium', 'monthly payment'], action: 'clock', to: at('2026-07-27'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium paid on ${ABS_NAME} for 2026-06-25 to 2026-07-25: 20,833.33 USD`, cash: { USD: -20_833.33 }, date: '2026-07-27' }],
        cash: { account: { USD: { settled: 1_479_066.67, availableToTrade: 1_479_066.67, availableToWithdraw: 1_479_066.67 } } },
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-08-25', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2036-06-25', status: 'pending' },
        ],
        pnl: { account: { realized: -20_833.33, total: -20_933.33 } },
        nav: { account: 2_979_066.67, book: 4_979_066.67 },
        balance: { account: { cash: 1_479_066.67, assets: 2_979_066.67, netAssets: 2_979_066.67 } },
      },
    },
    { id: 'early-august', action: 'clock', to: at('2026-08-10'), expect: {} },
    {
      id: 'interest-shortfall', covers: ['pay-as-you-go', 'interest shortfall'], action: 'instrument_lifecycle', instrument: 'main', body: { action: 'paygo', kind: 'interest_shortfall', amount: 0.12, date: '2026-08-10' },
      expect: {
        events: [{ type: 'cds.paygo', summary: 'Interest shortfall on Harrow Mortgage Trust 2006-HE2 class M5 notes (subprime RMBS mezzanine) recorded by hand for HMT06-M5-CDS (2026-08-10); 6,000.00 USD (0.12 per 100 of 5,000,000.00 USD) paid by the protection seller; received 6,000.00 USD', cash: { USD: 6_000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 1_485_066.67, availableToTrade: 1_485_066.67, availableToWithdraw: 1_485_066.67 } } },
        pnl: { account: { realized: -14_833.33, total: -14_933.33 } },
        nav: { account: 2_985_066.67, book: 4_985_066.67 },
        balance: { account: { cash: 1_485_066.67, assets: 2_985_066.67, netAssets: 2_985_066.67 } },
      },
    },
    {
      id: 'august-premium', covers: ['premium', 'monthly payment'], action: 'clock', to: at('2026-08-25'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium paid on ${ABS_NAME} for 2026-07-25 to 2026-08-25: 21,527.78 USD`, cash: { USD: -21_527.78 } }], // 5,000,000 x 5% x 31/360
        cash: { account: { USD: { settled: 1_463_538.89, availableToTrade: 1_463_538.89, availableToWithdraw: 1_463_538.89 } } },
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-09-25', status: 'pending' },
          { type: 'cds.maturity', instrument: 'main', dueDate: '2036-06-25', status: 'pending' },
        ],
        pnl: { account: { realized: -36_361.11, total: -36_461.11 } },
        nav: { account: 2_963_538.89, book: 4_963_538.89 },
        balance: { account: { cash: 1_463_538.89, assets: 2_963_538.89, netAssets: 2_963_538.89 } },
      },
    },
    { id: 'distribution-report', action: 'clock', to: at('2026-08-26'), expect: {} },
    {
      id: 'writedown', covers: ['pay-as-you-go', 'writedown', 'collateral'], action: 'instrument_lifecycle', instrument: 'main', body: { action: 'paygo', kind: 'writedown', amount: 4, date: '2026-08-25' },
      expect: {
        events: [
          { type: 'cds.paygo', summary: 'Writedown on Harrow Mortgage Trust 2006-HE2 class M5 notes (subprime RMBS mezzanine) recorded by hand for HMT06-M5-CDS (2026-08-25); 200,000.00 USD (4 per 100 of 5,000,000.00 USD) paid by the protection seller; factor 1 to 0.96; received 200,000.00 USD', cash: { USD: 200_000 } },
          { type: 'cds.collateral', summary: `Collateral returned on ${ABS_NAME} under its position-level terms: 40,000.00 USD (independent amount, 20.00% of 4,800,000.00 USD notional)`, cash: { USD: 40_000 } },
        ],
        cash: { account: { USD: { settled: 1_703_538.89, margin: 960_000, availableToTrade: 1_703_538.89, availableToWithdraw: 1_703_538.89 } } },
        positions: [{ instrument: 'main', lot: 'abs', cost: 480_000, avgCost: 10, value: 480_000, unrealized: 0, notional: 4_800_000, margin: 960_000 }], // 5,000,000 x 0.96 x 10 / 100
        otc: [{ instrument: 'main', markValue: 480_000, iaRequired: 960_000, iaPosted: 960_000 }],
        pnl: { account: { realized: 143_638.89, total: 143_538.89 } }, // -36,361.11 + 200,000 - 20,000
        nav: { account: 3_143_538.89, book: 5_143_538.89 },
        balance: { account: { cash: 1_703_538.89, margin: 960_000, positions: 480_000, assets: 3_143_538.89, netAssets: 3_143_538.89 } },
      },
    },
    { id: 'september', action: 'clock', to: at('2026-09-10'), expect: {} },
    {
      id: 'writedown-reimbursement', covers: ['pay-as-you-go', 'writedown reimbursement', 'collateral'], action: 'instrument_lifecycle', instrument: 'main', body: { action: 'paygo', kind: 'writedown_reimbursement', amount: 1, date: '2026-09-10' },
      expect: {
        events: [
          { type: 'cds.paygo', summary: 'Writedown reimbursement on Harrow Mortgage Trust 2006-HE2 class M5 notes (subprime RMBS mezzanine) recorded by hand for HMT06-M5-CDS (2026-09-10); 50,000.00 USD (1 per 100 of 5,000,000.00 USD) paid by the protection buyer; factor 0.96 to 0.97; paid 50,000.00 USD', cash: { USD: -50_000 } },
          { type: 'cds.collateral', summary: `Collateral posted on ${ABS_NAME} under its position-level terms: 10,000.00 USD (independent amount, 20.00% of 4,850,000.00 USD notional)`, cash: { USD: -10_000 } },
        ],
        cash: { account: { USD: { settled: 1_643_538.89, margin: 970_000, availableToTrade: 1_643_538.89, availableToWithdraw: 1_643_538.89 } } },
        positions: [{ instrument: 'main', lot: 'abs', cost: 480_000, avgCost: 9.896907, value: 485_000, unrealized: 5_000, notional: 4_850_000, margin: 970_000 }], // 480,000 / 48,500
        otc: [{ instrument: 'main', markValue: 485_000, iaRequired: 970_000, iaPosted: 970_000 }],
        pnl: { account: { realized: 93_638.89, unrealized: 5_000, total: 98_538.89 } },
        nav: { account: 3_098_538.89, book: 5_098_538.89 },
        balance: { account: { cash: 1_643_538.89, margin: 970_000, positions: 485_000, assets: 3_098_538.89, netAssets: 3_098_538.89 } },
      },
    },
    {
      id: 'september-premium', covers: ['premium', 'monthly payment'], action: 'clock', to: at('2026-09-25'),
      expect: {
        events: [{ type: 'cds.premium', summary: `CDS premium paid on ${ABS_NAME} for 2026-08-25 to 2026-09-25: 20,881.94 USD`, cash: { USD: -20_881.94 } }],
        cash: { account: { USD: { settled: 1_622_656.95, availableToTrade: 1_622_656.95, availableToWithdraw: 1_622_656.95 } } },
        lifecycle: [
          { type: 'cds.premium', instrument: 'main', dueDate: '2026-10-26', status: 'pending' }, // 25 October is a Sunday
          { type: 'cds.maturity', instrument: 'main', dueDate: '2036-06-25', status: 'pending' },
        ],
        pnl: { account: { realized: 72_756.95, total: 77_656.95 } },
        nav: { account: 3_077_656.95, book: 5_077_656.95 },
        balance: { account: { cash: 1_622_656.95, assets: 3_077_656.95, netAssets: 3_077_656.95 } },
      },
    },
    { id: 'amortization-reported', action: 'clock', to: at('2026-09-28'), expect: {} },
    {
      id: 'amortization', covers: ['pay-as-you-go', 'amortization', 'collateral'], action: 'instrument_lifecycle', instrument: 'main', body: { action: 'paygo', kind: 'amortization', amount: 0.90, date: '2026-09-25' },
      expect: {
        events: [
          { type: 'cds.paygo', summary: 'Amortization of the reference obligation on Harrow Mortgage Trust 2006-HE2 class M5 notes (subprime RMBS mezzanine) recorded by hand for HMT06-M5-CDS (2026-09-25); factor 0.97 to 0.9, nothing paid for it; nothing to settle' },
          { type: 'cds.collateral', summary: `Collateral returned on ${ABS_NAME} under its position-level terms: 70,000.00 USD (independent amount, 20.00% of 4,500,000.00 USD notional)`, cash: { USD: 70_000 } },
        ],
        cash: { account: { USD: { settled: 1_692_656.95, margin: 900_000, availableToTrade: 1_692_656.95, availableToWithdraw: 1_692_656.95 } } },
        positions: [{ instrument: 'main', lot: 'abs', cost: 445_360.82, avgCost: 9.896907, value: 450_000, unrealized: 4_639.18, notional: 4_500_000, margin: 900_000 }],
        otc: [{ instrument: 'main', markValue: 450_000, iaRequired: 900_000, iaPosted: 900_000 }],
        pnl: { account: { realized: 38_117.77, unrealized: 4_639.18, total: 42_656.95 } }, // 72,756.95 - 34,639.18
        nav: { account: 3_042_656.95, book: 5_042_656.95 },
        balance: { account: { cash: 1_692_656.95, margin: 900_000, positions: 450_000, assets: 3_042_656.95, netAssets: 3_042_656.95 } },
      },
    },
    { id: 'mid-october', action: 'clock', to: at('2026-10-14'), expect: {} },
    {
      id: 'mark-wider', covers: 'manual mark', action: 'manual_price', instrument: 'main', value: 30.00, note: 'Dealer R upfront per 100 of the outstanding notional, by hand',
      expect: {
        positions: [{ instrument: 'main', lot: 'abs', price: 30, value: 1_350_000, unrealized: 904_639.18 }], // 5,000,000 x 0.90 x 30 / 100
        otc: [{ instrument: 'main', mark: 30, markValue: 1_350_000 }],
        pnl: { account: { unrealized: 904_639.18, total: 942_656.95 } },
        nav: { account: 3_942_656.95, book: 5_942_656.95 },
        balance: { account: { positions: 1_350_000, assets: 3_942_656.95, netAssets: 3_942_656.95 } },
      },
    },
    {
      id: 'terminate', covers: ['close', 'full termination', 'collateral'], action: 'close', lot: 'abs', scope: 'position', percent: 100, order: { statedPrice: 30.00 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 5_000_000, estimate: 30, model: 'stated-price', settleDate: '2026-10-19', cash: 1_350_000, accrued: 0, fees: 100, notional: 4_500_000 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 5_000_000, avgPrice: 30 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 5,000,000 HMT06-M5-CDS @ 30.00 USD (realized 904,639.18 USD)' },
          { type: 'cds.collateral', summary: `Collateral returned on ${ABS_NAME} under its position-level terms: 900,000.00 USD (independent amount, the position ended)`, cash: { USD: 900_000 } },
        ],
        cash: { account: { USD: { settled: 2_592_656.95, unsettled: 1_349_900, margin: 0, availableToTrade: 3_942_556.95, availableToWithdraw: 2_592_656.95 } } },
        positions: [], holdings: { main: null }, lifecycle: [], otc: [],
        pending: [{ instrument: 'main', owner: 'account', dueDate: '2026-10-19', amount: 1_349_900, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 942_756.95, commissions: -200, unrealized: 0, total: 942_556.95 } },
        nav: { account: 3_942_556.95, book: 5_942_556.95 },
        balance: { account: { cash: 2_592_656.95, margin: null, positions: null, receivable: 1_349_900, assets: 3_942_556.95, liabilities: 0, netAssets: 3_942_556.95 } },
      },
    },
    {
      // -500,100 - 20,833.33 + 6,000 - 21,527.78 + 200,000 - 50,000 - 20,881.94 + 1,349,900 = +942,556.95 on 3,000,000.
      id: 'settle-termination', covers: ['settlement', 'close'], action: 'clock', to: at('2026-10-19'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,349,900.00 USD into settled cash', cash: { USD: 1_349_900 } }],
        cash: { account: { USD: { settled: 3_942_556.95, unsettled: 0, availableToTrade: 3_942_556.95, availableToWithdraw: 3_942_556.95 } } },
        pending: [], lifecycle: [], otc: [], alerts: [],
        balance: { account: { cash: 3_942_556.95, receivable: null } },
      },
    },
  ],
};

export default [cdsSingleName, cdsSovereign, cdsIndex, cdsBasket, cdsTranche, loanCds, absCds];
