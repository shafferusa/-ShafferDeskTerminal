// Forwards family (engine family "forward"): equity, bond, FX and commodity forwards, non-deliverable
// forwards, forward-rate agreements, FX swaps and TBA mortgage contracts. One scenario per product, each
// on its own fictional contract registered as exactly that product, with the terms a real contract of it
// has (underlying or currency pair, value date on the right calendar, fixing source, settlement style,
// counterparty and collateral terms).
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The arithmetic
// is in the comment beside it. Nothing here is copied from what the Terminal prints.
//
// The Terminal's rules for a forward, restated so the arithmetic can be followed:
//   - A forward is an OTC contract. It cannot be entered without a collateral basis on the contract:
//     an agreement of the Book, position-level terms, or "uncollateralized" chosen explicitly.
//   - No cash changes hands at entry, apart from collateral: an independent amount under position-level
//     terms leaves settled cash for "Margin and collateral posted" at once. Commission (the Book's fee
//     schedule for forwards, an amount per unit of quantity) is owed and paid on the value date.
//   - Quantity is the base-currency amount (FX), the number of units of the underlying (asset forwards,
//     with the multiplier converting to the underlying's own unit), or the notional (FRA). Price is the
//     forward rate or price; for an FRA, the contract rate in percent a year.
//   - The position carries its dealt price. Its value, which is also its unrealized P&L, is
//     quantity x (mark - dealt) x multiplier, undiscounted, in the contract's currency; the mark is the
//     contract's own quote (a fixture standing in for a dealer's indication) or a price entered by hand.
//     Without a mark the position is unpriced and the totals that rest on it are provisional.
//   - Variation margin under position-level terms moves in the end-of-day pass (17:00 New York) on that
//     value: posted when it is below minus the threshold, received (restricted cash and a liability, never
//     spendable) when above the threshold; a transfer smaller than the minimum transfer amount is not made.
//   - Early termination is recorded on the position at the amount agreed with the counterparty, realized,
//     settled on the date stated (two business days if none is stated); its collateral is returned.
//   - Settlement on the value date (or the fixing date): a deliverable FX forward exchanges both currency
//     amounts if the paying currency is there in settled cash, and fails visibly otherwise (retried each
//     cycle); a non-deliverable forward pays quantity x (fixing - dealt) in the settlement currency against
//     the fixing of its fixing date, and waits visibly when the fixing is missing; an FRA pays at the start
//     of its period N x (L - K) x d / (1 + L x d) with d the day-count fraction of the period; an asset
//     forward delivers the underlying at the dealt price (simulated, labelled) or pays the difference
//     against the underlying's close on the value date, by its terms. After settlement nothing is left
//     posted, accrued or scheduled.

export const family = 'forward';

/** 10:00 and 17:30 New York. Daylight time (UTC-4) runs from 8 March to 1 November 2026. */
const AM = (d) => `${d}T${d >= '2026-03-08' && d < '2026-11-01' ? '14' : '15'}:00:00.000Z`;
const EOD = (d) => `${d}T${d >= '2026-03-08' && d < '2026-11-01' ? '21' : '22'}:30:00.000Z`;

