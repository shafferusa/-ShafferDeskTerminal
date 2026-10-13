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
      id: 'hedge-request', covers: ['hedge request'], action: 'hedge_request',
      input: pageInput('long', { quantity: 1500, ...CONTEXT, hedgeRatio: undefined }),
      strategyPage: { ...PAGE_CONTEXT, template: 'Long', underlying: 'main', quantity: 1500 },
      expect: { result: {} },
    },
    {
      id: 'cash-short-not-financed', covers: ['financing: not financed'], action: 'package', instrument: 'main',
      input: pageInput('long', { quantity: 5000, hedgeRatio: undefined }),
      strategyPage: { template: 'Long', underlying: 'main', quantity: 5000 },
      status: 'blocked', reason: 'The package needs 250,300.00 and the Account has 200,000.00; "Do not finance" leaves it blocked.',
      expect: { refused: 'Alpha is short 50,300.00 USD' },
    },
    {
      id: 'open-partial', covers: ['open', 'partial fill'], action: 'package', as: 'core', instrument: 'main',
      input: pageInput('long', { quantity: 1500, hedgeRatio: undefined }),
      strategyPage: { template: 'Long', underlying: 'main', quantity: 1500 },
      expect: {},
    },
    { id: 'cancel-remainder', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'core', expect: {} },
    { id: 'retry', covers: ['retry'], action: 'recover', how: 'retry', lot: 'core', expect: {} },
    { id: 'thin-book', action: 'quote', instrument: 'main', quote: { bid: 49.95, ask: 50.05, last: 50.00, bidSize: 100, askSize: 100 }, expect: {} },
    { id: 'kept-partial', covers: ['partial fill'], action: 'package', as: 'kept', instrument: 'main', input: pageInput('long', { quantity: 400, hedgeRatio: undefined }), strategyPage: { template: 'Long', underlying: 'main', quantity: 400 }, expect: {} },
    { id: 'cancel-kept', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'kept', expect: {} },
    { id: 'accept-kept', covers: ['accept as it stands'], action: 'strategy_action', how: 'accept', lot: 'kept', expect: {} },
    { id: 'unwound-partial', covers: ['partial fill'], action: 'package', as: 'unwound', instrument: 'main', input: pageInput('long', { quantity: 400, hedgeRatio: undefined }), strategyPage: { template: 'Long', underlying: 'main', quantity: 400 }, expect: {} },
    { id: 'cancel-unwound', covers: ['cancel working legs', 'needs attention'], action: 'strategy_action', how: 'cancel_working', lot: 'unwound', expect: {} },
    { id: 'unwind', covers: ['unwind'], action: 'recover', how: 'unwind', lot: 'unwound', expect: {} },
    { id: 'deep-book', action: 'quote', instrument: 'main', quote: { bid: 49.95, ask: 50.05, last: 50.00, bidSize: 10000, askSize: 10000 }, expect: {} },
    { id: 'resize-up', covers: ['resize', 'increase'], action: 'resize', lot: 'core', factor: 1.2, expect: {} },
    { id: 'roll-refused', covers: ['roll'], action: 'roll', lot: 'core', newExpiration: '2026-04-17', status: 'unsupported', reason: 'A long holding of shares has no option or futures position to roll.', expect: { refused: { engine: 'Choose option or futures positions to roll', api: 'Choose option or futures positions to roll', browser: 'offers no Roll' } } },
    { id: 'funded-from-treasury', covers: ['financing: Treasury funding'], action: 'package', as: 'funded', instrument: 'main', input: pageInput('long', { quantity: 2000, hedgeRatio: undefined, financing: { mode: 'treasury' } }), strategyPage: { template: 'Long', underlying: 'main', quantity: 2000, financing: { mode: 'treasury' } }, expect: {} },
    { id: 'funded-by-loan', covers: ['financing: borrow'], action: 'package', as: 'levered', instrument: 'main', contractAs: 'loan', input: pageInput('long', { quantity: 600, hedgeRatio: undefined, financing: { mode: 'loan', rateType: 'fixed', rate: 0.06 } }), strategyPage: { template: 'Long', underlying: 'main', quantity: 600, financing: { mode: 'loan', rate: 0.06 } }, expect: {} },
    { id: 'next-day', covers: ['settlement', 'loan interest'], action: 'clock', to: MAR(3), expect: {} },
    { id: 'price-up', action: 'quote', instrument: 'main', quote: { bid: 51.95, ask: 52.05, last: 52.00, bidSize: 10000, askSize: 10000 }, expect: {} },
    { id: 'close-share', covers: ['reduce', 'close share'], action: 'close', lot: 'core', scope: 'strategy', percent: 50, expect: {} },
    { id: 'close-exact', covers: ['reduce', 'close exact amount'], action: 'close', lot: 'core', instrument: 'main', qty: 300, expect: {} },
    { id: 'close-all', covers: ['close'], action: 'close', lot: 'core', scope: 'strategy', expect: {} },
    { id: 'close-levered', covers: ['close'], action: 'close', lot: 'levered', scope: 'strategy', expect: {} },
    { id: 'close-funded', covers: ['close'], action: 'close', lot: 'funded', scope: 'strategy', expect: {} },
    { id: 'close-kept', covers: ['close'], action: 'close', lot: 'kept', scope: 'strategy', expect: {} },
    { id: 'settle-sales', covers: ['settlement', 'loan interest'], action: 'clock', to: MAR(4), expect: {} },
    { id: 'repay-loan', covers: ['repay'], action: 'repay', lot: 'levered', instrument: 'loan', expect: {} },
  ],
};

export default [longTemplate];
