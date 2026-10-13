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
      // Close 40% of "spread": buy back 2 of its 50 calls (estimated at the last 2.25: 450; no fresh quote, so it waits)
      // and sell 2 of its 55 calls (2 x 0.50 x 100 = 100). The sale of the 55 calls waits on the buy-back: the
      // protection is not sold while the written calls it covers are still open. Nothing fills.
      id: 'close-part-buyback-fails', covers: ['reduce', 'failed leg', 'dependency'], action: 'close', lot: 'spread', instrument: 'c55', scope: 'strategy', percent: 40,
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'], intent: 'close',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'c50', qty: 2, estimate: null, reference: 2.25, executable: false, settleDate: '2026-03-06', cash: -450, fees: 1.30, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'c55', qty: 2, estimate: 0.50, settleDate: '2026-03-06', cash: 100, fees: 1.30, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 450, proceeds: 100, fees: 2.60, reserved: 0, required: 452.60, available: 4_875, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ action: 'buy', instrument: 'c50', status: 'working', filledQty: 0 }, { action: 'sell', instrument: 'c55', status: 'pending', filledQty: 0, reason: 'Waiting on leg 4' }] },
        events: [{ type: 'strategy.legs_added' }],
        openOrders: [{ instrument: 'c50', kind: 'trade', action: 'buy', status: 'working', qty: 2, filledQty: 0 }, { instrument: 'c55', kind: 'trade', action: 'sell', status: 'pending', qty: 2, filledQty: 0 }],
      },
    },
    {
      // End of 5 March: both legs of the close expire unfilled. "spread" still holds its 5 + 5 and needs attention.
      id: 'close-legs-expire', covers: 'failed leg', action: 'clock', to: MAR(6),
      expect: {
        events: [
          { type: 'order.expired', summary: 'Leg 5 expired: sell 2 CFL260320C55. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 4 expired: buy 2 CFL260320C50. Day order did not fill before the end of the business day' },
        ],
        openOrders: [],
        failed: { orders: 4 },
        alerts: ['strategy.attention'],
      },
    },
    {
      id: 'c50-quote-day5', action: 'quote', instrument: 'c50', quote: { bid: 2.00, ask: 2.10, last: 2.05, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c50', lot: 'second', price: 2.05, value: -1_025, unrealized: 75 }, // -5 x 2.05 x 100 + 1,100
          { instrument: 'c50', lot: 'spread', price: 2.05, value: -1_025, unrealized: 175 },
          { instrument: 'c55', lot: 'second', value: 275, unrealized: -75 },
          { instrument: 'c55', lot: 'spread', value: 275, unrealized: -125 },
          { instrument: 'c55', lot: 'third', value: 275, unrealized: -75 },
        ],
        pnl: { account: { unrealized: -25, total: -41.25 }, book: { unrealized: -25, total: -41.25 } },
        nav: { account: 8_650, book: 999_958.75 }, // 9,875 - 2,050 + 825
        balance: { account: { positions: -1_225, assets: 8_650, netAssets: 8_650 }, book: { positions: -1_225, assets: 999_958.75, netAssets: 999_958.75 } },
      },
    },
    {
      id: 'c55-quote-day5', action: 'quote', instrument: 'c55', quote: { bid: 0.40, ask: 0.50, last: 0.45, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c50', lot: 'second', value: -1_025, unrealized: 75 },
          { instrument: 'c50', lot: 'spread', value: -1_025, unrealized: 175 },
          { instrument: 'c55', lot: 'second', price: 0.45, value: 225, unrealized: -125 },
          { instrument: 'c55', lot: 'spread', price: 0.45, value: 225, unrealized: -175 },
          { instrument: 'c55', lot: 'third', price: 0.45, value: 225, unrealized: -125 },
        ],
        pnl: { account: { unrealized: -175, total: -191.25 }, book: { unrealized: -175, total: -191.25 } },
        nav: { account: 8_500, book: 999_808.75 }, // 9,875 - 2,050 + 675
        balance: { account: { positions: -1_375, assets: 8_500, netAssets: 8_500 }, book: { positions: -1_375, assets: 999_808.75, netAssets: 999_808.75 } },
      },
    },
    {
      // Unwind "spread": buy back its 5 50 calls at 2.10 (1,050), then sell its 5 55 calls at 0.40 (200), which wait on
      // the buy-back. Realized: 5 x (2.40 - 2.10) x 100 = +150 and 5 x (0.40 - 0.80) x 100 = -200. Nothing is left in it.
      id: 'unwind-spread', covers: ['unwind', 'close', 'dependency'], action: 'recover', how: 'unwind', lot: 'spread',
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'unwind',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'c50', qty: 5, estimate: 2.10, settleDate: '2026-03-09', cash: -1_050, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'c55', qty: 5, estimate: 0.40, settleDate: '2026-03-09', cash: 200, fees: 3.25, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 1_050, proceeds: 200, fees: 6.50, reserved: 0, required: 1_056.50, available: 4_875, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ action: 'buy', instrument: 'c50', status: 'filled', filledQty: 5, avgPrice: 2.10 }, { action: 'sell', instrument: 'c55', status: 'filled', filledQty: 5, avgPrice: 0.40 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 5 CFL260320C50 @ 2.10 USD (realized 150.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 5 CFL260320C55 @ 0.40 USD (realized -200.00 USD)' },
        ],
        // owed: -1,053.25 (1,050 + 3.25); owed to it: 196.75 (200 - 3.25). "spread" reserves nothing now; "second" 2,500.
        cash: { account: { USD: { settled: 9_875, unsettled: -856.50, reserved: 2_500, availableToTrade: 6_518.50, availableToWithdraw: 6_321.75 } } },
        positions: [
          { instrument: 'c50', lot: 'second', qty: -5, value: -1_025, unrealized: 75 },
          { instrument: 'c55', lot: 'second', qty: 5, value: 225, unrealized: -125 },
          { instrument: 'c55', lot: 'third', qty: 5, value: 225, unrealized: -125 },
        ],
        holdings: { c50: { long: 0, short: 5, net: -5 }, c55: { long: 10, short: 0, net: 10 } },
        pending: [
          { instrument: 'c50', lot: 'spread', dueDate: '2026-03-09', amount: -1_053.25, into: 'cash' },
          { instrument: 'c55', lot: 'spread', dueDate: '2026-03-09', amount: 196.75, into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'c50' }, { type: 'option.expiry', instrument: 'c55' }, { type: 'option.expiry', instrument: 'c55' }],
        alerts: [],
        pnl: { account: { realized: -50, commissions: -22.75, unrealized: -175, total: -247.75 }, book: { realized: -50, commissions: -22.75, unrealized: -175, total: -247.75 } },
        nav: { account: 8_443.50, book: 999_752.25 }, // 8,500 - 25 - 25 (0.05 from the marks on 500 units each way) - 6.50
        balance: {
          account: { cash: 9_875, receivable: 196.75, payable: 1_053.25, positions: -575, assets: 9_496.75, liabilities: 1_053.25, netAssets: 8_443.50 },
          book: { cash: 1_001_183.75, receivable: 196.75, payable: 1_053.25, positions: -575, assets: 1_000_805.50, liabilities: 1_053.25, netAssets: 999_752.25 },
        },
      },
    },
    {
      id: 'settle-unwind', covers: 'settlement', action: 'clock', to: MAR(9),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 196.75 USD into settled cash', date: '2026-03-09' },
          { type: 'settlement.pay', summary: 'paid 1,053.25 USD from settled cash', date: '2026-03-09' },
        ],
        cash: { account: { USD: { settled: 9_018.50, unsettled: 0, availableToTrade: 6_518.50, availableToWithdraw: 6_518.50 } } }, // 9,875 + 196.75 - 1,053.25
        pending: [],
        balance: {
          account: { cash: 9_018.50, receivable: null, payable: null, assets: 8_443.50, liabilities: 0 },
          book: { cash: 1_000_327.25, receivable: null, payable: null, assets: 999_752.25, liabilities: 0 },
        },
      },
    },
    { id: 'expiry-close', action: 'close_price', instrument: 'stock', date: '2026-03-20', value: 48.00, expect: {} },
    {
      // The stock closes at 48, below both strikes: every remaining call expires worthless. Realized: the written 50s of
      // "second" keep their 1,100 premium; the 55s of "second" and "third" lose 350 each. 350 = -50 + 1,100 - 350 - 350.
      id: 'expiry', covers: ['expiry', 'close'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [
          { type: 'option.expired', summary: 'Expired worthless: 5 CFL260320C55 (fixing 48)', date: '2026-03-20' },
          { type: 'option.expired', summary: 'Expired worthless: 5 CFL260320C55 (fixing 48)', date: '2026-03-20' },
          { type: 'option.expired', summary: 'Expired worthless: 5 CFL260320C50 (fixing 48)', date: '2026-03-20' },
        ],
        cash: { account: { USD: { settled: 9_018.50, unsettled: 0, reserved: 0, availableToTrade: 9_018.50, availableToWithdraw: 9_018.50 } } },
        positions: [],
        holdings: { c50: null, c55: null },
        lifecycle: [],
        pnl: { account: { realized: 350, commissions: -22.75, unrealized: 0, total: 327.25 }, book: { realized: 350, commissions: -22.75, unrealized: 0, total: 327.25 } },
        nav: { account: 9_018.50, treasury: 991_308.75, book: 1_000_327.25 }, // 1,000,000 + 327.25
        balance: {
          account: { cash: 9_018.50, positions: null, assets: 9_018.50, liabilities: 0, netAssets: 9_018.50 },
          book: { cash: 1_000_327.25, positions: null, assets: 1_000_327.25, liabilities: 0, netAssets: 1_000_327.25 },
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

// =====================================================================================================================
// long_strangle
// =====================================================================================================================
// Northfield 100 Index options (Cboe, European, cash-settled at 100 x the index), 20 March 2026: buy the 95 put and
// the 105 call. The index level is carried by a reference instrument registered as an ETF and named as a reference
// level (the catalog has no index product). Financing choice: a simulated margin loan (5% fixed, ACT/360) sized to the
// shortfall, drawn before the legs that wait on it, accruing daily and repaid with its interest at the end.
//   strangle  5 + 5, with the margin loan; the call fills 3 of 5 on its first cycle. The index fixes at 90 on 20 March:
//             the put is settled in cash (5 x 5 x 100 = 2,500, paid T+1) and the call lapses, on the same day.
//   retry / accept / unwind  1 + 1 each when the call has no fresh quote: the call legs expire unfilled; Retry buys
//             one, Accept keeps a put alone (settled in cash at expiry), Unwind sells the put back.
const STRANGLE_PAGE = (contracts, financing) => ({ template: 'Long Strangle', underlying: 'index', expiration: '2026-03-20', strikes: { 'Put strike': 95, 'Call strike': 105 }, contracts, ...(financing ? { financing } : {}) });
const strangleInput = (contracts, financing) => templateInput('long_strangle', { underlyingId: '$inst:index', options: { expiration: '2026-03-20', strikes: { put: 95, call: 105 }, contracts }, financing });
const indexOption = (symbol, right, strike) => ({
  productId: 'index_option', name: `NFX 20 March 2026 ${strike} ${right === 'C' ? 'call' : 'put'}`, symbol, marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlying: 'index', multiplier: 100,
  terms: { right, strike, expiration: '2026-03-20', exercise: 'european', settlement: 'cash', deliverable: { units: 100 } },
});
const strangleOne = (as) => ({ action: 'package', as, instrument: 'index', input: strangleInput(1, null), strategyPage: STRANGLE_PAGE(1, null) });
const LOAN = 'Margin loan USD (Long Strangle NFX)';
// Positions that do not change after the recovery steps, as the later steps restate them.
const longStrangle = {
  template: 'long_strangle',
  title: 'Long strangle on the Northfield 100 Index (Cboe, cash-settled): buy the 20 March 2026 95 put and 105 call, financed by a margin loan',
  matrix: {
    ...OPTION_TEMPLATE_MATRIX,
    automaticInputs: [...OPTION_TEMPLATE_MATRIX.automaticInputs.filter((x) => !x.startsWith('Treasury funding')), 'margin loan sized to the cash shortfall (Financing: borrow), its daily interest ACT/360 at the end-of-day run, and the interest settled with the repayment', 'index fixing for the expiration date (close fixture on the reference instrument)'],
    manualInputs: [...OPTION_TEMPLATE_MATRIX.manualInputs, 'the loan rate, typed on the Strategies page', 'repayment of the margin loan from the Account'],
    settlement: 'Premium T+1 on the US calendar; the loan is drawn in settled cash at once, ahead of the legs it funds; cash settlement of the put T+1 after expiry; the repayment pays principal and interest from settled cash',
    lifecycle: 'Expiry items for the put and the call on the same day from the index fixing for 20 March 2026 (90: the put is settled in cash, the call lapses); a failed leg leaves the instance needing attention: Retry, Unwind or Accept; the loan accrues daily and is repaid in full',
    accounting: 'Net debit paid; commission expensed; premium realized on sale, cash settlement and lapse; the loan is a liability with its accrued interest as an expense (borrow funding), repaid at the end',
    collateral: 'None reserved: both legs are bought. The margin loan is secured on the Account as a whole (no specific pledge)',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: [] },
  book: book('Templates long strangle', { funding: [{ ccy: 'USD', amount: 1_006.50 }] }),
  instruments: {
    index: { productId: 'etf', name: 'Northfield 100 Index (reference level)', symbol: 'NFX', marketView: 'US_CASH', venue: 'Northfield Indices', venueType: 'exchange', venueCountry: 'US', issuer: 'Northfield Indices LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    p95: indexOption('NFX260320P95', 'P', 95),
    c105: indexOption('NFX260320C105', 'C', 105),
  },
  quotes: {
    index: { bid: 99.99, ask: 100.01, last: 100, bidSize: 1000, askSize: 1000 },
    p95: { bid: 2.40, ask: 2.50, last: 2.45, bidSize: 20, askSize: 20 },
    c105: { bid: 2.28, ask: 2.38, last: 2.33, bidSize: 20, askSize: 3 }, // only 3 calls displayed at the ask
  },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 1_006.50, unsettled: 0, reserved: 0, availableToTrade: 1_006.50, availableToWithdraw: 1_006.50 } },
      treasury: { USD: { settled: 998_993.50, unsettled: 0, reserved: 0, availableToTrade: 998_993.50, availableToWithdraw: 998_993.50 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 1_006.50, treasury: 998_993.50, book: 1_000_000 },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
  },
  steps: [
    {
      // 5 puts at 2.50 (1,250) and 5 calls at 2.38 (1,190), 6.50 commission: 2,446.50 against 1,006.50.
      id: 'open-short-of-cash', covers: 'financing', action: 'package', as: 'refused', instrument: 'index',
      input: strangleInput(5, null), strategyPage: STRANGLE_PAGE(5, null),
      status: 'blocked', reason: 'The Account cannot pay for the package: the preview is blocked until financing is chosen.',
      expect: {
        refused: 'Alpha is short 1,440.00 USD',
        preview: {
          blocking: 1, errors: ['cash'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p95', qty: 5, estimate: 2.50, settleDate: '2026-03-03', cash: -1_250, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c105', qty: 5, estimate: 2.38, settleDate: '2026-03-03', cash: -1_190, fees: 3.25, dependsOn: [] },
          ],
          cash: { USD: { purchases: 2_440, fees: 6.50, reserved: 0, required: 2_446.50, available: 1_006.50, shortfall: 1_440 } },
        },
      },
    },
    {
      // Financing: borrow. A margin loan of 1,440 at 5% (1,440 x 0.05 / 360 = 0.20 a day) is drawn first. The puts fill
      // 5 at 2.50; the calls 3 at 2.38 (the displayed size) and 2 on the next cycle (commission 1.95, then 1.30).
      id: 'open', covers: ['open', 'financing', 'borrow', 'partial fill', 'dependency'], action: 'package', as: 'strangle', instrument: 'index', contractAs: 'mloan',
      input: strangleInput(5, { mode: 'loan', rateType: 'fixed', rate: 0.05 }), strategyPage: STRANGLE_PAGE(5, { mode: 'loan', rate: 0.05 }),
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'loan', action: 'borrow_cash', purpose: 'financing', qty: 1_440, cash: 1_440, ccy: 'USD', dailyCost: 0.20, financing: { amount: 1_440, rateType: 'fixed', rate: 0.05, maturity: null, interestFrom: '2026-03-02' }, dependsOn: [] },
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'p95', qty: 5, estimate: 2.50, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US', cash: -1_250, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'c105', qty: 5, estimate: 2.38, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US', cash: -1_190, fees: 3.25, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 2_440, fees: 6.50, reserved: 0, financingIn: 1_440, required: 2_446.50, available: 1_006.50, shortfall: 0, netCash: -1_006.50 } },
          netPremium: { amount: 2_440, ccy: 'USD', type: 'debit', complete: true },
          optionRequirement: [],
        },
        result: {
          status: 'partial',
          orders: [
            { kind: 'loan', action: 'borrow_cash', instrument: 'mloan', status: 'filled', qty: 1_440, filledQty: 1_440 },
            { kind: 'trade', action: 'buy', instrument: 'p95', status: 'filled', filledQty: 5, avgPrice: 2.50 },
            { kind: 'trade', action: 'buy', instrument: 'c105', status: 'partial', qty: 5, filledQty: 3, avgPrice: 2.38 },
          ],
        },
        events: [
          { type: 'strategy.submitted' },
          { type: 'loan.drawdown', summary: 'Borrowed 1,440.00 USD (margin, 5.000% fixed, open-ended)', cash: { USD: 1_440 }, owner: 'account', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Bought 5 NFX260320P95 @ 2.50 USD', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Bought 3 NFX260320C105 @ 2.38 USD', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Bought 2 NFX260320C105 @ 2.38 USD', date: '2026-03-02' },
        ],
        cash: {
          // 1,006.50 + 1,440 borrowed; owed 1,253.25 + 715.95 + 477.30 = 2,446.50
          account: { USD: { settled: 2_446.50, unsettled: -2_446.50, reserved: 0, availableToTrade: 0, availableToWithdraw: 0, borrowed: 1_440 } },
          treasury: { USD: { settled: 998_993.50, unsettled: 0, availableToTrade: 998_993.50 } },
        },
        positions: [
          { instrument: 'c105', lot: 'strangle', owner: 'account', direction: 'long', qty: 5, avgCost: 2.38, cost: 1_190, price: 2.33, value: 1_165, unrealized: -25 },
          { instrument: 'mloan', lot: 'strangle', owner: 'account', direction: 'borrowed', qty: -1_440, value: 1_440, carrying: -1_440, accrued: 0, provisional: false },
          { instrument: 'p95', lot: 'strangle', owner: 'account', direction: 'long', qty: 5, avgCost: 2.50, cost: 1_250, price: 2.45, value: 1_225, unrealized: -25 },
        ],
        holdings: { c105: { long: 5, short: 0, net: 5 }, p95: { long: 5, short: 0, net: 5 } },
        pending: [
          { instrument: 'c105', lot: 'strangle', dueDate: '2026-03-03', amount: -715.95, into: 'cash' },
          { instrument: 'c105', lot: 'strangle', dueDate: '2026-03-03', amount: -477.30, into: 'cash' },
          { instrument: 'p95', lot: 'strangle', dueDate: '2026-03-03', amount: -1_253.25, into: 'cash' },
        ],
        lifecycle: [
          { type: 'option.expiry', instrument: 'c105', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'p95', dueDate: '2026-03-20', status: 'pending' },
          { type: 'loan.interest', instrument: 'mloan', dueDate: '2026-04-01', status: 'pending' },
        ],
        borrowings: [{ owner: 'account', origin: 'account', family: 'loan', type: 'Margin loan', lot: 'strangle', principal: 1_440, ccy: 'USD', rate: 0.05, rateType: 'fixed', dayCount: 'ACT/360', accrued: 0, costToDate: 0, startDate: '2026-03-02', maturity: null, lender: 'Simulated lender', nextPayment: '2026-04-01' }],
        pnl: {
          account: { realized: 0, commissions: -6.50, borrowFunding: 0, unrealized: -50, total: -56.50 },
          book: { realized: 0, commissions: -6.50, borrowFunding: 0, unrealized: -50, total: -56.50 },
          treasury: { total: 0 },
        },
        nav: { account: 950, treasury: 998_993.50, book: 999_943.50 }, // 1,006.50 - 56.50
        balance: {
          account: { cash: 2_446.50, payable: 2_446.50, positions: 2_390, borrowed: 1_440, assets: 4_836.50, liabilities: 3_886.50, netAssets: 950 },
          treasury: { cash: 998_993.50, assets: 998_993.50, liabilities: 0, netAssets: 998_993.50 },
          book: { cash: 1_001_440, payable: 2_446.50, positions: 2_390, borrowed: 1_440, assets: 1_003_830, liabilities: 3_886.50, netAssets: 999_943.50 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'strangle', principal: 1_440, ccy: 'USD', accrued: 0 }], treasuryOwn: [] },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR(3),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 1,253.25 USD from settled cash', date: '2026-03-03' },
          { type: 'settlement.pay', summary: 'paid 715.95 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 477.30 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 0, unsettled: 0, availableToTrade: 0, availableToWithdraw: 0, borrowed: 1_440 } } },
        pending: [],
        balance: {
          account: { cash: null, payable: null, assets: 2_390, liabilities: 1_440, netAssets: 950 },
          book: { cash: 998_993.50, payable: null, assets: 1_001_383.50, liabilities: 1_440, netAssets: 999_943.50 },
        },
      },
    },
    {
      id: 'fund-account', covers: 'internal funding', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 2_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 2,000.00 USD from Treasury to Alpha' }],
        cash: { account: { USD: { settled: 2_000, availableToTrade: 2_000, availableToWithdraw: 2_000 } }, treasury: { USD: { settled: 996_993.50, availableToTrade: 996_993.50, availableToWithdraw: 996_993.50 } } },
        nav: { account: 2_950, treasury: 996_993.50 },
        balance: { account: { cash: 2_000, assets: 4_390, netAssets: 2_950 }, treasury: { cash: 996_993.50, assets: 996_993.50, netAssets: 996_993.50 } },
      },
    },
    // The call's quote stops updating at 09:50.
    { id: 'c105-quote-stops', action: 'quote', instrument: 'c105', quote: { bid: 2.28, ask: 2.38, last: 2.33, bidSize: 20, askSize: 20, asOf: MAR(3, '09:50') }, expect: {} },
    {
      // 1 put at 2.50 (250) and 1 call estimated at its last 2.33 (233), 1.30 commission: 484.30 of 2,000.
      ...strangleOne('retry'), id: 'open-retry', covers: ['open', 'failed leg'],
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p95', qty: 1, estimate: 2.50, settleDate: '2026-03-04', cash: -250, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c105', qty: 1, estimate: null, reference: 2.33, executable: false, settleDate: '2026-03-04', cash: -233, fees: 0.65, dependsOn: [] },
          ],
          cash: { USD: { purchases: 483, fees: 1.30, required: 484.30, available: 2_000, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ instrument: 'p95', status: 'filled', filledQty: 1, avgPrice: 2.50 }, { instrument: 'c105', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 NFX260320P95 @ 2.50 USD', date: '2026-03-03' }],
        cash: { account: { USD: { settled: 2_000, unsettled: -250.65, availableToTrade: 1_749.35, availableToWithdraw: 1_749.35 } } },
        positions: [
          { instrument: 'c105', lot: 'strangle', value: 1_165 },
          { instrument: 'mloan', lot: 'strangle', qty: -1_440 },
          { instrument: 'p95', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 2.50, cost: 250, price: 2.45, value: 245, unrealized: -5 },
          { instrument: 'p95', lot: 'strangle', value: 1_225 },
        ],
        holdings: { p95: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'p95', lot: 'retry', dueDate: '2026-03-04', amount: -250.65, into: 'cash' }],
        openOrders: [{ instrument: 'c105', kind: 'trade', action: 'buy', status: 'working', qty: 1, filledQty: 0 }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'p95' }, { instrument: 'p95' }, { type: 'loan.interest' }],
        pnl: { account: { commissions: -7.15, unrealized: -55, total: -62.15 }, book: { commissions: -7.15, unrealized: -55, total: -62.15 } },
        nav: { account: 2_944.35, book: 999_937.85 },
        balance: {
          account: { cash: 2_000, payable: 250.65, positions: 2_635, assets: 4_635, liabilities: 1_690.65, netAssets: 2_944.35 },
          book: { cash: 998_993.50, payable: 250.65, positions: 2_635, assets: 1_001_628.50, liabilities: 1_690.65, netAssets: 999_937.85 },
        },
      },
    },
    {
      ...strangleOne('accept'), id: 'open-accept', covers: ['open', 'failed leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'p95', qty: 1, cash: -250 }, { instrument: 'c105', qty: 1, estimate: null, cash: -233 }], cash: { USD: { required: 484.30, available: 1_749.35, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ instrument: 'p95', status: 'filled', filledQty: 1 }, { instrument: 'c105', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 NFX260320P95 @ 2.50 USD' }],
        cash: { account: { USD: { settled: 2_000, unsettled: -501.30, availableToTrade: 1_498.70, availableToWithdraw: 1_498.70 } } },
        positions: [
          { instrument: 'c105', lot: 'strangle', value: 1_165 }, { instrument: 'mloan', lot: 'strangle', qty: -1_440 },
          { instrument: 'p95', lot: 'accept', qty: 1, cost: 250, value: 245, unrealized: -5 }, { instrument: 'p95', lot: 'retry', value: 245 }, { instrument: 'p95', lot: 'strangle', value: 1_225 },
        ],
        holdings: { p95: { long: 7, short: 0, net: 7 } },
        pending: [{ lot: 'accept', amount: -250.65 }, { lot: 'retry', amount: -250.65 }],
        openOrders: [{ instrument: 'c105', status: 'working' }, { instrument: 'c105', status: 'working' }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }, { type: 'loan.interest' }],
        pnl: { account: { commissions: -7.80, unrealized: -60, total: -67.80 }, book: { commissions: -7.80, unrealized: -60, total: -67.80 } },
        nav: { account: 2_938.70, book: 999_932.20 },
        balance: {
          account: { cash: 2_000, payable: 501.30, positions: 2_880, assets: 4_880, liabilities: 1_941.30, netAssets: 2_938.70 },
          book: { cash: 998_993.50, payable: 501.30, positions: 2_880, assets: 1_001_873.50, liabilities: 1_941.30, netAssets: 999_932.20 },
        },
      },
    },
    {
      ...strangleOne('unwind'), id: 'open-unwind', covers: ['open', 'failed leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'p95', qty: 1, cash: -250 }, { instrument: 'c105', qty: 1, estimate: null, cash: -233 }], cash: { USD: { required: 484.30, available: 1_498.70, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ instrument: 'p95', status: 'filled', filledQty: 1 }, { instrument: 'c105', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 NFX260320P95 @ 2.50 USD' }],
        cash: { account: { USD: { settled: 2_000, unsettled: -751.95, availableToTrade: 1_248.05, availableToWithdraw: 1_248.05 } } },
        positions: [
          { instrument: 'c105', lot: 'strangle', value: 1_165 }, { instrument: 'mloan', lot: 'strangle', qty: -1_440 },
          { instrument: 'p95', lot: 'accept', value: 245 }, { instrument: 'p95', lot: 'retry', value: 245 }, { instrument: 'p95', lot: 'strangle', value: 1_225 }, { instrument: 'p95', lot: 'unwind', qty: 1, cost: 250, value: 245, unrealized: -5 },
        ],
        holdings: { p95: { long: 8, short: 0, net: 8 } },
        pending: [{ lot: 'accept', amount: -250.65 }, { lot: 'retry', amount: -250.65 }, { lot: 'unwind', amount: -250.65 }],
        openOrders: [{ instrument: 'c105', status: 'working' }, { instrument: 'c105', status: 'working' }, { instrument: 'c105', status: 'working' }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }, { type: 'loan.interest' }],
        pnl: { account: { commissions: -8.45, unrealized: -65, total: -73.45 }, book: { commissions: -8.45, unrealized: -65, total: -73.45 } },
        nav: { account: 2_933.05, book: 999_926.55 },
        balance: {
          account: { cash: 2_000, payable: 751.95, positions: 3_125, assets: 5_125, liabilities: 2_191.95, netAssets: 2_933.05 },
          book: { cash: 998_993.50, payable: 751.95, positions: 3_125, assets: 1_002_118.50, liabilities: 2_191.95, netAssets: 999_926.55 },
        },
      },
    },
    {
      // End of 3 March: the call legs expire unfilled; the puts settle; the loan's first day of interest (0.20) accrues.
      id: 'call-legs-expire', covers: ['failed leg', 'settlement', 'interest accrual'], action: 'clock', to: MAR(4),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 250.65 USD from settled cash', date: '2026-03-04' },
          { type: 'settlement.pay', summary: 'paid 250.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 250.65 USD from settled cash' },
          { type: 'accrual.interest', summary: `Interest accrued on ${LOAN}: 0.20 USD`, owner: 'account' },
          { type: 'order.expired', summary: 'Leg 2 expired: buy 1 NFX260320C105. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 2 expired: buy 1 NFX260320C105. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 2 expired: buy 1 NFX260320C105. Day order did not fill before the end of the business day' },
        ],
        cash: { account: { USD: { settled: 1_248.05, unsettled: 0, availableToTrade: 1_248.05, availableToWithdraw: 1_248.05 } } },
        positions: [
          { instrument: 'c105', lot: 'strangle', value: 1_165 }, { instrument: 'mloan', lot: 'strangle', qty: -1_440, accrued: -0.20 },
          { instrument: 'p95', lot: 'accept', value: 245 }, { instrument: 'p95', lot: 'retry', value: 245 }, { instrument: 'p95', lot: 'strangle', value: 1_225 }, { instrument: 'p95', lot: 'unwind', value: 245 },
        ],
        pending: [], openOrders: [],
        borrowings: [{ lot: 'strangle', principal: 1_440, accrued: 0.20, costToDate: 0.20 }],
        failed: { orders: 3 },
        alerts: ['strategy.attention', 'strategy.attention', 'strategy.attention'],
        pnl: { account: { borrowFunding: -0.20, total: -73.65 }, book: { borrowFunding: -0.20, total: -73.65 } },
        nav: { account: 2_932.85, book: 999_926.35 },
        balance: {
          account: { cash: 1_248.05, payable: null, accruedExpense: 0.20, assets: 4_373.05, liabilities: 1_440.20, netAssets: 2_932.85 },
          book: { cash: 998_241.55, payable: null, accruedExpense: 0.20, assets: 1_001_366.55, liabilities: 1_440.20, netAssets: 999_926.35 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'strangle', principal: 1_440, ccy: 'USD', accrued: 0.20 }] },
      },
    },
    {
      id: 'c105-quote-day3', action: 'quote', instrument: 'c105', quote: { bid: 2.08, ask: 2.18, last: 2.13, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c105', lot: 'strangle', price: 2.13, value: 1_065, unrealized: -125 }, { instrument: 'mloan', lot: 'strangle', qty: -1_440 },
          { instrument: 'p95', lot: 'accept', value: 245 }, { instrument: 'p95', lot: 'retry', value: 245 }, { instrument: 'p95', lot: 'strangle', value: 1_225 }, { instrument: 'p95', lot: 'unwind', value: 245 },
        ],
        pnl: { account: { unrealized: -165, total: -173.65 }, book: { unrealized: -165, total: -173.65 } },
        nav: { account: 2_832.85, book: 999_826.35 },
        balance: { account: { positions: 3_025, assets: 4_273.05, netAssets: 2_832.85 }, book: { positions: 3_025, assets: 1_001_266.55, netAssets: 999_826.35 } },
      },
    },
    {
      id: 'retry', covers: ['retry', 'failed leg'], action: 'recover', how: 'retry', lot: 'retry',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'retry', legs: [{ kind: 'trade', action: 'buy', instrument: 'c105', qty: 1, estimate: 2.18, settleDate: '2026-03-05', cash: -218, fees: 0.65 }], cash: { USD: { purchases: 218, fees: 0.65, required: 218.65, available: 1_248.05, shortfall: 0 } } },
        result: { status: 'open', complete: true, orders: [{ kind: 'trade', action: 'buy', instrument: 'c105', status: 'filled', filledQty: 1, avgPrice: 2.18 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought 1 NFX260320C105 @ 2.18 USD', date: '2026-03-04' }],
        cash: { account: { USD: { settled: 1_248.05, unsettled: -218.65, availableToTrade: 1_029.40, availableToWithdraw: 1_029.40 } } },
        positions: [
          { instrument: 'c105', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 2.18, cost: 218, price: 2.13, value: 213, unrealized: -5 },
          { instrument: 'c105', lot: 'strangle', value: 1_065 }, { instrument: 'mloan', lot: 'strangle', qty: -1_440 },
          { instrument: 'p95', lot: 'accept', value: 245 }, { instrument: 'p95', lot: 'retry', value: 245 }, { instrument: 'p95', lot: 'strangle', value: 1_225 }, { instrument: 'p95', lot: 'unwind', value: 245 },
        ],
        holdings: { c105: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'c105', lot: 'retry', dueDate: '2026-03-05', amount: -218.65 }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'c105' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }, { type: 'loan.interest' }],
        alerts: ['strategy.attention', 'strategy.attention'],
        pnl: { account: { commissions: -9.10, unrealized: -170, total: -179.30 }, book: { commissions: -9.10, unrealized: -170, total: -179.30 } },
        nav: { account: 2_827.20, book: 999_820.70 },
        balance: {
          account: { cash: 1_248.05, payable: 218.65, positions: 3_238, assets: 4_486.05, liabilities: 1_658.85, netAssets: 2_827.20 },
          book: { cash: 998_241.55, payable: 218.65, positions: 3_238, assets: 1_001_479.55, liabilities: 1_658.85, netAssets: 999_820.70 },
        },
      },
    },
    {
      id: 'accept', covers: ['accept', 'failed leg'], action: 'strategy_action', lot: 'accept', how: 'accept',
      expect: { events: [{ type: 'strategy.accepted', summary: 'accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: ['strategy.attention'] },
    },
    {
      // Unwind sells the put back at 2.40: 240 - 0.65 = 239.35. Realized 1 x (2.40 - 2.50) x 100 = -10.
      id: 'unwind', covers: ['unwind', 'close'], action: 'recover', how: 'unwind', lot: 'unwind',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'unwind', legs: [{ kind: 'trade', action: 'sell', instrument: 'p95', qty: 1, estimate: 2.40, settleDate: '2026-03-05', cash: 240, fees: 0.65 }] },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'p95', status: 'filled', filledQty: 1, avgPrice: 2.40 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 NFX260320P95 @ 2.40 USD (realized -10.00 USD)' }],
        cash: { account: { USD: { settled: 1_248.05, unsettled: 20.70, availableToTrade: 1_268.75, availableToWithdraw: 1_029.40 } } }, // -218.65 + 239.35
        positions: [
          { instrument: 'c105', lot: 'retry', value: 213 }, { instrument: 'c105', lot: 'strangle', value: 1_065 }, { instrument: 'mloan', lot: 'strangle', qty: -1_440 },
          { instrument: 'p95', lot: 'accept', value: 245 }, { instrument: 'p95', lot: 'retry', value: 245 }, { instrument: 'p95', lot: 'strangle', value: 1_225 },
        ],
        holdings: { p95: { long: 7, short: 0, net: 7 } },
        pending: [{ instrument: 'c105', lot: 'retry', amount: -218.65 }, { instrument: 'p95', lot: 'unwind', dueDate: '2026-03-05', amount: 239.35 }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'c105' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }, { type: 'loan.interest' }],
        alerts: [],
        pnl: { account: { realized: -10, commissions: -9.75, unrealized: -165, total: -184.95 }, book: { realized: -10, commissions: -9.75, unrealized: -165, total: -184.95 } },
        nav: { account: 2_821.55, book: 999_815.05 },
        balance: {
          account: { cash: 1_248.05, receivable: 239.35, payable: 218.65, positions: 2_993, assets: 4_480.40, liabilities: 1_658.85, netAssets: 2_821.55 },
          book: { cash: 998_241.55, receivable: 239.35, payable: 218.65, positions: 2_993, assets: 1_001_473.90, liabilities: 1_658.85, netAssets: 999_815.05 },
        },
      },
    },
    {
      id: 'settle-recovery', covers: ['settlement', 'interest accrual'], action: 'clock', to: MAR(5),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 239.35 USD into settled cash', date: '2026-03-05' },
          { type: 'settlement.pay', summary: 'paid 218.65 USD from settled cash' },
          { type: 'accrual.interest', summary: `Interest accrued on ${LOAN}: 0.20 USD` }, // 2 days: 0.40, less 0.20
        ],
        cash: { account: { USD: { settled: 1_268.75, unsettled: 0, availableToTrade: 1_268.75, availableToWithdraw: 1_268.75 } } },
        positions: [
          { instrument: 'c105', lot: 'retry', value: 213 }, { instrument: 'c105', lot: 'strangle', value: 1_065 }, { instrument: 'mloan', lot: 'strangle', qty: -1_440, accrued: -0.40 },
          { instrument: 'p95', lot: 'accept', value: 245 }, { instrument: 'p95', lot: 'retry', value: 245 }, { instrument: 'p95', lot: 'strangle', value: 1_225 },
        ],
        pending: [],
        borrowings: [{ lot: 'strangle', accrued: 0.40, costToDate: 0.40 }],
        pnl: { account: { borrowFunding: -0.40, total: -185.15 }, book: { borrowFunding: -0.40, total: -185.15 } },
        nav: { account: 2_821.35, book: 999_814.85 },
        balance: {
          account: { cash: 1_268.75, receivable: null, payable: null, accruedExpense: 0.40, assets: 4_261.75, liabilities: 1_440.40, netAssets: 2_821.35 },
          book: { cash: 998_262.25, receivable: null, payable: null, accruedExpense: 0.40, assets: 1_001_255.25, liabilities: 1_440.40, netAssets: 999_814.85 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'strangle', principal: 1_440, ccy: 'USD', accrued: 0.40 }] },
      },
    },
    {
      // Close "retry": its put at 2.40 and its call at 2.08. Realized -10 on each.
      id: 'close-retry', covers: ['close'], action: 'close', lot: 'retry', instrument: 'p95', scope: 'strategy', percent: 100,
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'close',
          legs: [
            { kind: 'trade', action: 'sell', instrument: 'p95', qty: 1, estimate: 2.40, settleDate: '2026-03-06', cash: 240, fees: 0.65 },
            { kind: 'trade', action: 'sell', instrument: 'c105', qty: 1, estimate: 2.08, settleDate: '2026-03-06', cash: 208, fees: 0.65 },
          ],
          cash: { USD: { proceeds: 448, fees: 1.30, required: 1.30 } },
        },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'p95', status: 'filled', avgPrice: 2.40 }, { action: 'sell', instrument: 'c105', status: 'filled', avgPrice: 2.08 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 1 NFX260320P95 @ 2.40 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 NFX260320C105 @ 2.08 USD (realized -10.00 USD)' },
        ],
        cash: { account: { USD: { settled: 1_268.75, unsettled: 446.70, availableToTrade: 1_715.45, availableToWithdraw: 1_268.75 } } }, // 239.35 + 207.35
        positions: [
          { instrument: 'c105', lot: 'strangle', value: 1_065 }, { instrument: 'mloan', lot: 'strangle', qty: -1_440 },
          { instrument: 'p95', lot: 'accept', value: 245 }, { instrument: 'p95', lot: 'strangle', value: 1_225 },
        ],
        holdings: { c105: { long: 5, short: 0, net: 5 }, p95: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'c105', lot: 'retry', dueDate: '2026-03-06', amount: 207.35 }, { instrument: 'p95', lot: 'retry', dueDate: '2026-03-06', amount: 239.35 }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'p95' }, { instrument: 'p95' }, { type: 'loan.interest' }],
        pnl: { account: { realized: -30, commissions: -11.05, unrealized: -155, total: -196.45 }, book: { realized: -30, commissions: -11.05, unrealized: -155, total: -196.45 } },
        nav: { account: 2_810.05, book: 999_803.55 },
        balance: {
          account: { cash: 1_268.75, receivable: 446.70, positions: 2_535, assets: 4_250.45, liabilities: 1_440.40, netAssets: 2_810.05 },
          book: { cash: 998_262.25, receivable: 446.70, positions: 2_535, assets: 1_001_243.95, liabilities: 1_440.40, netAssets: 999_803.55 },
        },
      },
    },
    {
      id: 'settle-close', covers: ['settlement', 'interest accrual'], action: 'clock', to: MAR(6),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 239.35 USD into settled cash', date: '2026-03-06' },
          { type: 'settlement.receive', summary: 'received 207.35 USD into settled cash' },
          { type: 'accrual.interest', summary: `Interest accrued on ${LOAN}: 0.20 USD` },
        ],
        cash: { account: { USD: { settled: 1_715.45, unsettled: 0, availableToTrade: 1_715.45, availableToWithdraw: 1_715.45 } } },
        positions: [
          { instrument: 'c105', lot: 'strangle', value: 1_065 }, { instrument: 'mloan', lot: 'strangle', qty: -1_440, accrued: -0.60 },
          { instrument: 'p95', lot: 'accept', value: 245 }, { instrument: 'p95', lot: 'strangle', value: 1_225 },
        ],
        pending: [],
        borrowings: [{ lot: 'strangle', accrued: 0.60, costToDate: 0.60 }],
        pnl: { account: { borrowFunding: -0.60, total: -196.65 }, book: { borrowFunding: -0.60, total: -196.65 } },
        nav: { account: 2_809.85, book: 999_803.35 },
        balance: {
          account: { cash: 1_715.45, receivable: null, accruedExpense: 0.60, assets: 4_250.45, liabilities: 1_440.60, netAssets: 2_809.85 },
          book: { cash: 998_708.95, receivable: null, accruedExpense: 0.60, assets: 1_001_243.95, liabilities: 1_440.60, netAssets: 999_803.35 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'strangle', principal: 1_440, ccy: 'USD', accrued: 0.60 }] },
      },
    },
    { id: 'expiry-fixing', action: 'close_price', instrument: 'index', date: '2026-03-20', value: 90, expect: {} },
    {
      // 20 March after the close: the index fixes at 90. The puts are settled in cash: 5 x (95 - 90) x 100 = 2,500 for
      // "strangle" (realized 2,500 - 1,250 = 1,250) and 500 for "accept" (realized 250), both paid on 23 March; the calls
      // lapse (realized -1,190). Interest to 20 March: 18 days x 0.20 = 3.60, of which 3.00 is new.
      id: 'expiry', covers: ['expiry', 'cash settlement', 'interest accrual'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [
          { type: 'option.cash_settled', summary: /^Exercised \(cash settlement\): 5 NFX260320P95 at 5(\.00)? per unit/, date: '2026-03-20' },
          { type: 'option.expired', summary: 'Expired worthless: 5 NFX260320C105 (fixing 90)', date: '2026-03-20' },
          { type: 'option.cash_settled', summary: /^Exercised \(cash settlement\): 1 NFX260320P95 at 5(\.00)? per unit/, date: '2026-03-20' },
          { type: 'accrual.interest', summary: `Interest accrued on ${LOAN}: 3.00 USD` },
        ],
        cash: { account: { USD: { settled: 1_715.45, unsettled: 3_000, reserved: 0, availableToTrade: 4_715.45, availableToWithdraw: 1_715.45, borrowed: 1_440 } } },
        positions: [{ instrument: 'mloan', lot: 'strangle', qty: -1_440, value: 1_440, carrying: -1_440, accrued: -3.60 }],
        holdings: { c105: null, p95: null },
        pending: [{ instrument: 'p95', lot: 'accept', dueDate: '2026-03-23', amount: 500, into: 'cash' }, { instrument: 'p95', lot: 'strangle', dueDate: '2026-03-23', amount: 2_500, into: 'cash' }],
        lifecycle: [{ type: 'loan.interest', instrument: 'mloan', dueDate: '2026-04-01', status: 'pending' }],
        borrowings: [{ lot: 'strangle', principal: 1_440, accrued: 3.60, costToDate: 3.60 }],
        pnl: { account: { realized: 280, commissions: -11.05, unrealized: 0, borrowFunding: -3.60, total: 265.35 }, book: { realized: 280, commissions: -11.05, unrealized: 0, borrowFunding: -3.60, total: 265.35 } },
        nav: { account: 3_271.85, book: 1_000_265.35 }, // 1,006.50 + 2,000 funded + 265.35
        balance: {
          account: { cash: 1_715.45, receivable: 3_000, positions: null, borrowed: 1_440, accruedExpense: 3.60, assets: 4_715.45, liabilities: 1_443.60, netAssets: 3_271.85 },
          book: { cash: 998_708.95, receivable: 3_000, positions: null, borrowed: 1_440, accruedExpense: 3.60, assets: 1_001_708.95, liabilities: 1_443.60, netAssets: 1_000_265.35 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'strangle', principal: 1_440, ccy: 'USD', accrued: 3.60 }] },
      },
    },
    {
      id: 'cash-settlement-paid', covers: 'settlement', action: 'clock', to: MAR(23),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 2,500.00 USD into settled cash', date: '2026-03-23' },
          { type: 'settlement.receive', summary: 'received 500.00 USD into settled cash' },
        ],
        cash: { account: { USD: { settled: 4_715.45, unsettled: 0, availableToTrade: 4_715.45, availableToWithdraw: 4_715.45 } } },
        pending: [],
        balance: { account: { cash: 4_715.45, receivable: null }, book: { cash: 1_001_708.95, receivable: null } },
      },
    },
    {
      // Repay the loan in full: 1,440 of principal and the interest to today, 21 days x 0.20 = 4.20 (0.60 newly accrued).
      id: 'repay-loan', covers: ['repayment', 'close'], action: 'repay', lot: 'strangle', instrument: 'mloan',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repay', action: 'repay_cash', purpose: 'financing', instrument: 'mloan', qty: 1_440, cash: -1_444.20, ccy: 'USD', financing: { amount: -1_444.20, principal: 1_440, interest: 4.20, full: true, rate: 0.05, maturity: null } }],
          cash: { USD: { financingOut: 1_444.20, required: 1_444.20, available: 4_715.45, shortfall: 0, netCash: -1_444.20 } },
        },
        result: { status: 'closed', orders: [{ kind: 'repay', action: 'repay_cash', status: 'filled', qty: 1_440, filledQty: 1_440 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'accrual.interest', summary: `Interest accrued on ${LOAN}: 0.60 USD`, date: '2026-03-23' },
          { type: 'loan.repayment', summary: /^Repaid 1,440\.00 USD of principal on Margin loan USD \(Long Strangle NFX\) \(in full\)/, cash: { USD: -1_440 }, owner: 'account', date: '2026-03-23' },
          { type: 'interest.payment', summary: `Interest paid on ${LOAN}: 4.20 USD`, cash: { USD: -4.20 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 3_271.25, unsettled: 0, availableToTrade: 3_271.25, availableToWithdraw: 3_271.25, borrowed: 0 } } }, // 4,715.45 - 1,444.20
        positions: [],
        lifecycle: [],
        borrowings: [],
        pnl: { account: { realized: 280, commissions: -11.05, borrowFunding: -4.20, total: 264.75 }, book: { borrowFunding: -4.20, total: 264.75 } },
        nav: { account: 3_271.25, book: 1_000_264.75 },
        balance: {
          account: { cash: 3_271.25, borrowed: null, accruedExpense: null, assets: 3_271.25, liabilities: 0, netAssets: 3_271.25 },
          book: { cash: 1_000_264.75, borrowed: null, accruedExpense: null, assets: 1_000_264.75, liabilities: 0, netAssets: 1_000_264.75 },
        },
        oversight: { accountBorrowings: [] },
      },
    },
  ],
};

