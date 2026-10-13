// Repo family (engine family "repo"): repos and reverse repos, eleven catalog products, one scenario each.
//
// None of these is a registry instrument. Each contract is entered on the Treasury page's "Repo or reverse repo"
// ticket (New repo or reverse repo), for Treasury or for an Account, and registers itself when the ticket is
// confirmed. The collateral is a registered security: a repo pledges a position the borrower holds; a reverse repo
// names the security it receives.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The arithmetic is in the
// comment beside it. Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be followed):
//   - The cash principal is entered on the ticket. It may not exceed what the collateral supports: its value today
//     less the haircut. A debt security is valued dirty: face x clean price / 100, plus the interest accrued to the
//     repo's start date on its own day count. The figures are rounded to the cent at each stage.
//   - A repo is settled cash at once (borrowed by the repo party, a liability; lent by the reverse repo party, an
//     asset) and starts on the day it is confirmed. A repo's collateral stays on the borrower's balance sheet, at
//     market value, pledged: it cannot be sold or lent until the repo is repurchased. A reverse repo's collateral is
//     held, not owned: it is never a position of the holder and never on its balance sheet.
//   - Repo interest is simple money-market interest: principal x rate x days / 360 (ACT/360) or / 365 (ACT/365),
//     recognised at the end-of-day run, the running figure kept unrounded and the ledger trued up to its rounded
//     value. It is paid with the principal at the repurchase (end date, or on demand for an open repo).
//   - A repurchase or termination is for the whole principal; an end date is moved to the next business day of the
//     currency's payment calendar.
//   - Each day the cover is checked: collateral value less the haircut against principal and interest owed. A
//     shortfall is flagged; margin calls, returns of excess and substitutions are not simulated.
//   - A bond holding accrues its coupon daily at the end-of-day run ("Coupon and interest income").
//   - 2026: US clocks move to daylight time on 8 March (10:00 New York is 14:00 UTC from 9 March).

export const family = 'repo';

const dst = (d) => d >= '2026-03-08' && d < '2026-11-01';
const AT_1000 = (d) => `${d}T${dst(d) ? '14' : '15'}:00:00.000Z`;
const AT_1730 = (d) => `${d}T${dst(d) ? '21' : '22'}:30:00.000Z`; // after the 17:00 end-of-day cutoff

