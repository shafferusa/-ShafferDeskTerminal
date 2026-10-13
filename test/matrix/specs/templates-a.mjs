// Execution templates, first half (t1): long, short, protective put and call, covered call and put, long and short
// collar, cash-secured put, long call and put, bull call, bear put and bull put spreads. One scenario per template,
// each in its own Book, driven from the Strategies page as one linked package (legs under one strategy instance ID).
//
// Every expected number is a literal worked out by hand from the inputs in the same spec (quotes, quantities, each
// contract's multiplier and deliverable, the Book's fee schedule and assumptions). The arithmetic is in the comment
// beside it. Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be followed):
//   - A market buy fills at the ask, a market sell at the bid, of the quote in force; at most the displayed size
//     (bid or ask size x participation 1) fills in one matching cycle. A confirmation runs one matching cycle and the
//     harness runs one more after every step, so a leg larger than twice the displayed size is still working after
//     its step: a partial fill, with the remainder working.
//   - Commission is per share (0.01) or per contract (0.50) from the Book's fee schedule, no minimum, expensed.
//   - A fill books the position on trade date and leaves a payable or receivable; cash moves on the settlement date
//     (T+1 on the US calendar for shares and for option premium).
//   - A leg that depends on another (a short sale on its borrow, a written call on its shares) is scaled to what the
//     leg it depends on has filled; a required leg that ends unfilled (cancelled, expired, rejected) while another leg
//     filled leaves the package "needs attention" until it is retried, unwound or accepted as it stands.
//   - "If cash is short": Do not finance blocks the preview; Treasury funding adds an internal transfer leg sized to
//     the shortfall (rounded up to the cent); Borrow adds a margin-loan leg from a simulated lender, a liability of the
//     owner that borrowed, at the rate typed (ACT/360, accrued at each end of day).
//
// Calendar: Monday 2 March 2026 to Friday 20 March 2026 (no US market holiday; Good Friday is 3 April). US clocks move
// to daylight time on Sunday 8 March: 10:00 New York is 15:00 UTC up to 6 March and 14:00 UTC from 9 March.

export const family = 'templates';