const FILL = { halfSpreadBps: { forward: 0, equity: 0, bond: 0, spot: 0, fx: 0 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const NO_STATE = { pending: [], openOrders: [], lifecycle: [], borrowings: [], alerts: [], provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } };
const OTC_TICKET = {
  ticket: 'Registry form (Instruments, New instrument) for the contract: kind of forward, its terms and the required Collateral terms group; then the instrument drawer, Trade tab (Account, Buy / Sell, quantity, State a fill price); the strategy instance for early termination',
};
const cashOf = (settled, { unsettled = 0, margin = 0, restricted = 0, trade, withdraw } = {}) => ({
  settled, unsettled, reserved: 0, restricted, margin,
  availableToTrade: trade ?? Math.round((settled + Math.min(unsettled, 0)) * 100) / 100,
  availableToWithdraw: withdraw ?? Math.round((settled + Math.min(unsettled, 0)) * 100) / 100,
});

/** The collateral row of a position under position-level terms (Treasury, Collateral). */
const otcRow = (lot, qty, iaRequired, extra) => ({
  instrument: 'main', lot, owner: 'account', qty, basis: 'position', agreement: null, flagged: false,
  iaRequired, iaPosted: iaRequired, iaCcy: 'USD', iaStatus: 'ok', postedBy: 'account',
  vmPosted: 0, vmHeld: 0, vmCcy: 'USD', vmExposure: null, vmStatus: 'not_valued_yet', vmPending: 0, ...extra,
});

// ---------------------------------------------------------------------------------------------
// fx_forward
// ---------------------------------------------------------------------------------------------
// A deliverable EUR/USD outright forward with a New York dealer: the Account buys 1,000,000 EUR for
// value Monday 22 June 2026 at 1.0850 (pays 1,085,000.00 USD), and in a separate strategy instance sells
// 400,000 EUR for the same date at 1.0870. The value date is a business day of both currencies' payment
// calendars (TARGET for EUR, the Federal Reserve calendar for USD); Friday 19 June (Juneteenth) is not,
// and a contract with that value date is refused. The long is held across Juneteenth.
// Position-level collateral terms: independent amount 2% of the notional at the dealt rate, variation
// margin with a threshold of 0 and a minimum transfer of 2,000 USD.
// The Account is funded with 200,000 USD only: on the value date the 1,085,000.00 USD it must pay is not
// there, the settlement fails visibly, and goes through once Treasury funds the Account.
// Commission: 0.00002 USD per EUR of quantity (20.00 USD a million), paid on the value date.
const OTC_BUY = (x) => otcRow('buy', 1_000_000, 21_700, x);
const OTC_SELL = (x) => otcRow('sell', -400_000, 8_696, x);
const fxForward = {
  productId: 'fx_forward',
  title: 'EUR/USD deliverable forward, bought and sold for value 22 June 2026, position-level collateral, held across Juneteenth, unfunded then funded on the value date',
  matrix: {
    ...OTC_TICKET,
    requiredFields: ['Kind of forward (Deliverable FX forward)', 'Base currency', 'Quote currency', 'Value date', 'Counterparty', 'Collateral basis and its terms', 'Account', 'Action (Buy / Sell)', 'Base-currency amount', 'State a fill price'],
    automaticInputs: ['value-date check on the joint calendar of both currencies', 'independent amount and variation margin from the position-level terms', 'commission from the Book fee schedule', 'mark (quote fixture standing in for a dealer indication)', 'EUR/USD rate for the reporting currency (FX fixture)'],
    manualInputs: ['dealt forward rate (stated fill price)', 'early termination amount (position Lifecycle menu, "Early termination")'],
    settlement: 'No cash at entry other than the independent amount; commission and the exchange of 1,000,000 EUR against 1,085,000 USD on the value date, only when the USD is in settled cash; otherwise a visible failure retried each cycle',
    lifecycle: 'Daily variation margin on the mark (automatic); early termination of the short at a stated amount (manual); settlement by exchange of both currencies on the value date (automatic), failed while unfunded and completed once funded',
    accounting: 'Nil cost; value and unrealized P&L = quantity x (mark - dealt rate) in USD; the termination amount is realized; after delivery the EUR is a cash balance valued at the EUR/USD fixture in the reporting currency',
    collateral: 'Position-level terms: independent amount 2% of notional posted at entry and returned at termination or settlement; variation margin, threshold 0, minimum transfer 2,000 USD; collateral received is restricted cash with a liability',
  },
  start: AM('2026-06-01'),
  settlementCheck: { lag: 0, holidays: ['2026-06-19'] },
  book: {
    name: 'Matrix FX forward', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'FX desk', funding: [{ ccy: 'USD', amount: 200_000 }] },
    settings: { fees: { forward: { perUnit: 0.00002, minimum: 0, bps: 0 } }, fill: FILL, settlement: {} },
  },
  instruments: {
    main: {
      productId: 'fx_forward', name: 'EUR/USD outright forward, value 22 June 2026', symbol: 'EURUSD-F0622', marketView: 'US_DERIV', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'USD',
      terms: { forwardType: 'fx', base: 'EUR', quote: 'USD', valueDate: '2026-06-22', counterparty: 'Harbourline Bank N.A., New York',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: true, threshold: 0, minimumTransfer: 2_000 } },
    },
  },
  quotes: { main: { bid: 1.0848, ask: 1.0852, last: 1.0850, bidSize: 10_000_000, askSize: 10_000_000 } },
  fx: { 'EUR/USD': 1.0840 },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: cashOf(200_000) }, treasury: { USD: cashOf(2_800_000) } },
    positions: [], otc: [],
    nav: { account: 200_000, treasury: 2_800_000, book: 3_000_000 },
  },
  steps: [
    {
      // Friday 19 June 2026 is Juneteenth, a Federal Reserve holiday: USD does not settle that day.
      id: 'register-value-date-on-holiday', covers: 'value date', action: 'register_instrument',
      draft: { productId: 'fx_forward', name: 'EUR/USD outright forward, value 19 June 2026', symbol: 'EURUSD-F0619', marketView: 'US_DERIV', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'USD',
        terms: { forwardType: 'fx', base: 'EUR', quote: 'USD', valueDate: '2026-06-19', counterparty: 'Harbourline Bank N.A., New York', collateralBasis: { type: 'uncollateralized' } } },
      status: 'blocked', reason: 'The value date of an FX forward must be a business day for both currencies.',
      expect: { refused: 'The value date 2026-06-19 is not a business day for USD (USD calendar)' },
    },
    {
      // 1,000,000 x 1.0850 = 1,085,000.00 USD notional; independent amount 2% = 21,700.00; commission 1,000,000 x 0.00002 = 20.00.
      id: 'open-buy', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 1_000_000, as: 'buy', order: { statedPrice: 1.0850 },
      expect: {
        preview: { blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1_000_000, estimate: 1.0850, model: 'stated-price', settleDate: '2026-06-22', cash: 0, fees: 20 }],
          cash: { USD: { purchases: 0, fees: 20, margin: 21_700, required: 21_720, available: 200_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000_000, avgPrice: 1.0850 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought forward 1,000,000 EURUSD-F0622 @ 1.085 for 2026-06-22', owner: 'account', date: '2026-06-01' },
          { type: 'forward.collateral', summary: 'Collateral posted on EUR/USD outright forward, value 22 June 2026 under its position-level terms: 21,700.00 USD (independent amount, 2.00% of 1,085,000.00 USD notional)', cash: { USD: -21_700 }, owner: 'account' },
        ],
        cash: { account: { USD: cashOf(178_300, { unsettled: -20, margin: 21_700 }) } }, // 200,000 - 21,700
        positions: [{ instrument: 'main', lot: 'buy', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 1.0850, cost: 0, price: 1.0850, value: 0, unrealized: 0, notional: 1_085_000, margin: 21_700 }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [{ instrument: 'main', lot: 'buy', owner: 'account', dueDate: '2026-06-22', amount: -20, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'forward.maturity', instrument: 'main', dueDate: '2026-06-22', status: 'pending' }],
        pnl: { account: { realized: 0, commissions: -20, fees: 0, unrealized: 0, total: -20 } },
        nav: { account: 199_980, book: 2_999_980 },
        balance: { account: { cash: 178_300, margin: 21_700, payable: 20, assets: 200_000, liabilities: 20, netAssets: 199_980 } },
        otc: [OTC_BUY({ mark: 1.0850, markValue: 0 })],
      },
    },
    {
      // 400,000 x 1.0870 = 434,800.00 USD notional; independent amount 2% = 8,696.00; commission 400,000 x 0.00002 = 8.00.
      // Marked at 1.0850: -400,000 x (1.0850 - 1.0870) = +800.00.
      id: 'open-sell', covers: ['open short', 'collateral'], action: 'ticket', instrument: 'main', side: 'sell', qty: 400_000, as: 'sell', order: { statedPrice: 1.0870 },
      expect: {
        preview: { blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 400_000, estimate: 1.0870, model: 'stated-price', settleDate: '2026-06-22', cash: 0, fees: 8 }],
          cash: { USD: { purchases: 0, fees: 8, margin: 8_696, required: 8_704, available: 178_280, shortfall: 0 } } }, // available: settled less the 20.00 owed
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 400_000, avgPrice: 1.0870 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold forward 400,000 EURUSD-F0622 @ 1.087 for 2026-06-22', owner: 'account', date: '2026-06-01' },
          { type: 'forward.collateral', summary: '8,696.00 USD (independent amount, 2.00% of 434,800.00 USD notional)', cash: { USD: -8_696 }, owner: 'account' },
        ],
        cash: { account: { USD: cashOf(169_604, { unsettled: -28, margin: 30_396 }) } }, // 178,300 - 8,696; 21,700 + 8,696
        positions: [
          { instrument: 'main', lot: 'buy', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 1.0850, cost: 0, price: 1.0850, value: 0, unrealized: 0, notional: 1_085_000, margin: 21_700 },
          { instrument: 'main', lot: 'sell', owner: 'account', direction: 'short', qty: -400_000, avgCost: 1.0870, cost: 0, price: 1.0850, value: 800, unrealized: 800, notional: 434_800, margin: 8_696 },
        ],
        holdings: { main: { long: 1_000_000, short: 400_000, net: 600_000 } },
        pending: [
          { instrument: 'main', lot: 'buy', owner: 'account', dueDate: '2026-06-22', amount: -20, ccy: 'USD', into: 'cash' },
          { instrument: 'main', lot: 'sell', owner: 'account', dueDate: '2026-06-22', amount: -8, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'forward.maturity', instrument: 'main', dueDate: '2026-06-22', status: 'pending' }, { type: 'forward.maturity', instrument: 'main', dueDate: '2026-06-22', status: 'pending' }],
        pnl: { account: { commissions: -28, unrealized: 800, total: 772 } },
        nav: { account: 200_772, book: 3_000_772 }, // 200,000 - 28 + 800
        balance: { account: { cash: 169_604, margin: 30_396, positions: 800, payable: 28, assets: 200_800, liabilities: 28, netAssets: 200_772 } },
        otc: [OTC_BUY({ mark: 1.0850, markValue: 0 }), OTC_SELL({ mark: 1.0850, markValue: 800 })],
      },
    },
    {
      // The dealer's indication moves to 1.0900: long 1,000,000 x (1.0900 - 1.0850) = 5,000.00; short -400,000 x (1.0900 - 1.0870) = -1,200.00.
      id: 'mark-up', covers: 'mark', action: 'quote', instrument: 'main', quote: { bid: 1.0898, ask: 1.0902, last: 1.0900, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [
          { instrument: 'main', lot: 'buy', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 1.0850, cost: 0, price: 1.0900, value: 5_000, unrealized: 5_000, notional: 1_085_000, margin: 21_700 },
          { instrument: 'main', lot: 'sell', owner: 'account', direction: 'short', qty: -400_000, avgCost: 1.0870, cost: 0, price: 1.0900, value: -1_200, unrealized: -1_200, notional: 434_800, margin: 8_696 },
        ],
        pnl: { account: { unrealized: 3_800, total: 3_772 } }, // 5,000 - 1,200 - 28
        nav: { account: 203_772, book: 3_003_772 },
        balance: { account: { positions: 3_800, assets: 203_800, netAssets: 203_772 } },
        otc: [OTC_BUY({ mark: 1.0900, markValue: 5_000 }), OTC_SELL({ mark: 1.0900, markValue: -1_200 })],
      },
    },
    {
      // End of day: each position is its own netting set. The long is worth +5,000.00, above the threshold of 0 and not
      // below the minimum transfer of 2,000: the dealer posts 5,000.00, held as restricted cash against a liability.
      // The short is worth -1,200.00: posting 1,200.00 would be below the minimum transfer, so nothing moves.
      id: 'variation-margin', covers: ['variation margin', 'collateral'], action: 'clock', to: EOD('2026-06-01'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 5,000.00 USD received. Netting set of 1 position marked at 5,000.00 USD; threshold 0.00 USD.', owner: 'account', date: '2026-06-01' }],
        cash: { account: { USD: cashOf(169_604, { unsettled: -28, margin: 30_396, restricted: 5_000 }) } },
        balance: { account: { assets: 208_800, liabilities: 5_028, netAssets: 203_772 } }, // + 5,000 restricted cash and the 5,000 owed back to the dealer
        otc: [OTC_BUY({ mark: 1.0900, markValue: 5_000, vmHeld: 5_000, vmExposure: 5_000, vmStatus: 'ok' }), OTC_SELL({ mark: 1.0900, markValue: -1_200, vmExposure: -1_200, vmStatus: 'ok' })],
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-06-02'), expect: {} },
    {
      // The short is terminated early at an amount agreed with the dealer: 1,250.00 USD paid, settled two business days
      // later (Thursday 4 June). Realized -1,250.00; its independent amount 8,696.00 comes back at once. Its commission of
      // 8.00, owed from the trade, is still paid on the value date.
      id: 'terminate-short', covers: ['early termination', 'close', 'collateral'], action: 'lifecycle', lot: 'sell', body: { action: 'terminate', amount: -1_250 },
      expect: {
        events: [
          { type: 'forward.termination', summary: 'Terminated early: 400,000 of EURUSD-F0622 (dealt 1.087) at a stated amount, paid 1,250.00 USD on 2026-06-04', owner: 'account', date: '2026-06-02' },
          { type: 'forward.collateral', summary: '8,696.00 USD', cash: { USD: 8_696 }, owner: 'account' },
        ],
        cash: { account: { USD: cashOf(178_300, { unsettled: -1_278, margin: 21_700, restricted: 5_000 }) } }, // 169,604 + 8,696; -28 - 1,250
        positions: [{ instrument: 'main', lot: 'buy', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 1.0850, cost: 0, price: 1.0900, value: 5_000, unrealized: 5_000, notional: 1_085_000, margin: 21_700 }],
        holdings: { main: { long: 1_000_000, short: 0, net: 1_000_000 } },
        pending: [
          { instrument: 'main', lot: 'sell', owner: 'account', dueDate: '2026-06-04', amount: -1_250, ccy: 'USD', into: 'cash' },
          { instrument: 'main', lot: 'buy', owner: 'account', dueDate: '2026-06-22', amount: -20, ccy: 'USD', into: 'cash' },
          { instrument: 'main', lot: 'sell', owner: 'account', dueDate: '2026-06-22', amount: -8, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'forward.maturity', instrument: 'main', dueDate: '2026-06-22', status: 'pending' }],
        pnl: { account: { realized: -1_250, commissions: -28, unrealized: 5_000, total: 3_722 } },
        nav: { account: 203_722, book: 3_003_722 },
        balance: { account: { cash: 178_300, margin: 21_700, positions: 5_000, payable: 1_278, assets: 210_000, liabilities: 6_278, netAssets: 203_722 } }, // 178,300 + 21,700 + 5,000 + 5,000; 1,278 + 5,000
        otc: [OTC_BUY({ mark: 1.0900, markValue: 5_000, vmHeld: 5_000, vmExposure: 5_000, vmStatus: 'ok' })],
      },
    },
    {
      id: 'termination-settles', covers: 'settlement', action: 'clock', to: AM('2026-06-04'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 1,250.00 USD from settled cash', cash: { USD: -1_250 }, owner: 'account', date: '2026-06-04' }],
        cash: { account: { USD: cashOf(177_050, { unsettled: -28, margin: 21_700, restricted: 5_000 }) } },
        pending: [
          { instrument: 'main', lot: 'buy', owner: 'account', dueDate: '2026-06-22', amount: -20, ccy: 'USD', into: 'cash' },
          { instrument: 'main', lot: 'sell', owner: 'account', dueDate: '2026-06-22', amount: -8, ccy: 'USD', into: 'cash' },
        ],
        balance: { account: { cash: 177_050, payable: 28, assets: 208_750, liabilities: 5_028 } },
      },
    },
    { id: 'thursday-18-june', action: 'clock', to: AM('2026-06-18'), expect: {} },
    {
      // 1,000,000 x (1.0950 - 1.0850) = 10,000.00.
      id: 'mark-up-again', covers: 'mark', action: 'quote', instrument: 'main', quote: { bid: 1.0948, ask: 1.0952, last: 1.0950, bidSize: 10_000_000, askSize: 10_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'buy', owner: 'account', direction: 'long', qty: 1_000_000, avgCost: 1.0850, cost: 0, price: 1.0950, value: 10_000, unrealized: 10_000, notional: 1_085_000, margin: 21_700 }],
        pnl: { account: { unrealized: 10_000, total: 8_722 } }, // -1,250 - 28 + 10,000
        nav: { account: 208_722, book: 3_008_722 },
        balance: { account: { positions: 10_000, assets: 213_750, netAssets: 208_722 } },
        otc: [OTC_BUY({ mark: 1.0950, markValue: 10_000, vmHeld: 5_000, vmExposure: 5_000, vmStatus: 'ok' })],
      },
    },
    {
      // Exposure 10,000.00 against 5,000.00 held: the dealer posts 5,000.00 more (not below the minimum transfer of 2,000).
      id: 'variation-margin-call', covers: ['variation margin', 'collateral'], action: 'clock', to: EOD('2026-06-18'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 5,000.00 USD received. Netting set of 1 position marked at 10,000.00 USD; threshold 0.00 USD.', owner: 'account', date: '2026-06-18' }],
        cash: { account: { USD: cashOf(177_050, { unsettled: -28, margin: 21_700, restricted: 10_000 }) } },
        balance: { account: { assets: 218_750, liabilities: 10_028, netAssets: 208_722 } },
        otc: [OTC_BUY({ mark: 1.0950, markValue: 10_000, vmHeld: 10_000, vmExposure: 10_000, vmStatus: 'ok' })],
      },
    },
    { id: 'spot-on-value-date', action: 'fx_rate', pair: 'EUR/USD', rate: 1.0960, expect: {} },
    {
      // Monday 22 June, over Juneteenth (Friday 19 June: no end-of-day pass for the US). The commissions (28.00) are paid.
      // The forward is due: 1,000,000 x 1.0850 = 1,085,000.00 USD must be paid and only 177,022.00 of settled USD is held
      // (177,050 - 28). The exchange is not made: the lifecycle item fails, visibly, and an alert is raised.
      id: 'value-date-unfunded', covers: ['settlement', 'failed settlement', 'holiday'], action: 'clock', to: AM('2026-06-22'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 20.00 USD from settled cash', cash: { USD: -20 }, owner: 'account', date: '2026-06-22' },
          { type: 'settlement.pay', summary: 'paid 8.00 USD from settled cash', cash: { USD: -8 }, owner: 'account', date: '2026-06-22' },
        ],
        cash: { account: { USD: cashOf(177_022, { margin: 21_700, restricted: 10_000 }) } },
        pending: [],
        lifecycle: [], // a failed item is listed with the failures, not with the scheduled items
        failed: { orders: 0, settlements: 0, lifecycle: 1 },
        lifecycleFailures: [{ type: 'forward.maturity', instrument: 'main', dueDate: '2026-06-22', status: 'failed', owner: 'account', reason: 'Delivery failed: 1,085,000.00 USD due, 177,022.00 USD of settled USD available.' }],
        alerts: ['forward.unfunded'],
        balance: { account: { cash: 177_022, payable: null, assets: 218_722, liabilities: 10_000 } },
      },
    },
    {
      // Treasury funds the Account with 1,000,000.00 USD; the next cycle retries the exchange and it goes through:
      // 1,000,000.00 EUR received, 1,085,000.00 USD paid; the independent amount 21,700.00 comes back, and the
      // variation margin of 10,000.00 is returned to the dealer. Nothing is left posted or scheduled.
      // USD: 177,022 + 1,000,000 - 1,085,000 + 21,700 = 113,722.00. EUR 1,000,000 at 1.0960 = 1,096,000.00 USD.
      // P&L by hand: realized -1,250 (termination), commission -28, and the EUR bought at 1.0850 now worth 1.0960:
      // 1,000,000 x 0.0110 = 11,000.00 in the reporting currency. Total 9,722.00.
      id: 'fund-and-settle', covers: ['settlement', 'funding', 'collateral', 'reporting currency'], action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 1_000_000,
      expect: {
        events: [
          { type: 'transfer.funding', summary: 'Treasury funding: 1,000,000.00 USD from Treasury to FX desk' },
          { type: 'forward.settlement', summary: 'FX forward settled: received 1,000,000.00 EUR against 1,085,000.00 USD at 1.085', owner: 'account', date: '2026-06-22' },
          { type: 'forward.collateral', summary: '21,700.00 USD (independent amount, the position ended)', cash: { USD: 21_700 }, owner: 'account' },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 10,000.00 USD returned to the counterparty. The last position of the netting set ended.', owner: 'account' },
        ],
        cash: { account: { USD: cashOf(113_722), EUR: cashOf(1_000_000) }, treasury: { USD: cashOf(1_800_000) } },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        failed: { orders: 0, settlements: 0, lifecycle: 0 },
        lifecycleFailures: [],
        alerts: [],
        pnl: { account: { realized: -1_250, commissions: -28, unrealized: 0, fx: 11_000, total: 9_722 } },
        nav: { account: 1_209_722, treasury: 1_800_000, book: 3_009_722 }, // 113,722 + 1,096,000
        balance: { account: { cash: 1_209_722, margin: null, positions: null, assets: 1_209_722, liabilities: 0, netAssets: 1_209_722, local: { EUR: { cash: 1_000_000 }, USD: { cash: 113_722 } } } },
        otc: [],
      },
    },
  ],
};

export default [fxForward];