const FILL = { halfSpreadBps: { equity: 2, bond: 3 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };

/** The contract a repo ticket sends: what web/views/treasury.js builds from its form (draftToContract). */
const contract = (productId, name, ccy, terms) => ({ productId, name, marketView: ccy === 'USD' ? 'US_CASH' : 'FOREIGN_CASH', venueType: 'otc', tradingCcy: ccy, tags: [], externalIds: {}, terms });

/**
 * A step that opens a repo or reverse repo from the "Repo or reverse repo" ticket.
 *   o: { owner, side: 'repo' | 'reverse_repo', productId, productLabel, ccy, principal, name, collateral: { instrument, lot }, terms, as }
 * `ticket` is what the browser driver fills in; `input` is the request that ticket sends (engine and API levels).
 */
const repoTicket = (id, o, rest) => ({
  id, action: 'ticket', owner: o.owner, as: o.as, contractAs: o.as,
  ticket: { kind: 'repo', side: o.side, productId: o.productId, productLabel: o.productLabel, ccy: o.ccy, principal: o.principal, name: o.name, collateral: o.collateral || null, terms: o.terms },
  input: { template: 'custom', name: o.name, legs: [{ kind: 'repo_open', action: o.side, purpose: 'financing', qty: o.principal, contract: contract(o.productId, o.name, o.ccy, o.terms),
    ...(o.side === 'repo' ? { collateralPositionId: `$pos:${o.collateral.lot}:${o.collateral.instrument}` } : {}) }] },
  ...rest,
});

const REPO_TICKET = {
  ticket: 'Treasury page, Borrowings and lending, "New repo or reverse repo": the Repo or reverse repo ticket (borrower or lender, side, product, collateral position or security, currency, cash principal, terms), then the trade preview; Set rate and Repurchase (or Terminate) on the row of the open repo',
  requiredFields: ['Borrower or Lender (Treasury or an Account)', 'Side (repo or reverse repo)', 'Product', 'Collateral position (repo) or Collateral security (reverse repo)', 'Collateral quantity', 'Haircut', 'Currency', 'Cash principal', 'Repo rate (fixed: the rate; floating: reference rate code and spread)', 'Day count', 'Term (overnight, term with its end date, open)'],
};
const BOND_TICKET_NOTE = 'Instrument drawer, Trade tab: the security ticket for the bond holding pledged';

// ---------------------------------------------------------------------------------------------
// repo
// ---------------------------------------------------------------------------------------------
// An Account buys 2,000,000 face of a 5% corporate note and repos it for two weeks: the cash raised is the dirty value
// of the notes less a 2% haircut, and asking for more is refused. The pledged notes stay on the Account's balance
// sheet and keep accruing their coupon, but cannot be sold. On the end date the repo is repurchased automatically:
// principal and 14 days of repo interest, and the notes are released.
//
// Inputs: OSTR 5% notes, 30/360, coupons 15 March and 15 September, quoted 98.40 bid / 98.60 ask, last 98.50 (fixture);
// no commission; T+1. Repo at 4.40% ACT/360 with a 2% haircut, 18 March to 1 April 2026.
//   Coupon: 2,000,000 x 0.05 / 360 = 277.777778 a day (30/360). Purchase settles 18 March: 3 days accrued, 833.33.
//   Collateral on 18 March: clean 2,000,000 x 98.50 / 100 = 1,970,000.00, plus 833.33 accrued: 1,970,833.33.
//   Most it supports: 1,970,833.33 x 0.98 = 1,931,416.6634 -> 1,931,416.66, which is borrowed.
//   Repo interest: 1,931,416.66 x 0.044 / 360 = 236.062036 a day; 14 days: 3,304.8685 -> 3,304.87.
const OSTR = { productId: 'corporate_bond', name: 'Ostrander Rail Corp 5.00% Notes 15-Sep-2030', symbol: 'OSTR-5-SEP30', marketView: 'US_CASH', venueType: 'otc', issuer: 'Ostrander Rail Corp', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
  terms: { couponType: 'fixed', couponRate: 0.05, frequency: 2, maturity: '2030-09-15', issueDate: '2025-09-15', dayCount: '30/360', redemption: 100, minDenomination: 1_000, seniority: 'Senior unsecured' } };
const REPO_TERMS = { collateralInstrumentId: '$inst:bond', collateralQty: 2_000_000, haircut: 0.02, rateType: 'fixed', rate: 0.044, dayCount: 'ACT/360', term: 'term', endDate: '2026-04-01', style: 'classic', collateralType: 'gc', triparty: false, counterparty: 'Kittering Securities' };
const REPO = { owner: 'account', side: 'repo', productId: 'repo', productLabel: 'Repo', ccy: 'USD', principal: 1_931_416.66, name: 'Ostrander notes repo', collateral: { instrument: 'bond', lot: 'bonds' }, as: 'repo', terms: REPO_TERMS };
const BOND_LIFECYCLE = [{ type: 'bond.coupon', instrument: 'bond', dueDate: '2026-09-15', status: 'pending', owner: 'account' }, { type: 'bond.maturity', instrument: 'bond', dueDate: '2030-09-16', status: 'pending', owner: 'account' }]; // 15 Sep 2030 is a Sunday

const repo = {
  productId: 'repo',
  title: 'Two-week repo of 2,000,000 Ostrander Rail 5% notes by an Account with Kittering Securities: cash = dirty value less a 2% haircut, 4.40% ACT/360, repurchased on the end date',
  matrix: {
    ...REPO_TICKET,
    automaticInputs: ['the collateral\'s dirty value on the start date (price fixture plus accrued interest from the registered coupon terms)', 'the most cash it supports after the haircut (a larger principal is refused)', 'repo interest accrued daily at the end-of-day run', 'repurchase on the end date: principal and interest paid, the collateral released', 'the daily check of the cover'],
    manualInputs: ['every term of the repo, entered on the ticket (counterparty, haircut, rate, end date)', 'the cash principal, entered on the ticket (at most the collateral value less the haircut)'],
    settlement: 'None for the repo: cash is received on the day it is confirmed and paid back on the end date. The bond bought to pledge settles T+1',
    lifecycle: 'Interest accrues daily; on the end date the repo is repurchased automatically with interest and the collateral released; the pledged notes keep accruing their coupon for the Account',
    accounting: 'Cash borrowed is a liability of the Account; repo interest is a funding expense; the pledged notes stay on the Account\'s balance sheet at market value with their accrued coupon',
    collateral: 'The notes are pledged for the whole term: not sellable or lendable; released on repurchase. Cover checked daily (margin calls not simulated)',
  },
  tradedOn: 'A repo is not a registry instrument: it is entered on the Repo or reverse repo ticket of the Treasury page (for the Account) and registers itself when the ticket is confirmed. The collateral is a registered corporate bond.',
  start: AT_1000('2026-03-17'), // Tuesday 17 March 2026, 10:00 New York
  book: {
    name: 'Matrix repo', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 2_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { bond: 1 } },
  },
  instruments: { bond: OSTR },
  quotes: { bond: { bid: 98.40, ask: 98.60, last: 98.50, bidSize: 10_000_000, askSize: 10_000_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 2_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 2_000_000, availableToWithdraw: 2_000_000, borrowed: 0, lent: 0 } },
      treasury: { USD: { settled: 1_000_000, availableToTrade: 1_000_000, availableToWithdraw: 1_000_000, borrowed: 0, lent: 0 } },
    },
    positions: [], holdings: {}, pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 2_000_000, treasury: 1_000_000, book: 3_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
    pnl: { account: { realized: 0, couponInterest: 0, borrowFunding: 0, unrealized: 0, total: 0 }, book: { total: 0 } },
    balance: { account: { cash: 2_000_000, assets: 2_000_000, liabilities: 0, netAssets: 2_000_000 }, book: { cash: 3_000_000, assets: 3_000_000, netAssets: 3_000_000 } },
    oversight: { accountBorrowings: [], treasuryOwn: [] },
  },
  steps: [
    {
      id: 'buy-the-notes', covers: 'collateral', action: 'ticket', ticketOf: 'bond', instrument: 'bond', side: 'buy', qty: 2_000_000, as: 'bonds',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy', instrument: 'bond', qty: 2_000_000, estimate: 98.60, model: 'quoted-bid-ask', settleDate: '2026-03-18',
          gross: 1_972_000, accrued: 833.33, cash: -1_972_833.33, fees: 0 }] }, // 2,000,000 x 98.60 / 100; 3 days of 30/360 to settlement
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2_000_000, avgPrice: 98.60 }] },
        events: [{ type: 'strategy.submitted', owner: 'account' }, { type: 'trade.fill', summary: 'Bought 2,000,000 OSTR-5-SEP30 @ 98.60 USD', owner: 'account', date: '2026-03-17' }],
        cash: { account: { USD: { settled: 2_000_000, unsettled: -1_972_833.33, payable: 1_972_833.33, availableToTrade: 27_166.67, availableToWithdraw: 27_166.67 } } },
        positions: [{ instrument: 'bond', lot: 'bonds', owner: 'account', direction: 'long', qty: 2_000_000, avgCost: 98.60, cost: 1_972_000, price: 98.50, value: 1_970_000, unrealized: -2_000, accrued: 833.33, pledged: 0 }],
        holdings: { bond: { long: 2_000_000, short: 0, net: 2_000_000 } },
        pending: [{ instrument: 'bond', lot: 'bonds', owner: 'account', dueDate: '2026-03-18', amount: -1_972_833.33, ccy: 'USD', into: 'cash' }],
        lifecycle: BOND_LIFECYCLE,
        pnl: { account: { realized: 0, couponInterest: 0, borrowFunding: 0, unrealized: -2_000, total: -2_000 }, book: { total: -2_000 } },
        nav: { account: 1_998_000, treasury: 1_000_000, book: 2_998_000 }, // buying accrued interest is not a cost
        balance: {
          account: { cash: 2_000_000, positions: 1_970_000, accruedIncome: 833.33, payable: 1_972_833.33, assets: 3_970_833.33, liabilities: 1_972_833.33, netAssets: 1_998_000 },
          book: { cash: 3_000_000, positions: 1_970_000, accruedIncome: 833.33, payable: 1_972_833.33, assets: 4_970_833.33, liabilities: 1_972_833.33, netAssets: 2_998_000 },
        },
      },
    },
    {
      id: 'notes-settle', covers: 'settlement', action: 'clock', to: AT_1000('2026-03-18'), // the run of 17 March: the interest bought runs to 18 March, already booked
      expect: {
        events: [{ type: 'settlement.pay', summary: /^Settlement: paid 1,972,833\.33 USD/, cash: { USD: -1_972_833.33 }, date: '2026-03-18' }],
        cash: { account: { USD: { settled: 27_166.67, unsettled: 0, payable: 0, availableToTrade: 27_166.67, availableToWithdraw: 27_166.67 } } },
        pending: [],
        balance: { account: { cash: 27_166.67, payable: null, assets: 1_998_000, liabilities: 0 }, book: { cash: 1_027_166.67, payable: null, assets: 2_998_000, liabilities: 0 } },
      },
    },
    repoTicket('ask-more-than-the-collateral-supports', { ...REPO, as: undefined, principal: 1_950_000 }, {
      covers: ['open', 'haircut'], status: 'blocked', reason: 'The notes are worth 1,970,833.33 dirty; after the 2% haircut they support 1,931,416.66.',
      expect: { refused: 'The collateral supports at most 1,931,416.66 USD: 2,000,000 OSTR-5-SEP30 is worth 1,970,833.33 USD (1,970,000.00 USD clean plus 833.33 USD accrued interest) and the haircut is 2.00%; 1,950,000.00 USD requested.' },
    }),
    repoTicket('repo-the-notes', REPO, {
      covers: ['open', 'borrow', 'haircut', 'collateral'],
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repo_open', action: 'repo', purpose: 'financing', qty: 1_931_416.66, cash: 1_931_416.66, fees: 0, ccy: 'USD', dailyCost: 236.06, // 1,931,416.66 x 0.044 / 360
            financing: { amount: 1_931_416.66, rateType: 'fixed', rate: 0.044, maturity: '2026-04-01', interestFrom: '2026-03-18' } }],
          cash: { USD: { financingIn: 1_931_416.66, financingOut: 0, required: 0, available: 27_166.67, shortfall: 0, netCash: 1_931_416.66 } },
        },
        result: { status: 'open', orders: [{ kind: 'repo_open', action: 'repo', instrument: 'repo', status: 'filled', qty: 1_931_416.66, filledQty: 1_931_416.66 }] },
        events: [
          { type: 'strategy.submitted', owner: 'account' },
          { type: 'repo.open', summary: 'Repo: received 1,931,416.66 USD against 2,000,000 OSTR-5-SEP30 at 4.400% fixed to 2026-04-01', cash: { USD: 1_931_416.66 }, owner: 'account', date: '2026-03-18' },
        ],
        cash: { account: { USD: { settled: 1_958_583.33, availableToTrade: 1_958_583.33, availableToWithdraw: 1_958_583.33, borrowed: 1_931_416.66 } } }, // 27,166.67 + 1,931,416.66
        positions: [
          { instrument: 'bond', lot: 'bonds', owner: 'account', direction: 'long', qty: 2_000_000, avgCost: 98.60, cost: 1_972_000, price: 98.50, value: 1_970_000, unrealized: -2_000, accrued: 833.33, pledged: 2_000_000 },
          { instrument: 'repo', lot: 'repo', owner: 'account', direction: 'repo (cash borrowed)', qty: -1_931_416.66, value: 1_931_416.66, carrying: -1_931_416.66, accrued: 0, collateralHeld: null, provisional: false },
        ],
        lifecycle: [{ type: 'repo.end', instrument: 'repo', dueDate: '2026-04-01', status: 'pending', owner: 'account' }, ...BOND_LIFECYCLE],
        borrowings: [{ owner: 'account', origin: 'account', family: 'repo', type: 'Repo (cash borrowed against securities)', lot: 'repo', principal: 1_931_416.66, principalRc: 1_931_416.66, ccy: 'USD', rate: 0.044, rateType: 'fixed', rateText: '4.400% fixed', dayCount: 'ACT/360',
          accrued: 0, costToDate: 0, feesToDate: 0, startDate: '2026-03-18', maturity: '2026-04-01', term: 'term', lender: 'Kittering Securities', collateral: 'OSTR-5-SEP30: 2,000,000 pledged, haircut 2.00%', schedule: 'Interest paid at repurchase', nextPayment: '2026-04-01', nextPaymentType: 'repo.end', blocked: null }],
        balance: {
          account: { cash: 1_958_583.33, positions: 1_970_000, accruedIncome: 833.33, borrowed: 1_931_416.66, assets: 3_929_416.66, liabilities: 1_931_416.66, netAssets: 1_998_000 },
          book: { cash: 2_958_583.33, positions: 1_970_000, accruedIncome: 833.33, borrowed: 1_931_416.66, assets: 4_929_416.66, liabilities: 1_931_416.66, netAssets: 2_998_000 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'repo', principal: 1_931_416.66, ccy: 'USD', accrued: 0 }], treasuryOwn: [], accounts: { account: { cashBorrowed: 1_931_416.66, fundingReceived: 2_000_000 } } },
      },
    }),
    {
      id: 'sell-pledged-notes', covers: ['reduce', 'pledged collateral not sellable'], action: 'ticket', ticketOf: 'bond', instrument: 'bond', side: 'sell', qty: 500_000, from: 'bonds',
      status: 'blocked', reason: 'All 2,000,000 face is pledged to the repo.',
      expect: { refused: 'only 0 of the 2,000,000 OSTR-5-SEP30 held is unencumbered; the rest is pledged or out on loan and cannot be sold until it is released' },
    },
    {
      // Thursday's run: the notes earn one more day of coupon (4 days from 15 March: 1,111.11, +277.78); the repo one day of interest, 236.06.
      id: 'accrue-a-day', covers: 'interest accrual', action: 'clock', to: AT_1730('2026-03-19'),
      expect: {
        events: [
          { type: 'accrual.coupon', summary: /^Interest accrued on OSTR-5-SEP30: 277\.78 USD$/, owner: 'account', date: '2026-03-19' },
          { type: 'accrual.interest', summary: 'Repo interest accrued on Ostrander notes repo: 236.06 USD', owner: 'account', date: '2026-03-19' },
        ],
        positions: [
          { instrument: 'bond', lot: 'bonds', qty: 2_000_000, value: 1_970_000, accrued: 1_111.11, pledged: 2_000_000 },
          { instrument: 'repo', lot: 'repo', qty: -1_931_416.66, accrued: -236.06 },
        ],
        borrowings: [{ lot: 'repo', principal: 1_931_416.66, accrued: 236.06, costToDate: 236.06, nextPayment: '2026-04-01' }],
        pnl: { account: { couponInterest: 277.78, borrowFunding: -236.06, unrealized: -2_000, total: -1_958.28 }, book: { total: -1_958.28 } },
        nav: { account: 1_998_041.72, book: 2_998_041.72 },
        balance: {
          account: { accruedIncome: 1_111.11, accruedExpense: 236.06, assets: 3_929_694.44, liabilities: 1_931_652.72, netAssets: 1_998_041.72 },
          book: { accruedIncome: 1_111.11, accruedExpense: 236.06, assets: 4_929_694.44, liabilities: 1_931_652.72, netAssets: 2_998_041.72 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'repo', principal: 1_931_416.66, ccy: 'USD', accrued: 236.06 }] },
      },
    },
    {
      // Wednesday 1 April, the end date: the repo is repurchased first, with interest to today (14 days, 3,304.87: +3,068.81),
      // and the notes released; then the run of 31 March brings the notes' coupon to 31 March (16 days on 30/360: 4,444.44, +3,333.33).
      id: 'repurchase-on-the-end-date', covers: ['maturity', 'close', 'repurchase', 'collateral released'], action: 'clock', to: AT_1000('2026-04-01'),
      expect: {
        events: [
          { type: 'accrual.interest', summary: 'Repo interest accrued on Ostrander notes repo: 3,068.81 USD', owner: 'account', date: '2026-04-01' },
          { type: 'interest.payment', summary: 'Repo interest paid on Ostrander notes repo: 3,304.87 USD', cash: { USD: -3_304.87 }, owner: 'account', date: '2026-04-01' },
          { type: 'repo.close', summary: 'Repo repurchase: paid 1,931,416.66 USD principal (interest 3,304.87 USD); collateral released', cash: { USD: -1_931_416.66 }, owner: 'account', date: '2026-04-01' },
          { type: 'accrual.coupon', summary: /^Interest accrued on OSTR-5-SEP30: 3,333\.33 USD$/, owner: 'account', date: '2026-04-01' },
        ],
        cash: { account: { USD: { settled: 23_861.80, availableToTrade: 23_861.80, availableToWithdraw: 23_861.80, borrowed: 0 } } }, // 1,958,583.33 - 1,931,416.66 - 3,304.87
        positions: [{ instrument: 'bond', lot: 'bonds', owner: 'account', direction: 'long', qty: 2_000_000, avgCost: 98.60, cost: 1_972_000, price: 98.50, value: 1_970_000, unrealized: -2_000, accrued: 4_444.44, pledged: 0 }],
        lifecycle: BOND_LIFECYCLE, borrowings: [],
        // Coupon earned 4,444.44 - 833.33 bought = 3,611.11; repo interest 3,304.87.
        pnl: { account: { couponInterest: 3_611.11, borrowFunding: -3_304.87, unrealized: -2_000, total: -1_693.76 }, book: { total: -1_693.76 } },
        nav: { account: 1_998_306.24, book: 2_998_306.24 },
        balance: {
          account: { cash: 23_861.80, accruedIncome: 4_444.44, accruedExpense: null, borrowed: null, assets: 1_998_306.24, liabilities: 0, netAssets: 1_998_306.24 },
          book: { cash: 1_023_861.80, accruedIncome: 4_444.44, accruedExpense: null, borrowed: null, assets: 2_998_306.24, liabilities: 0, netAssets: 2_998_306.24 },
        },
        oversight: { accountBorrowings: [], accounts: { account: { cashBorrowed: 0, fundingReceived: 2_000_000 } } },
      },
    },
  ],
};

export default [repo];