// =====================================================================================================================
// iron_condor
// =====================================================================================================================
// Ashgrove 100 Index options (Cboe, European, cash-settled at 100 x the index), 20 March 2026: buy the 90 put and the
// 110 call (the wings), sell the 95 put and the 105 call (the inner legs), 5 each. Each written leg depends on the wing
// that covers it, so the reserve is the width of one side only: 5 x 100 x (95 - 90) = 2,500.
//   condor  opened short of cash (refused: the written put needs its whole reserve before the written call's premium
//           arrives, so the shortfall is measured leg by leg), then with Treasury funding sized to it; the 110 call fills
//           3 of 5 on its first cycle and the dependent 105 call follows it. The index fixes at 85: both put legs are
//           settled in cash (the bought 90 put receives 5, the written 95 put pays 10, per unit), both calls lapse.
//   retry / accept / unwind  1 of each when the written call has no fresh quote: it expires unfilled; Retry sells it,
//           then Close (written legs bought back first, the wings sold after them); Accept keeps the other three to
//           expiry; Unwind buys the written put back and then sells the wings.
const CONDOR_PAGE = (contracts, financing) => ({ template: 'Iron Condor', underlying: 'index', expiration: '2026-03-20', strikes: { 'Lower wing (put bought)': 90, 'Inner put (sold)': 95, 'Inner call (sold)': 105, 'Upper wing (call bought)': 110 }, contracts, ...(financing ? { financing } : {}) });
const condorInput = (contracts, financing) => templateInput('iron_condor', { underlyingId: '$inst:index', options: { expiration: '2026-03-20', strikes: { wingLower: 90, put: 95, call: 105, wingUpper: 110 }, contracts }, financing });
const agxOption = (symbol, right, strike) => ({
  productId: 'index_option', name: `AGX 20 March 2026 ${strike} ${right === 'C' ? 'call' : 'put'}`, symbol, marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlying: 'index', multiplier: 100,
  terms: { right, strike, expiration: '2026-03-20', exercise: 'european', settlement: 'cash', deliverable: { units: 100 } },
});
const condorOne = (as) => ({ action: 'package', as, instrument: 'index', input: condorInput(1, null), strategyPage: CONDOR_PAGE(1, null) });
const ironCondor = {
  template: 'iron_condor',
  title: 'Iron condor on the Ashgrove 100 Index (Cboe, cash-settled): 20 March 2026 90 / 95 puts and 105 / 110 calls',
  matrix: {
    ...OPTION_TEMPLATE_MATRIX,
    settlement: 'Premium of each leg T+1 on the US calendar; Treasury funding moves at once; cash settlement of the put legs T+1 after expiry (receipts settled before payments)',
    lifecycle: 'Four expiry items settled from the index fixing for 20 March 2026 (85: the outer and inner puts settled in cash, the calls lapse); a failed dependent leg leaves the instance needing attention: Retry, Unwind or Accept; Close and Unwind buy the written legs back before the wings are sold',
    accounting: 'Net credit received; average premium per leg; commission expensed; premium realized on buy-back, sale, cash settlement and lapse',
    collateral: 'Each written leg is covered by its wing: one side\'s width is reserved (5 x 100 x 5 = 2,500), released at settlement; the package\'s cash need is measured leg by leg in execution order',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: [] },
  book: book('Templates iron condor'),
  instruments: {
    index: { productId: 'etf', name: 'Ashgrove 100 Index (reference level)', symbol: 'AGX', marketView: 'US_CASH', venue: 'Ashgrove Indices', venueType: 'exchange', venueCountry: 'US', issuer: 'Ashgrove Indices LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    p90: agxOption('AGX260320P90', 'P', 90),
    p95: agxOption('AGX260320P95', 'P', 95),
    c105: agxOption('AGX260320C105', 'C', 105),
    c110: agxOption('AGX260320C110', 'C', 110),
  },
  quotes: {
    index: { bid: 99.99, ask: 100.01, last: 100, bidSize: 1000, askSize: 1000 },
    p90: { bid: 0.90, ask: 1.00, last: 0.95, bidSize: 20, askSize: 20 },
    p95: { bid: 1.90, ask: 2.00, last: 1.95, bidSize: 20, askSize: 20 },
    c105: { bid: 1.80, ask: 1.90, last: 1.85, bidSize: 20, askSize: 20 },
    c110: { bid: 0.80, ask: 0.90, last: 0.85, bidSize: 20, askSize: 3 }, // only 3 contracts displayed at the ask
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
      // Netted, the package needs 950 for the wings (500 + 450), 13 of commission and 2,500 reserved, and brings 1,850
      // (950 + 900): 613 short. Leg by leg from 1,000: the wings leave 1,000 - 503.25 - 453.25 = 43.50 free; the written
      // put brings 946.75 and must find 2,500: 43.50 + 946.75 - 2,500 = -1,509.75, before the written call's 896.75.
      id: 'open-short-of-cash', covers: 'financing', action: 'package', as: 'refused', instrument: 'index',
      input: condorInput(5, null), strategyPage: CONDOR_PAGE(5, null),
      status: 'blocked', reason: 'The Account cannot fund the package as its legs execute: the preview is blocked until financing is chosen.',
      expect: {
        refused: 'Alpha is short 1,509.75 USD while the legs execute',
        preview: {
          blocking: 1, errors: ['cash'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p90', qty: 5, estimate: 1.00, settleDate: '2026-03-03', cash: -500, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c110', qty: 5, estimate: 0.90, settleDate: '2026-03-03', cash: -450, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'p95', qty: 5, estimate: 1.90, settleDate: '2026-03-03', cash: 950, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c105', qty: 5, estimate: 1.80, settleDate: '2026-03-03', cash: 900, fees: 3.25, dependsOn: [2] },
          ],
          cash: { USD: { purchases: 950, proceeds: 1_850, fees: 13, reserved: 2_500, required: 3_463, available: 1_000, shortfall: 1_509.75 } },
        },
      },
    },
    {
      // Treasury funding of 1,509.75 runs first. The 90 puts fill 5 at 1.00, the 110 calls 3 at 0.90; the 95 puts follow
      // their wing with 5 at 1.90 and the 105 calls theirs with 3 at 1.80; on the next cycle 2 more 110 and 105 calls.
      id: 'open', covers: ['open', 'financing', 'partial fill', 'dependency'], action: 'package', as: 'condor', instrument: 'index',
      input: condorInput(5, { mode: 'treasury' }), strategyPage: CONDOR_PAGE(5, { mode: 'treasury' }),
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', action: 'treasury_funding', purpose: 'financing', qty: 1_509.75, cash: 1_509.75, dependsOn: [] },
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'p90', qty: 5, estimate: 1.00, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', cash: -500, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'c110', qty: 5, estimate: 0.90, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -450, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', purpose: 'primary', instrument: 'p95', qty: 5, estimate: 1.90, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: 950, fees: 3.25, dependsOn: [2, 1] },
            { kind: 'trade', action: 'sell', purpose: 'primary', instrument: 'c105', qty: 5, estimate: 1.80, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: 900, fees: 3.25, dependsOn: [3, 1] },
          ],
          cash: { USD: { purchases: 950, proceeds: 1_850, fees: 13, reserved: 2_500, financingIn: 1_509.75, required: 3_463, available: 1_000, shortfall: 0, netCash: 2_396.75 } }, // 1,850 + 1,509.75 - 950 - 13
          netPremium: { amount: -900, ccy: 'USD', type: 'credit', complete: true },
          optionRequirement: [{ ccy: 'USD', amount: 2_500, finite: 2_500, naked: 0, uncoveredCallUnits: 0 }],
        },
        result: {
          status: 'partial',
          orders: [
            { kind: 'funding', status: 'filled', filledQty: 1_509.75 },
            { action: 'buy', instrument: 'p90', status: 'filled', filledQty: 5, avgPrice: 1.00 },
            { action: 'buy', instrument: 'c110', status: 'partial', filledQty: 3, avgPrice: 0.90 },
            { action: 'sell', instrument: 'p95', status: 'filled', filledQty: 5, avgPrice: 1.90 },
            { action: 'sell', instrument: 'c105', status: 'partial', filledQty: 3, avgPrice: 1.80 },
          ],
        },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 1,509.75 USD from Treasury to Alpha' },
          { type: 'trade.fill', summary: 'Bought 5 AGX260320P90 @ 1.00 USD', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Bought 3 AGX260320C110 @ 0.90 USD' },
          { type: 'trade.fill', summary: 'Sold 5 AGX260320P95 @ 1.90 USD' },
          { type: 'trade.fill', summary: 'Sold 3 AGX260320C105 @ 1.80 USD' },
          { type: 'trade.fill', summary: 'Bought 2 AGX260320C110 @ 0.90 USD' },
          { type: 'trade.fill', summary: 'Sold 2 AGX260320C105 @ 1.80 USD' },
        ],
        cash: {
          // owed 503.25 + 271.95 + 181.30 = 956.50; owed to it 946.75 + 538.05 + 358.70 = 1,843.50; reserved 2,500.
          // To trade: 2,509.75 + 887 - 2,500 = 896.75. To withdraw: 2,509.75 - 956.50 - 2,500 = -946.75.
          account: { USD: { settled: 2_509.75, unsettled: 887, reserved: 2_500, availableToTrade: 896.75, availableToWithdraw: -946.75 } },
          treasury: { USD: { settled: 997_490.25, unsettled: 0, availableToTrade: 997_490.25, availableToWithdraw: 997_490.25 } },
        },
        positions: [
          { instrument: 'c105', lot: 'condor', owner: 'account', direction: 'short', qty: -5, avgCost: 1.80, cost: -900, price: 1.85, value: -925, unrealized: -25 },
          { instrument: 'c110', lot: 'condor', owner: 'account', direction: 'long', qty: 5, avgCost: 0.90, cost: 450, price: 0.85, value: 425, unrealized: -25 },
          { instrument: 'p90', lot: 'condor', owner: 'account', direction: 'long', qty: 5, avgCost: 1.00, cost: 500, price: 0.95, value: 475, unrealized: -25 },
          { instrument: 'p95', lot: 'condor', owner: 'account', direction: 'short', qty: -5, avgCost: 1.90, cost: -950, price: 1.95, value: -975, unrealized: -25 },
        ],
        holdings: { c105: { long: 0, short: 5, net: -5 }, c110: { long: 5, short: 0, net: 5 }, p90: { long: 5, short: 0, net: 5 }, p95: { long: 0, short: 5, net: -5 } },
        pending: [
          { instrument: 'c105', lot: 'condor', dueDate: '2026-03-03', amount: 358.70, into: 'cash' },
          { instrument: 'c105', lot: 'condor', dueDate: '2026-03-03', amount: 538.05, into: 'cash' },
          { instrument: 'c110', lot: 'condor', dueDate: '2026-03-03', amount: -271.95, into: 'cash' },
          { instrument: 'c110', lot: 'condor', dueDate: '2026-03-03', amount: -181.30, into: 'cash' },
          { instrument: 'p90', lot: 'condor', dueDate: '2026-03-03', amount: -503.25, into: 'cash' },
          { instrument: 'p95', lot: 'condor', dueDate: '2026-03-03', amount: 946.75, into: 'cash' },
        ],
        lifecycle: [
          { type: 'option.expiry', instrument: 'c105', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'c110', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'p90', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'p95', dueDate: '2026-03-20', status: 'pending' },
        ],
        pnl: {
          account: { realized: 0, commissions: -13, fees: 0, unrealized: -100, total: -113 },
          book: { realized: 0, commissions: -13, unrealized: -100, total: -113 },
          treasury: { total: 0 },
        },
        nav: { account: 2_396.75, treasury: 997_490.25, book: 999_887 }, // 1,000 + 1,509.75 - 113
        balance: {
          account: { cash: 2_509.75, receivable: 1_843.50, payable: 956.50, positions: -1_000, assets: 3_353.25, liabilities: 956.50, netAssets: 2_396.75 },
          treasury: { cash: 997_490.25, assets: 997_490.25, liabilities: 0, netAssets: 997_490.25 },
          book: { cash: 1_000_000, receivable: 1_843.50, payable: 956.50, positions: -1_000, assets: 1_000_843.50, liabilities: 956.50, netAssets: 999_887 },
        },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR(3),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 946.75 USD into settled cash', date: '2026-03-03' },
          { type: 'settlement.receive', summary: 'received 538.05 USD into settled cash' },
          { type: 'settlement.receive', summary: 'received 358.70 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 503.25 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 271.95 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 181.30 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 3_396.75, unsettled: 0, availableToTrade: 896.75, availableToWithdraw: 896.75 } } },
        pending: [],
        balance: {
          account: { cash: 3_396.75, receivable: null, payable: null, assets: 2_396.75, liabilities: 0 },
          book: { cash: 1_000_887, receivable: null, payable: null, assets: 999_887, liabilities: 0 },
        },
      },
    },
    {
      id: 'fund-account', covers: 'internal funding', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 2_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 2,000.00 USD from Treasury to Alpha' }],
        cash: { account: { USD: { settled: 5_396.75, availableToTrade: 2_896.75, availableToWithdraw: 2_896.75 } }, treasury: { USD: { settled: 995_490.25, availableToTrade: 995_490.25, availableToWithdraw: 995_490.25 } } },
        nav: { account: 4_396.75, treasury: 995_490.25 },
        balance: { account: { cash: 5_396.75, assets: 4_396.75, netAssets: 4_396.75 }, treasury: { cash: 995_490.25, assets: 995_490.25, netAssets: 995_490.25 } },
      },
    },
    // The written call's quote stops updating at 09:50.
    { id: 'c105-quote-stops', action: 'quote', instrument: 'c105', quote: { bid: 1.80, ask: 1.90, last: 1.85, bidSize: 20, askSize: 20, asOf: MAR(3, '09:50') }, expect: {} },
    {
      // 1 of each: wings 100 + 90, inner legs 190 + 185 (the call estimated at its last 1.85), 2.60 commission, 500
      // reserved. Leg by leg the deepest point is after the written put: 2,896.75 - 100.65 - 90.65 + 189.35 - 500.
      ...condorOne('retry'), id: 'open-retry', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p90', qty: 1, estimate: 1.00, settleDate: '2026-03-04', cash: -100, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c110', qty: 1, estimate: 0.90, settleDate: '2026-03-04', cash: -90, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'p95', qty: 1, estimate: 1.90, settleDate: '2026-03-04', cash: 190, fees: 0.65, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c105', qty: 1, estimate: null, reference: 1.85, executable: false, settleDate: '2026-03-04', cash: 185, fees: 0.65, dependsOn: [2] },
          ],
          cash: { USD: { purchases: 190, proceeds: 375, fees: 2.60, reserved: 500, required: 692.60, available: 2_896.75, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ instrument: 'p90', status: 'filled' }, { instrument: 'c110', status: 'filled' }, { instrument: 'p95', status: 'filled' }, { instrument: 'c105', status: 'working', filledQty: 0 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 1 AGX260320P90 @ 1.00 USD', date: '2026-03-03' },
          { type: 'trade.fill', summary: 'Bought 1 AGX260320C110 @ 0.90 USD' },
          { type: 'trade.fill', summary: 'Sold 1 AGX260320P95 @ 1.90 USD' },
        ],
        // -100.65 - 90.65 + 189.35 = -1.95; reserved 2,500 + 500 (its written put, covered by its 90 put)
        cash: { account: { USD: { settled: 5_396.75, unsettled: -1.95, reserved: 3_000, availableToTrade: 2_394.80, availableToWithdraw: 2_205.45 } } },
        positions: [
          { instrument: 'c105', lot: 'condor', value: -925 },
          { instrument: 'c110', lot: 'condor', value: 425 },
          { instrument: 'c110', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 0.90, cost: 90, price: 0.85, value: 85, unrealized: -5 },
          { instrument: 'p90', lot: 'condor', value: 475 },
          { instrument: 'p90', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 1.00, cost: 100, price: 0.95, value: 95, unrealized: -5 },
          { instrument: 'p95', lot: 'condor', value: -975 },
          { instrument: 'p95', lot: 'retry', owner: 'account', direction: 'short', qty: -1, avgCost: 1.90, cost: -190, price: 1.95, value: -195, unrealized: -5 },
        ],
        holdings: { c110: { long: 6, short: 0, net: 6 }, p90: { long: 6, short: 0, net: 6 }, p95: { long: 0, short: 6, net: -6 } },
        pending: [
          { instrument: 'c110', lot: 'retry', dueDate: '2026-03-04', amount: -90.65 },
          { instrument: 'p90', lot: 'retry', dueDate: '2026-03-04', amount: -100.65 },
          { instrument: 'p95', lot: 'retry', dueDate: '2026-03-04', amount: 189.35 },
        ],
        openOrders: [{ instrument: 'c105', kind: 'trade', action: 'sell', status: 'working', qty: 1, filledQty: 0 }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p95' }, { instrument: 'p95' }],
        pnl: { account: { commissions: -14.95, unrealized: -115, total: -129.95 }, book: { commissions: -14.95, unrealized: -115, total: -129.95 } },
        nav: { account: 4_379.80, book: 999_870.05 },
        balance: {
          account: { cash: 5_396.75, receivable: 189.35, payable: 191.30, positions: -1_015, assets: 4_571.10, liabilities: 191.30, netAssets: 4_379.80 },
          book: { cash: 1_000_887, receivable: 189.35, payable: 191.30, positions: -1_015, assets: 1_000_061.35, liabilities: 191.30, netAssets: 999_870.05 },
        },
      },
    },
    {
      ...condorOne('accept'), id: 'open-accept', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'p90' }, { instrument: 'c110' }, { instrument: 'p95', dependsOn: [1] }, { instrument: 'c105', estimate: null, dependsOn: [2] }], cash: { USD: { required: 692.60, available: 2_394.80, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ status: 'filled' }, { status: 'filled' }, { status: 'filled' }, { instrument: 'c105', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill' }, { type: 'trade.fill' }, { type: 'trade.fill' }],
        cash: { account: { USD: { settled: 5_396.75, unsettled: -3.90, reserved: 3_500, availableToTrade: 1_892.85, availableToWithdraw: 1_514.15 } } },
        positions: [
          { instrument: 'c105', lot: 'condor', value: -925 },
          { instrument: 'c110', lot: 'accept', value: 85 }, { instrument: 'c110', lot: 'condor', value: 425 }, { instrument: 'c110', lot: 'retry', value: 85 },
          { instrument: 'p90', lot: 'accept', value: 95 }, { instrument: 'p90', lot: 'condor', value: 475 }, { instrument: 'p90', lot: 'retry', value: 95 },
          { instrument: 'p95', lot: 'accept', value: -195 }, { instrument: 'p95', lot: 'condor', value: -975 }, { instrument: 'p95', lot: 'retry', value: -195 },
        ],
        holdings: { c110: { long: 7, short: 0, net: 7 }, p90: { long: 7, short: 0, net: 7 }, p95: { long: 0, short: 7, net: -7 } },
        pending: [
          { instrument: 'c110', lot: 'accept', amount: -90.65 }, { instrument: 'c110', lot: 'retry', amount: -90.65 },
          { instrument: 'p90', lot: 'accept', amount: -100.65 }, { instrument: 'p90', lot: 'retry', amount: -100.65 },
          { instrument: 'p95', lot: 'accept', amount: 189.35 }, { instrument: 'p95', lot: 'retry', amount: 189.35 },
        ],
        openOrders: [{ instrument: 'c105', status: 'working' }, { instrument: 'c105', status: 'working' }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }],
        pnl: { account: { commissions: -16.90, unrealized: -130, total: -146.90 }, book: { commissions: -16.90, unrealized: -130, total: -146.90 } },
        nav: { account: 4_362.85, book: 999_853.10 },
        balance: {
          account: { cash: 5_396.75, receivable: 378.70, payable: 382.60, positions: -1_030, assets: 4_745.45, liabilities: 382.60, netAssets: 4_362.85 },
          book: { cash: 1_000_887, receivable: 378.70, payable: 382.60, positions: -1_030, assets: 1_000_235.70, liabilities: 382.60, netAssets: 999_853.10 },
        },
      },
    },
    {
      ...condorOne('unwind'), id: 'open-unwind', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'p90' }, { instrument: 'c110' }, { instrument: 'p95' }, { instrument: 'c105', estimate: null }], cash: { USD: { required: 692.60, available: 1_892.85, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ status: 'filled' }, { status: 'filled' }, { status: 'filled' }, { instrument: 'c105', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill' }, { type: 'trade.fill' }, { type: 'trade.fill' }],
        cash: { account: { USD: { settled: 5_396.75, unsettled: -5.85, reserved: 4_000, availableToTrade: 1_390.90, availableToWithdraw: 822.85 } } },
        positions: [
          { instrument: 'c105', lot: 'condor', value: -925 },
          { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'condor' }, { instrument: 'c110', lot: 'retry' }, { instrument: 'c110', lot: 'unwind', qty: 1, value: 85 },
          { instrument: 'p90', lot: 'accept' }, { instrument: 'p90', lot: 'condor' }, { instrument: 'p90', lot: 'retry' }, { instrument: 'p90', lot: 'unwind', qty: 1, value: 95 },
          { instrument: 'p95', lot: 'accept' }, { instrument: 'p95', lot: 'condor' }, { instrument: 'p95', lot: 'retry' }, { instrument: 'p95', lot: 'unwind', qty: -1, value: -195 },
        ],
        holdings: { c110: { long: 8, short: 0, net: 8 }, p90: { long: 8, short: 0, net: 8 }, p95: { long: 0, short: 8, net: -8 } },
        pending: [
          { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'retry' }, { instrument: 'c110', lot: 'unwind', amount: -90.65 },
          { instrument: 'p90', lot: 'accept' }, { instrument: 'p90', lot: 'retry' }, { instrument: 'p90', lot: 'unwind', amount: -100.65 },
          { instrument: 'p95', lot: 'accept' }, { instrument: 'p95', lot: 'retry' }, { instrument: 'p95', lot: 'unwind', amount: 189.35 },
        ],
        openOrders: [{ instrument: 'c105', status: 'working' }, { instrument: 'c105', status: 'working' }, { instrument: 'c105', status: 'working' }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }],
        pnl: { account: { commissions: -18.85, unrealized: -145, total: -163.85 }, book: { commissions: -18.85, unrealized: -145, total: -163.85 } },
        nav: { account: 4_345.90, book: 999_836.15 },
        balance: {
          account: { cash: 5_396.75, receivable: 568.05, payable: 573.90, positions: -1_045, assets: 4_919.80, liabilities: 573.90, netAssets: 4_345.90 },
          book: { cash: 1_000_887, receivable: 568.05, payable: 573.90, positions: -1_045, assets: 1_000_410.05, liabilities: 573.90, netAssets: 999_836.15 },
        },
      },
    },
    {
      // End of 3 March: the three written-call legs expire unfilled; the other legs settle.
      id: 'call-legs-expire', covers: ['failed dependent leg', 'settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 189.35 USD into settled cash', date: '2026-03-04' },
          { type: 'settlement.receive', summary: 'received 189.35 USD into settled cash' },
          { type: 'settlement.receive', summary: 'received 189.35 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 100.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 90.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 100.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 90.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 100.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 90.65 USD from settled cash' },
          { type: 'order.expired', summary: 'Leg 4 expired: sell 1 AGX260320C105. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 4 expired: sell 1 AGX260320C105. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 4 expired: sell 1 AGX260320C105. Day order did not fill before the end of the business day' },
        ],
        cash: { account: { USD: { settled: 5_390.90, unsettled: 0, availableToTrade: 1_390.90, availableToWithdraw: 1_390.90 } } },
        pending: [], openOrders: [],
        failed: { orders: 3 },
        alerts: ['strategy.attention', 'strategy.attention', 'strategy.attention'],
        balance: { account: { cash: 5_390.90, receivable: null, payable: null, assets: 4_345.90, liabilities: 0 }, book: { cash: 1_000_881.15, receivable: null, payable: null, assets: 999_836.15, liabilities: 0 } },
      },
    },
    {
      id: 'c105-quote-day3', action: 'quote', instrument: 'c105', quote: { bid: 1.60, ask: 1.70, last: 1.65, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c105', lot: 'condor', price: 1.65, value: -825, unrealized: 75 }, // -5 x 1.65 x 100 + 900
          { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'condor' }, { instrument: 'c110', lot: 'retry' }, { instrument: 'c110', lot: 'unwind' },
          { instrument: 'p90', lot: 'accept' }, { instrument: 'p90', lot: 'condor' }, { instrument: 'p90', lot: 'retry' }, { instrument: 'p90', lot: 'unwind' },
          { instrument: 'p95', lot: 'accept' }, { instrument: 'p95', lot: 'condor' }, { instrument: 'p95', lot: 'retry' }, { instrument: 'p95', lot: 'unwind' },
        ],
        pnl: { account: { unrealized: -45, total: -63.85 }, book: { unrealized: -45, total: -63.85 } },
        nav: { account: 4_445.90, book: 999_936.15 },
        balance: { account: { positions: -945, assets: 4_445.90, netAssets: 4_445.90 }, book: { positions: -945, assets: 999_936.15, netAssets: 999_936.15 } },
      },
    },
    {
      // Retry sells the call at 1.60 (159.35 after commission). It is covered by the instance's 110 call: the reserve stays 500.
      id: 'retry', covers: ['retry', 'failed dependent leg'], action: 'recover', how: 'retry', lot: 'retry',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'retry', legs: [{ kind: 'trade', action: 'sell', instrument: 'c105', qty: 1, estimate: 1.60, settleDate: '2026-03-05', cash: 160, fees: 0.65 }], cash: { USD: { proceeds: 160, fees: 0.65, reserved: 0, required: 0.65, available: 1_390.90, shortfall: 0 } }, optionRequirement: [{ ccy: 'USD', amount: 500, finite: 500, naked: 0, uncoveredCallUnits: 0 }] },
        result: { status: 'open', complete: true, orders: [{ action: 'sell', instrument: 'c105', status: 'filled', filledQty: 1, avgPrice: 1.60 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 AGX260320C105 @ 1.60 USD', date: '2026-03-04' }],
        cash: { account: { USD: { settled: 5_390.90, unsettled: 159.35, reserved: 4_000, availableToTrade: 1_550.25, availableToWithdraw: 1_390.90 } } },
        positions: [
          { instrument: 'c105', lot: 'condor', value: -825 }, { instrument: 'c105', lot: 'retry', owner: 'account', direction: 'short', qty: -1, avgCost: 1.60, cost: -160, price: 1.65, value: -165, unrealized: -5 },
          { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'condor' }, { instrument: 'c110', lot: 'retry' }, { instrument: 'c110', lot: 'unwind' },
          { instrument: 'p90', lot: 'accept' }, { instrument: 'p90', lot: 'condor' }, { instrument: 'p90', lot: 'retry' }, { instrument: 'p90', lot: 'unwind' },
          { instrument: 'p95', lot: 'accept' }, { instrument: 'p95', lot: 'condor' }, { instrument: 'p95', lot: 'retry' }, { instrument: 'p95', lot: 'unwind' },
        ],
        holdings: { c105: { long: 0, short: 6, net: -6 } },
        pending: [{ instrument: 'c105', lot: 'retry', dueDate: '2026-03-05', amount: 159.35 }],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }],
        alerts: ['strategy.attention', 'strategy.attention'],
        pnl: { account: { commissions: -19.50, unrealized: -50, total: -69.50 }, book: { commissions: -19.50, unrealized: -50, total: -69.50 } },
        nav: { account: 4_440.25, book: 999_930.50 },
        balance: {
          account: { cash: 5_390.90, receivable: 159.35, positions: -1_110, assets: 4_440.25, liabilities: 0, netAssets: 4_440.25 },
          book: { cash: 1_000_881.15, receivable: 159.35, positions: -1_110, assets: 999_930.50, netAssets: 999_930.50 },
        },
      },
    },
    {
      id: 'accept', covers: ['accept', 'failed dependent leg'], action: 'strategy_action', lot: 'accept', how: 'accept',
      expect: { events: [{ type: 'strategy.accepted', summary: 'accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: ['strategy.attention'] },
    },
    {
      // Unwind: the written 95 put is bought back first at 2.00; the wings are sold after it (0.90 and 0.80). Realized
      // -10 on each leg. The instance's 500 reserve is released.
      id: 'unwind', covers: ['unwind', 'close', 'dependency'], action: 'recover', how: 'unwind', lot: 'unwind',
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'unwind',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p95', qty: 1, estimate: 2.00, settleDate: '2026-03-05', cash: -200, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'p90', qty: 1, estimate: 0.90, settleDate: '2026-03-05', cash: 90, fees: 0.65, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c110', qty: 1, estimate: 0.80, settleDate: '2026-03-05', cash: 80, fees: 0.65, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 200, proceeds: 170, fees: 1.95, reserved: 0, required: 201.95, available: 1_550.25, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ action: 'buy', instrument: 'p95', status: 'filled' }, { action: 'sell', instrument: 'p90', status: 'filled' }, { action: 'sell', instrument: 'c110', status: 'filled' }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 1 AGX260320P95 @ 2.00 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 AGX260320P90 @ 0.90 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 AGX260320C110 @ 0.80 USD (realized -10.00 USD)' },
        ],
        // 159.35 - 200.65 + 89.35 + 79.35 = 127.40; reserved 4,000 - 500
        cash: { account: { USD: { settled: 5_390.90, unsettled: 127.40, reserved: 3_500, availableToTrade: 2_018.30, availableToWithdraw: 1_690.25 } } },
        positions: [
          { instrument: 'c105', lot: 'condor', value: -825 }, { instrument: 'c105', lot: 'retry', value: -165 },
          { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'condor' }, { instrument: 'c110', lot: 'retry' },
          { instrument: 'p90', lot: 'accept' }, { instrument: 'p90', lot: 'condor' }, { instrument: 'p90', lot: 'retry' },
          { instrument: 'p95', lot: 'accept' }, { instrument: 'p95', lot: 'condor' }, { instrument: 'p95', lot: 'retry' },
        ],
        holdings: { c110: { long: 7, short: 0, net: 7 }, p90: { long: 7, short: 0, net: 7 }, p95: { long: 0, short: 7, net: -7 } },
        pending: [
          { instrument: 'c105', lot: 'retry', amount: 159.35 },
          { instrument: 'c110', lot: 'unwind', dueDate: '2026-03-05', amount: 79.35 },
          { instrument: 'p90', lot: 'unwind', dueDate: '2026-03-05', amount: 89.35 },
          { instrument: 'p95', lot: 'unwind', dueDate: '2026-03-05', amount: -200.65 },
        ],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p95' }, { instrument: 'p95' }, { instrument: 'p95' }],
        alerts: [],
        pnl: { account: { realized: -30, commissions: -21.45, unrealized: -35, total: -86.45 }, book: { realized: -30, commissions: -21.45, unrealized: -35, total: -86.45 } },
        nav: { account: 4_423.30, book: 999_913.55 }, // 4,440.25 - 15 (each leg 0.05 from its mark) - 1.95
        balance: {
          account: { cash: 5_390.90, receivable: 328.05, payable: 200.65, positions: -1_095, assets: 4_623.95, liabilities: 200.65, netAssets: 4_423.30 },
          book: { cash: 1_000_881.15, receivable: 328.05, payable: 200.65, positions: -1_095, assets: 1_000_114.20, liabilities: 200.65, netAssets: 999_913.55 },
        },
      },
    },
    {
      id: 'settle-recovery', covers: 'settlement', action: 'clock', to: MAR(5),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 159.35 USD into settled cash', date: '2026-03-05' },
          { type: 'settlement.receive', summary: 'received 89.35 USD into settled cash' },
          { type: 'settlement.receive', summary: 'received 79.35 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 200.65 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 5_518.30, unsettled: 0, availableToTrade: 2_018.30, availableToWithdraw: 2_018.30 } } },
        pending: [],
        balance: { account: { cash: 5_518.30, receivable: null, payable: null, assets: 4_423.30, liabilities: 0 }, book: { cash: 1_001_008.55, receivable: null, payable: null, assets: 999_913.55, liabilities: 0 } },
      },
    },
    {
      // Close "retry": the written 95 put (2.00) and 105 call (1.70) are bought back first; the wings (0.90, 0.80) are
      // sold after them. Realized -10 on each of the four legs.
      id: 'close-retry', covers: ['close', 'dependency'], action: 'close', lot: 'retry', instrument: 'p90', scope: 'strategy', percent: 100,
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'close',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p95', qty: 1, estimate: 2.00, settleDate: '2026-03-06', cash: -200, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c105', qty: 1, estimate: 1.70, settleDate: '2026-03-06', cash: -170, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'p90', qty: 1, estimate: 0.90, settleDate: '2026-03-06', cash: 90, fees: 0.65, dependsOn: [1, 2] },
            { kind: 'trade', action: 'sell', instrument: 'c110', qty: 1, estimate: 0.80, settleDate: '2026-03-06', cash: 80, fees: 0.65, dependsOn: [1, 2] },
          ],
          cash: { USD: { purchases: 370, proceeds: 170, fees: 2.60, reserved: 0, required: 372.60, available: 2_018.30, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ instrument: 'p95', status: 'filled' }, { instrument: 'c105', status: 'filled' }, { instrument: 'p90', status: 'filled' }, { instrument: 'c110', status: 'filled' }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 1 AGX260320P95 @ 2.00 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Bought 1 AGX260320C105 @ 1.70 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 AGX260320P90 @ 0.90 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 AGX260320C110 @ 0.80 USD (realized -10.00 USD)' },
        ],
        // -200.65 - 170.65 + 89.35 + 79.35 = -202.60; reserved 2,500 (condor) + 500 (accept)
        cash: { account: { USD: { settled: 5_518.30, unsettled: -202.60, reserved: 3_000, availableToTrade: 2_315.70, availableToWithdraw: 2_147 } } },
        positions: [
          { instrument: 'c105', lot: 'condor', value: -825 },
          { instrument: 'c110', lot: 'accept', value: 85 }, { instrument: 'c110', lot: 'condor', value: 425 },
          { instrument: 'p90', lot: 'accept', value: 95 }, { instrument: 'p90', lot: 'condor', value: 475 },
          { instrument: 'p95', lot: 'accept', value: -195 }, { instrument: 'p95', lot: 'condor', value: -975 },
        ],
        holdings: { c105: { long: 0, short: 5, net: -5 }, c110: { long: 6, short: 0, net: 6 }, p90: { long: 6, short: 0, net: 6 }, p95: { long: 0, short: 6, net: -6 } },
        pending: [
          { instrument: 'c105', lot: 'retry', dueDate: '2026-03-06', amount: -170.65 },
          { instrument: 'c110', lot: 'retry', dueDate: '2026-03-06', amount: 79.35 },
          { instrument: 'p90', lot: 'retry', dueDate: '2026-03-06', amount: 89.35 },
          { instrument: 'p95', lot: 'retry', dueDate: '2026-03-06', amount: -200.65 },
        ],
        lifecycle: [{ instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'p90' }, { instrument: 'p90' }, { instrument: 'p95' }, { instrument: 'p95' }],
        pnl: { account: { realized: -70, commissions: -24.05, unrealized: -15, total: -109.05 }, book: { realized: -70, commissions: -24.05, unrealized: -15, total: -109.05 } },
        nav: { account: 4_400.70, book: 999_890.95 },
        balance: {
          account: { cash: 5_518.30, receivable: 168.70, payable: 371.30, positions: -915, assets: 4_772, liabilities: 371.30, netAssets: 4_400.70 },
          book: { cash: 1_001_008.55, receivable: 168.70, payable: 371.30, positions: -915, assets: 1_000_262.25, liabilities: 371.30, netAssets: 999_890.95 },
        },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MAR(6),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 89.35 USD into settled cash', date: '2026-03-06' },
          { type: 'settlement.receive', summary: 'received 79.35 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 200.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 170.65 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 5_315.70, unsettled: 0, availableToTrade: 2_315.70, availableToWithdraw: 2_315.70 } } },
        pending: [],
        balance: { account: { cash: 5_315.70, receivable: null, payable: null, assets: 4_400.70, liabilities: 0 }, book: { cash: 1_000_805.95, receivable: null, payable: null, assets: 999_890.95, liabilities: 0 } },
      },
    },
    { id: 'expiry-fixing', action: 'close_price', instrument: 'index', date: '2026-03-20', value: 85, expect: {} },
    {
      // The index fixes at 85, below both puts. Outer legs: the bought 90 puts receive 5 x 100 = 500 a contract (realized
      // 2,500 - 500 = 2,000 in "condor", 500 - 100 = 400 in "accept"); inner legs: the written 95 puts pay 10 x 100 =
      // 1,000 a contract (-5,000 + 950 = -4,050; -1,000 + 190 = -810). The calls lapse: written 105s keep 900, bought
      // 110s lose 450 and 90. Realized -70 - 2,100 = -2,170: the maximum loss of each condor, its width less its credit.
      id: 'expiry', covers: ['expiry', 'cash settlement', 'assignment'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [
          { type: 'option.cash_settled', summary: /^Exercised \(cash settlement\): 5 AGX260320P90 at 5(\.00)? per unit/, date: '2026-03-20' },
          { type: 'option.expired', summary: 'Expired worthless: 5 AGX260320C110 (fixing 85)' },
          { type: 'option.cash_settled', summary: /^Assigned \(cash settlement\): 5 AGX260320P95 at 10(\.00)? per unit/ },
          { type: 'option.expired', summary: 'Expired worthless: 5 AGX260320C105 (fixing 85)' },
          { type: 'option.cash_settled', summary: /^Exercised \(cash settlement\): 1 AGX260320P90 at 5(\.00)? per unit/ },
          { type: 'option.expired', summary: 'Expired worthless: 1 AGX260320C110 (fixing 85)' },
          { type: 'option.cash_settled', summary: /^Assigned \(cash settlement\): 1 AGX260320P95 at 10(\.00)? per unit/ },
        ],
        cash: { account: { USD: { settled: 5_315.70, unsettled: -3_000, reserved: 0, availableToTrade: 2_315.70, availableToWithdraw: -684.30 } } },
        positions: [],
        holdings: { c105: null, c110: null, p90: null, p95: null },
        pending: [
          { instrument: 'p90', lot: 'accept', dueDate: '2026-03-23', amount: 500, into: 'cash' },
          { instrument: 'p90', lot: 'condor', dueDate: '2026-03-23', amount: 2_500, into: 'cash' },
          { instrument: 'p95', lot: 'condor', dueDate: '2026-03-23', amount: -5_000, into: 'cash' },
          { instrument: 'p95', lot: 'accept', dueDate: '2026-03-23', amount: -1_000, into: 'cash' },
        ],
        lifecycle: [],
        pnl: { account: { realized: -2_170, commissions: -24.05, unrealized: 0, total: -2_194.05 }, book: { realized: -2_170, commissions: -24.05, unrealized: 0, total: -2_194.05 } },
        nav: { account: 2_315.70, book: 997_805.95 }, // 1,000 + 1,509.75 + 2,000 - 2,194.05
        balance: {
          account: { cash: 5_315.70, receivable: 3_000, payable: 6_000, positions: null, assets: 8_315.70, liabilities: 6_000, netAssets: 2_315.70 },
          book: { cash: 1_000_805.95, receivable: 3_000, payable: 6_000, positions: null, assets: 1_003_805.95, liabilities: 6_000, netAssets: 997_805.95 },
        },
      },
    },
    {
      id: 'cash-settlement', covers: 'settlement', action: 'clock', to: MAR(23),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 2,500.00 USD into settled cash', date: '2026-03-23' },
          { type: 'settlement.receive', summary: 'received 500.00 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 5,000.00 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 1,000.00 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 2_315.70, unsettled: 0, availableToTrade: 2_315.70, availableToWithdraw: 2_315.70 } } },
        pending: [],
        balance: { account: { cash: 2_315.70, receivable: null, payable: null, assets: 2_315.70, liabilities: 0 }, book: { cash: 997_805.95, receivable: null, payable: null, assets: 997_805.95, liabilities: 0 } },
      },
    },
  ],
};

