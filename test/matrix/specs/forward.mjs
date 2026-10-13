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

// ---------------------------------------------------------------------------------------------
// ndf
// ---------------------------------------------------------------------------------------------
// A USD/INR non-deliverable forward owned by Treasury: rupees cannot be delivered offshore, so the contract
// is settled in US dollars against the rupee reference rate of its fixing date. Treasury sells 5,000,000 USD
// forward at 87.50 INR per USD, fixing Thursday 30 April 2026, value date Monday 4 May 2026 (two business
// days after the fixing). The fixing source is the USD/INR pair registered beside it; its close for the
// fixing date stands in for the reference rate (a fixture standing in for Shaffer MarketData).
// Collateral: explicitly uncollateralized (chosen on the contract, not assumed).
// The contract's own currency is INR (its forward rate is INR per USD), so its value is in rupees and is
// converted at the USD/INR fixture (87.40) for the reporting currency; it settles in USD.
// Settlement in USD: quantity x (fixing - dealt) / fixing, positive received.
// Held across Good Friday (3 April 2026). No commission (the dealer's spread is in the rate).
const ndf = {
  productId: 'ndf',
  title: 'USD/INR non-deliverable forward sold by Treasury, cash-settled in USD against the 30 April 2026 fixing, partly terminated early, uncollateralized',
  matrix: {
    ...OTC_TICKET,
    requiredFields: ['Kind of forward (Non-deliverable forward)', 'Base currency', 'Quote currency', 'Value date', 'Fixing date', 'Settlement currency', 'Fixing source (currency pair)', 'Counterparty', 'Collateral basis (Uncollateralized)', 'Trading owner (Treasury)', 'Action (Sell)', 'quantity', 'State a fill price'],
    automaticInputs: ['mark (quote fixture standing in for a dealer indication)', 'USD/INR rate for the reporting currency (FX fixture)', 'the fixing: close of the USD/INR pair on the fixing date (fixture standing in for the reference rate)'],
    manualInputs: ['dealt forward rate (stated fill price)', 'early termination of 2,000,000 at a stated amount in USD (position Lifecycle menu)'],
    settlement: 'No cash at entry; cash settlement in USD on the value date of quantity x (fixing - dealt) / fixing, booked when the fixing arrives; the termination amount settles two business days after it is agreed',
    lifecycle: 'Settlement against the fixing (automatic), waiting visibly while the fixing is missing and completed when it arrives; early termination of part of the notional at a stated amount (manual)',
    accounting: 'Nil cost; value and unrealized P&L in INR = quantity x (mark - dealt), converted to USD at the fixture; termination amount and settlement amount realized in USD',
    collateral: 'Explicitly uncollateralized: no independent amount, no variation margin',
  },
  start: AM('2026-03-02'),
  settlementCheck: { lag: 0, holidays: ['2026-04-03'] },
  book: {
    name: 'Matrix NDF', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 10_000_000 }],
    account: { name: 'Rates', funding: [{ ccy: 'USD', amount: 100_000 }] },
    settings: { fees: { forward: { perUnit: 0, minimum: 0, bps: 0 }, fx: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: {} }, // the pair is not traded here
  },
  instruments: {
    pair: { productId: 'fx_spot', name: 'USD/INR spot', symbol: 'USDINR', marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: 'INR', terms: { base: 'USD', quote: 'INR', settleDays: 2 } },
    main: {
      productId: 'ndf', name: 'USD/INR non-deliverable forward, fixing 30 April 2026', symbol: 'USDINR-NDF0430', marketView: 'FOREIGN_DERIV', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'INR', underlying: 'pair',
      terms: { forwardType: 'ndf', base: 'USD', quote: 'INR', valueDate: '2026-05-04', fixingDate: '2026-04-30', settleCcy: 'USD', counterparty: 'Harbourline Bank N.A., New York', collateralBasis: { type: 'uncollateralized' } },
    },
  },
  quotes: { main: { bid: 87.48, ask: 87.52, last: 87.50, bidSize: 50_000_000, askSize: 50_000_000 } },
  fx: { 'USD/INR': 87.40 },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: cashOf(100_000) }, treasury: { USD: cashOf(9_900_000) } },
    positions: [], otc: [],
    nav: { account: 100_000, treasury: 9_900_000, book: 10_000_000 },
  },
  steps: [
    {
      id: 'open-sell', covers: ['open short', 'treasury'], action: 'ticket', owner: 'treasury', instrument: 'main', side: 'sell', qty: 5_000_000, as: 'hedge', order: { statedPrice: 87.50 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 5_000_000, estimate: 87.50, model: 'stated-price', settleDate: '2026-05-04', cash: 0, fees: 0 }] },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 5_000_000, avgPrice: 87.50 }] },
        events: [{ type: 'strategy.submitted', owner: 'treasury' }, { type: 'trade.fill', summary: 'Sold forward 5,000,000 USDINR-NDF0430 @ 87.50 for 2026-05-04', owner: 'treasury', date: '2026-03-02' }],
        positions: [{ instrument: 'main', lot: 'hedge', owner: 'treasury', direction: 'short', qty: -5_000_000, avgCost: 87.50, cost: 0, price: 87.50, value: 0, unrealized: 0, notional: 437_500_000, margin: 0 }], // 5,000,000 x 87.50 INR
        holdings: { main: { long: 0, short: 5_000_000, net: -5_000_000 } },
        lifecycle: [{ type: 'forward.maturity', instrument: 'main', dueDate: '2026-04-30', status: 'pending', owner: 'treasury' }],
        pnl: { treasury: { realized: 0, commissions: 0, unrealized: 0, total: 0 } },
        balance: { treasury: { cash: 9_900_000, assets: 9_900_000, liabilities: 0, netAssets: 9_900_000 } },
        otc: [{ instrument: 'main', lot: 'hedge', owner: 'treasury', qty: -5_000_000, basis: 'uncollateralized', agreement: null, flagged: false, mark: 87.50, markValue: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
      },
    },
    {
      // The dealer's indication moves to 87.80: -5,000,000 x (87.80 - 87.50) = -1,500,000.00 INR; at 87.40 INR per USD
      // that is -1,500,000 / 87.40 = -17,162.4714 = -17,162.47 USD.
      id: 'mark', covers: ['mark', 'reporting currency'], action: 'quote', instrument: 'main', quote: { bid: 87.78, ask: 87.82, last: 87.80, bidSize: 50_000_000, askSize: 50_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'hedge', owner: 'treasury', direction: 'short', qty: -5_000_000, avgCost: 87.50, cost: 0, price: 87.80, value: -1_500_000, unrealized: -1_500_000, notional: 437_500_000, margin: 0 }],
        pnl: { treasury: { unrealized: -17_162.47, total: -17_162.47 } },
        nav: { treasury: 9_882_837.53, book: 9_982_837.53 },
        balance: { treasury: { positions: -17_162.47, assets: 9_882_837.53, netAssets: 9_882_837.53 } }, // a contract worth less than nothing is carried at its (negative) value
        otc: [{ instrument: 'main', lot: 'hedge', owner: 'treasury', qty: -5_000_000, basis: 'uncollateralized', agreement: null, flagged: false, mark: 87.80, markValue: -1_500_000, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
      },
    },
    {
      // 2,000,000 of the 5,000,000 is terminated early at an amount agreed with the dealer: 6,900.00 USD paid, in the
      // settlement currency, two business days later (Wednesday 4 March). Realized -6,900.00 USD. What is left:
      // -3,000,000 x 0.30 = -900,000.00 INR = -900,000 / 87.40 = -10,297.4828 = -10,297.48 USD.
      id: 'terminate-part', covers: ['early termination', 'reduce'], action: 'lifecycle', owner: 'treasury', lot: 'hedge', body: { action: 'terminate', amount: -6_900, qty: 2_000_000 },
      expect: {
        events: [{ type: 'forward.termination', summary: 'Terminated early: 2,000,000 of USDINR-NDF0430 (dealt 87.50) at a stated amount, paid 6,900.00 USD on 2026-03-04; 3,000,000 remains', owner: 'treasury', date: '2026-03-02' }],
        cash: { treasury: { USD: cashOf(9_900_000, { unsettled: -6_900 }) } },
        positions: [{ instrument: 'main', lot: 'hedge', owner: 'treasury', direction: 'short', qty: -3_000_000, avgCost: 87.50, cost: 0, price: 87.80, value: -900_000, unrealized: -900_000, notional: 262_500_000, margin: 0 }],
        holdings: { main: { long: 0, short: 3_000_000, net: -3_000_000 } },
        pending: [{ instrument: 'main', lot: 'hedge', owner: 'treasury', dueDate: '2026-03-04', amount: -6_900, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: -6_900, unrealized: -10_297.48, total: -17_197.48 } },
        nav: { treasury: 9_882_802.52, book: 9_982_802.52 }, // 9,900,000 - 6,900 - 10,297.48
        balance: { treasury: { cash: 9_900_000, positions: -10_297.48, payable: 6_900, assets: 9_889_702.52, liabilities: 6_900, netAssets: 9_882_802.52 } },
        otc: [{ instrument: 'main', lot: 'hedge', owner: 'treasury', qty: -3_000_000, basis: 'uncollateralized', agreement: null, flagged: false, mark: 87.80, markValue: -900_000, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
      },
    },
    {
      id: 'termination-settles', covers: 'settlement', action: 'clock', to: AM('2026-03-04'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 6,900.00 USD from settled cash', cash: { USD: -6_900 }, owner: 'treasury', date: '2026-03-04' }],
        cash: { treasury: { USD: cashOf(9_893_100) } },
        pending: [],
        balance: { treasury: { cash: 9_893_100, payable: null, assets: 9_882_802.52, liabilities: 0 } },
      },
    },
    {
      // Thursday 30 April, the fixing date (over Good Friday). No fixing has been supplied: the settlement waits, visibly.
      id: 'fixing-date-no-fixing', covers: ['fixing', 'holiday'], action: 'clock', to: AM('2026-04-30'),
      expect: {
        lifecycle: [{ type: 'forward.maturity', instrument: 'main', dueDate: '2026-04-30', status: 'blocked', owner: 'treasury' }],
      },
    },
    { id: 'fixing-date-evening', action: 'clock', to: EOD('2026-04-30'), expect: {} },
    {
      // The fixing arrives: 87.10. -3,000,000 x (87.10 - 87.50) = 1,200,000.00 INR, in USD at the fixing:
      // 1,200,000 / 87.10 = 13,777.2675 = 13,777.27 USD received on the value date, Monday 4 May. Realized in all:
      // -6,900 + 13,777.27 = 6,877.27.
      id: 'fixing-arrives', covers: ['fixing', 'settlement'], action: 'close_price', instrument: 'pair', date: '2026-04-30', value: 87.10,
      expect: {
        events: [{ type: 'forward.settlement', summary: 'NDF fixed at 87.10 against 87.50: receivable 13,777.27 USD on 2026-05-04', owner: 'treasury', date: '2026-04-30' }],
        cash: { treasury: { USD: cashOf(9_893_100, { unsettled: 13_777.27, trade: 9_906_877.27, withdraw: 9_893_100 }) } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'hedge', owner: 'treasury', dueDate: '2026-05-04', amount: 13_777.27, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { treasury: { realized: 6_877.27, unrealized: 0, total: 6_877.27 } },
        nav: { treasury: 9_906_877.27, book: 10_006_877.27 },
        balance: { treasury: { cash: 9_893_100, positions: null, receivable: 13_777.27, assets: 9_906_877.27, liabilities: 0, netAssets: 9_906_877.27 } },
        otc: [],
      },
    },
    {
      id: 'value-date', covers: 'settlement', action: 'clock', to: AM('2026-05-04'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 13,777.27 USD into settled cash', cash: { USD: 13_777.27 }, owner: 'treasury', date: '2026-05-04' }],
        cash: { treasury: { USD: cashOf(9_906_877.27) } },
        pending: [],
        balance: { treasury: { cash: 9_906_877.27, receivable: null, assets: 9_906_877.27, liabilities: 0, netAssets: 9_906_877.27 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// fra
// ---------------------------------------------------------------------------------------------
// A EUR forward-rate agreement, 3x6 on three-month EURIBOR, under English law with a London dealer: the
// Account buys 25,000,000 EUR notional at 2.15% (it pays the contract rate and receives the fixing) for the
// interest period Wednesday 3 June to Thursday 3 September 2026 (92 days, ACT/360). The rate fixes two TARGET
// business days before the period starts: Monday 1 June 2026.
// The formula the Terminal uses, settled in cash at the start of the period (the value date):
//     amount = N x (L - K) x d / (1 + L x d),  d = days / 360 = 92 / 360,  L the fixing, K the contract rate
// positive received by the buyer. Quoted and marked in percent a year; value and unrealized P&L before the
// fixing = N x (mark - K) / 100 x d, undiscounted.
// Collateral under a Book agreement (CSA Dealer C, recorded in the scenario): no independent amount, variation
// margin in USD, threshold 0, minimum transfer 5,000 USD; the EUR exposure is converted at the EUR/USD fixture
// (1.08). Part of the contract (5,000,000) is terminated early at an amount agreed with the dealer.
// Held across Good Friday (3 April) and 1 May (TARGET holidays). No commission.
const FRA_DRAFT = {
  productId: 'fra', name: 'EUR FRA 3x6 on 3M EURIBOR at 2.15%, period 3 June to 3 September 2026', symbol: 'EUR-FRA-3X6-0603', marketView: 'FOREIGN_DERIV', venueType: 'otc', jurisdiction: 'GB', tradingCcy: 'EUR',
  terms: { forwardType: 'fra', periodStart: '2026-06-03', periodEnd: '2026-09-03', fixingRate: 'EURIBOR3M', fixingDate: '2026-06-01', dayCount: 'ACT/360', counterparty: 'Northgate Capital Markets Ltd, London',
    collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' } },
};
const fraRow = (qty, extra) => ({ instrument: 'main', lot: 'fra', owner: 'account', qty, basis: 'agreement', agreement: 'CSA Dealer C', flagged: false, iaPosted: 0, vmPosted: 0, vmCcy: 'USD', vmPending: 0, ...extra });
const fra = {
  productId: 'fra',
  title: 'EUR 3x6 FRA on 3M EURIBOR, bought at 2.15% under a Book collateral agreement, partly terminated early, settled at the start of the period against the fixing',
  matrix: {
    ...OTC_TICKET,
    requiredFields: ['Kind of forward (Forward-rate agreement)', 'Interest period start', 'Interest period end', 'Fixing date', 'Reference rate code', 'Day count', 'Counterparty', 'Collateral basis (Agreement)', 'Account', 'Action (Buy / Sell)', 'Notional', 'State a fill price (contract rate)'],
    automaticInputs: ['mark (quote fixture standing in for a dealer indication, % a year)', 'EURIBOR3M fixing (rate fixture standing in for Shaffer MarketData)', 'EUR/USD rate (FX fixture) for the collateral exposure and the reporting currency', 'variation margin from the agreement'],
    manualInputs: ['contract rate (stated fill price)', 'collateral agreement (Treasury, Collateral, New agreement)', 'early termination of 5,000,000 at a stated amount'],
    settlement: 'No cash at entry; at the start of the period N x (L - K) x d / (1 + L x d) in EUR against the fixing of 1 June, waiting visibly while the fixing is missing; the termination amount settles on the date agreed',
    lifecycle: 'Variation margin under the agreement (automatic); early termination of part of the notional (manual); settlement at the period start against the fixing (automatic)',
    accounting: 'Nil cost; value = N x (mark - K) / 100 x 92/360 in EUR, converted to USD at the fixture; termination and settlement amounts realized in EUR',
    collateral: 'Book agreement CSA Dealer C: no independent amount; variation margin in USD, threshold 0, minimum transfer 5,000 USD; received collateral is restricted cash with a liability; returned when the contract ends',
  },
  start: AM('2026-03-02'),
  settlementCheck: { lag: 0, holidays: ['2026-04-03', '2026-05-01'] },
  book: {
    name: 'Matrix FRA', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Rates', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { forward: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: {} },
  },
  instruments: {},
  tradedOn: 'The contract names a collateral agreement of the Book, so a step registers it (Instruments, New instrument) once the agreement exists; it is then traded from the instrument drawer.',
  fx: { 'EUR/USD': 1.08 },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: cashOf(1_000_000) }, treasury: { USD: cashOf(4_000_000) } },
    positions: [], otc: [],
    nav: { account: 1_000_000, treasury: 4_000_000, book: 5_000_000 },
  },
  steps: [
    {
      id: 'record-agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer C', counterparty: 'Northgate Capital Markets Ltd', kind: 'bilateral', covers: ['account'], independentAmount: { type: 'none' }, variationMargin: true, threshold: 0, minimumTransfer: 5_000, baseCcy: 'USD', postingCcy: 'USD', haircut: 0, nettingScope: 'position' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer C with Northgate Capital Markets Ltd (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    { id: 'register', covers: 'registration', action: 'register_instrument', as: 'main', draft: FRA_DRAFT, expect: {} },
    { id: 'indication', action: 'quote', instrument: 'main', quote: { bid: 2.14, ask: 2.16, last: 2.15, bidSize: 100_000_000, askSize: 100_000_000 }, expect: {} },
    {
      id: 'open', covers: ['open', 'collateral'], action: 'ticket', instrument: 'main', side: 'buy', qty: 25_000_000, as: 'fra', order: { statedPrice: 2.15 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 25_000_000, estimate: 2.15, model: 'stated-price', settleDate: '2026-06-03', cash: 0, fees: 0 }] },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 25_000_000, avgPrice: 2.15 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought forward 25,000,000 EUR-FRA-3X6-0603 @ 2.15 for 2026-06-03', owner: 'account', date: '2026-03-02' }],
        positions: [{ instrument: 'main', lot: 'fra', owner: 'account', direction: 'long', qty: 25_000_000, avgCost: 2.15, cost: 0, price: 2.15, value: 0, unrealized: 0, notional: 25_000_000, margin: 0 }],
        holdings: { main: { long: 25_000_000, short: 0, net: 25_000_000 } },
        lifecycle: [{ type: 'forward.maturity', instrument: 'main', dueDate: '2026-06-03', status: 'pending' }],
        pnl: { account: { realized: 0, commissions: 0, unrealized: 0, total: 0 } },
        balance: { account: { cash: 1_000_000, assets: 1_000_000, liabilities: 0, netAssets: 1_000_000 } },
        otc: [fraRow(25_000_000, { mark: 2.15, markValue: 0, vmHeld: 0, vmStatus: 'not_valued_yet' })],
      },
    },
    {
      // Marked at 2.30%: 25,000,000 x 0.15 / 100 x 92/360 = 9,583.3333 = 9,583.33 EUR; at 1.08 = 10,350.00 USD.
      id: 'mark', covers: 'mark', action: 'quote', instrument: 'main', quote: { bid: 2.29, ask: 2.31, last: 2.30, bidSize: 100_000_000, askSize: 100_000_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'fra', owner: 'account', direction: 'long', qty: 25_000_000, avgCost: 2.15, cost: 0, price: 2.30, value: 9_583.33, unrealized: 9_583.33, notional: 25_000_000, margin: 0 }],
        pnl: { account: { unrealized: 10_350, total: 10_350 } },
        nav: { account: 1_010_350, book: 5_010_350 },
        balance: { account: { positions: 10_350, assets: 1_010_350, netAssets: 1_010_350 } },
        otc: [fraRow(25_000_000, { mark: 2.30, markValue: 9_583.33, vmHeld: 0, vmStatus: 'not_valued_yet' })],
      },
    },
    {
      // Exposure 10,350.00 USD, threshold 0, not below the minimum transfer: the dealer posts 10,350.00 USD.
      id: 'variation-margin', covers: ['variation margin', 'collateral'], action: 'clock', to: EOD('2026-03-02'),
      expect: {
        events: [{ type: 'collateral.variation', summary: '10,350.00 USD received', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: cashOf(1_000_000, { restricted: 10_350 }) } },
        balance: { account: { assets: 1_020_700, liabilities: 10_350, netAssets: 1_010_350 } },
        otc: [fraRow(25_000_000, { mark: 2.30, markValue: 9_583.33, vmHeld: 10_350, vmExposure: 10_350, vmStatus: 'ok' })],
      },
    },
    { id: 'tuesday', action: 'clock', to: AM('2026-03-03'), expect: {} },
    {
      // 5,000,000 of the notional is terminated early: the dealer pays 1,900.00 EUR on Thursday 5 March (the date agreed).
      // What is left: 20,000,000 x 0.15 / 100 x 92/360 = 7,666.6667 = 7,666.67 EUR = 8,280.00 USD (7,666.67 x 1.08 = 8,280.0036).
      // Realized 1,900 EUR = 2,052.00 USD at 1.08.
      id: 'terminate-part', covers: ['early termination', 'reduce'], action: 'lifecycle', lot: 'fra', body: { action: 'terminate', amount: 1_900, qty: 5_000_000, settleDate: '2026-03-05' },
      expect: {
        events: [{ type: 'forward.termination', summary: 'Terminated early: 5,000,000 of EUR-FRA-3X6-0603 (dealt 2.15) at a stated amount, received 1,900.00 EUR on 2026-03-05; 20,000,000 remains', owner: 'account', date: '2026-03-03' }],
        cash: { account: { USD: cashOf(1_000_000, { restricted: 10_350 }), EUR: cashOf(0, { unsettled: 1_900, trade: 1_900, withdraw: 0 }) } },
        positions: [{ instrument: 'main', lot: 'fra', owner: 'account', direction: 'long', qty: 20_000_000, avgCost: 2.15, cost: 0, price: 2.30, value: 7_666.67, unrealized: 7_666.67, notional: 20_000_000, margin: 0 }],
        holdings: { main: { long: 20_000_000, short: 0, net: 20_000_000 } },
        pending: [{ instrument: 'main', lot: 'fra', owner: 'account', dueDate: '2026-03-05', amount: 1_900, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: 2_052, unrealized: 8_280, total: 10_332 } },
        nav: { account: 1_010_332, book: 5_010_332 }, // 1,000,000 + 2,052 + 8,280
        balance: { account: { positions: 8_280, receivable: 2_052, assets: 1_020_682, liabilities: 10_350, netAssets: 1_010_332 } },
        otc: [fraRow(20_000_000, { mark: 2.30, markValue: 7_666.67, vmHeld: 10_350, vmExposure: 10_350, vmStatus: 'ok' })],
      },
    },
    {
      // Exposure now 8,280.00 against 10,350.00 held: 2,070.00 would go back, below the minimum transfer of 5,000. Nothing moves.
      id: 'variation-below-minimum', covers: ['variation margin', 'collateral'], action: 'clock', to: EOD('2026-03-03'),
      expect: {
        events: [],
        otc: [fraRow(20_000_000, { mark: 2.30, markValue: 7_666.67, vmHeld: 10_350, vmExposure: 8_280, vmStatus: 'ok' })],
      },
    },
    {
      id: 'termination-settles', covers: 'settlement', action: 'clock', to: AM('2026-03-05'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,900.00 EUR into settled cash', cash: { EUR: 1_900 }, owner: 'account', date: '2026-03-05' }],
        cash: { account: { USD: cashOf(1_000_000, { restricted: 10_350 }), EUR: cashOf(1_900) } },
        pending: [],
        balance: { account: { cash: 1_002_052, receivable: null } },
      },
    },
    {
      // Wednesday 3 June, the start of the period. The EURIBOR3M fixing of Monday 1 June has not been supplied: the
      // settlement waits, visibly.
      id: 'period-start-no-fixing', covers: ['fixing', 'holiday'], action: 'clock', to: AM('2026-06-03'),
      expect: { lifecycle: [{ type: 'forward.maturity', instrument: 'main', dueDate: '2026-06-03', status: 'blocked' }] },
    },
    {
      // The fixing arrives: 2.40%. d = 92/360. 20,000,000 x 0.0025 x d = 12,777.7778; 1 + 0.024 x d = 1.0061333;
      // 12,777.7778 / 1.0061333 = 12,699.8851 = 12,699.89 EUR received now. The variation margin of 10,350.00 USD goes
      // back to the dealer: the contract has ended. Realized in EUR: 1,900 + 12,699.89 = 14,599.89 = 15,767.88 USD at 1.08.
      id: 'fixing-arrives', covers: ['fixing', 'settlement', 'collateral'], action: 'rate', code: 'EURIBOR3M', value: 2.40, date: '2026-06-01',
      expect: {
        events: [
          { type: 'forward.settlement', summary: 'FRA settled against EURIBOR3M fixing 2.4% (contract 2.15%): received 12,699.89 EUR', cash: { EUR: 12_699.89 }, owner: 'account', date: '2026-06-03' },
          { type: 'collateral.variation', summary: '10,350.00 USD returned to the counterparty', owner: 'account' },
        ],
        cash: { account: { USD: cashOf(1_000_000), EUR: cashOf(14_599.89) } },
        positions: [],
        holdings: { main: null },
        lifecycle: [],
        pnl: { account: { realized: 15_767.88, unrealized: 0, total: 15_767.88 } },
        nav: { account: 1_015_767.88, book: 5_015_767.88 },
        balance: { account: { cash: 1_015_767.88, positions: null, assets: 1_015_767.88, liabilities: 0, netAssets: 1_015_767.88 } },
        otc: [],
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// equity_forward
// ---------------------------------------------------------------------------------------------
// An equity forward settled by physical delivery. The Account holds 10,000 shares of Ridgeway Industrial
// Holdings (NYSE) bought at 50.10, and sells them forward to a dealer at 52.40 for value Friday 17 April 2026
// (held across Good Friday, 3 April). On the value date the shares are delivered at the dealt price: a
// simulated delivery (no securities move), booked as a sale of the shares the Account holds at 52.40,
// settling T+1 like any sale of the stock. The forward's own value before then is quantity x (mark - dealt)
// on the dealer's indication for the forward.
// Collateral: position-level terms, a fixed independent amount of 20,000 USD, no variation margin.
// Commission: shares 0.005 USD a share (at least 1.00 an order); the forward 0.01 USD a share, paid on the value date.
const equityForward = {
  productId: 'equity_forward',
  title: 'Equity forward: 10,000 Ridgeway Industrial shares held and sold forward at 52.40, physically delivered (simulated) on 17 April 2026, fixed independent amount',
  matrix: {
    ...OTC_TICKET,
    requiredFields: ['Kind of forward (Forward on an asset)', 'Underlying (the stock)', 'Settlement (Physical delivery)', 'Multiplier (shares per unit)', 'Value date', 'Counterparty', 'Collateral basis and its terms', 'Account', 'Action (Sell)', 'quantity (shares)', 'State a fill price'],
    automaticInputs: ['stock bid and ask (quote fixture)', 'forward mark (quote fixture standing in for a dealer indication)', 'commission from the Book fee schedule', 'independent amount from the position-level terms'],
    manualInputs: ['dealt forward price (stated fill price)'],
    settlement: 'No cash at entry other than the independent amount; on the value date the shares held are delivered at the dealt price (simulated, labelled), the proceeds settling T+1; forward commission paid on the value date',
    lifecycle: 'Physical delivery on the value date (automatic), from the shares the Account holds; without them the delivery waits visibly (engine test)',
    accounting: 'Nil cost; forward value = quantity x (mark - dealt); the delivery is a sale of the shares at the dealt price, realizing against their cost',
    collateral: 'Position-level terms: fixed independent amount 20,000 USD posted at entry and returned at delivery; no variation margin',
  },
  start: AM('2026-03-23'),
  settlementCheck: { lag: 1, holidays: ['2026-04-03'] },
  book: {
    name: 'Matrix equity forward', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }],
    account: { name: 'Equities', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { equity: { perUnit: 0.005, minimum: 1, bps: 0 }, forward: { perUnit: 0.01, minimum: 0, bps: 0 } }, fill: FILL, settlement: { equity: 1 } },
  },
  instruments: {
    stock: { productId: 'common_stock', name: 'Ridgeway Industrial Holdings Inc.', symbol: 'RWIH', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Ridgeway Industrial Holdings Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    main: {
      productId: 'equity_forward', name: 'Ridgeway Industrial forward, value 17 April 2026', symbol: 'RWIH-F0417', marketView: 'US_DERIV', venueType: 'otc', jurisdiction: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 1,
      terms: { forwardType: 'asset', settlement: 'physical', valueDate: '2026-04-17', counterparty: 'Harbourline Bank N.A., New York',
        collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 20_000 }, variationMargin: false } },
    },
  },
  quotes: {
    stock: { bid: 50.08, ask: 50.10, last: 50.09, bidSize: 100_000, askSize: 100_000 },
    main: { bid: 52.38, ask: 52.42, last: 52.40, bidSize: 100_000, askSize: 100_000 },
  },
  expectAtStart: {
    ...NO_STATE,
    cash: { account: { USD: cashOf(1_000_000) }, treasury: { USD: cashOf(1_000_000) } },
    positions: [], otc: [],
    nav: { account: 1_000_000, treasury: 1_000_000, book: 2_000_000 },
  },
  steps: [
    {
      // 10,000 x 50.10 (the ask) = 501,000.00; commission 10,000 x 0.005 = 50.00; settles T+1, Tuesday 24 March.
      id: 'buy-shares', covers: 'underlying', action: 'ticket', ticketOf: 'equity', instrument: 'stock', side: 'buy', qty: 10_000, as: 'shares',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'stock', qty: 10_000, estimate: 50.10, model: 'quoted-bid-ask', settleDate: '2026-03-24', calendar: 'US', cash: -501_000, fees: 50 }],
          cash: { USD: { purchases: 501_000, fees: 50, required: 501_050, available: 1_000_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000, avgPrice: 50.10 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 10,000 RWIH @ 50.10 USD', owner: 'account', date: '2026-03-23' }],
        cash: { account: { USD: cashOf(1_000_000, { unsettled: -501_050 }) } },
        positions: [{ instrument: 'stock', lot: 'shares', owner: 'account', direction: 'long', qty: 10_000, avgCost: 50.10, cost: 501_000, price: 50.09, value: 500_900, unrealized: -100 }],
        holdings: { stock: { long: 10_000, short: 0, net: 10_000 } },
        pending: [{ instrument: 'stock', lot: 'shares', owner: 'account', dueDate: '2026-03-24', amount: -501_050, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -50, fees: 0, unrealized: -100, total: -150 } },
        nav: { account: 999_850, book: 1_999_850 },
        balance: { account: { cash: 1_000_000, positions: 500_900, payable: 501_050, assets: 1_500_900, liabilities: 501_050, netAssets: 999_850 } },
      },
    },
    {
      // 10,000 x 52.40 = 524,000.00 notional; fixed independent amount 20,000.00; commission 10,000 x 0.01 = 100.00 on the value date.
      id: 'sell-forward', covers: ['open short', 'collateral'], action: 'ticket', instrument: 'main', side: 'sell', qty: 10_000, as: 'fwd', order: { statedPrice: 52.40 }, settlementCheck: false,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 10_000, estimate: 52.40, model: 'stated-price', settleDate: '2026-04-17', cash: 0, fees: 100 }],
          cash: { USD: { purchases: 0, fees: 100, margin: 20_000, required: 20_100, available: 498_950, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000, avgPrice: 52.40 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold forward 10,000 RWIH-F0417 @ 52.40 for 2026-04-17', owner: 'account', date: '2026-03-23' },
          { type: 'forward.collateral', summary: '20,000.00 USD (independent amount', cash: { USD: -20_000 }, owner: 'account' },
        ],
        cash: { account: { USD: cashOf(980_000, { unsettled: -501_150, margin: 20_000 }) } },
        positions: [
          { instrument: 'main', lot: 'fwd', owner: 'account', direction: 'short', qty: -10_000, avgCost: 52.40, cost: 0, price: 52.40, value: 0, unrealized: 0, notional: 524_000, margin: 20_000 },
          { instrument: 'stock', lot: 'shares', owner: 'account', direction: 'long', qty: 10_000, avgCost: 50.10, cost: 501_000, price: 50.09, value: 500_900, unrealized: -100 },
        ],
        holdings: { main: { long: 0, short: 10_000, net: -10_000 }, stock: { long: 10_000, short: 0, net: 10_000 } },
        pending: [
          { instrument: 'stock', lot: 'shares', owner: 'account', dueDate: '2026-03-24', amount: -501_050, ccy: 'USD', into: 'cash' },
          { instrument: 'main', lot: 'fwd', owner: 'account', dueDate: '2026-04-17', amount: -100, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'forward.maturity', instrument: 'main', dueDate: '2026-04-17', status: 'pending' }],
        pnl: { account: { commissions: -150, unrealized: -100, total: -250 } },
        nav: { account: 999_750, book: 1_999_750 },
        balance: { account: { cash: 980_000, margin: 20_000, positions: 500_900, payable: 501_150, assets: 1_500_900, liabilities: 501_150, netAssets: 999_750 } },
        otc: [{ instrument: 'main', lot: 'fwd', owner: 'account', qty: -10_000, basis: 'position', agreement: null, flagged: false, mark: 52.40, markValue: 0, iaRequired: 20_000, iaPosted: 20_000, iaCcy: 'USD', iaStatus: 'ok', postedBy: 'account', vmPosted: 0, vmHeld: 0 }],
      },
    },
    {
      id: 'shares-settle', covers: 'settlement', action: 'clock', to: AM('2026-03-24'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 501,050.00 USD from settled cash', cash: { USD: -501_050 }, owner: 'account', date: '2026-03-24' }],
        cash: { account: { USD: cashOf(478_950, { unsettled: -100, margin: 20_000 }) } },
        pending: [{ instrument: 'main', lot: 'fwd', owner: 'account', dueDate: '2026-04-17', amount: -100, ccy: 'USD', into: 'cash' }],
        balance: { account: { cash: 478_950, payable: 100, assets: 999_850, liabilities: 100 } },
      },
    },
    { id: 'day-before-value-date', action: 'clock', to: AM('2026-04-16'), expect: {} }, // across Good Friday
    { id: 'stock-up', action: 'quote', instrument: 'stock', quote: { bid: 51.58, ask: 51.62, last: 51.60, bidSize: 100_000, askSize: 100_000 },
      expect: {
        positions: [
          { instrument: 'main', lot: 'fwd', owner: 'account', direction: 'short', qty: -10_000, avgCost: 52.40, cost: 0, price: 52.40, value: 0, unrealized: 0, notional: 524_000, margin: 20_000 },
          { instrument: 'stock', lot: 'shares', owner: 'account', direction: 'long', qty: 10_000, avgCost: 50.10, cost: 501_000, price: 51.60, value: 516_000, unrealized: 15_000 },
        ],
        pnl: { account: { unrealized: 15_000, total: 14_850 } },
        nav: { account: 1_014_850, book: 2_014_850 },
        balance: { account: { positions: 516_000, assets: 1_014_950, netAssets: 1_014_850 } },
      },
    },
    {
      // The forward's indication: 51.65. -10,000 x (51.65 - 52.40) = +7,500.00.
      id: 'forward-mark', covers: 'mark', action: 'quote', instrument: 'main', quote: { bid: 51.63, ask: 51.67, last: 51.65, bidSize: 100_000, askSize: 100_000 },
      expect: {
        positions: [
          { instrument: 'main', lot: 'fwd', owner: 'account', direction: 'short', qty: -10_000, avgCost: 52.40, cost: 0, price: 51.65, value: 7_500, unrealized: 7_500, notional: 524_000, margin: 20_000 },
          { instrument: 'stock', lot: 'shares', owner: 'account', direction: 'long', qty: 10_000, avgCost: 50.10, cost: 501_000, price: 51.60, value: 516_000, unrealized: 15_000 },
        ],
        pnl: { account: { unrealized: 22_500, total: 22_350 } },
        nav: { account: 1_022_350, book: 2_022_350 }, // 478,950 + 20,000 + 516,000 + 7,500 - 100
        balance: { account: { positions: 523_500, assets: 1_022_450, netAssets: 1_022_350 } },
        otc: [{ instrument: 'main', lot: 'fwd', owner: 'account', qty: -10_000, basis: 'position', agreement: null, flagged: false, mark: 51.65, markValue: 7_500, iaRequired: 20_000, iaPosted: 20_000, iaCcy: 'USD', iaStatus: 'ok', postedBy: 'account', vmPosted: 0, vmHeld: 0 }],
      },
    },
    {
      // Value date. The forward commission (100.00) is paid. The 10,000 shares held are delivered at 52.40 (simulated):
      // 524,000.00 receivable T+1 (Monday 20 April); realized on the shares (52.40 - 50.10) x 10,000 = 23,000.00.
      // The forward ends at its dealt price (nothing realized on it); its independent amount 20,000.00 comes back.
      // By hand, the whole scenario: 23,000 - 50 - 100 = 22,850.00.
      id: 'value-date-delivery', covers: ['physical delivery', 'settlement', 'collateral'], action: 'clock', to: AM('2026-04-17'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 100.00 USD from settled cash', cash: { USD: -100 }, owner: 'account', date: '2026-04-17' },
          { type: 'forward.delivery', summary: 'Simulated forward delivery (paper entry, no goods or securities move): delivered 10,000 RWIH at 52.40 on RWIH-F0417', owner: 'account', date: '2026-04-17' },
          { type: 'forward.collateral', summary: '20,000.00 USD (independent amount, the position ended)', cash: { USD: 20_000 }, owner: 'account' },
        ],
        cash: { account: { USD: cashOf(498_850, { unsettled: 524_000, trade: 1_022_850, withdraw: 498_850 }) } },
        positions: [],
        holdings: { main: null, stock: null },
        pending: [{ instrument: 'stock', lot: 'shares', owner: 'account', dueDate: '2026-04-20', amount: 524_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: 23_000, commissions: -150, unrealized: 0, total: 22_850 } },
        nav: { account: 1_022_850, book: 2_022_850 },
        balance: { account: { cash: 498_850, margin: null, positions: null, receivable: 524_000, payable: null, assets: 1_022_850, liabilities: 0, netAssets: 1_022_850 } },
        otc: [],
      },
    },
    {
      id: 'proceeds-settle', covers: 'settlement', action: 'clock', to: AM('2026-04-20'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 524,000.00 USD into settled cash', cash: { USD: 524_000 }, owner: 'account', date: '2026-04-20' }],
        cash: { account: { USD: cashOf(1_022_850) } },
        pending: [],
        balance: { account: { cash: 1_022_850, receivable: null, assets: 1_022_850 } },
      },
    },
  ],
};

export default [equityForward, fxForward, ndf, fra];
