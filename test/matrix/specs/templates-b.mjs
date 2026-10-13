// Execution templates, second half (t2): bear_call_spread ... custom, and the two trading paths.
//
// Each scenario drives one execution template from the Strategies page as a linked package: the legs the template
// assembles (with their quantities and dependencies), one preview priced from one quote snapshot, one confirmation,
// per-leg fills (one leg forced to fill in part by the displayed size), a dependent leg that fails and each recovery
// action (Retry, Accept as it stands, Unwind), the financing choice when the Account is short of cash, protection the
// package already carries, the settlement of every leg, its lifecycle (expiry, exercise, assignment, delivery), and
// closure with realized P&L and nothing left. The runner checks the Account, Treasury and the Book after every step,
// and restarts the application at the end.
//
// Every expected number is a literal worked out by hand from the inputs stated in the same spec. The arithmetic is in
// the comment beside it. Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be followed):
//   - An option premium is quoted per unit of the underlying; one contract is premium x 100 (the contract's multiplier).
//     A market buy fills at the ask, a market sell at the bid, up to the displayed size per matching cycle; the rest of
//     the order keeps working and fills on the next cycle.
//   - A quote is executable for 120 seconds (Book setting fill.maxQuoteAgeSec). An older quote still marks positions
//     but an order waits for a fresh one; a Day order still working at the end of its business day expires.
//   - Option commission 0.65 a contract (Book fee schedule), expensed. Premium settles T+1 on the US calendar.
//   - Written options reserve cash in their strategy instance: the worst value at expiration of the instance's options
//     (intrinsic values at each strike), plus 20% of the underlying's value for calls not covered.
//   - A package whose cash requirement exceeds what the Account has is refused; the Strategies page's Financing choice
//     adds a Treasury funding leg (an internal transfer, sized to the shortfall) that runs first.
//   - A leg that depends on another follows it: it executes at most the share of its quantity that the leg it
//     depends on has filled.
//   - Expiration is settled against the underlying close for the expiration date, after 16:00 New York time.

export const family = 'templates';