// =====================================================================================================================
// iron_butterfly
// =====================================================================================================================
// Marlow Paper Co. (NYSE) 17 April 2026 options, physical delivery: sell the 50 put and the 50 call (the body), buy the
// 45 put and the 55 call (the wings), 5 each. Each written leg depends on its wing; one side's width is reserved
// (5 x 100 x 5 = 2,500).
//   butterfly  refused short of cash (measured leg by leg), then Treasury funding; the 55 call fills 3 of 5 first and
//              the dependent written 50 call follows it. Held over Good Friday. The stock closes at 47 on 17 April: the
//              written 50 put is assigned (500 shares received at 50, paid T+1), the 45 put and both calls lapse, on the
//              same day. The shares are then sold.
//   retry / accept / unwind  1 of each when the written call has no fresh quote; Accept keeps the other three to expiry
//              (its written put is assigned: 100 shares).
const IFLY_PAGE = (contracts, financing) => ({ template: 'Iron Butterfly', underlying: 'stock', expiration: '2026-04-17', strikes: { 'Lower wing (put bought)': 45, 'Middle strike (call and put sold)': 50, 'Upper wing (call bought)': 55 }, contracts, ...(financing ? { financing } : {}) });
const iflyInput = (contracts, financing) => templateInput('iron_butterfly', { underlyingId: '$inst:stock', options: { expiration: '2026-04-17', strikes: { wingLower: 45, middle: 50, wingUpper: 55 }, contracts }, financing });
const iflyOne = (as) => ({ action: 'package', as, instrument: 'stock', input: iflyInput(1, null), strategyPage: IFLY_PAGE(1, null) });
const ironButterfly = {
  template: 'iron_butterfly',
  title: 'Iron butterfly on Marlow Paper Co. (NYSE): sell the 17 April 2026 50 put and 50 call, buy the 45 put and 55 call',
  matrix: {
    ...OPTION_TEMPLATE_MATRIX,
    settlement: 'Premium of each leg T+1 on the US calendar; Treasury funding moves at once; shares received on assignment T+1 at the strike (settlement.equity = 1)',
    lifecycle: 'Four expiry items settled from the stock close on 17 April 2026 (47: the written put is assigned with a simulated delivery of the shares, the bought put and both calls lapse); held across Good Friday; a failed dependent leg leaves the instance needing attention: Retry, Unwind or Accept; Close and Unwind buy the written legs back first',
    accounting: 'Net credit received; average premium per leg; commission expensed; premium realized on buy-back, sale, assignment (closed at zero) and lapse; shares received carried at the strike and sold',
    collateral: 'Each written leg is covered by its wing: one side\'s width is reserved (2,500), released at expiry; the cash need is measured leg by leg in execution order',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: ['2026-04-03'] },
  book: book('Templates iron butterfly'),
  instruments: {
    stock: stockDraft('Marlow Paper Co.', 'MPC'),
    p45: equityOption('MPC', 'MPC260417P45', 'P', 45, '2026-04-17'),
    p50: equityOption('MPC', 'MPC260417P50', 'P', 50, '2026-04-17'),
    c50: equityOption('MPC', 'MPC260417C50', 'C', 50, '2026-04-17'),
    c55: equityOption('MPC', 'MPC260417C55', 'C', 55, '2026-04-17'),
  },
  quotes: {
    stock: { bid: 49.98, ask: 50.02, last: 50.00, bidSize: 10000, askSize: 10000 },
    p45: { bid: 0.60, ask: 0.70, last: 0.65, bidSize: 20, askSize: 20 },
    p50: { bid: 2.00, ask: 2.10, last: 2.05, bidSize: 20, askSize: 20 },
    c50: { bid: 2.10, ask: 2.20, last: 2.15, bidSize: 20, askSize: 20 },
    c55: { bid: 0.50, ask: 0.60, last: 0.55, bidSize: 20, askSize: 3 }, // only 3 contracts displayed at the ask
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
      // Netted: wings 350 + 300, commission 13, reserve 2,500, against 2,050 of premium and 1,000: 113 short. Leg by leg:
      // 1,000 - 353.25 - 303.25 = 343.50 free; the written put brings 996.75 and needs 2,500: -1,159.75.
      id: 'open-short-of-cash', covers: 'financing', action: 'package', as: 'refused', instrument: 'stock',
      input: iflyInput(5, null), strategyPage: IFLY_PAGE(5, null),
      status: 'blocked', reason: 'The Account cannot fund the package as its legs execute: the preview is blocked until financing is chosen.',
      expect: {
        refused: 'Alpha is short 1,159.75 USD while the legs execute',
        preview: {
          blocking: 1, errors: ['cash'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p45', qty: 5, estimate: 0.70, settleDate: '2026-03-03', cash: -350, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c55', qty: 5, estimate: 0.60, settleDate: '2026-03-03', cash: -300, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'p50', qty: 5, estimate: 2.00, settleDate: '2026-03-03', cash: 1_000, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c50', qty: 5, estimate: 2.10, settleDate: '2026-03-03', cash: 1_050, fees: 3.25, dependsOn: [2] },
          ],
          cash: { USD: { purchases: 650, proceeds: 2_050, fees: 13, reserved: 2_500, required: 3_163, available: 1_000, shortfall: 1_159.75 } },
        },
      },
    },
    {
      id: 'open', covers: ['open', 'financing', 'partial fill', 'dependency'], action: 'package', as: 'butterfly', instrument: 'stock',
      input: iflyInput(5, { mode: 'treasury' }), strategyPage: IFLY_PAGE(5, { mode: 'treasury' }),
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', purpose: 'financing', qty: 1_159.75, cash: 1_159.75, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'p45', qty: 5, estimate: 0.70, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -350, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'buy', instrument: 'c55', qty: 5, estimate: 0.60, settleDate: '2026-03-03', cash: -300, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'p50', qty: 5, estimate: 2.00, settleDate: '2026-03-03', cash: 1_000, fees: 3.25, dependsOn: [2, 1] },
            { kind: 'trade', action: 'sell', instrument: 'c50', qty: 5, estimate: 2.10, settleDate: '2026-03-03', cash: 1_050, fees: 3.25, dependsOn: [3, 1] },
          ],
          cash: { USD: { purchases: 650, proceeds: 2_050, fees: 13, reserved: 2_500, financingIn: 1_159.75, required: 3_163, available: 1_000, shortfall: 0, netCash: 2_546.75 } }, // 2,050 + 1,159.75 - 650 - 13
          netPremium: { amount: -1_400, ccy: 'USD', type: 'credit', complete: true },
          optionRequirement: [{ ccy: 'USD', amount: 2_500, finite: 2_500, naked: 0, uncoveredCallUnits: 0 }],
        },
        result: {
          status: 'partial',
          orders: [
            { kind: 'funding', status: 'filled', filledQty: 1_159.75 },
            { action: 'buy', instrument: 'p45', status: 'filled', filledQty: 5, avgPrice: 0.70 },
            { action: 'buy', instrument: 'c55', status: 'partial', filledQty: 3, avgPrice: 0.60 },
            { action: 'sell', instrument: 'p50', status: 'filled', filledQty: 5, avgPrice: 2.00 },
            { action: 'sell', instrument: 'c50', status: 'partial', filledQty: 3, avgPrice: 2.10 },
          ],
        },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 1,159.75 USD from Treasury to Alpha' },
          { type: 'trade.fill', summary: 'Bought 5 MPC260417P45 @ 0.70 USD', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Bought 3 MPC260417C55 @ 0.60 USD' },
          { type: 'trade.fill', summary: 'Sold 5 MPC260417P50 @ 2.00 USD' },
          { type: 'trade.fill', summary: 'Sold 3 MPC260417C50 @ 2.10 USD' },
          { type: 'trade.fill', summary: 'Bought 2 MPC260417C55 @ 0.60 USD' },
          { type: 'trade.fill', summary: 'Sold 2 MPC260417C50 @ 2.10 USD' },
        ],
        cash: {
          // owed 353.25 + 181.95 + 121.30 = 656.50; owed to it 996.75 + 628.05 + 418.70 = 2,043.50; reserved 2,500
          account: { USD: { settled: 2_159.75, unsettled: 1_387, reserved: 2_500, availableToTrade: 1_046.75, availableToWithdraw: -996.75 } },
          treasury: { USD: { settled: 997_840.25, unsettled: 0, availableToTrade: 997_840.25, availableToWithdraw: 997_840.25 } },
        },
        positions: [
          { instrument: 'c50', lot: 'butterfly', owner: 'account', direction: 'short', qty: -5, avgCost: 2.10, cost: -1_050, price: 2.15, value: -1_075, unrealized: -25 },
          { instrument: 'c55', lot: 'butterfly', owner: 'account', direction: 'long', qty: 5, avgCost: 0.60, cost: 300, price: 0.55, value: 275, unrealized: -25 },
          { instrument: 'p45', lot: 'butterfly', owner: 'account', direction: 'long', qty: 5, avgCost: 0.70, cost: 350, price: 0.65, value: 325, unrealized: -25 },
          { instrument: 'p50', lot: 'butterfly', owner: 'account', direction: 'short', qty: -5, avgCost: 2.00, cost: -1_000, price: 2.05, value: -1_025, unrealized: -25 },
        ],
        holdings: { c50: { long: 0, short: 5, net: -5 }, c55: { long: 5, short: 0, net: 5 }, p45: { long: 5, short: 0, net: 5 }, p50: { long: 0, short: 5, net: -5 } },
        pending: [
          { instrument: 'c50', lot: 'butterfly', dueDate: '2026-03-03', amount: 418.70, into: 'cash' },
          { instrument: 'c50', lot: 'butterfly', dueDate: '2026-03-03', amount: 628.05, into: 'cash' },
          { instrument: 'c55', lot: 'butterfly', dueDate: '2026-03-03', amount: -181.95, into: 'cash' },
          { instrument: 'c55', lot: 'butterfly', dueDate: '2026-03-03', amount: -121.30, into: 'cash' },
          { instrument: 'p45', lot: 'butterfly', dueDate: '2026-03-03', amount: -353.25, into: 'cash' },
          { instrument: 'p50', lot: 'butterfly', dueDate: '2026-03-03', amount: 996.75, into: 'cash' },
        ],
        lifecycle: [
          { type: 'option.expiry', instrument: 'c50', dueDate: '2026-04-17', status: 'pending' },
          { type: 'option.expiry', instrument: 'c55', dueDate: '2026-04-17', status: 'pending' },
          { type: 'option.expiry', instrument: 'p45', dueDate: '2026-04-17', status: 'pending' },
          { type: 'option.expiry', instrument: 'p50', dueDate: '2026-04-17', status: 'pending' },
        ],
        pnl: {
          account: { realized: 0, commissions: -13, fees: 0, unrealized: -100, total: -113 },
          book: { realized: 0, commissions: -13, unrealized: -100, total: -113 },
          treasury: { total: 0 },
        },
        nav: { account: 2_046.75, treasury: 997_840.25, book: 999_887 },
        balance: {
          account: { cash: 2_159.75, receivable: 2_043.50, payable: 656.50, positions: -1_500, assets: 2_703.25, liabilities: 656.50, netAssets: 2_046.75 },
          treasury: { cash: 997_840.25, assets: 997_840.25, liabilities: 0, netAssets: 997_840.25 },
          book: { cash: 1_000_000, receivable: 2_043.50, payable: 656.50, positions: -1_500, assets: 1_000_543.50, liabilities: 656.50, netAssets: 999_887 },
        },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR(3),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 996.75 USD into settled cash', date: '2026-03-03' },
          { type: 'settlement.receive', summary: 'received 628.05 USD into settled cash' },
          { type: 'settlement.receive', summary: 'received 418.70 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 353.25 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 181.95 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 121.30 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 3_546.75, unsettled: 0, availableToTrade: 1_046.75, availableToWithdraw: 1_046.75 } } },
        pending: [],
        balance: { account: { cash: 3_546.75, receivable: null, payable: null, assets: 2_046.75, liabilities: 0 }, book: { cash: 1_001_387, receivable: null, payable: null, assets: 999_887, liabilities: 0 } },
      },
    },
    {
      id: 'fund-account', covers: 'internal funding', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 2_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 2,000.00 USD from Treasury to Alpha' }],
        cash: { account: { USD: { settled: 5_546.75, availableToTrade: 3_046.75, availableToWithdraw: 3_046.75 } }, treasury: { USD: { settled: 995_840.25, availableToTrade: 995_840.25, availableToWithdraw: 995_840.25 } } },
        nav: { account: 4_046.75, treasury: 995_840.25 },
        balance: { account: { cash: 5_546.75, assets: 4_046.75, netAssets: 4_046.75 }, treasury: { cash: 995_840.25, assets: 995_840.25, netAssets: 995_840.25 } },
      },
    },
    { id: 'c50-quote-stops', action: 'quote', instrument: 'c50', quote: { bid: 2.10, ask: 2.20, last: 2.15, bidSize: 20, askSize: 20, asOf: MAR(3, '09:50') }, expect: {} },
    {
      // 1 of each: wings 70 + 60, body 200 + 215 (the call estimated at its last 2.15), 2.60 commission, 500 reserved.
      ...iflyOne('retry'), id: 'open-retry', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p45', qty: 1, estimate: 0.70, settleDate: '2026-03-04', cash: -70, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c55', qty: 1, estimate: 0.60, settleDate: '2026-03-04', cash: -60, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'p50', qty: 1, estimate: 2.00, settleDate: '2026-03-04', cash: 200, fees: 0.65, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c50', qty: 1, estimate: null, reference: 2.15, executable: false, settleDate: '2026-03-04', cash: 215, fees: 0.65, dependsOn: [2] },
          ],
          cash: { USD: { purchases: 130, proceeds: 415, fees: 2.60, reserved: 500, required: 632.60, available: 3_046.75, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ instrument: 'p45', status: 'filled' }, { instrument: 'c55', status: 'filled' }, { instrument: 'p50', status: 'filled' }, { instrument: 'c50', status: 'working', filledQty: 0 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Bought 1 MPC260417P45 @ 0.70 USD', date: '2026-03-03' },
          { type: 'trade.fill', summary: 'Bought 1 MPC260417C55 @ 0.60 USD' },
          { type: 'trade.fill', summary: 'Sold 1 MPC260417P50 @ 2.00 USD' },
        ],
        cash: { account: { USD: { settled: 5_546.75, unsettled: 68.05, reserved: 3_000, availableToTrade: 2_614.80, availableToWithdraw: 2_415.45 } } }, // -70.65 - 60.65 + 199.35
        positions: [
          { instrument: 'c50', lot: 'butterfly', value: -1_075 },
          { instrument: 'c55', lot: 'butterfly', value: 275 },
          { instrument: 'c55', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 0.60, cost: 60, price: 0.55, value: 55, unrealized: -5 },
          { instrument: 'p45', lot: 'butterfly', value: 325 },
          { instrument: 'p45', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 0.70, cost: 70, price: 0.65, value: 65, unrealized: -5 },
          { instrument: 'p50', lot: 'butterfly', value: -1_025 },
          { instrument: 'p50', lot: 'retry', owner: 'account', direction: 'short', qty: -1, avgCost: 2.00, cost: -200, price: 2.05, value: -205, unrealized: -5 },
        ],
        holdings: { c55: { long: 6, short: 0, net: 6 }, p45: { long: 6, short: 0, net: 6 }, p50: { long: 0, short: 6, net: -6 } },
        pending: [
          { instrument: 'c55', lot: 'retry', dueDate: '2026-03-04', amount: -60.65 },
          { instrument: 'p45', lot: 'retry', dueDate: '2026-03-04', amount: -70.65 },
          { instrument: 'p50', lot: 'retry', dueDate: '2026-03-04', amount: 199.35 },
        ],
        openOrders: [{ instrument: 'c50', kind: 'trade', action: 'sell', status: 'working', qty: 1, filledQty: 0 }],
        lifecycle: [{ instrument: 'c50' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p50' }, { instrument: 'p50' }],
        pnl: { account: { commissions: -14.95, unrealized: -115, total: -129.95 }, book: { commissions: -14.95, unrealized: -115, total: -129.95 } },
        nav: { account: 4_029.80, book: 999_870.05 },
        balance: {
          account: { cash: 5_546.75, receivable: 199.35, payable: 131.30, positions: -1_585, assets: 4_161.10, liabilities: 131.30, netAssets: 4_029.80 },
          book: { cash: 1_001_387, receivable: 199.35, payable: 131.30, positions: -1_585, assets: 1_000_001.35, liabilities: 131.30, netAssets: 999_870.05 },
        },
      },
    },
    {
      ...iflyOne('accept'), id: 'open-accept', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'p45' }, { instrument: 'c55' }, { instrument: 'p50', dependsOn: [1] }, { instrument: 'c50', estimate: null, dependsOn: [2] }], cash: { USD: { required: 632.60, available: 2_614.80, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ status: 'filled' }, { status: 'filled' }, { status: 'filled' }, { instrument: 'c50', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill' }, { type: 'trade.fill' }, { type: 'trade.fill' }],
        cash: { account: { USD: { settled: 5_546.75, unsettled: 136.10, reserved: 3_500, availableToTrade: 2_182.85, availableToWithdraw: 1_784.15 } } },
        positions: [
          { instrument: 'c50', lot: 'butterfly' },
          { instrument: 'c55', lot: 'accept', value: 55 }, { instrument: 'c55', lot: 'butterfly' }, { instrument: 'c55', lot: 'retry' },
          { instrument: 'p45', lot: 'accept', value: 65 }, { instrument: 'p45', lot: 'butterfly' }, { instrument: 'p45', lot: 'retry' },
          { instrument: 'p50', lot: 'accept', value: -205 }, { instrument: 'p50', lot: 'butterfly' }, { instrument: 'p50', lot: 'retry' },
        ],
        holdings: { c55: { long: 7, short: 0, net: 7 }, p45: { long: 7, short: 0, net: 7 }, p50: { long: 0, short: 7, net: -7 } },
        pending: [
          { instrument: 'c55', lot: 'accept' }, { instrument: 'c55', lot: 'retry' },
          { instrument: 'p45', lot: 'accept' }, { instrument: 'p45', lot: 'retry' },
          { instrument: 'p50', lot: 'accept' }, { instrument: 'p50', lot: 'retry' },
        ],
        openOrders: [{ instrument: 'c50', status: 'working' }, { instrument: 'c50', status: 'working' }],
        lifecycle: [{ instrument: 'c50' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p50' }, { instrument: 'p50' }, { instrument: 'p50' }],
        pnl: { account: { commissions: -16.90, unrealized: -130, total: -146.90 }, book: { commissions: -16.90, unrealized: -130, total: -146.90 } },
        nav: { account: 4_012.85, book: 999_853.10 },
        balance: {
          account: { cash: 5_546.75, receivable: 398.70, payable: 262.60, positions: -1_670, assets: 4_275.45, liabilities: 262.60, netAssets: 4_012.85 },
          book: { cash: 1_001_387, receivable: 398.70, payable: 262.60, positions: -1_670, assets: 1_000_115.70, liabilities: 262.60, netAssets: 999_853.10 },
        },
      },
    },
    {
      ...iflyOne('unwind'), id: 'open-unwind', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'p45' }, { instrument: 'c55' }, { instrument: 'p50' }, { instrument: 'c50', estimate: null }], cash: { USD: { required: 632.60, available: 2_182.85, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ status: 'filled' }, { status: 'filled' }, { status: 'filled' }, { instrument: 'c50', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill' }, { type: 'trade.fill' }, { type: 'trade.fill' }],
        cash: { account: { USD: { settled: 5_546.75, unsettled: 204.15, reserved: 4_000, availableToTrade: 1_750.90, availableToWithdraw: 1_152.85 } } },
        positions: [
          { instrument: 'c50', lot: 'butterfly' },
          { instrument: 'c55', lot: 'accept' }, { instrument: 'c55', lot: 'butterfly' }, { instrument: 'c55', lot: 'retry' }, { instrument: 'c55', lot: 'unwind', value: 55 },
          { instrument: 'p45', lot: 'accept' }, { instrument: 'p45', lot: 'butterfly' }, { instrument: 'p45', lot: 'retry' }, { instrument: 'p45', lot: 'unwind', value: 65 },
          { instrument: 'p50', lot: 'accept' }, { instrument: 'p50', lot: 'butterfly' }, { instrument: 'p50', lot: 'retry' }, { instrument: 'p50', lot: 'unwind', value: -205 },
        ],
        holdings: { c55: { long: 8, short: 0, net: 8 }, p45: { long: 8, short: 0, net: 8 }, p50: { long: 0, short: 8, net: -8 } },
        pending: [
          { instrument: 'c55', lot: 'accept' }, { instrument: 'c55', lot: 'retry' }, { instrument: 'c55', lot: 'unwind', amount: -60.65 },
          { instrument: 'p45', lot: 'accept' }, { instrument: 'p45', lot: 'retry' }, { instrument: 'p45', lot: 'unwind', amount: -70.65 },
          { instrument: 'p50', lot: 'accept' }, { instrument: 'p50', lot: 'retry' }, { instrument: 'p50', lot: 'unwind', amount: 199.35 },
        ],
        openOrders: [{ instrument: 'c50', status: 'working' }, { instrument: 'c50', status: 'working' }, { instrument: 'c50', status: 'working' }],
        lifecycle: [{ instrument: 'c50' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p50' }, { instrument: 'p50' }, { instrument: 'p50' }, { instrument: 'p50' }],
        pnl: { account: { commissions: -18.85, unrealized: -145, total: -163.85 }, book: { commissions: -18.85, unrealized: -145, total: -163.85 } },
        nav: { account: 3_995.90, book: 999_836.15 },
        balance: {
          account: { cash: 5_546.75, receivable: 598.05, payable: 393.90, positions: -1_755, assets: 4_389.80, liabilities: 393.90, netAssets: 3_995.90 },
          book: { cash: 1_001_387, receivable: 598.05, payable: 393.90, positions: -1_755, assets: 1_000_230.05, liabilities: 393.90, netAssets: 999_836.15 },
        },
      },
    },
    {
      id: 'call-legs-expire', covers: ['failed dependent leg', 'settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 199.35 USD into settled cash', date: '2026-03-04' },
          { type: 'settlement.receive', summary: 'received 199.35 USD into settled cash' },
          { type: 'settlement.receive', summary: 'received 199.35 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 70.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 60.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 70.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 60.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 70.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 60.65 USD from settled cash' },
          { type: 'order.expired', summary: 'Leg 4 expired: sell 1 MPC260417C50. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 4 expired: sell 1 MPC260417C50. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 4 expired: sell 1 MPC260417C50. Day order did not fill before the end of the business day' },
        ],
        cash: { account: { USD: { settled: 5_750.90, unsettled: 0, availableToTrade: 1_750.90, availableToWithdraw: 1_750.90 } } },
        pending: [], openOrders: [],
        failed: { orders: 3 },
        alerts: ['strategy.attention', 'strategy.attention', 'strategy.attention'],
        balance: { account: { cash: 5_750.90, receivable: null, payable: null, assets: 3_995.90, liabilities: 0 }, book: { cash: 1_001_591.15, receivable: null, payable: null, assets: 999_836.15, liabilities: 0 } },
      },
    },
    {
      id: 'c50-quote-day3', action: 'quote', instrument: 'c50', quote: { bid: 1.90, ask: 2.00, last: 1.95, bidSize: 20, askSize: 20 },
      expect: {
        positions: [
          { instrument: 'c50', lot: 'butterfly', price: 1.95, value: -975, unrealized: 75 }, // -5 x 1.95 x 100 + 1,050
          { instrument: 'c55', lot: 'accept' }, { instrument: 'c55', lot: 'butterfly' }, { instrument: 'c55', lot: 'retry' }, { instrument: 'c55', lot: 'unwind' },
          { instrument: 'p45', lot: 'accept' }, { instrument: 'p45', lot: 'butterfly' }, { instrument: 'p45', lot: 'retry' }, { instrument: 'p45', lot: 'unwind' },
          { instrument: 'p50', lot: 'accept' }, { instrument: 'p50', lot: 'butterfly' }, { instrument: 'p50', lot: 'retry' }, { instrument: 'p50', lot: 'unwind' },
        ],
        pnl: { account: { unrealized: -45, total: -63.85 }, book: { unrealized: -45, total: -63.85 } },
        nav: { account: 4_095.90, book: 999_936.15 },
        balance: { account: { positions: -1_655, assets: 4_095.90, netAssets: 4_095.90 }, book: { positions: -1_655, assets: 999_936.15, netAssets: 999_936.15 } },
      },
    },
    {
      id: 'retry', covers: ['retry', 'failed dependent leg'], action: 'recover', how: 'retry', lot: 'retry',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'retry', legs: [{ kind: 'trade', action: 'sell', instrument: 'c50', qty: 1, estimate: 1.90, settleDate: '2026-03-05', cash: 190, fees: 0.65 }], cash: { USD: { proceeds: 190, fees: 0.65, reserved: 0, required: 0.65, available: 1_750.90, shortfall: 0 } }, optionRequirement: [{ ccy: 'USD', amount: 500, finite: 500, naked: 0, uncoveredCallUnits: 0 }] },
        result: { status: 'open', complete: true, orders: [{ action: 'sell', instrument: 'c50', status: 'filled', filledQty: 1, avgPrice: 1.90 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 MPC260417C50 @ 1.90 USD', date: '2026-03-04' }],
        cash: { account: { USD: { settled: 5_750.90, unsettled: 189.35, reserved: 4_000, availableToTrade: 1_940.25, availableToWithdraw: 1_750.90 } } },
        positions: [
          { instrument: 'c50', lot: 'butterfly', value: -975 }, { instrument: 'c50', lot: 'retry', owner: 'account', direction: 'short', qty: -1, avgCost: 1.90, cost: -190, price: 1.95, value: -195, unrealized: -5 },
          { instrument: 'c55', lot: 'accept' }, { instrument: 'c55', lot: 'butterfly' }, { instrument: 'c55', lot: 'retry' }, { instrument: 'c55', lot: 'unwind' },
          { instrument: 'p45', lot: 'accept' }, { instrument: 'p45', lot: 'butterfly' }, { instrument: 'p45', lot: 'retry' }, { instrument: 'p45', lot: 'unwind' },
          { instrument: 'p50', lot: 'accept' }, { instrument: 'p50', lot: 'butterfly' }, { instrument: 'p50', lot: 'retry' }, { instrument: 'p50', lot: 'unwind' },
        ],
        holdings: { c50: { long: 0, short: 6, net: -6 } },
        pending: [{ instrument: 'c50', lot: 'retry', dueDate: '2026-03-05', amount: 189.35 }],
        lifecycle: [{ instrument: 'c50' }, { instrument: 'c50' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p50' }, { instrument: 'p50' }, { instrument: 'p50' }, { instrument: 'p50' }],
        alerts: ['strategy.attention', 'strategy.attention'],
        pnl: { account: { commissions: -19.50, unrealized: -50, total: -69.50 }, book: { commissions: -19.50, unrealized: -50, total: -69.50 } },
        nav: { account: 4_090.25, book: 999_930.50 },
        balance: {
          account: { cash: 5_750.90, receivable: 189.35, positions: -1_850, assets: 4_090.25, liabilities: 0, netAssets: 4_090.25 },
          book: { cash: 1_001_591.15, receivable: 189.35, positions: -1_850, assets: 999_930.50, netAssets: 999_930.50 },
        },
      },
    },
    {
      id: 'accept', covers: ['accept', 'failed dependent leg'], action: 'strategy_action', lot: 'accept', how: 'accept',
      expect: { events: [{ type: 'strategy.accepted', summary: 'accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: ['strategy.attention'] },
    },
    {
      // Unwind: the written 50 put is bought back first at 2.10; the wings are sold after it at 0.60 and 0.50. -10 each.
      id: 'unwind', covers: ['unwind', 'close', 'dependency'], action: 'recover', how: 'unwind', lot: 'unwind',
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'unwind',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p50', qty: 1, estimate: 2.10, settleDate: '2026-03-05', cash: -210, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'p45', qty: 1, estimate: 0.60, settleDate: '2026-03-05', cash: 60, fees: 0.65, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c55', qty: 1, estimate: 0.50, settleDate: '2026-03-05', cash: 50, fees: 0.65, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 210, proceeds: 110, fees: 1.95, reserved: 0, required: 211.95, available: 1_940.25, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ action: 'buy', instrument: 'p50', status: 'filled' }, { action: 'sell', instrument: 'p45', status: 'filled' }, { action: 'sell', instrument: 'c55', status: 'filled' }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 1 MPC260417P50 @ 2.10 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 MPC260417P45 @ 0.60 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 MPC260417C55 @ 0.50 USD (realized -10.00 USD)' },
        ],
        cash: { account: { USD: { settled: 5_750.90, unsettled: 87.40, reserved: 3_500, availableToTrade: 2_338.30, availableToWithdraw: 2_040.25 } } }, // 189.35 - 210.65 + 59.35 + 49.35
        positions: [
          { instrument: 'c50', lot: 'butterfly' }, { instrument: 'c50', lot: 'retry' },
          { instrument: 'c55', lot: 'accept' }, { instrument: 'c55', lot: 'butterfly' }, { instrument: 'c55', lot: 'retry' },
          { instrument: 'p45', lot: 'accept' }, { instrument: 'p45', lot: 'butterfly' }, { instrument: 'p45', lot: 'retry' },
          { instrument: 'p50', lot: 'accept' }, { instrument: 'p50', lot: 'butterfly' }, { instrument: 'p50', lot: 'retry' },
        ],
        holdings: { c55: { long: 7, short: 0, net: 7 }, p45: { long: 7, short: 0, net: 7 }, p50: { long: 0, short: 7, net: -7 } },
        pending: [
          { instrument: 'c50', lot: 'retry', amount: 189.35 },
          { instrument: 'c55', lot: 'unwind', dueDate: '2026-03-05', amount: 49.35 },
          { instrument: 'p45', lot: 'unwind', dueDate: '2026-03-05', amount: 59.35 },
          { instrument: 'p50', lot: 'unwind', dueDate: '2026-03-05', amount: -210.65 },
        ],
        lifecycle: [{ instrument: 'c50' }, { instrument: 'c50' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p50' }, { instrument: 'p50' }, { instrument: 'p50' }],
        alerts: [],
        pnl: { account: { realized: -30, commissions: -21.45, unrealized: -35, total: -86.45 }, book: { realized: -30, commissions: -21.45, unrealized: -35, total: -86.45 } },
        nav: { account: 4_073.30, book: 999_913.55 },
        balance: {
          account: { cash: 5_750.90, receivable: 298.05, payable: 210.65, positions: -1_765, assets: 4_283.95, liabilities: 210.65, netAssets: 4_073.30 },
          book: { cash: 1_001_591.15, receivable: 298.05, payable: 210.65, positions: -1_765, assets: 1_000_124.20, liabilities: 210.65, netAssets: 999_913.55 },
        },
      },
    },
    {
      id: 'settle-recovery', covers: 'settlement', action: 'clock', to: MAR(5),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 189.35 USD into settled cash', date: '2026-03-05' },
          { type: 'settlement.receive', summary: 'received 59.35 USD into settled cash' },
          { type: 'settlement.receive', summary: 'received 49.35 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 210.65 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 5_838.30, unsettled: 0, availableToTrade: 2_338.30, availableToWithdraw: 2_338.30 } } },
        pending: [],
        balance: { account: { cash: 5_838.30, receivable: null, payable: null, assets: 4_073.30, liabilities: 0 }, book: { cash: 1_001_678.55, receivable: null, payable: null, assets: 999_913.55, liabilities: 0 } },
      },
    },
    {
      id: 'close-retry', covers: ['close', 'dependency'], action: 'close', lot: 'retry', instrument: 'p45', scope: 'strategy', percent: 100,
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'close',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'p50', qty: 1, estimate: 2.10, settleDate: '2026-03-06', cash: -210, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c50', qty: 1, estimate: 2.00, settleDate: '2026-03-06', cash: -200, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'p45', qty: 1, estimate: 0.60, settleDate: '2026-03-06', cash: 60, fees: 0.65, dependsOn: [1, 2] },
            { kind: 'trade', action: 'sell', instrument: 'c55', qty: 1, estimate: 0.50, settleDate: '2026-03-06', cash: 50, fees: 0.65, dependsOn: [1, 2] },
          ],
          cash: { USD: { purchases: 410, proceeds: 110, fees: 2.60, reserved: 0, required: 412.60, available: 2_338.30, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ instrument: 'p50', status: 'filled' }, { instrument: 'c50', status: 'filled' }, { instrument: 'p45', status: 'filled' }, { instrument: 'c55', status: 'filled' }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 1 MPC260417P50 @ 2.10 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Bought 1 MPC260417C50 @ 2.00 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 MPC260417P45 @ 0.60 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 MPC260417C55 @ 0.50 USD (realized -10.00 USD)' },
        ],
        cash: { account: { USD: { settled: 5_838.30, unsettled: -302.60, reserved: 3_000, availableToTrade: 2_535.70, availableToWithdraw: 2_427 } } },
        positions: [
          { instrument: 'c50', lot: 'butterfly', value: -975 },
          { instrument: 'c55', lot: 'accept', value: 55 }, { instrument: 'c55', lot: 'butterfly', value: 275 },
          { instrument: 'p45', lot: 'accept', value: 65 }, { instrument: 'p45', lot: 'butterfly', value: 325 },
          { instrument: 'p50', lot: 'accept', value: -205 }, { instrument: 'p50', lot: 'butterfly', value: -1_025 },
        ],
        holdings: { c50: { long: 0, short: 5, net: -5 }, c55: { long: 6, short: 0, net: 6 }, p45: { long: 6, short: 0, net: 6 }, p50: { long: 0, short: 6, net: -6 } },
        pending: [
          { instrument: 'c50', lot: 'retry', dueDate: '2026-03-06', amount: -200.65 },
          { instrument: 'c55', lot: 'retry', dueDate: '2026-03-06', amount: 49.35 },
          { instrument: 'p45', lot: 'retry', dueDate: '2026-03-06', amount: 59.35 },
          { instrument: 'p50', lot: 'retry', dueDate: '2026-03-06', amount: -210.65 },
        ],
        lifecycle: [{ instrument: 'c50' }, { instrument: 'c55' }, { instrument: 'c55' }, { instrument: 'p45' }, { instrument: 'p45' }, { instrument: 'p50' }, { instrument: 'p50' }],
        pnl: { account: { realized: -70, commissions: -24.05, unrealized: -15, total: -109.05 }, book: { realized: -70, commissions: -24.05, unrealized: -15, total: -109.05 } },
        nav: { account: 4_050.70, book: 999_890.95 },
        balance: {
          account: { cash: 5_838.30, receivable: 108.70, payable: 411.30, positions: -1_485, assets: 4_462, liabilities: 411.30, netAssets: 4_050.70 },
          book: { cash: 1_001_678.55, receivable: 108.70, payable: 411.30, positions: -1_485, assets: 1_000_302.25, liabilities: 411.30, netAssets: 999_890.95 },
        },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MAR(6),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 59.35 USD into settled cash', date: '2026-03-06' },
          { type: 'settlement.receive', summary: 'received 49.35 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 210.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 200.65 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 5_535.70, unsettled: 0, availableToTrade: 2_535.70, availableToWithdraw: 2_535.70 } } },
        pending: [],
        balance: { account: { cash: 5_535.70, receivable: null, payable: null, assets: 4_050.70, liabilities: 0 }, book: { cash: 1_001_375.95, receivable: null, payable: null, assets: 999_890.95, liabilities: 0 } },
      },
    },
    {
      // Cash for the shares an assignment of the written puts would deliver at 50.
      id: 'fund-for-delivery', covers: 'internal funding', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 30_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 30,000.00 USD from Treasury to Alpha' }],
        cash: { account: { USD: { settled: 35_535.70, availableToTrade: 32_535.70, availableToWithdraw: 32_535.70 } }, treasury: { USD: { settled: 965_840.25, availableToTrade: 965_840.25, availableToWithdraw: 965_840.25 } } },
        nav: { account: 34_050.70, treasury: 965_840.25 },
        balance: { account: { cash: 35_535.70, assets: 34_050.70, netAssets: 34_050.70 }, treasury: { cash: 965_840.25, assets: 965_840.25, netAssets: 965_840.25 } },
      },
    },
    { id: 'stock-quote', action: 'quote', instrument: 'stock', quote: { bid: 46.98, ask: 47.02, last: 47.00, bidSize: 10000, askSize: 10000 }, expect: {} }, // no shares held yet
    { id: 'expiry-close', action: 'close_price', instrument: 'stock', date: '2026-04-17', value: 47.00, expect: {} },
    {
      // Held across Good Friday. 17 April, close 47: the written 50 puts are assigned (closed at zero: their premium is
      // realized, +1,000 and +200), 500 and 100 shares received at 50 (25,000 and 5,000, due 20 April); the 45 puts lapse
      // (-350, -70), the written 50 calls lapse (+1,050), the 55 calls lapse (-300, -60). Realized -70 + 1,400 + 70 = 1,400.
      // The shares are worth 600 x 47 = 28,200 against 30,000.
      id: 'expiry', covers: ['expiry', 'assignment', 'holiday'], action: 'clock', to: APR(17, '17:30'),
      expect: {
        events: [
          { type: 'option.expired', summary: 'Expired worthless: 5 MPC260417P45 (fixing 47)', date: '2026-04-17' },
          { type: 'option.expired', summary: 'Expired worthless: 5 MPC260417C55 (fixing 47)' },
          { type: 'option.assigned', summary: 'Assigned: 5 MPC260417P50 at strike 50' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 500 MPC at strike 50 on assignment of MPC260417P50/ },
          { type: 'option.expired', summary: 'Expired worthless: 5 MPC260417C50 (fixing 47)' },
          { type: 'option.expired', summary: 'Expired worthless: 1 MPC260417P45 (fixing 47)' },
          { type: 'option.expired', summary: 'Expired worthless: 1 MPC260417C55 (fixing 47)' },
          { type: 'option.assigned', summary: 'Assigned: 1 MPC260417P50 at strike 50' },
          { type: 'option.delivery', summary: /^Simulated delivery: received 100 MPC at strike 50 on assignment of MPC260417P50/ },
        ],
        cash: { account: { USD: { settled: 35_535.70, unsettled: -30_000, reserved: 0, availableToTrade: 5_535.70, availableToWithdraw: 5_535.70 } } },
        positions: [
          { instrument: 'stock', lot: 'accept', owner: 'account', direction: 'long', qty: 100, avgCost: 50, cost: 5_000, price: 47, value: 4_700, unrealized: -300 },
          { instrument: 'stock', lot: 'butterfly', owner: 'account', direction: 'long', qty: 500, avgCost: 50, cost: 25_000, price: 47, value: 23_500, unrealized: -1_500 },
        ],
        holdings: { c50: null, c55: null, p45: null, p50: null, stock: { long: 600, short: 0, net: 600 } },
        pending: [{ instrument: 'stock', lot: 'butterfly', dueDate: '2026-04-20', amount: -25_000, into: 'cash' }, { instrument: 'stock', lot: 'accept', dueDate: '2026-04-20', amount: -5_000, into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: 1_400, commissions: -24.05, unrealized: -1_800, total: -424.05 }, book: { realized: 1_400, commissions: -24.05, unrealized: -1_800, total: -424.05 } },
        nav: { account: 33_735.70, book: 999_575.95 }, // 35,535.70 - 30,000 + 28,200
        balance: {
          account: { cash: 35_535.70, payable: 30_000, positions: 28_200, assets: 63_735.70, liabilities: 30_000, netAssets: 33_735.70 },
          book: { cash: 1_001_375.95, payable: 30_000, positions: 28_200, assets: 1_029_575.95, liabilities: 30_000, netAssets: 999_575.95 },
        },
      },
    },
    {
      id: 'settle-delivery', covers: 'settlement', action: 'clock', to: APR(20),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 25,000.00 USD from settled cash', date: '2026-04-20' }, { type: 'settlement.pay', summary: 'paid 5,000.00 USD from settled cash' }],
        cash: { account: { USD: { settled: 5_535.70, unsettled: 0, availableToTrade: 5_535.70, availableToWithdraw: 5_535.70 } } },
        pending: [],
        balance: { account: { cash: 5_535.70, payable: null, assets: 33_735.70, liabilities: 0 }, book: { cash: 971_375.95, payable: null, assets: 999_575.95, liabilities: 0 } },
      },
    },
    {
      // 500 shares at the bid 46.98 = 23,490; commission 2.50. Realized 500 x (46.98 - 50) = -1,510.
      id: 'close-butterfly', covers: ['close'], action: 'close', lot: 'butterfly', instrument: 'stock', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], intent: 'close', legs: [{ kind: 'trade', action: 'sell', instrument: 'stock', qty: 500, estimate: 46.98, settleDate: '2026-04-21', cash: 23_490, fees: 2.50 }] },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'stock', status: 'filled', filledQty: 500, avgPrice: 46.98 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 500 MPC @ 46.98 USD (realized -1,510.00 USD)', date: '2026-04-20' }],
        cash: { account: { USD: { settled: 5_535.70, unsettled: 23_487.50, availableToTrade: 29_023.20, availableToWithdraw: 5_535.70 } } },
        positions: [{ instrument: 'stock', lot: 'accept', qty: 100, value: 4_700, unrealized: -300 }],
        holdings: { stock: { long: 100, short: 0, net: 100 } },
        pending: [{ instrument: 'stock', lot: 'butterfly', dueDate: '2026-04-21', amount: 23_487.50, into: 'cash' }],
        pnl: { account: { realized: -110, commissions: -26.55, unrealized: -300, total: -436.55 }, book: { realized: -110, commissions: -26.55, unrealized: -300, total: -436.55 } },
        nav: { account: 33_723.20, book: 999_563.45 },
        balance: {
          account: { cash: 5_535.70, receivable: 23_487.50, positions: 4_700, assets: 33_723.20, liabilities: 0, netAssets: 33_723.20 },
          book: { cash: 971_375.95, receivable: 23_487.50, positions: 4_700, assets: 999_563.45, netAssets: 999_563.45 },
        },
      },
    },
    {
      // 100 shares at 46.98 = 4,698; commission 0.50, raised to the 1.00 minimum. Realized -302.
      id: 'close-accept', covers: ['close'], action: 'close', lot: 'accept', instrument: 'stock', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', instrument: 'stock', qty: 100, estimate: 46.98, settleDate: '2026-04-21', cash: 4_698, fees: 1 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 100, avgPrice: 46.98 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 100 MPC @ 46.98 USD (realized -302.00 USD)' }],
        cash: { account: { USD: { settled: 5_535.70, unsettled: 28_184.50, availableToTrade: 33_720.20, availableToWithdraw: 5_535.70 } } },
        positions: [],
        holdings: { stock: null },
        pending: [{ instrument: 'stock', lot: 'accept', dueDate: '2026-04-21', amount: 4_697 }, { instrument: 'stock', lot: 'butterfly', dueDate: '2026-04-21', amount: 23_487.50 }],
        pnl: { account: { realized: -412, commissions: -27.55, unrealized: 0, total: -439.55 }, book: { realized: -412, commissions: -27.55, unrealized: 0, total: -439.55 } },
        nav: { account: 33_720.20, book: 999_560.45 },
        balance: {
          account: { cash: 5_535.70, receivable: 28_184.50, positions: null, assets: 33_720.20, netAssets: 33_720.20 },
          book: { cash: 971_375.95, receivable: 28_184.50, positions: null, assets: 999_560.45, netAssets: 999_560.45 },
        },
      },
    },
    {
      // Nothing left: 1,000 + 1,159.75 + 2,000 + 30,000 funded, less 439.55.
      id: 'settle-final', covers: 'settlement', action: 'clock', to: APR(21),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 23,487.50 USD into settled cash', date: '2026-04-21' }, { type: 'settlement.receive', summary: 'received 4,697.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 33_720.20, unsettled: 0, reserved: 0, availableToTrade: 33_720.20, availableToWithdraw: 33_720.20 } } },
        pending: [],
        balance: { account: { cash: 33_720.20, receivable: null, assets: 33_720.20 }, book: { cash: 999_560.45, receivable: null, assets: 999_560.45 } },
      },
    },
  ],
};

