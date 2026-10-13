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

export default [longTemplate, shortTemplate];
