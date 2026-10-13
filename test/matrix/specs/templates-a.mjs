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

export default [longTemplate];