// =====================================================================================================================
// long_butterfly
// =====================================================================================================================
// Corrin 50 Index calls (Cboe, European, cash-settled at 100 x the index), 20 March 2026: buy one 100 call, sell two 105
// calls, buy one 110 call, 5 butterflies. The written 105s depend on both bought legs and are covered by them: nothing
// is reserved (the package cannot lose more than its debit). Netted, the Account could pay; but both bought legs execute
// before the written calls bring their premium, so the package is short leg by leg and needs funding.
//   butterfly  refused (short while the legs execute), then Treasury funding; the 100 calls fill 3 of 5 first, and the
//              written 105s follow the share of the two legs they depend on (6 of 10), then the rest. The index fixes
//              at 107: the bought 100s (outer) and the written 105s (inner) are settled in cash, the 110s lapse.
//   retry / accept / unwind  1 butterfly each when the written calls have no fresh quote.
const LFLY_PAGE = (contracts, financing) => ({ template: 'Long Call or Put Butterfly', underlying: 'index', expiration: '2026-03-20', right: 'C', strikes: { 'Lower strike (bought)': 100, 'Middle strike (two sold)': 105, 'Upper strike (bought)': 110 }, contracts, ...(financing ? { financing } : {}) });
const lflyInput = (contracts, financing) => templateInput('long_butterfly', { underlyingId: '$inst:index', options: { expiration: '2026-03-20', right: 'C', strikes: { lower: 100, middle: 105, upper: 110 }, contracts }, financing });
const crxCall = (strike) => ({
  productId: 'index_option', name: `CRX 20 March 2026 ${strike} call`, symbol: `CRX260320C${strike}`, marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlying: 'index', multiplier: 100,
  terms: { right: 'C', strike, expiration: '2026-03-20', exercise: 'european', settlement: 'cash', deliverable: { units: 100 } },
});
const lflyOne = (as) => ({ action: 'package', as, instrument: 'index', input: lflyInput(1, null), strategyPage: LFLY_PAGE(1, null) });
const longButterfly = {
  template: 'long_butterfly',
  title: 'Long call butterfly on the Corrin 50 Index (Cboe, cash-settled): 20 March 2026 100 / 105 / 110 calls, one, two sold, one',
  matrix: {
    ...OPTION_TEMPLATE_MATRIX,
    requiredFields: [...OPTION_TEMPLATE_MATRIX.requiredFields, 'Built from (calls or puts)'],
    settlement: 'Premium of each leg T+1 on the US calendar; Treasury funding moves at once; cash settlement of the expired legs T+1 (receipts settled before payments)',
    lifecycle: 'Three expiry items settled from the index fixing for 20 March 2026 (107: the bought 100 calls and the written 105 calls settled in cash, the 110 calls lapse); a failed dependent leg leaves the instance needing attention: Retry, Unwind or Accept',
    accounting: 'Net debit paid; commission expensed; premium realized on buy-back, sale, cash settlement and lapse',
    collateral: 'The two written calls are covered by the two bought legs: nothing is reserved; the cash need is measured leg by leg (the bought legs are paid for before the written legs bring their premium)',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: [] },
  book: book('Templates long butterfly'),
  instruments: {
    index: { productId: 'etf', name: 'Corrin 50 Index (reference level)', symbol: 'CRX', marketView: 'US_CASH', venue: 'Corrin Indices', venueType: 'exchange', venueCountry: 'US', issuer: 'Corrin Indices LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    c100: crxCall(100),
    c105: crxCall(105),
    c110: crxCall(110),
  },
  quotes: {
    index: { bid: 99.99, ask: 100.01, last: 100, bidSize: 1000, askSize: 1000 },
    c100: { bid: 3.30, ask: 3.40, last: 3.35, bidSize: 20, askSize: 3 }, // only 3 contracts displayed at the ask
    c105: { bid: 1.20, ask: 1.30, last: 1.25, bidSize: 40, askSize: 40 },
    c110: { bid: 0.30, ask: 0.40, last: 0.35, bidSize: 20, askSize: 20 },
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
      // Netted: 1,900 for the bought legs (5 x 3.40 x 100 + 5 x 0.40 x 100), 13 of commission (20 contracts), nothing
      // reserved, against 1,200 (10 x 1.20 x 100) and 1,000: no shortfall. Leg by leg: 1,000 - 1,703.25 - 203.25 =
      // -906.50 before the written calls bring 1,193.50.
      id: 'open-short-of-cash', covers: 'financing', action: 'package', as: 'refused', instrument: 'index',
      input: lflyInput(5, null), strategyPage: LFLY_PAGE(5, null),
      status: 'blocked', reason: 'The bought legs are paid for before the written legs bring their premium: the preview is blocked until financing is chosen.',
      expect: {
        refused: 'Alpha is short 906.50 USD while the legs execute',
        preview: {
          blocking: 1, errors: ['cash'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'c100', qty: 5, estimate: 3.40, settleDate: '2026-03-03', cash: -1_700, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c110', qty: 5, estimate: 0.40, settleDate: '2026-03-03', cash: -200, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'c105', qty: 10, estimate: 1.20, settleDate: '2026-03-03', cash: 1_200, fees: 6.50, dependsOn: [1, 2] },
          ],
          cash: { USD: { purchases: 1_900, proceeds: 1_200, fees: 13, reserved: 0, required: 1_913, available: 1_000, shortfall: 906.50 } },
        },
      },
    },
    {
      id: 'open', covers: ['open', 'financing', 'partial fill', 'dependency'], action: 'package', as: 'butterfly', instrument: 'index',
      input: lflyInput(5, { mode: 'treasury' }), strategyPage: LFLY_PAGE(5, { mode: 'treasury' }),
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', purpose: 'financing', qty: 906.50, cash: 906.50, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c100', qty: 5, estimate: 3.40, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -1_700, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'buy', instrument: 'c110', qty: 5, estimate: 0.40, settleDate: '2026-03-03', cash: -200, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c105', qty: 10, estimate: 1.20, settleDate: '2026-03-03', cash: 1_200, fees: 6.50, dependsOn: [2, 3, 1] },
          ],
          cash: { USD: { purchases: 1_900, proceeds: 1_200, fees: 13, reserved: 0, financingIn: 906.50, required: 1_913, available: 1_000, shortfall: 0, netCash: 193.50 } },
          netPremium: { amount: 700, ccy: 'USD', type: 'debit', complete: true },
          // The two written calls are covered by the two bought legs: nothing reserved.
          optionRequirement: [{ ccy: 'USD', amount: 0, finite: 0, naked: 0, uncoveredCallUnits: 0 }],
        },
        result: {
          status: 'partial',
          orders: [
            { kind: 'funding', status: 'filled', filledQty: 906.50 },
            { action: 'buy', instrument: 'c100', status: 'partial', filledQty: 3, avgPrice: 3.40 },
            { action: 'buy', instrument: 'c110', status: 'filled', filledQty: 5, avgPrice: 0.40 },
            { action: 'sell', instrument: 'c105', status: 'partial', qty: 10, filledQty: 6, avgPrice: 1.20 }, // 10 x min(3/5, 5/5)
          ],
        },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 906.50 USD from Treasury to Alpha' },
          { type: 'trade.fill', summary: 'Bought 3 CRX260320C100 @ 3.40 USD', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Bought 5 CRX260320C110 @ 0.40 USD' },
          { type: 'trade.fill', summary: 'Sold 6 CRX260320C105 @ 1.20 USD' },
          { type: 'trade.fill', summary: 'Bought 2 CRX260320C100 @ 3.40 USD' },
          { type: 'trade.fill', summary: 'Sold 4 CRX260320C105 @ 1.20 USD' },
        ],
        cash: {
          // owed 1,021.95 + 203.25 + 681.30 = 1,906.50; owed to it 716.10 + 477.40 = 1,193.50
          account: { USD: { settled: 1_906.50, unsettled: -713, reserved: 0, availableToTrade: 1_193.50, availableToWithdraw: 0 } },
          treasury: { USD: { settled: 998_093.50, unsettled: 0, availableToTrade: 998_093.50, availableToWithdraw: 998_093.50 } },
        },
        positions: [
          { instrument: 'c100', lot: 'butterfly', owner: 'account', direction: 'long', qty: 5, avgCost: 3.40, cost: 1_700, price: 3.35, value: 1_675, unrealized: -25 },
          { instrument: 'c105', lot: 'butterfly', owner: 'account', direction: 'short', qty: -10, avgCost: 1.20, cost: -1_200, price: 1.25, value: -1_250, unrealized: -50 },
          { instrument: 'c110', lot: 'butterfly', owner: 'account', direction: 'long', qty: 5, avgCost: 0.40, cost: 200, price: 0.35, value: 175, unrealized: -25 },
        ],
        holdings: { c100: { long: 5, short: 0, net: 5 }, c105: { long: 0, short: 10, net: -10 }, c110: { long: 5, short: 0, net: 5 } },
        pending: [
          { instrument: 'c100', lot: 'butterfly', dueDate: '2026-03-03', amount: -1_021.95, into: 'cash' },
          { instrument: 'c100', lot: 'butterfly', dueDate: '2026-03-03', amount: -681.30, into: 'cash' },
          { instrument: 'c105', lot: 'butterfly', dueDate: '2026-03-03', amount: 477.40, into: 'cash' },
          { instrument: 'c105', lot: 'butterfly', dueDate: '2026-03-03', amount: 716.10, into: 'cash' },
          { instrument: 'c110', lot: 'butterfly', dueDate: '2026-03-03', amount: -203.25, into: 'cash' },
        ],
        lifecycle: [
          { type: 'option.expiry', instrument: 'c100', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'c105', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'c110', dueDate: '2026-03-20', status: 'pending' },
        ],
        pnl: {
          account: { realized: 0, commissions: -13, fees: 0, unrealized: -100, total: -113 },
          book: { realized: 0, commissions: -13, unrealized: -100, total: -113 },
          treasury: { total: 0 },
        },
        nav: { account: 1_793.50, treasury: 998_093.50, book: 999_887 }, // 1,000 + 906.50 - 113
        balance: {
          account: { cash: 1_906.50, receivable: 1_193.50, payable: 1_906.50, positions: 600, assets: 3_700, liabilities: 1_906.50, netAssets: 1_793.50 },
          treasury: { cash: 998_093.50, assets: 998_093.50, liabilities: 0, netAssets: 998_093.50 },
          book: { cash: 1_000_000, receivable: 1_193.50, payable: 1_906.50, positions: 600, assets: 1_001_793.50, liabilities: 1_906.50, netAssets: 999_887 },
        },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR(3),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 716.10 USD into settled cash', date: '2026-03-03' },
          { type: 'settlement.receive', summary: 'received 477.40 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 1,021.95 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 203.25 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 681.30 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 1_193.50, unsettled: 0, availableToTrade: 1_193.50, availableToWithdraw: 1_193.50 } } },
        pending: [],
        balance: { account: { cash: 1_193.50, receivable: null, payable: null, assets: 1_793.50, liabilities: 0 }, book: { cash: 999_287, receivable: null, payable: null, assets: 999_887, liabilities: 0 } },
      },
    },
    { id: 'c105-quote-stops', action: 'quote', instrument: 'c105', quote: { bid: 1.20, ask: 1.30, last: 1.25, bidSize: 40, askSize: 40, asOf: MAR(3, '09:50') }, expect: {} },
    {
      // One butterfly: 340 + 40 bought, two calls sold estimated at their last 1.25 (250), 2.60 commission. Leg by leg the
      // deepest point is after the bought legs: 1,193.50 - 340.65 - 40.65 = 812.20.
      ...lflyOne('retry'), id: 'open-retry', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'c100', qty: 1, estimate: 3.40, settleDate: '2026-03-04', cash: -340, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'c110', qty: 1, estimate: 0.40, settleDate: '2026-03-04', cash: -40, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'c105', qty: 2, estimate: null, reference: 1.25, executable: false, settleDate: '2026-03-04', cash: 250, fees: 1.30, dependsOn: [1, 2] },
          ],
          cash: { USD: { purchases: 380, proceeds: 250, fees: 2.60, reserved: 0, required: 382.60, available: 1_193.50, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ instrument: 'c100', status: 'filled', filledQty: 1 }, { instrument: 'c110', status: 'filled', filledQty: 1 }, { instrument: 'c105', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 CRX260320C100 @ 3.40 USD', date: '2026-03-03' }, { type: 'trade.fill', summary: 'Bought 1 CRX260320C110 @ 0.40 USD' }],
        cash: { account: { USD: { settled: 1_193.50, unsettled: -381.30, availableToTrade: 812.20, availableToWithdraw: 812.20 } } },
        positions: [
          { instrument: 'c100', lot: 'butterfly', value: 1_675 },
          { instrument: 'c100', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 3.40, cost: 340, price: 3.35, value: 335, unrealized: -5 },
          { instrument: 'c105', lot: 'butterfly', value: -1_250 },
          { instrument: 'c110', lot: 'butterfly', value: 175 },
          { instrument: 'c110', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 0.40, cost: 40, price: 0.35, value: 35, unrealized: -5 },
        ],
        holdings: { c100: { long: 6, short: 0, net: 6 }, c110: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'c100', lot: 'retry', dueDate: '2026-03-04', amount: -340.65 }, { instrument: 'c110', lot: 'retry', dueDate: '2026-03-04', amount: -40.65 }],
        openOrders: [{ instrument: 'c105', kind: 'trade', action: 'sell', status: 'working', qty: 2, filledQty: 0 }],
        lifecycle: [{ instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }],
        pnl: { account: { commissions: -14.30, unrealized: -110, total: -124.30 }, book: { commissions: -14.30, unrealized: -110, total: -124.30 } },
        nav: { account: 1_782.20, book: 999_875.70 },
        balance: {
          account: { cash: 1_193.50, payable: 381.30, positions: 970, assets: 2_163.50, liabilities: 381.30, netAssets: 1_782.20 },
          book: { cash: 999_287, payable: 381.30, positions: 970, assets: 1_000_257, liabilities: 381.30, netAssets: 999_875.70 },
        },
      },
    },
    {
      ...lflyOne('accept'), id: 'open-accept', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'c100' }, { instrument: 'c110' }, { instrument: 'c105', estimate: null, dependsOn: [1, 2] }], cash: { USD: { required: 382.60, available: 812.20, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ status: 'filled' }, { status: 'filled' }, { instrument: 'c105', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill' }, { type: 'trade.fill' }],
        cash: { account: { USD: { settled: 1_193.50, unsettled: -762.60, availableToTrade: 430.90, availableToWithdraw: 430.90 } } },
        positions: [
          { instrument: 'c100', lot: 'accept', value: 335 }, { instrument: 'c100', lot: 'butterfly' }, { instrument: 'c100', lot: 'retry' },
          { instrument: 'c105', lot: 'butterfly' },
          { instrument: 'c110', lot: 'accept', value: 35 }, { instrument: 'c110', lot: 'butterfly' }, { instrument: 'c110', lot: 'retry' },
        ],
        holdings: { c100: { long: 7, short: 0, net: 7 }, c110: { long: 7, short: 0, net: 7 } },
        pending: [{ instrument: 'c100', lot: 'accept' }, { instrument: 'c100', lot: 'retry' }, { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'retry' }],
        openOrders: [{ instrument: 'c105', status: 'working' }, { instrument: 'c105', status: 'working' }],
        lifecycle: [{ instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }],
        pnl: { account: { commissions: -15.60, unrealized: -120, total: -135.60 }, book: { commissions: -15.60, unrealized: -120, total: -135.60 } },
        nav: { account: 1_770.90, book: 999_864.40 },
        balance: {
          account: { cash: 1_193.50, payable: 762.60, positions: 1_340, assets: 2_533.50, liabilities: 762.60, netAssets: 1_770.90 },
          book: { cash: 999_287, payable: 762.60, positions: 1_340, assets: 1_000_627, liabilities: 762.60, netAssets: 999_864.40 },
        },
      },
    },
    {
      ...lflyOne('unwind'), id: 'open-unwind', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'c100' }, { instrument: 'c110' }, { instrument: 'c105', estimate: null }], cash: { USD: { required: 382.60, available: 430.90, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ status: 'filled' }, { status: 'filled' }, { instrument: 'c105', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill' }, { type: 'trade.fill' }],
        cash: { account: { USD: { settled: 1_193.50, unsettled: -1_143.90, availableToTrade: 49.60, availableToWithdraw: 49.60 } } },
        positions: [
          { instrument: 'c100', lot: 'accept' }, { instrument: 'c100', lot: 'butterfly' }, { instrument: 'c100', lot: 'retry' }, { instrument: 'c100', lot: 'unwind', value: 335 },
          { instrument: 'c105', lot: 'butterfly' },
          { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'butterfly' }, { instrument: 'c110', lot: 'retry' }, { instrument: 'c110', lot: 'unwind', value: 35 },
        ],
        holdings: { c100: { long: 8, short: 0, net: 8 }, c110: { long: 8, short: 0, net: 8 } },
        pending: [{ instrument: 'c100', lot: 'accept' }, { instrument: 'c100', lot: 'retry' }, { instrument: 'c100', lot: 'unwind' }, { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'retry' }, { instrument: 'c110', lot: 'unwind' }],
        openOrders: [{ instrument: 'c105', status: 'working' }, { instrument: 'c105', status: 'working' }, { instrument: 'c105', status: 'working' }],
        lifecycle: [{ instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }],
        pnl: { account: { commissions: -16.90, unrealized: -130, total: -146.90 }, book: { commissions: -16.90, unrealized: -130, total: -146.90 } },
        nav: { account: 1_759.60, book: 999_853.10 },
        balance: {
          account: { cash: 1_193.50, payable: 1_143.90, positions: 1_710, assets: 2_903.50, liabilities: 1_143.90, netAssets: 1_759.60 },
          book: { cash: 999_287, payable: 1_143.90, positions: 1_710, assets: 1_000_997, liabilities: 1_143.90, netAssets: 999_853.10 },
        },
      },
    },
    {
      id: 'written-legs-expire', covers: ['failed dependent leg', 'settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 340.65 USD from settled cash', date: '2026-03-04' },
          { type: 'settlement.pay', summary: 'paid 40.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 340.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 40.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 340.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 40.65 USD from settled cash' },
          { type: 'order.expired', summary: 'Leg 3 expired: sell 2 CRX260320C105. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 3 expired: sell 2 CRX260320C105. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 3 expired: sell 2 CRX260320C105. Day order did not fill before the end of the business day' },
        ],
        cash: { account: { USD: { settled: 49.60, unsettled: 0, availableToTrade: 49.60, availableToWithdraw: 49.60 } } },
        pending: [], openOrders: [],
        failed: { orders: 3 },
        alerts: ['strategy.attention', 'strategy.attention', 'strategy.attention'],
        balance: { account: { cash: 49.60, payable: null, assets: 1_759.60, liabilities: 0 }, book: { cash: 998_143.10, payable: null, assets: 999_853.10, liabilities: 0 } },
      },
    },
    {
      id: 'c105-quote-day3', action: 'quote', instrument: 'c105', quote: { bid: 1.00, ask: 1.10, last: 1.05, bidSize: 40, askSize: 40 },
      expect: {
        positions: [
          { instrument: 'c100', lot: 'accept' }, { instrument: 'c100', lot: 'butterfly' }, { instrument: 'c100', lot: 'retry' }, { instrument: 'c100', lot: 'unwind' },
          { instrument: 'c105', lot: 'butterfly', price: 1.05, value: -1_050, unrealized: 150 }, // -10 x 1.05 x 100 + 1,200
          { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'butterfly' }, { instrument: 'c110', lot: 'retry' }, { instrument: 'c110', lot: 'unwind' },
        ],
        pnl: { account: { unrealized: 70, total: 53.10 }, book: { unrealized: 70, total: 53.10 } },
        nav: { account: 1_959.60, book: 1_000_053.10 },
        balance: { account: { positions: 1_910, assets: 1_959.60, netAssets: 1_959.60 }, book: { positions: 1_910, assets: 1_000_053.10, netAssets: 1_000_053.10 } },
      },
    },
    {
      // Retry sells the two calls at 1.00 (200 - 1.30). Covered by the instance's bought legs: nothing reserved.
      id: 'retry', covers: ['retry', 'failed dependent leg'], action: 'recover', how: 'retry', lot: 'retry',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'retry', legs: [{ kind: 'trade', action: 'sell', instrument: 'c105', qty: 2, estimate: 1.00, settleDate: '2026-03-05', cash: 200, fees: 1.30 }], cash: { USD: { proceeds: 200, fees: 1.30, reserved: 0, required: 1.30, available: 49.60, shortfall: 0 } }, optionRequirement: [{ ccy: 'USD', amount: 0, finite: 0, naked: 0, uncoveredCallUnits: 0 }] },
        result: { status: 'open', complete: true, orders: [{ action: 'sell', instrument: 'c105', status: 'filled', filledQty: 2, avgPrice: 1.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2 CRX260320C105 @ 1.00 USD', date: '2026-03-04' }],
        cash: { account: { USD: { settled: 49.60, unsettled: 198.70, reserved: 0, availableToTrade: 248.30, availableToWithdraw: 49.60 } } },
        positions: [
          { instrument: 'c100', lot: 'accept' }, { instrument: 'c100', lot: 'butterfly' }, { instrument: 'c100', lot: 'retry' }, { instrument: 'c100', lot: 'unwind' },
          { instrument: 'c105', lot: 'butterfly', value: -1_050 }, { instrument: 'c105', lot: 'retry', owner: 'account', direction: 'short', qty: -2, avgCost: 1.00, cost: -200, price: 1.05, value: -210, unrealized: -10 },
          { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'butterfly' }, { instrument: 'c110', lot: 'retry' }, { instrument: 'c110', lot: 'unwind' },
        ],
        holdings: { c105: { long: 0, short: 12, net: -12 } },
        pending: [{ instrument: 'c105', lot: 'retry', dueDate: '2026-03-05', amount: 198.70 }],
        lifecycle: [{ instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c105' }, { instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }],
        alerts: ['strategy.attention', 'strategy.attention'],
        pnl: { account: { commissions: -18.20, unrealized: 60, total: 41.80 }, book: { commissions: -18.20, unrealized: 60, total: 41.80 } },
        nav: { account: 1_948.30, book: 1_000_041.80 },
        balance: {
          account: { cash: 49.60, receivable: 198.70, positions: 1_700, assets: 1_948.30, liabilities: 0, netAssets: 1_948.30 },
          book: { cash: 998_143.10, receivable: 198.70, positions: 1_700, assets: 1_000_041.80, netAssets: 1_000_041.80 },
        },
      },
    },
    {
      id: 'accept', covers: ['accept', 'failed dependent leg'], action: 'strategy_action', lot: 'accept', how: 'accept',
      expect: { events: [{ type: 'strategy.accepted', summary: 'accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: ['strategy.attention'] },
    },
    {
      // Unwind: nothing written to buy back; the two bought calls are sold at 3.30 and 0.30. Realized -10 each.
      id: 'unwind', covers: ['unwind', 'close'], action: 'recover', how: 'unwind', lot: 'unwind',
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'unwind',
          legs: [
            { kind: 'trade', action: 'sell', instrument: 'c100', qty: 1, estimate: 3.30, settleDate: '2026-03-05', cash: 330, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'c110', qty: 1, estimate: 0.30, settleDate: '2026-03-05', cash: 30, fees: 0.65, dependsOn: [] },
          ],
          cash: { USD: { proceeds: 360, fees: 1.30, required: 1.30, available: 248.30, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'c100', status: 'filled' }, { action: 'sell', instrument: 'c110', status: 'filled' }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Sold 1 CRX260320C100 @ 3.30 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 CRX260320C110 @ 0.30 USD (realized -10.00 USD)' },
        ],
        cash: { account: { USD: { settled: 49.60, unsettled: 557.40, availableToTrade: 607, availableToWithdraw: 49.60 } } }, // 198.70 + 329.35 + 29.35
        positions: [
          { instrument: 'c100', lot: 'accept' }, { instrument: 'c100', lot: 'butterfly' }, { instrument: 'c100', lot: 'retry' },
          { instrument: 'c105', lot: 'butterfly' }, { instrument: 'c105', lot: 'retry' },
          { instrument: 'c110', lot: 'accept' }, { instrument: 'c110', lot: 'butterfly' }, { instrument: 'c110', lot: 'retry' },
        ],
        holdings: { c100: { long: 7, short: 0, net: 7 }, c110: { long: 7, short: 0, net: 7 } },
        pending: [{ instrument: 'c100', lot: 'unwind', dueDate: '2026-03-05', amount: 329.35 }, { instrument: 'c105', lot: 'retry', amount: 198.70 }, { instrument: 'c110', lot: 'unwind', dueDate: '2026-03-05', amount: 29.35 }],
        lifecycle: [{ instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c105' }, { instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }, { instrument: 'c110' }],
        alerts: [],
        pnl: { account: { realized: -20, commissions: -19.50, unrealized: 70, total: 30.50 }, book: { realized: -20, commissions: -19.50, unrealized: 70, total: 30.50 } },
        nav: { account: 1_937, book: 1_000_030.50 },
        balance: {
          account: { cash: 49.60, receivable: 557.40, positions: 1_330, assets: 1_937, liabilities: 0, netAssets: 1_937 },
          book: { cash: 998_143.10, receivable: 557.40, positions: 1_330, assets: 1_000_030.50, netAssets: 1_000_030.50 },
        },
      },
    },
    {
      id: 'settle-recovery', covers: 'settlement', action: 'clock', to: MAR(5),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 198.70 USD into settled cash', date: '2026-03-05' },
          { type: 'settlement.receive', summary: 'received 329.35 USD into settled cash' },
          { type: 'settlement.receive', summary: 'received 29.35 USD into settled cash' },
        ],
        cash: { account: { USD: { settled: 607, unsettled: 0, availableToTrade: 607, availableToWithdraw: 607 } } },
        pending: [],
        balance: { account: { cash: 607, receivable: null, assets: 1_937 }, book: { cash: 998_700.50, receivable: null, assets: 1_000_030.50 } },
      },
    },
    {
      // Close "retry": its two written calls are bought back first at 1.10; its bought calls are sold after (3.30, 0.30).
      // Realized 2 x (1.00 - 1.10) x 100 = -20, and -10, -10.
      id: 'close-retry', covers: ['close', 'dependency'], action: 'close', lot: 'retry', instrument: 'c100', scope: 'strategy', percent: 100,
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'close',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'c105', qty: 2, estimate: 1.10, settleDate: '2026-03-06', cash: -220, fees: 1.30, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'c100', qty: 1, estimate: 3.30, settleDate: '2026-03-06', cash: 330, fees: 0.65, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'c110', qty: 1, estimate: 0.30, settleDate: '2026-03-06', cash: 30, fees: 0.65, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 220, proceeds: 360, fees: 2.60, reserved: 0, required: 222.60, available: 607, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ instrument: 'c105', status: 'filled' }, { instrument: 'c100', status: 'filled' }, { instrument: 'c110', status: 'filled' }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 2 CRX260320C105 @ 1.10 USD (realized -20.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 CRX260320C100 @ 3.30 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 CRX260320C110 @ 0.30 USD (realized -10.00 USD)' },
        ],
        cash: { account: { USD: { settled: 607, unsettled: 137.40, availableToTrade: 744.40, availableToWithdraw: 385.70 } } }, // -221.30 + 329.35 + 29.35
        positions: [
          { instrument: 'c100', lot: 'accept', value: 335 }, { instrument: 'c100', lot: 'butterfly', value: 1_675 },
          { instrument: 'c105', lot: 'butterfly', value: -1_050 },
          { instrument: 'c110', lot: 'accept', value: 35 }, { instrument: 'c110', lot: 'butterfly', value: 175 },
        ],
        holdings: { c100: { long: 6, short: 0, net: 6 }, c105: { long: 0, short: 10, net: -10 }, c110: { long: 6, short: 0, net: 6 } },
        pending: [
          { instrument: 'c100', lot: 'retry', dueDate: '2026-03-06', amount: 329.35 },
          { instrument: 'c105', lot: 'retry', dueDate: '2026-03-06', amount: -221.30 },
          { instrument: 'c110', lot: 'retry', dueDate: '2026-03-06', amount: 29.35 },
        ],
        lifecycle: [{ instrument: 'c100' }, { instrument: 'c100' }, { instrument: 'c105' }, { instrument: 'c110' }, { instrument: 'c110' }],
        pnl: { account: { realized: -60, commissions: -22.10, unrealized: 90, total: 7.90 }, book: { realized: -60, commissions: -22.10, unrealized: 90, total: 7.90 } },
        nav: { account: 1_914.40, book: 1_000_007.90 },
        balance: {
          account: { cash: 607, receivable: 358.70, payable: 221.30, positions: 1_170, assets: 2_135.70, liabilities: 221.30, netAssets: 1_914.40 },
          book: { cash: 998_700.50, receivable: 358.70, payable: 221.30, positions: 1_170, assets: 1_000_229.20, liabilities: 221.30, netAssets: 1_000_007.90 },
        },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MAR(6),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 329.35 USD into settled cash', date: '2026-03-06' },
          { type: 'settlement.receive', summary: 'received 29.35 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 221.30 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 744.40, unsettled: 0, availableToTrade: 744.40, availableToWithdraw: 744.40 } } },
        pending: [],
        balance: { account: { cash: 744.40, receivable: null, payable: null, assets: 1_914.40, liabilities: 0 }, book: { cash: 998_837.90, receivable: null, payable: null, assets: 1_000_007.90, liabilities: 0 } },
      },
    },
    { id: 'expiry-fixing', action: 'close_price', instrument: 'index', date: '2026-03-20', value: 107, expect: {} },
    {
      // The index fixes at 107. Outer: the bought 100 calls receive 7 x 100 a contract (3,500 for "butterfly", realized
      // 1,800; 700 for "accept", realized 360). Inner: the ten written 105 calls pay 2 x 100 each, 2,000 (realized -800).
      // The 110 calls lapse (-200, -40). Realized -60 + 1,800 - 800 - 200 + 360 - 40 = 1,060.
      id: 'expiry', covers: ['expiry', 'cash settlement', 'assignment'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [
          { type: 'option.cash_settled', summary: /^Exercised \(cash settlement\): 5 CRX260320C100 at 7(\.00)? per unit/, date: '2026-03-20' },
          { type: 'option.expired', summary: 'Expired worthless: 5 CRX260320C110 (fixing 107)' },
          { type: 'option.cash_settled', summary: /^Assigned \(cash settlement\): 10 CRX260320C105 at 2(\.00)? per unit/ },
          { type: 'option.cash_settled', summary: /^Exercised \(cash settlement\): 1 CRX260320C100 at 7(\.00)? per unit/ },
          { type: 'option.expired', summary: 'Expired worthless: 1 CRX260320C110 (fixing 107)' },
        ],
        cash: { account: { USD: { settled: 744.40, unsettled: 2_200, reserved: 0, availableToTrade: 2_944.40, availableToWithdraw: -1_255.60 } } },
        positions: [],
        holdings: { c100: null, c105: null, c110: null },
        pending: [
          { instrument: 'c100', lot: 'accept', dueDate: '2026-03-23', amount: 700, into: 'cash' },
          { instrument: 'c100', lot: 'butterfly', dueDate: '2026-03-23', amount: 3_500, into: 'cash' },
          { instrument: 'c105', lot: 'butterfly', dueDate: '2026-03-23', amount: -2_000, into: 'cash' },
        ],
        lifecycle: [],
        pnl: { account: { realized: 1_060, commissions: -22.10, unrealized: 0, total: 1_037.90 }, book: { realized: 1_060, commissions: -22.10, unrealized: 0, total: 1_037.90 } },
        nav: { account: 2_944.40, book: 1_001_037.90 }, // 1,000 + 906.50 + 1,037.90
        balance: {
          account: { cash: 744.40, receivable: 4_200, payable: 2_000, positions: null, assets: 4_944.40, liabilities: 2_000, netAssets: 2_944.40 },
          book: { cash: 998_837.90, receivable: 4_200, payable: 2_000, positions: null, assets: 1_003_037.90, liabilities: 2_000, netAssets: 1_001_037.90 },
        },
      },
    },
    {
      id: 'cash-settlement', covers: 'settlement', action: 'clock', to: MAR(23),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 3,500.00 USD into settled cash', date: '2026-03-23' },
          { type: 'settlement.receive', summary: 'received 700.00 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 2,000.00 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 2_944.40, unsettled: 0, availableToTrade: 2_944.40, availableToWithdraw: 2_944.40 } } },
        pending: [],
        balance: { account: { cash: 2_944.40, receivable: null, payable: null, assets: 2_944.40, liabilities: 0 }, book: { cash: 1_001_037.90, receivable: null, payable: null, assets: 1_001_037.90, liabilities: 0 } },
      },
    },
  ],
};

// =====================================================================================================================
// long_calendar
// =====================================================================================================================
// Pemberton Foods (NYSE) 50 calls, physical delivery: sell the 20 March 2026 call, buy the 17 April 2026 call, 5 each.
// The near call depends on the far call; the far call outlives it and covers it, so nothing is reserved. Netted the
// Account could pay, but the far call is bought before the near call's premium arrives: funding is needed.
//   calendar  refused (short while the legs execute), then Treasury funding; the far call fills 3 of 5 first and the
//             dependent near call follows. On 20 March the stock closes at 48: the near call lapses and the far call
//             remains, held over Good Friday, and is sold on 6 April.
//   retry / accept / unwind  1 each when the near call has no fresh quote. Accept keeps a far call alone, sold on 6 April.
const CAL_PAGE = (contracts, financing) => ({ template: 'Long Calendar Spread', underlying: 'stock', expiration: '2026-03-20', farExpiration: '2026-04-17', right: 'C', strikes: { Strike: 50 }, contracts, ...(financing ? { financing } : {}) });
const calInput = (contracts, financing) => templateInput('long_calendar', { underlyingId: '$inst:stock', options: { expiration: '2026-03-20', farExpiration: '2026-04-17', right: 'C', strikes: { middle: 50 }, contracts }, financing });
const calOne = (as) => ({ action: 'package', as, instrument: 'stock', input: calInput(1, null), strategyPage: CAL_PAGE(1, null) });
const longCalendar = {
  template: 'long_calendar',
  title: 'Long calendar spread on Pemberton Foods (NYSE): sell the 20 March 2026 50 call, buy the 17 April 2026 50 call',
  matrix: {
    ...OPTION_TEMPLATE_MATRIX,
    requiredFields: [...OPTION_TEMPLATE_MATRIX.requiredFields, 'Far expiration', 'Built from (calls or puts)'],
    settlement: 'Premium of each leg T+1 on the US calendar; Treasury funding moves at once',
    lifecycle: 'The near call\'s expiry item on 20 March 2026 (close 48: it lapses) while the far call remains open with its own expiry item on 17 April; the far call is held across Good Friday and sold; a failed dependent leg leaves the instance needing attention: Retry, Unwind or Accept',
    accounting: 'Net debit paid; commission expensed; premium realized on buy-back, sale and lapse; after the near expiry the instance holds the far call alone',
    collateral: 'The far call outlives the near call and covers it: nothing is reserved; the cash need is measured leg by leg (the far call is paid for before the near call\'s premium arrives)',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: ['2026-04-03'] },
  book: book('Templates long calendar'),
  instruments: {
    stock: stockDraft('Pemberton Foods Inc.', 'PMF'),
    mar50: equityOption('PMF', 'PMF260320C50', 'C', 50, '2026-03-20'),
    apr50: equityOption('PMF', 'PMF260417C50', 'C', 50, '2026-04-17'),
  },
  quotes: {
    stock: { bid: 49.98, ask: 50.02, last: 50.00, bidSize: 10000, askSize: 10000 },
    mar50: { bid: 1.50, ask: 1.60, last: 1.55, bidSize: 20, askSize: 20 },
    apr50: { bid: 2.50, ask: 2.60, last: 2.55, bidSize: 20, askSize: 3 }, // only 3 contracts displayed at the ask
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
      // Netted: 1,300 (5 x 2.60 x 100) + 6.50 against 750 (5 x 1.50 x 100) and 1,000. Leg by leg: 1,000 - 1,303.25 = -303.25.
      id: 'open-short-of-cash', covers: 'financing', action: 'package', as: 'refused', instrument: 'stock',
      input: calInput(5, null), strategyPage: CAL_PAGE(5, null),
      status: 'blocked', reason: 'The far call is paid for before the near call brings its premium: the preview is blocked until financing is chosen.',
      expect: {
        refused: 'Alpha is short 303.25 USD while the legs execute',
        preview: {
          blocking: 1, errors: ['cash'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'apr50', qty: 5, estimate: 2.60, settleDate: '2026-03-03', cash: -1_300, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'mar50', qty: 5, estimate: 1.50, settleDate: '2026-03-03', cash: 750, fees: 3.25, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 1_300, proceeds: 750, fees: 6.50, reserved: 0, required: 1_306.50, available: 1_000, shortfall: 303.25 } },
        },
      },
    },
    {
      id: 'open', covers: ['open', 'financing', 'partial fill', 'dependency'], action: 'package', as: 'calendar', instrument: 'stock',
      input: calInput(5, { mode: 'treasury' }), strategyPage: CAL_PAGE(5, { mode: 'treasury' }),
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', purpose: 'financing', qty: 303.25, cash: 303.25, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'apr50', qty: 5, estimate: 2.60, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -1_300, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'mar50', qty: 5, estimate: 1.50, settleDate: '2026-03-03', cash: 750, fees: 3.25, dependsOn: [2, 1] },
          ],
          cash: { USD: { purchases: 1_300, proceeds: 750, fees: 6.50, reserved: 0, financingIn: 303.25, required: 1_306.50, available: 1_000, shortfall: 0, netCash: -253.25 } },
          netPremium: { amount: 550, ccy: 'USD', type: 'debit', complete: true },
          optionRequirement: [{ ccy: 'USD', amount: 0, finite: 0, naked: 0, uncoveredCallUnits: 0 }], // the far call covers the near call
        },
        result: {
          status: 'partial',
          orders: [
            { kind: 'funding', status: 'filled', filledQty: 303.25 },
            { action: 'buy', instrument: 'apr50', status: 'partial', filledQty: 3, avgPrice: 2.60 },
            { action: 'sell', instrument: 'mar50', status: 'partial', filledQty: 3, avgPrice: 1.50 },
          ],
        },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 303.25 USD from Treasury to Alpha' },
          { type: 'trade.fill', summary: 'Bought 3 PMF260417C50 @ 2.60 USD', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Sold 3 PMF260320C50 @ 1.50 USD' },
          { type: 'trade.fill', summary: 'Bought 2 PMF260417C50 @ 2.60 USD' },
          { type: 'trade.fill', summary: 'Sold 2 PMF260320C50 @ 1.50 USD' },
        ],
        cash: {
          // owed 781.95 + 521.30 = 1,303.25; owed to it 448.05 + 298.70 = 746.75
          account: { USD: { settled: 1_303.25, unsettled: -556.50, reserved: 0, availableToTrade: 746.75, availableToWithdraw: 0 } },
          treasury: { USD: { settled: 998_696.75, unsettled: 0, availableToTrade: 998_696.75, availableToWithdraw: 998_696.75 } },
        },
        positions: [
          { instrument: 'apr50', lot: 'calendar', owner: 'account', direction: 'long', qty: 5, avgCost: 2.60, cost: 1_300, price: 2.55, value: 1_275, unrealized: -25 },
          { instrument: 'mar50', lot: 'calendar', owner: 'account', direction: 'short', qty: -5, avgCost: 1.50, cost: -750, price: 1.55, value: -775, unrealized: -25 },
        ],
        holdings: { apr50: { long: 5, short: 0, net: 5 }, mar50: { long: 0, short: 5, net: -5 } },
        pending: [
          { instrument: 'apr50', lot: 'calendar', dueDate: '2026-03-03', amount: -781.95, into: 'cash' },
          { instrument: 'apr50', lot: 'calendar', dueDate: '2026-03-03', amount: -521.30, into: 'cash' },
          { instrument: 'mar50', lot: 'calendar', dueDate: '2026-03-03', amount: 298.70, into: 'cash' },
          { instrument: 'mar50', lot: 'calendar', dueDate: '2026-03-03', amount: 448.05, into: 'cash' },
        ],
        lifecycle: [
          { type: 'option.expiry', instrument: 'mar50', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'apr50', dueDate: '2026-04-17', status: 'pending' },
        ],
        pnl: {
          account: { realized: 0, commissions: -6.50, fees: 0, unrealized: -50, total: -56.50 },
          book: { realized: 0, commissions: -6.50, unrealized: -50, total: -56.50 },
          treasury: { total: 0 },
        },
        nav: { account: 1_246.75, treasury: 998_696.75, book: 999_943.50 },
        balance: {
          account: { cash: 1_303.25, receivable: 746.75, payable: 1_303.25, positions: 500, assets: 2_550, liabilities: 1_303.25, netAssets: 1_246.75 },
          treasury: { cash: 998_696.75, assets: 998_696.75, liabilities: 0, netAssets: 998_696.75 },
          book: { cash: 1_000_000, receivable: 746.75, payable: 1_303.25, positions: 500, assets: 1_001_246.75, liabilities: 1_303.25, netAssets: 999_943.50 },
        },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR(3),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 448.05 USD into settled cash', date: '2026-03-03' },
          { type: 'settlement.receive', summary: 'received 298.70 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 781.95 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 521.30 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 746.75, unsettled: 0, availableToTrade: 746.75, availableToWithdraw: 746.75 } } },
        pending: [],
        balance: { account: { cash: 746.75, receivable: null, payable: null, assets: 1_246.75, liabilities: 0 }, book: { cash: 999_443.50, receivable: null, payable: null, assets: 999_943.50, liabilities: 0 } },
      },
    },
    {
      id: 'fund-account', covers: 'internal funding', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 1_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 1,000.00 USD from Treasury to Alpha' }],
        cash: { account: { USD: { settled: 1_746.75, availableToTrade: 1_746.75, availableToWithdraw: 1_746.75 } }, treasury: { USD: { settled: 997_696.75, availableToTrade: 997_696.75, availableToWithdraw: 997_696.75 } } },
        nav: { account: 2_246.75, treasury: 997_696.75 },
        balance: { account: { cash: 1_746.75, assets: 2_246.75, netAssets: 2_246.75 }, treasury: { cash: 997_696.75, assets: 997_696.75, netAssets: 997_696.75 } },
      },
    },
    { id: 'mar50-quote-stops', action: 'quote', instrument: 'mar50', quote: { bid: 1.50, ask: 1.60, last: 1.55, bidSize: 20, askSize: 20, asOf: MAR(3, '09:50') }, expect: {} },
    {
      ...calOne('retry'), id: 'open-retry', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'apr50', qty: 1, estimate: 2.60, settleDate: '2026-03-04', cash: -260, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'mar50', qty: 1, estimate: null, reference: 1.55, executable: false, settleDate: '2026-03-04', cash: 155, fees: 0.65, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 260, proceeds: 155, fees: 1.30, reserved: 0, required: 261.30, available: 1_746.75, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ instrument: 'apr50', status: 'filled', filledQty: 1, avgPrice: 2.60 }, { instrument: 'mar50', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 PMF260417C50 @ 2.60 USD', date: '2026-03-03' }],
        cash: { account: { USD: { settled: 1_746.75, unsettled: -260.65, availableToTrade: 1_486.10, availableToWithdraw: 1_486.10 } } },
        positions: [
          { instrument: 'apr50', lot: 'calendar', value: 1_275 },
          { instrument: 'apr50', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 2.60, cost: 260, price: 2.55, value: 255, unrealized: -5 },
          { instrument: 'mar50', lot: 'calendar', value: -775 },
        ],
        holdings: { apr50: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'apr50', lot: 'retry', dueDate: '2026-03-04', amount: -260.65 }],
        openOrders: [{ instrument: 'mar50', kind: 'trade', action: 'sell', status: 'working', qty: 1, filledQty: 0 }],
        lifecycle: [{ instrument: 'mar50' }, { instrument: 'apr50' }, { instrument: 'apr50' }],
        pnl: { account: { commissions: -7.15, unrealized: -55, total: -62.15 }, book: { commissions: -7.15, unrealized: -55, total: -62.15 } },
        nav: { account: 2_241.10, book: 999_937.85 },
        balance: {
          account: { cash: 1_746.75, payable: 260.65, positions: 755, assets: 2_501.75, liabilities: 260.65, netAssets: 2_241.10 },
          book: { cash: 999_443.50, payable: 260.65, positions: 755, assets: 1_000_198.50, liabilities: 260.65, netAssets: 999_937.85 },
        },
      },
    },
    {
      ...calOne('accept'), id: 'open-accept', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'apr50', qty: 1 }, { instrument: 'mar50', qty: 1, estimate: null, dependsOn: [1] }], cash: { USD: { required: 261.30, available: 1_486.10, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ instrument: 'apr50', status: 'filled' }, { instrument: 'mar50', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 PMF260417C50 @ 2.60 USD' }],
        cash: { account: { USD: { settled: 1_746.75, unsettled: -521.30, availableToTrade: 1_225.45, availableToWithdraw: 1_225.45 } } },
        positions: [{ instrument: 'apr50', lot: 'accept', value: 255 }, { instrument: 'apr50', lot: 'calendar' }, { instrument: 'apr50', lot: 'retry' }, { instrument: 'mar50', lot: 'calendar' }],
        holdings: { apr50: { long: 7, short: 0, net: 7 } },
        pending: [{ lot: 'accept', amount: -260.65 }, { lot: 'retry', amount: -260.65 }],
        openOrders: [{ instrument: 'mar50', status: 'working' }, { instrument: 'mar50', status: 'working' }],
        lifecycle: [{ instrument: 'mar50' }, { instrument: 'apr50' }, { instrument: 'apr50' }, { instrument: 'apr50' }],
        pnl: { account: { commissions: -7.80, unrealized: -60, total: -67.80 }, book: { commissions: -7.80, unrealized: -60, total: -67.80 } },
        nav: { account: 2_235.45, book: 999_932.20 },
        balance: {
          account: { cash: 1_746.75, payable: 521.30, positions: 1_010, assets: 2_756.75, liabilities: 521.30, netAssets: 2_235.45 },
          book: { cash: 999_443.50, payable: 521.30, positions: 1_010, assets: 1_000_453.50, liabilities: 521.30, netAssets: 999_932.20 },
        },
      },
    },
    {
      ...calOne('unwind'), id: 'open-unwind', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'apr50', qty: 1 }, { instrument: 'mar50', qty: 1, estimate: null }], cash: { USD: { required: 261.30, available: 1_225.45, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ instrument: 'apr50', status: 'filled' }, { instrument: 'mar50', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 PMF260417C50 @ 2.60 USD' }],
        cash: { account: { USD: { settled: 1_746.75, unsettled: -781.95, availableToTrade: 964.80, availableToWithdraw: 964.80 } } },
        positions: [{ instrument: 'apr50', lot: 'accept' }, { instrument: 'apr50', lot: 'calendar' }, { instrument: 'apr50', lot: 'retry' }, { instrument: 'apr50', lot: 'unwind', value: 255 }, { instrument: 'mar50', lot: 'calendar' }],
        holdings: { apr50: { long: 8, short: 0, net: 8 } },
        pending: [{ lot: 'accept' }, { lot: 'retry' }, { lot: 'unwind', amount: -260.65 }],
        openOrders: [{ instrument: 'mar50', status: 'working' }, { instrument: 'mar50', status: 'working' }, { instrument: 'mar50', status: 'working' }],
        lifecycle: [{ instrument: 'mar50' }, { instrument: 'apr50' }, { instrument: 'apr50' }, { instrument: 'apr50' }, { instrument: 'apr50' }],
        pnl: { account: { commissions: -8.45, unrealized: -65, total: -73.45 }, book: { commissions: -8.45, unrealized: -65, total: -73.45 } },
        nav: { account: 2_229.80, book: 999_926.55 },
        balance: {
          account: { cash: 1_746.75, payable: 781.95, positions: 1_265, assets: 3_011.75, liabilities: 781.95, netAssets: 2_229.80 },
          book: { cash: 999_443.50, payable: 781.95, positions: 1_265, assets: 1_000_708.50, liabilities: 781.95, netAssets: 999_926.55 },
        },
      },
    },
    {
      id: 'near-legs-expire', covers: ['failed dependent leg', 'settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 260.65 USD from settled cash', date: '2026-03-04' },
          { type: 'settlement.pay', summary: 'paid 260.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 260.65 USD from settled cash' },
          { type: 'order.expired', summary: 'Leg 2 expired: sell 1 PMF260320C50. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 2 expired: sell 1 PMF260320C50. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 2 expired: sell 1 PMF260320C50. Day order did not fill before the end of the business day' },
        ],
        cash: { account: { USD: { settled: 964.80, unsettled: 0, availableToTrade: 964.80, availableToWithdraw: 964.80 } } },
        pending: [], openOrders: [],
        failed: { orders: 3 },
        alerts: ['strategy.attention', 'strategy.attention', 'strategy.attention'],
        balance: { account: { cash: 964.80, payable: null, assets: 2_229.80, liabilities: 0 }, book: { cash: 998_661.55, payable: null, assets: 999_926.55, liabilities: 0 } },
      },
    },
    {
      id: 'mar50-quote-day3', action: 'quote', instrument: 'mar50', quote: { bid: 1.30, ask: 1.40, last: 1.35, bidSize: 20, askSize: 20 },
      expect: {
        positions: [{ instrument: 'apr50', lot: 'accept' }, { instrument: 'apr50', lot: 'calendar' }, { instrument: 'apr50', lot: 'retry' }, { instrument: 'apr50', lot: 'unwind' }, { instrument: 'mar50', lot: 'calendar', price: 1.35, value: -675, unrealized: 75 }],
        pnl: { account: { unrealized: 35, total: 26.55 }, book: { unrealized: 35, total: 26.55 } },
        nav: { account: 2_329.80, book: 1_000_026.55 },
        balance: { account: { positions: 1_365, assets: 2_329.80, netAssets: 2_329.80 }, book: { positions: 1_365, assets: 1_000_026.55, netAssets: 1_000_026.55 } },
      },
    },
    {
      id: 'retry', covers: ['retry', 'failed dependent leg'], action: 'recover', how: 'retry', lot: 'retry',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'retry', legs: [{ kind: 'trade', action: 'sell', instrument: 'mar50', qty: 1, estimate: 1.30, settleDate: '2026-03-05', cash: 130, fees: 0.65 }], cash: { USD: { proceeds: 130, fees: 0.65, reserved: 0, required: 0.65, available: 964.80, shortfall: 0 } }, optionRequirement: [{ ccy: 'USD', amount: 0, finite: 0, naked: 0, uncoveredCallUnits: 0 }] },
        result: { status: 'open', complete: true, orders: [{ action: 'sell', instrument: 'mar50', status: 'filled', filledQty: 1, avgPrice: 1.30 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 PMF260320C50 @ 1.30 USD', date: '2026-03-04' }],
        cash: { account: { USD: { settled: 964.80, unsettled: 129.35, availableToTrade: 1_094.15, availableToWithdraw: 964.80 } } },
        positions: [
          { instrument: 'apr50', lot: 'accept' }, { instrument: 'apr50', lot: 'calendar' }, { instrument: 'apr50', lot: 'retry' }, { instrument: 'apr50', lot: 'unwind' },
          { instrument: 'mar50', lot: 'calendar', value: -675 }, { instrument: 'mar50', lot: 'retry', owner: 'account', direction: 'short', qty: -1, avgCost: 1.30, cost: -130, price: 1.35, value: -135, unrealized: -5 },
        ],
        holdings: { mar50: { long: 0, short: 6, net: -6 } },
        pending: [{ instrument: 'mar50', lot: 'retry', dueDate: '2026-03-05', amount: 129.35 }],
        lifecycle: [{ instrument: 'mar50' }, { instrument: 'mar50' }, { instrument: 'apr50' }, { instrument: 'apr50' }, { instrument: 'apr50' }, { instrument: 'apr50' }],
        alerts: ['strategy.attention', 'strategy.attention'],
        pnl: { account: { commissions: -9.10, unrealized: 30, total: 20.90 }, book: { commissions: -9.10, unrealized: 30, total: 20.90 } },
        nav: { account: 2_324.15, book: 1_000_020.90 },
        balance: {
          account: { cash: 964.80, receivable: 129.35, positions: 1_230, assets: 2_324.15, liabilities: 0, netAssets: 2_324.15 },
          book: { cash: 998_661.55, receivable: 129.35, positions: 1_230, assets: 1_000_020.90, netAssets: 1_000_020.90 },
        },
      },
    },
    {
      id: 'accept', covers: ['accept', 'failed dependent leg'], action: 'strategy_action', lot: 'accept', how: 'accept',
      expect: { events: [{ type: 'strategy.accepted', summary: 'accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: ['strategy.attention'] },
    },
    {
      id: 'unwind', covers: ['unwind', 'close'], action: 'recover', how: 'unwind', lot: 'unwind',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'unwind', legs: [{ kind: 'trade', action: 'sell', instrument: 'apr50', qty: 1, estimate: 2.50, settleDate: '2026-03-05', cash: 250, fees: 0.65, dependsOn: [] }] },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'apr50', status: 'filled', filledQty: 1, avgPrice: 2.50 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 PMF260417C50 @ 2.50 USD (realized -10.00 USD)' }],
        cash: { account: { USD: { settled: 964.80, unsettled: 378.70, availableToTrade: 1_343.50, availableToWithdraw: 964.80 } } },
        positions: [
          { instrument: 'apr50', lot: 'accept' }, { instrument: 'apr50', lot: 'calendar' }, { instrument: 'apr50', lot: 'retry' },
          { instrument: 'mar50', lot: 'calendar' }, { instrument: 'mar50', lot: 'retry' },
        ],
        holdings: { apr50: { long: 7, short: 0, net: 7 } },
        pending: [{ instrument: 'apr50', lot: 'unwind', dueDate: '2026-03-05', amount: 249.35 }, { instrument: 'mar50', lot: 'retry', amount: 129.35 }],
        lifecycle: [{ instrument: 'mar50' }, { instrument: 'mar50' }, { instrument: 'apr50' }, { instrument: 'apr50' }, { instrument: 'apr50' }],
        alerts: [],
        pnl: { account: { realized: -10, commissions: -9.75, unrealized: 35, total: 15.25 }, book: { realized: -10, commissions: -9.75, unrealized: 35, total: 15.25 } },
        nav: { account: 2_318.50, book: 1_000_015.25 },
        balance: {
          account: { cash: 964.80, receivable: 378.70, positions: 975, assets: 2_318.50, liabilities: 0, netAssets: 2_318.50 },
          book: { cash: 998_661.55, receivable: 378.70, positions: 975, assets: 1_000_015.25, netAssets: 1_000_015.25 },
        },
      },
    },
    {
      id: 'settle-recovery', covers: 'settlement', action: 'clock', to: MAR(5),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 129.35 USD into settled cash', date: '2026-03-05' }, { type: 'settlement.receive', summary: 'received 249.35 USD into settled cash' }],
        cash: { account: { USD: { settled: 1_343.50, unsettled: 0, availableToTrade: 1_343.50, availableToWithdraw: 1_343.50 } } },
        pending: [],
        balance: { account: { cash: 1_343.50, receivable: null, assets: 2_318.50 }, book: { cash: 999_040.25, receivable: null, assets: 1_000_015.25 } },
      },
    },
    {
      // Close "retry": the near call is bought back first at 1.40, then the far call is sold at 2.50. -10 each.
      id: 'close-retry', covers: ['close', 'dependency'], action: 'close', lot: 'retry', instrument: 'apr50', scope: 'strategy', percent: 100,
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'close',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'mar50', qty: 1, estimate: 1.40, settleDate: '2026-03-06', cash: -140, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'apr50', qty: 1, estimate: 2.50, settleDate: '2026-03-06', cash: 250, fees: 0.65, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 140, proceeds: 250, fees: 1.30, required: 141.30, available: 1_343.50, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ instrument: 'mar50', status: 'filled' }, { instrument: 'apr50', status: 'filled' }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 1 PMF260320C50 @ 1.40 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 PMF260417C50 @ 2.50 USD (realized -10.00 USD)' },
        ],
        cash: { account: { USD: { settled: 1_343.50, unsettled: 108.70, availableToTrade: 1_452.20, availableToWithdraw: 1_202.85 } } }, // -140.65 + 249.35
        positions: [{ instrument: 'apr50', lot: 'accept', value: 255 }, { instrument: 'apr50', lot: 'calendar', value: 1_275 }, { instrument: 'mar50', lot: 'calendar', value: -675 }],
        holdings: { apr50: { long: 6, short: 0, net: 6 }, mar50: { long: 0, short: 5, net: -5 } },
        pending: [{ instrument: 'apr50', lot: 'retry', dueDate: '2026-03-06', amount: 249.35 }, { instrument: 'mar50', lot: 'retry', dueDate: '2026-03-06', amount: -140.65 }],
        lifecycle: [{ instrument: 'mar50' }, { instrument: 'apr50' }, { instrument: 'apr50' }],
        pnl: { account: { realized: -30, commissions: -11.05, unrealized: 45, total: 3.95 }, book: { realized: -30, commissions: -11.05, unrealized: 45, total: 3.95 } },
        nav: { account: 2_307.20, book: 1_000_003.95 },
        balance: {
          account: { cash: 1_343.50, receivable: 249.35, payable: 140.65, positions: 855, assets: 2_447.85, liabilities: 140.65, netAssets: 2_307.20 },
          book: { cash: 999_040.25, receivable: 249.35, payable: 140.65, positions: 855, assets: 1_000_144.60, liabilities: 140.65, netAssets: 1_000_003.95 },
        },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MAR(6),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 249.35 USD into settled cash', date: '2026-03-06' }, { type: 'settlement.pay', summary: 'paid 140.65 USD from settled cash' }],
        cash: { account: { USD: { settled: 1_452.20, unsettled: 0, availableToTrade: 1_452.20, availableToWithdraw: 1_452.20 } } },
        pending: [],
        balance: { account: { cash: 1_452.20, receivable: null, payable: null, assets: 2_307.20, liabilities: 0 }, book: { cash: 999_148.95, receivable: null, payable: null, assets: 1_000_003.95, liabilities: 0 } },
      },
    },
    { id: 'near-expiry-close', action: 'close_price', instrument: 'stock', date: '2026-03-20', value: 48.00, expect: {} },
    {
      // 20 March, close 48: the near call lapses (its 750 premium is realized); the far calls remain, with their expiry
      // item on 17 April. Realized -30 + 750 = 720.
      id: 'near-expiry', covers: ['expiry', 'far leg remains'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [{ type: 'option.expired', summary: 'Expired worthless: 5 PMF260320C50 (fixing 48)', date: '2026-03-20' }],
        positions: [
          { instrument: 'apr50', lot: 'accept', qty: 1, value: 255, unrealized: -5 },
          { instrument: 'apr50', lot: 'calendar', owner: 'account', direction: 'long', qty: 5, avgCost: 2.60, cost: 1_300, price: 2.55, value: 1_275, unrealized: -25 },
        ],
        holdings: { mar50: null },
        lifecycle: [{ type: 'option.expiry', instrument: 'apr50', dueDate: '2026-04-17', status: 'pending' }, { type: 'option.expiry', instrument: 'apr50', dueDate: '2026-04-17', status: 'pending' }],
        pnl: { account: { realized: 720, commissions: -11.05, unrealized: -30, total: 678.95 }, book: { realized: 720, commissions: -11.05, unrealized: -30, total: 678.95 } },
        nav: { account: 2_982.20, book: 1_000_678.95 }, // 1,452.20 + 1,530
        balance: { account: { positions: 1_530, assets: 2_982.20, netAssets: 2_982.20 }, book: { positions: 1_530, assets: 1_000_678.95, netAssets: 1_000_678.95 } },
      },
    },
    { id: 'after-good-friday', covers: 'holiday', action: 'clock', to: APR(6), expect: {} },
    {
      id: 'apr50-quote', action: 'quote', instrument: 'apr50', quote: { bid: 1.20, ask: 1.30, last: 1.25, bidSize: 20, askSize: 20 },
      expect: {
        positions: [{ instrument: 'apr50', lot: 'accept', price: 1.25, value: 125, unrealized: -135 }, { instrument: 'apr50', lot: 'calendar', price: 1.25, value: 625, unrealized: -675 }],
        pnl: { account: { unrealized: -810, total: -101.05 }, book: { unrealized: -810, total: -101.05 } },
        nav: { account: 2_202.20, book: 999_898.95 },
        balance: { account: { positions: 750, assets: 2_202.20, netAssets: 2_202.20 }, book: { positions: 750, assets: 999_898.95, netAssets: 999_898.95 } },
      },
    },
    {
      // The far call that remains: 5 sold at 1.20 = 600, commission 3.25. Realized 5 x (1.20 - 2.60) x 100 = -700.
      id: 'close-calendar', covers: ['close'], action: 'close', lot: 'calendar', instrument: 'apr50', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], intent: 'close', legs: [{ kind: 'trade', action: 'sell', instrument: 'apr50', qty: 5, estimate: 1.20, settleDate: '2026-04-07', cash: 600, fees: 3.25 }] },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'apr50', status: 'filled', filledQty: 5, avgPrice: 1.20 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 5 PMF260417C50 @ 1.20 USD (realized -700.00 USD)', date: '2026-04-06' }],
        cash: { account: { USD: { settled: 1_452.20, unsettled: 596.75, availableToTrade: 2_048.95, availableToWithdraw: 1_452.20 } } },
        positions: [{ instrument: 'apr50', lot: 'accept', value: 125 }],
        holdings: { apr50: { long: 1, short: 0, net: 1 } },
        pending: [{ instrument: 'apr50', lot: 'calendar', dueDate: '2026-04-07', amount: 596.75, into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'apr50' }],
        pnl: { account: { realized: 20, commissions: -14.30, unrealized: -135, total: -129.30 }, book: { realized: 20, commissions: -14.30, unrealized: -135, total: -129.30 } },
        nav: { account: 2_173.95, book: 999_870.70 },
        balance: {
          account: { cash: 1_452.20, receivable: 596.75, positions: 125, assets: 2_173.95, netAssets: 2_173.95 },
          book: { cash: 999_148.95, receivable: 596.75, positions: 125, assets: 999_870.70, netAssets: 999_870.70 },
        },
      },
    },
    {
      id: 'close-accept', covers: ['close'], action: 'close', lot: 'accept', instrument: 'apr50', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', instrument: 'apr50', qty: 1, estimate: 1.20, settleDate: '2026-04-07', cash: 120, fees: 0.65 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1, avgPrice: 1.20 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 PMF260417C50 @ 1.20 USD (realized -140.00 USD)' }],
        cash: { account: { USD: { settled: 1_452.20, unsettled: 716.10, availableToTrade: 2_168.30, availableToWithdraw: 1_452.20 } } },
        positions: [],
        holdings: { apr50: null },
        pending: [{ instrument: 'apr50', lot: 'accept', dueDate: '2026-04-07', amount: 119.35 }, { instrument: 'apr50', lot: 'calendar', dueDate: '2026-04-07', amount: 596.75 }],
        lifecycle: [],
        pnl: { account: { realized: -120, commissions: -14.95, unrealized: 0, total: -134.95 }, book: { realized: -120, commissions: -14.95, unrealized: 0, total: -134.95 } },
        nav: { account: 2_168.30, book: 999_865.05 },
        balance: {
          account: { cash: 1_452.20, receivable: 716.10, positions: null, assets: 2_168.30, netAssets: 2_168.30 },
          book: { cash: 999_148.95, receivable: 716.10, positions: null, assets: 999_865.05, netAssets: 999_865.05 },
        },
      },
    },
    {
      // Nothing left: 1,000 + 303.25 + 1,000 funded, less 134.95.
      id: 'settle-final', covers: 'settlement', action: 'clock', to: APR(7),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 596.75 USD into settled cash', date: '2026-04-07' }, { type: 'settlement.receive', summary: 'received 119.35 USD into settled cash' }],
        cash: { account: { USD: { settled: 2_168.30, unsettled: 0, reserved: 0, availableToTrade: 2_168.30, availableToWithdraw: 2_168.30 } } },
        pending: [],
        balance: { account: { cash: 2_168.30, receivable: null, assets: 2_168.30 }, book: { cash: 999_865.05, receivable: null, assets: 999_865.05 } },
      },
    },
  ],
};