const at = (d, t = '10:00') => {
  const [h, m] = t.split(':').map(Number);
  const off = d < 8 ? 5 : 4;
  return `2026-03-${String(d).padStart(2, '0')}T${String(h + off).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
};
const MAR = (d, t) => at(d, t);

/** The Book every template scenario starts from, stated in full so no figure rests on a default. */
const book = (name, over = {}) => ({
  name,
  reportingCcy: 'USD',
  capital: [{ ccy: 'USD', amount: 1_000_000 }],
  account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: over.funding ?? 200_000 }] },
  settings: {
    fees: { equity: { perUnit: 0.01, minimum: 0, bps: 0 }, option: { perUnit: 0.50, minimum: 0, bps: 0 } }, // 0.01 a share, 0.50 a contract
    fill: { halfSpreadBps: { equity: 2 }, optionHalfSpreadPct: 1, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 },
    settlement: { equity: 1, option: 1, foreignCash: 2 }, // T+1 for US shares and for option premium
    short: { collateralPct: 1.02, marginPct: 0.3 },
    margin: { nakedCallPct: 0.2 },
    dividends: { withholdingPct: 0 },
  },
});

/** State before any trade: 1,000,000 deposited in Treasury, `funding` of it moved to the Account. */
const startState = (funding = 200_000) => ({
  cash: {
    account: { USD: { settled: funding, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: funding, availableToWithdraw: funding } },
    treasury: { USD: { settled: 1_000_000 - funding, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 1_000_000 - funding } },
  },
  positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [],
  nav: { account: funding, treasury: 1_000_000 - funding, book: 1_000_000 },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
  alerts: [],
});

const STOCK = { productId: 'common_stock', name: 'Kestrel Logistics Inc.', symbol: 'KSTL', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Kestrel Logistics Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} };
const option = (right, strike, expiration = '2026-03-20') => ({
  productId: 'equity_option', name: `KSTL ${expiration === '2026-03-20' ? '20 March' : '17 April'} 2026 ${strike} ${right === 'C' ? 'call' : 'put'}`, symbol: `KSTL${expiration.slice(2).replace(/-/g, '')}${right}${strike}`,
  marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlying: 'main', multiplier: 100,
  terms: { right, strike, expiration, exercise: 'american', settlement: 'physical', deliverable: { units: 100 } },
});

/** The context the Strategies page sends with every package and hedge request: Investment Strategy by its listed ID, holding period, objective. */
const CONTEXT = { investmentStrategy: { id: 'DEMO-IS-002', name: 'Core Equity', resolved: true, source: 'Demo fixture, not Analytics Lab', version: 'demo-1' }, holdingPeriod: { days: 30 }, hedgeObjective: { type: 'downside_protection' } };
const NO_CONTEXT = { investmentStrategy: null, holdingPeriod: null, hedgeObjective: null };
const PAGE_CONTEXT = { investmentStrategy: 'DEMO-IS-002', holdingDays: 30, objective: 'Downside protection' };

/** The request the Strategies page sends for a template package (web/views/strategy.js, `input`). */
const pageInput = (template, rest = {}) => ({
  template, underlyingId: '$inst:main', origin: 'strategy_page', ...NO_CONTEXT, mode: 'new', hedgeRatio: rest.options ? 1 : undefined,
  borrow: null, orderType: 'market', limitPrice: null, stopPrice: null, tif: 'day', financing: null, ...rest,
});

const TEMPLATE_MATRIX = {
  requiredFields: ['Trading owner', 'Execution template', 'Ticker or instrument'],
  automaticInputs: ['bid, ask, last and displayed size (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model per leg', 'settlement date per leg from the US calendar', 'commission from the Book fee schedule', 'hedge request answered by the labelled demo fixture'],
};

// ---------------------------------------------------------------------------------------------
// long
// ---------------------------------------------------------------------------------------------
// One leg: buy the shares. Opened with a small displayed size, so it fills in parts and the remainder works; the
// remainder is cancelled (needs attention) and retried. Two more packages fill in part and are cancelled: one is
// accepted as it stands, the other unwound. The page's "If cash is short" is exercised three ways: not financed
// (blocked), funded from Treasury (an internal transfer leg linked to the package) and borrowed (a margin loan leg,
// a liability of the Account, overseen by Treasury). The first package is resized up and closed by a share, by an
// exact amount and in full; the others are closed and the loan repaid. Nothing is left held, reserved, borrowed or
// scheduled. A long holding has no expiry and no roll: the roll is refused.
const longTemplate = {
  template: 'long',
  title: 'Long template on Kestrel Logistics (NYSE common stock): partial fills, recovery, financing, resize and closure',
  matrix: {
    ...TEMPLATE_MATRIX,
    ticket: 'Strategies page: Trading owner and intent, Instrument and template (Long), Order and funding, Hedge panel; then the package preview. The strategy instance drawer for Cancel working legs, Retry, Unwind, Accept, Resize and Close',
    manualInputs: ['investment Strategy (chosen by ID from the labelled demo list), holding period and hedge objective for the hedge request', 'loan rate when the shortfall is borrowed'],
    settlement: 'Shares T+1 on the US calendar; Treasury funding moves at once; a margin loan is drawn at once and repaid with interest to the day',
    lifecycle: 'Partial fills against displayed size; cancelled remainder leaves the package needing attention; retry, unwind and accept; resize; close by share, exact amount and in full; loan interest accrued at each end of day; no expiry (shares); roll refused',
    accounting: 'Average cost; commission expensed; realized on each sale; Treasury funding is internal (no Book P&L); the margin loan is one borrowing record of the Account, with its interest under borrowing and funding expenses',
    collateral: 'None for a long holding; loan unsecured (simulated lender)',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: [] },
  book: book('Matrix template long'),
  instruments: { main: STOCK },
  quotes: { main: { bid: 49.95, ask: 50.05, last: 50.00, bidSize: 500, askSize: 500 } },
  expectAtStart: startState(),
  steps: [
    {
      // The Strategies page asks Shaffer Hedge once owner, instrument and amount are set. Here the labelled demo fixture
      // answers. The context is complete: the Investment Strategy chosen by its listed ID, 30 days, downside protection.
      id: 'hedge-request', covers: ['hedge request'], action: 'hedge_request',
      input: pageInput('long', { quantity: 1500, ...CONTEXT }),
      strategyPage: { ...PAGE_CONTEXT, template: 'Long', underlying: 'main', quantity: 1500 },
      expect: {
        result: {
          state: 'recommendation_ready', complete: true, missing: [], source: { kind: 'demo-fixture', label: 'Demo fixture, not Shaffer Hedge' },
          // (Which canned packages the fixture proposes depends on the demo data present: not stated. None is chosen here.)
          investmentStrategy: { id: 'DEMO-IS-002', name: 'Core Equity', resolved: true }, holdingDays: 30, objective: 'downside_protection', scope: 'trade',
          primary: { instrument: 'main', direction: 'long', quantity: 1500, status: 'proposed' },
          proposedProtection: [], linkedProtection: [], hedgesHeld: [], // a Long template carries no protection of its own; nothing is held yet
        },
      },
    },
    {
      // 5,000 x 50.05 (the ask) = 250,250 + 50 commission = 250,300 against 200,000 available: short 50,300.
      id: 'cash-short-not-financed', covers: ['financing: not financed'], action: 'package', instrument: 'main',
      input: pageInput('long', { quantity: 5000 }),
      strategyPage: { template: 'Long', underlying: 'main', quantity: 5000 },
      status: 'blocked', reason: 'The package needs 250,300.00 and the Account has 200,000.00; "Do not finance" leaves it blocked.',
      expect: { refused: 'Alpha is short 50,300.00 USD' },
    },
    {
      // 1,500 shares against a displayed size of 500: 500 fill on confirmation and 500 more in the next cycle; 500 work.
      id: 'open-partial', covers: ['open', 'partial fill'], action: 'package', as: 'core', instrument: 'main',
      input: pageInput('long', { quantity: 1500 }),
      strategyPage: { template: 'Long', underlying: 'main', quantity: 1500 },
      expect: {
        preview: {
          blocking: 0, errors: [], template: 'long',
          legs: [{ kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'main', qty: 1500, estimate: 50.05, model: 'quoted-bid-ask', priceSource: 'Test fixture', settleDate: '2026-03-03', calendar: 'US', cash: -75_075, fees: 15, dependsOn: [] }], // 1,500 x 50.05; 1,500 x 0.01
          cash: { USD: { purchases: 75_075, proceeds: 0, fees: 15, margin: 0, collateral: 0, reserved: 0, financingIn: 0, required: 75_090, available: 200_000, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ kind: 'trade', action: 'buy', status: 'partial', qty: 1500, filledQty: 500, avgPrice: 50.05, fills: [{ qty: 500, price: 50.05, model: 'quoted-bid-ask', settleDate: '2026-03-03', source: 'Test fixture', status: 'simulated' }] }] },
        events: [{ type: 'strategy.submitted', summary: 'Package submitted: Long KSTL (1 leg; open)' }, { type: 'trade.fill', summary: 'Bought 500 KSTL @ 50.05 USD', owner: 'account', date: '2026-03-02' }, { type: 'trade.fill', summary: 'Bought 500 KSTL @ 50.05 USD' }],
        // Owed for 1,000 shares: 2 x (500 x 50.05 + 5) = 50,060.
        cash: { account: { USD: { settled: 200_000, unsettled: -50_060, availableToTrade: 149_940, availableToWithdraw: 149_940 } } },
        positions: [{ instrument: 'main', lot: 'core', owner: 'account', direction: 'long', qty: 1000, avgCost: 50.05, cost: 50_050, price: 50, value: 50_000, unrealized: -50, priceSource: 'Test fixture' }],
        holdings: { main: { long: 1000, short: 0, net: 1000 } },
        pending: [{ instrument: 'main', lot: 'core', owner: 'account', dueDate: '2026-03-03', amount: -25_030, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'core', owner: 'account', dueDate: '2026-03-03', amount: -25_030, ccy: 'USD', into: 'cash' }],
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'buy', status: 'partial', qty: 1500, filledQty: 1000, owner: 'account' }],
        pnl: { account: { realized: 0, commissions: -10, borrowFunding: 0, unrealized: -50, total: -60 }, book: { realized: 0, commissions: -10, unrealized: -50, total: -60 }, treasury: { total: 0 } },
        nav: { account: 199_940, treasury: 800_000, book: 999_940 },
        balance: {
          account: { cash: 200_000, positions: 50_000, payable: 50_060, assets: 250_000, liabilities: 50_060, netAssets: 199_940 },
          book: { cash: 1_000_000, positions: 50_000, payable: 50_060, assets: 1_050_000, liabilities: 50_060, netAssets: 999_940 },
          treasury: { cash: 800_000, assets: 800_000, liabilities: 0, netAssets: 800_000 },
        },
        oversight: { accountBorrowings: [], accounts: { account: { cashBorrowed: 0, fundingReceived: 200_000 } }, treasuryOwn: [] },
      },
    },
    {
      id: 'cancel-remainder', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'core',
      expect: {
        // The 1,000 filled stay; the 500 that did not fill leave the package short of its template.
        result: { status: 'attention', orders: [{ kind: 'trade', action: 'buy', status: 'cancelled', qty: 1500, filledQty: 1000 }] },
        events: [{ type: 'order.cancelled', summary: 'Leg 1 cancelled: buy 1,500 KSTL. Cancelled by user (1,000 of 1,500 had filled and remains in place)' }],
        openOrders: [],
        failed: { orders: 1 }, // the Failed tab lists the leg that ended unfilled, with its reason; it stays there as history
        alerts: ['strategy.attention'],
      },
    },
    {
      id: 'retry', covers: ['retry'], action: 'recover', how: 'retry', lot: 'core',
      expect: {
        preview: { blocking: 0, intent: 'retry', legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 500, estimate: 50.05, cash: -25_025, fees: 5 }], cash: { USD: { purchases: 25_025, fees: 5, required: 25_030, available: 149_940, shortfall: 0 } } }, // the 500 that did not fill
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', qty: 500, filledQty: 500, avgPrice: 50.05 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Long KSTL (1 leg; retry)' }, { type: 'trade.fill', summary: 'Bought 500 KSTL @ 50.05 USD' }],
        cash: { account: { USD: { unsettled: -75_090, availableToTrade: 124_910, availableToWithdraw: 124_910 } } }, // 50,060 + 25,030
        positions: [{ instrument: 'main', lot: 'core', qty: 1500, avgCost: 50.05, cost: 75_075, price: 50, value: 75_000, unrealized: -75 }],
        holdings: { main: { long: 1500, short: 0, net: 1500 } },
        pending: [-25_030, -25_030, -25_030].map((amount) => ({ instrument: 'main', lot: 'core', dueDate: '2026-03-03', amount, into: 'cash' })),
        pnl: { account: { commissions: -15, unrealized: -75, total: -90 }, book: { commissions: -15, unrealized: -75, total: -90 } },
        nav: { account: 199_910, book: 999_910 },
        balance: { account: { positions: 75_000, payable: 75_090, assets: 275_000, liabilities: 75_090, netAssets: 199_910 }, book: { positions: 75_000, payable: 75_090, assets: 1_075_000, liabilities: 75_090, netAssets: 999_910 } },
        alerts: [],
      },
    },
    { id: 'thin-book', action: 'quote', instrument: 'main', quote: { bid: 49.95, ask: 50.05, last: 50.00, bidSize: 100, askSize: 100 }, expect: {} },
    {
      // 400 shares against a displayed size of 100: 100 + 100 fill, 200 work.
      id: 'kept-partial', covers: ['partial fill'], action: 'package', as: 'kept', instrument: 'main',
      input: pageInput('long', { quantity: 400 }), strategyPage: { template: 'Long', underlying: 'main', quantity: 400 },
      expect: {
        preview: { blocking: 0, warnings: ['already-held'], legs: [{ kind: 'trade', action: 'buy', qty: 400, estimate: 50.05, cash: -20_020, fees: 4 }], cash: { USD: { purchases: 20_020, fees: 4, required: 20_024, available: 124_910, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ kind: 'trade', action: 'buy', status: 'partial', qty: 400, filledQty: 100, avgPrice: 50.05 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 100 KSTL @ 50.05 USD' }, { type: 'trade.fill', summary: 'Bought 100 KSTL @ 50.05 USD' }],
        cash: { account: { USD: { unsettled: -85_102, availableToTrade: 114_898, availableToWithdraw: 114_898 } } }, // 75,090 + 2 x 5,006
        positions: [{ instrument: 'main', lot: 'core', qty: 1500, value: 75_000, unrealized: -75 }, { instrument: 'main', lot: 'kept', owner: 'account', direction: 'long', qty: 200, avgCost: 50.05, cost: 10_010, price: 50, value: 10_000, unrealized: -10 }],
        holdings: { main: { long: 1700, short: 0, net: 1700 } },
        pending: [...[-25_030, -25_030, -25_030].map((amount) => ({ lot: 'core', dueDate: '2026-03-03', amount })), { lot: 'kept', dueDate: '2026-03-03', amount: -5_006 }, { lot: 'kept', dueDate: '2026-03-03', amount: -5_006 }], // 100 x 50.05 + 1
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'buy', status: 'partial', qty: 400, filledQty: 200 }],
        pnl: { account: { commissions: -17, unrealized: -85, total: -102 }, book: { commissions: -17, unrealized: -85, total: -102 } },
        nav: { account: 199_898, book: 999_898 },
        balance: { account: { positions: 85_000, payable: 85_102, assets: 285_000, liabilities: 85_102, netAssets: 199_898 }, book: { positions: 85_000, payable: 85_102, assets: 1_085_000, liabilities: 85_102, netAssets: 999_898 } },
      },
    },
    {
      id: 'cancel-kept', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'kept',
      expect: { result: { status: 'attention', orders: [{ status: 'cancelled', qty: 400, filledQty: 200 }] }, events: [{ type: 'order.cancelled', summary: /200 of 400 had filled and remains in place/ }], openOrders: [], failed: { orders: 2 }, alerts: ['strategy.attention'] },
    },
    {
      // Accepting trades nothing: the 200 held stay, and the strategy instance is recorded as no longer matching its template.
      id: 'accept-kept', covers: ['accept as it stands'], action: 'strategy_action', how: 'accept', lot: 'kept',
      expect: { result: { status: 'open', orders: [{ status: 'cancelled', filledQty: 200 }] }, events: [{ type: 'strategy.accepted', summary: 'Long KSTL: accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: [] },
    },
    {
      id: 'unwound-partial', covers: ['partial fill'], action: 'package', as: 'unwound', instrument: 'main',
      input: pageInput('long', { quantity: 400 }), strategyPage: { template: 'Long', underlying: 'main', quantity: 400 },
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy', qty: 400, estimate: 50.05, cash: -20_020, fees: 4 }], cash: { USD: { required: 20_024, available: 114_898 } } },
        result: { status: 'partial', orders: [{ status: 'partial', qty: 400, filledQty: 100 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 100 KSTL @ 50.05 USD' }, { type: 'trade.fill', summary: 'Bought 100 KSTL @ 50.05 USD' }],
        cash: { account: { USD: { unsettled: -95_114, availableToTrade: 104_886, availableToWithdraw: 104_886 } } },
        positions: [{ instrument: 'main', lot: 'core', qty: 1500 }, { instrument: 'main', lot: 'kept', qty: 200 }, { instrument: 'main', lot: 'unwound', qty: 200, avgCost: 50.05, cost: 10_010, value: 10_000, unrealized: -10 }],
        holdings: { main: { long: 1900, short: 0, net: 1900 } },
        pending: [...[-25_030, -25_030, -25_030].map((amount) => ({ lot: 'core', amount })), { lot: 'kept', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }],
        openOrders: [{ kind: 'trade', action: 'buy', status: 'partial', qty: 400, filledQty: 200 }],
        pnl: { account: { commissions: -19, unrealized: -95, total: -114 }, book: { commissions: -19, unrealized: -95, total: -114 } },
        nav: { account: 199_886, book: 999_886 },
        balance: { account: { positions: 95_000, payable: 95_114, assets: 295_000, liabilities: 95_114, netAssets: 199_886 }, book: { positions: 95_000, payable: 95_114, assets: 1_095_000, liabilities: 95_114, netAssets: 999_886 } },
      },
    },
    { id: 'cancel-unwound', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'unwound', expect: { result: { status: 'attention' }, events: [{ type: 'order.cancelled' }], openOrders: [], failed: { orders: 3 }, alerts: ['strategy.attention'] } },
    {
      // Unwind sells the 200 that filled at the bid, 100 at a time (bid size 100). 2 x 100 x (49.95 - 50.05) = -20 realized.
      id: 'unwind', covers: ['unwind'], action: 'recover', how: 'unwind', lot: 'unwound',
      expect: {
        preview: { blocking: 0, intent: 'unwind', legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 200, estimate: 49.95, cash: 9_990, fees: 2 }], cash: { USD: { proceeds: 9_990, fees: 2, required: 2, netCash: 9_988 } } },
        result: { status: 'partial', orders: [{ kind: 'trade', action: 'sell', status: 'partial', qty: 200, filledQty: 100, avgPrice: 49.95 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Long KSTL (1 leg; unwind)' }, { type: 'trade.fill', summary: 'Sold 100 KSTL @ 49.95 USD (realized -10.00 USD)' }, { type: 'trade.fill', summary: 'Sold 100 KSTL @ 49.95 USD (realized -10.00 USD)' }],
        // Due to the Account: 2 x (100 x 49.95 - 1) = 9,988. Still owed: 95,114.
        cash: { account: { USD: { unsettled: -85_126, receivable: 9_988, payable: 95_114, availableToTrade: 114_874, availableToWithdraw: 104_886 } } },
        positions: [{ instrument: 'main', lot: 'core', qty: 1500 }, { instrument: 'main', lot: 'kept', qty: 200 }],
        holdings: { main: { long: 1700, short: 0, net: 1700 } },
        pending: [...[-25_030, -25_030, -25_030].map((amount) => ({ lot: 'core', amount })), { lot: 'kept', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }, { lot: 'unwound', amount: 4_994 }, { lot: 'unwound', amount: 4_994 }],
        openOrders: [],
        pnl: { account: { realized: -20, commissions: -21, unrealized: -85, total: -126 }, book: { realized: -20, commissions: -21, unrealized: -85, total: -126 } },
        nav: { account: 199_874, book: 999_874 },
        balance: { account: { receivable: 9_988, positions: 85_000, payable: 95_114, assets: 294_988, liabilities: 95_114, netAssets: 199_874 }, book: { receivable: 9_988, positions: 85_000, payable: 95_114, assets: 1_094_988, liabilities: 95_114, netAssets: 999_874 } },
        alerts: [],
      },
    },
    { id: 'deep-book', action: 'quote', instrument: 'main', quote: { bid: 49.95, ask: 50.05, last: 50.00, bidSize: 10000, askSize: 10000 }, expect: {} },
    {
      // 1,500 x 1.2 = 1,800: 300 more in the same strategy instance.
      id: 'resize-up', covers: ['resize', 'increase'], action: 'resize', lot: 'core', factor: 1.2,
      expect: {
        preview: { blocking: 0, intent: 'resize', legs: [{ kind: 'trade', action: 'buy', qty: 300, estimate: 50.05, cash: -15_015, fees: 3 }], cash: { USD: { purchases: 15_015, fees: 3, required: 15_018, available: 114_874 } } },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 300, avgPrice: 50.05 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Long KSTL (1 leg; resize)' }, { type: 'trade.fill', summary: 'Bought 300 KSTL @ 50.05 USD' }],
        cash: { account: { USD: { unsettled: -100_144, payable: 110_132, availableToTrade: 99_856, availableToWithdraw: 89_868 } } }, // 95,114 + 15,018 owed; 9,988 due
        positions: [{ instrument: 'main', lot: 'core', qty: 1800, avgCost: 50.05, cost: 90_090, value: 90_000, unrealized: -90 }, { instrument: 'main', lot: 'kept', qty: 200 }],
        holdings: { main: { long: 2000, short: 0, net: 2000 } },
        pending: [...[-25_030, -25_030, -25_030].map((amount) => ({ lot: 'core', amount })), { lot: 'core', amount: -15_018 }, { lot: 'kept', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }, { lot: 'unwound', amount: 4_994 }, { lot: 'unwound', amount: 4_994 }],
        pnl: { account: { commissions: -24, unrealized: -100, total: -144 }, book: { commissions: -24, unrealized: -100, total: -144 } },
        nav: { account: 199_856, book: 999_856 },
        balance: { account: { positions: 100_000, payable: 110_132, assets: 309_988, liabilities: 110_132, netAssets: 199_856 }, book: { positions: 100_000, payable: 110_132, assets: 1_109_988, liabilities: 110_132, netAssets: 999_856 } },
      },
    },
    {
      id: 'roll-refused', covers: ['roll'], action: 'roll', lot: 'core', newExpiration: '2026-04-17',
      status: 'unsupported', reason: 'A long holding of shares has no option or futures position to roll; the strategy instance offers no Roll.',
      expect: { refused: { engine: 'holds no option or futures position to roll', api: 'holds no option or futures position to roll', browser: 'offers no Roll' } },
    },
    {
      // 2,000 x 50.05 = 100,100 + 20 = 100,120 needed; 99,856 available; Treasury funds the 264.00 shortfall.
      id: 'funded-from-treasury', covers: ['financing: Treasury funding'], action: 'package', as: 'funded', instrument: 'main',
      input: pageInput('long', { quantity: 2000, financing: { mode: 'treasury' } }), strategyPage: { template: 'Long', underlying: 'main', quantity: 2000, financing: { mode: 'treasury' } },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', action: 'treasury_funding', purpose: 'financing', qty: 264, cash: 264, financing: { amount: 264 } },
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'main', qty: 2000, estimate: 50.05, cash: -100_100, fees: 20, dependsOn: [1] }, // the purchase waits for its funding
          ],
          cash: { USD: { purchases: 100_100, fees: 20, financingIn: 264, required: 100_120, available: 99_856, shortfall: 0, netCash: -99_856 } },
        },
        result: { status: 'open', orders: [{ kind: 'funding', status: 'filled', filledQty: 264 }, { kind: 'trade', action: 'buy', status: 'filled', filledQty: 2000, avgPrice: 50.05 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'transfer.funding', summary: 'Treasury funding: 264.00 USD from Treasury to Alpha (Funding for Long KSTL)', owner: 'treasury' }, { type: 'trade.fill', summary: 'Bought 2,000 KSTL @ 50.05 USD' }],
        cash: {
          account: { USD: { settled: 200_264, unsettled: -200_264, payable: 210_252, availableToTrade: 0, availableToWithdraw: -9_988 } }, // 200,264 - 210,252 owed until the sales of 'unwound' settle
          treasury: { USD: { settled: 799_736, availableToTrade: 799_736 } },
        },
        positions: [{ instrument: 'main', lot: 'core', qty: 1800 }, { instrument: 'main', lot: 'funded', owner: 'account', direction: 'long', qty: 2000, avgCost: 50.05, cost: 100_100, value: 100_000, unrealized: -100 }, { instrument: 'main', lot: 'kept', qty: 200 }],
        holdings: { main: { long: 4000, short: 0, net: 4000 } },
        pending: [{ lot: 'funded', amount: -100_120 }, ...[-25_030, -25_030, -25_030].map((amount) => ({ lot: 'core', amount })), { lot: 'core', amount: -15_018 }, { lot: 'kept', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }, { lot: 'unwound', amount: 4_994 }, { lot: 'unwound', amount: 4_994 }],
        // Internal funding is no Book P&L: the Book loses only the 20 commission and 100 of unrealized.
        pnl: { account: { commissions: -44, unrealized: -200, total: -264 }, book: { commissions: -44, unrealized: -200, total: -264 }, treasury: { total: 0 } },
        nav: { account: 200_000, treasury: 799_736, book: 999_736 },
        balance: {
          account: { cash: 200_264, positions: 200_000, payable: 210_252, assets: 410_252, liabilities: 210_252, netAssets: 200_000 },
          book: { cash: 1_000_000, positions: 200_000, payable: 210_252, assets: 1_209_988, liabilities: 210_252, netAssets: 999_736 },
          treasury: { cash: 799_736, assets: 799_736, netAssets: 799_736 },
        },
        oversight: { accounts: { account: { cashBorrowed: 0, fundingReceived: 200_264 } } },
      },
    },
    {
      // 600 x 50.05 = 30,030 + 6 = 30,036 needed, nothing available: a margin loan of 30,036.00 at 6% (ACT/360), drawn at once.
      id: 'funded-by-loan', covers: ['financing: borrow'], action: 'package', as: 'levered', instrument: 'main', contractAs: 'loan',
      input: pageInput('long', { quantity: 600, financing: { mode: 'loan', rateType: 'fixed', rate: 0.06 } }), strategyPage: { template: 'Long', underlying: 'main', quantity: 600, financing: { mode: 'loan', rate: 0.06 } },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'loan', action: 'borrow_cash', purpose: 'financing', qty: 30_036, cash: 30_036, dailyCost: 5.01, financing: { amount: 30_036, rateType: 'fixed', rate: 0.06, interestFrom: '2026-03-02' } }, // 30,036 x 0.06 / 360 = 5.006
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'main', qty: 600, estimate: 50.05, cash: -30_030, fees: 6, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 30_030, fees: 6, financingIn: 30_036, required: 30_036, available: 0, shortfall: 0, netCash: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'loan', action: 'borrow_cash', instrument: 'loan', status: 'filled', filledQty: 30_036 }, { kind: 'trade', action: 'buy', status: 'filled', filledQty: 600, avgPrice: 50.05 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'loan.drawdown', summary: 'Borrowed 30,036.00 USD (margin, 6.000% fixed, open-ended)', cash: { USD: 30_036 } }, { type: 'trade.fill', summary: 'Bought 600 KSTL @ 50.05 USD' }],
        cash: { account: { USD: { settled: 230_300, unsettled: -230_300, payable: 240_288, availableToTrade: 0, availableToWithdraw: -9_988, borrowed: 30_036 } } },
        positions: [
          { instrument: 'loan', lot: 'levered', owner: 'account', direction: 'borrowed', qty: -30_036, carrying: -30_036, accrued: 0 },
          { instrument: 'main', lot: 'core', qty: 1800 }, { instrument: 'main', lot: 'funded', qty: 2000 }, { instrument: 'main', lot: 'kept', qty: 200 },
          { instrument: 'main', lot: 'levered', owner: 'account', direction: 'long', qty: 600, avgCost: 50.05, cost: 30_030, value: 30_000, unrealized: -30 },
        ],
        holdings: { main: { long: 4600, short: 0, net: 4600 } },
        pending: [{ lot: 'funded', amount: -100_120 }, { lot: 'levered', amount: -30_036 }, ...[-25_030, -25_030, -25_030].map((amount) => ({ lot: 'core', amount })), { lot: 'core', amount: -15_018 }, { lot: 'kept', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }, { lot: 'unwound', amount: -5_006 }, { lot: 'unwound', amount: 4_994 }, { lot: 'unwound', amount: 4_994 }],
        lifecycle: [{ type: 'loan.interest', instrument: 'loan', dueDate: '2026-04-01', status: 'pending', owner: 'account' }], // paid monthly, first business day of April
        borrowings: [{ owner: 'account', family: 'loan', type: 'Margin loan', lot: 'levered', principal: 30_036, ccy: 'USD', rate: 0.06, accrued: 0, costToDate: 0, origin: 'account', lender: 'Simulated lender', dayCount: 'ACT/360', startDate: '2026-03-02', nextPayment: '2026-04-01' }],
        pnl: { account: { commissions: -50, unrealized: -230, total: -300 }, book: { commissions: -50, unrealized: -230, total: -300 } },
        nav: { account: 199_964, book: 999_700 },
        balance: {
          account: { cash: 230_300, positions: 230_000, payable: 240_288, borrowed: 30_036, assets: 470_288, liabilities: 270_324, netAssets: 199_964 },
          book: { cash: 1_030_036, positions: 230_000, payable: 240_288, borrowed: 30_036, assets: 1_270_024, liabilities: 270_324, netAssets: 999_700 },
        },
        // Treasury oversees the Account's borrowing; it is the Account's own record and Treasury owes nothing.
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'levered', principal: 30_036, ccy: 'USD', accrued: 0 }], accounts: { account: { cashBorrowed: 30_036, fundingReceived: 200_264 } }, treasuryOwn: [] },
      },
    },
    {
      // Every Monday trade settles: paid 240,288, received 9,988; settled cash 230,300 - 240,288 + 9,988 = 0.
      // Interest is accrued as of the business date of each end of day (from the drawdown date, ACT/360): as of
      // Monday 2 March nothing has accrued yet. A repayment settles interest to its own date.
      id: 'next-day', covers: ['settlement', 'loan interest'], action: 'clock', to: MAR(3),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'Settlement: received 4,994.00 USD into settled cash' }, { type: 'settlement.receive', summary: 'received 4,994.00 USD' },
          ...[25_030, 25_030, 25_030].map(() => ({ type: 'settlement.pay', summary: 'paid 25,030.00 USD from settled cash' })),
          ...[1, 2, 3, 4].map(() => ({ type: 'settlement.pay', summary: 'paid 5,006.00 USD from settled cash' })),
          { type: 'settlement.pay', summary: 'paid 15,018.00 USD' }, { type: 'settlement.pay', summary: 'paid 100,120.00 USD' }, { type: 'settlement.pay', summary: 'paid 30,036.00 USD' },
        ],
        cash: { account: { USD: { settled: 0, unsettled: 0, receivable: 0, payable: 0, availableToTrade: 0, availableToWithdraw: 0, borrowed: 30_036 } } },
        pending: [],
        balance: { account: { cash: null, receivable: null, payable: null, assets: 230_000, liabilities: 30_036, netAssets: 199_964 }, book: { cash: 799_736, receivable: null, payable: null, assets: 1_029_736, liabilities: 30_036, netAssets: 999_700 } },
      },
    },
    {
      id: 'price-up', action: 'quote', instrument: 'main', quote: { bid: 51.95, ask: 52.05, last: 52.00, bidSize: 10000, askSize: 10000 },
      expect: {
        positions: [
          { instrument: 'loan', lot: 'levered', qty: -30_036 },
          { instrument: 'main', lot: 'core', qty: 1800, price: 52, value: 93_600, unrealized: 3_510 }, // 1,800 x (52 - 50.05)
          { instrument: 'main', lot: 'funded', qty: 2000, value: 104_000, unrealized: 3_900 },
          { instrument: 'main', lot: 'kept', qty: 200, value: 10_400, unrealized: 390 },
          { instrument: 'main', lot: 'levered', qty: 600, value: 31_200, unrealized: 1_170 },
        ],
        pnl: { account: { unrealized: 8_970, total: 8_900 }, book: { unrealized: 8_970, total: 8_900 } }, // -20 - 50 + 8,970
        nav: { account: 209_164, book: 1_008_900 },
        balance: { account: { positions: 239_200, assets: 239_200, netAssets: 209_164 }, book: { positions: 239_200, assets: 1_038_936, netAssets: 1_008_900 } },
      },
    },
    {
      // Half of every position of 'core': 900 sold at 51.95 = 46,755 - 9; realized 900 x (51.95 - 50.05) = 1,710.
      id: 'close-share', covers: ['reduce', 'close share'], action: 'close', lot: 'core', scope: 'strategy', percent: 50,
      expect: {
        preview: { blocking: 0, intent: 'close', legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 900, estimate: 51.95, settleDate: '2026-03-04', cash: 46_755, fees: 9 }], cash: { USD: { proceeds: 46_755, fees: 9, required: 9, available: 0, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 900, avgPrice: 51.95 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Long KSTL (1 leg; close)' }, { type: 'trade.fill', summary: 'Sold 900 KSTL @ 51.95 USD (realized 1,710.00 USD)', date: '2026-03-03' }],
        cash: { account: { USD: { unsettled: 46_746, receivable: 46_746, availableToTrade: 46_746, availableToWithdraw: 0 } } },
        positions: [{ instrument: 'loan', qty: -30_036 }, { instrument: 'main', lot: 'core', qty: 900, cost: 45_045, value: 46_800, unrealized: 1_755 }, { instrument: 'main', lot: 'funded', qty: 2000 }, { instrument: 'main', lot: 'kept', qty: 200 }, { instrument: 'main', lot: 'levered', qty: 600 }],
        holdings: { main: { long: 3700, short: 0, net: 3700 } },
        pending: [{ lot: 'core', dueDate: '2026-03-04', amount: 46_746, into: 'cash' }],
        pnl: { account: { realized: 1_690, commissions: -59, unrealized: 7_215, total: 8_846 }, book: { realized: 1_690, commissions: -59, unrealized: 7_215, total: 8_846 } },
        nav: { account: 209_110, book: 1_008_846 },
        balance: { account: { receivable: 46_746, positions: 192_400, assets: 239_146, netAssets: 209_110 }, book: { receivable: 46_746, positions: 192_400, assets: 1_038_882, netAssets: 1_008_846 } },
      },
    },
    {
      // Exactly 300 of the 900 left: 300 x 51.95 = 15,585 - 3; realized 300 x 1.90 = 570.
      id: 'close-exact', covers: ['reduce', 'close exact amount'], action: 'close', lot: 'core', instrument: 'main', qty: 300,
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 300, estimate: 51.95, cash: 15_585, fees: 3 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 300 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 300 KSTL @ 51.95 USD (realized 570.00 USD)' }],
        cash: { account: { USD: { unsettled: 62_328, receivable: 62_328, availableToTrade: 62_328 } } },
        positions: [{ instrument: 'loan', qty: -30_036 }, { instrument: 'main', lot: 'core', qty: 600, cost: 30_030, value: 31_200, unrealized: 1_170 }, { instrument: 'main', lot: 'funded', qty: 2000 }, { instrument: 'main', lot: 'kept', qty: 200 }, { instrument: 'main', lot: 'levered', qty: 600 }],
        holdings: { main: { long: 3400, short: 0, net: 3400 } },
        pending: [{ lot: 'core', amount: 15_582 }, { lot: 'core', amount: 46_746 }],
        pnl: { account: { realized: 2_260, commissions: -62, unrealized: 6_630, total: 8_828 }, book: { realized: 2_260, commissions: -62, unrealized: 6_630, total: 8_828 } },
        nav: { account: 209_092, book: 1_008_828 },
        balance: { account: { receivable: 62_328, positions: 176_800, assets: 239_128, netAssets: 209_092 }, book: { receivable: 62_328, positions: 176_800, assets: 1_038_864, netAssets: 1_008_828 } },
      },
    },
    {
      id: 'close-all', covers: ['close'], action: 'close', lot: 'core', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 600, estimate: 51.95, cash: 31_170, fees: 6 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 600 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 600 KSTL @ 51.95 USD (realized 1,140.00 USD)' }],
        cash: { account: { USD: { unsettled: 93_492, receivable: 93_492, availableToTrade: 93_492 } } },
        positions: [{ instrument: 'loan', qty: -30_036 }, { instrument: 'main', lot: 'funded', qty: 2000 }, { instrument: 'main', lot: 'kept', qty: 200 }, { instrument: 'main', lot: 'levered', qty: 600 }],
        holdings: { main: { long: 2800, short: 0, net: 2800 } },
        pending: [{ lot: 'core', amount: 15_582 }, { lot: 'core', amount: 31_164 }, { lot: 'core', amount: 46_746 }],
        pnl: { account: { realized: 3_400, commissions: -68, unrealized: 5_460, total: 8_792 }, book: { realized: 3_400, commissions: -68, unrealized: 5_460, total: 8_792 } },
        nav: { account: 209_056, book: 1_008_792 },
        balance: { account: { receivable: 93_492, positions: 145_600, assets: 239_092, netAssets: 209_056 }, book: { receivable: 93_492, positions: 145_600, assets: 1_038_828, netAssets: 1_008_792 } },
      },
    },
    {
      // Closing 'levered' sells its 600 shares and offers the loan's repayment as an optional leg: 30,036 principal plus
      // interest to today (one day, 30,036 x 0.06 / 360 = 5.006 -> 5.01). It needs settled cash, and the Account has none
      // until the sales settle tomorrow: the repayment works, then expires at the end of the day; the package does not
      // need attention for it (an optional leg).
      id: 'close-levered', covers: ['close', 'repay'], action: 'close', lot: 'levered', scope: 'strategy',
      expect: {
        preview: {
          blocking: 0, warnings: ['arrangement'],
          legs: [
            { kind: 'trade', action: 'sell', instrument: 'main', qty: 600, estimate: 51.95, cash: 31_170, fees: 6 },
            { kind: 'repay', action: 'repay_cash', purpose: 'financing', instrument: 'loan', qty: 30_036, cash: -30_041.01, financing: { amount: -30_041.01, principal: 30_036, interest: 5.01, full: true, interestThrough: '2026-03-03' } },
          ],
          cash: { USD: { proceeds: 31_170, fees: 6, financingOut: 30_041.01, required: 30_047.01, available: 93_492, shortfall: 0, netCash: 1_122.99 } },
        },
        result: { status: 'partial', orders: [{ action: 'sell', status: 'filled', filledQty: 600 }, { kind: 'repay', status: 'working', filledQty: 0, reason: 'Alpha has 0.00 USD of settled USD available; 30,041.01 USD is needed (principal plus accrued interest).' }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Long KSTL (2 legs; close)' }, { type: 'trade.fill', summary: 'Sold 600 KSTL @ 51.95 USD (realized 1,140.00 USD)' }],
        cash: { account: { USD: { unsettled: 124_656, receivable: 124_656, availableToTrade: 124_656 } } },
        positions: [{ instrument: 'loan', qty: -30_036 }, { instrument: 'main', lot: 'funded', qty: 2000 }, { instrument: 'main', lot: 'kept', qty: 200 }],
        holdings: { main: { long: 2200, short: 0, net: 2200 } },
        pending: [{ lot: 'core', amount: 15_582 }, { lot: 'core', amount: 31_164 }, { lot: 'levered', amount: 31_164 }, { lot: 'core', amount: 46_746 }],
        openOrders: [{ instrument: 'loan', kind: 'repay', action: 'repay_cash', status: 'working', qty: 30_036, filledQty: 0 }],
        pnl: { account: { realized: 4_540, commissions: -74, unrealized: 4_290, total: 8_756 }, book: { realized: 4_540, commissions: -74, unrealized: 4_290, total: 8_756 } },
        nav: { account: 209_020, book: 1_008_756 },
        balance: { account: { receivable: 124_656, positions: 114_400, assets: 239_056, netAssets: 209_020 }, book: { receivable: 124_656, positions: 114_400, assets: 1_038_792, netAssets: 1_008_756 } },
      },
    },
    {
      id: 'close-funded', covers: ['close'], action: 'close', lot: 'funded', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 2000, estimate: 51.95, cash: 103_900, fees: 20 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 2000 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 2,000 KSTL @ 51.95 USD (realized 3,800.00 USD)' }], // 2,000 x 1.90
        cash: { account: { USD: { unsettled: 228_536, receivable: 228_536, availableToTrade: 228_536 } } },
        positions: [{ instrument: 'loan', qty: -30_036 }, { instrument: 'main', lot: 'kept', qty: 200 }],
        holdings: { main: { long: 200, short: 0, net: 200 } },
        pending: [{ lot: 'core', amount: 15_582 }, { lot: 'core', amount: 31_164 }, { lot: 'levered', amount: 31_164 }, { lot: 'core', amount: 46_746 }, { lot: 'funded', amount: 103_880 }],
        pnl: { account: { realized: 8_340, commissions: -94, unrealized: 390, total: 8_636 }, book: { realized: 8_340, commissions: -94, unrealized: 390, total: 8_636 } },
        nav: { account: 208_900, book: 1_008_636 },
        balance: { account: { receivable: 228_536, positions: 10_400, assets: 238_936, netAssets: 208_900 }, book: { receivable: 228_536, positions: 10_400, assets: 1_038_672, netAssets: 1_008_636 } },
      },
    },
    {
      id: 'close-kept', covers: ['close'], action: 'close', lot: 'kept', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 200, estimate: 51.95, cash: 10_390, fees: 2 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 200 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 200 KSTL @ 51.95 USD (realized 380.00 USD)' }],
        cash: { account: { USD: { unsettled: 238_924, receivable: 238_924, availableToTrade: 238_924 } } },
        positions: [{ instrument: 'loan', qty: -30_036 }],
        holdings: { main: null },
        pending: [{ lot: 'kept', amount: 10_388 }, { lot: 'core', amount: 15_582 }, { lot: 'core', amount: 31_164 }, { lot: 'levered', amount: 31_164 }, { lot: 'core', amount: 46_746 }, { lot: 'funded', amount: 103_880 }],
        pnl: { account: { realized: 8_720, commissions: -96, unrealized: 0, total: 8_624 }, book: { realized: 8_720, commissions: -96, unrealized: 0, total: 8_624 } },
        nav: { account: 208_888, book: 1_008_624 },
        balance: { account: { receivable: 238_924, positions: null, assets: 238_924, netAssets: 208_888 }, book: { receivable: 238_924, positions: null, assets: 1_038_660, netAssets: 1_008_624 } },
      },
    },
    {
      // The sales settle (238,924 received). Interest as of Tuesday 3 March: one day, 5.006 -> 5.01. The repayment leg,
      // a day order, expired at Tuesday's end of day.
      id: 'settle-sales', covers: ['settlement', 'loan interest'], action: 'clock', to: MAR(4),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 46,746.00 USD' }, { type: 'settlement.receive', summary: 'received 15,582.00 USD' }, { type: 'settlement.receive', summary: 'received 31,164.00 USD' },
          { type: 'settlement.receive', summary: 'received 31,164.00 USD' }, { type: 'settlement.receive', summary: 'received 103,880.00 USD' }, { type: 'settlement.receive', summary: 'received 10,388.00 USD' },
          { type: 'accrual.interest', summary: 'Interest accrued on Margin loan USD (Long KSTL): 5.01 USD' },
          { type: 'order.expired', summary: /^Leg 4 expired: repay cash 30,036 Margin loan USD \(Long KSTL\)/ },
        ],
        cash: { account: { USD: { settled: 238_924, unsettled: 0, receivable: 0, availableToTrade: 238_924, availableToWithdraw: 238_924, borrowed: 30_036 } } },
        positions: [{ instrument: 'loan', lot: 'levered', qty: -30_036, accrued: -5.01 }],
        pending: [], openOrders: [], failed: { orders: 4 }, // the optional repayment leg that expired is listed with the others
        borrowings: [{ owner: 'account', lot: 'levered', principal: 30_036, accrued: 5.01, costToDate: 5.01 }],
        pnl: { account: { borrowFunding: -5.01, total: 8_618.99 }, book: { borrowFunding: -5.01, total: 8_618.99 } },
        nav: { account: 208_882.99, book: 1_008_618.99 },
        balance: { account: { cash: 238_924, receivable: null, accruedExpense: 5.01, assets: 238_924, liabilities: 30_041.01, netAssets: 208_882.99 }, book: { cash: 1_038_660, receivable: null, accruedExpense: 5.01, assets: 1_038_660, liabilities: 30_041.01, netAssets: 1_008_618.99 } },
        oversight: { accountBorrowings: [{ owner: 'account', lot: 'levered', principal: 30_036, accrued: 5.01 }] },
      },
    },
    {
      // Repaid in full with interest to today: two days, 30,036 x 0.06 x 2 / 360 = 10.012 -> 10.01 (5.00 more than accrued).
      id: 'repay-loan', covers: ['repay'], action: 'repay', lot: 'levered', instrument: 'loan',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'repay', action: 'repay_cash', instrument: 'loan', qty: 30_036, cash: -30_046.01, financing: { principal: 30_036, interest: 10.01, full: true, interestThrough: '2026-03-04' } }], cash: { USD: { financingOut: 30_046.01, required: 30_046.01, available: 238_924, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ kind: 'repay', status: 'filled', filledQty: 30_036 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'accrual.interest', summary: 'Interest accrued on Margin loan USD (Long KSTL): 5.00 USD' },
          { type: 'loan.repayment', summary: 'Repaid 30,036.00 USD of principal on Margin loan USD (Long KSTL) (in full)', cash: { USD: -30_036 } },
          { type: 'interest.payment', summary: 'Interest paid on Margin loan USD (Long KSTL): 10.01 USD', cash: { USD: -10.01 } },
        ],
        // Nothing is left held, borrowed, reserved or scheduled. Whole scenario: realized 8,720; commissions 96; interest 10.01.
        cash: { account: { USD: { settled: 208_877.99, unsettled: 0, receivable: 0, payable: 0, reserved: 0, availableToTrade: 208_877.99, availableToWithdraw: 208_877.99, borrowed: 0 } }, treasury: { USD: { settled: 799_736 } } },
        positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [],
        pnl: { account: { realized: 8_720, commissions: -96, borrowFunding: -10.01, unrealized: 0, total: 8_613.99 }, book: { realized: 8_720, commissions: -96, borrowFunding: -10.01, unrealized: 0, total: 8_613.99 }, treasury: { total: 0 } },
        nav: { account: 208_877.99, treasury: 799_736, book: 1_008_613.99 },
        balance: {
          account: { cash: 208_877.99, accruedExpense: null, borrowed: null, assets: 208_877.99, liabilities: 0, netAssets: 208_877.99 },
          book: { cash: 1_008_613.99, accruedExpense: null, borrowed: null, assets: 1_008_613.99, liabilities: 0, netAssets: 1_008_613.99 },
        },
        oversight: { accountBorrowings: [], accounts: { account: { cashBorrowed: 0, fundingReceived: 200_264 } }, treasuryOwn: [] },
      },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// short
// ---------------------------------------------------------------------------------------------
// Two legs: a simulated securities borrow (financing) and the short sale that depends on it. The borrow is refused
// while none is available. The short sale fills in parts against a small bid size and its remainder is cancelled and
// retried; a short sale held at a limit never reached is cancelled and the package unwound (the borrow goes back); a
// part-filled one is accepted as it stands. The first package is resized (a second borrow record) and later closed by a
// share, an exact amount and in full; the cover returns what it frees of both borrows. Cash short is not financed
// (blocked), funded from Treasury, or borrowed (a margin loan). Treasury tops the Account up for the covers and takes
// the cash back at the end.
//
// Rules used here (Book short assumptions): the sale proceeds less commission settle T+1 into restricted cash; the
// collateral is marked at each end of day (and when the proceeds arrive) to 102% of quantity x last price, topped up
// from or released to settled cash; 30% of quantity x last price is reserved from free cash while the short is open
// (set when the strategy instance changes, and again at each end of day). The borrow fee (1.8% a year, ACT/360, on
// quantity x last price) accrues at each end of day from the day the sale settles, and to the day of a return at the
// current price; it is paid when a borrow record is fully returned. A cover is paid from the short's restricted cash
// first; until it settles, its payable is counted against free cash.
const borrowed = (lot, qty, value, accrued = 0) => ({ instrument: 'borrow:main', lot, owner: 'account', direction: 'securities borrowed', qty, value, accrued });
const shortPos = (lot, qty, value, unrealized, restrictedCash) => ({ instrument: 'main', lot, owner: 'account', direction: 'short', qty, avgCost: 50, cost: qty * 50, value, unrealized, restrictedCash });
const fee = (n) => Array.from({ length: n }, () => ({ type: 'secloan.fee', instrument: 'borrow:main', dueDate: '2026-04-01', status: 'pending', owner: 'account' }));
const secBorrow = (lot, qty, value, accrued, collateralCash) => ({ owner: 'account', family: 'secloan', instrument: 'main', lot, qty, value, rate: 0.018, accrued, costToDate: accrued, collateralCash, nextPayment: '2026-04-01' });
const oversee = (lot, accrued, principal = null) => ({ owner: 'account', origin: 'account', lot, principal, ccy: 'USD', accrued });

const shortTemplate = {
  template: 'short',
  title: 'Short template on Kestrel Logistics: simulated borrow linked to the short sale, partial fills, failures, financing, closure',
  matrix: {
    ...TEMPLATE_MATRIX,
    ticket: 'Strategies page (Short): Trading owner and intent, Instrument and template, Securities borrow, Order and funding; then the package preview (legs editable). The strategy instance drawer for Cancel working legs, Retry, Unwind, Accept, Resize and Close',
    manualInputs: ['limit price of the short-sale leg, changed in the preview', 'investment Strategy, holding period and objective for the hedge request', 'loan rate when the shortfall is borrowed'],
    automaticInputs: [...TEMPLATE_MATRIX.automaticInputs, 'borrow availability and fee (borrow fixture standing in for Shaffer MarketData)', 'collateral and margin from the Book short assumptions'],
    settlement: 'Short-sale proceeds T+1 into restricted cash; covers T+1 paid from restricted cash; collateral marked when proceeds arrive and at each end of day',
    lifecycle: 'Borrow first, short sale after it (dependent leg); borrow refused when unavailable; daily borrow fee from settlement; fee paid when a borrow record is fully returned; cover returns the borrow; resize borrows again; roll refused',
    accounting: 'Short position at negative cost; realized on cover; borrow fee and loan interest under borrowing and funding expenses; each borrow is one record in the borrowing register, overseen by Treasury',
    collateral: 'Restricted cash 102% of market value; 30% margin reserve; neither is buying power or withdrawable',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: [] },
  book: book('Matrix template short', { funding: 100_000 }),
  instruments: { main: STOCK },
  // The last trade is at the bid: the margin reserve (30% of the last price) is then exactly 30% of the sale proceeds.
  quotes: { main: { bid: 50.00, ask: 50.10, last: 50.00, bidSize: 500, askSize: 500 } },
  borrow: { main: { available: true, quantity: 50_000, feeRate: 0.018 } },
  expectAtStart: startState(100_000),
  steps: [
    {
      id: 'hedge-request', covers: ['hedge request'], action: 'hedge_request',
      input: pageInput('short', { quantity: 1500, ...CONTEXT, hedgeObjective: { type: 'upside_protection_short' } }),
      strategyPage: { ...PAGE_CONTEXT, objective: 'Upside protection for shorts', template: 'Short', underlying: 'main', quantity: 1500 },
      expect: {
        result: {
          state: 'recommendation_ready', complete: true, missing: [], source: { kind: 'demo-fixture', label: 'Demo fixture, not Shaffer Hedge' },
          investmentStrategy: { id: 'DEMO-IS-002', name: 'Core Equity', resolved: true }, holdingDays: 30, objective: 'upside_protection_short', scope: 'trade',
          primary: { instrument: 'main', direction: 'short', quantity: 1500, status: 'proposed' }, proposedProtection: [], linkedProtection: [], hedgesHeld: [],
        },
      },
    },
    { id: 'borrow-withdrawn', action: 'borrow', instrument: 'main', terms: { available: false, quantity: 0, feeRate: 0.018 }, expect: {} },
    {
      id: 'borrow-unavailable', covers: ['borrow unavailable'], action: 'package', instrument: 'main',
      input: pageInput('short', { quantity: 1500 }), strategyPage: { template: 'Short', underlying: 'main', quantity: 1500 },
      status: 'blocked', reason: 'No borrow is available, so the dependent short sale cannot be confirmed.',
      expect: { refused: 'is not available to borrow' },
    },
    { id: 'borrow-back', action: 'borrow', instrument: 'main', terms: { available: true, quantity: 50_000, feeRate: 0.018 }, expect: {} },
    {
      // 1,500 x 50.00 (the bid) = 75,000 of proceeds, restricted. Required: 15 commission + 2% top-up 1,500 + 30% margin 22,500.
      id: 'open-partial', covers: ['open', 'borrow', 'partial fill'], action: 'package', as: 'core', instrument: 'main',
      input: pageInput('short', { quantity: 1500 }), strategyPage: { template: 'Short', underlying: 'main', quantity: 1500 },
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: ['unbounded'], template: 'short',
          legs: [
            { kind: 'borrow_sec', action: 'borrow_sec', purpose: 'financing', instrument: 'main', qty: 1500, borrow: { available: true, feeRate: 0.018, dailyCost: 3.75, source: 'Test fixture' } }, // 1,500 x 50 x 0.018 / 360
            { kind: 'trade', action: 'sell_short', purpose: 'primary', instrument: 'main', qty: 1500, estimate: 50, settleDate: '2026-03-03', cash: 75_000, fees: 15, dependsOn: [1], shortCollateral: { topUp: 1_500, marginHold: 22_500 } },
          ],
          cash: { USD: { purchases: 0, proceeds: 0, restrictedProceeds: 75_000, fees: 15, collateral: 1_500, margin: 22_500, required: 24_015, available: 100_000, shortfall: 0 } },
        },
        result: { status: 'partial', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 1500 }, { kind: 'trade', action: 'sell_short', status: 'partial', qty: 1500, filledQty: 500, avgPrice: 50 }] },
        events: [{ type: 'strategy.submitted', summary: 'Package submitted: Short KSTL (2 legs; open)' }, { type: 'secloan.borrow', summary: 'Borrowed 1,500 KSTL at a fee of 1.800% p.a.' }, { type: 'trade.fill', summary: 'Sold short 500 KSTL @ 50.00 USD' }, { type: 'trade.fill', summary: 'Sold short 500 KSTL @ 50.00 USD' }],
        // Owed to the Account, as restricted cash: 2 x (500 x 50 - 5) = 49,990. Reserved: 0.30 x 1,000 x 50 = 15,000.
        cash: { account: { USD: { settled: 100_000, unsettled: 49_990, receivable: 49_990, reserved: 15_000, restricted: 0, availableToTrade: 85_000, availableToWithdraw: 85_000 } } },
        positions: [borrowed('core', 1500, 75_000), shortPos('core', -1000, -50_000, 0, 0)],
        holdings: { main: { long: 0, short: 1000, net: -1000 } },
        pending: [24_995, 24_995].map((amount) => ({ instrument: 'main', lot: 'core', owner: 'account', dueDate: '2026-03-03', amount, ccy: 'USD', into: 'cash.restricted' })),
        openOrders: [{ instrument: 'main', kind: 'trade', action: 'sell_short', status: 'partial', qty: 1500, filledQty: 1000 }],
        lifecycle: fee(1),
        borrowings: [secBorrow('core', 1500, 75_000, 0, null)], // no collateral until the sale settles
        pnl: { account: { realized: 0, commissions: -10, borrowFunding: 0, unrealized: 0, total: -10 }, book: { realized: 0, commissions: -10, unrealized: 0, total: -10 }, treasury: { total: 0 } },
        nav: { account: 99_990, treasury: 900_000, book: 999_990 },
        balance: {
          account: { cash: 100_000, receivable: 49_990, positions: -50_000, assets: 99_990, liabilities: 0, netAssets: 99_990 },
          book: { cash: 1_000_000, receivable: 49_990, positions: -50_000, assets: 999_990, liabilities: 0, netAssets: 999_990 },
          treasury: { cash: 900_000, assets: 900_000, liabilities: 0, netAssets: 900_000 },
        },
        oversight: { accountBorrowings: [oversee('core', 0)], accounts: { account: { cashBorrowed: 0, fundingReceived: 100_000 } }, treasuryOwn: [] },
      },
    },
    {
      id: 'cancel-remainder', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'core',
      expect: {
        result: { status: 'attention', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 1500 }, { kind: 'trade', action: 'sell_short', status: 'cancelled', qty: 1500, filledQty: 1000 }] },
        events: [{ type: 'order.cancelled', summary: 'Leg 2 cancelled: sell short 1,500 KSTL. Cancelled by user (1,000 of 1,500 had filled and remains in place)' }],
        openOrders: [], failed: { orders: 1 }, alerts: ['strategy.attention'],
      },
    },
    {
      // The 500 not sold are sold against the borrow already held (1,500 borrowed, 1,000 used).
      id: 'retry', covers: ['retry'], action: 'recover', how: 'retry', lot: 'core',
      expect: {
        preview: { blocking: 0, intent: 'retry', legs: [{ kind: 'trade', action: 'sell_short', qty: 500, estimate: 50, cash: 25_000, fees: 5, shortCollateral: { topUp: 500, marginHold: 7_500 } }], cash: { USD: { restrictedProceeds: 25_000, fees: 5, collateral: 500, margin: 7_500, required: 8_005, available: 85_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell_short', status: 'filled', qty: 500, filledQty: 500, avgPrice: 50 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Short KSTL (1 leg; retry)' }, { type: 'trade.fill', summary: 'Sold short 500 KSTL @ 50.00 USD' }],
        cash: { account: { USD: { unsettled: 74_985, receivable: 74_985, reserved: 22_500, availableToTrade: 77_500, availableToWithdraw: 77_500 } } }, // 0.30 x 1,500 x 50
        positions: [borrowed('core', 1500, 75_000), shortPos('core', -1500, -75_000, 0, 0)],
        holdings: { main: { long: 0, short: 1500, net: -1500 } },
        pending: [24_995, 24_995, 24_995].map((amount) => ({ lot: 'core', dueDate: '2026-03-03', amount, into: 'cash.restricted' })),
        pnl: { account: { commissions: -15, total: -15 }, book: { commissions: -15, total: -15 } },
        nav: { account: 99_985, book: 999_985 },
        balance: { account: { receivable: 74_985, positions: -75_000, assets: 99_985, netAssets: 99_985 }, book: { receivable: 74_985, positions: -75_000, assets: 999_985, netAssets: 999_985 } },
        alerts: [],
      },
    },
    {
      // The short-sale leg is changed in the preview to a limit of 52, above the bid: the borrow fills, the sale works.
      id: 'limit-never-reached', covers: ['failed dependent leg'], action: 'package', as: 'limited', instrument: 'main',
      input: pageInput('short', { quantity: 400 }), strategyPage: { template: 'Short', underlying: 'main', quantity: 400 }, editLegs: { 2: { orderType: 'limit', limitPrice: 52 } },
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'borrow_sec', qty: 400, borrow: { available: true, dailyCost: 1 } }, { kind: 'trade', action: 'sell_short', qty: 400, orderType: 'limit', executable: false, cash: 20_000, fees: 4, dependsOn: [1] }], cash: { USD: { restrictedProceeds: 20_000, fees: 4, collateral: 400, margin: 6_000, required: 6_404, available: 77_500, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 400 }, { kind: 'trade', action: 'sell_short', status: 'working', filledQty: 0, reason: 'Limit not reached: executable price 50 is below the limit 52.' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'secloan.borrow', summary: 'Borrowed 400 KSTL at a fee of 1.800% p.a.' }],
        positions: [borrowed('core', 1500, 75_000), borrowed('limited', 400, 20_000), shortPos('core', -1500, -75_000, 0, 0)],
        openOrders: [{ kind: 'trade', action: 'sell_short', status: 'working', qty: 400, filledQty: 0 }],
        lifecycle: fee(2),
        borrowings: [secBorrow('core', 1500, 75_000, 0, null), secBorrow('limited', 400, 20_000, 0, null)],
        oversight: { accountBorrowings: [oversee('core', 0), oversee('limited', 0)] },
      },
    },
    {
      id: 'cancel-limited', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'limited',
      expect: { result: { status: 'attention', orders: [{ kind: 'borrow_sec', status: 'filled' }, { kind: 'trade', status: 'cancelled', filledQty: 0 }] }, events: [{ type: 'order.cancelled', summary: 'Leg 2 cancelled: sell short 400 KSTL. Cancelled by user' }], openOrders: [], failed: { orders: 2 }, alerts: ['strategy.attention'] },
    },
    {
      // Unwind gives back what filled: the borrow, returned the same day (no fee: it never supported a settled sale).
      id: 'unwind', covers: ['unwind', 'return'], action: 'recover', how: 'unwind', lot: 'limited',
      expect: {
        preview: { blocking: 0, intent: 'unwind', legs: [{ kind: 'return_sec', action: 'return_sec', instrument: 'borrow:main', qty: 400 }] },
        result: { status: 'closed', orders: [{ kind: 'return_sec', status: 'filled', filledQty: 400 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Short KSTL (1 leg; unwind)' }, { type: 'secloan.return', summary: 'Returned 400 borrowed KSTL' }],
        positions: [borrowed('core', 1500, 75_000), shortPos('core', -1500, -75_000, 0, 0)],
        lifecycle: fee(1), borrowings: [secBorrow('core', 1500, 75_000, 0, null)], oversight: { accountBorrowings: [oversee('core', 0)] }, alerts: [],
      },
    },
    { id: 'thin-book', action: 'quote', instrument: 'main', quote: { bid: 50.00, ask: 50.10, last: 50.00, bidSize: 100, askSize: 100 }, expect: {} },
    {
      id: 'kept-partial', covers: ['partial fill'], action: 'package', as: 'kept', instrument: 'main',
      input: pageInput('short', { quantity: 400 }), strategyPage: { template: 'Short', underlying: 'main', quantity: 400 },
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'borrow_sec', qty: 400 }, { kind: 'trade', action: 'sell_short', qty: 400, cash: 20_000, fees: 4, shortCollateral: { topUp: 400, marginHold: 6_000 } }], cash: { USD: { required: 6_404, available: 77_500 } } },
        result: { status: 'partial', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 400 }, { kind: 'trade', status: 'partial', qty: 400, filledQty: 100 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'secloan.borrow', summary: 'Borrowed 400 KSTL' }, { type: 'trade.fill', summary: 'Sold short 100 KSTL @ 50.00 USD' }, { type: 'trade.fill', summary: 'Sold short 100 KSTL @ 50.00 USD' }],
        cash: { account: { USD: { unsettled: 84_983, receivable: 84_983, reserved: 25_500, availableToTrade: 74_500, availableToWithdraw: 74_500 } } }, // + 2 x (100 x 50 - 1); + 0.30 x 200 x 50
        positions: [borrowed('core', 1500, 75_000), borrowed('kept', 400, 20_000), shortPos('core', -1500, -75_000, 0, 0), shortPos('kept', -200, -10_000, 0, 0)],
        holdings: { main: { long: 0, short: 1700, net: -1700 } },
        pending: [{ lot: 'kept', amount: 4_999 }, { lot: 'kept', amount: 4_999 }, ...[24_995, 24_995, 24_995].map((amount) => ({ lot: 'core', amount }))],
        openOrders: [{ kind: 'trade', action: 'sell_short', status: 'partial', qty: 400, filledQty: 200 }],
        lifecycle: fee(2), borrowings: [secBorrow('core', 1500, 75_000, 0, null), secBorrow('kept', 400, 20_000, 0, null)], oversight: { accountBorrowings: [oversee('core', 0), oversee('kept', 0)] },
        pnl: { account: { commissions: -17, total: -17 }, book: { commissions: -17, total: -17 } },
        nav: { account: 99_983, book: 999_983 },
        balance: { account: { receivable: 84_983, positions: -85_000, assets: 99_983, netAssets: 99_983 }, book: { receivable: 84_983, positions: -85_000, assets: 999_983, netAssets: 999_983 } },
      },
    },
    { id: 'cancel-kept', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'kept', expect: { result: { status: 'attention' }, events: [{ type: 'order.cancelled', summary: /200 of 400 had filled and remains in place/ }], openOrders: [], failed: { orders: 3 }, alerts: ['strategy.attention'] } },
    { id: 'accept-kept', covers: ['accept as it stands'], action: 'strategy_action', how: 'accept', lot: 'kept', expect: { result: { status: 'open' }, events: [{ type: 'strategy.accepted', summary: 'Short KSTL: accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: [] } },
    { id: 'deep-book', action: 'quote', instrument: 'main', quote: { bid: 50.00, ask: 50.10, last: 50.00, bidSize: 10000, askSize: 10000 }, expect: {} },
    {
      // 1,500 x 1.2 = 1,800: a borrow of 300 more (its own record) and the short sale of 300 after it.
      id: 'resize-up', covers: ['resize', 'increase', 'borrow'], action: 'resize', lot: 'core', factor: 1.2,
      expect: {
        preview: { blocking: 0, intent: 'resize', legs: [{ kind: 'borrow_sec', qty: 300, borrow: { dailyCost: 0.75 } }, { kind: 'trade', action: 'sell_short', qty: 300, cash: 15_000, fees: 3, dependsOn: [1], shortCollateral: { topUp: 300, marginHold: 4_500 } }], cash: { USD: { restrictedProceeds: 15_000, fees: 3, required: 4_803, available: 74_500 } } },
        result: { status: 'open', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 300 }, { kind: 'trade', action: 'sell_short', status: 'filled', filledQty: 300 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Short KSTL (2 legs; resize)' }, { type: 'secloan.borrow', summary: 'Borrowed 300 KSTL' }, { type: 'trade.fill', summary: 'Sold short 300 KSTL @ 50.00 USD' }],
        cash: { account: { USD: { unsettled: 99_980, receivable: 99_980, reserved: 30_000, availableToTrade: 70_000, availableToWithdraw: 70_000 } } },
        positions: [borrowed('core', 300, 15_000), borrowed('core', 1500, 75_000), borrowed('kept', 400, 20_000), shortPos('core', -1800, -90_000, 0, 0), shortPos('kept', -200, -10_000, 0, 0)],
        holdings: { main: { long: 0, short: 2000, net: -2000 } },
        pending: [{ lot: 'kept', amount: 4_999 }, { lot: 'kept', amount: 4_999 }, { lot: 'core', amount: 14_997 }, ...[24_995, 24_995, 24_995].map((amount) => ({ lot: 'core', amount }))],
        lifecycle: fee(3), borrowings: [secBorrow('core', 1500, 75_000, 0, null), secBorrow('core', 300, 15_000, 0, null), secBorrow('kept', 400, 20_000, 0, null)], oversight: { accountBorrowings: [oversee('core', 0), oversee('core', 0), oversee('kept', 0)] },
        pnl: { account: { commissions: -20, total: -20 }, book: { commissions: -20, total: -20 } },
        nav: { account: 99_980, book: 999_980 },
        balance: { account: { receivable: 99_980, positions: -100_000, assets: 99_980, netAssets: 99_980 }, book: { receivable: 99_980, positions: -100_000, assets: 999_980, netAssets: 999_980 } },
      },
    },
    { id: 'roll-refused', covers: ['roll'], action: 'roll', lot: 'core', newExpiration: '2026-04-17', status: 'unsupported', reason: 'A short holding of shares has no option or futures position to roll; the strategy instance offers no Roll.', expect: { refused: { engine: 'holds no option or futures position to roll', api: 'holds no option or futures position to roll', browser: 'offers no Roll' } } },
    {
      // The sales settle into restricted cash and the collateral is marked to 102%: core 1.02 x 1,800 x 50 = 91,800 against
      // 89,982 received (top-up 1,818); kept 1.02 x 200 x 50 = 10,200 against 9,998 (202). No borrow fee yet.
      id: 'next-day', covers: ['settlement', 'collateral mark'], action: 'clock', to: MAR(3),
      expect: {
        events: [
          ...[1, 2, 3].map(() => ({ type: 'settlement.receive', summary: 'Settlement: received 24,995.00 USD into restricted cash' })),
          { type: 'settlement.receive', summary: 'received 4,999.00 USD into restricted cash' }, { type: 'settlement.receive', summary: 'received 4,999.00 USD into restricted cash' }, { type: 'settlement.receive', summary: 'received 14,997.00 USD into restricted cash' },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 1,818.00 USD', cash: { USD: -1_818 } },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 202.00 USD', cash: { USD: -202 } },
        ],
        cash: { account: { USD: { settled: 97_980, unsettled: 0, receivable: 0, reserved: 30_000, restricted: 102_000, availableToTrade: 67_980, availableToWithdraw: 67_980 } } },
        positions: [borrowed('core', 300, 15_000), borrowed('core', 1500, 75_000), borrowed('kept', 400, 20_000), shortPos('core', -1800, -90_000, 0, 91_800), shortPos('kept', -200, -10_000, 0, 10_200)],
        pending: [],
        borrowings: [secBorrow('core', 1500, 75_000, 0, 91_800), secBorrow('core', 300, 15_000, 0, 91_800), secBorrow('kept', 400, 20_000, 0, 10_200)],
        balance: { account: { cash: 97_980, restricted: 102_000, receivable: null, assets: 99_980 }, book: { cash: 997_980, restricted: 102_000, receivable: null, assets: 999_980 } },
      },
    },
    {
      // 5,000 x 50 = 250,000: 30% margin 75,000 + 2% top-up 5,000 + 50 commission = 80,050 against 67,980 free: short 12,070.
      id: 'cash-short-not-financed', covers: ['financing: not financed'], action: 'package', instrument: 'main',
      input: pageInput('short', { quantity: 5000 }), strategyPage: { template: 'Short', underlying: 'main', quantity: 5000 },
      status: 'blocked', reason: 'The short sale needs 80,050.00 of margin, collateral and commission and 67,980.00 is free; "Do not finance" leaves it blocked.',
      expect: { refused: 'Alpha is short 12,070.00 USD' },
    },
    {
      id: 'funded-from-treasury', covers: ['financing: Treasury funding'], action: 'package', as: 'funded', instrument: 'main',
      input: pageInput('short', { quantity: 5000, financing: { mode: 'treasury' } }), strategyPage: { template: 'Short', underlying: 'main', quantity: 5000, financing: { mode: 'treasury' } },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'funding', action: 'treasury_funding', purpose: 'financing', qty: 12_070, cash: 12_070 },
            { kind: 'borrow_sec', purpose: 'financing', qty: 5000, borrow: { dailyCost: 12.5 } }, // 5,000 x 50 x 0.018 / 360
            { kind: 'trade', action: 'sell_short', qty: 5000, estimate: 50, settleDate: '2026-03-04', cash: 250_000, fees: 50, dependsOn: [2, 1], shortCollateral: { topUp: 5_000, marginHold: 75_000 } }, // waits for its borrow and its funding
          ],
          cash: { USD: { restrictedProceeds: 250_000, fees: 50, collateral: 5_000, margin: 75_000, financingIn: 12_070, required: 80_050, available: 67_980, shortfall: 0, netCash: 12_020 } },
        },
        result: { status: 'open', orders: [{ kind: 'funding', status: 'filled', filledQty: 12_070 }, { kind: 'borrow_sec', status: 'filled', filledQty: 5000 }, { kind: 'trade', action: 'sell_short', status: 'filled', filledQty: 5000, avgPrice: 50 }] },
        events: [{ type: 'strategy.submitted', summary: 'Package submitted: Short KSTL (3 legs; open)' }, { type: 'transfer.funding', summary: 'Treasury funding: 12,070.00 USD from Treasury to Alpha (Funding for Short KSTL)', owner: 'treasury' }, { type: 'secloan.borrow', summary: 'Borrowed 5,000 KSTL' }, { type: 'trade.fill', summary: 'Sold short 5,000 KSTL @ 50.00 USD' }],
        cash: {
          account: { USD: { settled: 110_050, unsettled: 249_950, receivable: 249_950, reserved: 105_000, restricted: 102_000, availableToTrade: 5_050, availableToWithdraw: 5_050 } }, // 97,980 + 12,070; 30,000 + 75,000 reserved
          treasury: { USD: { settled: 887_930, availableToTrade: 887_930 } },
        },
        positions: [borrowed('core', 300, 15_000), borrowed('core', 1500, 75_000), borrowed('funded', 5000, 250_000), borrowed('kept', 400, 20_000), shortPos('core', -1800, -90_000, 0, 91_800), shortPos('funded', -5000, -250_000, 0, 0), shortPos('kept', -200, -10_000, 0, 10_200)],
        holdings: { main: { long: 0, short: 7000, net: -7000 } },
        pending: [{ lot: 'funded', dueDate: '2026-03-04', amount: 249_950, into: 'cash.restricted' }],
        lifecycle: fee(4),
        borrowings: [secBorrow('core', 1500, 75_000, 0, 91_800), secBorrow('core', 300, 15_000, 0, 91_800), secBorrow('funded', 5000, 250_000, 0, null), secBorrow('kept', 400, 20_000, 0, 10_200)],
        pnl: { account: { commissions: -70, total: -70 }, book: { commissions: -70, total: -70 }, treasury: { total: 0 } },
        nav: { account: 112_000, treasury: 887_930, book: 999_930 }, // 110,050 + 102,000 + 249,950 - 350,000; internal funding is no Book P&L
        balance: {
          account: { cash: 110_050, restricted: 102_000, receivable: 249_950, positions: -350_000, assets: 112_000, netAssets: 112_000 },
          book: { cash: 997_980, restricted: 102_000, receivable: 249_950, positions: -350_000, assets: 999_930, netAssets: 999_930 },
          treasury: { cash: 887_930, assets: 887_930, netAssets: 887_930 },
        },
        oversight: { accountBorrowings: [oversee('core', 0), oversee('core', 0), oversee('funded', 0), oversee('kept', 0)], accounts: { account: { cashBorrowed: 0, fundingReceived: 112_070 } } },
      },
    },
    {
      // End of Tuesday: borrow fees for the shorts that settled today (on 50.00): 1,500 -> 3.75; 400 -> 1.00; 300 -> 0.75.
      // 'funded' is marked with its proceeds still on the way: 1.02 x 5,000 x 50 = 255,000 against 249,950 to come: 5,050 posted.
      id: 'fee-day', covers: ['borrow fee', 'collateral mark'], action: 'clock', to: MAR(3, '17:30'),
      expect: {
        events: [
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,500 KSTL: 3.75 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 400 KSTL: 1.00 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 300 KSTL: 0.75 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 5,050.00 USD', cash: { USD: -5_050 } },
        ],
        cash: { account: { USD: { settled: 105_000, restricted: 107_050, availableToTrade: 0, availableToWithdraw: 0 } } },
        positions: [borrowed('core', 300, 15_000, -0.75), borrowed('core', 1500, 75_000, -3.75), borrowed('funded', 5000, 250_000), borrowed('kept', 400, 20_000, -1), shortPos('core', -1800, -90_000, 0, 91_800), shortPos('funded', -5000, -250_000, 0, 5_050), shortPos('kept', -200, -10_000, 0, 10_200)],
        borrowings: [secBorrow('core', 1500, 75_000, 3.75, 91_800), secBorrow('core', 300, 15_000, 0.75, 91_800), secBorrow('funded', 5000, 250_000, 0, 5_050), secBorrow('kept', 400, 20_000, 1, 10_200)],
        oversight: { accountBorrowings: [oversee('core', 3.75), oversee('core', 0.75), oversee('funded', 0), oversee('kept', 1)] },
        pnl: { account: { borrowFunding: -5.5, total: -75.5 }, book: { borrowFunding: -5.5, total: -75.5 } },
        nav: { account: 111_994.5, book: 999_924.5 },
        balance: { account: { cash: 105_000, restricted: 107_050, accruedExpense: 5.5, liabilities: 5.5, netAssets: 111_994.5 }, book: { cash: 992_930, restricted: 107_050, accruedExpense: 5.5, liabilities: 5.5, netAssets: 999_924.5 } },
      },
    },
    {
      id: 'settle-funded', covers: ['settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'Settlement: received 249,950.00 USD into restricted cash' }],
        cash: { account: { USD: { unsettled: 0, receivable: 0, restricted: 357_000 } } },
        positions: [borrowed('core', 300, 15_000, -0.75), borrowed('core', 1500, 75_000, -3.75), borrowed('funded', 5000, 250_000), borrowed('kept', 400, 20_000, -1), shortPos('core', -1800, -90_000, 0, 91_800), shortPos('funded', -5000, -250_000, 0, 255_000), shortPos('kept', -200, -10_000, 0, 10_200)],
        pending: [],
        borrowings: [secBorrow('core', 1500, 75_000, 3.75, 91_800), secBorrow('core', 300, 15_000, 0.75, 91_800), secBorrow('funded', 5000, 250_000, 0, 255_000), secBorrow('kept', 400, 20_000, 1, 10_200)],
        balance: { account: { restricted: 357_000, receivable: null }, book: { restricted: 357_000, receivable: null } },
      },
    },
    {
      // 600 x 50 = 30,000: 9,000 margin + 600 top-up + 6 commission = 9,606 needed, nothing free: a margin loan of 9,606.00 at 6%.
      id: 'funded-by-loan', covers: ['financing: borrow'], action: 'package', as: 'levered', instrument: 'main', contractAs: 'loan',
      input: pageInput('short', { quantity: 600, financing: { mode: 'loan', rateType: 'fixed', rate: 0.06 } }), strategyPage: { template: 'Short', underlying: 'main', quantity: 600, financing: { mode: 'loan', rate: 0.06 } },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'loan', action: 'borrow_cash', purpose: 'financing', qty: 9_606, cash: 9_606, dailyCost: 1.6, financing: { amount: 9_606, rateType: 'fixed', rate: 0.06, interestFrom: '2026-03-04' } }, // 9,606 x 0.06 / 360 = 1.601
            { kind: 'borrow_sec', qty: 600, borrow: { dailyCost: 1.5 } },
            { kind: 'trade', action: 'sell_short', qty: 600, cash: 30_000, fees: 6, settleDate: '2026-03-05', dependsOn: [2, 1] },
          ],
          cash: { USD: { restrictedProceeds: 30_000, fees: 6, collateral: 600, margin: 9_000, financingIn: 9_606, required: 9_606, available: 0, shortfall: 0, netCash: 9_600 } },
        },
        result: { status: 'open', orders: [{ kind: 'loan', instrument: 'loan', status: 'filled', filledQty: 9_606 }, { kind: 'borrow_sec', status: 'filled', filledQty: 600 }, { kind: 'trade', action: 'sell_short', status: 'filled', filledQty: 600 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'loan.drawdown', summary: 'Borrowed 9,606.00 USD (margin, 6.000% fixed, open-ended)', cash: { USD: 9_606 } }, { type: 'secloan.borrow', summary: 'Borrowed 600 KSTL' }, { type: 'trade.fill', summary: 'Sold short 600 KSTL @ 50.00 USD' }],
        cash: { account: { USD: { settled: 114_606, unsettled: 29_994, receivable: 29_994, reserved: 114_000, availableToTrade: 606, availableToWithdraw: 606, borrowed: 9_606 } } },
        positions: [borrowed('core', 300, 15_000, -0.75), borrowed('core', 1500, 75_000, -3.75), borrowed('funded', 5000, 250_000), borrowed('kept', 400, 20_000, -1), borrowed('levered', 600, 30_000),
          { instrument: 'loan', lot: 'levered', owner: 'account', direction: 'borrowed', qty: -9_606, carrying: -9_606 },
          shortPos('core', -1800, -90_000, 0, 91_800), shortPos('funded', -5000, -250_000, 0, 255_000), shortPos('kept', -200, -10_000, 0, 10_200), shortPos('levered', -600, -30_000, 0, 0)],
        holdings: { main: { long: 0, short: 7600, net: -7600 } },
        pending: [{ lot: 'levered', dueDate: '2026-03-05', amount: 29_994, into: 'cash.restricted' }],
        lifecycle: [{ type: 'loan.interest', instrument: 'loan', dueDate: '2026-04-01', status: 'pending' }, ...fee(5)],
        borrowings: [{ owner: 'account', family: 'loan', lot: 'levered', principal: 9_606, rate: 0.06, accrued: 0 }, secBorrow('core', 1500, 75_000, 3.75, 91_800), secBorrow('core', 300, 15_000, 0.75, 91_800), secBorrow('funded', 5000, 250_000, 0, 255_000), secBorrow('kept', 400, 20_000, 1, 10_200), secBorrow('levered', 600, 30_000, 0, null)],
        oversight: { accountBorrowings: [oversee('core', 3.75), oversee('core', 0.75), oversee('funded', 0), oversee('kept', 1), oversee('levered', 0, 9_606), oversee('levered', 0)], accounts: { account: { cashBorrowed: 9_606, fundingReceived: 112_070 } } },
        pnl: { account: { commissions: -76, total: -81.5 }, book: { commissions: -76, total: -81.5 } },
        nav: { account: 111_988.5, book: 999_918.5 },
        balance: {
          account: { cash: 114_606, receivable: 29_994, positions: -380_000, borrowed: 9_606, assets: 121_600, liabilities: 9_611.5, netAssets: 111_988.5 },
          book: { cash: 1_002_536, receivable: 29_994, positions: -380_000, borrowed: 9_606, assets: 1_009_530, liabilities: 9_611.5, netAssets: 999_918.5 },
        },
      },
    },
    {
      // Wednesday's end of day: fees on the shorts settled by then, on 50.00 (core 3.75 + 0.75, kept 1.00, funded 12.50).
      // The loan's interest is accrued as of the business date, from its drawdown on Wednesday: none yet.
      id: 'settle-levered', covers: ['settlement', 'borrow fee', 'collateral mark'], action: 'clock', to: MAR(5),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'Settlement: received 29,994.00 USD into restricted cash' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,500 KSTL: 3.75 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 400 KSTL: 1.00 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 300 KSTL: 0.75 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 5,000 KSTL: 12.50 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 606.00 USD', cash: { USD: -606 } }, // 1.02 x 600 x 50 = 30,600 against 29,994
        ],
        cash: { account: { USD: { settled: 114_000, unsettled: 0, receivable: 0, restricted: 387_600, availableToTrade: 0, availableToWithdraw: 0 } } },
        positions: [borrowed('core', 300, 15_000, -1.5), borrowed('core', 1500, 75_000, -7.5), borrowed('funded', 5000, 250_000, -12.5), borrowed('kept', 400, 20_000, -2), borrowed('levered', 600, 30_000),
          { instrument: 'loan', lot: 'levered', qty: -9_606 }, shortPos('core', -1800, -90_000, 0, 91_800), shortPos('funded', -5000, -250_000, 0, 255_000), shortPos('kept', -200, -10_000, 0, 10_200), shortPos('levered', -600, -30_000, 0, 30_600)],
        pending: [],
        borrowings: [{ family: 'loan', lot: 'levered', principal: 9_606, accrued: 0 }, secBorrow('core', 1500, 75_000, 7.5, 91_800), secBorrow('core', 300, 15_000, 1.5, 91_800), secBorrow('funded', 5000, 250_000, 12.5, 255_000), secBorrow('kept', 400, 20_000, 2, 10_200), secBorrow('levered', 600, 30_000, 0, 30_600)],
        oversight: { accountBorrowings: [oversee('core', 7.5), oversee('core', 1.5), oversee('funded', 12.5), oversee('kept', 2), oversee('levered', 0, 9_606), oversee('levered', 0)] },
        pnl: { account: { borrowFunding: -23.5, total: -99.5 }, book: { borrowFunding: -23.5, total: -99.5 } },
        nav: { account: 111_970.5, book: 999_900.5 },
        balance: { account: { cash: 114_000, restricted: 387_600, receivable: null, accruedExpense: 23.5, liabilities: 9_629.5, netAssets: 111_970.5 }, book: { cash: 1_001_930, restricted: 387_600, receivable: null, accruedExpense: 23.5, liabilities: 9_629.5, netAssets: 999_900.5 } },
      },
    },
    {
      id: 'treasury-top-up', covers: ['transfer'], action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 400_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 400,000.00 USD from Treasury to Alpha', owner: 'treasury' }],
        cash: { account: { USD: { settled: 514_000, availableToTrade: 400_000, availableToWithdraw: 400_000 } }, treasury: { USD: { settled: 487_930, availableToTrade: 487_930 } } },
        nav: { account: 511_970.5, treasury: 487_930 },
        balance: { account: { cash: 514_000, assets: 521_600, netAssets: 511_970.5 }, treasury: { cash: 487_930, assets: 487_930, netAssets: 487_930 } },
        oversight: { accounts: { account: { fundingReceived: 512_070 } } },
      },
    },
    {
      id: 'price-down', action: 'quote', instrument: 'main', quote: { bid: 48.00, ask: 48.10, last: 48.00, bidSize: 10000, askSize: 10000 },
      expect: {
        positions: [borrowed('core', 300, 14_400, -1.5), borrowed('core', 1500, 72_000, -7.5), borrowed('funded', 5000, 240_000, -12.5), borrowed('kept', 400, 19_200, -2), borrowed('levered', 600, 28_800),
          { instrument: 'loan', lot: 'levered', qty: -9_606 },
          shortPos('core', -1800, -86_400, 3_600, 91_800), shortPos('funded', -5000, -240_000, 10_000, 255_000), shortPos('kept', -200, -9_600, 400, 10_200), shortPos('levered', -600, -28_800, 1_200, 30_600)], // (50 - 48) x quantity
        borrowings: [{ family: 'loan', principal: 9_606 }, secBorrow('core', 1500, 72_000, 7.5, 91_800), secBorrow('core', 300, 14_400, 1.5, 91_800), secBorrow('funded', 5000, 240_000, 12.5, 255_000), secBorrow('kept', 400, 19_200, 2, 10_200), secBorrow('levered', 600, 28_800, 0, 30_600)],
        pnl: { account: { unrealized: 15_200, total: 15_100.5 }, book: { unrealized: 15_200, total: 15_100.5 } },
        nav: { account: 527_170.5, book: 1_015_100.5 },
        balance: { account: { positions: -364_800, assets: 536_800, netAssets: 527_170.5 }, book: { positions: -364_800, assets: 1_024_730, netAssets: 1_015_100.5 } },
      },
    },
    {
      // Half of 'core': cover 900 at 48.10 (the ask) and give back half of each borrow record (750 and 150) once it fills.
      // Realized 900 x (50 - 48.10) = 1,710. Each partly returned borrow has its fee accrued to today, on 48.00:
      // 1,500 x 48 x 0.018 / 360 = 3.60; 300 x 48 x 0.018 / 360 = 0.72. The cover is paid from the short's restricted cash.
      id: 'close-share', covers: ['reduce', 'close share', 'return'], action: 'close', lot: 'core', scope: 'strategy', percent: 50,
      expect: {
        preview: {
          blocking: 0, errors: [], notes: ['arrangement', 'arrangement'],
          legs: [
            { kind: 'trade', action: 'buy_to_cover', instrument: 'main', qty: 900, estimate: 48.1, settleDate: '2026-03-06', cash: -43_290, fees: 9 },
            { kind: 'return_sec', instrument: 'borrow:main', qty: 750, dependsOn: [1] }, { kind: 'return_sec', instrument: 'borrow:main', qty: 150, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 43_290, fees: 9, coverCollateral: 43_299, required: 43_299, available: 400_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 900, avgPrice: 48.1 }, { kind: 'return_sec', status: 'filled', filledQty: 750 }, { kind: 'return_sec', status: 'filled', filledQty: 150 }] },
        events: [
          { type: 'strategy.legs_added', summary: 'Legs added to Short KSTL (3 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 900 KSTL @ 48.10 USD (realized 1,710.00 USD)' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,500 KSTL: 3.60 USD' }, { type: 'secloan.return', summary: 'Returned 750 borrowed KSTL' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 300 KSTL: 0.72 USD' }, { type: 'secloan.return', summary: 'Returned 150 borrowed KSTL' },
        ],
        // Reserved: core now 0.30 x 900 x 48 = 12,960, the others still on Wednesday's 50.00 (75,000 + 3,000 + 9,000).
        cash: { account: { USD: { unsettled: -43_299, payable: 43_299, reserved: 99_960, availableToTrade: 370_741, availableToWithdraw: 370_741 } } },
        positions: [borrowed('core', 150, 7_200, -2.22), borrowed('core', 750, 36_000, -11.1), borrowed('funded', 5000, 240_000, -12.5), borrowed('kept', 400, 19_200, -2), borrowed('levered', 600, 28_800),
          { instrument: 'loan', lot: 'levered', qty: -9_606 },
          shortPos('core', -900, -43_200, 1_800, 91_800), shortPos('funded', -5000, -240_000, 10_000, 255_000), shortPos('kept', -200, -9_600, 400, 10_200), shortPos('levered', -600, -28_800, 1_200, 30_600)],
        holdings: { main: { long: 0, short: 6700, net: -6700 } },
        pending: [{ lot: 'core', dueDate: '2026-03-06', amount: -43_299, into: 'cash.restricted' }],
        borrowings: [{ family: 'loan', principal: 9_606 }, secBorrow('core', 750, 36_000, 11.1, 91_800), secBorrow('core', 150, 7_200, 2.22, 91_800), secBorrow('funded', 5000, 240_000, 12.5, 255_000), secBorrow('kept', 400, 19_200, 2, 10_200), secBorrow('levered', 600, 28_800, 0, 30_600)],
        oversight: { accountBorrowings: [oversee('core', 11.1), oversee('core', 2.22), oversee('funded', 12.5), oversee('kept', 2), oversee('levered', 0, 9_606), oversee('levered', 0)] },
        pnl: { account: { realized: 1_710, commissions: -85, borrowFunding: -27.82, unrealized: 13_400, total: 14_997.18 }, book: { realized: 1_710, commissions: -85, borrowFunding: -27.82, unrealized: 13_400, total: 14_997.18 } },
        nav: { account: 527_067.18, book: 1_014_997.18 },
        balance: {
          account: { payable: 43_299, positions: -321_600, accruedExpense: 27.82, assets: 580_000, liabilities: 52_932.82, netAssets: 527_067.18 },
          book: { payable: 43_299, positions: -321_600, accruedExpense: 27.82, assets: 1_067_930, liabilities: 52_932.82, netAssets: 1_014_997.18 },
        },
      },
    },
    {
      // Exactly 300 of the 900: the cover returns as much of a borrow with it (the first record, 750 -> 450). Realized 570.
      id: 'close-exact', covers: ['reduce', 'close exact amount', 'return'], action: 'close', lot: 'core', instrument: 'main', qty: 300,
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy_to_cover', qty: 300, estimate: 48.1, cash: -14_430, fees: 3 }, { kind: 'return_sec', qty: 300, dependsOn: [1] }], cash: { USD: { purchases: 14_430, fees: 3, coverCollateral: 14_433, required: 14_433, available: 370_741, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 300 }, { kind: 'return_sec', status: 'filled', filledQty: 300 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Short KSTL (2 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 300 KSTL @ 48.10 USD (realized 570.00 USD)' }, { type: 'secloan.return', summary: 'Returned 300 borrowed KSTL' }],
        cash: { account: { USD: { unsettled: -57_732, payable: 57_732, reserved: 95_640, availableToTrade: 360_628, availableToWithdraw: 360_628 } } }, // core reserve 0.30 x 600 x 48 = 8,640
        positions: [borrowed('core', 150, 7_200, -2.22), borrowed('core', 450, 21_600, -11.1), borrowed('funded', 5000, 240_000, -12.5), borrowed('kept', 400, 19_200, -2), borrowed('levered', 600, 28_800),
          { instrument: 'loan', lot: 'levered', qty: -9_606 },
          shortPos('core', -600, -28_800, 1_200, 91_800), shortPos('funded', -5000, -240_000, 10_000, 255_000), shortPos('kept', -200, -9_600, 400, 10_200), shortPos('levered', -600, -28_800, 1_200, 30_600)],
        holdings: { main: { long: 0, short: 6400, net: -6400 } },
        pending: [{ lot: 'core', amount: -43_299 }, { lot: 'core', amount: -14_433 }],
        borrowings: [{ family: 'loan', principal: 9_606 }, secBorrow('core', 450, 21_600, 11.1, 91_800), secBorrow('core', 150, 7_200, 2.22, 91_800), secBorrow('funded', 5000, 240_000, 12.5, 255_000), secBorrow('kept', 400, 19_200, 2, 10_200), secBorrow('levered', 600, 28_800, 0, 30_600)],
        pnl: { account: { realized: 2_280, commissions: -88, unrealized: 12_800, total: 14_964.18 }, book: { realized: 2_280, commissions: -88, unrealized: 12_800, total: 14_964.18 } },
        nav: { account: 527_034.18, book: 1_014_964.18 },
        balance: { account: { payable: 57_732, positions: -307_200, assets: 594_400, liabilities: 67_365.82, netAssets: 527_034.18 }, book: { payable: 57_732, positions: -307_200, assets: 1_082_330, liabilities: 67_365.82, netAssets: 1_014_964.18 } },
      },
    },
    {
      // The rest of 'core': cover 600 and return both records in full; each pays its fee (11.10 and 2.22). Realized 1,140.
      id: 'close-all', covers: ['close', 'return', 'borrow fee'], action: 'close', lot: 'core', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy_to_cover', qty: 600, cash: -28_860, fees: 6 }, { kind: 'return_sec', qty: 450, dependsOn: [1] }, { kind: 'return_sec', qty: 150, dependsOn: [1] }], cash: { USD: { purchases: 28_860, fees: 6, coverCollateral: 28_866, required: 28_866, available: 360_628 } } },
        result: { status: 'closed', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 600 }, { kind: 'return_sec', status: 'filled', filledQty: 450 }, { kind: 'return_sec', status: 'filled', filledQty: 150 }] },
        events: [
          { type: 'strategy.legs_added', summary: 'Legs added to Short KSTL (3 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 600 KSTL @ 48.10 USD (realized 1,140.00 USD)' },
          { type: 'secloan.return', summary: 'Returned 450 borrowed KSTL' }, { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Short KSTL): 11.10 USD', cash: { USD: -11.1 } },
          { type: 'secloan.return', summary: 'Returned 150 borrowed KSTL' }, { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Short KSTL): 2.22 USD', cash: { USD: -2.22 } },
        ],
        cash: { account: { USD: { settled: 513_986.68, unsettled: -86_598, payable: 86_598, reserved: 87_000, availableToTrade: 340_388.68, availableToWithdraw: 340_388.68 } } },
        positions: [borrowed('funded', 5000, 240_000, -12.5), borrowed('kept', 400, 19_200, -2), borrowed('levered', 600, 28_800), { instrument: 'loan', lot: 'levered', qty: -9_606 },
          shortPos('funded', -5000, -240_000, 10_000, 255_000), shortPos('kept', -200, -9_600, 400, 10_200), shortPos('levered', -600, -28_800, 1_200, 30_600)],
        holdings: { main: { long: 0, short: 5800, net: -5800 } },
        pending: [{ lot: 'core', amount: -43_299 }, { lot: 'core', amount: -28_866 }, { lot: 'core', amount: -14_433 }],
        lifecycle: [{ type: 'loan.interest', instrument: 'loan', dueDate: '2026-04-01' }, ...fee(3)],
        borrowings: [{ family: 'loan', principal: 9_606 }, secBorrow('funded', 5000, 240_000, 12.5, 255_000), secBorrow('kept', 400, 19_200, 2, 10_200), secBorrow('levered', 600, 28_800, 0, 30_600)],
        oversight: { accountBorrowings: [oversee('funded', 12.5), oversee('kept', 2), oversee('levered', 0, 9_606), oversee('levered', 0)] },
        pnl: { account: { realized: 3_420, commissions: -94, unrealized: 11_600, total: 14_898.18 }, book: { realized: 3_420, commissions: -94, unrealized: 11_600, total: 14_898.18 } },
        nav: { account: 526_968.18, book: 1_014_898.18 },
        balance: {
          account: { cash: 513_986.68, payable: 86_598, positions: -278_400, accruedExpense: 14.5, assets: 623_186.68, liabilities: 96_218.5, netAssets: 526_968.18 },
          book: { cash: 1_001_916.68, payable: 86_598, positions: -278_400, accruedExpense: 14.5, assets: 1_111_116.68, liabilities: 96_218.5, netAssets: 1_014_898.18 },
        },
      },
    },
    {
      // Cover 600, repay the loan with interest to today (one day, 9,606 x 0.06 / 360 = 1.601 -> 1.60) from the settled cash
      // Treasury provided, and return the borrow after the cover, paying its fee for today (600 x 48 x 0.018 / 360 = 1.44).
      id: 'close-levered', covers: ['close', 'repay', 'return'], action: 'close', lot: 'levered', scope: 'strategy',
      expect: {
        preview: {
          blocking: 0,
          legs: [
            { kind: 'trade', action: 'buy_to_cover', qty: 600, cash: -28_860, fees: 6 },
            { kind: 'repay', action: 'repay_cash', instrument: 'loan', qty: 9_606, cash: -9_607.6, financing: { principal: 9_606, interest: 1.6, full: true, interestThrough: '2026-03-05' } },
            { kind: 'return_sec', qty: 600, dependsOn: [1] },
          ],
          cash: { USD: { purchases: 28_860, fees: 6, financingOut: 9_607.6, coverCollateral: 28_866, required: 38_473.6, available: 340_388.68, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 600 }, { kind: 'repay', status: 'filled', filledQty: 9_606 }, { kind: 'return_sec', status: 'filled', filledQty: 600 }] },
        events: [
          { type: 'strategy.legs_added', summary: 'Legs added to Short KSTL (3 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 600 KSTL @ 48.10 USD (realized 1,140.00 USD)' },
          { type: 'accrual.interest', summary: 'Interest accrued on Margin loan USD (Short KSTL): 1.60 USD' },
          { type: 'loan.repayment', summary: 'Repaid 9,606.00 USD of principal on Margin loan USD (Short KSTL) (in full)', cash: { USD: -9_606 } },
          { type: 'interest.payment', summary: 'Interest paid on Margin loan USD (Short KSTL): 1.60 USD', cash: { USD: -1.6 } },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 600 KSTL: 1.44 USD' }, { type: 'secloan.return', summary: 'Returned 600 borrowed KSTL' },
          { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Short KSTL): 1.44 USD', cash: { USD: -1.44 } },
        ],
        cash: { account: { USD: { settled: 504_377.64, unsettled: -115_464, payable: 115_464, reserved: 78_000, availableToTrade: 310_913.64, availableToWithdraw: 310_913.64, borrowed: 0 } } }, // 513,986.68 - 9,606 - 1.60 - 1.44
        positions: [borrowed('funded', 5000, 240_000, -12.5), borrowed('kept', 400, 19_200, -2), shortPos('funded', -5000, -240_000, 10_000, 255_000), shortPos('kept', -200, -9_600, 400, 10_200)],
        holdings: { main: { long: 0, short: 5200, net: -5200 } },
        pending: [{ lot: 'core', amount: -43_299 }, { lot: 'core', amount: -28_866 }, { lot: 'levered', amount: -28_866 }, { lot: 'core', amount: -14_433 }],
        lifecycle: fee(2),
        borrowings: [secBorrow('funded', 5000, 240_000, 12.5, 255_000), secBorrow('kept', 400, 19_200, 2, 10_200)],
        oversight: { accountBorrowings: [oversee('funded', 12.5), oversee('kept', 2)], accounts: { account: { cashBorrowed: 0 } } },
        pnl: { account: { realized: 4_560, commissions: -100, borrowFunding: -30.86, unrealized: 10_400, total: 14_829.14 }, book: { realized: 4_560, commissions: -100, borrowFunding: -30.86, unrealized: 10_400, total: 14_829.14 } },
        nav: { account: 526_899.14, book: 1_014_829.14 },
        balance: {
          account: { cash: 504_377.64, payable: 115_464, positions: -249_600, borrowed: null, assets: 642_377.64, liabilities: 115_478.5, netAssets: 526_899.14 },
          book: { cash: 992_307.64, payable: 115_464, positions: -249_600, borrowed: null, assets: 1_130_307.64, liabilities: 115_478.5, netAssets: 1_014_829.14 },
        },
      },
    },
    {
      // Realized 5,000 x 1.90 = 9,500. Fee for today 5,000 x 48 x 0.018 / 360 = 12.00; paid 12.50 + 12.00 = 24.50.
      id: 'close-funded', covers: ['close', 'return', 'borrow fee'], action: 'close', lot: 'funded', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy_to_cover', qty: 5000, cash: -240_500, fees: 50 }, { kind: 'return_sec', qty: 5000, dependsOn: [1] }], cash: { USD: { purchases: 240_500, fees: 50, coverCollateral: 240_550, required: 240_550, available: 310_913.64, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 5000 }, { kind: 'return_sec', status: 'filled', filledQty: 5000 }] },
        events: [
          { type: 'strategy.legs_added', summary: 'Legs added to Short KSTL (2 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 5,000 KSTL @ 48.10 USD (realized 9,500.00 USD)' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 5,000 KSTL: 12.00 USD' }, { type: 'secloan.return', summary: 'Returned 5,000 borrowed KSTL' },
          { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Short KSTL): 24.50 USD', cash: { USD: -24.5 } },
        ],
        cash: { account: { USD: { settled: 504_353.14, unsettled: -356_014, payable: 356_014, reserved: 3_000, availableToTrade: 145_339.14, availableToWithdraw: 145_339.14 } } },
        positions: [borrowed('kept', 400, 19_200, -2), shortPos('kept', -200, -9_600, 400, 10_200)],
        holdings: { main: { long: 0, short: 200, net: -200 } },
        pending: [{ lot: 'funded', amount: -240_550 }, { lot: 'core', amount: -43_299 }, { lot: 'core', amount: -28_866 }, { lot: 'levered', amount: -28_866 }, { lot: 'core', amount: -14_433 }],
        lifecycle: fee(1), borrowings: [secBorrow('kept', 400, 19_200, 2, 10_200)], oversight: { accountBorrowings: [oversee('kept', 2)] },
        pnl: { account: { realized: 14_060, commissions: -150, borrowFunding: -42.86, unrealized: 400, total: 14_267.14 }, book: { realized: 14_060, commissions: -150, borrowFunding: -42.86, unrealized: 400, total: 14_267.14 } },
        nav: { account: 526_337.14, book: 1_014_267.14 },
        balance: {
          account: { cash: 504_353.14, payable: 356_014, positions: -9_600, accruedExpense: 2, assets: 882_353.14, liabilities: 356_016, netAssets: 526_337.14 },
          book: { cash: 992_283.14, payable: 356_014, positions: -9_600, accruedExpense: 2, assets: 1_370_283.14, liabilities: 356_016, netAssets: 1_014_267.14 },
        },
      },
    },
    {
      // The accepted package: cover its 200 and return its whole borrow of 400 (fee 1.00 + 1.00 + 0.96 = 2.96). Realized 380.
      id: 'close-kept', covers: ['close', 'return', 'borrow fee'], action: 'close', lot: 'kept', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy_to_cover', qty: 200, cash: -9_620, fees: 2 }, { kind: 'return_sec', qty: 400, dependsOn: [1] }], cash: { USD: { purchases: 9_620, fees: 2, coverCollateral: 9_622, required: 9_622, available: 145_339.14 } } },
        result: { status: 'closed', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 200 }, { kind: 'return_sec', status: 'filled', filledQty: 400 }] },
        events: [
          { type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Bought to cover 200 KSTL @ 48.10 USD (realized 380.00 USD)' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 400 KSTL: 0.96 USD' }, { type: 'secloan.return', summary: 'Returned 400 borrowed KSTL' },
          { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Short KSTL): 2.96 USD', cash: { USD: -2.96 } },
        ],
        cash: { account: { USD: { settled: 504_350.18, unsettled: -365_636, payable: 365_636, reserved: 0, availableToTrade: 138_714.18, availableToWithdraw: 138_714.18 } } },
        positions: [], holdings: { main: null },
        pending: [{ lot: 'funded', amount: -240_550 }, { lot: 'core', amount: -43_299 }, { lot: 'core', amount: -28_866 }, { lot: 'levered', amount: -28_866 }, { lot: 'core', amount: -14_433 }, { lot: 'kept', amount: -9_622 }],
        lifecycle: [], borrowings: [], oversight: { accountBorrowings: [] },
        pnl: { account: { realized: 14_440, commissions: -152, borrowFunding: -43.82, unrealized: 0, total: 14_244.18 }, book: { realized: 14_440, commissions: -152, borrowFunding: -43.82, unrealized: 0, total: 14_244.18 } },
        nav: { account: 526_314.18, book: 1_014_244.18 },
        balance: {
          account: { cash: 504_350.18, payable: 365_636, positions: null, accruedExpense: null, assets: 891_950.18, liabilities: 365_636, netAssets: 526_314.18 },
          book: { cash: 992_280.18, payable: 365_636, positions: null, accruedExpense: null, assets: 1_379_880.18, liabilities: 365_636, netAssets: 1_014_244.18 },
        },
      },
    },
    {
      // The covers settle from restricted cash; what each short's collateral had beyond its cover comes back to settled cash:
      // core 91,800 - 86,598 = 5,202; kept 10,200 - 9,622 = 578; funded 255,000 - 240,550 = 14,450; levered 30,600 - 28,866 = 1,734.
      id: 'settle-covers', covers: ['settlement', 'collateral release'], action: 'clock', to: MAR(6),
      expect: {
        events: [
          { type: 'settlement.pay', summary: 'Settlement: paid 43,299.00 USD from restricted cash' }, { type: 'settlement.pay', summary: 'paid 14,433.00 USD from restricted cash' }, { type: 'settlement.pay', summary: 'paid 28,866.00 USD from restricted cash' },
          { type: 'settlement.pay', summary: 'paid 28,866.00 USD from restricted cash' }, { type: 'settlement.pay', summary: 'paid 240,550.00 USD from restricted cash' }, { type: 'settlement.pay', summary: 'paid 9,622.00 USD from restricted cash' },
          { type: 'collateral.mark', summary: 'released 5,202.00 USD', cash: { USD: 5_202 } }, { type: 'collateral.mark', summary: 'released 578.00 USD', cash: { USD: 578 } },
          { type: 'collateral.mark', summary: 'released 14,450.00 USD', cash: { USD: 14_450 } }, { type: 'collateral.mark', summary: 'released 1,734.00 USD', cash: { USD: 1_734 } },
        ],
        // Nothing is left restricted, reserved, borrowed or scheduled. Whole scenario: realized 14,440; commissions 152;
        // borrow fees 42.22 and loan interest 1.60. 100,000 + 12,070 + 400,000 funded + 14,244.18 = 526,314.18.
        cash: { account: { USD: { settled: 526_314.18, unsettled: 0, payable: 0, receivable: 0, reserved: 0, restricted: 0, availableToTrade: 526_314.18, availableToWithdraw: 526_314.18, borrowed: 0 } } },
        pending: [],
        balance: { account: { cash: 526_314.18, restricted: null, payable: null, assets: 526_314.18, liabilities: 0, netAssets: 526_314.18 }, book: { cash: 1_014_244.18, restricted: null, payable: null, assets: 1_014_244.18, liabilities: 0, netAssets: 1_014_244.18 } },
      },
    },
    {
      id: 'return-to-treasury', covers: ['transfer'], action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 400_000,
      expect: {
        events: [{ type: 'transfer.return', summary: 'Return to Treasury: 400,000.00 USD from Alpha to Treasury', owner: 'account' }],
        cash: { account: { USD: { settled: 126_314.18, availableToTrade: 126_314.18, availableToWithdraw: 126_314.18 } }, treasury: { USD: { settled: 887_930, availableToTrade: 887_930 } } },
        nav: { account: 126_314.18, treasury: 887_930, book: 1_014_244.18 },
        balance: { account: { cash: 126_314.18, assets: 126_314.18, netAssets: 126_314.18 }, treasury: { cash: 887_930, assets: 887_930, netAssets: 887_930 } },
        oversight: { accountBorrowings: [], accounts: { account: { cashBorrowed: 0, fundingReceived: 112_070 } }, treasuryOwn: [] },
      },
    },
  ],
};


// ---------------------------------------------------------------------------------------------
// protective_put
// ---------------------------------------------------------------------------------------------
// Two legs: buy the shares, and buy one put per 100 shares (the contract's deliverable). The puts wait for the shares
// and are scaled to what of them filled. A small displayed size fills both in parts; the remainder is cancelled and
// retried. A put held at a limit never reached is cancelled and the shares unwound; another is accepted as it stands,
// and its shares are then covered again by a protective put on the existing holding (no new shares: the holding is
// linked to the new strategy instance). The first package is resized, and its puts rolled to April. At the March
// expiry (close 49.00) the 50 put is in the money and is exercised against the 100 shares it protects (a simulated
// delivery at the strike); the 48 puts lapse. Cash short: blocked, funded from Treasury, borrowed and repaid.
const pp = (qty, strike, extra = {}) => pageInput('protective_put', { quantity: qty, options: { expiration: '2026-03-20', strikes: { put: strike }, contracts: null }, ...extra });
const ppPage = (qty, strike, extra = {}) => ({ template: 'Protective Put / Long + Put Cover', underlying: 'main', quantity: qty, expiration: '2026-03-20', strikes: { 'Put strike': strike }, ...extra });
const longPos = (instrument, lot, qty, avgCost, cost, price, value, unrealized) => ({ instrument, lot, owner: 'account', direction: 'long', qty, avgCost, cost, price, value, unrealized });
const expiryItem = (instrument, dueDate = '2026-03-20') => ({ type: 'option.expiry', instrument, dueDate, status: 'pending', owner: 'account' });

const protectivePut = {
  template: 'protective_put',
  title: 'Protective put on Kestrel Logistics: shares and puts as one package, new and existing holding, partial fills, expiry, roll',
  matrix: {
    ...TEMPLATE_MATRIX,
    ticket: 'Strategies page (Protective Put / Long + Put Cover): Trading owner and intent, Instrument and template, Underlying position (new or existing), Option contracts, Order and funding, Hedge panel; then the package preview (legs editable). The strategy instance drawer for Cancel working legs, Retry, Unwind, Accept, Resize, Roll and Close',
    manualInputs: ['option expiration and put strike (no option chain is supplied for the fictional stock)', 'limit price of the put leg, changed in the preview', 'investment Strategy, holding period and objective for the hedge request', 'loan rate when the shortfall is borrowed'],
    automaticInputs: [...TEMPLATE_MATRIX.automaticInputs, 'contracts from the share quantity and the contract deliverable (100 shares)', 'underlying close for the expiration date (close fixture)'],
    settlement: 'Shares and premium T+1 on the US calendar; shares delivered on exercise settle T+1 at the strike',
    lifecycle: 'Put waits for the shares and is scaled to what filled; retry keeps that link; expiry in the money exercises the put against the shares held (simulated delivery); out of the money lapses; roll to a later expiry; resize; close by share, exact amount, in full',
    accounting: 'Shares at average cost; put premium as an option position; premium realized at exercise, lapse or sale; commissions expensed; an existing holding is linked, not bought again',
    collateral: 'None (bought puts reserve nothing)',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: [] }, // US: no holiday from 2 to 24 March 2026
  book: book('Matrix template protective put'),
  instruments: { main: STOCK, put48: option('P', 48), put50: option('P', 50), put48apr: option('P', 48, '2026-04-17') },
  quotes: {
    main: { bid: 49.95, ask: 50.05, last: 50.00, bidSize: 300, askSize: 300 },
    put48: { bid: 0.90, ask: 1.00, last: 0.95, bidSize: 3, askSize: 3 },
    put50: { bid: 1.80, ask: 1.90, last: 1.85, bidSize: 100, askSize: 100 },
    put48apr: { bid: 1.60, ask: 1.70, last: 1.65, bidSize: 100, askSize: 100 },
  },
  expectAtStart: startState(),
  steps: [
    {
      // The template's own puts are sent with the request as proposed protection; the fixture proposes nothing on top.
      id: 'hedge-request', covers: ['hedge request', 'template protection'], action: 'hedge_request',
      input: pp(1000, 48, CONTEXT), strategyPage: { ...PAGE_CONTEXT, ...ppPage(1000, 48) },
      expect: {
        result: {
          state: 'recommendation_ready', complete: true, source: { kind: 'demo-fixture', label: 'Demo fixture, not Shaffer Hedge' }, packages: [], recommendedId: null,
          note: 'Nothing further is proposed for price risk: the position is already protected (10 puts in the template). The demo fixture does not layer a second hedge on top.',
          investmentStrategy: { id: 'DEMO-IS-002', name: 'Core Equity', resolved: true }, holdingDays: 30, objective: 'downside_protection',
          primary: { instrument: 'main', direction: 'long', quantity: 1000, status: 'proposed' },
          proposedProtection: [{ action: 'buy', quantity: 10, right: 'P', strike: 48 }], linkedProtection: [], hedgesHeld: [],
        },
      },
    },
    {
      // 1,000 shares (askSize 300) and 10 puts (1,000 / 100 a contract; askSize 3). On confirmation 300 shares fill, so 3
      // puts may follow (10 x 300 / 1,000); in the next cycle 300 more shares, 3 more puts. 400 shares and 4 puts work.
      id: 'open-partial', covers: ['open', 'partial fill', 'dependent leg scaled'], action: 'package', as: 'core', instrument: 'main',
      input: pp(1000, 48), strategyPage: ppPage(1000, 48),
      expect: {
        preview: {
          blocking: 0, errors: [], template: 'protective_put',
          legs: [
            { kind: 'trade', action: 'buy', purpose: 'primary', instrument: 'main', qty: 1000, estimate: 50.05, settleDate: '2026-03-03', cash: -50_050, fees: 10, dependsOn: [] },
            { kind: 'trade', action: 'buy', purpose: 'hedge', instrument: 'put48', qty: 10, estimate: 1.00, settleDate: '2026-03-03', cash: -1_000, fees: 5, dependsOn: [1] }, // 10 x 1.00 x 100; 10 x 0.50
          ],
          cash: { USD: { purchases: 51_050, fees: 15, required: 51_065, available: 200_000, shortfall: 0 } },
          netPremium: { amount: 1_000, ccy: 'USD', type: 'debit' }, optionRequirement: [],
        },
        result: { status: 'partial', orders: [{ instrument: 'main', status: 'partial', qty: 1000, filledQty: 300, avgPrice: 50.05 }, { instrument: 'put48', status: 'partial', qty: 10, filledQty: 3, avgPrice: 1, reason: 'Waiting on leg 1' }] },
        events: [{ type: 'strategy.submitted', summary: 'Package submitted: Protective Put KSTL (2 legs; open)' }, { type: 'trade.fill', summary: 'Bought 300 KSTL @ 50.05 USD' }, { type: 'trade.fill', summary: 'Bought 3 KSTL260320P48 @ 1.00 USD' }, { type: 'trade.fill', summary: 'Bought 300 KSTL @ 50.05 USD' }, { type: 'trade.fill', summary: 'Bought 3 KSTL260320P48 @ 1.00 USD' }],
        // Owed: 2 x (300 x 50.05 + 3) = 30,036 for shares, 2 x (3 x 100 + 1.50) = 603 for puts.
        cash: { account: { USD: { settled: 200_000, unsettled: -30_639, payable: 30_639, availableToTrade: 169_361, availableToWithdraw: 169_361 } } },
        positions: [longPos('main', 'core', 600, 50.05, 30_030, 50, 30_000, -30), longPos('put48', 'core', 6, 1, 600, 0.95, 570, -30)], // 6 x 0.95 x 100
        holdings: { main: { long: 600, short: 0, net: 600 }, put48: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'main', amount: -15_018 }, { instrument: 'main', amount: -15_018 }, { instrument: 'put48', amount: -301.5 }, { instrument: 'put48', amount: -301.5 }].map((x) => ({ ...x, lot: 'core', owner: 'account', dueDate: '2026-03-03', ccy: 'USD', into: 'cash' })),
        openOrders: [{ instrument: 'main', status: 'partial', qty: 1000, filledQty: 600 }, { instrument: 'put48', status: 'partial', qty: 10, filledQty: 6 }],
        lifecycle: [expiryItem('put48')],
        pnl: { account: { realized: 0, commissions: -9, borrowFunding: 0, unrealized: -60, total: -69 }, book: { realized: 0, commissions: -9, unrealized: -60, total: -69 }, treasury: { total: 0 } },
        nav: { account: 199_931, treasury: 800_000, book: 999_931 },
        balance: {
          account: { cash: 200_000, positions: 30_570, payable: 30_639, assets: 230_570, liabilities: 30_639, netAssets: 199_931 },
          book: { cash: 1_000_000, positions: 30_570, payable: 30_639, assets: 1_030_570, liabilities: 30_639, netAssets: 999_931 },
          treasury: { cash: 800_000, assets: 800_000, netAssets: 800_000 },
        },
        oversight: { accountBorrowings: [], accounts: { account: { cashBorrowed: 0, fundingReceived: 200_000 } }, treasuryOwn: [] },
      },
    },
    {
      id: 'cancel-remainder', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'core',
      expect: {
        result: { status: 'attention', orders: [{ instrument: 'main', status: 'cancelled', filledQty: 600 }, { instrument: 'put48', status: 'cancelled', filledQty: 6 }] },
        events: [{ type: 'order.cancelled', summary: 'Leg 1 cancelled: buy 1,000 KSTL. Cancelled by user (600 of 1,000 had filled and remains in place)' }, { type: 'order.cancelled', summary: 'Leg 2 cancelled: buy 10 KSTL260320P48. Cancelled by user (6 of 10 had filled and remains in place)' }],
        openOrders: [], failed: { orders: 2 }, alerts: ['strategy.attention'],
      },
    },
    {
      // Retry both unfilled remainders; the puts still wait for the shares (300 + 3 now, 100 + 1 in the next cycle). The
      // primary exposure changed after its protection was on, so the strategy is flagged for a hedge review.
      id: 'retry', covers: ['retry'], action: 'recover', how: 'retry', lot: 'core',
      expect: {
        preview: { blocking: 0, intent: 'retry', legs: [{ instrument: 'main', qty: 400, cash: -20_020, fees: 4, dependsOn: [] }, { instrument: 'put48', qty: 4, cash: -400, fees: 2, dependsOn: [1] }], cash: { USD: { purchases: 20_420, fees: 6, required: 20_426, available: 169_361 } } },
        result: { status: 'partial', orders: [{ instrument: 'main', status: 'partial', qty: 400, filledQty: 300 }, { instrument: 'put48', status: 'partial', qty: 4, filledQty: 3 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Put KSTL (2 legs; retry)' }, { type: 'trade.fill', summary: 'Bought 300 KSTL @ 50.05 USD' }, { type: 'trade.fill', summary: 'Bought 3 KSTL260320P48 @ 1.00 USD' }, { type: 'trade.fill', summary: 'Bought 100 KSTL @ 50.05 USD' }, { type: 'trade.fill', summary: 'Bought 1 KSTL260320P48 @ 1.00 USD' }],
        cash: { account: { USD: { unsettled: -51_065, payable: 51_065, availableToTrade: 148_935, availableToWithdraw: 148_935 } } },
        positions: [longPos('main', 'core', 1000, 50.05, 50_050, 50, 50_000, -50), longPos('put48', 'core', 10, 1, 1_000, 0.95, 950, -50)],
        holdings: { main: { long: 1000, short: 0, net: 1000 }, put48: { long: 10, short: 0, net: 10 } },
        pending: [...[-15_018, -15_018, -15_018, -5_006].map((amount) => ({ instrument: 'main', lot: 'core', amount })), ...[-301.5, -301.5, -301.5, -100.5].map((amount) => ({ instrument: 'put48', lot: 'core', amount }))],
        pnl: { account: { commissions: -15, unrealized: -100, total: -115 }, book: { commissions: -15, unrealized: -100, total: -115 } },
        nav: { account: 199_885, book: 999_885 },
        balance: { account: { positions: 50_950, payable: 51_065, assets: 250_950, liabilities: 51_065, netAssets: 199_885 }, book: { positions: 50_950, payable: 51_065, assets: 1_050_950, liabilities: 51_065, netAssets: 999_885 } },
        alerts: ['hedge.review'],
      },
    },
    {
      // 200 shares and 2 puts at 50; the put leg is set to a limit of 1.50 in the preview, below the 1.90 ask.
      id: 'limit-never-reached', covers: ['failed dependent leg'], action: 'package', as: 'limited', instrument: 'main',
      input: pp(200, 50), strategyPage: ppPage(200, 50), editLegs: { 2: { orderType: 'limit', limitPrice: 1.5 } },
      expect: {
        preview: { blocking: 0, warnings: ['already-held'], legs: [{ instrument: 'main', qty: 200, cash: -10_010, fees: 2 }, { instrument: 'put50', qty: 2, orderType: 'limit', estimate: 1.9, cash: -380, fees: 1, dependsOn: [1] }], cash: { USD: { purchases: 10_390, fees: 3, required: 10_393, available: 148_935 } } },
        result: { status: 'partial', orders: [{ instrument: 'main', status: 'filled', filledQty: 200 }, { instrument: 'put50', status: 'working', filledQty: 0, reason: 'Limit not reached: executable price 1.9 is above the limit 1.5.' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 200 KSTL @ 50.05 USD' }],
        cash: { account: { USD: { unsettled: -61_077, payable: 61_077, availableToTrade: 138_923, availableToWithdraw: 138_923 } } },
        positions: [longPos('main', 'core', 1000, 50.05, 50_050, 50, 50_000, -50), longPos('main', 'limited', 200, 50.05, 10_010, 50, 10_000, -10), longPos('put48', 'core', 10, 1, 1_000, 0.95, 950, -50)],
        holdings: { main: { long: 1200, short: 0, net: 1200 }, put48: { long: 10, short: 0, net: 10 } },
        pending: [...[-15_018, -15_018, -15_018].map((amount) => ({ lot: 'core', amount })), { lot: 'limited', amount: -10_012 }, { lot: 'core', amount: -5_006 }, ...[-301.5, -301.5, -301.5, -100.5].map((amount) => ({ lot: 'core', amount }))],
        openOrders: [{ instrument: 'put50', status: 'working', qty: 2, filledQty: 0 }],
        pnl: { account: { commissions: -17, unrealized: -110, total: -127 }, book: { commissions: -17, unrealized: -110, total: -127 } },
        nav: { account: 199_873, book: 999_873 },
        balance: { account: { positions: 60_950, payable: 61_077, assets: 260_950, liabilities: 61_077, netAssets: 199_873 }, book: { positions: 60_950, payable: 61_077, assets: 1_060_950, liabilities: 61_077, netAssets: 999_873 } },
      },
    },
    { id: 'cancel-limited', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'limited', expect: { result: { status: 'attention', orders: [{ status: 'filled' }, { status: 'cancelled', filledQty: 0 }] }, events: [{ type: 'order.cancelled', summary: 'Leg 2 cancelled: buy 2 KSTL260320P50. Cancelled by user' }], openOrders: [], failed: { orders: 3 }, alerts: ['hedge.review', 'strategy.attention'] } },
    {
      // Unwind sells the 200 unprotected shares at the bid: 200 x (49.95 - 50.05) = -20 realized.
      id: 'unwind', covers: ['unwind'], action: 'recover', how: 'unwind', lot: 'limited',
      expect: {
        preview: { blocking: 0, intent: 'unwind', legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 200, estimate: 49.95, cash: 9_990, fees: 2 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 200, avgPrice: 49.95 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Put KSTL (1 leg; unwind)' }, { type: 'trade.fill', summary: 'Sold 200 KSTL @ 49.95 USD (realized -20.00 USD)' }],
        cash: { account: { USD: { unsettled: -51_089, receivable: 9_988, payable: 61_077, availableToTrade: 148_911, availableToWithdraw: 138_923 } } },
        positions: [longPos('main', 'core', 1000, 50.05, 50_050, 50, 50_000, -50), longPos('put48', 'core', 10, 1, 1_000, 0.95, 950, -50)],
        holdings: { main: { long: 1000, short: 0, net: 1000 }, put48: { long: 10, short: 0, net: 10 } },
        pending: [...[-15_018, -15_018, -15_018].map((amount) => ({ lot: 'core', amount })), { lot: 'limited', amount: -10_012 }, { lot: 'core', amount: -5_006 }, { lot: 'limited', amount: 9_988 }, ...[-301.5, -301.5, -301.5, -100.5].map((amount) => ({ lot: 'core', amount }))],
        pnl: { account: { realized: -20, commissions: -19, unrealized: -100, total: -139 }, book: { realized: -20, commissions: -19, unrealized: -100, total: -139 } },
        nav: { account: 199_861, book: 999_861 },
        balance: { account: { receivable: 9_988, positions: 50_950, assets: 260_938, netAssets: 199_861 }, book: { receivable: 9_988, positions: 50_950, assets: 1_060_938, netAssets: 999_861 } },
        alerts: ['hedge.review'],
      },
    },
    {
      id: 'kept-limit', covers: ['failed dependent leg'], action: 'package', as: 'kept', instrument: 'main',
      input: pp(100, 50), strategyPage: ppPage(100, 50), editLegs: { 2: { orderType: 'limit', limitPrice: 1.5 } },
      expect: {
        preview: { blocking: 0, legs: [{ instrument: 'main', qty: 100, cash: -5_005, fees: 1 }, { instrument: 'put50', qty: 1, orderType: 'limit', cash: -190, fees: 0.5, dependsOn: [1] }], cash: { USD: { required: 5_196.5, available: 148_911 } } },
        result: { status: 'partial', orders: [{ instrument: 'main', status: 'filled', filledQty: 100 }, { instrument: 'put50', status: 'working', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 100 KSTL @ 50.05 USD' }],
        cash: { account: { USD: { unsettled: -56_095, payable: 66_083, availableToTrade: 143_905, availableToWithdraw: 133_917 } } },
        positions: [longPos('main', 'core', 1000, 50.05, 50_050, 50, 50_000, -50), longPos('main', 'kept', 100, 50.05, 5_005, 50, 5_000, -5), longPos('put48', 'core', 10, 1, 1_000, 0.95, 950, -50)],
        holdings: { main: { long: 1100, short: 0, net: 1100 }, put48: { long: 10, short: 0, net: 10 } },
        pending: [...[-15_018, -15_018, -15_018].map((amount) => ({ lot: 'core', amount })), { lot: 'limited', amount: -10_012 }, { lot: 'core', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'limited', amount: 9_988 }, ...[-301.5, -301.5, -301.5, -100.5].map((amount) => ({ lot: 'core', amount }))],
        openOrders: [{ instrument: 'put50', status: 'working', qty: 1, filledQty: 0 }],
        pnl: { account: { commissions: -20, unrealized: -105, total: -145 }, book: { commissions: -20, unrealized: -105, total: -145 } },
        nav: { account: 199_855, book: 999_855 },
        balance: { account: { positions: 55_950, payable: 66_083, assets: 265_938, liabilities: 66_083, netAssets: 199_855 }, book: { positions: 55_950, payable: 66_083, assets: 1_065_938, liabilities: 66_083, netAssets: 999_855 } },
      },
    },
    { id: 'cancel-kept', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'kept', expect: { result: { status: 'attention' }, events: [{ type: 'order.cancelled', summary: 'Leg 2 cancelled: buy 1 KSTL260320P50. Cancelled by user' }], openOrders: [], failed: { orders: 4 }, alerts: ['hedge.review', 'strategy.attention'] } },
    { id: 'accept-kept', covers: ['accept as it stands'], action: 'strategy_action', how: 'accept', lot: 'kept', expect: { result: { status: 'open' }, events: [{ type: 'strategy.accepted', summary: 'Protective Put KSTL: accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: ['hedge.review'] } },
    {
      // Protect the 100 shares already held: nothing is bought but the put (1 x 1.90 x 100). The holding is linked to the
      // new strategy instance and moves into it with its cost.
      id: 'existing-holding', covers: ['existing holding', 'open'], action: 'package', as: 'wrapped', instrument: 'main',
      input: { template: 'protective_put', underlyingId: '$inst:main', origin: 'strategy_page', ...NO_CONTEXT, mode: 'existing', existingPositionId: '$pos:kept:main', quantity: 100, hedgeRatio: 1, options: { expiration: '2026-03-20', strikes: { put: 50 }, contracts: null }, borrow: null, orderType: 'market', limitPrice: null, stopPrice: null, tif: 'day', financing: null },
      strategyPage: { template: 'Protective Put / Long + Put Cover', underlying: 'main', mode: 'existing', existing: { lot: 'kept', instrument: 'main' }, expiration: '2026-03-20', strikes: { 'Put strike': 50 } },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'link', action: 'use_existing', purpose: 'primary', instrument: 'main', qty: 100 }, { kind: 'trade', action: 'buy', purpose: 'hedge', instrument: 'put50', qty: 1, estimate: 1.9, cash: -190, fees: 0.5, dependsOn: [1] }], cash: { USD: { purchases: 190, fees: 0.5, required: 190.5, available: 143_905 } } },
        result: { status: 'open', orders: [{ kind: 'link', status: 'filled', filledQty: 100 }, { instrument: 'put50', status: 'filled', filledQty: 1, avgPrice: 1.9 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'position.linked', summary: 'Linked existing long position of 100 KSTL to this strategy (no trade)' }, { type: 'trade.fill', summary: 'Bought 1 KSTL260320P50 @ 1.90 USD' }],
        cash: { account: { USD: { unsettled: -56_285.5, payable: 66_273.5, availableToTrade: 143_714.5, availableToWithdraw: 133_726.5 } } },
        positions: [longPos('main', 'core', 1000, 50.05, 50_050, 50, 50_000, -50), longPos('main', 'wrapped', 100, 50.05, 5_005, 50, 5_000, -5), longPos('put48', 'core', 10, 1, 1_000, 0.95, 950, -50), longPos('put50', 'wrapped', 1, 1.9, 190, 1.85, 185, -5)],
        holdings: { main: { long: 1100, short: 0, net: 1100 }, put48: { long: 10, short: 0, net: 10 }, put50: { long: 1, short: 0, net: 1 } },
        pending: [...[-15_018, -15_018, -15_018].map((amount) => ({ lot: 'core', amount })), { lot: 'limited', amount: -10_012 }, { lot: 'core', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'limited', amount: 9_988 }, ...[-301.5, -301.5, -301.5, -100.5].map((amount) => ({ lot: 'core', amount })), { instrument: 'put50', lot: 'wrapped', amount: -190.5 }],
        lifecycle: [expiryItem('put48'), expiryItem('put50')],
        pnl: { account: { commissions: -20.5, unrealized: -110, total: -150.5 }, book: { commissions: -20.5, unrealized: -110, total: -150.5 } },
        nav: { account: 199_849.5, book: 999_849.5 },
        balance: { account: { positions: 56_135, payable: 66_273.5, assets: 266_123, liabilities: 66_273.5, netAssets: 199_849.5 }, book: { positions: 56_135, payable: 66_273.5, assets: 1_066_123, liabilities: 66_273.5, netAssets: 999_849.5 } },
      },
    },
    { id: 'kept-after-link', covers: ['existing holding'], action: 'strategy_check', lot: 'kept', expect: { result: { status: 'closed', orders: [{ instrument: 'main', status: 'filled', filledQty: 100 }, { instrument: 'put50', status: 'cancelled', filledQty: 0 }] } } }, // its shares now belong to 'wrapped'
    { id: 'deep-book', action: 'quote', instrument: 'main', quote: { bid: 49.95, ask: 50.05, last: 50.00, bidSize: 10000, askSize: 10000 }, expect: {} },
    { id: 'deep-book-put', action: 'quote', instrument: 'put48', quote: { bid: 0.90, ask: 1.00, last: 0.95, bidSize: 100, askSize: 100 }, expect: {} },
    {
      // 1,000 x 1.2 = 1,200: 200 shares and 2 puts more.
      id: 'resize-up', covers: ['resize', 'increase'], action: 'resize', lot: 'core', factor: 1.2,
      expect: {
        preview: { blocking: 0, intent: 'resize', legs: [{ instrument: 'main', qty: 200, cash: -10_010, fees: 2 }, { instrument: 'put48', qty: 2, cash: -200, fees: 1 }], cash: { USD: { purchases: 10_210, fees: 3, required: 10_213, available: 143_714.5 } } },
        result: { status: 'open', orders: [{ instrument: 'main', status: 'filled', filledQty: 200 }, { instrument: 'put48', status: 'filled', filledQty: 2 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Put KSTL (2 legs; resize)' }, { type: 'trade.fill', summary: 'Bought 200 KSTL @ 50.05 USD' }, { type: 'trade.fill', summary: 'Bought 2 KSTL260320P48 @ 1.00 USD' }],
        cash: { account: { USD: { unsettled: -66_498.5, payable: 76_486.5, availableToTrade: 133_501.5, availableToWithdraw: 123_513.5 } } },
        positions: [longPos('main', 'core', 1200, 50.05, 60_060, 50, 60_000, -60), longPos('main', 'wrapped', 100, 50.05, 5_005, 50, 5_000, -5), longPos('put48', 'core', 12, 1, 1_200, 0.95, 1_140, -60), longPos('put50', 'wrapped', 1, 1.9, 190, 1.85, 185, -5)],
        holdings: { main: { long: 1300, short: 0, net: 1300 }, put48: { long: 12, short: 0, net: 12 }, put50: { long: 1, short: 0, net: 1 } },
        pending: [...[-15_018, -15_018, -15_018, -10_012].map((amount) => ({ lot: 'core', amount })), { lot: 'limited', amount: -10_012 }, { lot: 'core', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'limited', amount: 9_988 }, ...[-301.5, -301.5, -301.5, -201, -100.5].map((amount) => ({ lot: 'core', amount })), { lot: 'wrapped', amount: -190.5 }],
        pnl: { account: { commissions: -23.5, unrealized: -130, total: -173.5 }, book: { commissions: -23.5, unrealized: -130, total: -173.5 } },
        nav: { account: 199_826.5, book: 999_826.5 },
        balance: { account: { positions: 66_325, payable: 76_486.5, assets: 276_313, liabilities: 76_486.5, netAssets: 199_826.5 }, book: { positions: 66_325, payable: 76_486.5, assets: 1_076_313, liabilities: 76_486.5, netAssets: 999_826.5 } },
      },
    },
    {
      // The Account returns 120,000 to Treasury, so the next packages meet a cash shortfall.
      id: 'sweep-to-treasury', covers: ['transfer'], action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 120_000,
      expect: {
        events: [{ type: 'transfer.return', summary: 'Return to Treasury: 120,000.00 USD from Alpha to Treasury' }],
        cash: { account: { USD: { settled: 80_000, availableToTrade: 13_501.5, availableToWithdraw: 3_513.5 } }, treasury: { USD: { settled: 920_000, availableToTrade: 920_000 } } },
        nav: { account: 79_826.5, treasury: 920_000 },
        balance: { account: { cash: 80_000, assets: 156_313, netAssets: 79_826.5 }, treasury: { cash: 920_000, assets: 920_000, netAssets: 920_000 } },
        oversight: { accounts: { account: { fundingReceived: 80_000 } } },
      },
    },
    {
      // 400 x 50.05 + 4 x 1.00 x 100 = 20,420 + 6 fees = 20,426 against 13,501.50 available: short 6,924.50.
      id: 'cash-short-not-financed', covers: ['financing: not financed'], action: 'package', instrument: 'main', input: pp(400, 48), strategyPage: ppPage(400, 48),
      status: 'blocked', reason: 'The package needs 20,426.00 and 13,501.50 is available; "Do not finance" leaves it blocked.', expect: { refused: 'Alpha is short 6,924.50 USD' },
    },
    {
      id: 'funded-from-treasury', covers: ['financing: Treasury funding'], action: 'package', as: 'funded', instrument: 'main',
      input: pp(400, 48, { financing: { mode: 'treasury' } }), strategyPage: ppPage(400, 48, { financing: { mode: 'treasury' } }),
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'funding', qty: 6_924.5, cash: 6_924.5 }, { instrument: 'main', qty: 400, cash: -20_020, fees: 4, dependsOn: [1] }, { instrument: 'put48', qty: 4, cash: -400, fees: 2, dependsOn: [2, 1] }], cash: { USD: { purchases: 20_420, fees: 6, financingIn: 6_924.5, required: 20_426, available: 13_501.5, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'funding', status: 'filled', filledQty: 6_924.5 }, { instrument: 'main', status: 'filled', filledQty: 400 }, { instrument: 'put48', status: 'filled', filledQty: 4 }] },
        events: [{ type: 'strategy.submitted', summary: 'Package submitted: Protective Put KSTL (3 legs; open)' }, { type: 'transfer.funding', summary: 'Treasury funding: 6,924.50 USD from Treasury to Alpha (Funding for Protective Put KSTL)', owner: 'treasury' }, { type: 'trade.fill', summary: 'Bought 400 KSTL @ 50.05 USD' }, { type: 'trade.fill', summary: 'Bought 4 KSTL260320P48 @ 1.00 USD' }],
        cash: { account: { USD: { settled: 86_924.5, unsettled: -86_924.5, payable: 96_912.5, availableToTrade: 0, availableToWithdraw: -9_988 } }, treasury: { USD: { settled: 913_075.5, availableToTrade: 913_075.5 } } },
        positions: [longPos('main', 'core', 1200, 50.05, 60_060, 50, 60_000, -60), longPos('main', 'funded', 400, 50.05, 20_020, 50, 20_000, -20), longPos('main', 'wrapped', 100, 50.05, 5_005, 50, 5_000, -5), longPos('put48', 'core', 12, 1, 1_200, 0.95, 1_140, -60), longPos('put48', 'funded', 4, 1, 400, 0.95, 380, -20), longPos('put50', 'wrapped', 1, 1.9, 190, 1.85, 185, -5)],
        holdings: { main: { long: 1700, short: 0, net: 1700 }, put48: { long: 16, short: 0, net: 16 }, put50: { long: 1, short: 0, net: 1 } },
        pending: [{ lot: 'funded', amount: -20_024 }, ...[-15_018, -15_018, -15_018, -10_012].map((amount) => ({ lot: 'core', amount })), { lot: 'limited', amount: -10_012 }, { lot: 'core', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'limited', amount: 9_988 }, { lot: 'funded', amount: -402 }, ...[-301.5, -301.5, -301.5, -201, -100.5].map((amount) => ({ lot: 'core', amount })), { lot: 'wrapped', amount: -190.5 }],
        lifecycle: [expiryItem('put48'), expiryItem('put48'), expiryItem('put50')],
        pnl: { account: { commissions: -29.5, unrealized: -170, total: -219.5 }, book: { commissions: -29.5, unrealized: -170, total: -219.5 }, treasury: { total: 0 } },
        nav: { account: 86_705, treasury: 913_075.5, book: 999_780.5 },
        balance: { account: { cash: 86_924.5, positions: 86_705, payable: 96_912.5, assets: 183_617.5, liabilities: 96_912.5, netAssets: 86_705 }, book: { cash: 1_000_000, positions: 86_705, payable: 96_912.5, assets: 1_096_693, liabilities: 96_912.5, netAssets: 999_780.5 }, treasury: { cash: 913_075.5, assets: 913_075.5, netAssets: 913_075.5 } },
        oversight: { accounts: { account: { fundingReceived: 86_924.5 } } },
      },
    },
    {
      // 100 shares and 1 put: 5,005 + 100 + 1.50 = 5,106.50, nothing free: a margin loan of 5,106.50 at 6%.
      id: 'funded-by-loan', covers: ['financing: borrow'], action: 'package', as: 'levered', instrument: 'main', contractAs: 'loan',
      input: pp(100, 48, { financing: { mode: 'loan', rateType: 'fixed', rate: 0.06 } }), strategyPage: ppPage(100, 48, { financing: { mode: 'loan', rate: 0.06 } }),
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'loan', qty: 5_106.5, cash: 5_106.5, dailyCost: 0.85, financing: { rate: 0.06, interestFrom: '2026-03-02' } }, { instrument: 'main', qty: 100, dependsOn: [1] }, { instrument: 'put48', qty: 1, dependsOn: [2, 1] }], cash: { USD: { purchases: 5_105, fees: 1.5, financingIn: 5_106.5, required: 5_106.5, available: 0, shortfall: 0, netCash: 0 } } },
        result: { status: 'open', orders: [{ kind: 'loan', instrument: 'loan', status: 'filled', filledQty: 5_106.5 }, { instrument: 'main', status: 'filled', filledQty: 100 }, { instrument: 'put48', status: 'filled', filledQty: 1 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'loan.drawdown', summary: 'Borrowed 5,106.50 USD (margin, 6.000% fixed, open-ended)', cash: { USD: 5_106.5 } }, { type: 'trade.fill', summary: 'Bought 100 KSTL @ 50.05 USD' }, { type: 'trade.fill', summary: 'Bought 1 KSTL260320P48 @ 1.00 USD' }],
        cash: { account: { USD: { settled: 92_031, unsettled: -92_031, payable: 102_019, availableToTrade: 0, availableToWithdraw: -9_988, borrowed: 5_106.5 } } },
        positions: [{ instrument: 'loan', lot: 'levered', owner: 'account', direction: 'borrowed', qty: -5_106.5, carrying: -5_106.5 }, longPos('main', 'core', 1200, 50.05, 60_060, 50, 60_000, -60), longPos('main', 'funded', 400, 50.05, 20_020, 50, 20_000, -20), longPos('main', 'levered', 100, 50.05, 5_005, 50, 5_000, -5), longPos('main', 'wrapped', 100, 50.05, 5_005, 50, 5_000, -5),
          longPos('put48', 'core', 12, 1, 1_200, 0.95, 1_140, -60), longPos('put48', 'funded', 4, 1, 400, 0.95, 380, -20), longPos('put48', 'levered', 1, 1, 100, 0.95, 95, -5), longPos('put50', 'wrapped', 1, 1.9, 190, 1.85, 185, -5)],
        holdings: { main: { long: 1800, short: 0, net: 1800 }, put48: { long: 17, short: 0, net: 17 }, put50: { long: 1, short: 0, net: 1 } },
        pending: [{ lot: 'funded', amount: -20_024 }, ...[-15_018, -15_018, -15_018, -10_012].map((amount) => ({ lot: 'core', amount })), { lot: 'limited', amount: -10_012 }, { lot: 'core', amount: -5_006 }, { lot: 'kept', amount: -5_006 }, { lot: 'levered', amount: -5_006 }, { lot: 'limited', amount: 9_988 }, { lot: 'funded', amount: -402 }, ...[-301.5, -301.5, -301.5, -201, -100.5].map((amount) => ({ lot: 'core', amount })), { lot: 'levered', amount: -100.5 }, { lot: 'wrapped', amount: -190.5 }],
        lifecycle: [expiryItem('put48'), expiryItem('put48'), expiryItem('put48'), expiryItem('put50'), { type: 'loan.interest', instrument: 'loan', dueDate: '2026-04-01', status: 'pending' }],
        borrowings: [{ owner: 'account', family: 'loan', lot: 'levered', principal: 5_106.5, rate: 0.06, accrued: 0 }],
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'levered', principal: 5_106.5, ccy: 'USD', accrued: 0 }], accounts: { account: { cashBorrowed: 5_106.5 } } },
        pnl: { account: { commissions: -31, unrealized: -180, total: -231 }, book: { commissions: -31, unrealized: -180, total: -231 } },
        nav: { account: 86_693.5, book: 999_769 },
        balance: { account: { cash: 92_031, positions: 91_800, payable: 102_019, borrowed: 5_106.5, assets: 193_819, liabilities: 107_125.5, netAssets: 86_693.5 }, book: { cash: 1_005_106.5, positions: 91_800, payable: 102_019, borrowed: 5_106.5, assets: 1_106_894.5, liabilities: 107_125.5, netAssets: 999_769 } },
      },
    },
    {
      id: 'next-day', covers: ['settlement'], action: 'clock', to: MAR(3),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 9,988.00 USD' },
          ...[15_018, 301.5, 15_018, 301.5, 15_018, 301.5, 5_006, 100.5, 10_012, 5_006, 190.5, 10_012, 201, 20_024, 402, 5_006, 100.5].map((x) => ({ type: 'settlement.pay', cash: { USD: -x } })),
        ],
        cash: { account: { USD: { settled: 0, unsettled: 0, receivable: 0, payable: 0, availableToTrade: 0, availableToWithdraw: 0 } } }, // 92,031 + 9,988 - 102,019
        pending: [],
        balance: { account: { cash: null, receivable: null, payable: null, assets: 91_800, liabilities: 5_106.5 }, book: { cash: 913_075.5, receivable: null, payable: null, assets: 1_004_875.5, liabilities: 5_106.5 } },
      },
    },
    {
      id: 'treasury-top-up', covers: ['transfer'], action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 50_000,
      expect: { events: [{ type: 'transfer.funding', summary: 'Treasury funding: 50,000.00 USD from Treasury to Alpha' }], cash: { account: { USD: { settled: 50_000, availableToTrade: 50_000, availableToWithdraw: 50_000 } }, treasury: { USD: { settled: 863_075.5, availableToTrade: 863_075.5 } } }, nav: { account: 136_693.5, treasury: 863_075.5 }, balance: { account: { cash: 50_000, assets: 141_800, netAssets: 136_693.5 }, treasury: { cash: 863_075.5, assets: 863_075.5, netAssets: 863_075.5 } }, oversight: { accounts: { account: { fundingReceived: 136_924.5 } } } },
    },
    {
      // Close 'levered': sell its 100 shares (-10 realized) and its put (1 x (0.90 - 1.00) x 100 = -10), and repay the loan
      // with one day's interest (5,106.50 x 0.06 / 360 = 0.851 -> 0.85) from the settled cash Treasury provided.
      id: 'close-levered', covers: ['close', 'repay'], action: 'close', lot: 'levered', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', instrument: 'main', qty: 100, cash: 4_995, fees: 1 }, { action: 'sell', instrument: 'put48', qty: 1, cash: 90, fees: 0.5 }, { kind: 'repay', instrument: 'loan', qty: 5_106.5, cash: -5_107.35, financing: { principal: 5_106.5, interest: 0.85, full: true, interestThrough: '2026-03-03' } }], cash: { USD: { proceeds: 5_085, fees: 1.5, financingOut: 5_107.35, required: 5_108.85, available: 50_000, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ instrument: 'main', status: 'filled', filledQty: 100 }, { instrument: 'put48', status: 'filled', filledQty: 1 }, { kind: 'repay', status: 'filled' }] },
        events: [
          { type: 'strategy.legs_added', summary: 'Legs added to Protective Put KSTL (3 legs; close)' }, { type: 'trade.fill', summary: 'Sold 100 KSTL @ 49.95 USD (realized -10.00 USD)' }, { type: 'trade.fill', summary: 'Sold 1 KSTL260320P48 @ 0.90 USD (realized -10.00 USD)' },
          { type: 'accrual.interest', summary: ': 0.85 USD' }, { type: 'loan.repayment', summary: 'Repaid 5,106.50 USD of principal', cash: { USD: -5_106.5 } }, { type: 'interest.payment', summary: ': 0.85 USD', cash: { USD: -0.85 } },
        ],
        cash: { account: { USD: { settled: 44_892.65, unsettled: 5_083.5, receivable: 5_083.5, availableToTrade: 49_976.15, availableToWithdraw: 44_892.65, borrowed: 0 } } },
        positions: [longPos('main', 'core', 1200, 50.05, 60_060, 50, 60_000, -60), longPos('main', 'funded', 400, 50.05, 20_020, 50, 20_000, -20), longPos('main', 'wrapped', 100, 50.05, 5_005, 50, 5_000, -5), longPos('put48', 'core', 12, 1, 1_200, 0.95, 1_140, -60), longPos('put48', 'funded', 4, 1, 400, 0.95, 380, -20), longPos('put50', 'wrapped', 1, 1.9, 190, 1.85, 185, -5)],
        holdings: { main: { long: 1700, short: 0, net: 1700 }, put48: { long: 16, short: 0, net: 16 }, put50: { long: 1, short: 0, net: 1 } },
        pending: [{ lot: 'levered', dueDate: '2026-03-04', amount: 4_994 }, { lot: 'levered', dueDate: '2026-03-04', amount: 89.5 }],
        lifecycle: [expiryItem('put48'), expiryItem('put48'), expiryItem('put50')],
        borrowings: [], oversight: { accountBorrowings: [], accounts: { account: { cashBorrowed: 0 } } },
        pnl: { account: { realized: -40, borrowFunding: -0.85, commissions: -32.5, unrealized: -170, total: -243.35 }, book: { realized: -40, borrowFunding: -0.85, commissions: -32.5, unrealized: -170, total: -243.35 } },
        nav: { account: 136_681.15, book: 999_756.65 },
        balance: { account: { cash: 44_892.65, receivable: 5_083.5, positions: 86_705, borrowed: null, assets: 136_681.15, liabilities: 0, netAssets: 136_681.15 }, book: { cash: 907_968.15, receivable: 5_083.5, positions: 86_705, borrowed: null, assets: 999_756.65, liabilities: 0, netAssets: 999_756.65 } },
      },
    },
    {
      // Roll the 12 March puts of 'core' to April: sell at 0.90 (realized 12 x (0.90 - 1.00) x 100 = -120), buy at 1.70.
      id: 'roll', covers: ['roll'], action: 'roll', lot: 'core', newExpiration: '2026-04-17',
      expect: {
        preview: { blocking: 0, intent: 'roll', legs: [{ action: 'sell', instrument: 'put48', qty: 12, estimate: 0.9, cash: 1_080, fees: 6 }, { action: 'buy', instrument: 'put48apr', qty: 12, estimate: 1.7, cash: -2_040, fees: 6 }], cash: { USD: { purchases: 2_040, proceeds: 1_080, fees: 12, required: 2_052, available: 49_976.15 } }, netPremium: { amount: 960, type: 'debit' } },
        result: { status: 'open', orders: [{ action: 'sell', instrument: 'put48', status: 'filled', filledQty: 12 }, { action: 'buy', instrument: 'put48apr', status: 'filled', filledQty: 12 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Put KSTL (2 legs; roll)' }, { type: 'trade.fill', summary: 'Sold 12 KSTL260320P48 @ 0.90 USD (realized -120.00 USD)' }, { type: 'trade.fill', summary: 'Bought 12 KSTL260417P48 @ 1.70 USD' }],
        cash: { account: { USD: { unsettled: 4_111.5, receivable: 6_157.5, payable: 2_046, availableToTrade: 49_004.15, availableToWithdraw: 42_846.65 } } },
        positions: [longPos('main', 'core', 1200, 50.05, 60_060, 50, 60_000, -60), longPos('main', 'funded', 400, 50.05, 20_020, 50, 20_000, -20), longPos('main', 'wrapped', 100, 50.05, 5_005, 50, 5_000, -5), longPos('put48', 'funded', 4, 1, 400, 0.95, 380, -20), longPos('put48apr', 'core', 12, 1.7, 2_040, 1.65, 1_980, -60), longPos('put50', 'wrapped', 1, 1.9, 190, 1.85, 185, -5)],
        holdings: { main: { long: 1700, short: 0, net: 1700 }, put48: { long: 4, short: 0, net: 4 }, put48apr: { long: 12, short: 0, net: 12 }, put50: { long: 1, short: 0, net: 1 } },
        pending: [{ lot: 'levered', amount: 4_994 }, { lot: 'levered', amount: 89.5 }, { lot: 'core', amount: 1_074 }, { lot: 'core', amount: -2_046 }],
        lifecycle: [expiryItem('put48'), expiryItem('put50'), expiryItem('put48apr', '2026-04-17')],
        pnl: { account: { realized: -160, commissions: -44.5, unrealized: -170, total: -375.35 }, book: { realized: -160, commissions: -44.5, unrealized: -170, total: -375.35 } },
        nav: { account: 136_549.15, book: 999_624.65 },
        balance: { account: { receivable: 6_157.5, positions: 87_545, payable: 2_046, assets: 138_595.15, liabilities: 2_046, netAssets: 136_549.15 }, book: { receivable: 6_157.5, positions: 87_545, payable: 2_046, assets: 1_001_670.65, liabilities: 2_046, netAssets: 999_624.65 } },
      },
    },
    {
      id: 'settle-roll', covers: ['settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 4,994.00 USD' }, { type: 'settlement.receive', summary: 'received 89.50 USD' }, { type: 'settlement.receive', summary: 'received 1,074.00 USD' }, { type: 'settlement.pay', summary: 'paid 2,046.00 USD' }],
        cash: { account: { USD: { settled: 49_004.15, unsettled: 0, receivable: 0, payable: 0, availableToTrade: 49_004.15, availableToWithdraw: 49_004.15 } } },
        pending: [],
        balance: { account: { cash: 49_004.15, receivable: null, payable: null, assets: 136_549.15, liabilities: 0 }, book: { cash: 912_079.65, receivable: null, payable: null, assets: 999_624.65, liabilities: 0 } },
      },
    },
    { id: 'expiry-close', action: 'close_price', instrument: 'main', date: '2026-03-20', value: 49, expect: {} },
    {
      id: 'expiry-quote', action: 'quote', instrument: 'main', quote: { bid: 48.95, ask: 49.05, last: 49.00, bidSize: 10000, askSize: 10000 },
      expect: {
        positions: [longPos('main', 'core', 1200, 50.05, 60_060, 49, 58_800, -1_260), longPos('main', 'funded', 400, 50.05, 20_020, 49, 19_600, -420), longPos('main', 'wrapped', 100, 50.05, 5_005, 49, 4_900, -105), longPos('put48', 'funded', 4, 1, 400, 0.95, 380, -20), longPos('put48apr', 'core', 12, 1.7, 2_040, 1.65, 1_980, -60), longPos('put50', 'wrapped', 1, 1.9, 190, 1.85, 185, -5)],
        pnl: { account: { unrealized: -1_870, total: -2_075.35 }, book: { unrealized: -1_870, total: -2_075.35 } },
        nav: { account: 134_849.15, book: 997_924.65 },
        balance: { account: { positions: 85_845, assets: 134_849.15, netAssets: 134_849.15 }, book: { positions: 85_845, assets: 997_924.65, netAssets: 997_924.65 } },
      },
    },
    {
      // Expiration, close 49.00: the 50 put of 'wrapped' is in the money and is exercised: its 100 shares are delivered at
      // 50 (5,000 due Monday); realized on the shares 100 x (50 - 50.05) = -5 and on the put -190 (its premium). The 4
      // March 48 puts of 'funded' lapse: -400. The April puts of 'core' are untouched.
      id: 'expiry', covers: ['expiry', 'exercise', 'lapse'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 1 KSTL260320P50 at strike 50', date: '2026-03-20' },
          { type: 'option.delivery', summary: 'Simulated delivery: delivered 100 KSTL at strike 50 on exercise of KSTL260320P50' },
          { type: 'option.expired', summary: 'Expired worthless: 4 KSTL260320P48 (fixing 49)' },
        ],
        cash: { account: { USD: { unsettled: 5_000, receivable: 5_000, availableToTrade: 54_004.15, availableToWithdraw: 49_004.15 } } },
        positions: [longPos('main', 'core', 1200, 50.05, 60_060, 49, 58_800, -1_260), longPos('main', 'funded', 400, 50.05, 20_020, 49, 19_600, -420), longPos('put48apr', 'core', 12, 1.7, 2_040, 1.65, 1_980, -60)],
        holdings: { main: { long: 1600, short: 0, net: 1600 }, put48: null, put48apr: { long: 12, short: 0, net: 12 }, put50: null },
        pending: [{ lot: 'wrapped', dueDate: '2026-03-23', amount: 5_000, into: 'cash' }],
        lifecycle: [expiryItem('put48apr', '2026-04-17')],
        pnl: { account: { realized: -755, unrealized: -1_740, total: -2_540.35 }, book: { realized: -755, unrealized: -1_740, total: -2_540.35 } },
        nav: { account: 134_384.15, book: 997_459.65 },
        balance: { account: { receivable: 5_000, positions: 80_380, assets: 134_384.15, netAssets: 134_384.15 }, book: { receivable: 5_000, positions: 80_380, assets: 997_459.65, netAssets: 997_459.65 } },
        alerts: ['hedge.review', 'hedge.review'], // 'core' (retried) and 'funded' (its protection lapsed): the hedges no longer match the exposure
      },
    },
    { id: 'after-expiry-wrapped', covers: ['package state after expiry'], action: 'strategy_check', lot: 'wrapped', expect: { result: { status: 'closed', orders: [{ kind: 'link', status: 'filled' }, { instrument: 'put50', status: 'filled', filledQty: 1 }] } } },
    {
      id: 'settle-expiry', covers: ['settlement'], action: 'clock', to: MAR(23),
      expect: { events: [{ type: 'settlement.receive', summary: 'received 5,000.00 USD into settled cash' }], cash: { account: { USD: { settled: 54_004.15, unsettled: 0, receivable: 0, availableToTrade: 54_004.15, availableToWithdraw: 54_004.15 } } }, pending: [], balance: { account: { cash: 54_004.15, receivable: null }, book: { cash: 917_079.65, receivable: null } } },
    },
    {
      // Half of 'core': 600 shares at 48.95 (realized 600 x (48.95 - 50.05) = -660) and 6 April puts at 1.60 (-60).
      id: 'close-share', covers: ['reduce', 'close share'], action: 'close', lot: 'core', scope: 'strategy', percent: 50,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', instrument: 'main', qty: 600, estimate: 48.95, settleDate: '2026-03-24', cash: 29_370, fees: 6 }, { action: 'sell', instrument: 'put48apr', qty: 6, estimate: 1.6, cash: 960, fees: 3 }], cash: { USD: { proceeds: 30_330, fees: 9, required: 9, available: 54_004.15 } } },
        result: { status: 'open', orders: [{ instrument: 'main', status: 'filled', filledQty: 600 }, { instrument: 'put48apr', status: 'filled', filledQty: 6 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 600 KSTL @ 48.95 USD (realized -660.00 USD)' }, { type: 'trade.fill', summary: 'Sold 6 KSTL260417P48 @ 1.60 USD (realized -60.00 USD)' }],
        cash: { account: { USD: { unsettled: 30_321, receivable: 30_321, availableToTrade: 84_325.15, availableToWithdraw: 54_004.15 } } },
        positions: [longPos('main', 'core', 600, 50.05, 30_030, 49, 29_400, -630), longPos('main', 'funded', 400, 50.05, 20_020, 49, 19_600, -420), longPos('put48apr', 'core', 6, 1.7, 1_020, 1.65, 990, -30)],
        holdings: { main: { long: 1000, short: 0, net: 1000 }, put48apr: { long: 6, short: 0, net: 6 } },
        pending: [{ lot: 'core', dueDate: '2026-03-24', amount: 29_364 }, { lot: 'core', dueDate: '2026-03-24', amount: 957 }],
        pnl: { account: { realized: -1_475, commissions: -53.5, unrealized: -1_080, total: -2_609.35 }, book: { realized: -1_475, commissions: -53.5, unrealized: -1_080, total: -2_609.35 } },
        nav: { account: 134_315.15, book: 997_390.65 },
        balance: { account: { receivable: 30_321, positions: 49_990, assets: 134_315.15, netAssets: 134_315.15 }, book: { receivable: 30_321, positions: 49_990, assets: 997_390.65, netAssets: 997_390.65 } },
      },
    },
    {
      id: 'close-exact', covers: ['reduce', 'close exact amount'], action: 'close', lot: 'core', instrument: 'main', qty: 200,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', instrument: 'main', qty: 200, cash: 9_790, fees: 2 }] },
        result: { status: 'open', orders: [{ instrument: 'main', status: 'filled', filledQty: 200 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 200 KSTL @ 48.95 USD (realized -220.00 USD)' }],
        cash: { account: { USD: { unsettled: 40_109, receivable: 40_109, availableToTrade: 94_113.15 } } },
        positions: [longPos('main', 'core', 400, 50.05, 20_020, 49, 19_600, -420), longPos('main', 'funded', 400, 50.05, 20_020, 49, 19_600, -420), longPos('put48apr', 'core', 6, 1.7, 1_020, 1.65, 990, -30)],
        holdings: { main: { long: 800, short: 0, net: 800 }, put48apr: { long: 6, short: 0, net: 6 } },
        pending: [{ lot: 'core', amount: 9_788 }, { lot: 'core', amount: 29_364 }, { lot: 'core', amount: 957 }],
        pnl: { account: { realized: -1_695, commissions: -55.5, unrealized: -870, total: -2_621.35 }, book: { realized: -1_695, commissions: -55.5, unrealized: -870, total: -2_621.35 } },
        nav: { account: 134_303.15, book: 997_378.65 },
        balance: { account: { receivable: 40_109, positions: 40_190, assets: 134_303.15, netAssets: 134_303.15 }, book: { receivable: 40_109, positions: 40_190, assets: 997_378.65, netAssets: 997_378.65 } },
      },
    },
    {
      id: 'close-all', covers: ['close'], action: 'close', lot: 'core', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', instrument: 'main', qty: 400, cash: 19_580, fees: 4 }, { action: 'sell', instrument: 'put48apr', qty: 6, cash: 960, fees: 3 }] },
        result: { status: 'closed', orders: [{ instrument: 'main', status: 'filled', filledQty: 400 }, { instrument: 'put48apr', status: 'filled', filledQty: 6 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 400 KSTL @ 48.95 USD (realized -440.00 USD)' }, { type: 'trade.fill', summary: 'Sold 6 KSTL260417P48 @ 1.60 USD (realized -60.00 USD)' }],
        cash: { account: { USD: { unsettled: 60_642, receivable: 60_642, availableToTrade: 114_646.15 } } },
        positions: [longPos('main', 'funded', 400, 50.05, 20_020, 49, 19_600, -420)],
        holdings: { main: { long: 400, short: 0, net: 400 }, put48apr: null },
        pending: [{ lot: 'core', amount: 9_788 }, { lot: 'core', amount: 19_576 }, { lot: 'core', amount: 29_364 }, { lot: 'core', amount: 957 }, { lot: 'core', amount: 957 }],
        lifecycle: [],
        pnl: { account: { realized: -2_195, commissions: -62.5, unrealized: -420, total: -2_678.35 }, book: { realized: -2_195, commissions: -62.5, unrealized: -420, total: -2_678.35 } },
        nav: { account: 134_246.15, book: 997_321.65 },
        balance: { account: { receivable: 60_642, positions: 19_600, assets: 134_246.15, netAssets: 134_246.15 }, book: { receivable: 60_642, positions: 19_600, assets: 997_321.65, netAssets: 997_321.65 } },
        alerts: ['hedge.review'],
      },
    },
    {
      id: 'close-funded', covers: ['close'], action: 'close', lot: 'funded', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', instrument: 'main', qty: 400, cash: 19_580, fees: 4 }] },
        result: { status: 'closed', orders: [{ instrument: 'main', status: 'filled', filledQty: 400 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 400 KSTL @ 48.95 USD (realized -440.00 USD)' }],
        cash: { account: { USD: { unsettled: 80_218, receivable: 80_218, availableToTrade: 134_222.15 } } },
        positions: [], holdings: { main: null },
        pending: [{ lot: 'core', amount: 9_788 }, { lot: 'core', amount: 19_576 }, { lot: 'funded', amount: 19_576 }, { lot: 'core', amount: 29_364 }, { lot: 'core', amount: 957 }, { lot: 'core', amount: 957 }],
        pnl: { account: { realized: -2_635, commissions: -66.5, unrealized: 0, total: -2_702.35 }, book: { realized: -2_635, commissions: -66.5, unrealized: 0, total: -2_702.35 } },
        nav: { account: 134_222.15, book: 997_297.65 },
        balance: { account: { receivable: 80_218, positions: null, assets: 134_222.15, netAssets: 134_222.15 }, book: { receivable: 80_218, positions: null, assets: 997_297.65, netAssets: 997_297.65 } },
        alerts: [],
      },
    },
    {
      // Nothing held, reserved, borrowed or scheduled. Whole scenario: realized -2,635; commissions 66.50; interest 0.85.
      // The Account holds what Treasury funded net (136,924.50) less the loss (2,702.35).
      id: 'settle-closes', covers: ['settlement'], action: 'clock', to: MAR(24),
      expect: {
        events: [29_364, 957, 9_788, 19_576, 957, 19_576].map((x) => ({ type: 'settlement.receive', cash: { USD: x } })),
        cash: { account: { USD: { settled: 134_222.15, unsettled: 0, receivable: 0, payable: 0, reserved: 0, availableToTrade: 134_222.15, availableToWithdraw: 134_222.15 } }, treasury: { USD: { settled: 863_075.5 } } },
        pending: [], openOrders: [], lifecycle: [], borrowings: [],
        nav: { account: 134_222.15, treasury: 863_075.5, book: 997_297.65 },
        balance: { account: { cash: 134_222.15, receivable: null, assets: 134_222.15, liabilities: 0, netAssets: 134_222.15 }, book: { cash: 997_297.65, receivable: null, assets: 997_297.65, liabilities: 0, netAssets: 997_297.65 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// protective_call
// ---------------------------------------------------------------------------------------------
// Three legs: a simulated securities borrow, the short sale that waits for it, and one call per 100 shares sold (the
// contract's deliverable) that waits for the short sale and is scaled to what of it filled. A small displayed size
// fills the sale and the calls in parts; the remainder is cancelled and retried. A short sale held at a limit never
// reached leaves its calls unbought; the package is cancelled and unwound (the borrow goes back). Another package whose
// call is held at a limit is accepted as it stands, and its short is then protected by a call on the existing short
// (no new sale: the short and its borrow are linked to the new strategy instance). The first package is resized (a
// second borrow record; the calls wait for the added sale) and its calls rolled to April. Cash short: blocked, funded
// from Treasury, borrowed and repaid. At the March expiry (close 51.00) the 50 call is in the money and is exercised:
// the 100 shares received cover the linked short and its borrow goes back the same day; the 52 calls lapse.
//
// Short rules as in the short template (Book short assumptions): proceeds less commission T+1 into restricted cash;
// collateral marked to 102% of quantity x last price when the proceeds arrive and at each end of day; 30% of quantity x
// last price reserved from free cash; borrow fee 1.8% a year, ACT/360, on quantity x last price, accrued at each end of
// day from the day the sale settles and to the day of a return; paid when a borrow record is fully returned.
const pc = (qty, strike, extra = {}) => pageInput('protective_call', { quantity: qty, options: { expiration: '2026-03-20', strikes: { call: strike }, contracts: null }, ...extra });
const pcPage = (qty, strike, extra = {}) => ({ template: 'Protective Call / Short + Call Cover', underlying: 'main', quantity: qty, expiration: '2026-03-20', strikes: { 'Call strike': strike }, ...extra });
const pcCall = (instrument, lot, qty, avgCost, price) => longPos(instrument, lot, qty, avgCost, qty * avgCost * 100, price, Math.round(qty * price * 100 * 100) / 100, Math.round(qty * (price - avgCost) * 100 * 100) / 100);
const pcShort = (lot, qty, price, restrictedCash) => ({ ...shortPos(lot, qty, qty * price, qty * (price - 50), restrictedCash), price });

const protectiveCall = {
  template: 'protective_call',
  title: 'Protective call on Kestrel Logistics: borrow, short sale and calls as one package, new and existing short, partial fills, expiry, roll',
  matrix: {
    ...TEMPLATE_MATRIX,
    ticket: 'Strategies page (Protective Call / Short + Call Cover): Trading owner and intent, Instrument and template, Underlying position (new or existing), Securities borrow, Option contracts, Order and funding, Hedge panel; then the package preview (legs editable). The strategy instance drawer for Cancel working legs, Retry, Unwind, Accept, Resize, Roll and Close',
    manualInputs: ['option expiration and call strike (no option chain is supplied for the fictional stock)', 'limit price of a leg, changed in the preview', 'investment Strategy, holding period and objective for the hedge request', 'loan rate when the shortfall is borrowed'],
    automaticInputs: [...TEMPLATE_MATRIX.automaticInputs, 'contracts from the share quantity and the contract deliverable (100 shares)', 'borrow availability and fee (borrow fixture)', 'collateral and margin from the Book short assumptions', 'underlying close for the expiration date (close fixture)'],
    settlement: 'Short-sale proceeds T+1 into restricted cash; premium T+1; covers T+1 paid from restricted cash, as are shares received on exercise (at the strike)',
    lifecycle: 'Borrow, then the short sale, then the calls (each waits for the one before and is scaled to what filled); retry and resize keep that link; expiry in the money exercises the call against the short and returns the borrow; out of the money lapses; roll; close by share, exact amount, in full',
    accounting: 'Short at negative cost; call premium as an option position; realized on cover, exercise, lapse or sale; borrow fee and loan interest as funding expense; an existing short is linked with its borrow, not sold again',
    collateral: 'Restricted cash 102% of the short market value and a 30% margin reserve; bought calls reserve nothing',
  },
  start: MAR(2),
  settlementCheck: { lag: 1, holidays: [] },
  book: book('Matrix template protective call'),
  instruments: { main: STOCK, call52: option('C', 52), call50: option('C', 50), call52apr: option('C', 52, '2026-04-17') },
  // The last trade is at the bid: the margin reserve (30% of the last price) is then 30% of the sale proceeds.
  quotes: {
    main: { bid: 50.00, ask: 50.10, last: 50.00, bidSize: 300, askSize: 300 },
    call52: { bid: 0.90, ask: 1.00, last: 0.95, bidSize: 3, askSize: 3 },
    call50: { bid: 1.80, ask: 1.90, last: 1.85, bidSize: 100, askSize: 100 },
    call52apr: { bid: 1.60, ask: 1.70, last: 1.65, bidSize: 100, askSize: 100 },
  },
  borrow: { main: { available: true, quantity: 50_000, feeRate: 0.018 } },
  expectAtStart: startState(),
  steps: [
    {
      // The template's calls are sent with the request as proposed protection; the fixture proposes nothing on top.
      id: 'hedge-request', covers: ['hedge request', 'template protection'], action: 'hedge_request',
      input: pc(1000, 52, { ...CONTEXT, hedgeObjective: { type: 'upside_protection_short' } }), strategyPage: { ...PAGE_CONTEXT, objective: 'Upside protection for shorts', ...pcPage(1000, 52) },
      expect: {
        result: {
          state: 'recommendation_ready', complete: true, missing: [], source: { kind: 'demo-fixture', label: 'Demo fixture, not Shaffer Hedge' }, packages: [], recommendedId: null,
          note: 'Nothing further is proposed for price risk: the position is already protected (10 calls in the template). The demo fixture does not layer a second hedge on top.',
          investmentStrategy: { id: 'DEMO-IS-002', name: 'Core Equity', resolved: true }, holdingDays: 30, objective: 'upside_protection_short', scope: 'trade',
          primary: { instrument: 'main', direction: 'short', quantity: 1000, status: 'proposed' },
          proposedProtection: [{ action: 'buy', quantity: 10, right: 'C', strike: 52 }], linkedProtection: [], hedgesHeld: [],
        },
      },
    },
    {
      // Borrow 1,000; sell 1,000 short at the 50.00 bid (bidSize 300); buy 10 calls (1,000 / 100; askSize 3). On
      // confirmation 300 shares are sold and 3 calls follow (10 x 300 / 1,000); in the next cycle 300 and 3 more.
      // Required: premium 1,000 + fees 15 (10 + 5) + 2% top-up 1,000 + 30% margin 15,000 = 17,015.
      id: 'open-partial', covers: ['open', 'borrow', 'partial fill', 'dependent leg scaled'], action: 'package', as: 'core', instrument: 'main',
      input: pc(1000, 52), strategyPage: pcPage(1000, 52),
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [], template: 'protective_call',
          legs: [
            { kind: 'borrow_sec', action: 'borrow_sec', purpose: 'financing', instrument: 'main', qty: 1000, dependsOn: [], borrow: { available: true, feeRate: 0.018, dailyCost: 2.5, source: 'Test fixture' } }, // 1,000 x 50 x 0.018 / 360
            { kind: 'trade', action: 'sell_short', purpose: 'primary', instrument: 'main', qty: 1000, estimate: 50, settleDate: '2026-03-03', cash: 50_000, fees: 10, dependsOn: [1], shortCollateral: { topUp: 1_000, marginHold: 15_000 } },
            { kind: 'trade', action: 'buy', purpose: 'hedge', instrument: 'call52', qty: 10, estimate: 1, settleDate: '2026-03-03', cash: -1_000, fees: 5, dependsOn: [2] },
          ],
          cash: { USD: { purchases: 1_000, proceeds: 0, restrictedProceeds: 50_000, fees: 15, collateral: 1_000, margin: 15_000, required: 17_015, available: 200_000, shortfall: 0 } },
          netPremium: { amount: 1_000, ccy: 'USD', type: 'debit' }, optionRequirement: [],
        },
        result: { status: 'partial', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 1000 }, { action: 'sell_short', status: 'partial', qty: 1000, filledQty: 300, avgPrice: 50 }, { instrument: 'call52', status: 'partial', qty: 10, filledQty: 3, avgPrice: 1, reason: 'Waiting on leg 2' }] },
        events: [{ type: 'strategy.submitted', summary: 'Package submitted: Protective Call KSTL (3 legs; open)' }, { type: 'secloan.borrow', summary: 'Borrowed 1,000 KSTL at a fee of 1.800% p.a.' }, { type: 'trade.fill', summary: 'Sold short 300 KSTL @ 50.00 USD' }, { type: 'trade.fill', summary: 'Bought 3 KSTL260320C52 @ 1.00 USD' }, { type: 'trade.fill', summary: 'Sold short 300 KSTL @ 50.00 USD' }, { type: 'trade.fill', summary: 'Bought 3 KSTL260320C52 @ 1.00 USD' }],
        // Restricted, to come: 2 x (300 x 50 - 3) = 29,994. Owed for calls: 2 x (300 + 1.50) = 603. Reserved 0.30 x 600 x 50.
        cash: { account: { USD: { settled: 200_000, unsettled: 29_391, receivable: 29_994, payable: 603, reserved: 9_000, restricted: 0, availableToTrade: 190_397, availableToWithdraw: 190_397 } } },
        positions: [borrowed('core', 1000, 50_000), pcCall('call52', 'core', 6, 1, 0.95), pcShort('core', -600, 50, 0)],
        holdings: { main: { long: 0, short: 600, net: -600 }, call52: { long: 6, short: 0, net: 6 } },
        pending: [...[-301.5, -301.5].map((amount) => ({ instrument: 'call52', amount, into: 'cash' })), ...[14_997, 14_997].map((amount) => ({ instrument: 'main', amount, into: 'cash.restricted' }))].map((x) => ({ ...x, lot: 'core', owner: 'account', dueDate: '2026-03-03', ccy: 'USD' })),
        openOrders: [{ instrument: 'main', action: 'sell_short', status: 'partial', qty: 1000, filledQty: 600 }, { instrument: 'call52', status: 'partial', qty: 10, filledQty: 6 }],
        lifecycle: [expiryItem('call52'), ...fee(1)],
        borrowings: [secBorrow('core', 1000, 50_000, 0, null)],
        pnl: { account: { realized: 0, commissions: -9, borrowFunding: 0, unrealized: -30, total: -39 }, book: { realized: 0, commissions: -9, unrealized: -30, total: -39 }, treasury: { total: 0 } },
        nav: { account: 199_961, treasury: 800_000, book: 999_961 },
        balance: {
          account: { cash: 200_000, receivable: 29_994, positions: -29_430, payable: 603, assets: 200_564, liabilities: 603, netAssets: 199_961 },
          book: { cash: 1_000_000, receivable: 29_994, positions: -29_430, payable: 603, assets: 1_000_564, liabilities: 603, netAssets: 999_961 },
          treasury: { cash: 800_000, assets: 800_000, netAssets: 800_000 },
        },
        oversight: { accountBorrowings: [oversee('core', 0)], accounts: { account: { cashBorrowed: 0, fundingReceived: 200_000 } }, treasuryOwn: [] },
      },
    },
    {
      id: 'cancel-remainder', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'core',
      expect: {
        result: { status: 'attention', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 1000 }, { action: 'sell_short', status: 'cancelled', filledQty: 600 }, { instrument: 'call52', status: 'cancelled', filledQty: 6 }] },
        events: [{ type: 'order.cancelled', summary: 'Leg 2 cancelled: sell short 1,000 KSTL. Cancelled by user (600 of 1,000 had filled and remains in place)' }, { type: 'order.cancelled', summary: 'Leg 3 cancelled: buy 10 KSTL260320C52. Cancelled by user (6 of 10 had filled and remains in place)' }],
        openOrders: [], failed: { orders: 2 }, alerts: ['strategy.attention'],
      },
    },
    {
      // The 400 not sold are sold against the borrow already held; the calls still wait for them (300 + 3, then 100 + 1).
      // The exposure changed after its protection was on, so the strategy is flagged for a hedge review.
      id: 'retry', covers: ['retry'], action: 'recover', how: 'retry', lot: 'core',
      expect: {
        preview: { blocking: 0, intent: 'retry', legs: [{ action: 'sell_short', qty: 400, estimate: 50, cash: 20_000, fees: 4, dependsOn: [], shortCollateral: { topUp: 400, marginHold: 6_000 } }, { instrument: 'call52', qty: 4, cash: -400, fees: 2, dependsOn: [1] }], cash: { USD: { purchases: 400, restrictedProceeds: 20_000, fees: 6, collateral: 400, margin: 6_000, required: 6_806, available: 190_397, shortfall: 0 } } },
        result: { status: 'partial', orders: [{ action: 'sell_short', status: 'partial', qty: 400, filledQty: 300 }, { instrument: 'call52', status: 'partial', qty: 4, filledQty: 3 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Call KSTL (2 legs; retry)' }, { type: 'trade.fill', summary: 'Sold short 300 KSTL @ 50.00 USD' }, { type: 'trade.fill', summary: 'Bought 3 KSTL260320C52 @ 1.00 USD' }, { type: 'trade.fill', summary: 'Sold short 100 KSTL @ 50.00 USD' }, { type: 'trade.fill', summary: 'Bought 1 KSTL260320C52 @ 1.00 USD' }],
        // Restricted to come 3 x 14,997 + 4,999 = 49,990; owed for calls 3 x 301.50 + 100.50 = 1,005; reserved 0.30 x 1,000 x 50.
        cash: { account: { USD: { unsettled: 48_985, receivable: 49_990, payable: 1_005, reserved: 15_000, availableToTrade: 183_995, availableToWithdraw: 183_995 } } },
        positions: [borrowed('core', 1000, 50_000), pcCall('call52', 'core', 10, 1, 0.95), pcShort('core', -1000, 50, 0)],
        holdings: { main: { long: 0, short: 1000, net: -1000 }, call52: { long: 10, short: 0, net: 10 } },
        pending: [...[-301.5, -301.5, -301.5, -100.5].map((amount) => ({ instrument: 'call52', lot: 'core', amount })), ...[4_999, 14_997, 14_997, 14_997].map((amount) => ({ instrument: 'main', lot: 'core', amount }))],
        pnl: { account: { commissions: -15, unrealized: -50, total: -65 }, book: { commissions: -15, unrealized: -50, total: -65 } },
        nav: { account: 199_935, book: 999_935 },
        balance: { account: { receivable: 49_990, positions: -49_050, payable: 1_005, assets: 200_940, liabilities: 1_005, netAssets: 199_935 }, book: { receivable: 49_990, positions: -49_050, payable: 1_005, assets: 1_000_940, liabilities: 1_005, netAssets: 999_935 } },
        alerts: ['hedge.review'],
      },
    },
    {
      // The short sale is set to a limit of 52 in the preview, above the bid: the borrow fills, the sale works, and the
      // calls, waiting for it, are not bought (a protective call on nothing sold short would be a naked call purchase).
      id: 'limit-never-reached', covers: ['failed dependent leg'], action: 'package', as: 'limited', instrument: 'main',
      input: pc(200, 50), strategyPage: pcPage(200, 50), editLegs: { 2: { orderType: 'limit', limitPrice: 52 } },
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'borrow_sec', qty: 200, borrow: { dailyCost: 0.5 } }, { action: 'sell_short', qty: 200, orderType: 'limit', cash: 10_000, fees: 2, dependsOn: [1], shortCollateral: { topUp: 200, marginHold: 3_000 } }, { instrument: 'call50', qty: 2, estimate: 1.9, cash: -380, fees: 1, dependsOn: [2] }], cash: { USD: { purchases: 380, restrictedProceeds: 10_000, fees: 3, collateral: 200, margin: 3_000, required: 3_583, available: 183_995 } } },
        result: { status: 'partial', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 200 }, { action: 'sell_short', status: 'working', filledQty: 0, reason: 'Limit not reached: executable price 50 is below the limit 52.' }, { instrument: 'call50', filledQty: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'secloan.borrow', summary: 'Borrowed 200 KSTL at a fee of 1.800% p.a.' }],
        positions: [borrowed('core', 1000, 50_000), borrowed('limited', 200, 10_000), pcCall('call52', 'core', 10, 1, 0.95), pcShort('core', -1000, 50, 0)],
        openOrders: [{ instrument: 'main', action: 'sell_short', status: 'working', qty: 200, filledQty: 0 }, { instrument: 'call50', qty: 2, filledQty: 0 }],
        lifecycle: [expiryItem('call52'), ...fee(2)],
        borrowings: [secBorrow('core', 1000, 50_000, 0, null), secBorrow('limited', 200, 10_000, 0, null)],
        oversight: { accountBorrowings: [oversee('core', 0), oversee('limited', 0)] },
      },
    },
    { id: 'cancel-limited', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'limited', expect: { result: { status: 'attention', orders: [{ kind: 'borrow_sec', status: 'filled' }, { status: 'cancelled', filledQty: 0 }, { status: 'cancelled', filledQty: 0 }] }, events: [{ type: 'order.cancelled', summary: 'Leg 2 cancelled: sell short 200 KSTL. Cancelled by user' }, { type: 'order.cancelled', summary: 'Leg 3 cancelled: buy 2 KSTL260320C50. Cancelled by user' }], openOrders: [], failed: { orders: 4 }, alerts: ['hedge.review', 'strategy.attention'] } },
    {
      // Unwind gives back what filled: the borrow, the same day (no fee: it never supported a settled sale).
      id: 'unwind', covers: ['unwind', 'return'], action: 'recover', how: 'unwind', lot: 'limited',
      expect: {
        preview: { blocking: 0, intent: 'unwind', legs: [{ kind: 'return_sec', action: 'return_sec', instrument: 'borrow:main', qty: 200 }] },
        result: { status: 'closed', orders: [{ kind: 'return_sec', status: 'filled', filledQty: 200 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Call KSTL (1 leg; unwind)' }, { type: 'secloan.return', summary: 'Returned 200 borrowed KSTL' }],
        positions: [borrowed('core', 1000, 50_000), pcCall('call52', 'core', 10, 1, 0.95), pcShort('core', -1000, 50, 0)],
        lifecycle: [expiryItem('call52'), ...fee(1)], borrowings: [secBorrow('core', 1000, 50_000, 0, null)], oversight: { accountBorrowings: [oversee('core', 0)] }, alerts: ['hedge.review'],
      },
    },
    {
      // 100 sold short; its call is set to a limit of 1.50 in the preview, below the 1.90 ask, and works.
      id: 'kept-limit', covers: ['failed dependent leg'], action: 'package', as: 'kept', instrument: 'main',
      input: pc(100, 50), strategyPage: pcPage(100, 50), editLegs: { 3: { orderType: 'limit', limitPrice: 1.5 } },
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'borrow_sec', qty: 100, borrow: { dailyCost: 0.25 } }, { action: 'sell_short', qty: 100, cash: 5_000, fees: 1, dependsOn: [1], shortCollateral: { topUp: 100, marginHold: 1_500 } }, { instrument: 'call50', qty: 1, orderType: 'limit', cash: -190, fees: 0.5, dependsOn: [2] }], cash: { USD: { purchases: 190, restrictedProceeds: 5_000, fees: 1.5, collateral: 100, margin: 1_500, required: 1_791.5, available: 183_995 } } },
        result: { status: 'partial', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 100 }, { action: 'sell_short', status: 'filled', filledQty: 100 }, { instrument: 'call50', status: 'working', filledQty: 0, reason: 'Limit not reached: executable price 1.9 is above the limit 1.5.' }] },
        events: [{ type: 'strategy.submitted' }, { type: 'secloan.borrow', summary: 'Borrowed 100 KSTL at a fee of 1.800% p.a.' }, { type: 'trade.fill', summary: 'Sold short 100 KSTL @ 50.00 USD' }],
        cash: { account: { USD: { unsettled: 53_984, receivable: 54_989, reserved: 16_500, availableToTrade: 182_495, availableToWithdraw: 182_495 } } }, // + 4,999 to come; + 0.30 x 100 x 50 reserved
        positions: [borrowed('core', 1000, 50_000), borrowed('kept', 100, 5_000), pcCall('call52', 'core', 10, 1, 0.95), pcShort('core', -1000, 50, 0), pcShort('kept', -100, 50, 0)],
        holdings: { main: { long: 0, short: 1100, net: -1100 } },
        pending: [...[-301.5, -301.5, -301.5, -100.5].map((amount) => ({ instrument: 'call52', lot: 'core', amount })), { instrument: 'main', lot: 'core', amount: 4_999 }, { instrument: 'main', lot: 'kept', amount: 4_999 }, ...[14_997, 14_997, 14_997].map((amount) => ({ instrument: 'main', lot: 'core', amount }))],
        openOrders: [{ instrument: 'call50', status: 'working', qty: 1, filledQty: 0 }],
        lifecycle: [expiryItem('call52'), ...fee(2)], borrowings: [secBorrow('core', 1000, 50_000, 0, null), secBorrow('kept', 100, 5_000, 0, null)], oversight: { accountBorrowings: [oversee('core', 0), oversee('kept', 0)] },
        pnl: { account: { commissions: -16, total: -66 }, book: { commissions: -16, total: -66 } },
        nav: { account: 199_934, book: 999_934 },
        balance: { account: { receivable: 54_989, positions: -54_050, assets: 200_939, netAssets: 199_934 }, book: { receivable: 54_989, positions: -54_050, assets: 1_000_939, netAssets: 999_934 } },
      },
    },
    { id: 'cancel-kept', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'kept', expect: { result: { status: 'attention' }, events: [{ type: 'order.cancelled', summary: 'Leg 3 cancelled: buy 1 KSTL260320C50. Cancelled by user' }], openOrders: [], failed: { orders: 5 }, alerts: ['hedge.review', 'strategy.attention'] } },
    { id: 'accept-kept', covers: ['accept as it stands'], action: 'strategy_action', how: 'accept', lot: 'kept', expect: { result: { status: 'open' }, events: [{ type: 'strategy.accepted', summary: 'Protective Call KSTL: accepted as it stands with 1 leg unexecuted. The position no longer matches its template.' }], alerts: ['hedge.review'] } },
    {
      // Protect the 100 shares already short: nothing is sold or borrowed, only the call is bought (1 x 1.90 x 100). The
      // short and its borrow move into the new strategy instance; no further margin is asked for.
      id: 'existing-short', covers: ['existing holding', 'open'], action: 'package', as: 'wrapped', instrument: 'main',
      input: { template: 'protective_call', underlyingId: '$inst:main', origin: 'strategy_page', ...NO_CONTEXT, mode: 'existing', existingPositionId: '$pos:kept:main', quantity: 100, hedgeRatio: 1, options: { expiration: '2026-03-20', strikes: { call: 50 }, contracts: null }, borrow: null, orderType: 'market', limitPrice: null, stopPrice: null, tif: 'day', financing: null },
      strategyPage: { template: 'Protective Call / Short + Call Cover', underlying: 'main', mode: 'existing', existing: { lot: 'kept', instrument: 'main' }, expiration: '2026-03-20', strikes: { 'Call strike': 50 } },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'link', action: 'use_existing', purpose: 'primary', instrument: 'main', qty: 100 }, { kind: 'trade', action: 'buy', purpose: 'hedge', instrument: 'call50', qty: 1, estimate: 1.9, cash: -190, fees: 0.5, dependsOn: [1] }], cash: { USD: { purchases: 190, fees: 0.5, margin: 0, collateral: 0, required: 190.5, available: 182_495 } } },
        result: { status: 'open', orders: [{ kind: 'link', status: 'filled', filledQty: 100 }, { instrument: 'call50', status: 'filled', filledQty: 1, avgPrice: 1.9 }] },
        events: [{ type: 'strategy.submitted', summary: 'Package submitted: Protective Call KSTL (2 legs; open)' }, { type: 'position.linked', summary: 'Linked existing short position of 100 KSTL to this strategy (no trade)' }, { type: 'trade.fill', summary: 'Bought 1 KSTL260320C50 @ 1.90 USD' }],
        cash: { account: { USD: { unsettled: 53_793.5, payable: 1_195.5, availableToTrade: 182_304.5, availableToWithdraw: 182_304.5 } } },
        positions: [borrowed('core', 1000, 50_000), borrowed('wrapped', 100, 5_000), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'core', 10, 1, 0.95), pcShort('core', -1000, 50, 0), pcShort('wrapped', -100, 50, 0)],
        holdings: { call50: { long: 1, short: 0, net: 1 } },
        pending: [{ instrument: 'call50', lot: 'wrapped', amount: -190.5 }, ...[-301.5, -301.5, -301.5, -100.5].map((amount) => ({ instrument: 'call52', lot: 'core', amount })), { instrument: 'main', lot: 'core', amount: 4_999 }, { instrument: 'main', lot: 'kept', amount: 4_999 }, ...[14_997, 14_997, 14_997].map((amount) => ({ instrument: 'main', lot: 'core', amount }))],
        lifecycle: [expiryItem('call50'), expiryItem('call52'), ...fee(2)], borrowings: [secBorrow('core', 1000, 50_000, 0, null), secBorrow('wrapped', 100, 5_000, 0, null)], oversight: { accountBorrowings: [oversee('core', 0), oversee('wrapped', 0)] },
        pnl: { account: { commissions: -16.5, unrealized: -55, total: -71.5 }, book: { commissions: -16.5, unrealized: -55, total: -71.5 } },
        nav: { account: 199_928.5, book: 999_928.5 },
        balance: { account: { positions: -53_865, payable: 1_195.5, assets: 201_124, liabilities: 1_195.5, netAssets: 199_928.5 }, book: { positions: -53_865, payable: 1_195.5, assets: 1_001_124, liabilities: 1_195.5, netAssets: 999_928.5 } },
      },
    },
    { id: 'kept-after-link', covers: ['existing holding'], action: 'strategy_check', lot: 'kept', expect: { result: { status: 'closed', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 100 }, { action: 'sell_short', status: 'filled', filledQty: 100 }, { instrument: 'call50', status: 'cancelled', filledQty: 0 }] } } }, // its short now belongs to 'wrapped'
    { id: 'deep-book', action: 'quote', instrument: 'main', quote: { bid: 50.00, ask: 50.10, last: 50.00, bidSize: 10000, askSize: 10000 }, expect: {} },
    { id: 'deep-book-call', action: 'quote', instrument: 'call52', quote: { bid: 0.90, ask: 1.00, last: 0.95, bidSize: 100, askSize: 100 }, expect: {} },
    {
      // 1,000 x 1.2 = 1,200: a borrow of 200 more (its own record), the short sale after it, and 2 calls after the sale.
      id: 'resize-up', covers: ['resize', 'increase', 'borrow'], action: 'resize', lot: 'core', factor: 1.2,
      expect: {
        preview: { blocking: 0, intent: 'resize', legs: [{ kind: 'borrow_sec', qty: 200, borrow: { dailyCost: 0.5 } }, { action: 'sell_short', qty: 200, cash: 10_000, fees: 2, dependsOn: [1], shortCollateral: { topUp: 200, marginHold: 3_000 } }, { instrument: 'call52', qty: 2, cash: -200, fees: 1, dependsOn: [2] }], cash: { USD: { purchases: 200, restrictedProceeds: 10_000, fees: 3, collateral: 200, margin: 3_000, required: 3_403, available: 182_304.5 } } },
        result: { status: 'open', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 200 }, { action: 'sell_short', status: 'filled', filledQty: 200 }, { instrument: 'call52', status: 'filled', filledQty: 2 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Call KSTL (3 legs; resize)' }, { type: 'secloan.borrow', summary: 'Borrowed 200 KSTL at a fee of 1.800% p.a.' }, { type: 'trade.fill', summary: 'Sold short 200 KSTL @ 50.00 USD' }, { type: 'trade.fill', summary: 'Bought 2 KSTL260320C52 @ 1.00 USD' }],
        cash: { account: { USD: { unsettled: 63_590.5, receivable: 64_987, payable: 1_396.5, reserved: 19_500, availableToTrade: 179_103.5, availableToWithdraw: 179_103.5 } } },
        positions: [borrowed('core', 200, 10_000), borrowed('core', 1000, 50_000), borrowed('wrapped', 100, 5_000), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'core', 12, 1, 0.95), pcShort('core', -1200, 50, 0), pcShort('wrapped', -100, 50, 0)],
        holdings: { main: { long: 0, short: 1300, net: -1300 }, call52: { long: 12, short: 0, net: 12 } },
        pending: [{ instrument: 'call50', lot: 'wrapped', amount: -190.5 }, ...[-301.5, -301.5, -301.5, -201, -100.5].map((amount) => ({ instrument: 'call52', lot: 'core', amount })), { instrument: 'main', lot: 'core', amount: 4_999 }, { instrument: 'main', lot: 'kept', amount: 4_999 }, ...[9_998, 14_997, 14_997, 14_997].map((amount) => ({ instrument: 'main', lot: 'core', amount }))],
        lifecycle: [expiryItem('call50'), expiryItem('call52'), ...fee(3)], borrowings: [secBorrow('core', 1000, 50_000, 0, null), secBorrow('core', 200, 10_000, 0, null), secBorrow('wrapped', 100, 5_000, 0, null)], oversight: { accountBorrowings: [oversee('core', 0), oversee('core', 0), oversee('wrapped', 0)] },
        pnl: { account: { commissions: -19.5, unrealized: -65, total: -84.5 }, book: { commissions: -19.5, unrealized: -65, total: -84.5 } },
        nav: { account: 199_915.5, book: 999_915.5 },
        balance: { account: { receivable: 64_987, positions: -63_675, payable: 1_396.5, assets: 201_312, liabilities: 1_396.5, netAssets: 199_915.5 }, book: { receivable: 64_987, positions: -63_675, payable: 1_396.5, assets: 1_001_312, liabilities: 1_396.5, netAssets: 999_915.5 } },
      },
    },
    {
      // Roll the 12 March calls of 'core' to April: sell at 0.90 (realized 12 x (0.90 - 1.00) x 100 = -120), buy at 1.70.
      id: 'roll', covers: ['roll'], action: 'roll', lot: 'core', newExpiration: '2026-04-17',
      expect: {
        preview: { blocking: 0, intent: 'roll', legs: [{ action: 'sell', instrument: 'call52', qty: 12, estimate: 0.9, cash: 1_080, fees: 6 }, { action: 'buy', instrument: 'call52apr', qty: 12, estimate: 1.7, cash: -2_040, fees: 6 }], cash: { USD: { purchases: 2_040, proceeds: 1_080, fees: 12, required: 2_052, available: 179_103.5 } }, netPremium: { amount: 960, type: 'debit' } },
        result: { status: 'open', orders: [{ action: 'sell', instrument: 'call52', status: 'filled', filledQty: 12 }, { action: 'buy', instrument: 'call52apr', status: 'filled', filledQty: 12 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Call KSTL (2 legs; roll)' }, { type: 'trade.fill', summary: 'Sold 12 KSTL260320C52 @ 0.90 USD (realized -120.00 USD)' }, { type: 'trade.fill', summary: 'Bought 12 KSTL260417C52 @ 1.70 USD' }],
        // + 1,074 to receive (1,080 - 6), + 2,046 to pay (2,040 + 6). The sale proceeds count toward trading, not withdrawal.
        cash: { account: { USD: { unsettled: 62_618.5, receivable: 66_061, payable: 3_442.5, availableToTrade: 178_131.5, availableToWithdraw: 177_057.5 } } },
        positions: [borrowed('core', 200, 10_000), borrowed('core', 1000, 50_000), borrowed('wrapped', 100, 5_000), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 50, 0), pcShort('wrapped', -100, 50, 0)],
        holdings: { call52: null, call52apr: { long: 12, short: 0, net: 12 } },
        pending: [{ instrument: 'call50', lot: 'wrapped', amount: -190.5 }, ...[-301.5, -301.5, -301.5, -201, -100.5, 1_074].map((amount) => ({ instrument: 'call52', lot: 'core', amount })), { instrument: 'call52apr', lot: 'core', amount: -2_046 }, { instrument: 'main', lot: 'core', amount: 4_999 }, { instrument: 'main', lot: 'kept', amount: 4_999 }, ...[9_998, 14_997, 14_997, 14_997].map((amount) => ({ instrument: 'main', lot: 'core', amount }))],
        lifecycle: [expiryItem('call50'), ...fee(3), expiryItem('call52apr', '2026-04-17')],
        pnl: { account: { realized: -120, commissions: -31.5, unrealized: -65, total: -216.5 }, book: { realized: -120, commissions: -31.5, unrealized: -65, total: -216.5 } },
        nav: { account: 199_783.5, book: 999_783.5 },
        balance: { account: { receivable: 66_061, positions: -62_835, payable: 3_442.5, assets: 203_226, liabilities: 3_442.5, netAssets: 199_783.5 }, book: { receivable: 66_061, positions: -62_835, payable: 3_442.5, assets: 1_003_226, liabilities: 3_442.5, netAssets: 999_783.5 } },
      },
    },
    {
      // The sales settle into restricted cash and are marked to 102%: core 1.02 x 1,200 x 50 = 61,200 against 59,988
      // received (3 x 14,997 + 4,999 + 9,998): 1,212 posted. 'kept' no longer holds its short: its 4,999 is released;
      // 'wrapped' now holds it: 1.02 x 100 x 50 = 5,100 posted. No borrow fee yet (it accrues at the end of the day).
      id: 'next-day', covers: ['settlement', 'collateral mark'], action: 'clock', to: MAR(3),
      expect: {
        events: [
          ...[14_997, 14_997, 14_997, 4_999, 4_999, 9_998].map((x) => ({ type: 'settlement.receive', summary: `Settlement: received ${x.toLocaleString('en-US')}.00 USD into restricted cash` })),
          { type: 'settlement.receive', summary: 'Settlement: received 1,074.00 USD into settled cash', cash: { USD: 1_074 } },
          ...[301.5, 301.5, 301.5, 100.5, 190.5, 201, 2_046].map((x) => ({ type: 'settlement.pay', cash: { USD: -x } })),
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 1,212.00 USD', cash: { USD: -1_212 } },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: released 4,999.00 USD', cash: { USD: 4_999 } },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 5,100.00 USD', cash: { USD: -5_100 } },
        ],
        // 200,000 + 1,074 - 3,442.50 - 1,212 + 4,999 - 5,100 = 196,318.50; restricted 61,200 + 5,100 = 66,300.
        cash: { account: { USD: { settled: 196_318.5, unsettled: 0, receivable: 0, payable: 0, restricted: 66_300, availableToTrade: 176_818.5, availableToWithdraw: 176_818.5 } } },
        positions: [borrowed('core', 200, 10_000), borrowed('core', 1000, 50_000), borrowed('wrapped', 100, 5_000), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 50, 61_200), pcShort('wrapped', -100, 50, 5_100)],
        pending: [],
        borrowings: [secBorrow('core', 1000, 50_000, 0, 61_200), secBorrow('core', 200, 10_000, 0, 61_200), secBorrow('wrapped', 100, 5_000, 0, 5_100)],
        balance: { account: { cash: 196_318.5, restricted: 66_300, receivable: null, payable: null, assets: 199_783.5, liabilities: 0 }, book: { cash: 996_318.5, restricted: 66_300, receivable: null, payable: null, assets: 999_783.5, liabilities: 0 } },
      },
    },
    {
      id: 'sweep-to-treasury', covers: ['transfer'], action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 170_000,
      expect: {
        events: [{ type: 'transfer.return', summary: 'Return to Treasury: 170,000.00 USD from Alpha to Treasury' }],
        cash: { account: { USD: { settled: 26_318.5, availableToTrade: 6_818.5, availableToWithdraw: 6_818.5 } }, treasury: { USD: { settled: 970_000, availableToTrade: 970_000 } } },
        nav: { account: 29_783.5, treasury: 970_000 },
        balance: { account: { cash: 26_318.5, assets: 29_783.5, netAssets: 29_783.5 }, treasury: { cash: 970_000, assets: 970_000, netAssets: 970_000 } },
        oversight: { accounts: { account: { fundingReceived: 30_000 } } },
      },
    },
    {
      id: 'cash-short-not-financed', covers: ['financing: not financed'], action: 'package', instrument: 'main', input: pc(1000, 52), strategyPage: pcPage(1000, 52),
      status: 'blocked', reason: 'The package needs 17,015.00 (premium, fees, collateral top-up and margin) and 6,818.50 is free; "Do not finance" leaves it blocked.', expect: { refused: 'Alpha is short 10,196.50 USD' },
    },
    {
      id: 'funded-from-treasury', covers: ['financing: Treasury funding'], action: 'package', as: 'funded', instrument: 'main',
      input: pc(1000, 52, { financing: { mode: 'treasury' } }), strategyPage: pcPage(1000, 52, { financing: { mode: 'treasury' } }),
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'funding', action: 'treasury_funding', qty: 10_196.5, cash: 10_196.5 }, { kind: 'borrow_sec', qty: 1000 }, { action: 'sell_short', qty: 1000, settleDate: '2026-03-04', cash: 50_000, fees: 10, dependsOn: [2, 1] }, { instrument: 'call52', qty: 10, cash: -1_000, fees: 5, dependsOn: [3, 1] }], cash: { USD: { purchases: 1_000, restrictedProceeds: 50_000, fees: 15, collateral: 1_000, margin: 15_000, financingIn: 10_196.5, required: 17_015, available: 6_818.5, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'funding', status: 'filled', filledQty: 10_196.5 }, { kind: 'borrow_sec', status: 'filled', filledQty: 1000 }, { action: 'sell_short', status: 'filled', filledQty: 1000 }, { instrument: 'call52', status: 'filled', filledQty: 10 }] },
        events: [{ type: 'strategy.submitted', summary: 'Package submitted: Protective Call KSTL (4 legs; open)' }, { type: 'transfer.funding', summary: 'Treasury funding: 10,196.50 USD from Treasury to Alpha (Funding for Protective Call KSTL)', owner: 'treasury' }, { type: 'secloan.borrow', summary: 'Borrowed 1,000 KSTL at a fee of 1.800% p.a.' }, { type: 'trade.fill', summary: 'Sold short 1,000 KSTL @ 50.00 USD' }, { type: 'trade.fill', summary: 'Bought 10 KSTL260320C52 @ 1.00 USD' }],
        // Free: 36,515 - 34,500 reserved - 1,005 owed = 1,010, the top-up and sale commission the evening mark will post.
        cash: { account: { USD: { settled: 36_515, unsettled: 48_985, receivable: 49_990, payable: 1_005, reserved: 34_500, availableToTrade: 1_010, availableToWithdraw: 1_010 } }, treasury: { USD: { settled: 959_803.5, availableToTrade: 959_803.5 } } },
        positions: [borrowed('core', 200, 10_000), borrowed('core', 1000, 50_000), borrowed('funded', 1000, 50_000), borrowed('wrapped', 100, 5_000), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'funded', 10, 1, 0.95), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 50, 61_200), pcShort('funded', -1000, 50, 0), pcShort('wrapped', -100, 50, 5_100)],
        holdings: { main: { long: 0, short: 2300, net: -2300 }, call52: { long: 10, short: 0, net: 10 } },
        pending: [{ instrument: 'call52', lot: 'funded', dueDate: '2026-03-04', amount: -1_005, into: 'cash' }, { instrument: 'main', lot: 'funded', dueDate: '2026-03-04', amount: 49_990, into: 'cash.restricted' }],
        lifecycle: [expiryItem('call50'), expiryItem('call52'), ...fee(4), expiryItem('call52apr', '2026-04-17')],
        borrowings: [secBorrow('core', 1000, 50_000, 0, 61_200), secBorrow('core', 200, 10_000, 0, 61_200), secBorrow('funded', 1000, 50_000, 0, null), secBorrow('wrapped', 100, 5_000, 0, 5_100)],
        pnl: { account: { commissions: -46.5, unrealized: -115, total: -281.5 }, book: { commissions: -46.5, unrealized: -115, total: -281.5 }, treasury: { total: 0 } },
        nav: { account: 39_915, treasury: 959_803.5, book: 999_718.5 },
        balance: {
          account: { cash: 36_515, restricted: 66_300, receivable: 49_990, positions: -111_885, payable: 1_005, assets: 40_920, liabilities: 1_005, netAssets: 39_915 },
          book: { cash: 996_318.5, restricted: 66_300, receivable: 49_990, positions: -111_885, payable: 1_005, assets: 1_000_723.5, liabilities: 1_005, netAssets: 999_718.5 },
          treasury: { cash: 959_803.5, assets: 959_803.5, netAssets: 959_803.5 },
        },
        oversight: { accountBorrowings: [oversee('core', 0), oversee('core', 0), oversee('funded', 0), oversee('wrapped', 0)], accounts: { account: { fundingReceived: 40_196.5 } } },
      },
    },
    {
      // End of Tuesday: fees on the shorts that settled today, on 50.00 (1,000 -> 2.50, 100 -> 0.25, 200 -> 0.50).
      // 'funded' is marked with its proceeds still to come: 1.02 x 1,000 x 50 = 51,000 against 49,990: 1,010 posted.
      id: 'fee-day', covers: ['borrow fee', 'collateral mark'], action: 'clock', to: MAR(3, '17:30'),
      expect: {
        events: [{ type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 2.50 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 100 KSTL: 0.25 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 200 KSTL: 0.50 USD' }, { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 1,010.00 USD', cash: { USD: -1_010 } }],
        cash: { account: { USD: { settled: 35_505, restricted: 67_310, availableToTrade: 0, availableToWithdraw: 0 } } },
        positions: [borrowed('core', 200, 10_000, -0.5), borrowed('core', 1000, 50_000, -2.5), borrowed('funded', 1000, 50_000), borrowed('wrapped', 100, 5_000, -0.25), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'funded', 10, 1, 0.95), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 50, 61_200), pcShort('funded', -1000, 50, 1_010), pcShort('wrapped', -100, 50, 5_100)],
        borrowings: [secBorrow('core', 1000, 50_000, 2.5, 61_200), secBorrow('core', 200, 10_000, 0.5, 61_200), secBorrow('funded', 1000, 50_000, 0, 1_010), secBorrow('wrapped', 100, 5_000, 0.25, 5_100)],
        oversight: { accountBorrowings: [oversee('core', 2.5), oversee('core', 0.5), oversee('funded', 0), oversee('wrapped', 0.25)] },
        pnl: { account: { borrowFunding: -3.25, total: -284.75 }, book: { borrowFunding: -3.25, total: -284.75 } },
        nav: { account: 39_911.75, book: 999_715.25 },
        balance: { account: { cash: 35_505, restricted: 67_310, accruedExpense: 3.25, liabilities: 1_008.25, netAssets: 39_911.75 }, book: { cash: 995_308.5, restricted: 67_310, accruedExpense: 3.25, liabilities: 1_008.25, netAssets: 999_715.25 } },
      },
    },
    {
      id: 'settle-funded', covers: ['settlement'], action: 'clock', to: MAR(4),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'Settlement: received 49,990.00 USD into restricted cash' }, { type: 'settlement.pay', summary: 'Settlement: paid 1,005.00 USD from settled cash', cash: { USD: -1_005 } }],
        cash: { account: { USD: { settled: 34_500, unsettled: 0, receivable: 0, payable: 0, restricted: 117_300, availableToTrade: 0, availableToWithdraw: 0 } } },
        positions: [borrowed('core', 200, 10_000, -0.5), borrowed('core', 1000, 50_000, -2.5), borrowed('funded', 1000, 50_000), borrowed('wrapped', 100, 5_000, -0.25), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'funded', 10, 1, 0.95), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 50, 61_200), pcShort('funded', -1000, 50, 51_000), pcShort('wrapped', -100, 50, 5_100)],
        pending: [],
        borrowings: [secBorrow('core', 1000, 50_000, 2.5, 61_200), secBorrow('core', 200, 10_000, 0.5, 61_200), secBorrow('funded', 1000, 50_000, 0, 51_000), secBorrow('wrapped', 100, 5_000, 0.25, 5_100)],
        balance: { account: { cash: 34_500, restricted: 117_300, receivable: null, payable: null, assets: 39_915, liabilities: 3.25 }, book: { cash: 994_303.5, restricted: 117_300, receivable: null, payable: null, assets: 999_718.5, liabilities: 3.25 } },
      },
    },
    {
      // 200 shares and 2 calls: premium 200 + fees 3 + top-up 200 + margin 3,000 = 3,403, nothing free: a margin loan of
      // 3,403 at 6% (3,403 x 0.06 / 360 = 0.567 -> 0.57 a day).
      id: 'funded-by-loan', covers: ['financing: borrow'], action: 'package', as: 'levered', instrument: 'main', contractAs: 'loan',
      input: pc(200, 52, { financing: { mode: 'loan', rateType: 'fixed', rate: 0.06 } }), strategyPage: pcPage(200, 52, { financing: { mode: 'loan', rate: 0.06 } }),
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'loan', qty: 3_403, cash: 3_403, dailyCost: 0.57, financing: { rate: 0.06, interestFrom: '2026-03-04' } }, { kind: 'borrow_sec', qty: 200 }, { action: 'sell_short', qty: 200, cash: 10_000, fees: 2, dependsOn: [2, 1] }, { instrument: 'call52', qty: 2, cash: -200, fees: 1, dependsOn: [3, 1] }], cash: { USD: { purchases: 200, restrictedProceeds: 10_000, fees: 3, collateral: 200, margin: 3_000, financingIn: 3_403, required: 3_403, available: 0, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'loan', instrument: 'loan', status: 'filled', filledQty: 3_403 }, { kind: 'borrow_sec', status: 'filled', filledQty: 200 }, { action: 'sell_short', status: 'filled', filledQty: 200 }, { instrument: 'call52', status: 'filled', filledQty: 2 }] },
        events: [{ type: 'strategy.submitted', summary: 'Package submitted: Protective Call KSTL (4 legs; open)' }, { type: 'loan.drawdown', summary: 'Borrowed 3,403.00 USD (margin, 6.000% fixed, open-ended)', cash: { USD: 3_403 } }, { type: 'secloan.borrow', summary: 'Borrowed 200 KSTL at a fee of 1.800% p.a.' }, { type: 'trade.fill', summary: 'Sold short 200 KSTL @ 50.00 USD' }, { type: 'trade.fill', summary: 'Bought 2 KSTL260320C52 @ 1.00 USD' }],
        cash: { account: { USD: { settled: 37_903, unsettled: 9_797, receivable: 9_998, payable: 201, reserved: 37_500, availableToTrade: 202, availableToWithdraw: 202, borrowed: 3_403 } } },
        positions: [borrowed('core', 200, 10_000, -0.5), borrowed('core', 1000, 50_000, -2.5), borrowed('funded', 1000, 50_000), borrowed('levered', 200, 10_000), borrowed('wrapped', 100, 5_000, -0.25), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'funded', 10, 1, 0.95), pcCall('call52', 'levered', 2, 1, 0.95), pcCall('call52apr', 'core', 12, 1.7, 1.65),
          { instrument: 'loan', lot: 'levered', owner: 'account', direction: 'borrowed', qty: -3_403, carrying: -3_403 }, pcShort('core', -1200, 50, 61_200), pcShort('funded', -1000, 50, 51_000), pcShort('levered', -200, 50, 0), pcShort('wrapped', -100, 50, 5_100)],
        holdings: { main: { long: 0, short: 2500, net: -2500 }, call52: { long: 12, short: 0, net: 12 } },
        pending: [{ instrument: 'call52', lot: 'levered', dueDate: '2026-03-05', amount: -201, into: 'cash' }, { instrument: 'main', lot: 'levered', dueDate: '2026-03-05', amount: 9_998, into: 'cash.restricted' }],
        lifecycle: [expiryItem('call50'), expiryItem('call52'), expiryItem('call52'), { type: 'loan.interest', instrument: 'loan', dueDate: '2026-04-01', status: 'pending', owner: 'account' }, ...fee(5), expiryItem('call52apr', '2026-04-17')],
        borrowings: [{ owner: 'account', family: 'loan', lot: 'levered', principal: 3_403, rate: 0.06, accrued: 0 }, secBorrow('core', 1000, 50_000, 2.5, 61_200), secBorrow('core', 200, 10_000, 0.5, 61_200), secBorrow('funded', 1000, 50_000, 0, 51_000), secBorrow('levered', 200, 10_000, 0, null), secBorrow('wrapped', 100, 5_000, 0.25, 5_100)],
        oversight: { accountBorrowings: [oversee('core', 2.5), oversee('core', 0.5), oversee('funded', 0), oversee('levered', 0, 3_403), oversee('levered', 0), oversee('wrapped', 0.25)], accounts: { account: { cashBorrowed: 3_403 } } },
        pnl: { account: { commissions: -49.5, unrealized: -125, total: -297.75 }, book: { commissions: -49.5, unrealized: -125, total: -297.75 } },
        nav: { account: 39_898.75, book: 999_702.25 },
        balance: { account: { cash: 37_903, restricted: 117_300, receivable: 9_998, positions: -121_695, payable: 201, borrowed: 3_403, assets: 43_506, liabilities: 3_607.25, netAssets: 39_898.75 }, book: { cash: 997_706.5, restricted: 117_300, receivable: 9_998, positions: -121_695, payable: 201, borrowed: 3_403, assets: 1_003_309.5, liabilities: 3_607.25, netAssets: 999_702.25 } },
      },
    },
    {
      // End of Wednesday (run on Thursday morning): fees on 50.00 for the four settled shorts; the loan drawn today has
      // no interest yet. 'levered' marked: 1.02 x 200 x 50 = 10,200 against 9,998 received: 202 posted.
      id: 'settle-levered', covers: ['settlement', 'borrow fee', 'collateral mark'], action: 'clock', to: MAR(5),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'Settlement: received 9,998.00 USD into restricted cash' }, { type: 'settlement.pay', summary: 'Settlement: paid 201.00 USD from settled cash', cash: { USD: -201 } },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 2.50 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 100 KSTL: 0.25 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 200 KSTL: 0.50 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 2.50 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 202.00 USD', cash: { USD: -202 } },
        ],
        cash: { account: { USD: { settled: 37_500, unsettled: 0, receivable: 0, payable: 0, restricted: 127_500, availableToTrade: 0, availableToWithdraw: 0 } } },
        positions: [borrowed('core', 200, 10_000, -1), borrowed('core', 1000, 50_000, -5), borrowed('funded', 1000, 50_000, -2.5), borrowed('levered', 200, 10_000), borrowed('wrapped', 100, 5_000, -0.5), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'funded', 10, 1, 0.95), pcCall('call52', 'levered', 2, 1, 0.95), pcCall('call52apr', 'core', 12, 1.7, 1.65),
          { instrument: 'loan', lot: 'levered', owner: 'account', direction: 'borrowed', qty: -3_403, carrying: -3_403 }, pcShort('core', -1200, 50, 61_200), pcShort('funded', -1000, 50, 51_000), pcShort('levered', -200, 50, 10_200), pcShort('wrapped', -100, 50, 5_100)],
        pending: [],
        borrowings: [{ owner: 'account', family: 'loan', lot: 'levered', principal: 3_403, rate: 0.06, accrued: 0 }, secBorrow('core', 1000, 50_000, 5, 61_200), secBorrow('core', 200, 10_000, 1, 61_200), secBorrow('funded', 1000, 50_000, 2.5, 51_000), secBorrow('levered', 200, 10_000, 0, 10_200), secBorrow('wrapped', 100, 5_000, 0.5, 5_100)],
        oversight: { accountBorrowings: [oversee('core', 5), oversee('core', 1), oversee('funded', 2.5), oversee('levered', 0, 3_403), oversee('levered', 0), oversee('wrapped', 0.5)] },
        pnl: { account: { borrowFunding: -9, total: -303.5 }, book: { borrowFunding: -9, total: -303.5 } },
        nav: { account: 39_893, book: 999_696.5 },
        balance: { account: { cash: 37_500, restricted: 127_500, receivable: null, payable: null, accruedExpense: 9, assets: 43_305, liabilities: 3_412, netAssets: 39_893 }, book: { cash: 997_303.5, restricted: 127_500, receivable: null, payable: null, accruedExpense: 9, assets: 1_003_108.5, liabilities: 3_412, netAssets: 999_696.5 } },
      },
    },
    {
      id: 'treasury-top-up', covers: ['transfer'], action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 100_000,
      expect: { events: [{ type: 'transfer.funding', summary: 'Treasury funding: 100,000.00 USD from Treasury to Alpha' }], cash: { account: { USD: { settled: 137_500, availableToTrade: 100_000, availableToWithdraw: 100_000 } }, treasury: { USD: { settled: 859_803.5, availableToTrade: 859_803.5 } } }, nav: { account: 139_893, treasury: 859_803.5 }, balance: { account: { cash: 137_500, assets: 143_305, netAssets: 139_893 }, treasury: { cash: 859_803.5, assets: 859_803.5, netAssets: 859_803.5 } }, oversight: { accounts: { account: { fundingReceived: 140_196.5 } } } },
    },
    {
      // Close 'levered': cover 200 at the 50.10 ask (realized -20; 10,022 paid from its restricted collateral), sell its
      // calls at 0.90 (-20), repay the loan with one day's interest (0.57) and return the borrow with its fee (one day on
      // 50.00: 0.50), paid on the full return.
      id: 'close-levered', covers: ['close', 'repay', 'return'], action: 'close', lot: 'levered', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy_to_cover', instrument: 'main', qty: 200, estimate: 50.1, cash: -10_020, fees: 2 }, { action: 'sell', instrument: 'call52', qty: 2, estimate: 0.9, cash: 180, fees: 1 }, { kind: 'repay', instrument: 'loan', qty: 3_403, cash: -3_403.57, financing: { principal: 3_403, interest: 0.57, full: true, interestThrough: '2026-03-05' } }, { kind: 'return_sec', instrument: 'borrow:main', qty: 200, dependsOn: [1] }], cash: { USD: { purchases: 10_020, proceeds: 180, fees: 3, financingOut: 3_403.57, coverCollateral: 10_022, required: 13_426.57, available: 100_000, shortfall: 0 } } },
        result: { status: 'closed', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 200, avgPrice: 50.1 }, { instrument: 'call52', status: 'filled', filledQty: 2 }, { kind: 'repay', status: 'filled' }, { kind: 'return_sec', status: 'filled', filledQty: 200 }] },
        events: [
          { type: 'strategy.legs_added', summary: 'Legs added to Protective Call KSTL (4 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 200 KSTL @ 50.10 USD (realized -20.00 USD)' }, { type: 'trade.fill', summary: 'Sold 2 KSTL260320C52 @ 0.90 USD (realized -20.00 USD)' },
          { type: 'accrual.interest', summary: ': 0.57 USD' }, { type: 'loan.repayment', summary: 'Repaid 3,403.00 USD of principal', cash: { USD: -3_403 } }, { type: 'interest.payment', summary: ': 0.57 USD', cash: { USD: -0.57 } },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 200 KSTL: 0.50 USD' }, { type: 'secloan.return', summary: 'Returned 200 borrowed KSTL' }, { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Protective Call KSTL): 0.50 USD', cash: { USD: -0.5 } },
        ],
        // 137,500 - 3,403.57 - 0.50 = 134,095.93. The cover's 10,022 settles from restricted cash; until then it is counted against free cash.
        cash: { account: { USD: { settled: 134_095.93, unsettled: -9_843, receivable: 179, payable: 10_022, reserved: 34_500, restricted: 127_500, availableToTrade: 89_752.93, availableToWithdraw: 89_573.93, borrowed: 0 } } },
        positions: [borrowed('core', 200, 10_000, -1), borrowed('core', 1000, 50_000, -5), borrowed('funded', 1000, 50_000, -2.5), borrowed('wrapped', 100, 5_000, -0.5), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'funded', 10, 1, 0.95), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 50, 61_200), pcShort('funded', -1000, 50, 51_000), pcShort('wrapped', -100, 50, 5_100)],
        holdings: { main: { long: 0, short: 2300, net: -2300 }, call52: { long: 10, short: 0, net: 10 } },
        pending: [{ instrument: 'call52', lot: 'levered', dueDate: '2026-03-06', amount: 179, into: 'cash' }, { instrument: 'main', lot: 'levered', dueDate: '2026-03-06', amount: -10_022, into: 'cash.restricted' }],
        lifecycle: [expiryItem('call50'), expiryItem('call52'), ...fee(4), expiryItem('call52apr', '2026-04-17')],
        borrowings: [secBorrow('core', 1000, 50_000, 5, 61_200), secBorrow('core', 200, 10_000, 1, 61_200), secBorrow('funded', 1000, 50_000, 2.5, 51_000), secBorrow('wrapped', 100, 5_000, 0.5, 5_100)],
        oversight: { accountBorrowings: [oversee('core', 5), oversee('core', 1), oversee('funded', 2.5), oversee('wrapped', 0.5)], accounts: { account: { cashBorrowed: 0 } } },
        pnl: { account: { realized: -160, borrowFunding: -10.07, commissions: -52.5, unrealized: -115, total: -337.57 }, book: { realized: -160, borrowFunding: -10.07, commissions: -52.5, unrealized: -115, total: -337.57 } },
        nav: { account: 139_858.93, book: 999_662.43 },
        balance: { account: { cash: 134_095.93, restricted: 127_500, receivable: 179, positions: -111_885, payable: 10_022, borrowed: null, accruedExpense: 9, assets: 149_889.93, liabilities: 10_031, netAssets: 139_858.93 }, book: { cash: 993_899.43, restricted: 127_500, receivable: 179, positions: -111_885, payable: 10_022, borrowed: null, accruedExpense: 9, assets: 1_009_693.43, liabilities: 10_031, netAssets: 999_662.43 } },
      },
    },
    {
      // The cover settles from 'levered's restricted cash (10,200 held): 178 is left over and released at the evening mark.
      id: 'settle-close-levered', covers: ['settlement', 'collateral release'], action: 'clock', to: MAR(6),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'Settlement: received 179.00 USD into settled cash', cash: { USD: 179 } }, { type: 'settlement.pay', summary: 'Settlement: paid 10,022.00 USD from restricted cash' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 2.50 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 100 KSTL: 0.25 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 200 KSTL: 0.50 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 2.50 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: released 178.00 USD', cash: { USD: 178 } },
        ],
        cash: { account: { USD: { settled: 134_452.93, unsettled: 0, receivable: 0, payable: 0, restricted: 117_300, availableToTrade: 99_952.93, availableToWithdraw: 99_952.93 } } },
        positions: [borrowed('core', 200, 10_000, -1.5), borrowed('core', 1000, 50_000, -7.5), borrowed('funded', 1000, 50_000, -5), borrowed('wrapped', 100, 5_000, -0.75), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'funded', 10, 1, 0.95), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 50, 61_200), pcShort('funded', -1000, 50, 51_000), pcShort('wrapped', -100, 50, 5_100)],
        pending: [],
        borrowings: [secBorrow('core', 1000, 50_000, 7.5, 61_200), secBorrow('core', 200, 10_000, 1.5, 61_200), secBorrow('funded', 1000, 50_000, 5, 51_000), secBorrow('wrapped', 100, 5_000, 0.75, 5_100)],
        oversight: { accountBorrowings: [oversee('core', 7.5), oversee('core', 1.5), oversee('funded', 5), oversee('wrapped', 0.75)] },
        pnl: { account: { borrowFunding: -15.82, total: -343.32 }, book: { borrowFunding: -15.82, total: -343.32 } },
        nav: { account: 139_853.18, book: 999_656.68 },
        balance: { account: { cash: 134_452.93, restricted: 117_300, receivable: null, payable: null, accruedExpense: 14.75, assets: 139_867.93, liabilities: 14.75, netAssets: 139_853.18 }, book: { cash: 994_256.43, restricted: 117_300, receivable: null, payable: null, accruedExpense: 14.75, assets: 999_671.43, liabilities: 14.75, netAssets: 999_656.68 } },
      },
    },
    {
      // Through the end of Thursday 19 March, nothing traded: 14 days of fee (6 to 19 March, ACT/360) on 50.00.
      id: 'quiet-fortnight', covers: ['borrow fee'], action: 'clock', to: MAR(19, '17:30'),
      expect: {
        events: [{ type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 35.00 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 100 KSTL: 3.50 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 200 KSTL: 7.00 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 35.00 USD' }],
        positions: [borrowed('core', 200, 10_000, -8.5), borrowed('core', 1000, 50_000, -42.5), borrowed('funded', 1000, 50_000, -40), borrowed('wrapped', 100, 5_000, -4.25), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'funded', 10, 1, 0.95), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 50, 61_200), pcShort('funded', -1000, 50, 51_000), pcShort('wrapped', -100, 50, 5_100)],
        borrowings: [secBorrow('core', 1000, 50_000, 42.5, 61_200), secBorrow('core', 200, 10_000, 8.5, 61_200), secBorrow('funded', 1000, 50_000, 40, 51_000), secBorrow('wrapped', 100, 5_000, 4.25, 5_100)],
        oversight: { accountBorrowings: [oversee('core', 42.5), oversee('core', 8.5), oversee('funded', 40), oversee('wrapped', 4.25)] },
        pnl: { account: { borrowFunding: -96.32, total: -423.82 }, book: { borrowFunding: -96.32, total: -423.82 } },
        nav: { account: 139_772.68, book: 999_576.18 },
        balance: { account: { accruedExpense: 95.25, liabilities: 95.25, netAssets: 139_772.68 }, book: { accruedExpense: 95.25, liabilities: 95.25, netAssets: 999_576.18 } },
      },
    },
    { id: 'expiry-close', action: 'close_price', instrument: 'main', date: '2026-03-20', value: 51, expect: {} },
    {
      id: 'expiry-quote', action: 'quote', instrument: 'main', quote: { bid: 51.00, ask: 51.10, last: 51.00, bidSize: 10000, askSize: 10000 },
      expect: {
        positions: [borrowed('core', 200, 10_200, -8.5), borrowed('core', 1000, 51_000, -42.5), borrowed('funded', 1000, 51_000, -40), borrowed('wrapped', 100, 5_100, -4.25), pcCall('call50', 'wrapped', 1, 1.9, 1.85), pcCall('call52', 'funded', 10, 1, 0.95), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 51, 61_200), pcShort('funded', -1000, 51, 51_000), pcShort('wrapped', -100, 51, 5_100)],
        borrowings: [secBorrow('core', 1000, 51_000, 42.5, 61_200), secBorrow('core', 200, 10_200, 8.5, 61_200), secBorrow('funded', 1000, 51_000, 40, 51_000), secBorrow('wrapped', 100, 5_100, 4.25, 5_100)],
        pnl: { account: { unrealized: -2_415, total: -2_723.82 }, book: { unrealized: -2_415, total: -2_723.82 } },
        nav: { account: 137_472.68, book: 997_276.18 },
        balance: { account: { positions: -114_185, assets: 137_567.93, netAssets: 137_472.68 }, book: { positions: -114_185, assets: 997_371.43, netAssets: 997_276.18 } },
      },
    },
    {
      // Expiration, close 51.00. The 50 call of 'wrapped' is in the money and is exercised: 100 shares received at 50
      // cover its short (5,000 from its restricted cash on Monday; realized 100 x (50 - 50) = 0 on the short, -190 on the
      // call), and the borrow they free goes back with its fee (0.25 x 3 + 3.50 + one day on 51.00, 0.255 -> 0.26: 4.51).
      // The 10 March calls of 'funded' (strike 52) lapse: -1,000. The day's fees on 51.00: 2.55, 0.51, 2.55. Marks:
      // core 1.02 x 1,200 x 51 = 62,424 (1,224 posted); 'wrapped' keeps the 5,000 it owes (100 released); 'funded'
      // 52,020 (1,020 posted). Margin reserve at 51.00: 0.30 x (1,200 + 1,000) x 51 = 33,660.
      id: 'expiry', covers: ['expiry', 'exercise', 'lapse', 'return'], action: 'clock', to: MAR(20, '17:30'),
      expect: {
        events: [
          { type: 'option.exercised', summary: 'Exercised: 1 KSTL260320C50 at strike 50', date: '2026-03-20' },
          { type: 'option.delivery', summary: 'Simulated delivery: received 100 KSTL at strike 50 on exercise of KSTL260320C50' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 100 KSTL: 0.26 USD' }, { type: 'secloan.return', summary: 'Returned 100 borrowed KSTL' }, { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Protective Call KSTL): 4.51 USD', cash: { USD: -4.51 } },
          { type: 'option.expired', summary: 'Expired worthless: 10 KSTL260320C52 (fixing 51)' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 2.55 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 200 KSTL: 0.51 USD' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 2.55 USD' },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 1,224.00 USD', cash: { USD: -1_224 } },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: released 100.00 USD', cash: { USD: 100 } },
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: posted 1,020.00 USD', cash: { USD: -1_020 } },
        ],
        cash: { account: { USD: { settled: 132_304.42, unsettled: -5_000, payable: 5_000, reserved: 33_660, restricted: 119_444, availableToTrade: 93_644.42, availableToWithdraw: 93_644.42 } } },
        positions: [borrowed('core', 200, 10_200, -9.01), borrowed('core', 1000, 51_000, -45.05), borrowed('funded', 1000, 51_000, -42.55), pcCall('call52apr', 'core', 12, 1.7, 1.65), pcShort('core', -1200, 51, 62_424), pcShort('funded', -1000, 51, 52_020)],
        holdings: { main: { long: 0, short: 2200, net: -2200 }, call50: null, call52: null },
        pending: [{ instrument: 'main', lot: 'wrapped', dueDate: '2026-03-23', amount: -5_000, into: 'cash.restricted' }],
        lifecycle: [...fee(3), expiryItem('call52apr', '2026-04-17')],
        borrowings: [secBorrow('core', 1000, 51_000, 45.05, 62_424), secBorrow('core', 200, 10_200, 9.01, 62_424), secBorrow('funded', 1000, 51_000, 42.55, 52_020)],
        oversight: { accountBorrowings: [oversee('core', 45.05), oversee('core', 9.01), oversee('funded', 42.55)] },
        pnl: { account: { realized: -1_350, borrowFunding: -102.19, unrealized: -2_260, total: -3_764.69 }, book: { realized: -1_350, borrowFunding: -102.19, unrealized: -2_260, total: -3_764.69 } },
        nav: { account: 136_431.81, book: 996_234.31 },
        balance: { account: { cash: 132_304.42, restricted: 119_444, positions: -110_220, payable: 5_000, accruedExpense: 96.61, assets: 141_528.42, liabilities: 5_096.61, netAssets: 136_431.81 }, book: { cash: 992_107.92, restricted: 119_444, positions: -110_220, payable: 5_000, accruedExpense: 96.61, assets: 1_001_331.92, liabilities: 5_096.61, netAssets: 996_234.31 } },
        alerts: ['hedge.review', 'hedge.review'], // 'core' (retried) and 'funded' (its protection lapsed)
      },
    },
    { id: 'after-expiry-wrapped', covers: ['package state after expiry'], action: 'strategy_check', lot: 'wrapped', expect: { result: { status: 'closed', orders: [{ kind: 'link', status: 'filled', filledQty: 100 }, { instrument: 'call50', status: 'filled', filledQty: 1 }] } } },
    {
      id: 'settle-expiry', covers: ['settlement'], action: 'clock', to: MAR(23),
      expect: { events: [{ type: 'settlement.pay', summary: 'Settlement: paid 5,000.00 USD from restricted cash' }], cash: { account: { USD: { unsettled: 0, payable: 0, restricted: 114_444, availableToTrade: 98_644.42, availableToWithdraw: 98_644.42 } } }, pending: [], balance: { account: { restricted: 114_444, payable: null, assets: 136_528.42, liabilities: 96.61 }, book: { restricted: 114_444, payable: null, assets: 996_331.92, liabilities: 96.61 } } },
    },
    {
      // Half of 'core': cover 600 at 51.10 (realized 600 x (50 - 51.10) = -660), sell 6 April calls at 1.60 (-60), and
      // return half of each borrow (500 of 1,000, 100 of 200), their fee accrued to today (3 days on 51.00) but not yet paid.
      id: 'close-share', covers: ['reduce', 'close share', 'return'], action: 'close', lot: 'core', scope: 'strategy', percent: 50,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy_to_cover', instrument: 'main', qty: 600, estimate: 51.1, settleDate: '2026-03-24', cash: -30_660, fees: 6 }, { action: 'sell', instrument: 'call52apr', qty: 6, estimate: 1.6, cash: 960, fees: 3 }, { kind: 'return_sec', qty: 500, dependsOn: [1] }, { kind: 'return_sec', qty: 100, dependsOn: [1] }], cash: { USD: { purchases: 30_660, proceeds: 960, fees: 9, coverCollateral: 30_666, required: 30_669, available: 98_644.42, shortfall: 0 } } },
        result: { status: 'open', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 600 }, { instrument: 'call52apr', status: 'filled', filledQty: 6 }, { kind: 'return_sec', status: 'filled', filledQty: 500 }, { kind: 'return_sec', status: 'filled', filledQty: 100 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Call KSTL (4 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 600 KSTL @ 51.10 USD (realized -660.00 USD)' }, { type: 'trade.fill', summary: 'Sold 6 KSTL260417C52 @ 1.60 USD (realized -60.00 USD)' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 7.65 USD' }, { type: 'secloan.return', summary: 'Returned 500 borrowed KSTL' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 200 KSTL: 1.53 USD' }, { type: 'secloan.return', summary: 'Returned 100 borrowed KSTL' }],
        cash: { account: { USD: { unsettled: -29_709, receivable: 957, payable: 30_666, reserved: 24_480, availableToTrade: 78_115.42, availableToWithdraw: 77_158.42 } } },
        positions: [borrowed('core', 100, 5_100, -10.54), borrowed('core', 500, 25_500, -52.7), borrowed('funded', 1000, 51_000, -42.55), pcCall('call52apr', 'core', 6, 1.7, 1.65), pcShort('core', -600, 51, 62_424), pcShort('funded', -1000, 51, 52_020)],
        holdings: { main: { long: 0, short: 1600, net: -1600 }, call52apr: { long: 6, short: 0, net: 6 } },
        pending: [{ instrument: 'call52apr', lot: 'core', dueDate: '2026-03-24', amount: 957, into: 'cash' }, { instrument: 'main', lot: 'core', dueDate: '2026-03-24', amount: -30_666, into: 'cash.restricted' }],
        borrowings: [secBorrow('core', 500, 25_500, 52.7, 62_424), secBorrow('core', 100, 5_100, 10.54, 62_424), secBorrow('funded', 1000, 51_000, 42.55, 52_020)],
        oversight: { accountBorrowings: [oversee('core', 52.7), oversee('core', 10.54), oversee('funded', 42.55)] },
        pnl: { account: { realized: -2_070, commissions: -61.5, borrowFunding: -111.37, unrealized: -1_630, total: -3_872.87 }, book: { realized: -2_070, commissions: -61.5, borrowFunding: -111.37, unrealized: -1_630, total: -3_872.87 } },
        nav: { account: 136_323.63, book: 996_126.13 },
        balance: { account: { receivable: 957, positions: -80_610, payable: 30_666, accruedExpense: 105.79, assets: 167_095.42, liabilities: 30_771.79, netAssets: 136_323.63 }, book: { receivable: 957, positions: -80_610, payable: 30_666, accruedExpense: 105.79, assets: 1_026_898.92, liabilities: 30_771.79, netAssets: 996_126.13 } },
      },
    },
    {
      id: 'close-exact', covers: ['reduce', 'close exact amount', 'return'], action: 'close', lot: 'core', instrument: 'main', qty: 200,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy_to_cover', instrument: 'main', qty: 200, cash: -10_220, fees: 2 }, { kind: 'return_sec', qty: 200, dependsOn: [1] }], cash: { USD: { purchases: 10_220, fees: 2, coverCollateral: 10_222, required: 10_222, available: 78_115.42 } } },
        result: { status: 'open', orders: [{ action: 'buy_to_cover', status: 'filled', filledQty: 200 }, { kind: 'return_sec', status: 'filled', filledQty: 200 }] },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Call KSTL (2 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 200 KSTL @ 51.10 USD (realized -220.00 USD)' }, { type: 'secloan.return', summary: 'Returned 200 borrowed KSTL' }],
        cash: { account: { USD: { unsettled: -39_931, payable: 40_888, reserved: 21_420, availableToTrade: 70_953.42, availableToWithdraw: 69_996.42 } } },
        positions: [borrowed('core', 100, 5_100, -10.54), borrowed('core', 300, 15_300, -52.7), borrowed('funded', 1000, 51_000, -42.55), pcCall('call52apr', 'core', 6, 1.7, 1.65), pcShort('core', -400, 51, 62_424), pcShort('funded', -1000, 51, 52_020)],
        holdings: { main: { long: 0, short: 1400, net: -1400 } },
        pending: [{ instrument: 'call52apr', lot: 'core', amount: 957 }, { instrument: 'main', lot: 'core', amount: -30_666 }, { instrument: 'main', lot: 'core', dueDate: '2026-03-24', amount: -10_222, into: 'cash.restricted' }],
        borrowings: [secBorrow('core', 300, 15_300, 52.7, 62_424), secBorrow('core', 100, 5_100, 10.54, 62_424), secBorrow('funded', 1000, 51_000, 42.55, 52_020)],
        pnl: { account: { realized: -2_290, commissions: -63.5, unrealized: -1_430, total: -3_894.87 }, book: { realized: -2_290, commissions: -63.5, unrealized: -1_430, total: -3_894.87 } },
        nav: { account: 136_301.63, book: 996_104.13 },
        balance: { account: { positions: -70_410, payable: 40_888, assets: 177_295.42, liabilities: 40_993.79, netAssets: 136_301.63 }, book: { positions: -70_410, payable: 40_888, assets: 1_037_098.92, liabilities: 40_993.79, netAssets: 996_104.13 } },
      },
    },
    {
      // The rest of 'core': cover 400 (-440), sell 6 calls (-60), return both borrows in full and pay their fees
      // (1,000 record: 2.50 x 3 + 35 + 2.55 + 7.65 = 52.70; 200 record: 0.50 x 3 + 7 + 0.51 + 1.53 = 10.54).
      id: 'close-all', covers: ['close', 'return', 'borrow fee'], action: 'close', lot: 'core', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy_to_cover', instrument: 'main', qty: 400, cash: -20_440, fees: 4 }, { action: 'sell', instrument: 'call52apr', qty: 6, cash: 960, fees: 3 }, { kind: 'return_sec', qty: 300, dependsOn: [1] }, { kind: 'return_sec', qty: 100, dependsOn: [1] }], cash: { USD: { purchases: 20_440, proceeds: 960, fees: 7, coverCollateral: 20_444, required: 20_447, available: 70_953.42 } } },
        result: { status: 'closed' },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Call KSTL (4 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 400 KSTL @ 51.10 USD (realized -440.00 USD)' }, { type: 'trade.fill', summary: 'Sold 6 KSTL260417C52 @ 1.60 USD (realized -60.00 USD)' }, { type: 'secloan.return', summary: 'Returned 300 borrowed KSTL' }, { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Protective Call KSTL): 52.70 USD', cash: { USD: -52.7 } }, { type: 'secloan.return', summary: 'Returned 100 borrowed KSTL' }, { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Protective Call KSTL): 10.54 USD', cash: { USD: -10.54 } }],
        cash: { account: { USD: { settled: 132_241.18, unsettled: -59_418, receivable: 1_914, payable: 61_332, reserved: 15_300, availableToTrade: 57_523.18, availableToWithdraw: 55_609.18 } } },
        positions: [borrowed('funded', 1000, 51_000, -42.55), pcShort('funded', -1000, 51, 52_020)],
        holdings: { main: { long: 0, short: 1000, net: -1000 }, call52apr: null },
        pending: [{ instrument: 'call52apr', lot: 'core', amount: 957 }, { instrument: 'call52apr', lot: 'core', dueDate: '2026-03-24', amount: 957, into: 'cash' }, { instrument: 'main', lot: 'core', amount: -30_666 }, { instrument: 'main', lot: 'core', dueDate: '2026-03-24', amount: -20_444, into: 'cash.restricted' }, { instrument: 'main', lot: 'core', amount: -10_222 }],
        lifecycle: fee(1),
        borrowings: [secBorrow('funded', 1000, 51_000, 42.55, 52_020)], oversight: { accountBorrowings: [oversee('funded', 42.55)] },
        pnl: { account: { realized: -2_790, commissions: -70.5, unrealized: -1_000, total: -3_971.87 }, book: { realized: -2_790, commissions: -70.5, unrealized: -1_000, total: -3_971.87 } },
        nav: { account: 136_224.63, book: 996_028.13 },
        balance: { account: { cash: 132_241.18, receivable: 1_914, positions: -51_000, payable: 61_332, accruedExpense: 42.55, assets: 197_599.18, liabilities: 61_374.55, netAssets: 136_224.63 }, book: { cash: 992_044.68, receivable: 1_914, positions: -51_000, payable: 61_332, accruedExpense: 42.55, assets: 1_057_402.68, liabilities: 61_374.55, netAssets: 996_028.13 } },
        alerts: ['hedge.review'],
      },
    },
    {
      // 'funded': cover 1,000 (-1,100) and return its borrow; fee 42.55 + 3 days on 51.00 (7.65) = 50.20, paid.
      id: 'close-funded', covers: ['close', 'return', 'borrow fee'], action: 'close', lot: 'funded', scope: 'strategy',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'buy_to_cover', instrument: 'main', qty: 1000, cash: -51_100, fees: 10 }, { kind: 'return_sec', qty: 1000, dependsOn: [1] }], cash: { USD: { purchases: 51_100, fees: 10, coverCollateral: 51_110, required: 51_110, available: 57_523.18 } } },
        result: { status: 'closed' },
        events: [{ type: 'strategy.legs_added', summary: 'Legs added to Protective Call KSTL (2 legs; close)' }, { type: 'trade.fill', summary: 'Bought to cover 1,000 KSTL @ 51.10 USD (realized -1,100.00 USD)' }, { type: 'accrual.fee', summary: 'Borrow fee accrued on 1,000 KSTL: 7.65 USD' }, { type: 'secloan.return', summary: 'Returned 1,000 borrowed KSTL' }, { type: 'interest.payment', summary: 'Borrow fee paid on Borrow of KSTL (Protective Call KSTL): 50.20 USD', cash: { USD: -50.2 } }],
        cash: { account: { USD: { settled: 132_191.98, unsettled: -110_528, payable: 112_442, reserved: 0, availableToTrade: 21_663.98, availableToWithdraw: 19_749.98 } } },
        positions: [], holdings: { main: null },
        pending: [{ instrument: 'call52apr', lot: 'core', amount: 957 }, { instrument: 'call52apr', lot: 'core', amount: 957 }, { instrument: 'main', lot: 'funded', dueDate: '2026-03-24', amount: -51_110, into: 'cash.restricted' }, { instrument: 'main', lot: 'core', amount: -30_666 }, { instrument: 'main', lot: 'core', amount: -20_444 }, { instrument: 'main', lot: 'core', amount: -10_222 }],
        lifecycle: [], borrowings: [], oversight: { accountBorrowings: [] },
        pnl: { account: { realized: -3_890, commissions: -80.5, borrowFunding: -119.02, unrealized: 0, total: -4_089.52 }, book: { realized: -3_890, commissions: -80.5, borrowFunding: -119.02, unrealized: 0, total: -4_089.52 } },
        nav: { account: 136_106.98, book: 995_910.48 },
        balance: { account: { cash: 132_191.98, positions: null, payable: 112_442, accruedExpense: null, assets: 248_548.98, liabilities: 112_442, netAssets: 136_106.98 }, book: { cash: 991_995.48, positions: null, payable: 112_442, accruedExpense: null, assets: 1_108_352.48, liabilities: 112_442, netAssets: 995_910.48 } },
        alerts: [],
      },
    },
    {
      // The covers settle from restricted cash and what is left is released at the evening mark: core 62,424 - 61,332 =
      // 1,092; funded 52,020 - 51,110 = 910. Nothing held, reserved, borrowed or scheduled. Whole scenario: realized
      // -3,890 (covers -2,440, calls -1,450); commissions 80.50; borrow fees 118.45 and loan interest 0.57.
      id: 'settle-closes', covers: ['settlement', 'collateral release'], action: 'clock', to: MAR(24),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'Settlement: received 957.00 USD into settled cash', cash: { USD: 957 } }, { type: 'settlement.receive', summary: 'Settlement: received 957.00 USD into settled cash', cash: { USD: 957 } },
          ...[30_666, 10_222, 20_444, 51_110].map((x) => ({ type: 'settlement.pay', summary: `Settlement: paid ${x.toLocaleString('en-US')}.00 USD from restricted cash` })),
          { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: released 1,092.00 USD', cash: { USD: 1_092 } }, { type: 'collateral.mark', summary: 'Short collateral on KSTL marked to market: released 910.00 USD', cash: { USD: 910 } },
        ],
        cash: { account: { USD: { settled: 136_106.98, unsettled: 0, receivable: 0, payable: 0, reserved: 0, restricted: 0, availableToTrade: 136_106.98, availableToWithdraw: 136_106.98 } }, treasury: { USD: { settled: 859_803.5 } } },
        pending: [], openOrders: [], lifecycle: [], borrowings: [],
        nav: { account: 136_106.98, treasury: 859_803.5, book: 995_910.48 },
        balance: { account: { cash: 136_106.98, restricted: null, receivable: null, payable: null, assets: 136_106.98, liabilities: 0, netAssets: 136_106.98 }, book: { cash: 995_910.48, restricted: null, receivable: null, payable: null, assets: 995_910.48, liabilities: 0, netAssets: 995_910.48 } },
      },
    },
  ],
};

export default [longTemplate, shortTemplate, protectivePut, protectiveCall];