// ---- instants (New York time; US clocks move to daylight time on Sunday 8 March 2026) -------------------------------
const at = (month, d, t, offset) => {
  const [h, m] = t.split(':').map(Number);
  return `2026-${month}-${String(d).padStart(2, '0')}T${String(h + offset).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
};
const MAR = (d, t = '10:00') => at('03', d, t, d < 8 ? 5 : 4);
const APR = (d, t = '10:00') => at('04', d, t, 4);

/** The Book of every scenario, stated in full so that no figure rests on a default. */
const book = (name, over = {}) => ({
  name,
  reportingCcy: 'USD',
  capital: over.capital || [{ ccy: 'USD', amount: 1_000_000 }],
  account: { name: 'Alpha', funding: over.funding || [{ ccy: 'USD', amount: 1_000 }] },
  settings: {
    fees: { option: { perUnit: 0.65, minimum: 0, bps: 0 }, equity: { perUnit: 0.005, minimum: 1, bps: 0 }, future: { perUnit: 2.25, minimum: 0, bps: 0 }, ...(over.fees || {}) },
    fill: { halfSpreadBps: { equity: 2 }, optionHalfSpreadPct: 1, futureHalfSpreadTicks: 0.5, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 },
    settlement: { equity: 1, option: 1, future: 0, foreignCash: 2, ...(over.settlement || {}) },
    short: { collateralPct: 1.02, marginPct: 0.3 },
    margin: { nakedCallPct: 0.2 },
    dividends: { withholdingPct: 0 },
  },
});

const stockDraft = (name, symbol, issuer = name) => ({ productId: 'common_stock', name, symbol, marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer, domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} });
const equityOption = (und, symbol, right, strike, expiration, settlement = 'physical') => ({
  productId: 'equity_option', name: `${und} ${expiration} ${strike} ${right === 'C' ? 'call' : 'put'}`, symbol, marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 100,
  terms: { right, strike, expiration, exercise: 'american', settlement, deliverable: { units: 100 } },
});

/** The request the Strategies page sends for a template (web/views/strategy.js, `input`). */
const templateInput = (template, extra) => ({ template, origin: 'strategy', orderType: 'market', tif: 'day', investmentStrategy: null, holdingPeriod: null, hedgeObjective: null, ...extra });

const OPTION_TEMPLATE_MATRIX = {
  ticket: 'Strategies page: Trading owner, Execution template, Underlying of the options, Option contracts (expiration, strikes, contracts), Financing; the package preview (legs, dependencies, cash table, payoff) and one confirmation. Retry, Unwind, Accept as it stands, Close and the expiry items are on the strategy instance',
  requiredFields: ['Trading owner', 'Execution template', 'Underlying of the options', 'Expiration', 'Strikes', 'Contracts'],
  automaticInputs: ['option bid, ask, last and displayed size of every leg (quote fixture standing in for Shaffer MarketData)', 'fill price, fill model and the displayed size each cycle can take', 'premium settlement date from the US calendar', 'commission per contract from the Book fee schedule', 'cash reserved against the written legs, from the package\'s own long legs and the Book margin assumption', 'Treasury funding sized to the cash shortfall (Financing: Treasury)', 'underlying close for the expiration date (close fixture)'],
  manualInputs: ['Retry, Unwind or Accept as it stands after a leg fails', 'Close of a share of every position of the instance'],
};

// =====================================================================================================================
// bear_call_spread
// =====================================================================================================================
// Calder Freight Lines (NYSE) 20 March 2026 calls, physical delivery. Sell the 50 call and buy the 55 call, 5 of each.
// Three strategy instances:
//   spread  opened short of cash (refused), then with Treasury funding; the 55 call fills 3 of 5 on its first cycle
//           (displayed ask size 3) and the dependent 50 call follows it. Later 40% is closed while the 50 call has no
//           fresh quote: the buy-back fails, the instance needs attention, and Unwind closes it.
//   second  opened when the 50 call has no fresh quote: the 55 call fills, the dependent 50 call expires unfilled at
//           the end of the day, and Retry sells it once a quote is back. Held to expiry.
//   third   the same failure, Accepted as it stands (55 calls only). Held to expiry.
// The stock closes at 48 on 20 March: every remaining call, the written 50s and the bought 55s, expires worthless.
/** What is typed and chosen on the Strategies page for this spread (drivers/browser/templates.mjs, `strategyPage`). */
const BEAR_CALL_PAGE = (financing) => ({ template: 'Bear Call Spread', underlying: 'stock', expiration: '2026-03-20', strikes: { 'Lower strike (sold)': 50, 'Upper strike (bought)': 55 }, contracts: 5, ...(financing ? { financing } : {}) });
const bearCall = {
  template: 'bear_call_spread',
  title: 'Bear call spread on Calder Freight Lines (NYSE): sell the 20 March 2026 50 call, buy the 55 call',
  matrix: {
    ...OPTION_TEMPLATE_MATRIX,
    settlement: 'Premium of each leg T+1 on the US calendar (settlement.option = 1); Treasury funding moves at once',
    lifecycle: 'Expiry items for the written and the bought call, settled from the underlying close on 20 March 2026 (48: both lapse); trades refused after expiration; a failed dependent leg leaves the instance needing attention: Retry, Unwind or Accept',
    accounting: 'Net credit received; average premium per leg; commission expensed; premium realized on buy-back, sale and lapse; legs held gross',
    collateral: 'The written 50 calls reserve the spread width (5 x 100 x (55 - 50) = 2,500) because the bought 55 calls cover them; a 55 call sold first leaves 50 calls uncovered and adds 20% of the stock value',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: [] }, // US: no market holiday between 2 March and 20 March 2026
  book: book('Templates bear call spread'),
  instruments: {
    stock: stockDraft('Calder Freight Lines Inc.', 'CFL'),
    c50: equityOption('CFL', 'CFL260320C50', 'C', 50, '2026-03-20'),
    c55: equityOption('CFL', 'CFL260320C55', 'C', 55, '2026-03-20'),
  },
  quotes: {
    stock: { bid: 49.98, ask: 50.02, last: 50.00, bidSize: 10000, askSize: 10000 },
    c50: { bid: 2.40, ask: 2.50, last: 2.45, bidSize: 20, askSize: 20 },
    c55: { bid: 0.70, ask: 0.80, last: 0.75, bidSize: 20, askSize: 3 }, // only 3 contracts displayed at the ask
  },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 1_000, unsettled: 0, reserved: 0, availableToTrade: 1_000, availableToWithdraw: 1_000 } },
      treasury: { USD: { settled: 999_000, unsettled: 0, reserved: 0, availableToTrade: 999_000, availableToWithdraw: 999_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 1_000, treasury: 999_000, book: 1_000_000 },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
  },
  steps: [
    {
      // Without financing: the package needs 400 for the 55 calls (5 x 0.80 x 100), 6.50 of commission (10 x 0.65) and
      // 2,500 reserved for the written 50s (5 x 100 x (55 - 50)): 2,906.50. It brings 1,200 (5 x 2.40 x 100) and the
      // Account has 1,000: short by 2,906.50 - 1,200 - 1,000 = 706.50.
      id: 'open-short-of-cash', covers: 'financing', action: 'package', as: 'spread-refused', instrument: 'stock',
      input: templateInput('bear_call_spread', { underlyingId: '$inst:stock', options: { expiration: '2026-03-20', strikes: { lower: 50, upper: 55 }, contracts: 5 }, financing: null }),
      strategyPage: BEAR_CALL_PAGE(null),
      status: 'blocked', reason: 'The Account cannot fund the package: the preview is blocked until financing is chosen.',
      expect: {
        refused: 'Alpha is short 706.50 USD',
        preview: {
          blocking: 1, errors: ['cash'],
          legs: [
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'c55', qty: 5, estimate: 0.80, settleDate: '2026-03-03', cash: -400, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'sell', purpose: 'primary', instrument: 'c50', qty: 5, estimate: 2.40, settleDate: '2026-03-03', cash: 1_200, fees: 3.25, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 400, proceeds: 1_200, fees: 6.50, reserved: 2_500, required: 2_906.50, available: 1_000, shortfall: 706.50 } },
        },
      },
    },
    {
      // Financing: Treasury. A funding leg of 706.50 is added first; both trade legs wait on it. The 55 calls fill 3 at
      // 0.80 (the displayed size) and the 50 calls follow with 3 at 2.40; on the next cycle the last 2 of each fill.
      // Commission by order: 3 x 0.65 = 1.95 then 2 x 0.65 = 1.30, each leg.
      id: 'open', covers: ['open', 'financing', 'partial fill', 'dependency'], action: 'package', as: 'spread', instrument: 'stock',
      input: templateInput('bear_call_spread', { underlyingId: '$inst:stock', options: { expiration: '2026-03-20', strikes: { lower: 50, upper: 55 }, contracts: 5 }, financing: { mode: 'treasury' } }),
      strategyPage: BEAR_CALL_PAGE({ mode: 'treasury' }),
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', action: 'treasury_funding', purpose: 'financing', qty: 706.50, cash: 706.50, dependsOn: [] },
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'c55', qty: 5, estimate: 0.80, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US', cash: -400, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', purpose: 'primary', instrument: 'c50', qty: 5, estimate: 2.40, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US', cash: 1_200, fees: 3.25, dependsOn: [2, 1] },
          ],
          cash: { USD: { purchases: 400, proceeds: 1_200, fees: 6.50, reserved: 2_500, financingIn: 706.50, required: 2_906.50, available: 1_000, shortfall: 0, netCash: 1_500 } }, // 1,200 + 706.50 - 400 - 6.50
          netPremium: { amount: -800, ccy: 'USD', type: 'credit', complete: true }, // 400 paid - 1,200 received
          // The bought 55 calls cover the written 50 calls: only the width is reserved, nothing for uncovered calls.
          optionRequirement: [{ ccy: 'USD', amount: 2_500, finite: 2_500, naked: 0, uncoveredCallUnits: 0 }],
        },
        result: {
          status: 'partial',
          orders: [
            { kind: 'funding', status: 'filled', filledQty: 706.50 },
            { kind: 'trade', action: 'buy', instrument: 'c55', status: 'partial', qty: 5, filledQty: 3, avgPrice: 0.80, fills: [{ qty: 3, price: 0.80, model: 'quoted-bid-ask', settleDate: '2026-03-03', source: 'Test fixture' }] },
            { kind: 'trade', action: 'sell', instrument: 'c50', status: 'partial', qty: 5, filledQty: 3, avgPrice: 2.40, fills: [{ qty: 3, price: 2.40, model: 'quoted-bid-ask', settleDate: '2026-03-03', source: 'Test fixture' }] },
          ],
        },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 706.50 USD from Treasury to Alpha' },
          { type: 'trade.fill', summary: 'Bought 3 CFL260320C55 @ 0.80 USD', owner: 'account', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Sold 3 CFL260320C50 @ 2.40 USD', owner: 'account', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Bought 2 CFL260320C55 @ 0.80 USD', owner: 'account', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Sold 2 CFL260320C50 @ 2.40 USD', owner: 'account', date: '2026-03-02' },
        ],
        cash: {
          // settled 1,000 + 706.50; owed: -241.95 - 161.30 (3 x 80 + 1.95, 2 x 80 + 1.30); owed to it: 718.05 + 478.70
          // (720 - 1.95, 480 - 1.30): net +793.50. Reserved 2,500. To trade: 1,706.50 + 793.50 - 2,500 = 0.
          // To withdraw: 1,706.50 - 403.25 - 2,500 = -1,196.75.
          account: { USD: { settled: 1_706.50, unsettled: 793.50, reserved: 2_500, availableToTrade: 0, availableToWithdraw: -1_196.75 } },
          treasury: { USD: { settled: 998_293.50, unsettled: 0, reserved: 0, availableToTrade: 998_293.50, availableToWithdraw: 998_293.50 } },
        },
        positions: [
          { instrument: 'c50', lot: 'spread', owner: 'account', direction: 'short', qty: -5, avgCost: 2.40, cost: -1_200, price: 2.45, value: -1_225, unrealized: -25 }, // -5 x 2.45 x 100
          { instrument: 'c55', lot: 'spread', owner: 'account', direction: 'long', qty: 5, avgCost: 0.80, cost: 400, price: 0.75, value: 375, unrealized: -25 },
        ],
        holdings: { c50: { long: 0, short: 5, net: -5 }, c55: { long: 5, short: 0, net: 5 } },
        pending: [
          { instrument: 'c50', lot: 'spread', dueDate: '2026-03-03', amount: 478.70, into: 'cash' },
          { instrument: 'c50', lot: 'spread', dueDate: '2026-03-03', amount: 718.05, into: 'cash' },
          { instrument: 'c55', lot: 'spread', dueDate: '2026-03-03', amount: -241.95, into: 'cash' },
          { instrument: 'c55', lot: 'spread', dueDate: '2026-03-03', amount: -161.30, into: 'cash' },
        ],
        lifecycle: [
          { type: 'option.expiry', instrument: 'c50', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'c55', dueDate: '2026-03-20', status: 'pending' },
        ],
        pnl: {
          account: { realized: 0, commissions: -6.50, fees: 0, unrealized: -50, total: -56.50 },
          book: { realized: 0, commissions: -6.50, unrealized: -50, total: -56.50 },
          treasury: { realized: 0, commissions: 0, unrealized: 0, total: 0 },
        },
        nav: { account: 1_650, treasury: 998_293.50, book: 999_943.50 }, // 1,706.50 + 793.50 + 375 - 1,225; 1,000,000 - 56.50
        balance: {
          account: { cash: 1_706.50, receivable: 1_196.75, payable: 403.25, positions: -850, assets: 2_053.25, liabilities: 403.25, netAssets: 1_650 },
          treasury: { cash: 998_293.50, assets: 998_293.50, liabilities: 0, netAssets: 998_293.50 },
          book: { cash: 1_000_000, receivable: 1_196.75, payable: 403.25, positions: -850, assets: 1_000_346.75, liabilities: 403.25, netAssets: 999_943.50 },
        },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR(3),
      expect: {
        events: [
          // Receipts are settled before payments on the same day.
          { type: 'settlement.receive', summary: 'received 718.05 USD into settled cash', cash: { USD: 718.05 }, date: '2026-03-03' },
          { type: 'settlement.receive', summary: 'received 478.70 USD into settled cash', cash: { USD: 478.70 } },
          { type: 'settlement.pay', summary: 'paid 241.95 USD from settled cash', cash: { USD: -241.95 } },
          { type: 'settlement.pay', summary: 'paid 161.30 USD from settled cash', cash: { USD: -161.30 } },
        ],
        cash: { account: { USD: { settled: 2_500, unsettled: 0, reserved: 2_500, availableToTrade: 0, availableToWithdraw: 0 } } }, // 1,706.50 + 793.50
        pending: [],
        balance: {
          account: { cash: 2_500, receivable: null, payable: null, assets: 1_650, liabilities: 0 },
          book: { cash: 1_000_793.50, receivable: null, payable: null, assets: 999_943.50, liabilities: 0 },
        },
      },
    },
    {
      // A fresh quote for the 55 call only. The 50 call's quote of yesterday still marks it, but is too old to trade on.
      id: 'c55-quote-day2', action: 'quote', instrument: 'c55', quote: { bid: 0.60, ask: 0.70, last: 0.65, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c50', lot: 'spread', qty: -5, value: -1_225, unrealized: -25 },
          { instrument: 'c55', lot: 'spread', qty: 5, price: 0.65, value: 325, unrealized: -75 }, // 5 x 0.65 x 100 - 400
        ],
        pnl: { account: { unrealized: -100, total: -106.50 }, book: { unrealized: -100, total: -106.50 } },
        nav: { account: 1_600, book: 999_893.50 },
        balance: { account: { positions: -900, assets: 1_600, netAssets: 1_600 }, book: { positions: -900, assets: 999_893.50, netAssets: 999_893.50 } },
      },
    },
    {
      // The 50 call's quote stops updating: the same figures, last observed at 09:50. It still marks the written calls,
      // but from 09:52 it is too old to trade on.
      id: 'c50-quote-stops', action: 'quote', instrument: 'c50', quote: { bid: 2.40, ask: 2.50, last: 2.45, bidSize: 20, askSize: 20, asOf: MAR(3, '09:50') },
      expect: {},
    },
    {
      // The same spread in a second instance. 55 calls: 5 x 0.70 x 100 = 350 at the fresh ask. 50 calls: the quote is
      // ten minutes old, so the leg is estimated at its last price, 5 x 2.45 x 100 = 1,225, and will wait. Reserved 2,500 for the
      // new instance. Needs 350 + 6.50 + 2,500 = 2,856.50; brings 1,225; the Account has 0 free: funding 1,631.50.
      id: 'open-second', covers: ['open', 'financing', 'failed dependent leg'], action: 'package', as: 'second', instrument: 'stock',
      input: templateInput('bear_call_spread', { underlyingId: '$inst:stock', options: { expiration: '2026-03-20', strikes: { lower: 50, upper: 55 }, contracts: 5 }, financing: { mode: 'treasury' } }),
      strategyPage: BEAR_CALL_PAGE({ mode: 'treasury' }),
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: ['not-executable'],
          legs: [
            { kind: 'funding', purpose: 'financing', qty: 1_631.50, cash: 1_631.50 },
            { kind: 'trade', action: 'buy', instrument: 'c55', qty: 5, estimate: 0.70, settleDate: '2026-03-04', cash: -350, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c50', qty: 5, estimate: null, reference: 2.45, executable: false, settleDate: '2026-03-04', cash: 1_225, fees: 3.25, dependsOn: [2, 1] },
          ],
          cash: { USD: { purchases: 350, proceeds: 1_225, fees: 6.50, reserved: 2_500, financingIn: 1_631.50, required: 2_856.50, available: 0, shortfall: 0 } },
        },
        result: {
          status: 'partial',
          orders: [
            { kind: 'funding', status: 'filled' },
            { kind: 'trade', action: 'buy', instrument: 'c55', status: 'filled', filledQty: 5, avgPrice: 0.70 },
            { kind: 'trade', action: 'sell', instrument: 'c50', status: 'working', filledQty: 0, reason: /^The last quote is 6\d\d seconds old\. Waiting for a fresh quote\.$/ }, // 600 seconds at the engine level; the browser's clock runs on
          ],
        },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 1,631.50 USD from Treasury to Alpha' },
          { type: 'trade.fill', summary: 'Bought 5 CFL260320C55 @ 0.70 USD', date: '2026-03-03' },
        ],
        // settled 2,500 + 1,631.50; owed 350 + 3.25; reserved still 2,500 (nothing written in "second" yet).
        cash: {
          account: { USD: { settled: 4_131.50, unsettled: -353.25, reserved: 2_500, availableToTrade: 1_278.25, availableToWithdraw: 1_278.25 } },
          treasury: { USD: { settled: 996_662, availableToTrade: 996_662, availableToWithdraw: 996_662 } }, // 998,293.50 - 1,631.50
        },
        positions: [
          { instrument: 'c50', lot: 'spread', qty: -5, value: -1_225, unrealized: -25 },
          { instrument: 'c55', lot: 'second', owner: 'account', direction: 'long', qty: 5, avgCost: 0.70, cost: 350, price: 0.65, value: 325, unrealized: -25 },
          { instrument: 'c55', lot: 'spread', qty: 5, value: 325, unrealized: -75 },
        ],
        holdings: { c50: { long: 0, short: 5, net: -5 }, c55: { long: 10, short: 0, net: 10 } },
        pending: [{ instrument: 'c55', lot: 'second', dueDate: '2026-03-04', amount: -353.25, into: 'cash' }],
        openOrders: [{ instrument: 'c50', kind: 'trade', action: 'sell', status: 'working', qty: 5, filledQty: 0 }],
        lifecycle: [
          { type: 'option.expiry', instrument: 'c50', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'c55', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'c55', dueDate: '2026-03-20', status: 'pending' },
        ],
        pnl: { account: { commissions: -9.75, unrealized: -125, total: -134.75 }, book: { commissions: -9.75, unrealized: -125, total: -134.75 } },
        nav: { account: 3_203.25, treasury: 996_662, book: 999_865.25 }, // 1,600 + 1,631.50 - 3.25 - 25
        balance: {
          account: { cash: 4_131.50, payable: 353.25, positions: -575, assets: 3_556.50, liabilities: 353.25, netAssets: 3_203.25 }, // -1,225 + 325 + 325
          treasury: { cash: 996_662, assets: 996_662, netAssets: 996_662 },
          book: { cash: 1_000_793.50, payable: 353.25, positions: -575, assets: 1_000_218.50, liabilities: 353.25, netAssets: 999_865.25 },
        },
      },
    },
    {
      // A third instance, the same way. The Account now has 1,278.25 free: funding 2,856.50 - 1,225 - 1,278.25 = 353.25.
      id: 'open-third', covers: ['open', 'financing', 'failed dependent leg'], action: 'package', as: 'third', instrument: 'stock',
      input: templateInput('bear_call_spread', { underlyingId: '$inst:stock', options: { expiration: '2026-03-20', strikes: { lower: 50, upper: 55 }, contracts: 5 }, financing: { mode: 'treasury' } }),
      strategyPage: BEAR_CALL_PAGE({ mode: 'treasury' }),
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          legs: [
            { kind: 'funding', qty: 353.25, cash: 353.25 },
            { kind: 'trade', action: 'buy', instrument: 'c55', qty: 5, estimate: 0.70, cash: -350, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c50', qty: 5, estimate: null, cash: 1_225, fees: 3.25, dependsOn: [2, 1] },
          ],
          cash: { USD: { purchases: 350, proceeds: 1_225, fees: 6.50, reserved: 2_500, financingIn: 353.25, required: 2_856.50, available: 1_278.25, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ kind: 'funding', status: 'filled' }, { action: 'buy', status: 'filled', filledQty: 5, avgPrice: 0.70 }, { action: 'sell', status: 'working', filledQty: 0 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 353.25 USD from Treasury to Alpha' },
          { type: 'trade.fill', summary: 'Bought 5 CFL260320C55 @ 0.70 USD' },
        ],
        cash: {
          account: { USD: { settled: 4_484.75, unsettled: -706.50, reserved: 2_500, availableToTrade: 1_278.25, availableToWithdraw: 1_278.25 } }, // 4,131.50 + 353.25; -353.25 x 2
          treasury: { USD: { settled: 996_308.75, availableToTrade: 996_308.75, availableToWithdraw: 996_308.75 } },
        },
        positions: [
          { instrument: 'c50', lot: 'spread', qty: -5, value: -1_225 },
          { instrument: 'c55', lot: 'second', qty: 5, value: 325 },
          { instrument: 'c55', lot: 'spread', qty: 5, value: 325 },
          { instrument: 'c55', lot: 'third', owner: 'account', direction: 'long', qty: 5, avgCost: 0.70, cost: 350, price: 0.65, value: 325, unrealized: -25 },
        ],
        holdings: { c55: { long: 15, short: 0, net: 15 } },
        pending: [
          { instrument: 'c55', lot: 'second', dueDate: '2026-03-04', amount: -353.25 },
          { instrument: 'c55', lot: 'third', dueDate: '2026-03-04', amount: -353.25 },
        ],
        openOrders: [{ instrument: 'c50', action: 'sell', status: 'working', qty: 5, filledQty: 0 }, { instrument: 'c50', action: 'sell', status: 'working', qty: 5, filledQty: 0 }],
        lifecycle: [
          { type: 'option.expiry', instrument: 'c50' }, { type: 'option.expiry', instrument: 'c55' }, { type: 'option.expiry', instrument: 'c55' }, { type: 'option.expiry', instrument: 'c55' },
        ],
        pnl: { account: { commissions: -13, unrealized: -150, total: -163 }, book: { commissions: -13, unrealized: -150, total: -163 } },
        nav: { account: 3_528.25, treasury: 996_308.75, book: 999_837 },
        balance: {
          account: { cash: 4_484.75, payable: 706.50, positions: -250, assets: 4_234.75, liabilities: 706.50, netAssets: 3_528.25 }, // -1,225 + 3 x 325
          treasury: { cash: 996_308.75, assets: 996_308.75, netAssets: 996_308.75 },
          book: { cash: 1_000_793.50, payable: 706.50, positions: -250, assets: 1_000_543.50, liabilities: 706.50, netAssets: 999_837 },
        },
      },
    },
    {
      // End of 3 March: the two 50-call legs are still working as Day orders and expire. Each instance holds its 55 calls
      // and no written calls: it needs attention. The 55-call purchases settle on 4 March.
      id: 'dependent-legs-expire', covers: ['failed dependent leg', 'settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 353.25 USD from settled cash', date: '2026-03-04' },
          { type: 'settlement.pay', summary: 'paid 353.25 USD from settled cash', date: '2026-03-04' },
          { type: 'order.expired', summary: 'Leg 3 expired: sell 5 CFL260320C50. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 3 expired: sell 5 CFL260320C50. Day order did not fill before the end of the business day' },
        ],
        cash: { account: { USD: { settled: 3_778.25, unsettled: 0, availableToTrade: 1_278.25, availableToWithdraw: 1_278.25 } } }, // 4,484.75 - 706.50
        pending: [],
        openOrders: [],
        failed: { orders: 2 },
        alerts: ['strategy.attention', 'strategy.attention'],
        balance: { account: { cash: 3_778.25, payable: null, assets: 3_528.25, liabilities: 0 }, book: { cash: 1_000_087, payable: null, assets: 999_837, liabilities: 0 } },
      },
    },
    {
      id: 'c50-quote-day3', action: 'quote', instrument: 'c50', quote: { bid: 2.20, ask: 2.30, last: 2.25, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c50', lot: 'spread', qty: -5, price: 2.25, value: -1_125, unrealized: 75 }, // -5 x 2.25 x 100 + 1,200
          { instrument: 'c55', lot: 'second', qty: 5, value: 325, unrealized: -25 },
          { instrument: 'c55', lot: 'spread', qty: 5, value: 325, unrealized: -75 },
          { instrument: 'c55', lot: 'third', qty: 5, value: 325, unrealized: -25 },
        ],
        pnl: { account: { unrealized: -50, total: -63 }, book: { unrealized: -50, total: -63 } }, // 75 - 75 - 25 - 25; -13 - 50
        nav: { account: 3_628.25, book: 999_937 },
        balance: { account: { positions: -150, assets: 3_628.25, netAssets: 3_628.25 }, book: { positions: -150, assets: 999_937, netAssets: 999_937 } },
      },
    },
    {
      // Retry sells 5 50 calls in "second" and reserves 2,500 more: the Account needs more cash first.
      id: 'fund-account', covers: 'internal funding', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 5_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 5,000.00 USD from Treasury to Alpha' }],
        cash: {
          account: { USD: { settled: 8_778.25, availableToTrade: 6_278.25, availableToWithdraw: 6_278.25 } },
          treasury: { USD: { settled: 991_308.75, availableToTrade: 991_308.75, availableToWithdraw: 991_308.75 } },
        },
        nav: { account: 8_628.25, treasury: 991_308.75 },
        balance: { account: { cash: 8_778.25, assets: 8_628.25, netAssets: 8_628.25 }, treasury: { cash: 991_308.75, assets: 991_308.75, netAssets: 991_308.75 } },
      },
    },
    {
      // Retry: the failed leg again, 5 50 calls at the fresh bid 2.20 = 1,100. The instance's written calls are covered by
      // its 55 calls: 2,500 reserved. Needs 3.25 + 2,500 = 2,503.25; 1,100 comes in; 6,278.25 is free.
      id: 'retry-second', covers: ['retry', 'failed dependent leg'], action: 'recover', how: 'retry', lot: 'second',
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'retry',
          legs: [{ kind: 'trade', action: 'sell', instrument: 'c50', qty: 5, estimate: 2.20, settleDate: '2026-03-05', cash: 1_100, fees: 3.25 }],
          cash: { USD: { purchases: 0, proceeds: 1_100, fees: 3.25, reserved: 2_500, required: 2_503.25, available: 6_278.25, shortfall: 0 } },
          optionRequirement: [{ ccy: 'USD', amount: 2_500, finite: 2_500, naked: 0, uncoveredCallUnits: 0 }],
        },
        result: { status: 'open', complete: true, orders: [{ kind: 'trade', action: 'sell', instrument: 'c50', status: 'filled', filledQty: 5, avgPrice: 2.20 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 5 CFL260320C50 @ 2.20 USD', date: '2026-03-04' }],
        // owed to the Account: 1,100 - 3.25 = 1,096.75; reserved 2,500 + 2,500
        cash: { account: { USD: { settled: 8_778.25, unsettled: 1_096.75, reserved: 5_000, availableToTrade: 4_875, availableToWithdraw: 3_778.25 } } },
        positions: [
          { instrument: 'c50', lot: 'second', owner: 'account', direction: 'short', qty: -5, avgCost: 2.20, cost: -1_100, price: 2.25, value: -1_125, unrealized: -25 },
          { instrument: 'c50', lot: 'spread', qty: -5, value: -1_125, unrealized: 75 },
          { instrument: 'c55', lot: 'second', qty: 5, value: 325, unrealized: -25 },
          { instrument: 'c55', lot: 'spread', qty: 5, value: 325, unrealized: -75 },
          { instrument: 'c55', lot: 'third', qty: 5, value: 325, unrealized: -25 },
        ],
        holdings: { c50: { long: 0, short: 10, net: -10 } },
        pending: [{ instrument: 'c50', lot: 'second', dueDate: '2026-03-05', amount: 1_096.75, into: 'cash' }],
        lifecycle: [
          { type: 'option.expiry', instrument: 'c50' }, { type: 'option.expiry', instrument: 'c50' },
          { type: 'option.expiry', instrument: 'c55' }, { type: 'option.expiry', instrument: 'c55' }, { type: 'option.expiry', instrument: 'c55' },
        ],
        failed: { orders: 2 }, // the Failed tab keeps the record of both expired legs; the retried one is marked resolved
        alerts: ['strategy.attention'],
        pnl: { account: { commissions: -16.25, unrealized: -75, total: -91.25 }, book: { commissions: -16.25, unrealized: -75, total: -91.25 } },
        nav: { account: 8_600, book: 999_908.75 }, // 8,628.25 - 3.25 - 25
        balance: {
          account: { cash: 8_778.25, receivable: 1_096.75, positions: -1_275, assets: 8_600, liabilities: 0, netAssets: 8_600 },
          book: { cash: 1_000_087, receivable: 1_096.75, positions: -1_275, assets: 999_908.75, netAssets: 999_908.75 },
        },
      },
    },
    {
      // Accept as it stands: "third" keeps its 55 calls without the written 50s. Nothing is traded.
      id: 'accept-third', covers: ['accept', 'failed dependent leg'], action: 'strategy_action', lot: 'third', how: 'accept',
      expect: {
        events: [{ type: 'strategy.accepted', summary: 'accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }],
        alerts: [],
      },
    },
    {
      id: 'settle-retry', covers: 'settlement', action: 'clock', to: MAR(5),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,096.75 USD into settled cash', date: '2026-03-05' }],
        cash: { account: { USD: { settled: 9_875, unsettled: 0, availableToTrade: 4_875, availableToWithdraw: 4_875 } } },
        pending: [],
        balance: { account: { cash: 9_875, receivable: null }, book: { cash: 1_001_183.75, receivable: null } },
      },
    },
    {
      id: 'c55-quote-day4', action: 'quote', instrument: 'c55', quote: { bid: 0.50, ask: 0.60, last: 0.55, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c50', lot: 'second', value: -1_125, unrealized: -25 },
          { instrument: 'c50', lot: 'spread', value: -1_125, unrealized: 75 },
          { instrument: 'c55', lot: 'second', price: 0.55, value: 275, unrealized: -75 }, // 5 x 0.55 x 100 - 350
          { instrument: 'c55', lot: 'spread', price: 0.55, value: 275, unrealized: -125 },
          { instrument: 'c55', lot: 'third', price: 0.55, value: 275, unrealized: -75 },
        ],
        pnl: { account: { unrealized: -225, total: -241.25 }, book: { unrealized: -225, total: -241.25 } },
        nav: { account: 8_450, book: 999_758.75 }, // 9,875 - 2,250 + 825
        balance: { account: { positions: -1_425, assets: 8_450, netAssets: 8_450 }, book: { positions: -1_425, assets: 999_758.75, netAssets: 999_758.75 } },
      },
    },
    { id: 'c50-quote-stops-again', action: 'quote', instrument: 'c50', quote: { bid: 2.20, ask: 2.30, last: 2.25, bidSize: 20, askSize: 20, asOf: MAR(5, '09:50') }, expect: {} },
    {
      // Close 40% of "spread": sell 2 of its 55 calls (2 x 0.50 x 100 = 100) and buy back 2 of its 50 calls (estimated at
      // the last 2.25: 450; no fresh quote, so it waits). The 55-call sale fills first; the 50 calls it covered are now
      // short 5 against 3: 2 calls (200 shares) uncovered add 20% of 200 x 50.00 = 2,000, so "spread" reserves 4,500.
      // Realized on the sale: 2 x (0.50 - 0.80) x 100 = -60.
      id: 'close-part-buyback-fails', covers: ['reduce', 'failed leg'], action: 'close', lot: 'spread', instrument: 'c55', scope: 'strategy', percent: 40,
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'], intent: 'close',
          legs: [
            { kind: 'trade', action: 'sell', instrument: 'c55', qty: 2, estimate: 0.50, settleDate: '2026-03-06', cash: 100, fees: 1.30 },
            { kind: 'trade', action: 'buy', instrument: 'c50', qty: 2, estimate: null, reference: 2.25, executable: false, settleDate: '2026-03-06', cash: -450, fees: 1.30 },
          ],
          cash: { USD: { purchases: 450, proceeds: 100, fees: 2.60, reserved: 0, required: 452.60, available: 4_875, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ action: 'sell', instrument: 'c55', status: 'filled', filledQty: 2, avgPrice: 0.50 }, { action: 'buy', instrument: 'c50', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2 CFL260320C55 @ 0.50 USD (realized -60.00 USD)', date: '2026-03-05' }],
        // owed to the Account 100 - 1.30 = 98.70; reserved 4,500 + 2,500
        cash: { account: { USD: { settled: 9_875, unsettled: 98.70, reserved: 7_000, availableToTrade: 2_973.70, availableToWithdraw: 2_875 } } },
        positions: [
          { instrument: 'c50', lot: 'second', value: -1_125 },
          { instrument: 'c50', lot: 'spread', qty: -5, value: -1_125, unrealized: 75 },
          { instrument: 'c55', lot: 'second', qty: 5, value: 275 },
          { instrument: 'c55', lot: 'spread', qty: 3, avgCost: 0.80, cost: 240, value: 165, unrealized: -75 }, // 3 x 0.55 x 100 - 240
          { instrument: 'c55', lot: 'third', qty: 5, value: 275 },
        ],
        holdings: { c55: { long: 13, short: 0, net: 13 } },
        pending: [{ instrument: 'c55', lot: 'spread', dueDate: '2026-03-06', amount: 98.70, into: 'cash' }],
        openOrders: [{ instrument: 'c50', kind: 'trade', action: 'buy', status: 'working', qty: 2, filledQty: 0 }],
        pnl: { account: { realized: -60, commissions: -17.55, unrealized: -175, total: -252.55 }, book: { realized: -60, commissions: -17.55, unrealized: -175, total: -252.55 } },
        nav: { account: 8_438.70, book: 999_747.45 }, // 8,450 - 10 (sold 0.05 under the mark) - 1.30
        balance: {
          account: { cash: 9_875, receivable: 98.70, positions: -1_535, assets: 8_438.70, netAssets: 8_438.70 },
          book: { cash: 1_001_183.75, receivable: 98.70, positions: -1_535, assets: 999_747.45, netAssets: 999_747.45 },
        },
      },
    },
    {
      // End of 5 March: the buy-back expires. "spread" holds 3 bought and 5 written calls and needs attention.
      id: 'buyback-expires', covers: ['failed leg', 'settlement'], action: 'clock', to: MAR(6),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 98.70 USD into settled cash', date: '2026-03-06' },
          { type: 'order.expired', summary: 'expired: buy 2 CFL260320C50. Day order did not fill before the end of the business day' },
        ],
        cash: { account: { USD: { settled: 9_973.70, unsettled: 0, reserved: 7_000, availableToTrade: 2_973.70, availableToWithdraw: 2_973.70 } } },
        pending: [], openOrders: [],
        failed: { orders: 3 },
        alerts: ['strategy.attention'],
        balance: { account: { cash: 9_973.70, receivable: null }, book: { cash: 1_001_282.45, receivable: null } },
      },
    },
    {
      id: 'c50-quote-day5', action: 'quote', instrument: 'c50', quote: { bid: 2.00, ask: 2.10, last: 2.05, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c50', lot: 'second', price: 2.05, value: -1_025, unrealized: 75 }, // -5 x 2.05 x 100 + 1,100
          { instrument: 'c50', lot: 'spread', price: 2.05, value: -1_025, unrealized: 175 },
          { instrument: 'c55', lot: 'second', value: 275, unrealized: -75 },
          { instrument: 'c55', lot: 'spread', value: 165, unrealized: -75 },
          { instrument: 'c55', lot: 'third', value: 275, unrealized: -75 },
        ],
        pnl: { account: { unrealized: 25, total: -52.55 }, book: { unrealized: 25, total: -52.55 } },
        nav: { account: 8_638.70, book: 999_947.45 }, // 9,973.70 - 2,050 + 715
        balance: { account: { positions: -1_335, assets: 8_638.70, netAssets: 8_638.70 }, book: { positions: -1_335, assets: 999_947.45, netAssets: 999_947.45 } },
      },
    },
    {
      id: 'c55-quote-day5', action: 'quote', instrument: 'c55', quote: { bid: 0.40, ask: 0.50, last: 0.45, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c50', lot: 'second', value: -1_025, unrealized: 75 },
          { instrument: 'c50', lot: 'spread', value: -1_025, unrealized: 175 },
          { instrument: 'c55', lot: 'second', price: 0.45, value: 225, unrealized: -125 },
          { instrument: 'c55', lot: 'spread', price: 0.45, value: 135, unrealized: -105 },
          { instrument: 'c55', lot: 'third', price: 0.45, value: 225, unrealized: -125 },
        ],
        pnl: { account: { unrealized: -105, total: -182.55 }, book: { unrealized: -105, total: -182.55 } },
        nav: { account: 8_508.70, book: 999_817.45 }, // 9,973.70 - 2,050 + 585
        balance: { account: { positions: -1_465, assets: 8_508.70, netAssets: 8_508.70 }, book: { positions: -1_465, assets: 999_817.45, netAssets: 999_817.45 } },
      },
    },
    {
      // Unwind "spread": sell its 3 remaining 55 calls at 0.40 (120) and buy back its 5 50 calls at 2.10 (1,050).
      // Realized: 3 x (0.40 - 0.80) x 100 = -120 and 5 x (2.40 - 2.10) x 100 = +150. Nothing is left in it.
      id: 'unwind-spread', covers: ['unwind', 'close'], action: 'recover', how: 'unwind', lot: 'spread',
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'unwind',
          legs: [
            { kind: 'trade', action: 'sell', instrument: 'c55', qty: 3, estimate: 0.40, settleDate: '2026-03-09', cash: 120, fees: 1.95 },
            { kind: 'trade', action: 'buy', instrument: 'c50', qty: 5, estimate: 2.10, settleDate: '2026-03-09', cash: -1_050, fees: 3.25 },
          ],
          cash: { USD: { purchases: 1_050, proceeds: 120, fees: 5.20, reserved: 0, required: 1_055.20, available: 2_973.70, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'c55', status: 'filled', filledQty: 3, avgPrice: 0.40 }, { action: 'buy', instrument: 'c50', status: 'filled', filledQty: 5, avgPrice: 2.10 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 3 CFL260320C55 @ 0.40 USD (realized -120.00 USD)' },
          { type: 'trade.fill', summary: 'Bought 5 CFL260320C50 @ 2.10 USD (realized 150.00 USD)' },
        ],
        // owed: -1,053.25 (1,050 + 3.25); owed to it: 118.05 (120 - 1.95). "spread" reserves nothing now; "second" 2,500.
        cash: { account: { USD: { settled: 9_973.70, unsettled: -935.20, reserved: 2_500, availableToTrade: 6_538.50, availableToWithdraw: 6_420.45 } } },
        positions: [
          { instrument: 'c50', lot: 'second', qty: -5, value: -1_025, unrealized: 75 },
          { instrument: 'c55', lot: 'second', qty: 5, value: 225, unrealized: -125 },
          { instrument: 'c55', lot: 'third', qty: 5, value: 225, unrealized: -125 },
        ],
        holdings: { c50: { long: 0, short: 5, net: -5 }, c55: { long: 10, short: 0, net: 10 } },
        pending: [
          { instrument: 'c50', lot: 'spread', dueDate: '2026-03-09', amount: -1_053.25, into: 'cash' },
          { instrument: 'c55', lot: 'spread', dueDate: '2026-03-09', amount: 118.05, into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'c50' }, { type: 'option.expiry', instrument: 'c55' }, { type: 'option.expiry', instrument: 'c55' }],
        alerts: [],
        pnl: { account: { realized: -30, commissions: -22.75, unrealized: -175, total: -227.75 }, book: { realized: -30, commissions: -22.75, unrealized: -175, total: -227.75 } },
        nav: { account: 8_463.50, book: 999_772.25 }, // 8,508.70 - 25 - 15 - 5.20
        balance: {
          account: { cash: 9_973.70, receivable: 118.05, payable: 1_053.25, positions: -575, assets: 9_516.75, liabilities: 1_053.25, netAssets: 8_463.50 },
          book: { cash: 1_001_282.45, receivable: 118.05, payable: 1_053.25, positions: -575, assets: 1_000_825.50, liabilities: 1_053.25, netAssets: 999_772.25 },
        },
      },
    },
    {
      id: 'settle-unwind', covers: 'settlement', action: 'clock', to: MAR(9),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 118.05 USD into settled cash', date: '2026-03-09' },
          { type: 'settlement.pay', summary: 'paid 1,053.25 USD from settled cash', date: '2026-03-09' },
        ],
        cash: { account: { USD: { settled: 9_038.50, unsettled: 0, availableToTrade: 6_538.50, availableToWithdraw: 6_538.50 } } }, // 9,973.70 + 118.05 - 1,053.25
        pending: [],
        balance: {
          account: { cash: 9_038.50, receivable: null, payable: null, assets: 8_463.50, liabilities: 0 },
          book: { cash: 1_000_347.25, receivable: null, payable: null, assets: 999_772.25, liabilities: 0 },
        },
      },
    },
    { id: 'expiry-close', action: 'close_price', instrument: 'stock', date: '2026-03-20', value: 48.00, expect: {} },
    {
      // The stock closes at 48, below both strikes: every remaining call expires worthless. Realized: the written 50s of
      // "second" keep their 1,100 premium; the 55s of "second" and "third" lose 350 each. 370 = -30 + 1,100 - 350 - 350.
      id: 'expiry', covers: ['expiry', 'close'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [
          { type: 'option.expired', summary: 'Expired worthless: 5 CFL260320C55 (fixing 48)', date: '2026-03-20' },
          { type: 'option.expired', summary: 'Expired worthless: 5 CFL260320C55 (fixing 48)', date: '2026-03-20' },
          { type: 'option.expired', summary: 'Expired worthless: 5 CFL260320C50 (fixing 48)', date: '2026-03-20' },
        ],
        cash: { account: { USD: { settled: 9_038.50, unsettled: 0, reserved: 0, availableToTrade: 9_038.50, availableToWithdraw: 9_038.50 } } },
        positions: [],
        holdings: { c50: null, c55: null },
        lifecycle: [],
        pnl: { account: { realized: 370, commissions: -22.75, unrealized: 0, total: 347.25 }, book: { realized: 370, commissions: -22.75, unrealized: 0, total: 347.25 } },
        nav: { account: 9_038.50, treasury: 991_308.75, book: 1_000_347.25 }, // 1,000,000 + 347.25
        balance: {
          account: { cash: 9_038.50, positions: null, assets: 9_038.50, liabilities: 0, netAssets: 9_038.50 },
          book: { cash: 1_000_347.25, positions: null, assets: 1_000_347.25, liabilities: 0, netAssets: 1_000_347.25 },
        },
      },
    },
    { id: 'next-business-day', action: 'clock', to: MAR(23), expect: {} },
    {
      id: 'open-after-expiry', covers: 'expired contract', action: 'package', as: 'late', instrument: 'stock',
      input: templateInput('bear_call_spread', { underlyingId: '$inst:stock', options: { expiration: '2026-03-20', strikes: { lower: 50, upper: 55 }, contracts: 5 }, financing: null }),
      strategyPage: BEAR_CALL_PAGE(null),
      status: 'blocked', reason: 'The contracts expired on 20 March 2026; nothing can be traded in them.',
      expect: { refused: 'CFL260320C55 expired on 2026-03-20' },
    },
  ],
};

// =====================================================================================================================
// long_straddle
// =====================================================================================================================
// Brightwater Biotech (NYSE) 17 April 2026 40 call and 40 put, physical delivery: buy 5 of each. Both legs are bought,
// so nothing is reserved: the premium paid is the most the package can lose. The legs do not depend on each other;
// with Treasury funding both wait on the funding leg. Four strategy instances:
//   straddle  opened short of cash (refused), then with Treasury funding; the put fills 4 of 5 on its first cycle.
//             Held over Good Friday (3 April, NYSE closed) to expiry: the stock closes at 46, the call is exercised
//             (500 shares delivered at 40, settled T+1) and the put lapses, on the same day. The shares are then sold.
//   retry     1 call and 1 put when the put has no fresh quote: the put expires unfilled; Retry buys it; then Close.
//   accept    the same failure, Accepted as it stands (the call alone), held to expiry: 100 shares delivered, sold.
//   unwind    the same failure, Unwound: the call is sold back.
const STRADDLE_PAGE = (contracts, financing) => ({ template: 'Long Straddle', underlying: 'stock', expiration: '2026-04-17', strikes: { Strike: 40 }, contracts, ...(financing ? { financing } : {}) });
const straddleInput = (contracts, financing) => templateInput('long_straddle', { underlyingId: '$inst:stock', options: { expiration: '2026-04-17', strikes: { middle: 40 }, contracts }, financing });
const straddleOne = (as) => ({
  // 1 call at 2.10 (210) and 1 put estimated at its last 1.85 (185, its quote is ten minutes old), 1.30 commission.
  action: 'package', as, instrument: 'stock', input: straddleInput(1, { mode: 'treasury' }), strategyPage: STRADDLE_PAGE(1, { mode: 'treasury' }),
});
const longStraddle = {
  template: 'long_straddle',
  title: 'Long straddle on Brightwater Biotech (NYSE): buy the 17 April 2026 40 call and 40 put',
  matrix: {
    ...OPTION_TEMPLATE_MATRIX,
    settlement: 'Premium of each leg T+1 on the US calendar; shares delivered on exercise T+1 at the strike (settlement.equity = 1); Treasury funding moves at once',
    lifecycle: 'Expiry items for the call and the put on the same day, from the underlying close on 17 April 2026 (46: the call is exercised with a simulated delivery of the shares, the put lapses); held across Good Friday (3 April); a failed leg leaves the instance needing attention: Retry, Unwind or Accept',
    accounting: 'Net debit paid; average premium per leg; commission expensed; premium realized on sale, exercise (closed at zero) and lapse; delivered shares carried at the strike and sold',
    collateral: 'None reserved: both legs are bought (no written option); the cash requirement is the premium and the commission',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: ['2026-04-03'] }, // US: Good Friday 3 April 2026; no other holiday in March or April
  book: book('Templates long straddle'),
  instruments: {
    stock: stockDraft('Brightwater Biotech Inc.', 'BWB'),
    c40: equityOption('BWB', 'BWB260417C40', 'C', 40, '2026-04-17'),
    p40: equityOption('BWB', 'BWB260417P40', 'P', 40, '2026-04-17'),
  },
  quotes: {
    stock: { bid: 39.98, ask: 40.02, last: 40.00, bidSize: 10000, askSize: 10000 },
    c40: { bid: 2.00, ask: 2.10, last: 2.05, bidSize: 20, askSize: 20 },
    p40: { bid: 1.80, ask: 1.90, last: 1.85, bidSize: 20, askSize: 4 }, // only 4 contracts displayed at the ask
  },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 1_000, unsettled: 0, reserved: 0, availableToTrade: 1_000, availableToWithdraw: 1_000 } },
      treasury: { USD: { settled: 999_000, unsettled: 0, reserved: 0, availableToTrade: 999_000, availableToWithdraw: 999_000 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 1_000, treasury: 999_000, book: 1_000_000 },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
  },
  steps: [
    {
      // 5 calls at 2.10 (1,050) and 5 puts at 1.90 (950), 10 x 0.65 = 6.50: 2,006.50 against 1,000 in the Account.
      id: 'open-short-of-cash', covers: 'financing', action: 'package', as: 'refused', instrument: 'stock',
      input: straddleInput(5, null), strategyPage: STRADDLE_PAGE(5, null),
      status: 'blocked', reason: 'The Account cannot pay for the package: the preview is blocked until financing is chosen.',
      expect: {
        refused: 'Alpha is short 1,006.50 USD',
        preview: {
          blocking: 1, errors: ['cash'],
          legs: [
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'c40', qty: 5, estimate: 2.10, settleDate: '2026-03-03', cash: -1_050, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'p40', qty: 5, estimate: 1.90, settleDate: '2026-03-03', cash: -950, fees: 3.25, dependsOn: [] },
          ],
          cash: { USD: { purchases: 2_000, proceeds: 0, fees: 6.50, reserved: 0, required: 2_006.50, available: 1_000, shortfall: 1_006.50 } },
        },
      },
    },
    {
      // Treasury funding of 1,006.50 runs first; both legs wait on it. The call fills 5 at 2.10; the put 4 at 1.90 (the
      // displayed size), then 1 on the next cycle. Commission on the put: 4 x 0.65 = 2.60, then 0.65.
      id: 'open', covers: ['open', 'financing', 'partial fill', 'dependency'], action: 'package', as: 'straddle', instrument: 'stock',
      input: straddleInput(5, { mode: 'treasury' }), strategyPage: STRADDLE_PAGE(5, { mode: 'treasury' }),
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', action: 'treasury_funding', purpose: 'financing', qty: 1_006.50, cash: 1_006.50, dependsOn: [] },
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'c40', qty: 5, estimate: 2.10, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US', cash: -1_050, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'p40', qty: 5, estimate: 1.90, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US', cash: -950, fees: 3.25, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 2_000, fees: 6.50, reserved: 0, financingIn: 1_006.50, required: 2_006.50, available: 1_000, shortfall: 0, netCash: -1_000 } }, // 1,006.50 - 2,000 - 6.50
          netPremium: { amount: 2_000, ccy: 'USD', type: 'debit', complete: true },
          optionRequirement: [], // nothing written, nothing reserved
        },
        result: {
          status: 'partial',
          orders: [
            { kind: 'funding', status: 'filled', filledQty: 1_006.50 },
            { kind: 'trade', action: 'buy', instrument: 'c40', status: 'filled', filledQty: 5, avgPrice: 2.10 },
            { kind: 'trade', action: 'buy', instrument: 'p40', status: 'partial', qty: 5, filledQty: 4, avgPrice: 1.90, fills: [{ qty: 4, price: 1.90, model: 'quoted-bid-ask', settleDate: '2026-03-03', source: 'Test fixture' }] },
          ],
        },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 1,006.50 USD from Treasury to Alpha' },
          { type: 'trade.fill', summary: 'Bought 5 BWB260417C40 @ 2.10 USD', owner: 'account', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Bought 4 BWB260417P40 @ 1.90 USD', owner: 'account', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Bought 1 BWB260417P40 @ 1.90 USD', owner: 'account', date: '2026-03-02' },
        ],
        cash: {
          // settled 1,000 + 1,006.50; owed 1,053.25 + 762.60 + 190.65 = 2,006.50
          account: { USD: { settled: 2_006.50, unsettled: -2_006.50, reserved: 0, availableToTrade: 0, availableToWithdraw: 0 } },
          treasury: { USD: { settled: 997_993.50, unsettled: 0, reserved: 0, availableToTrade: 997_993.50, availableToWithdraw: 997_993.50 } }, // 999,000 - 1,006.50
        },
        positions: [
          { instrument: 'c40', lot: 'straddle', owner: 'account', direction: 'long', qty: 5, avgCost: 2.10, cost: 1_050, price: 2.05, value: 1_025, unrealized: -25 },
          { instrument: 'p40', lot: 'straddle', owner: 'account', direction: 'long', qty: 5, avgCost: 1.90, cost: 950, price: 1.85, value: 925, unrealized: -25 },
        ],
        holdings: { c40: { long: 5, short: 0, net: 5 }, p40: { long: 5, short: 0, net: 5 } },
        pending: [
          { instrument: 'c40', lot: 'straddle', dueDate: '2026-03-03', amount: -1_053.25, into: 'cash' },
          { instrument: 'p40', lot: 'straddle', dueDate: '2026-03-03', amount: -762.60, into: 'cash' },
          { instrument: 'p40', lot: 'straddle', dueDate: '2026-03-03', amount: -190.65, into: 'cash' },
        ],
        lifecycle: [
          { type: 'option.expiry', instrument: 'c40', dueDate: '2026-04-17', status: 'pending' },
          { type: 'option.expiry', instrument: 'p40', dueDate: '2026-04-17', status: 'pending' },
        ],
        pnl: {
          account: { realized: 0, commissions: -6.50, fees: 0, unrealized: -50, total: -56.50 },
          book: { realized: 0, commissions: -6.50, unrealized: -50, total: -56.50 },
          treasury: { realized: 0, commissions: 0, unrealized: 0, total: 0 },
        },
        nav: { account: 1_950, treasury: 997_993.50, book: 999_943.50 }, // 2,006.50 - 2,006.50 + 1,025 + 925
        balance: {
          account: { cash: 2_006.50, payable: 2_006.50, positions: 1_950, assets: 3_956.50, liabilities: 2_006.50, netAssets: 1_950 },
          treasury: { cash: 997_993.50, assets: 997_993.50, liabilities: 0, netAssets: 997_993.50 },
          book: { cash: 1_000_000, payable: 2_006.50, positions: 1_950, assets: 1_001_950, liabilities: 2_006.50, netAssets: 999_943.50 },
        },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR(3),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 1,053.25 USD from settled cash', date: '2026-03-03' },
          { type: 'settlement.pay', summary: 'paid 762.60 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 190.65 USD from settled cash' },
        ],
        // Every USD balance of the Account is now zero: it has no cash line at all (shown as no cash, not as a figure).
        cash: { account: null },
        pending: [],
        balance: {
          account: { cash: null, payable: null, assets: 1_950, liabilities: 0 },
          book: { cash: 997_993.50, payable: null, assets: 999_943.50, liabilities: 0 },
        },
      },
    },
    // The put's quote stops updating at 09:50: it still marks, but from 09:52 it cannot be traded on.
    { id: 'p40-quote-stops', action: 'quote', instrument: 'p40', quote: { bid: 1.80, ask: 1.90, last: 1.85, bidSize: 20, askSize: 20, asOf: MAR(3, '09:50') }, expect: {} },
    {
      ...straddleOne('retry'), id: 'open-retry', covers: ['open', 'financing', 'failed leg'],
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          legs: [
            { kind: 'funding', qty: 396.30, cash: 396.30 }, // 210 + 185 + 1.30 against 0 free
            { kind: 'trade', action: 'buy', instrument: 'c40', qty: 1, estimate: 2.10, settleDate: '2026-03-04', cash: -210, fees: 0.65, dependsOn: [1] },
            { kind: 'trade', action: 'buy', instrument: 'p40', qty: 1, estimate: null, reference: 1.85, executable: false, settleDate: '2026-03-04', cash: -185, fees: 0.65, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 395, fees: 1.30, financingIn: 396.30, required: 396.30, available: 0, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ kind: 'funding', status: 'filled' }, { instrument: 'c40', status: 'filled', filledQty: 1, avgPrice: 2.10 }, { instrument: 'p40', status: 'working', filledQty: 0, reason: /^The last quote is 6\d\d seconds old\. Waiting for a fresh quote\.$/ }] },
        events: [{ type: 'strategy.submitted' }, { type: 'transfer.funding', summary: 'Treasury funding: 396.30 USD from Treasury to Alpha' }, { type: 'trade.fill', summary: 'Bought 1 BWB260417C40 @ 2.10 USD', date: '2026-03-03' }],
        cash: {
          account: { USD: { settled: 396.30, unsettled: -210.65, reserved: 0, availableToTrade: 185.65, availableToWithdraw: 185.65 } },
          treasury: { USD: { settled: 997_597.20, availableToTrade: 997_597.20, availableToWithdraw: 997_597.20 } },
        },
        positions: [
          { instrument: 'c40', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 2.10, cost: 210, price: 2.05, value: 205, unrealized: -5 },
          { instrument: 'c40', lot: 'straddle', qty: 5, value: 1_025, unrealized: -25 },
          { instrument: 'p40', lot: 'straddle', qty: 5, value: 925, unrealized: -25 },
        ],
        holdings: { c40: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'c40', lot: 'retry', dueDate: '2026-03-04', amount: -210.65, into: 'cash' }],
        openOrders: [{ instrument: 'p40', kind: 'trade', action: 'buy', status: 'working', qty: 1, filledQty: 0 }],
        lifecycle: [{ type: 'option.expiry', instrument: 'c40' }, { type: 'option.expiry', instrument: 'c40' }, { type: 'option.expiry', instrument: 'p40' }],
        pnl: { account: { commissions: -7.15, unrealized: -55, total: -62.15 }, book: { commissions: -7.15, unrealized: -55, total: -62.15 } },
        nav: { account: 2_340.65, treasury: 997_597.20, book: 999_937.85 }, // 396.30 - 210.65 + 1,025 + 205 + 925
        balance: {
          account: { cash: 396.30, payable: 210.65, positions: 2_155, assets: 2_551.30, liabilities: 210.65, netAssets: 2_340.65 },
          treasury: { cash: 997_597.20, assets: 997_597.20, netAssets: 997_597.20 },
          book: { cash: 997_993.50, payable: 210.65, positions: 2_155, assets: 1_000_148.50, liabilities: 210.65, netAssets: 999_937.85 },
        },
      },
    },
    {
      // 185.65 is free now: funding 396.30 - 185.65 = 210.65.
      ...straddleOne('accept'), id: 'open-accept', covers: ['open', 'financing', 'failed leg'],
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'funding', qty: 210.65 }, { instrument: 'c40', qty: 1, cash: -210 }, { instrument: 'p40', qty: 1, estimate: null, cash: -185 }], cash: { USD: { required: 396.30, available: 185.65, financingIn: 210.65, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ kind: 'funding', status: 'filled' }, { instrument: 'c40', status: 'filled', filledQty: 1 }, { instrument: 'p40', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'transfer.funding', summary: 'Treasury funding: 210.65 USD from Treasury to Alpha' }, { type: 'trade.fill', summary: 'Bought 1 BWB260417C40 @ 2.10 USD' }],
        cash: {
          account: { USD: { settled: 606.95, unsettled: -421.30, availableToTrade: 185.65, availableToWithdraw: 185.65 } },
          treasury: { USD: { settled: 997_386.55, availableToTrade: 997_386.55, availableToWithdraw: 997_386.55 } },
        },
        positions: [
          { instrument: 'c40', lot: 'accept', qty: 1, avgCost: 2.10, cost: 210, value: 205, unrealized: -5 },
          { instrument: 'c40', lot: 'retry', qty: 1, value: 205 },
          { instrument: 'c40', lot: 'straddle', qty: 5, value: 1_025 },
          { instrument: 'p40', lot: 'straddle', qty: 5, value: 925 },
        ],
        holdings: { c40: { long: 7, short: 0, net: 7 } },
        pending: [{ instrument: 'c40', lot: 'accept', dueDate: '2026-03-04', amount: -210.65 }, { instrument: 'c40', lot: 'retry', dueDate: '2026-03-04', amount: -210.65 }],
        openOrders: [{ instrument: 'p40', status: 'working' }, { instrument: 'p40', status: 'working' }],
        lifecycle: [{ instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'p40' }],
        pnl: { account: { commissions: -7.80, unrealized: -60, total: -67.80 }, book: { commissions: -7.80, unrealized: -60, total: -67.80 } },
        nav: { account: 2_545.65, treasury: 997_386.55, book: 999_932.20 },
        balance: {
          account: { cash: 606.95, payable: 421.30, positions: 2_360, assets: 2_966.95, liabilities: 421.30, netAssets: 2_545.65 },
          treasury: { cash: 997_386.55, assets: 997_386.55, netAssets: 997_386.55 },
          book: { cash: 997_993.50, payable: 421.30, positions: 2_360, assets: 1_000_353.50, liabilities: 421.30, netAssets: 999_932.20 },
        },
      },
    },
    {
      ...straddleOne('unwind'), id: 'open-unwind', covers: ['open', 'financing', 'failed leg'],
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'funding', qty: 210.65 }, { instrument: 'c40', qty: 1, cash: -210 }, { instrument: 'p40', qty: 1, estimate: null, cash: -185 }], cash: { USD: { required: 396.30, available: 185.65, financingIn: 210.65, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ kind: 'funding', status: 'filled' }, { instrument: 'c40', status: 'filled', filledQty: 1 }, { instrument: 'p40', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'transfer.funding', summary: 'Treasury funding: 210.65 USD from Treasury to Alpha' }, { type: 'trade.fill', summary: 'Bought 1 BWB260417C40 @ 2.10 USD' }],
        cash: {
          account: { USD: { settled: 817.60, unsettled: -631.95, availableToTrade: 185.65, availableToWithdraw: 185.65 } },
          treasury: { USD: { settled: 997_175.90, availableToTrade: 997_175.90, availableToWithdraw: 997_175.90 } },
        },
        positions: [
          { instrument: 'c40', lot: 'accept', qty: 1, value: 205 },
          { instrument: 'c40', lot: 'retry', qty: 1, value: 205 },
          { instrument: 'c40', lot: 'straddle', qty: 5, value: 1_025 },
          { instrument: 'c40', lot: 'unwind', qty: 1, avgCost: 2.10, cost: 210, value: 205, unrealized: -5 },
          { instrument: 'p40', lot: 'straddle', qty: 5, value: 925 },
        ],
        holdings: { c40: { long: 8, short: 0, net: 8 } },
        pending: [{ lot: 'accept', amount: -210.65 }, { lot: 'retry', amount: -210.65 }, { lot: 'unwind', amount: -210.65 }],
        openOrders: [{ instrument: 'p40', status: 'working' }, { instrument: 'p40', status: 'working' }, { instrument: 'p40', status: 'working' }],
        lifecycle: [{ instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'p40' }],
        pnl: { account: { commissions: -8.45, unrealized: -65, total: -73.45 }, book: { commissions: -8.45, unrealized: -65, total: -73.45 } },
        nav: { account: 2_750.65, treasury: 997_175.90, book: 999_926.55 },
        balance: {
          account: { cash: 817.60, payable: 631.95, positions: 2_565, assets: 3_382.60, liabilities: 631.95, netAssets: 2_750.65 },
          treasury: { cash: 997_175.90, assets: 997_175.90, netAssets: 997_175.90 },
          book: { cash: 997_993.50, payable: 631.95, positions: 2_565, assets: 1_000_558.50, liabilities: 631.95, netAssets: 999_926.55 },
        },
      },
    },
    {
      // End of 3 March: the three put legs expire unfilled; each instance holds a call alone and needs attention.
      id: 'put-legs-expire', covers: ['failed leg', 'settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 210.65 USD from settled cash', date: '2026-03-04' },
          { type: 'settlement.pay', summary: 'paid 210.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 210.65 USD from settled cash' },
          { type: 'order.expired', summary: 'Leg 3 expired: buy 1 BWB260417P40. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 3 expired: buy 1 BWB260417P40. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 3 expired: buy 1 BWB260417P40. Day order did not fill before the end of the business day' },
        ],
        cash: { account: { USD: { settled: 185.65, unsettled: 0, availableToTrade: 185.65, availableToWithdraw: 185.65 } } }, // 817.60 - 3 x 210.65
        pending: [], openOrders: [],
        failed: { orders: 3 },
        alerts: ['strategy.attention', 'strategy.attention', 'strategy.attention'],
        balance: { account: { cash: 185.65, payable: null, assets: 2_750.65, liabilities: 0 }, book: { cash: 997_361.55, payable: null, assets: 999_926.55, liabilities: 0 } }, // 997,993.50 - 631.95
      },
    },
    {
      id: 'p40-quote-day3', action: 'quote', instrument: 'p40', quote: { bid: 1.60, ask: 1.70, last: 1.65, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c40', lot: 'accept', value: 205 }, { instrument: 'c40', lot: 'retry', value: 205 }, { instrument: 'c40', lot: 'straddle', value: 1_025 }, { instrument: 'c40', lot: 'unwind', value: 205 },
          { instrument: 'p40', lot: 'straddle', qty: 5, price: 1.65, value: 825, unrealized: -125 }, // 5 x 1.65 x 100 - 950
        ],
        pnl: { account: { unrealized: -165, total: -173.45 }, book: { unrealized: -165, total: -173.45 } },
        nav: { account: 2_650.65, book: 999_826.55 },
        balance: { account: { positions: 2_465, assets: 2_650.65, netAssets: 2_650.65 }, book: { positions: 2_465, assets: 999_826.55, netAssets: 999_826.55 } },
      },
    },
    {
      // Retry buys the put: 1 x 1.70 x 100 = 170 and 0.65 commission, against 185.65 free.
      id: 'retry', covers: ['retry', 'failed leg'], action: 'recover', how: 'retry', lot: 'retry',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'retry', legs: [{ kind: 'trade', action: 'buy', instrument: 'p40', qty: 1, estimate: 1.70, settleDate: '2026-03-05', cash: -170, fees: 0.65 }], cash: { USD: { purchases: 170, fees: 0.65, reserved: 0, required: 170.65, available: 185.65, shortfall: 0 } } },
        result: { status: 'open', complete: true, orders: [{ kind: 'trade', action: 'buy', instrument: 'p40', status: 'filled', filledQty: 1, avgPrice: 1.70 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 1 BWB260417P40 @ 1.70 USD', date: '2026-03-04' }],
        cash: { account: { USD: { settled: 185.65, unsettled: -170.65, availableToTrade: 15, availableToWithdraw: 15 } } },
        positions: [
          { instrument: 'c40', lot: 'accept', value: 205 }, { instrument: 'c40', lot: 'retry', value: 205 }, { instrument: 'c40', lot: 'straddle', value: 1_025 }, { instrument: 'c40', lot: 'unwind', value: 205 },
          { instrument: 'p40', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 1.70, cost: 170, price: 1.65, value: 165, unrealized: -5 },
          { instrument: 'p40', lot: 'straddle', qty: 5, value: 825, unrealized: -125 },
        ],
        holdings: { p40: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'p40', lot: 'retry', dueDate: '2026-03-05', amount: -170.65, into: 'cash' }],
        lifecycle: [{ instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'p40' }, { instrument: 'p40' }],
        alerts: ['strategy.attention', 'strategy.attention'],
        pnl: { account: { commissions: -9.10, unrealized: -170, total: -179.10 }, book: { commissions: -9.10, unrealized: -170, total: -179.10 } },
        nav: { account: 2_645, book: 999_820.90 },
        balance: {
          account: { cash: 185.65, payable: 170.65, positions: 2_630, assets: 2_815.65, liabilities: 170.65, netAssets: 2_645 },
          book: { cash: 997_361.55, payable: 170.65, positions: 2_630, assets: 999_991.55, liabilities: 170.65, netAssets: 999_820.90 },
        },
      },
    },
    {
      id: 'accept', covers: ['accept', 'failed leg'], action: 'strategy_action', lot: 'accept', how: 'accept',
      expect: {
        events: [{ type: 'strategy.accepted', summary: 'accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }],
        alerts: ['strategy.attention'],
      },
    },
    {
      // Unwind sells the call back at the bid, 2.00: 200 - 0.65. Realized 1 x (2.00 - 2.10) x 100 = -10.
      id: 'unwind', covers: ['unwind', 'close'], action: 'recover', how: 'unwind', lot: 'unwind',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'unwind', legs: [{ kind: 'trade', action: 'sell', instrument: 'c40', qty: 1, estimate: 2.00, settleDate: '2026-03-05', cash: 200, fees: 0.65 }], cash: { USD: { proceeds: 200, fees: 0.65, required: 0.65 } } },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'c40', status: 'filled', filledQty: 1, avgPrice: 2.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 BWB260417C40 @ 2.00 USD (realized -10.00 USD)' }],
        cash: { account: { USD: { settled: 185.65, unsettled: 28.70, availableToTrade: 214.35, availableToWithdraw: 15 } } }, // -170.65 + 199.35
        positions: [
          { instrument: 'c40', lot: 'accept', value: 205 }, { instrument: 'c40', lot: 'retry', value: 205 }, { instrument: 'c40', lot: 'straddle', value: 1_025 },
          { instrument: 'p40', lot: 'retry', value: 165 }, { instrument: 'p40', lot: 'straddle', value: 825 },
        ],
        holdings: { c40: { long: 7, short: 0, net: 7 } },
        pending: [{ instrument: 'c40', lot: 'unwind', dueDate: '2026-03-05', amount: 199.35 }, { instrument: 'p40', lot: 'retry', dueDate: '2026-03-05', amount: -170.65 }],
        lifecycle: [{ instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'p40' }, { instrument: 'p40' }],
        alerts: [],
        pnl: { account: { realized: -10, commissions: -9.75, unrealized: -165, total: -184.75 }, book: { realized: -10, commissions: -9.75, unrealized: -165, total: -184.75 } },
        nav: { account: 2_639.35, book: 999_815.25 }, // 2,645 - 5 (sold 0.05 under the mark) - 0.65
        balance: {
          account: { cash: 185.65, receivable: 199.35, payable: 170.65, positions: 2_425, assets: 2_810, liabilities: 170.65, netAssets: 2_639.35 },
          book: { cash: 997_361.55, receivable: 199.35, payable: 170.65, positions: 2_425, assets: 999_985.90, liabilities: 170.65, netAssets: 999_815.25 }, // 997,361.55 + 199.35 + 2,425
        },
      },
    },
    {
      id: 'settle-recovery', covers: 'settlement', action: 'clock', to: MAR(5),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 199.35 USD into settled cash', date: '2026-03-05' }, { type: 'settlement.pay', summary: 'paid 170.65 USD from settled cash' }],
        cash: { account: { USD: { settled: 214.35, unsettled: 0, availableToTrade: 214.35, availableToWithdraw: 214.35 } } },
        pending: [],
        balance: { account: { cash: 214.35, receivable: null, payable: null, assets: 2_639.35, liabilities: 0 }, book: { cash: 997_390.25, receivable: null, payable: null, assets: 999_815.25, liabilities: 0 } },
      },
    },
    {
      // Close "retry": sell its call at 2.00 and its put at 1.60. Realized -10 on each (2.00 - 2.10; 1.60 - 1.70).
      id: 'close-retry', covers: ['close'], action: 'close', lot: 'retry', instrument: 'c40', scope: 'strategy', percent: 100,
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'close',
          legs: [
            { kind: 'trade', action: 'sell', instrument: 'c40', qty: 1, estimate: 2.00, settleDate: '2026-03-06', cash: 200, fees: 0.65 },
            { kind: 'trade', action: 'sell', instrument: 'p40', qty: 1, estimate: 1.60, settleDate: '2026-03-06', cash: 160, fees: 0.65 },
          ],
          cash: { USD: { proceeds: 360, fees: 1.30, required: 1.30 } },
        },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'c40', status: 'filled', avgPrice: 2.00 }, { action: 'sell', instrument: 'p40', status: 'filled', avgPrice: 1.60 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 1 BWB260417C40 @ 2.00 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 BWB260417P40 @ 1.60 USD (realized -10.00 USD)' },
        ],
        cash: { account: { USD: { settled: 214.35, unsettled: 358.70, availableToTrade: 573.05, availableToWithdraw: 214.35 } } }, // 199.35 + 159.35
        positions: [{ instrument: 'c40', lot: 'accept', value: 205 }, { instrument: 'c40', lot: 'straddle', value: 1_025 }, { instrument: 'p40', lot: 'straddle', value: 825 }],
        holdings: { c40: { long: 6, short: 0, net: 6 }, p40: { long: 5, short: 0, net: 5 } },
        pending: [{ instrument: 'c40', lot: 'retry', dueDate: '2026-03-06', amount: 199.35 }, { instrument: 'p40', lot: 'retry', dueDate: '2026-03-06', amount: 159.35 }],
        lifecycle: [{ instrument: 'c40' }, { instrument: 'c40' }, { instrument: 'p40' }],
        pnl: { account: { realized: -30, commissions: -11.05, unrealized: -155, total: -196.05 }, book: { realized: -30, commissions: -11.05, unrealized: -155, total: -196.05 } },
        nav: { account: 2_628.05, book: 999_803.95 }, // 214.35 + 358.70 + 1,025 + 205 + 825
        balance: {
          account: { cash: 214.35, receivable: 358.70, positions: 2_055, assets: 2_628.05, liabilities: 0, netAssets: 2_628.05 },
          book: { cash: 997_390.25, receivable: 358.70, positions: 2_055, assets: 999_803.95, netAssets: 999_803.95 },
        },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MAR(6),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 199.35 USD into settled cash', date: '2026-03-06' }, { type: 'settlement.receive', summary: 'received 159.35 USD into settled cash' }],
        cash: { account: { USD: { settled: 573.05, unsettled: 0, availableToTrade: 573.05, availableToWithdraw: 573.05 } } },
        pending: [],
        balance: { account: { cash: 573.05, receivable: null }, book: { cash: 997_748.95, receivable: null } },
      },
    },
    {
      // Cash for the shares that exercise will deliver at the strike.
      id: 'fund-for-delivery', covers: 'internal funding', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 30_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 30,000.00 USD from Treasury to Alpha' }],
        cash: { account: { USD: { settled: 30_573.05, availableToTrade: 30_573.05, availableToWithdraw: 30_573.05 } }, treasury: { USD: { settled: 967_175.90, availableToTrade: 967_175.90, availableToWithdraw: 967_175.90 } } },
        nav: { account: 32_628.05, treasury: 967_175.90 },
        balance: { account: { cash: 30_573.05, assets: 32_628.05, netAssets: 32_628.05 }, treasury: { cash: 967_175.90, assets: 967_175.90, netAssets: 967_175.90 } },
      },
    },
    { id: 'stock-quote', action: 'quote', instrument: 'stock', quote: { bid: 45.98, ask: 46.02, last: 46.00, bidSize: 10000, askSize: 10000 }, expect: {} }, // no shares held yet
    { id: 'expiry-close', action: 'close_price', instrument: 'stock', date: '2026-04-17', value: 46.00, expect: {} },
    {
      // Held across Good Friday. 17 April, after the close of 46: the calls are in the money and exercised (closed at zero:
      // premium realized, -1,050 in "straddle" and -210 in "accept"); 500 and 100 shares are delivered at 40 (20,000 and
      // 4,000, due Monday 20 April). The puts lapse (-950). Realized -30 - 1,050 - 210 - 950 = -2,240. The shares are worth
      // 600 x 46 = 27,600 against 24,000.
      id: 'expiry', covers: ['expiry', 'exercise', 'holiday'], action: 'clock', to: APR(17, '17:30'),
      expect: {
        events: [
          // The call and the put of "straddle" settle on the same day, then the call of "accept".
          { type: 'option.exercised', summary: 'Exercised: 5 BWB260417C40 at strike 40', date: '2026-04-17' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 500 BWB at strike 40 on exercise of BWB260417C40/ },
          { type: 'option.expired', summary: 'Expired worthless: 5 BWB260417P40 (fixing 46)', date: '2026-04-17' },
          { type: 'option.exercised', summary: 'Exercised: 1 BWB260417C40 at strike 40', date: '2026-04-17' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 100 BWB at strike 40 on exercise of BWB260417C40/ },
        ],
        cash: { account: { USD: { settled: 30_573.05, unsettled: -24_000, reserved: 0, availableToTrade: 6_573.05, availableToWithdraw: 6_573.05 } } },
        positions: [
          { instrument: 'stock', lot: 'accept', owner: 'account', direction: 'long', qty: 100, avgCost: 40, cost: 4_000, price: 46, value: 4_600, unrealized: 600 },
          { instrument: 'stock', lot: 'straddle', owner: 'account', direction: 'long', qty: 500, avgCost: 40, cost: 20_000, price: 46, value: 23_000, unrealized: 3_000 },
        ],
        holdings: { c40: null, p40: null, stock: { long: 600, short: 0, net: 600 } },
        pending: [{ instrument: 'stock', lot: 'straddle', dueDate: '2026-04-20', amount: -20_000, into: 'cash' }, { instrument: 'stock', lot: 'accept', dueDate: '2026-04-20', amount: -4_000, into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -2_240, commissions: -11.05, unrealized: 3_600, total: 1_348.95 }, book: { realized: -2_240, commissions: -11.05, unrealized: 3_600, total: 1_348.95 } },
        nav: { account: 34_173.05, book: 1_001_348.95 }, // 32,628.05 - 2,055 of options + 3,600 of share gain
        balance: {
          account: { cash: 30_573.05, payable: 24_000, positions: 27_600, assets: 58_173.05, liabilities: 24_000, netAssets: 34_173.05 },
          book: { cash: 997_748.95, payable: 24_000, positions: 27_600, assets: 1_025_348.95, liabilities: 24_000, netAssets: 1_001_348.95 },
        },
      },
    },
    {
      id: 'settle-delivery', covers: 'settlement', action: 'clock', to: APR(20),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 20,000.00 USD from settled cash', date: '2026-04-20' }, { type: 'settlement.pay', summary: 'paid 4,000.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 6_573.05, unsettled: 0, availableToTrade: 6_573.05, availableToWithdraw: 6_573.05 } } },
        pending: [],
        balance: { account: { cash: 6_573.05, payable: null, assets: 34_173.05, liabilities: 0 }, book: { cash: 973_748.95, payable: null, assets: 1_001_348.95, liabilities: 0 } },
      },
    },
    {
      // Close "straddle": its 500 shares at the bid 45.98 = 22,990; commission 500 x 0.005 = 2.50. Realized 500 x 5.98 = 2,990.
      id: 'close-straddle', covers: ['close'], action: 'close', lot: 'straddle', instrument: 'stock', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], intent: 'close', legs: [{ kind: 'trade', action: 'sell', instrument: 'stock', qty: 500, estimate: 45.98, settleDate: '2026-04-21', cash: 22_990, fees: 2.50 }] },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'stock', status: 'filled', filledQty: 500, avgPrice: 45.98 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 500 BWB @ 45.98 USD (realized 2,990.00 USD)', date: '2026-04-20' }],
        cash: { account: { USD: { settled: 6_573.05, unsettled: 22_987.50, availableToTrade: 29_560.55, availableToWithdraw: 6_573.05 } } },
        positions: [{ instrument: 'stock', lot: 'accept', qty: 100, value: 4_600, unrealized: 600 }],
        holdings: { stock: { long: 100, short: 0, net: 100 } },
        pending: [{ instrument: 'stock', lot: 'straddle', dueDate: '2026-04-21', amount: 22_987.50, into: 'cash' }],
        pnl: { account: { realized: 750, commissions: -13.55, unrealized: 600, total: 1_336.45 }, book: { realized: 750, commissions: -13.55, unrealized: 600, total: 1_336.45 } },
        nav: { account: 34_160.55, book: 1_001_336.45 }, // 34,173.05 - 10 (sold 0.02 under the mark) - 2.50
        balance: {
          account: { cash: 6_573.05, receivable: 22_987.50, positions: 4_600, assets: 34_160.55, liabilities: 0, netAssets: 34_160.55 },
          book: { cash: 973_748.95, receivable: 22_987.50, positions: 4_600, assets: 1_001_336.45, netAssets: 1_001_336.45 },
        },
      },
    },
    {
      // Close "accept": 100 shares at 45.98 = 4,598; commission 0.50, raised to the 1.00 minimum. Realized 598.
      id: 'close-accept', covers: ['close'], action: 'close', lot: 'accept', instrument: 'stock', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', instrument: 'stock', qty: 100, estimate: 45.98, settleDate: '2026-04-21', cash: 4_598, fees: 1 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 100, avgPrice: 45.98 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 100 BWB @ 45.98 USD (realized 598.00 USD)' }],
        cash: { account: { USD: { settled: 6_573.05, unsettled: 27_584.50, availableToTrade: 34_157.55, availableToWithdraw: 6_573.05 } } },
        positions: [],
        holdings: { stock: null },
        pending: [{ instrument: 'stock', lot: 'accept', dueDate: '2026-04-21', amount: 4_597 }, { instrument: 'stock', lot: 'straddle', dueDate: '2026-04-21', amount: 22_987.50 }],
        pnl: { account: { realized: 1_348, commissions: -14.55, unrealized: 0, total: 1_333.45 }, book: { realized: 1_348, commissions: -14.55, unrealized: 0, total: 1_333.45 } },
        nav: { account: 34_157.55, book: 1_001_333.45 },
        balance: {
          account: { cash: 6_573.05, receivable: 27_584.50, positions: null, assets: 34_157.55, netAssets: 34_157.55 },
          book: { cash: 973_748.95, receivable: 27_584.50, positions: null, assets: 1_001_333.45, netAssets: 1_001_333.45 },
        },
      },
    },
    {
      // Nothing left: every leg settled. 1,000 + 1,006.50 + 396.30 + 210.65 + 210.65 + 30,000 funded, plus 1,333.45.
      id: 'settle-final', covers: 'settlement', action: 'clock', to: APR(21),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 22,987.50 USD into settled cash', date: '2026-04-21' }, { type: 'settlement.receive', summary: 'received 4,597.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 34_157.55, unsettled: 0, reserved: 0, availableToTrade: 34_157.55, availableToWithdraw: 34_157.55 } } },
        pending: [],
        balance: { account: { cash: 34_157.55, receivable: null, assets: 34_157.55 }, book: { cash: 1_001_333.45, receivable: null, assets: 1_001_333.45 } },
      },
    },
  ],
};

export default [bearCall, longStraddle];