// =====================================================================================================================
// long_diagonal
// =====================================================================================================================
// Quillan Mining (NYSE) puts, physical delivery: sell the 20 March 2026 45 put, buy the 17 April 2026 40 put, 5 each.
// The near put depends on the far put. The far put outlives it and covers it below 40, so the reserve is the width,
// 5 x 100 x (45 - 40) = 2,500, not the full strike value of the written put (5 x 100 x 45 = 22,500).
//   diagonal  refused short of cash, then Treasury funding; the far put fills 3 of 5 first and the near put follows. On
//             20 March the stock closes at 46: the near put lapses, its reserve is released, and the far put remains,
//             held over Good Friday and sold on 6 April.
//   retry / accept / unwind  1 each when the near put has no fresh quote. Accept keeps a far put alone.
const DIAG_PAGE = (contracts, financing) => ({ template: 'Long Diagonal Spread', underlying: 'stock', expiration: '2026-03-20', farExpiration: '2026-04-17', right: 'P', strikes: { 'Near-dated strike (sold)': 45, 'Far-dated strike (bought)': 40 }, contracts, ...(financing ? { financing } : {}) });
const diagInput = (contracts, financing) => templateInput('long_diagonal', { underlyingId: '$inst:stock', options: { expiration: '2026-03-20', farExpiration: '2026-04-17', right: 'P', strikes: { near: 45, far: 40 }, contracts }, financing });
const diagOne = (as) => ({ action: 'package', as, instrument: 'stock', input: diagInput(1, null), strategyPage: DIAG_PAGE(1, null) });
const longDiagonal = {
  template: 'long_diagonal',
  title: 'Long diagonal put spread on Quillan Mining (NYSE): sell the 20 March 2026 45 put, buy the 17 April 2026 40 put',
  matrix: {
    ...OPTION_TEMPLATE_MATRIX,
    requiredFields: [...OPTION_TEMPLATE_MATRIX.requiredFields, 'Far expiration', 'Built from (calls or puts)'],
    settlement: 'Premium of each leg T+1 on the US calendar; Treasury funding moves at once',
    lifecycle: 'The near put\'s expiry item on 20 March 2026 (close 46: it lapses, its reserve is released) while the far put remains with its own expiry item on 17 April; held across Good Friday and sold; a failed dependent leg leaves the instance needing attention: Retry, Unwind or Accept',
    accounting: 'Net credit received; commission expensed; premium realized on buy-back, sale and lapse; after the near expiry the instance holds the far put alone',
    collateral: 'The far 40 put covers the written 45 put below 40: the width is reserved (2,500 for 5), not the written put\'s strike value; released when the near put lapses',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: ['2026-04-03'] },
  book: book('Templates long diagonal'),
  instruments: {
    stock: stockDraft('Quillan Mining Corp.', 'QLM'),
    mar45: equityOption('QLM', 'QLM260320P45', 'P', 45, '2026-03-20'),
    apr40: equityOption('QLM', 'QLM260417P40', 'P', 40, '2026-04-17'),
  },
  quotes: {
    stock: { bid: 45.98, ask: 46.02, last: 46.00, bidSize: 10000, askSize: 10000 },
    mar45: { bid: 1.60, ask: 1.70, last: 1.65, bidSize: 20, askSize: 20 },
    apr40: { bid: 0.90, ask: 1.00, last: 0.95, bidSize: 20, askSize: 3 }, // only 3 contracts displayed at the ask
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
      // 500 for the far puts (5 x 1.00 x 100) + 6.50 + 2,500 reserved, against 800 (5 x 1.60 x 100) and 1,000: 1,206.50
      // short, netted and leg by leg alike (the far put is bought first: 1,000 - 503.25 + 796.75 - 2,500).
      id: 'open-short-of-cash', covers: 'financing', action: 'package', as: 'refused', instrument: 'stock',
      input: diagInput(5, null), strategyPage: DIAG_PAGE(5, null),
      status: 'blocked', reason: 'The Account cannot fund the package: the preview is blocked until financing is chosen.',
      expect: {
        refused: 'Alpha is short 1,206.50 USD',
        preview: {
          blocking: 1, errors: ['cash'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'apr40', qty: 5, estimate: 1.00, settleDate: '2026-03-03', cash: -500, fees: 3.25, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'mar45', qty: 5, estimate: 1.60, settleDate: '2026-03-03', cash: 800, fees: 3.25, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 500, proceeds: 800, fees: 6.50, reserved: 2_500, required: 3_006.50, available: 1_000, shortfall: 1_206.50 } },
        },
      },
    },
    {
      id: 'open', covers: ['open', 'financing', 'partial fill', 'dependency'], action: 'package', as: 'diagonal', instrument: 'stock',
      input: diagInput(5, { mode: 'treasury' }), strategyPage: DIAG_PAGE(5, { mode: 'treasury' }),
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', purpose: 'financing', qty: 1_206.50, cash: 1_206.50, dependsOn: [] },
            { kind: 'trade', action: 'buy', instrument: 'apr40', qty: 5, estimate: 1.00, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -500, fees: 3.25, dependsOn: [1] },
            { kind: 'trade', action: 'sell', instrument: 'mar45', qty: 5, estimate: 1.60, settleDate: '2026-03-03', cash: 800, fees: 3.25, dependsOn: [2, 1] },
          ],
          cash: { USD: { purchases: 500, proceeds: 800, fees: 6.50, reserved: 2_500, financingIn: 1_206.50, required: 3_006.50, available: 1_000, shortfall: 0, netCash: 1_500 } },
          netPremium: { amount: -300, ccy: 'USD', type: 'credit', complete: true },
          optionRequirement: [{ ccy: 'USD', amount: 2_500, finite: 2_500, naked: 0, uncoveredCallUnits: 0 }],
        },
        result: {
          status: 'partial',
          orders: [
            { kind: 'funding', status: 'filled', filledQty: 1_206.50 },
            { action: 'buy', instrument: 'apr40', status: 'partial', filledQty: 3, avgPrice: 1.00 },
            { action: 'sell', instrument: 'mar45', status: 'partial', filledQty: 3, avgPrice: 1.60 },
          ],
        },
        events: [
          { type: 'strategy.submitted' },
          { type: 'transfer.funding', summary: 'Treasury funding: 1,206.50 USD from Treasury to Alpha' },
          { type: 'trade.fill', summary: 'Bought 3 QLM260417P40 @ 1.00 USD', date: '2026-03-02' },
          { type: 'trade.fill', summary: 'Sold 3 QLM260320P45 @ 1.60 USD' },
          { type: 'trade.fill', summary: 'Bought 2 QLM260417P40 @ 1.00 USD' },
          { type: 'trade.fill', summary: 'Sold 2 QLM260320P45 @ 1.60 USD' },
        ],
        cash: {
          // owed 301.95 + 201.30 = 503.25; owed to it 478.05 + 318.70 = 796.75; reserved 2,500
          account: { USD: { settled: 2_206.50, unsettled: 293.50, reserved: 2_500, availableToTrade: 0, availableToWithdraw: -796.75 } },
          treasury: { USD: { settled: 997_793.50, unsettled: 0, availableToTrade: 997_793.50, availableToWithdraw: 997_793.50 } },
        },
        positions: [
          { instrument: 'apr40', lot: 'diagonal', owner: 'account', direction: 'long', qty: 5, avgCost: 1.00, cost: 500, price: 0.95, value: 475, unrealized: -25 },
          { instrument: 'mar45', lot: 'diagonal', owner: 'account', direction: 'short', qty: -5, avgCost: 1.60, cost: -800, price: 1.65, value: -825, unrealized: -25 },
        ],
        holdings: { apr40: { long: 5, short: 0, net: 5 }, mar45: { long: 0, short: 5, net: -5 } },
        pending: [
          { instrument: 'apr40', lot: 'diagonal', dueDate: '2026-03-03', amount: -301.95, into: 'cash' },
          { instrument: 'apr40', lot: 'diagonal', dueDate: '2026-03-03', amount: -201.30, into: 'cash' },
          { instrument: 'mar45', lot: 'diagonal', dueDate: '2026-03-03', amount: 318.70, into: 'cash' },
          { instrument: 'mar45', lot: 'diagonal', dueDate: '2026-03-03', amount: 478.05, into: 'cash' },
        ],
        lifecycle: [
          { type: 'option.expiry', instrument: 'mar45', dueDate: '2026-03-20', status: 'pending' },
          { type: 'option.expiry', instrument: 'apr40', dueDate: '2026-04-17', status: 'pending' },
        ],
        pnl: {
          account: { realized: 0, commissions: -6.50, fees: 0, unrealized: -50, total: -56.50 },
          book: { realized: 0, commissions: -6.50, unrealized: -50, total: -56.50 },
          treasury: { total: 0 },
        },
        nav: { account: 2_150, treasury: 997_793.50, book: 999_943.50 },
        balance: {
          account: { cash: 2_206.50, receivable: 796.75, payable: 503.25, positions: -350, assets: 2_653.25, liabilities: 503.25, netAssets: 2_150 },
          treasury: { cash: 997_793.50, assets: 997_793.50, liabilities: 0, netAssets: 997_793.50 },
          book: { cash: 1_000_000, receivable: 796.75, payable: 503.25, positions: -350, assets: 1_000_446.75, liabilities: 503.25, netAssets: 999_943.50 },
        },
      },
    },
    {
      id: 'settle-open', covers: 'settlement', action: 'clock', to: MAR(3),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 478.05 USD into settled cash', date: '2026-03-03' },
          { type: 'settlement.receive', summary: 'received 318.70 USD into settled cash' },
          { type: 'settlement.pay', summary: 'paid 301.95 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 201.30 USD from settled cash' },
        ],
        cash: { account: { USD: { settled: 2_500, unsettled: 0, availableToTrade: 0, availableToWithdraw: 0 } } },
        pending: [],
        balance: { account: { cash: 2_500, receivable: null, payable: null, assets: 2_150, liabilities: 0 }, book: { cash: 1_000_293.50, receivable: null, payable: null, assets: 999_943.50, liabilities: 0 } },
      },
    },
    {
      id: 'fund-account', covers: 'internal funding', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 2_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 2,000.00 USD from Treasury to Alpha' }],
        cash: { account: { USD: { settled: 4_500, availableToTrade: 2_000, availableToWithdraw: 2_000 } }, treasury: { USD: { settled: 995_793.50, availableToTrade: 995_793.50, availableToWithdraw: 995_793.50 } } },
        nav: { account: 4_150, treasury: 995_793.50 },
        balance: { account: { cash: 4_500, assets: 4_150, netAssets: 4_150 }, treasury: { cash: 995_793.50, assets: 995_793.50, netAssets: 995_793.50 } },
      },
    },
    { id: 'mar45-quote-stops', action: 'quote', instrument: 'mar45', quote: { bid: 1.60, ask: 1.70, last: 1.65, bidSize: 20, askSize: 20, asOf: MAR(3, '09:50') }, expect: {} },
    {
      ...diagOne('retry'), id: 'open-retry', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: {
          blocking: 0, warnings: ['not-executable'],
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'apr40', qty: 1, estimate: 1.00, settleDate: '2026-03-04', cash: -100, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'mar45', qty: 1, estimate: null, reference: 1.65, executable: false, settleDate: '2026-03-04', cash: 165, fees: 0.65, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 100, proceeds: 165, fees: 1.30, reserved: 500, required: 601.30, available: 2_000, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ instrument: 'apr40', status: 'filled', filledQty: 1, avgPrice: 1.00 }, { instrument: 'mar45', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 QLM260417P40 @ 1.00 USD', date: '2026-03-03' }],
        cash: { account: { USD: { settled: 4_500, unsettled: -100.65, reserved: 2_500, availableToTrade: 1_899.35, availableToWithdraw: 1_899.35 } } },
        positions: [
          { instrument: 'apr40', lot: 'diagonal', value: 475 },
          { instrument: 'apr40', lot: 'retry', owner: 'account', direction: 'long', qty: 1, avgCost: 1.00, cost: 100, price: 0.95, value: 95, unrealized: -5 },
          { instrument: 'mar45', lot: 'diagonal', value: -825 },
        ],
        holdings: { apr40: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'apr40', lot: 'retry', dueDate: '2026-03-04', amount: -100.65 }],
        openOrders: [{ instrument: 'mar45', kind: 'trade', action: 'sell', status: 'working', qty: 1, filledQty: 0 }],
        lifecycle: [{ instrument: 'mar45' }, { instrument: 'apr40' }, { instrument: 'apr40' }],
        pnl: { account: { commissions: -7.15, unrealized: -55, total: -62.15 }, book: { commissions: -7.15, unrealized: -55, total: -62.15 } },
        nav: { account: 4_144.35, book: 999_937.85 },
        balance: {
          account: { cash: 4_500, payable: 100.65, positions: -255, assets: 4_245, liabilities: 100.65, netAssets: 4_144.35 },
          book: { cash: 1_000_293.50, payable: 100.65, positions: -255, assets: 1_000_038.50, liabilities: 100.65, netAssets: 999_937.85 },
        },
      },
    },
    {
      ...diagOne('accept'), id: 'open-accept', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'apr40', qty: 1 }, { instrument: 'mar45', qty: 1, estimate: null, dependsOn: [1] }], cash: { USD: { required: 601.30, available: 1_899.35, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ instrument: 'apr40', status: 'filled' }, { instrument: 'mar45', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 QLM260417P40 @ 1.00 USD' }],
        cash: { account: { USD: { settled: 4_500, unsettled: -201.30, availableToTrade: 1_798.70, availableToWithdraw: 1_798.70 } } },
        positions: [{ instrument: 'apr40', lot: 'accept', value: 95 }, { instrument: 'apr40', lot: 'diagonal' }, { instrument: 'apr40', lot: 'retry' }, { instrument: 'mar45', lot: 'diagonal' }],
        holdings: { apr40: { long: 7, short: 0, net: 7 } },
        pending: [{ lot: 'accept', amount: -100.65 }, { lot: 'retry', amount: -100.65 }],
        openOrders: [{ instrument: 'mar45', status: 'working' }, { instrument: 'mar45', status: 'working' }],
        lifecycle: [{ instrument: 'mar45' }, { instrument: 'apr40' }, { instrument: 'apr40' }, { instrument: 'apr40' }],
        pnl: { account: { commissions: -7.80, unrealized: -60, total: -67.80 }, book: { commissions: -7.80, unrealized: -60, total: -67.80 } },
        nav: { account: 4_138.70, book: 999_932.20 },
        balance: {
          account: { cash: 4_500, payable: 201.30, positions: -160, assets: 4_340, liabilities: 201.30, netAssets: 4_138.70 },
          book: { cash: 1_000_293.50, payable: 201.30, positions: -160, assets: 1_000_133.50, liabilities: 201.30, netAssets: 999_932.20 },
        },
      },
    },
    {
      ...diagOne('unwind'), id: 'open-unwind', covers: ['open', 'failed dependent leg'],
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'apr40', qty: 1 }, { instrument: 'mar45', qty: 1, estimate: null }], cash: { USD: { required: 601.30, available: 1_798.70, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ instrument: 'apr40', status: 'filled' }, { instrument: 'mar45', status: 'working' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 QLM260417P40 @ 1.00 USD' }],
        cash: { account: { USD: { settled: 4_500, unsettled: -301.95, availableToTrade: 1_698.05, availableToWithdraw: 1_698.05 } } },
        positions: [{ instrument: 'apr40', lot: 'accept' }, { instrument: 'apr40', lot: 'diagonal' }, { instrument: 'apr40', lot: 'retry' }, { instrument: 'apr40', lot: 'unwind', value: 95 }, { instrument: 'mar45', lot: 'diagonal' }],
        holdings: { apr40: { long: 8, short: 0, net: 8 } },
        pending: [{ lot: 'accept' }, { lot: 'retry' }, { lot: 'unwind', amount: -100.65 }],
        openOrders: [{ instrument: 'mar45', status: 'working' }, { instrument: 'mar45', status: 'working' }, { instrument: 'mar45', status: 'working' }],
        lifecycle: [{ instrument: 'mar45' }, { instrument: 'apr40' }, { instrument: 'apr40' }, { instrument: 'apr40' }, { instrument: 'apr40' }],
        pnl: { account: { commissions: -8.45, unrealized: -65, total: -73.45 }, book: { commissions: -8.45, unrealized: -65, total: -73.45 } },
        nav: { account: 4_133.05, book: 999_926.55 },
        balance: {
          account: { cash: 4_500, payable: 301.95, positions: -65, assets: 4_435, liabilities: 301.95, netAssets: 4_133.05 },
          book: { cash: 1_000_293.50, payable: 301.95, positions: -65, assets: 1_000_228.50, liabilities: 301.95, netAssets: 999_926.55 },
        },
      },
    },
    {
      id: 'near-legs-expire', covers: ['failed dependent leg', 'settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'paid 100.65 USD from settled cash', date: '2026-03-04' },
          { type: 'settlement.pay', summary: 'paid 100.65 USD from settled cash' },
          { type: 'settlement.pay', summary: 'paid 100.65 USD from settled cash' },
          { type: 'order.expired', summary: 'Leg 2 expired: sell 1 QLM260320P45. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 2 expired: sell 1 QLM260320P45. Day order did not fill before the end of the business day' },
          { type: 'order.expired', summary: 'Leg 2 expired: sell 1 QLM260320P45. Day order did not fill before the end of the business day' },
        ],
        cash: { account: { USD: { settled: 4_198.05, unsettled: 0, availableToTrade: 1_698.05, availableToWithdraw: 1_698.05 } } },
        pending: [], openOrders: [],
        failed: { orders: 3 },
        alerts: ['strategy.attention', 'strategy.attention', 'strategy.attention'],
        balance: { account: { cash: 4_198.05, payable: null, assets: 4_133.05, liabilities: 0 }, book: { cash: 999_991.55, payable: null, assets: 999_926.55, liabilities: 0 } },
      },
    },
    {
      id: 'mar45-quote-day3', action: 'quote', instrument: 'mar45', quote: { bid: 1.40, ask: 1.50, last: 1.45, bidSize: 20, askSize: 20 },
      expect: {
        positions: [{ instrument: 'apr40', lot: 'accept' }, { instrument: 'apr40', lot: 'diagonal' }, { instrument: 'apr40', lot: 'retry' }, { instrument: 'apr40', lot: 'unwind' }, { instrument: 'mar45', lot: 'diagonal', price: 1.45, value: -725, unrealized: 75 }],
        pnl: { account: { unrealized: 35, total: 26.55 }, book: { unrealized: 35, total: 26.55 } },
        nav: { account: 4_233.05, book: 1_000_026.55 },
        balance: { account: { positions: 35, assets: 4_233.05, netAssets: 4_233.05 }, book: { positions: 35, assets: 1_000_026.55, netAssets: 1_000_026.55 } },
      },
    },
    {
      // Retry sells the near put at 1.40 (139.35 after commission) and reserves the width for one contract, 500.
      id: 'retry', covers: ['retry', 'failed dependent leg'], action: 'recover', how: 'retry', lot: 'retry',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'retry', legs: [{ kind: 'trade', action: 'sell', instrument: 'mar45', qty: 1, estimate: 1.40, settleDate: '2026-03-05', cash: 140, fees: 0.65 }], cash: { USD: { proceeds: 140, fees: 0.65, reserved: 500, required: 500.65, available: 1_698.05, shortfall: 0 } }, optionRequirement: [{ ccy: 'USD', amount: 500, finite: 500, naked: 0, uncoveredCallUnits: 0 }] },
        result: { status: 'open', complete: true, orders: [{ action: 'sell', instrument: 'mar45', status: 'filled', filledQty: 1, avgPrice: 1.40 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 QLM260320P45 @ 1.40 USD', date: '2026-03-04' }],
        cash: { account: { USD: { settled: 4_198.05, unsettled: 139.35, reserved: 3_000, availableToTrade: 1_337.40, availableToWithdraw: 1_198.05 } } },
        positions: [
          { instrument: 'apr40', lot: 'accept' }, { instrument: 'apr40', lot: 'diagonal' }, { instrument: 'apr40', lot: 'retry' }, { instrument: 'apr40', lot: 'unwind' },
          { instrument: 'mar45', lot: 'diagonal', value: -725 }, { instrument: 'mar45', lot: 'retry', owner: 'account', direction: 'short', qty: -1, avgCost: 1.40, cost: -140, price: 1.45, value: -145, unrealized: -5 },
        ],
        holdings: { mar45: { long: 0, short: 6, net: -6 } },
        pending: [{ instrument: 'mar45', lot: 'retry', dueDate: '2026-03-05', amount: 139.35 }],
        lifecycle: [{ instrument: 'mar45' }, { instrument: 'mar45' }, { instrument: 'apr40' }, { instrument: 'apr40' }, { instrument: 'apr40' }, { instrument: 'apr40' }],
        alerts: ['strategy.attention', 'strategy.attention'],
        pnl: { account: { commissions: -9.10, unrealized: 30, total: 20.90 }, book: { commissions: -9.10, unrealized: 30, total: 20.90 } },
        nav: { account: 4_227.40, book: 1_000_020.90 },
        balance: {
          account: { cash: 4_198.05, receivable: 139.35, positions: -110, assets: 4_227.40, liabilities: 0, netAssets: 4_227.40 },
          book: { cash: 999_991.55, receivable: 139.35, positions: -110, assets: 1_000_020.90, netAssets: 1_000_020.90 },
        },
      },
    },
    {
      id: 'accept', covers: ['accept', 'failed dependent leg'], action: 'strategy_action', lot: 'accept', how: 'accept',
      expect: { events: [{ type: 'strategy.accepted', summary: 'accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: ['strategy.attention'] },
    },
    {
      id: 'unwind', covers: ['unwind', 'close'], action: 'recover', how: 'unwind', lot: 'unwind',
      expect: {
        preview: { blocking: 0, errors: [], intent: 'unwind', legs: [{ kind: 'trade', action: 'sell', instrument: 'apr40', qty: 1, estimate: 0.90, settleDate: '2026-03-05', cash: 90, fees: 0.65, dependsOn: [] }] },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'apr40', status: 'filled', filledQty: 1, avgPrice: 0.90 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 QLM260417P40 @ 0.90 USD (realized -10.00 USD)' }],
        cash: { account: { USD: { settled: 4_198.05, unsettled: 228.70, availableToTrade: 1_426.75, availableToWithdraw: 1_198.05 } } },
        positions: [
          { instrument: 'apr40', lot: 'accept' }, { instrument: 'apr40', lot: 'diagonal' }, { instrument: 'apr40', lot: 'retry' },
          { instrument: 'mar45', lot: 'diagonal' }, { instrument: 'mar45', lot: 'retry' },
        ],
        holdings: { apr40: { long: 7, short: 0, net: 7 } },
        pending: [{ instrument: 'apr40', lot: 'unwind', dueDate: '2026-03-05', amount: 89.35 }, { instrument: 'mar45', lot: 'retry', amount: 139.35 }],
        lifecycle: [{ instrument: 'mar45' }, { instrument: 'mar45' }, { instrument: 'apr40' }, { instrument: 'apr40' }, { instrument: 'apr40' }],
        alerts: [],
        pnl: { account: { realized: -10, commissions: -9.75, unrealized: 35, total: 15.25 }, book: { realized: -10, commissions: -9.75, unrealized: 35, total: 15.25 } },
        nav: { account: 4_221.75, book: 1_000_015.25 },
        balance: {
          account: { cash: 4_198.05, receivable: 228.70, positions: -205, assets: 4_221.75, liabilities: 0, netAssets: 4_221.75 },
          book: { cash: 999_991.55, receivable: 228.70, positions: -205, assets: 1_000_015.25, netAssets: 1_000_015.25 },
        },
      },
    },
    {
      id: 'settle-recovery', covers: 'settlement', action: 'clock', to: MAR(5),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 139.35 USD into settled cash', date: '2026-03-05' }, { type: 'settlement.receive', summary: 'received 89.35 USD into settled cash' }],
        cash: { account: { USD: { settled: 4_426.75, unsettled: 0, availableToTrade: 1_426.75, availableToWithdraw: 1_426.75 } } },
        pending: [],
        balance: { account: { cash: 4_426.75, receivable: null, assets: 4_221.75 }, book: { cash: 1_000_220.25, receivable: null, assets: 1_000_015.25 } },
      },
    },
    {
      // Close "retry": the near put is bought back first at 1.50, then the far put is sold at 0.90. -10 each.
      id: 'close-retry', covers: ['close', 'dependency'], action: 'close', lot: 'retry', instrument: 'apr40', scope: 'strategy', percent: 100,
      expect: {
        preview: {
          blocking: 0, errors: [], intent: 'close',
          legs: [
            { kind: 'trade', action: 'buy', instrument: 'mar45', qty: 1, estimate: 1.50, settleDate: '2026-03-06', cash: -150, fees: 0.65, dependsOn: [] },
            { kind: 'trade', action: 'sell', instrument: 'apr40', qty: 1, estimate: 0.90, settleDate: '2026-03-06', cash: 90, fees: 0.65, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 150, proceeds: 90, fees: 1.30, reserved: 0, required: 151.30, available: 1_426.75, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ instrument: 'mar45', status: 'filled' }, { instrument: 'apr40', status: 'filled' }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'trade.fill', summary: 'Bought 1 QLM260320P45 @ 1.50 USD (realized -10.00 USD)' },
          { type: 'trade.fill', summary: 'Sold 1 QLM260417P40 @ 0.90 USD (realized -10.00 USD)' },
        ],
        cash: { account: { USD: { settled: 4_426.75, unsettled: -61.30, reserved: 2_500, availableToTrade: 1_865.45, availableToWithdraw: 1_776.10 } } },
        positions: [{ instrument: 'apr40', lot: 'accept', value: 95 }, { instrument: 'apr40', lot: 'diagonal', value: 475 }, { instrument: 'mar45', lot: 'diagonal', value: -725 }],
        holdings: { apr40: { long: 6, short: 0, net: 6 }, mar45: { long: 0, short: 5, net: -5 } },
        pending: [{ instrument: 'apr40', lot: 'retry', dueDate: '2026-03-06', amount: 89.35 }, { instrument: 'mar45', lot: 'retry', dueDate: '2026-03-06', amount: -150.65 }],
        lifecycle: [{ instrument: 'mar45' }, { instrument: 'apr40' }, { instrument: 'apr40' }],
        pnl: { account: { realized: -30, commissions: -11.05, unrealized: 45, total: 3.95 }, book: { realized: -30, commissions: -11.05, unrealized: 45, total: 3.95 } },
        nav: { account: 4_210.45, book: 1_000_003.95 },
        balance: {
          account: { cash: 4_426.75, receivable: 89.35, payable: 150.65, positions: -155, assets: 4_361.10, liabilities: 150.65, netAssets: 4_210.45 },
          book: { cash: 1_000_220.25, receivable: 89.35, payable: 150.65, positions: -155, assets: 1_000_154.60, liabilities: 150.65, netAssets: 1_000_003.95 },
        },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: MAR(6),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 89.35 USD into settled cash', date: '2026-03-06' }, { type: 'settlement.pay', summary: 'paid 150.65 USD from settled cash' }],
        cash: { account: { USD: { settled: 4_365.45, unsettled: 0, availableToTrade: 1_865.45, availableToWithdraw: 1_865.45 } } },
        pending: [],
        balance: { account: { cash: 4_365.45, receivable: null, payable: null, assets: 4_210.45, liabilities: 0 }, book: { cash: 1_000_158.95, receivable: null, payable: null, assets: 1_000_003.95, liabilities: 0 } },
      },
    },
    { id: 'near-expiry-close', action: 'close_price', instrument: 'stock', date: '2026-03-20', value: 46.00, expect: {} },
    {
      // 20 March, close 46: the near 45 put lapses (its 800 premium is realized) and its 2,500 reserve is released; the
      // far 40 puts remain. Realized -30 + 800 = 770.
      id: 'near-expiry', covers: ['expiry', 'far leg remains', 'reserve release'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [{ type: 'option.expired', summary: 'Expired worthless: 5 QLM260320P45 (fixing 46)', date: '2026-03-20' }],
        cash: { account: { USD: { settled: 4_365.45, reserved: 0, availableToTrade: 4_365.45, availableToWithdraw: 4_365.45 } } },
        positions: [
          { instrument: 'apr40', lot: 'accept', qty: 1, value: 95, unrealized: -5 },
          { instrument: 'apr40', lot: 'diagonal', owner: 'account', direction: 'long', qty: 5, avgCost: 1.00, cost: 500, price: 0.95, value: 475, unrealized: -25 },
        ],
        holdings: { mar45: null },
        lifecycle: [{ type: 'option.expiry', instrument: 'apr40', dueDate: '2026-04-17', status: 'pending' }, { type: 'option.expiry', instrument: 'apr40', dueDate: '2026-04-17', status: 'pending' }],
        pnl: { account: { realized: 770, commissions: -11.05, unrealized: -30, total: 728.95 }, book: { realized: 770, commissions: -11.05, unrealized: -30, total: 728.95 } },
        nav: { account: 4_935.45, book: 1_000_728.95 }, // 4,365.45 + 570
        balance: { account: { positions: 570, assets: 4_935.45, netAssets: 4_935.45 }, book: { positions: 570, assets: 1_000_728.95, netAssets: 1_000_728.95 } },
      },
    },
    { id: 'after-good-friday', covers: 'holiday', action: 'clock', to: APR(6), expect: {} },
    {
      id: 'apr40-quote', action: 'quote', instrument: 'apr40', quote: { bid: 0.40, ask: 0.50, last: 0.45, bidSize: 20, askSize: 20 },
      expect: {
        positions: [{ instrument: 'apr40', lot: 'accept', price: 0.45, value: 45, unrealized: -55 }, { instrument: 'apr40', lot: 'diagonal', price: 0.45, value: 225, unrealized: -275 }],
        pnl: { account: { unrealized: -330, total: 428.95 }, book: { unrealized: -330, total: 428.95 } },
        nav: { account: 4_635.45, book: 1_000_428.95 },
        balance: { account: { positions: 270, assets: 4_635.45, netAssets: 4_635.45 }, book: { positions: 270, assets: 1_000_428.95, netAssets: 1_000_428.95 } },
      },
    },
    {
      // The far put that remains: 5 sold at 0.40 = 200, commission 3.25. Realized 5 x (0.40 - 1.00) x 100 = -300.
      id: 'close-diagonal', covers: ['close'], action: 'close', lot: 'diagonal', instrument: 'apr40', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, errors: [], intent: 'close', legs: [{ kind: 'trade', action: 'sell', instrument: 'apr40', qty: 5, estimate: 0.40, settleDate: '2026-04-07', cash: 200, fees: 3.25 }] },
        result: { status: 'closed', orders: [{ action: 'sell', instrument: 'apr40', status: 'filled', filledQty: 5, avgPrice: 0.40 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 5 QLM260417P40 @ 0.40 USD (realized -300.00 USD)', date: '2026-04-06' }],
        cash: { account: { USD: { settled: 4_365.45, unsettled: 196.75, availableToTrade: 4_562.20, availableToWithdraw: 4_365.45 } } },
        positions: [{ instrument: 'apr40', lot: 'accept', value: 45 }],
        holdings: { apr40: { long: 1, short: 0, net: 1 } },
        pending: [{ instrument: 'apr40', lot: 'diagonal', dueDate: '2026-04-07', amount: 196.75, into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'apr40' }],
        pnl: { account: { realized: 470, commissions: -14.30, unrealized: -55, total: 400.70 }, book: { realized: 470, commissions: -14.30, unrealized: -55, total: 400.70 } },
        nav: { account: 4_607.20, book: 1_000_400.70 },
        balance: {
          account: { cash: 4_365.45, receivable: 196.75, positions: 45, assets: 4_607.20, netAssets: 4_607.20 },
          book: { cash: 1_000_158.95, receivable: 196.75, positions: 45, assets: 1_000_400.70, netAssets: 1_000_400.70 },
        },
      },
    },
    {
      id: 'close-accept', covers: ['close'], action: 'close', lot: 'accept', instrument: 'apr40', scope: 'strategy', percent: 100,
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', instrument: 'apr40', qty: 1, estimate: 0.40, settleDate: '2026-04-07', cash: 40, fees: 0.65 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1, avgPrice: 0.40 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1 QLM260417P40 @ 0.40 USD (realized -60.00 USD)' }],
        cash: { account: { USD: { settled: 4_365.45, unsettled: 236.10, availableToTrade: 4_601.55, availableToWithdraw: 4_365.45 } } },
        positions: [],
        holdings: { apr40: null },
        pending: [{ instrument: 'apr40', lot: 'accept', dueDate: '2026-04-07', amount: 39.35 }, { instrument: 'apr40', lot: 'diagonal', dueDate: '2026-04-07', amount: 196.75 }],
        lifecycle: [],
        pnl: { account: { realized: 410, commissions: -14.95, unrealized: 0, total: 395.05 }, book: { realized: 410, commissions: -14.95, unrealized: 0, total: 395.05 } },
        nav: { account: 4_601.55, book: 1_000_395.05 },
        balance: {
          account: { cash: 4_365.45, receivable: 236.10, positions: null, assets: 4_601.55, netAssets: 4_601.55 },
          book: { cash: 1_000_158.95, receivable: 236.10, positions: null, assets: 1_000_395.05, netAssets: 1_000_395.05 },
        },
      },
    },
    {
      // Nothing left: 1,000 + 1,206.50 + 2,000 funded, plus 395.05.
      id: 'settle-final', covers: 'settlement', action: 'clock', to: APR(7),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 196.75 USD into settled cash', date: '2026-04-07' }, { type: 'settlement.receive', summary: 'received 39.35 USD into settled cash' }],
        cash: { account: { USD: { settled: 4_601.55, unsettled: 0, reserved: 0, availableToTrade: 4_601.55, availableToWithdraw: 4_601.55 } } },
        pending: [],
        balance: { account: { cash: 4_601.55, receivable: null, assets: 4_601.55 }, book: { cash: 1_000_395.05, receivable: null, assets: 1_000_395.05 } },
      },
    },
  ],
};

export default [bearCall, longStraddle, longStrangle, ironCondor, ironButterfly, longButterfly, longCalendar, longDiagonal];
