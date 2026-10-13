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

// ---------------------------------------------------------------------------------------------
// reverse_repo
// ---------------------------------------------------------------------------------------------
// Treasury lends cash for two weeks against 5,000,000 face of a US Treasury note delivered by Tidemark Securities. The
// cash lent is limited by the notes' dirty value less a 2% haircut (asking for more is refused). The notes are held, not
// owned: they are never a position, a holding or an asset of Treasury, and are listed as collateral received. The notes
// fall and the daily check flags the cover short; Treasury calls for more and records the 120,000 face delivered (the
// flag clears); they recover and 90,000 face goes back (a return that would leave the cover short is refused). On the
// end date the cash comes back with 14 days of interest and the notes are returned.
//
// Inputs: T-3.75-AUG30, 3.75% ACT/ACT, coupons 15 February / 15 August (period 15 Feb to 15 Aug 2026: 181 days; a full
// coupon is 1.875 per 100), quoted 99.20 / 99.30, last 99.25 (fixture). Reverse repo 4,850,000 at 4.30% ACT/360,
// 2 March to 16 March 2026.
//   Notes on 2 March: clean 5,000,000 x 99.25 / 100 = 4,962,500.00; accrued 15 days: 1.875 x 15 / 181 x 50,000 = 7,769.34;
//   worth 4,970,269.34; less 2%: 4,870,863.9532 -> 4,870,863.95, the most that can be lent.
//   Interest: 4,850,000 x 0.043 / 360 = 579.305556 a day; 14 days 8,110.2778 -> 8,110.28.
const NOTE = { productId: 'treasury_note', name: 'US Treasury Note 3.75% 15-Aug-2030', symbol: 'T-3.75-AUG30', marketView: 'US_CASH', venueType: 'otc', issuer: 'United States Treasury', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
  terms: { couponType: 'fixed', couponRate: 0.0375, frequency: 2, maturity: '2030-08-15', issueDate: '2025-08-15', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 100 } };
const RREPO_TERMS = { collateralInstrumentId: '$inst:note', collateralQty: 5_000_000, haircut: 0.02, rateType: 'fixed', rate: 0.043, dayCount: 'ACT/360', term: 'term', endDate: '2026-03-16', style: 'classic', collateralType: 'gc', triparty: false, counterparty: 'Tidemark Securities' };
const RREPO = { owner: 'treasury', side: 'reverse_repo', productId: 'reverse_repo', productLabel: 'Reverse repo', ccy: 'USD', principal: 4_850_000, name: 'Tidemark reverse repo', as: 'rrepo', terms: RREPO_TERMS };
const RR_POS = { instrument: 'rrepo', lot: 'rrepo', owner: 'treasury', direction: 'reverse repo (cash lent)', qty: 4_850_000, value: 4_850_000, carrying: 4_850_000, provisional: false };

const reverseRepo = {
  productId: 'reverse_repo',
  title: 'Two-week reverse repo by Treasury against 5,000,000 US Treasury 3.75% notes: cash capped at dirty value less 2%, collateral held not owned, margin call and return of excess by hand, terminated on the end date',
  matrix: {
    ...REPO_TICKET,
    automaticInputs: ['the collateral\'s dirty value on the start date (price fixture plus accrued interest from the registered coupon terms)', 'the most cash it supports after the haircut (more is refused)', 'repo interest income accrued daily at the end-of-day run', 'the daily check of the cover (flagged when short, cleared when restored)', 'termination on the end date: principal and interest received, the collateral returned'],
    manualInputs: ['every term of the reverse repo, entered on the ticket', 'the cash lent', 'a margin call met (collateral delivered) and a return of excess collateral, recorded with Collateral on the reverse repo\'s row'],
    settlement: 'None: the cash leaves settled cash on the day the ticket is confirmed and comes back on the end date',
    lifecycle: 'Interest accrues daily; the cover is checked daily; collateral delivered or returned is recorded by hand; terminated automatically on the end date',
    accounting: 'Cash lent is an asset of Treasury; repo interest is income ("Coupon and interest income"); the collateral received is held, not owned: never a position, a holding or a balance-sheet asset, listed as collateral received',
    collateral: 'Securities received, valued dirty; cover = value less 2% haircut against principal plus interest; a shortfall is flagged daily; a margin call and a return of excess are recorded by hand, the return refused when it would leave the cover short',
  },
  tradedOn: 'A reverse repo is not a registry instrument: it is entered on the Repo or reverse repo ticket of the Treasury page and registers itself when the ticket is confirmed. The collateral is a registered US Treasury note.',
  start: AT_1000('2026-03-02'), // Monday 2 March 2026, 10:00 New York
  book: {
    name: 'Matrix reverse repo', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 6_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 100_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { bond: 1 } },
  },
  instruments: { note: NOTE },
  quotes: { note: { bid: 99.20, ask: 99.30, last: 99.25, bidSize: 50_000_000, askSize: 50_000_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 100_000, availableToTrade: 100_000, availableToWithdraw: 100_000, borrowed: 0, lent: 0 } },
      treasury: { USD: { settled: 5_900_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 5_900_000, availableToWithdraw: 5_900_000, borrowed: 0, lent: 0 } },
    },
    positions: [], holdings: {}, pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 100_000, treasury: 5_900_000, book: 6_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
    pnl: { account: { total: 0 }, treasury: { couponInterest: 0, borrowFunding: 0, total: 0 }, book: { couponInterest: 0, total: 0 } },
    balance: {
      account: { cash: 100_000, assets: 100_000, liabilities: 0, netAssets: 100_000 },
      treasury: { cash: 5_900_000, assets: 5_900_000, liabilities: 0, netAssets: 5_900_000 },
      book: { cash: 6_000_000, assets: 6_000_000, liabilities: 0, netAssets: 6_000_000 },
    },
    oversight: { accountBorrowings: [], treasuryOwn: [] },
  },
  steps: [
    repoTicket('lend-more-than-the-collateral-supports', { ...RREPO, as: undefined, principal: 4_900_000 }, {
      covers: ['open', 'haircut'], status: 'blocked', reason: 'The notes delivered are worth 4,970,269.34 dirty; after the 2% haircut they support 4,870,863.95 of cash lent.',
      expect: { refused: 'The collateral received supports at most 4,870,863.95 USD: 5,000,000 T-3.75-AUG30 is worth 4,970,269.34 USD (4,962,500.00 USD clean plus 7,769.34 USD accrued interest) and the haircut is 2.00%; 4,900,000.00 USD requested.' },
    }),
    repoTicket('lend-the-cash', RREPO, {
      covers: ['open', 'lend', 'haircut', 'collateral received'],
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repo_open', action: 'reverse_repo', purpose: 'financing', qty: 4_850_000, cash: -4_850_000, fees: 0, ccy: 'USD', dailyCost: 579.31, // 4,850,000 x 0.043 / 360
            financing: { amount: -4_850_000, rateType: 'fixed', rate: 0.043, maturity: '2026-03-16', interestFrom: '2026-03-02',
              // the reconciliation: worth 4,970,269.34, haircut 4,970,269.34 - 4,870,863.95 = 99,405.39, no buffer
              collateral: { qty: 5_000_000, clean: 4_962_500, accrued: 7_769.34, worth: 4_970_269.34, haircutAmount: 99_405.39, buffer: 0, supports: 4_870_863.95 }, forward: null } }],
          cash: { USD: { financingIn: 0, financingOut: 4_850_000, required: 4_850_000, available: 5_900_000, shortfall: 0, netCash: -4_850_000 } },
        },
        result: { status: 'open', orders: [{ kind: 'repo_open', action: 'reverse_repo', instrument: 'rrepo', status: 'filled', qty: 4_850_000, filledQty: 4_850_000 }] },
        events: [
          { type: 'strategy.submitted', owner: 'treasury' },
          { type: 'repo.reverse_open', summary: 'Reverse repo: paid 4,850,000.00 USD against 5,000,000 T-3.75-AUG30 at 4.300% fixed to 2026-03-16', cash: { USD: -4_850_000 }, owner: 'treasury', date: '2026-03-02' },
        ],
        cash: { treasury: { USD: { settled: 1_050_000, availableToTrade: 1_050_000, availableToWithdraw: 1_050_000, lent: 4_850_000, borrowed: 0 } } },
        // The notes are held, not owned: no position, no holding, nothing on the balance sheet.
        positions: [{ ...RR_POS, accrued: 0, collateralHeld: { instrument: 'note', qty: 5_000_000 } }],
        holdings: {},
        lifecycle: [{ type: 'repo.end', instrument: 'rrepo', dueDate: '2026-03-16', status: 'pending', owner: 'treasury' }],
        balance: {
          treasury: { cash: 1_050_000, lent: 4_850_000, positions: null, assets: 5_900_000, liabilities: 0, netAssets: 5_900_000 },
          book: { cash: 1_150_000, lent: 4_850_000, positions: null, assets: 6_000_000, liabilities: 0, netAssets: 6_000_000 },
        },
      },
    }),
    { id: 'notes-fall', covers: 'collateral value falls', action: 'quote', instrument: 'note', quote: { bid: 96.95, ask: 97.05, last: 97.00, bidSize: 50_000_000, askSize: 50_000_000 }, expect: { events: [] } },
    {
      // The run of 3 March: a day's interest, 579.31; the cover: 5,000,000 x 97.00 / 100 = 4,850,000.00 plus 16 days accrued
      // (1.875 x 16 / 181 x 50,000 = 8,287.29) = 4,858,287.29, less 2% = 4,761,121.54, against 4,850,579.31 owed: 89,457.77 short.
      id: 'cover-short-at-the-end-of-day', covers: ['interest accrual', 'daily cover check'], action: 'clock', to: AT_1730('2026-03-03'),
      expect: {
        events: [{ type: 'accrual.interest', summary: 'Repo interest accrued on Tidemark reverse repo: 579.31 USD', owner: 'treasury', date: '2026-03-03' }],
        positions: [{ ...RR_POS, accrued: 579.31, collateralHeld: { instrument: 'note', qty: 5_000_000 } }],
        alerts: ['repo.margin'],
        pnl: { treasury: { couponInterest: 579.31, total: 579.31 }, book: { couponInterest: 579.31, total: 579.31 } },
        nav: { treasury: 5_900_579.31, book: 6_000_579.31 },
        balance: { treasury: { accruedIncome: 579.31, assets: 5_900_579.31, netAssets: 5_900_579.31 }, book: { accruedIncome: 579.31, assets: 6_000_579.31, netAssets: 6_000_579.31 } },
      },
    },
    {
      // Tidemark delivers 120,000 face more: 5,120,000 x 97.00 / 100 = 4,966,400.00 plus 8,486.19 accrued = 4,974,886.19, less 2% =
      // 4,875,388.47 against 4,850,579.31 owed. The flag clears at once. Nothing is posted: the notes are not Treasury's.
      id: 'margin-call-met', covers: ['margin call', 'collateral'], action: 'lifecycle', lot: 'rrepo', instrument: 'rrepo', body: { action: 'collateral', change: 'pledge', qty: 120_000 },
      expect: {
        events: [{ type: 'repo.collateral', summary: 'Margin call on Tidemark reverse repo: received 120,000 more T-3.75-AUG30 from the counterparty (now 5,120,000 T-3.75-AUG30 held, worth 4,974,886.19 USD: cover 4,875,388.47 USD against 4,850,579.31 USD owed)', owner: 'treasury', date: '2026-03-03', cash: {} }],
        positions: [{ ...RR_POS, accrued: 579.31, collateralHeld: { instrument: 'note', qty: 5_120_000 } }],
        holdings: {},
        alerts: [],
      },
    },
    { id: 'notes-recover', covers: 'collateral value rises', action: 'quote', instrument: 'note', quote: { bid: 99.45, ask: 99.55, last: 99.50, bidSize: 50_000_000, askSize: 50_000_000 }, expect: { events: [] } },
    { id: 'wednesday-morning', action: 'clock', to: AT_1000('2026-03-04'), expect: { events: [] } },
    {
      // Returning 400,000 would leave 4,720,000 x 99.50 / 100 = 4,696,400.00 plus 17 days accrued (1.875 x 17 / 181 x 47,200 =
      // 8,312.15) = 4,704,712.15, less 2% = 4,610,617.91 against 4,850,579.31 owed: 239,961.40 short. Refused.
      id: 'return-too-much', covers: ['return of excess collateral'], action: 'lifecycle', lot: 'rrepo', instrument: 'rrepo', body: { action: 'collateral', change: 'release', qty: 400_000 },
      status: 'blocked', reason: 'The cover after the return would be short of what Tidemark owes.',
      expect: { refused: 'After the return the cover would be 239,961.40 USD short: 4,720,000 T-3.75-AUG30 is worth 4,704,712.15 USD (4,696,400.00 USD clean plus 8,312.15 USD accrued interest) and the haircut is 2.00%, so it covers 4,610,617.91 USD against 4,850,579.31 USD owed with repo interest.' },
    },
    {
      // 90,000 goes back: 5,030,000 x 99.50 / 100 = 5,004,850.00 plus 8,858.08 accrued = 5,013,708.08, less 2% = 4,913,433.92.
      id: 'return-excess', covers: ['return of excess collateral', 'collateral'], action: 'lifecycle', lot: 'rrepo', instrument: 'rrepo', body: { action: 'collateral', change: 'release', qty: 90_000 },
      expect: {
        events: [{ type: 'repo.collateral', summary: 'Excess collateral returned to the counterparty on Tidemark reverse repo: 90,000 T-3.75-AUG30 (now 5,030,000 T-3.75-AUG30 held, worth 5,013,708.08 USD: cover 4,913,433.92 USD against 4,850,579.31 USD owed)', owner: 'treasury', date: '2026-03-04', cash: {} }],
        positions: [{ ...RR_POS, accrued: 579.31, collateralHeld: { instrument: 'note', qty: 5_030_000 } }],
      },
    },
    {
      // Monday 16 March, the end date: interest to today, 14 days, 8,110.28 (+7,530.97), is received with the principal and the
      // notes go back to Tidemark.
      id: 'terminated-on-the-end-date', covers: ['maturity', 'close', 'termination', 'collateral returned'], action: 'clock', to: AT_1000('2026-03-16'),
      expect: {
        events: [
          { type: 'accrual.interest', summary: 'Repo interest accrued on Tidemark reverse repo: 7,530.97 USD', owner: 'treasury', date: '2026-03-16' },
          { type: 'interest.payment', summary: 'Repo interest received on Tidemark reverse repo: 8,110.28 USD', cash: { USD: 8_110.28 }, owner: 'treasury', date: '2026-03-16' },
          { type: 'repo.reverse_close', summary: 'Reverse repo matured: received 4,850,000.00 USD principal (interest 8,110.28 USD); collateral returned', cash: { USD: 4_850_000 }, owner: 'treasury', date: '2026-03-16' },
        ],
        cash: { treasury: { USD: { settled: 5_908_110.28, availableToTrade: 5_908_110.28, availableToWithdraw: 5_908_110.28, lent: 0 } } }, // 1,050,000 + 4,850,000 + 8,110.28
        positions: [], holdings: {}, lifecycle: [], alerts: [],
        pnl: { treasury: { couponInterest: 8_110.28, total: 8_110.28 }, book: { couponInterest: 8_110.28, total: 8_110.28 } },
        nav: { treasury: 5_908_110.28, book: 6_008_110.28 },
        balance: {
          treasury: { cash: 5_908_110.28, lent: null, accruedIncome: null, assets: 5_908_110.28, liabilities: 0, netAssets: 5_908_110.28 },
          book: { cash: 6_008_110.28, lent: null, accruedIncome: null, assets: 6_008_110.28, liabilities: 0, netAssets: 6_008_110.28 },
        },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// overnight_repo
// ---------------------------------------------------------------------------------------------
// Treasury funds a holding of US Treasury bills overnight and rolls the funding. It buys 10,000,000 face of a bill and,
// once it has settled, repos it overnight for the most cash it supports (value less a 1% haircut). The next business day
// the repo is repurchased automatically with one day's interest and Treasury rolls it by hand: a new overnight repo on
// the same bills at the new day's rate. That one is entered on Friday 22 May: the next business day of the dollar
// payment calendar is Tuesday 26 May (Memorial Day, Monday 25 May, is a holiday), so it runs four days, and nothing
// happens on the holiday.
//
// Inputs: USTB-20AUG26 (discount bill, no coupon, nothing accrues on it), quoted 98.94 / 98.95, last 98.945 (fixture); no
// commission; T+1. Repo 1: 3.65% ACT/360, 21 to 22 May. Repo 2 (the roll): 3.70% ACT/360, 22 to 26 May.
//   Bills: 10,000,000 x 98.945 / 100 = 9,894,500.00; less 1%: 9,795,555.00, borrowed both times.
//   Repo 1: 9,795,555 x 0.0365 / 360 = 993.1604 -> 993.16 for the one day.
//   Repo 2: 9,795,555 x 0.037 / 360 = 1,006.7654 a day; 4 days: 4,027.0615 -> 4,027.06.
const BILL = { productId: 'treasury_bill', name: 'US Treasury Bill 20-Aug-2026', symbol: 'USTB-20AUG26', marketView: 'US_CASH', venueType: 'otc', issuer: 'United States Treasury', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
  terms: { couponType: 'zero', maturity: '2026-08-20', issueDate: '2026-02-19', dayCount: 'ACT/360', redemption: 100, minDenomination: 100 } };
const ON_TERMS = { collateralInstrumentId: '$inst:bill', collateralQty: 10_000_000, haircut: 0.01, rateType: 'fixed', rate: 0.0365, dayCount: 'ACT/360', term: 'overnight', style: 'classic', collateralType: 'gc', triparty: false, counterparty: 'Larkspur Capital Markets' };
const ON1 = { owner: 'treasury', side: 'repo', productId: 'overnight_repo', productLabel: 'Overnight repo', ccy: 'USD', principal: 9_795_555, name: 'Larkspur overnight repo 21 May', collateral: { instrument: 'bill', lot: 'bills' }, as: 'on1', terms: ON_TERMS };
const ON2 = { ...ON1, name: 'Larkspur overnight repo 22 May', as: 'on2', terms: { ...ON_TERMS, rate: 0.037 } };
const BILLS = { instrument: 'bill', lot: 'bills', owner: 'treasury', direction: 'long', qty: 10_000_000, avgCost: 98.95, cost: 9_895_000, price: 98.945, value: 9_894_500, unrealized: -500, accrued: 0 };
const BILL_LIFE = { type: 'bond.maturity', instrument: 'bill', dueDate: '2026-08-20', status: 'pending', owner: 'treasury' };
const onRecord = (lot, rate, rateText, maturity) => ({ owner: 'treasury', origin: 'treasury', family: 'repo', type: 'Repo (cash borrowed against securities)', lot, principal: 9_795_555, principalRc: 9_795_555, ccy: 'USD', rate, rateType: 'fixed', rateText, dayCount: 'ACT/360',
  accrued: 0, costToDate: 0, feesToDate: 0, maturity, term: 'overnight', lender: 'Larkspur Capital Markets', collateral: 'USTB-20AUG26: 10,000,000 pledged, haircut 1.00%', schedule: 'Interest paid at repurchase', nextPayment: maturity, nextPaymentType: 'repo.end', blocked: null });

const overnightRepo = {
  productId: 'overnight_repo',
  title: 'Overnight repo of 10,000,000 US Treasury bills by Treasury, repurchased the next business day and rolled by hand over Memorial Day',
  matrix: {
    ...REPO_TICKET,
    automaticInputs: ['the end date: the next business day of the dollar payment calendar (Tuesday after Memorial Day)', 'the bills\' value from the price fixture (a discount bill accrues nothing)', 'the most cash it supports after the haircut', 'repurchase on the end date with interest for the days run', 'the daily check of the cover'],
    manualInputs: ['every term, entered on the ticket', 'the roll: a new overnight repo entered each day at that day\'s rate (the Terminal does not renew an overnight repo by itself)'],
    settlement: 'None for the repo: cash received when confirmed, paid back on the next business day. The bills bought settle T+1',
    lifecycle: 'Repurchased automatically on the next business day with interest; rolled by entering a new overnight repo; an end date over a holiday runs to the next business day with interest for every day',
    accounting: 'Cash borrowed is a liability of Treasury; repo interest is a funding expense; the pledged bills stay on Treasury\'s balance sheet at market value',
    collateral: 'The bills are pledged for each night: not sellable or lendable; released at each repurchase and pledged again by the roll',
  },
  tradedOn: 'An overnight repo is not a registry instrument: it is entered on the Repo or reverse repo ticket of the Treasury page and registers itself when the ticket is confirmed. The collateral is a registered US Treasury bill.',
  start: AT_1000('2026-05-20'), // Wednesday 20 May 2026, 10:00 New York
  settlementCheck: { lag: 1, holidays: ['2026-05-25'] },
  book: {
    name: 'Matrix overnight repo', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 12_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { bond: 1 } },
  },
  instruments: { bill: BILL },
  quotes: { bill: { bid: 98.94, ask: 98.95, last: 98.945, bidSize: 50_000_000, askSize: 50_000_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 1_000_000, availableToTrade: 1_000_000, availableToWithdraw: 1_000_000, borrowed: 0, lent: 0 } },
      treasury: { USD: { settled: 11_000_000, unsettled: 0, payable: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 11_000_000, availableToWithdraw: 11_000_000, borrowed: 0, lent: 0 } },
    },
    positions: [], holdings: {}, pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 1_000_000, treasury: 11_000_000, book: 12_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
    pnl: { account: { total: 0 }, treasury: { borrowFunding: 0, unrealized: 0, total: 0 }, book: { total: 0 } },
    balance: {
      account: { cash: 1_000_000, assets: 1_000_000, liabilities: 0, netAssets: 1_000_000 },
      treasury: { cash: 11_000_000, assets: 11_000_000, liabilities: 0, netAssets: 11_000_000 },
      book: { cash: 12_000_000, assets: 12_000_000, liabilities: 0, netAssets: 12_000_000 },
    },
    oversight: { accountBorrowings: [], treasuryOwn: [] },
  },
  steps: [
    {
      id: 'buy-the-bills', covers: 'collateral', action: 'ticket', ticketOf: 'bond', instrument: 'bill', owner: 'treasury', side: 'buy', qty: 10_000_000, as: 'bills',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy', instrument: 'bill', qty: 10_000_000, estimate: 98.95, model: 'quoted-bid-ask', settleDate: '2026-05-21', gross: 9_895_000, accrued: 0, cash: -9_895_000, fees: 0 }] }, // 10,000,000 x 98.95 / 100
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000_000, avgPrice: 98.95 }] },
        events: [{ type: 'strategy.submitted', owner: 'treasury' }, { type: 'trade.fill', summary: 'Bought 10,000,000 USTB-20AUG26 @ 98.95 USD', owner: 'treasury', date: '2026-05-20' }],
        cash: { treasury: { USD: { settled: 11_000_000, unsettled: -9_895_000, payable: 9_895_000, availableToTrade: 1_105_000, availableToWithdraw: 1_105_000 } } },
        positions: [{ ...BILLS, pledged: 0 }],
        holdings: { bill: { long: 10_000_000, short: 0, net: 10_000_000 } },
        pending: [{ instrument: 'bill', lot: 'bills', owner: 'treasury', dueDate: '2026-05-21', amount: -9_895_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [BILL_LIFE],
        pnl: { treasury: { unrealized: -500, total: -500 }, book: { total: -500 } }, // 10,000,000 x (98.945 - 98.95) / 100
        nav: { treasury: 10_999_500, book: 11_999_500 },
        balance: {
          treasury: { cash: 11_000_000, positions: 9_894_500, payable: 9_895_000, assets: 20_894_500, liabilities: 9_895_000, netAssets: 10_999_500 },
          book: { cash: 12_000_000, positions: 9_894_500, payable: 9_895_000, assets: 21_894_500, liabilities: 9_895_000, netAssets: 11_999_500 },
        },
      },
    },
    {
      id: 'bills-settle', covers: 'settlement', action: 'clock', to: AT_1000('2026-05-21'),
      expect: {
        events: [{ type: 'settlement.pay', summary: /^Settlement: paid 9,895,000\.00 USD/, cash: { USD: -9_895_000 }, owner: 'treasury', date: '2026-05-21' }],
        cash: { treasury: { USD: { settled: 1_105_000, unsettled: 0, payable: 0, availableToTrade: 1_105_000, availableToWithdraw: 1_105_000 } } },
        pending: [],
        balance: { treasury: { cash: 1_105_000, payable: null, assets: 10_999_500, liabilities: 0 }, book: { cash: 2_105_000, payable: null, assets: 11_999_500, liabilities: 0 } },
      },
    },
    repoTicket('repo-overnight', ON1, {
      covers: ['open', 'borrow', 'haircut', 'collateral'],
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repo_open', action: 'repo', purpose: 'financing', qty: 9_795_555, cash: 9_795_555, fees: 0, ccy: 'USD', dailyCost: 993.16,
            financing: { amount: 9_795_555, rateType: 'fixed', rate: 0.0365, maturity: '2026-05-22', interestFrom: '2026-05-21',
              collateral: { qty: 10_000_000, clean: 9_894_500, accrued: 0, worth: 9_894_500, haircutAmount: 98_945, buffer: 0, supports: 9_795_555 }, forward: null } }],
          cash: { USD: { financingIn: 9_795_555, financingOut: 0, required: 0, available: 1_105_000, shortfall: 0, netCash: 9_795_555 } },
        },
        result: { status: 'open', orders: [{ kind: 'repo_open', action: 'repo', instrument: 'on1', status: 'filled', qty: 9_795_555, filledQty: 9_795_555 }] },
        events: [
          { type: 'strategy.submitted', owner: 'treasury' },
          { type: 'repo.open', summary: 'Repo: received 9,795,555.00 USD against 10,000,000 USTB-20AUG26 at 3.650% fixed to 2026-05-22', cash: { USD: 9_795_555 }, owner: 'treasury', date: '2026-05-21' },
        ],
        cash: { treasury: { USD: { settled: 10_900_555, availableToTrade: 10_900_555, availableToWithdraw: 10_900_555, borrowed: 9_795_555 } } }, // 1,105,000 + 9,795,555
        positions: [
          { ...BILLS, pledged: 10_000_000 },
          { instrument: 'on1', lot: 'on1', owner: 'treasury', direction: 'repo (cash borrowed)', qty: -9_795_555, value: 9_795_555, carrying: -9_795_555, accrued: 0, collateralHeld: null },
        ],
        lifecycle: [{ type: 'repo.end', instrument: 'on1', dueDate: '2026-05-22', status: 'pending', owner: 'treasury' }, BILL_LIFE],
        borrowings: [{ ...onRecord('on1', 0.0365, '3.650% fixed', '2026-05-22'), startDate: '2026-05-21' }],
        balance: {
          treasury: { cash: 10_900_555, positions: 9_894_500, borrowed: 9_795_555, assets: 20_795_055, liabilities: 9_795_555, netAssets: 10_999_500 },
          book: { cash: 11_900_555, positions: 9_894_500, borrowed: 9_795_555, assets: 21_795_055, liabilities: 9_795_555, netAssets: 11_999_500 },
        },
        oversight: { accountBorrowings: [], treasuryOwn: [{ owner: 'treasury', origin: 'treasury', lot: 'on1', principal: 9_795_555, ccy: 'USD', accrued: 0 }] },
      },
    }),
    {
      // Friday 22 May: repurchased with one day's interest, 993.16; the bills are released.
      id: 'repurchased-next-business-day', covers: ['maturity', 'close', 'repurchase', 'collateral released'], action: 'clock', to: AT_1000('2026-05-22'),
      expect: {
        events: [
          { type: 'accrual.interest', summary: 'Repo interest accrued on Larkspur overnight repo 21 May: 993.16 USD', owner: 'treasury', date: '2026-05-22' },
          { type: 'interest.payment', summary: 'Repo interest paid on Larkspur overnight repo 21 May: 993.16 USD', cash: { USD: -993.16 }, owner: 'treasury', date: '2026-05-22' },
          { type: 'repo.close', summary: 'Repo repurchase: paid 9,795,555.00 USD principal (interest 993.16 USD); collateral released', cash: { USD: -9_795_555 }, owner: 'treasury', date: '2026-05-22' },
        ],
        cash: { treasury: { USD: { settled: 1_104_006.84, availableToTrade: 1_104_006.84, availableToWithdraw: 1_104_006.84, borrowed: 0 } } }, // 10,900,555 - 9,795,555 - 993.16
        positions: [{ ...BILLS, pledged: 0 }],
        lifecycle: [BILL_LIFE], borrowings: [],
        pnl: { treasury: { borrowFunding: -993.16, unrealized: -500, total: -1_493.16 }, book: { total: -1_493.16 } },
        nav: { treasury: 10_998_506.84, book: 11_998_506.84 },
        balance: {
          treasury: { cash: 1_104_006.84, borrowed: null, accruedExpense: null, assets: 10_998_506.84, liabilities: 0, netAssets: 10_998_506.84 },
          book: { cash: 2_104_006.84, borrowed: null, accruedExpense: null, assets: 11_998_506.84, liabilities: 0, netAssets: 11_998_506.84 },
        },
        oversight: { treasuryOwn: [] },
      },
    },
    repoTicket('roll-over-the-holiday', ON2, {
      covers: ['open', 'roll', 'holiday'],
      expect: {
        preview: {
          blocking: 0, errors: [],
          // Entered on Friday: the next business day is Tuesday 26 May (Memorial Day on Monday).
          legs: [{ kind: 'repo_open', action: 'repo', purpose: 'financing', qty: 9_795_555, cash: 9_795_555, fees: 0, ccy: 'USD', dailyCost: 1_006.77,
            financing: { amount: 9_795_555, rateType: 'fixed', rate: 0.037, maturity: '2026-05-26', interestFrom: '2026-05-22',
              collateral: { qty: 10_000_000, clean: 9_894_500, accrued: 0, worth: 9_894_500, haircutAmount: 98_945, buffer: 0, supports: 9_795_555 }, forward: null } }],
          cash: { USD: { financingIn: 9_795_555, financingOut: 0, required: 0, available: 1_104_006.84, shortfall: 0, netCash: 9_795_555 } },
        },
        result: { status: 'open', orders: [{ kind: 'repo_open', action: 'repo', instrument: 'on2', status: 'filled', qty: 9_795_555, filledQty: 9_795_555 }] },
        events: [
          { type: 'strategy.submitted', owner: 'treasury' },
          { type: 'repo.open', summary: 'Repo: received 9,795,555.00 USD against 10,000,000 USTB-20AUG26 at 3.700% fixed to 2026-05-26', cash: { USD: 9_795_555 }, owner: 'treasury', date: '2026-05-22' },
        ],
        cash: { treasury: { USD: { settled: 10_899_561.84, availableToTrade: 10_899_561.84, availableToWithdraw: 10_899_561.84, borrowed: 9_795_555 } } },
        positions: [
          { ...BILLS, pledged: 10_000_000 },
          { instrument: 'on2', lot: 'on2', owner: 'treasury', direction: 'repo (cash borrowed)', qty: -9_795_555, value: 9_795_555, carrying: -9_795_555, accrued: 0, collateralHeld: null },
        ],
        lifecycle: [{ type: 'repo.end', instrument: 'on2', dueDate: '2026-05-26', status: 'pending', owner: 'treasury' }, BILL_LIFE],
        borrowings: [{ ...onRecord('on2', 0.037, '3.700% fixed', '2026-05-26'), startDate: '2026-05-22' }],
        balance: {
          treasury: { cash: 10_899_561.84, borrowed: 9_795_555, assets: 20_794_061.84, liabilities: 9_795_555, netAssets: 10_998_506.84 },
          book: { cash: 11_899_561.84, borrowed: 9_795_555, assets: 21_794_061.84, liabilities: 9_795_555, netAssets: 11_998_506.84 },
        },
        oversight: { treasuryOwn: [{ owner: 'treasury', origin: 'treasury', lot: 'on2', principal: 9_795_555, ccy: 'USD', accrued: 0 }] },
      },
    }),
    {
      // Memorial Day: the run of Friday 22 May accrues nothing (the repo started that day); nothing is repurchased.
      id: 'memorial-day-nothing-happens', covers: 'holiday', action: 'clock', to: AT_1000('2026-05-25'),
      expect: { events: [], lifecycle: [{ type: 'repo.end', instrument: 'on2', dueDate: '2026-05-26', status: 'pending', owner: 'treasury' }, BILL_LIFE], nav: { treasury: 10_998_506.84, book: 11_998_506.84 } },
    },
    {
      // Tuesday 26 May: four days of interest (22 to 26 May), 4,027.06, paid with the principal; the bills are released.
      id: 'repurchased-after-the-holiday', covers: ['maturity', 'close', 'repurchase', 'collateral released'], action: 'clock', to: AT_1000('2026-05-26'),
      expect: {
        events: [
          { type: 'accrual.interest', summary: 'Repo interest accrued on Larkspur overnight repo 22 May: 4,027.06 USD', owner: 'treasury', date: '2026-05-26' },
          { type: 'interest.payment', summary: 'Repo interest paid on Larkspur overnight repo 22 May: 4,027.06 USD', cash: { USD: -4_027.06 }, owner: 'treasury', date: '2026-05-26' },
          { type: 'repo.close', summary: 'Repo repurchase: paid 9,795,555.00 USD principal (interest 4,027.06 USD); collateral released', cash: { USD: -9_795_555 }, owner: 'treasury', date: '2026-05-26' },
        ],
        cash: { treasury: { USD: { settled: 1_099_979.78, availableToTrade: 1_099_979.78, availableToWithdraw: 1_099_979.78, borrowed: 0 } } }, // 10,899,561.84 - 9,795,555 - 4,027.06
        positions: [{ ...BILLS, pledged: 0 }],
        lifecycle: [BILL_LIFE], borrowings: [],
        pnl: { treasury: { borrowFunding: -5_020.22, unrealized: -500, total: -5_520.22 }, book: { total: -5_520.22 } }, // 993.16 + 4,027.06
        nav: { treasury: 10_994_479.78, book: 11_994_479.78 },
        balance: {
          treasury: { cash: 1_099_979.78, borrowed: null, assets: 10_994_479.78, liabilities: 0, netAssets: 10_994_479.78 },
          book: { cash: 2_099_979.78, borrowed: null, assets: 11_994_479.78, liabilities: 0, netAssets: 11_994_479.78 },
        },
        oversight: { treasuryOwn: [] },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// term_repo
// ---------------------------------------------------------------------------------------------
// A sterling term repo of gilts by an Account in a dollar Book, run to its end date. The Account buys 2,100,000 face of a
// 4.25% gilt and repos 2,000,000 of it to 3 April 2026 for 1,975,000 GBP at 4.10% ACT/365 (the sterling money-market
// basis). The terms state a haircut of 3% and an additional buffer of 25,000 GBP, so the most the gilts support is their
// dirty value less 3% less 25,000 (asking for more is refused). The gilt pays its coupon during the term: in a classic
// repo the coupon stays with the borrower (the lender passes it back as a manufactured payment), so the Account receives
// it on the pledged holding. The coupon takes the accrued interest out of the gilts' dirty value and the daily check
// flags the cover short; the Account pledges its other 100,000 face (the flag clears). Sterling falls from 1.27 to 1.255
// dollars. 3 April is Good Friday and 6 April Easter Monday, both English bank holidays: the repurchase is on Tuesday
// 7 April, with interest to that day. The borrowing is the Account's, shown once in the Book and in Treasury's oversight.
//
// Inputs: UKT-4.25-MAR34, 4.25% ACT/ACT, coupons 22 March / 22 September; a full coupon is 2.125 per 100; the period
// 22 Sep 2025 to 22 Mar 2026 is 181 days, 22 Mar to 22 Sep 2026 is 184 days. Quoted 101.10 / 101.20, last 101.15
// (fixture); no commission; T+1. GBP/USD 1.27, then 1.255 (fixture).
//   Bought 16 March, settles 17 March: 2,100,000 x 101.20 / 100 = 2,125,200.00; accrued 176 days: 44,625 x 176 / 181 =
//   43,392.27; cash 2,168,592.27 GBP.
//   Collateral 17 March: 2,000,000 x 101.15 / 100 = 2,023,000.00 plus 42,500 x 176 / 181 = 41,325.97: 2,064,325.97; less 3%:
//   2,002,396.19; less the 25,000 buffer: 1,977,396.19.
//   Repo interest: 1,975,000 x 0.041 / 365 = 221.849315 a day; to 20 March (3 days) 665.55; to 2 April (16) 3,549.59;
//   to 7 April (21) 4,658.84.
//   Coupon 22 March (a Sunday, paid Monday 23): 2,100,000 x 2.125 / 100 = 44,625.00, of which 43,392.27 was bought: 1,232.73
//   earned. Then 44,625 x 11 / 184 = 2,667.80 accrued to 2 April and 44,625 x 15 / 184 = 3,637.91 to 6 April.
//   Reporting currency: each entry at the rate in force when posted; balances at the current rate.
const GILT = { productId: 'foreign_gov_bond', name: 'UK Treasury 4.25% Gilt 22-Mar-2034', symbol: 'UKT-4.25-MAR34', marketView: 'FOREIGN_CASH', venueType: 'otc', venueCountry: 'GB', issuer: 'HM Treasury', domicile: 'GB', underlyingGeo: 'GB', tradingCcy: 'GBP', multiplier: 0.01,
  terms: { couponType: 'fixed', couponRate: 0.0425, frequency: 2, maturity: '2034-03-22', issueDate: '2023-09-22', dayCount: 'ACT/ACT', redemption: 100, minDenomination: 1 } };
const TREPO_TERMS = { collateralInstrumentId: '$inst:gilt', collateralQty: 2_000_000, haircut: 0.03, buffer: 25_000, rateType: 'fixed', rate: 0.041, dayCount: 'ACT/365', term: 'term', endDate: '2026-04-03', style: 'classic', collateralType: 'gc', triparty: false, counterparty: 'Ashcombe Gilt Dealers' };
const TREPO = { owner: 'account', side: 'repo', productId: 'term_repo', productLabel: 'Term repo', ccy: 'GBP', principal: 1_975_000, name: 'Ashcombe gilt term repo', collateral: { instrument: 'gilt', lot: 'gilts' }, as: 'trepo', terms: TREPO_TERMS };
const GILTS = { instrument: 'gilt', lot: 'gilts', owner: 'account', direction: 'long', qty: 2_100_000, avgCost: 101.20, cost: 2_125_200, price: 101.15, value: 2_124_150, unrealized: -1_050 };
const TR_POS = { instrument: 'trepo', lot: 'trepo', owner: 'account', direction: 'repo (cash borrowed)', qty: -1_975_000, value: 1_975_000, carrying: -1_975_000, collateralHeld: null };
const GILT_MAT = { type: 'bond.maturity', instrument: 'gilt', dueDate: '2034-03-22', status: 'pending', owner: 'account' };
const TR_END = { type: 'repo.end', instrument: 'trepo', dueDate: '2026-04-07', status: 'pending', owner: 'account' };

const termRepo = {
  productId: 'term_repo',
  title: 'Sterling term repo of 2,000,000 UK gilts by an Account in a dollar Book: haircut and buffer, ACT/365, coupon in the term kept by the borrower, margin call met, repurchase after Easter with reporting-currency figures',
  matrix: {
    ...REPO_TICKET,
    requiredFields: [...REPO_TICKET.requiredFields, 'Additional buffer (amount), when the terms state one'],
    automaticInputs: ['the gilts\' dirty value (price fixture plus ACT/ACT accrued interest from the registered coupon terms)', 'the most cash it supports: value less the haircut less the buffer', 'repo interest accrued daily on ACT/365', 'the coupon of the pledged gilts paid to the Account (the borrower keeps it in a classic repo)', 'the daily check of the cover', 'the repurchase date: the stated end date moved to the next sterling business day', 'conversion of every entry to dollars at the rate in force (GBP/USD fixture)'],
    manualInputs: ['every term, entered on the ticket (counterparty, haircut, buffer, rate, end date)', 'the cash principal', 'the margin call met: more gilts pledged with Collateral on the repo\'s row'],
    settlement: 'None for the repo: cash received when confirmed and paid back on the repurchase date. The gilts bought settle T+1',
    lifecycle: 'Interest accrues daily; the coupon is paid to the borrower during the term; the cover is checked daily; repurchased automatically on the first sterling business day on or after the end date, with interest to that day',
    accounting: 'Cash borrowed is a liability of the Account, in sterling, shown in dollars at the current rate; repo interest is a funding expense booked in dollars at each day\'s rate; the pledged gilts stay on the Account\'s balance sheet with their accrued coupon; the change in the dollar value of the sterling balances is the FX effect',
    collateral: 'The gilts are pledged: not sellable or lendable; cover = dirty value less 3% less 25,000 GBP against principal plus interest; the coupon lowers the dirty value and the shortfall is flagged; more gilts pledged by hand; all released on repurchase',
  },
  tradedOn: 'A term repo is not a registry instrument: it is entered on the Repo or reverse repo ticket of the Treasury page (for the Account) and registers itself when the ticket is confirmed. The collateral is a registered UK government bond (gilt).',
  start: AT_1000('2026-03-16'), // Monday 16 March 2026, 10:00 New York
  settlementCheck: { lag: 1, holidays: [] },
  book: {
    name: 'Matrix term repo', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'GBP', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'GBP', amount: 2_500_000 }] },
    settings: { fees: { bond: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { bond: 1 } },
  },
  instruments: { gilt: GILT },
  quotes: { gilt: { bid: 101.10, ask: 101.20, last: 101.15, bidSize: 50_000_000, askSize: 50_000_000 } },
  fx: { 'GBP/USD': 1.27 },
  expectAtStart: {
    cash: {
      account: { GBP: { settled: 2_500_000, unsettled: 0, payable: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 2_500_000, availableToWithdraw: 2_500_000, borrowed: 0, lent: 0 } },
      treasury: { USD: { settled: 1_000_000, availableToTrade: 1_000_000, borrowed: 0 }, GBP: { settled: 500_000, availableToTrade: 500_000, borrowed: 0 } },
    },
    positions: [], holdings: {}, pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 3_175_000, treasury: 1_635_000, book: 4_810_000 }, // 2,500,000 x 1.27; 1,000,000 + 500,000 x 1.27
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
    pnl: { account: { couponInterest: 0, borrowFunding: 0, unrealized: 0, fx: 0, total: 0 }, book: { fx: 0, total: 0 } },
    balance: {
      account: { cash: 3_175_000, assets: 3_175_000, liabilities: 0, netAssets: 3_175_000, local: { GBP: { cash: 2_500_000 } } },
      book: { cash: 4_810_000, assets: 4_810_000, liabilities: 0, netAssets: 4_810_000 },
    },
    oversight: { accountBorrowings: [], treasuryOwn: [] },
  },
  steps: [
    {
      id: 'buy-the-gilts', covers: 'collateral', action: 'ticket', ticketOf: 'bond', instrument: 'gilt', side: 'buy', qty: 2_100_000, as: 'gilts',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy', instrument: 'gilt', qty: 2_100_000, estimate: 101.20, model: 'quoted-bid-ask', settleDate: '2026-03-17', gross: 2_125_200, accrued: 43_392.27, cash: -2_168_592.27, fees: 0 }] },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2_100_000, avgPrice: 101.20 }] },
        events: [{ type: 'strategy.submitted', owner: 'account' }, { type: 'trade.fill', summary: 'Bought 2,100,000 UKT-4.25-MAR34 @ 101.20 GBP', owner: 'account', date: '2026-03-16' }],
        cash: { account: { GBP: { settled: 2_500_000, unsettled: -2_168_592.27, payable: 2_168_592.27, availableToTrade: 331_407.73, availableToWithdraw: 331_407.73 } } },
        positions: [{ ...GILTS, accrued: 43_392.27, pledged: 0 }],
        holdings: { gilt: { long: 2_100_000, short: 0, net: 2_100_000 } },
        pending: [{ instrument: 'gilt', lot: 'gilts', owner: 'account', dueDate: '2026-03-17', amount: -2_168_592.27, ccy: 'GBP', into: 'cash' }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'gilt', dueDate: '2026-03-23', status: 'pending', owner: 'account' }, GILT_MAT], // 22 March is a Sunday
        pnl: { account: { unrealized: -1_333.50, total: -1_333.50 }, book: { total: -1_333.50 } }, // -1,050 x 1.27
        nav: { account: 3_173_666.50, book: 4_808_666.50 }, // 2,498,950 x 1.27
        balance: {
          // 2,124,150 x 1.27 = 2,697,670.50; 43,392.27 x 1.27 = 55,108.18; 2,168,592.27 x 1.27 = 2,754,112.18
          account: { cash: 3_175_000, positions: 2_697_670.50, accruedIncome: 55_108.18, payable: 2_754_112.18, assets: 5_927_778.68, liabilities: 2_754_112.18, netAssets: 3_173_666.50,
            local: { GBP: { cash: 2_500_000, positions: 2_124_150, accruedIncome: 43_392.27, payable: 2_168_592.27 } } },
          book: { cash: 4_810_000, positions: 2_697_670.50, accruedIncome: 55_108.18, payable: 2_754_112.18, assets: 7_562_778.68, liabilities: 2_754_112.18, netAssets: 4_808_666.50 },
        },
      },
    },
    {
      id: 'gilts-settle', covers: 'settlement', action: 'clock', to: AT_1000('2026-03-17'),
      expect: {
        events: [{ type: 'settlement.pay', summary: /^Settlement: paid 2,168,592\.27 GBP/, cash: { GBP: -2_168_592.27 }, owner: 'account', date: '2026-03-17' }],
        cash: { account: { GBP: { settled: 331_407.73, unsettled: 0, payable: 0, availableToTrade: 331_407.73, availableToWithdraw: 331_407.73 } } },
        pending: [],
        balance: {
          account: { cash: 420_887.82, payable: null, assets: 3_173_666.50, liabilities: 0, local: { GBP: { cash: 331_407.73, payable: null } } }, // 331,407.73 x 1.27
          book: { cash: 2_055_887.82, payable: null, assets: 4_808_666.50, liabilities: 0 },
        },
      },
    },
    repoTicket('ask-more-than-the-buffer-allows', { ...TREPO, as: undefined, principal: 1_990_000 }, {
      covers: ['open', 'haircut', 'buffer'], status: 'blocked', reason: 'After the 3% haircut and the 25,000 GBP buffer the gilts support 1,977,396.19 GBP.',
      expect: { refused: 'The collateral supports at most 1,977,396.19 GBP: 2,000,000 UKT-4.25-MAR34 is worth 2,064,325.97 GBP (2,023,000.00 GBP clean plus 41,325.97 GBP accrued interest) and the haircut is 3.00%, less the additional buffer of 25,000.00 GBP; 1,990,000.00 GBP requested.' },
    }),
    repoTicket('repo-to-the-end-date', TREPO, {
      covers: ['open', 'borrow', 'haircut', 'buffer', 'collateral'],
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repo_open', action: 'repo', purpose: 'financing', qty: 1_975_000, cash: 1_975_000, fees: 0, ccy: 'GBP', dailyCost: 221.85, // 1,975,000 x 0.041 / 365
            financing: { amount: 1_975_000, rateType: 'fixed', rate: 0.041, maturity: '2026-04-03', interestFrom: '2026-03-17',
              collateral: { qty: 2_000_000, clean: 2_023_000, accrued: 41_325.97, worth: 2_064_325.97, haircutAmount: 61_929.78, buffer: 25_000, supports: 1_977_396.19 }, forward: null } }],
          cash: { GBP: { financingIn: 1_975_000, financingOut: 0, required: 0, available: 331_407.73, shortfall: 0, netCash: 1_975_000 } },
        },
        result: { status: 'open', orders: [{ kind: 'repo_open', action: 'repo', instrument: 'trepo', status: 'filled', qty: 1_975_000, filledQty: 1_975_000 }] },
        events: [
          { type: 'strategy.submitted', owner: 'account' },
          { type: 'repo.open', summary: 'Repo: received 1,975,000.00 GBP against 2,000,000 UKT-4.25-MAR34 at 4.100% fixed to 2026-04-03', cash: { GBP: 1_975_000 }, owner: 'account', date: '2026-03-17' },
        ],
        cash: { account: { GBP: { settled: 2_306_407.73, availableToTrade: 2_306_407.73, availableToWithdraw: 2_306_407.73, borrowed: 1_975_000 } } },
        positions: [{ ...GILTS, accrued: 43_392.27, pledged: 2_000_000 }, { ...TR_POS, accrued: 0 }],
        // The end date, Good Friday, is moved past Easter Monday to Tuesday 7 April (sterling payment calendar).
        lifecycle: [{ type: 'bond.coupon', instrument: 'gilt', dueDate: '2026-03-23', status: 'pending', owner: 'account' }, TR_END, GILT_MAT],
        borrowings: [{ owner: 'account', origin: 'account', family: 'repo', type: 'Repo (cash borrowed against securities)', lot: 'trepo', principal: 1_975_000, principalRc: 2_508_250, ccy: 'GBP', rate: 0.041, rateType: 'fixed', rateText: '4.100% fixed', dayCount: 'ACT/365',
          accrued: 0, costToDate: 0, feesToDate: 0, startDate: '2026-03-17', maturity: '2026-04-03', term: 'term', lender: 'Ashcombe Gilt Dealers', collateral: 'UKT-4.25-MAR34: 2,000,000 pledged, haircut 3.00%', schedule: 'Interest paid at repurchase', nextPayment: '2026-04-07', nextPaymentType: 'repo.end', blocked: null }],
        balance: {
          // 2,306,407.73 x 1.27 = 2,929,137.82; 1,975,000 x 1.27 = 2,508,250.00
          account: { cash: 2_929_137.82, borrowed: 2_508_250, assets: 5_681_916.50, liabilities: 2_508_250, netAssets: 3_173_666.50, local: { GBP: { cash: 2_306_407.73, borrowed: 1_975_000 } } },
          book: { cash: 4_564_137.82, borrowed: 2_508_250, assets: 7_316_916.50, liabilities: 2_508_250, netAssets: 4_808_666.50 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'trepo', principal: 1_975_000, ccy: 'GBP', accrued: 0 }], treasuryOwn: [], accounts: { account: { cashBorrowed: 2_508_250 } } },
      },
    }),
    {
      // Monday 23 March: the coupon is paid to the Account on its 2,100,000 face, pledged or not (44,625.00; 1,232.73 of it
      // earned since the purchase), and the run of Friday 20 March accrues 3 days of repo interest, 665.55. Both at 1.27.
      id: 'coupon-paid-to-the-borrower', covers: ['coupon during the term', 'interest accrual'], action: 'clock', to: AT_1000('2026-03-23'),
      expect: {
        events: [
          { type: 'bond.coupon', summary: 'Coupon received on 2,100,000 UKT-4.25-MAR34: 44,625.00 GBP', cash: { GBP: 44_625 }, owner: 'account', date: '2026-03-23' },
          { type: 'accrual.coupon', summary: /^Interest accrued on UKT-4\.25-MAR34: 1,232\.73 GBP$/, owner: 'account', date: '2026-03-23' },
          { type: 'accrual.interest', summary: 'Repo interest accrued on Ashcombe gilt term repo: 665.55 GBP', owner: 'account', date: '2026-03-23' },
        ],
        cash: { account: { GBP: { settled: 2_351_032.73, availableToTrade: 2_351_032.73, availableToWithdraw: 2_351_032.73 } } },
        positions: [{ ...GILTS, accrued: 0, pledged: 2_000_000 }, { ...TR_POS, accrued: -665.55 }],
        lifecycle: [TR_END, { type: 'bond.coupon', instrument: 'gilt', dueDate: '2026-09-22', status: 'pending', owner: 'account' }, GILT_MAT],
        borrowings: [{ lot: 'trepo', accrued: 665.55, costToDate: 665.55, costToDateRc: 845.25, nextPayment: '2026-04-07' }], // 665.55 x 1.27 = 845.2485
        // 1,232.73 x 1.27 = 1,565.5671; NAV 2,499,517.18 GBP x 1.27 = 3,174,386.8186
        pnl: { account: { couponInterest: 1_565.57, borrowFunding: -845.25, unrealized: -1_333.50, fx: 0, total: -613.18 }, book: { total: -613.18 } },
        nav: { account: 3_174_386.82, book: 4_809_386.82 },
        balance: {
          account: { cash: 2_985_811.57, accruedIncome: null, accruedExpense: 845.25, assets: 5_683_482.07, liabilities: 2_509_095.25, netAssets: 3_174_386.82, local: { GBP: { cash: 2_351_032.73, accruedIncome: null, accruedExpense: 665.55 } } },
          book: { cash: 4_620_811.57, accruedIncome: null, accruedExpense: 845.25, assets: 7_318_482.07, liabilities: 2_509_095.25, netAssets: 4_809_386.82 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'trepo', principal: 1_975_000, ccy: 'GBP', accrued: 665.55 }] },
      },
    },
    {
      // Sterling falls to 1.255. Nothing is posted. Balances: cash 2,351,032.73 x 1.255 = 2,950,546.08; gilts 2,124,150 x 1.255 =
      // 2,665,808.25; repo 1,975,000 x 1.255 = 2,478,625.00; accrued 665.55 x 1.255 = 835.27. NAV 2,499,517.18 x 1.255 =
      // 3,136,894.06. Unrealized -1,050 x 1.255 = -1,317.75. FX effect: total -38,105.94 (3,136,894.06 - 3,175,000 funded) less
      // income 1,565.57, expense -845.25 and unrealized -1,317.75: -37,508.51. Treasury's 500,000 GBP lose 7,500.00.
      id: 'sterling-falls', covers: 'FX effect', action: 'fx_rate', pair: 'GBP/USD', rate: 1.255,
      expect: {
        events: [],
        pnl: { account: { couponInterest: 1_565.57, borrowFunding: -845.25, unrealized: -1_317.75, fx: -37_508.51, total: -38_105.94 }, book: { fx: -45_008.51, total: -45_605.94 } },
        nav: { account: 3_136_894.06, treasury: 1_627_500, book: 4_764_394.06 },
        borrowings: [{ lot: 'trepo', principalRc: 2_478_625, costToDateRc: 845.25 }],
        balance: {
          account: { cash: 2_950_546.08, positions: 2_665_808.25, accruedExpense: 835.27, borrowed: 2_478_625, assets: 5_616_354.33, liabilities: 2_479_460.27, netAssets: 3_136_894.06 },
          book: { cash: 4_578_046.08, positions: 2_665_808.25, accruedExpense: 835.27, borrowed: 2_478_625, assets: 7_243_854.33, liabilities: 2_479_460.27, netAssets: 4_764_394.06 }, // 1,000,000 + 627,500 + 2,950,546.08
        },
        oversight: { accounts: { account: { cashBorrowed: 2_478_625 } } },
      },
    },
    {
      // Good Friday, 3 April: nothing is repurchased (English banks are closed). The run of Thursday 2 April accrues the gilts'
      // coupon (2,667.80, at 1.255 = 3,348.09) and repo interest to 2 April (3,549.59, +2,884.04, at 1.255 = 3,619.47). The cover:
      // 2,000,000 x 101.15 / 100 = 2,023,000.00 plus 42,500 x 11 / 184 = 2,540.76 is 2,025,540.76; less 3% = 1,964,774.54; less the
      // buffer = 1,939,774.54 against 1,978,549.59 owed: 38,775.05 short, flagged.
      id: 'good-friday-cover-short', covers: ['holiday', 'interest accrual', 'daily cover check'], action: 'clock', to: AT_1000('2026-04-03'),
      expect: {
        events: [
          { type: 'accrual.coupon', summary: /^Interest accrued on UKT-4\.25-MAR34: 2,667\.80 GBP$/, owner: 'account', date: '2026-04-03' },
          { type: 'accrual.interest', summary: 'Repo interest accrued on Ashcombe gilt term repo: 2,884.04 GBP', owner: 'account', date: '2026-04-03' },
        ],
        positions: [{ ...GILTS, accrued: 2_667.80, pledged: 2_000_000 }, { ...TR_POS, accrued: -3_549.59 }],
        alerts: ['repo.margin'],
        borrowings: [{ lot: 'trepo', accrued: 3_549.59, costToDate: 3_549.59, costToDateRc: 4_464.72 }], // 845.25 + 3,619.47
        // NAV 2,499,300.94 GBP x 1.255 = 3,136,622.68; income 1,565.57 + 3,348.09; expense 845.25 + 3,619.47
        pnl: { account: { couponInterest: 4_913.66, borrowFunding: -4_464.72, unrealized: -1_317.75, fx: -37_508.51, total: -38_377.32 }, book: { total: -45_877.32 } },
        nav: { account: 3_136_622.68, book: 4_764_122.68 },
        balance: {
          // accrued income 2,667.80 x 1.255 = 3,348.09; accrued expense 3,549.59 x 1.255 = 4,454.74
          account: { accruedIncome: 3_348.09, accruedExpense: 4_454.74, assets: 5_619_702.42, liabilities: 2_483_079.74, netAssets: 3_136_622.68, local: { GBP: { accruedIncome: 2_667.80, accruedExpense: 3_549.59 } } },
          book: { accruedIncome: 3_348.09, accruedExpense: 4_454.74, assets: 7_247_202.42, liabilities: 2_483_079.74, netAssets: 4_764_122.68 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'trepo', principal: 1_975_000, ccy: 'GBP', accrued: 3_549.59 }] },
      },
    },
    {
      // The Account meets the call with its other 100,000 face: 2,100,000 x 101.15 / 100 = 2,124,150.00 plus 44,625 x 12 / 184 =
      // 2,910.33 (3 April) = 2,127,060.33; less 3% = 2,063,248.52; less the buffer = 2,038,248.52 against 1,978,549.59 owed.
      id: 'margin-call-met', covers: ['margin call', 'collateral'], action: 'lifecycle', lot: 'trepo', instrument: 'trepo', body: { action: 'collateral', change: 'pledge', qty: 100_000 },
      expect: {
        events: [{ type: 'repo.collateral', summary: 'Margin call met on Ashcombe gilt term repo: pledged 100,000 more UKT-4.25-MAR34 (now 2,100,000 UKT-4.25-MAR34 pledged, worth 2,127,060.33 GBP: cover 2,038,248.52 GBP against 1,978,549.59 GBP owed)', owner: 'account', date: '2026-04-03', cash: {} }],
        positions: [{ ...GILTS, accrued: 2_667.80, pledged: 2_100_000 }, { ...TR_POS, accrued: -3_549.59 }],
        alerts: [],
        borrowings: [{ lot: 'trepo', collateral: 'UKT-4.25-MAR34: 2,100,000 pledged, haircut 3.00%' }],
      },
    },
    {
      // Easter Monday: an English bank holiday (the New York markets are open, but their run of Friday 3 April was a holiday too).
      id: 'easter-monday-nothing-happens', covers: 'holiday', action: 'clock', to: AT_1000('2026-04-06'),
      expect: { events: [], lifecycle: [TR_END, { type: 'bond.coupon', instrument: 'gilt', dueDate: '2026-09-22', status: 'pending', owner: 'account' }, GILT_MAT], nav: { account: 3_136_622.68, book: 4_764_122.68 } },
    },
    {
      // Tuesday 7 April: repurchased with 21 days' interest, 4,658.84 (+1,109.25, at 1.255 = 1,392.11); the gilts are released. The
      // run of Monday 6 April then accrues the coupon to 6 April: 3,637.91 (+970.11, at 1.255 = 1,217.49).
      id: 'repurchased-after-easter', covers: ['maturity', 'close', 'repurchase', 'holiday', 'collateral released'], action: 'clock', to: AT_1000('2026-04-07'),
      expect: {
        events: [
          { type: 'accrual.interest', summary: 'Repo interest accrued on Ashcombe gilt term repo: 1,109.25 GBP', owner: 'account', date: '2026-04-07' },
          { type: 'interest.payment', summary: 'Repo interest paid on Ashcombe gilt term repo: 4,658.84 GBP', cash: { GBP: -4_658.84 }, owner: 'account', date: '2026-04-07' },
          { type: 'repo.close', summary: 'Repo repurchase: paid 1,975,000.00 GBP principal (interest 4,658.84 GBP); collateral released', cash: { GBP: -1_975_000 }, owner: 'account', date: '2026-04-07' },
          { type: 'accrual.coupon', summary: /^Interest accrued on UKT-4\.25-MAR34: 970\.11 GBP$/, owner: 'account', date: '2026-04-07' },
        ],
        cash: { account: { GBP: { settled: 371_373.89, availableToTrade: 371_373.89, availableToWithdraw: 371_373.89, borrowed: 0 } } }, // 2,351,032.73 - 1,975,000 - 4,658.84
        positions: [{ ...GILTS, accrued: 3_637.91, pledged: 0 }],
        lifecycle: [{ type: 'bond.coupon', instrument: 'gilt', dueDate: '2026-09-22', status: 'pending', owner: 'account' }, GILT_MAT],
        borrowings: [],
        // NAV 2,499,161.80 GBP x 1.255 = 3,136,448.06; income 4,913.66 + 1,217.49; expense 4,464.72 + 1,392.11
        pnl: { account: { couponInterest: 6_131.15, borrowFunding: -5_856.83, unrealized: -1_317.75, fx: -37_508.51, total: -38_551.94 }, book: { total: -46_051.94 } },
        nav: { account: 3_136_448.06, book: 4_763_948.06 },
        balance: {
          // cash 371,373.89 x 1.255 = 466,074.23; accrued income 3,637.91 x 1.255 = 4,565.58
          account: { cash: 466_074.23, accruedIncome: 4_565.58, accruedExpense: null, borrowed: null, assets: 3_136_448.06, liabilities: 0, netAssets: 3_136_448.06, local: { GBP: { cash: 371_373.89, accruedIncome: 3_637.91, accruedExpense: null, borrowed: null } } },
          book: { cash: 2_093_574.23, accruedIncome: 4_565.58, accruedExpense: null, borrowed: null, assets: 4_763_948.06, liabilities: 0, netAssets: 4_763_948.06 },
        },
        oversight: { accountBorrowings: [], accounts: { account: { cashBorrowed: 0 } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// open_repo
// ---------------------------------------------------------------------------------------------
// An open equity repo: an Account buys 50,000 shares and repos them with no end date, at 5.10% to begin with. A week
// later the rate is reset by hand to 5.35%. The Account sends most of its cash back to Treasury, so when it asks to
// terminate the repo the termination is refused for want of cash (principal and interest must be paid at once); Treasury
// funds it and the repo is terminated on demand, with interest at each rate for its days.
//
// Inputs: RIDG, NYSE, quoted 83.98 / 84.02, last 84.00 (fixture); no commission; T+1. Repo 3,700,000 at 5.10% ACT/360
// from 3 March, haircut 10% (an equity haircut), reset to 5.35% on 10 March, terminated 16 March.
//   Shares: 50,000 x 84.00 = 4,200,000.00; less 10%: 3,780,000.00 supported.
//   Interest: 3,700,000 x 0.051 / 360 = 524.166667 a day for 7 days (3 to 10 March): 3,669.1667;
//             3,700,000 x 0.0535 / 360 = 549.861111 a day for 6 days (10 to 16 March): 3,299.1667; total 6,968.3333 -> 6,968.33.
const RIDG = { productId: 'common_stock', name: 'Ridgeway Industrial Holdings Inc.', symbol: 'RIDG', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Ridgeway Industrial Holdings Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} };
const OREPO_TERMS = { collateralInstrumentId: '$inst:stock', collateralQty: 50_000, haircut: 0.10, rateType: 'fixed', rate: 0.051, dayCount: 'ACT/360', term: 'open', style: 'classic', collateralType: 'gc', triparty: false, counterparty: 'Wexford Prime Services' };
const OREPO = { owner: 'account', side: 'repo', productId: 'open_repo', productLabel: 'Open repo', ccy: 'USD', principal: 3_700_000, name: 'Wexford open repo', collateral: { instrument: 'stock', lot: 'shares' }, as: 'orepo', terms: OREPO_TERMS };
const SHARES = { instrument: 'stock', lot: 'shares', owner: 'account', direction: 'long', qty: 50_000, avgCost: 84.02, cost: 4_201_000, price: 84, value: 4_200_000, unrealized: -1_000 };
const OR_POS = { instrument: 'orepo', lot: 'orepo', owner: 'account', direction: 'repo (cash borrowed)', qty: -3_700_000, value: 3_700_000, carrying: -3_700_000, collateralHeld: null };

const openRepo = {
  productId: 'open_repo',
  title: 'Open repo of 50,000 shares by an Account: no end date, rate reset by hand, termination on demand refused for want of cash, then terminated with interest at each rate',
  matrix: {
    ...REPO_TICKET,
    automaticInputs: ['the shares\' value from the price fixture', 'the most cash it supports after the haircut', 'repo interest accrued daily at the rate in force', 'the daily check of the cover', 'the cash a termination needs: principal and interest to the day'],
    manualInputs: ['every term, entered on the ticket (Term: Open, no end date)', 'the new rate, entered with Set rate on the repo\'s row', 'the termination on demand, with Repurchase on the repo\'s row'],
    settlement: 'None for the repo: cash received when confirmed and paid back when terminated. The shares bought settle T+1',
    lifecycle: 'Runs until terminated: no end date and nothing scheduled; interest accrues daily at the rate in force; a rate reset accrues to its date at the old rate first; termination on demand pays principal and all interest',
    accounting: 'Cash borrowed is a liability of the Account; repo interest is a funding expense; the pledged shares stay on the Account\'s balance sheet at market value',
    collateral: 'The shares are pledged until the repo is terminated: not sellable or lendable; cover checked daily',
  },
  tradedOn: 'An open repo is not a registry instrument: it is entered on the Repo or reverse repo ticket of the Treasury page (for the Account) and registers itself when the ticket is confirmed. The collateral is a registered NYSE-listed common stock.',
  start: AT_1000('2026-03-02'), // Monday 2 March 2026, 10:00 New York
  settlementCheck: { lag: 1, holidays: [] },
  book: {
    name: 'Matrix open repo', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 5_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 4_500_000 }] },
    settings: { fees: { equity: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { equity: 1 } },
  },
  instruments: { stock: RIDG },
  quotes: { stock: { bid: 83.98, ask: 84.02, last: 84.00, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 4_500_000, unsettled: 0, payable: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 4_500_000, availableToWithdraw: 4_500_000, borrowed: 0, lent: 0 } },
      treasury: { USD: { settled: 500_000, availableToTrade: 500_000, availableToWithdraw: 500_000, borrowed: 0 } },
    },
    positions: [], holdings: {}, pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 4_500_000, treasury: 500_000, book: 5_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
    pnl: { account: { realized: 0, borrowFunding: 0, unrealized: 0, total: 0 }, book: { total: 0 } },
    balance: {
      account: { cash: 4_500_000, assets: 4_500_000, liabilities: 0, netAssets: 4_500_000, internal: 4_500_000 },
      treasury: { cash: 500_000, assets: 500_000, liabilities: 0, netAssets: 500_000, internal: -4_500_000 },
      book: { cash: 5_000_000, assets: 5_000_000, liabilities: 0, netAssets: 5_000_000, internal: 0 },
    },
    oversight: { accountBorrowings: [], treasuryOwn: [] },
  },
  steps: [
    {
      id: 'buy-the-shares', covers: 'collateral', action: 'ticket', ticketOf: 'equity', instrument: 'stock', side: 'buy', qty: 50_000, as: 'shares',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'buy', instrument: 'stock', qty: 50_000, estimate: 84.02, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: -4_201_000, fees: 0 }] }, // 50,000 x 84.02
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 50_000, avgPrice: 84.02 }] },
        events: [{ type: 'strategy.submitted', owner: 'account' }, { type: 'trade.fill', summary: 'Bought 50,000 RIDG @ 84.02 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 4_500_000, unsettled: -4_201_000, payable: 4_201_000, availableToTrade: 299_000, availableToWithdraw: 299_000 } } },
        positions: [{ ...SHARES, pledged: 0 }],
        holdings: { stock: { long: 50_000, short: 0, net: 50_000 } },
        pending: [{ instrument: 'stock', lot: 'shares', owner: 'account', dueDate: '2026-03-03', amount: -4_201_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { unrealized: -1_000, total: -1_000 }, book: { total: -1_000 } },
        nav: { account: 4_499_000, book: 4_999_000 },
        balance: {
          account: { cash: 4_500_000, positions: 4_200_000, payable: 4_201_000, assets: 8_700_000, liabilities: 4_201_000, netAssets: 4_499_000 },
          book: { cash: 5_000_000, positions: 4_200_000, payable: 4_201_000, assets: 9_200_000, liabilities: 4_201_000, netAssets: 4_999_000 },
        },
      },
    },
    {
      id: 'shares-settle', covers: 'settlement', action: 'clock', to: AT_1000('2026-03-03'),
      expect: {
        events: [{ type: 'settlement.pay', summary: /^Settlement: paid 4,201,000\.00 USD/, cash: { USD: -4_201_000 }, owner: 'account', date: '2026-03-03' }],
        cash: { account: { USD: { settled: 299_000, unsettled: 0, payable: 0, availableToTrade: 299_000, availableToWithdraw: 299_000 } } },
        pending: [],
        balance: { account: { cash: 299_000, payable: null, assets: 4_499_000, liabilities: 0 }, book: { cash: 799_000, payable: null, assets: 4_999_000, liabilities: 0 } },
      },
    },
    repoTicket('repo-open-ended', OREPO, {
      covers: ['open', 'borrow', 'haircut', 'collateral'],
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repo_open', action: 'repo', purpose: 'financing', qty: 3_700_000, cash: 3_700_000, fees: 0, ccy: 'USD', dailyCost: 524.17, // 3,700,000 x 0.051 / 360
            financing: { amount: 3_700_000, rateType: 'fixed', rate: 0.051, maturity: null, interestFrom: '2026-03-03',
              collateral: { qty: 50_000, clean: 4_200_000, accrued: 0, worth: 4_200_000, haircutAmount: 420_000, buffer: 0, supports: 3_780_000 }, forward: null } }],
          cash: { USD: { financingIn: 3_700_000, financingOut: 0, required: 0, available: 299_000, shortfall: 0, netCash: 3_700_000 } },
        },
        result: { status: 'open', orders: [{ kind: 'repo_open', action: 'repo', instrument: 'orepo', status: 'filled', qty: 3_700_000, filledQty: 3_700_000 }] },
        events: [
          { type: 'strategy.submitted', owner: 'account' },
          { type: 'repo.open', summary: 'Repo: received 3,700,000.00 USD against 50,000 RIDG at 5.100% fixed, open', cash: { USD: 3_700_000 }, owner: 'account', date: '2026-03-03' },
        ],
        cash: { account: { USD: { settled: 3_999_000, availableToTrade: 3_999_000, availableToWithdraw: 3_999_000, borrowed: 3_700_000 } } },
        positions: [ // sorted by instrument key: orepo, stock
          { ...OR_POS, accrued: 0 }, { ...SHARES, pledged: 50_000 }],
        lifecycle: [], // open: nothing is scheduled
        borrowings: [{ owner: 'account', origin: 'account', family: 'repo', type: 'Repo (cash borrowed against securities)', lot: 'orepo', principal: 3_700_000, principalRc: 3_700_000, ccy: 'USD', rate: 0.051, rateType: 'fixed', rateText: '5.100% fixed', dayCount: 'ACT/360',
          accrued: 0, costToDate: 0, feesToDate: 0, startDate: '2026-03-03', maturity: null, term: 'open', lender: 'Wexford Prime Services', collateral: 'RIDG: 50,000 pledged, haircut 10.00%', schedule: 'Interest paid at repurchase', nextPayment: null, nextPaymentType: null, blocked: null }],
        balance: {
          account: { cash: 3_999_000, borrowed: 3_700_000, assets: 8_199_000, liabilities: 3_700_000, netAssets: 4_499_000 },
          book: { cash: 4_499_000, borrowed: 3_700_000, assets: 8_699_000, liabilities: 3_700_000, netAssets: 4_999_000 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'orepo', principal: 3_700_000, ccy: 'USD', accrued: 0 }], treasuryOwn: [], accounts: { account: { cashBorrowed: 3_700_000 } } },
      },
    }),
    {
      // Tuesday 10 March: the run of Monday 9 March accrues 6 days (3 to 9 March): 6 x 524.166667 = 3,145.00.
      id: 'a-week-runs', covers: 'interest accrual', action: 'clock', to: AT_1000('2026-03-10'),
      expect: {
        events: [{ type: 'accrual.interest', summary: 'Repo interest accrued on Wexford open repo: 3,145.00 USD', owner: 'account', date: '2026-03-10' }],
        positions: [{ ...OR_POS, accrued: -3_145 }, { ...SHARES, pledged: 50_000 }],
        borrowings: [{ lot: 'orepo', accrued: 3_145, costToDate: 3_145 }],
        pnl: { account: { borrowFunding: -3_145, unrealized: -1_000, total: -4_145 }, book: { total: -4_145 } },
        nav: { account: 4_495_855, book: 4_995_855 },
        balance: { account: { accruedExpense: 3_145, liabilities: 3_703_145, netAssets: 4_495_855 }, book: { accruedExpense: 3_145, liabilities: 3_703_145, netAssets: 4_995_855 } },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'orepo', principal: 3_700_000, ccy: 'USD', accrued: 3_145 }] },
      },
    },
    {
      // The rate is reset by hand. Interest is first brought to today at the old rate: 7 days, 3,669.1667 -> 3,669.17 (+524.17).
      id: 'set-a-new-rate', covers: ['rate change', 'set rate'], action: 'instrument_lifecycle', instrument: 'orepo', body: { action: 'set_rate', rate: 0.0535 },
      expect: {
        events: [
          { type: 'accrual.interest', summary: 'Repo interest accrued on Wexford open repo: 524.17 USD', owner: 'account', date: '2026-03-10' },
          { type: 'rate.reset', summary: 'Rate on Wexford open repo reset to 5.350%', owner: 'account', date: '2026-03-10' },
        ],
        positions: [{ ...OR_POS, accrued: -3_669.17 }, { ...SHARES, pledged: 50_000 }],
        borrowings: [{ lot: 'orepo', rate: 0.0535, rateText: '5.350% fixed', accrued: 3_669.17, costToDate: 3_669.17 }],
        pnl: { account: { borrowFunding: -3_669.17, total: -4_669.17 }, book: { total: -4_669.17 } },
        nav: { account: 4_495_330.83, book: 4_995_330.83 },
        balance: { account: { accruedExpense: 3_669.17, liabilities: 3_703_669.17, netAssets: 4_495_330.83 }, book: { accruedExpense: 3_669.17, liabilities: 3_703_669.17, netAssets: 4_995_330.83 } },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'orepo', principal: 3_700_000, ccy: 'USD', accrued: 3_669.17 }] },
      },
    },
    {
      id: 'cash-back-to-treasury', covers: 'return to Treasury', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 3_500_000,
      expect: {
        events: [{ type: 'transfer.return', summary: /3,500,000\.00 USD from Alpha to Treasury/, date: '2026-03-10' }],
        cash: { account: { USD: { settled: 499_000, availableToTrade: 499_000, availableToWithdraw: 499_000 } }, treasury: { USD: { settled: 4_000_000, availableToTrade: 4_000_000, availableToWithdraw: 4_000_000 } } },
        nav: { account: 995_330.83, treasury: 4_000_000, book: 4_995_330.83 },
        balance: {
          account: { cash: 499_000, assets: 4_699_000, netAssets: 995_330.83, internal: 1_000_000 },
          treasury: { cash: 4_000_000, assets: 4_000_000, netAssets: 4_000_000, internal: -1_000_000 },
          book: { cash: 4_499_000, internal: 0 },
        },
      },
    },
    {
      // Monday 16 March: the run of Friday 13 March accrues 3 days at 5.35%: 3,669.1667 + 1,649.5833 = 5,318.75 (+1,649.58).
      id: 'monday-16-march', covers: 'interest accrual', action: 'clock', to: AT_1000('2026-03-16'),
      expect: {
        events: [{ type: 'accrual.interest', summary: 'Repo interest accrued on Wexford open repo: 1,649.58 USD', owner: 'account', date: '2026-03-16' }],
        positions: [{ ...OR_POS, accrued: -5_318.75 }, { ...SHARES, pledged: 50_000 }],
        borrowings: [{ lot: 'orepo', accrued: 5_318.75, costToDate: 5_318.75 }],
        pnl: { account: { borrowFunding: -5_318.75, total: -6_318.75 }, book: { total: -6_318.75 } },
        nav: { account: 993_681.25, book: 4_993_681.25 },
        balance: { account: { accruedExpense: 5_318.75, liabilities: 3_705_318.75, netAssets: 993_681.25 }, book: { accruedExpense: 5_318.75, liabilities: 3_705_318.75, netAssets: 4_993_681.25 } },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'orepo', principal: 3_700_000, ccy: 'USD', accrued: 5_318.75 }] },
      },
    },
    {
      // Termination on demand needs 3,700,000 + 6,968.33 interest to today; the Account holds 499,000.
      id: 'terminate-without-the-cash', covers: ['close', 'termination', 'insufficient cash at repurchase'], action: 'repay', lot: 'orepo',
      status: 'blocked', reason: 'A termination pays principal and interest at once from settled cash; the Account holds 499,000.00 USD.',
      expect: { refused: 'Repurchase needs 3,706,968.33 USD (principal plus repo interest); Alpha has 499,000.00 USD of settled USD available.' },
    },
    {
      id: 'treasury-funds-the-account', covers: 'funding from Treasury', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 3_300_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 3,300,000.00 USD from Treasury to Alpha', date: '2026-03-16' }],
        cash: { account: { USD: { settled: 3_799_000, availableToTrade: 3_799_000, availableToWithdraw: 3_799_000 } }, treasury: { USD: { settled: 700_000, availableToTrade: 700_000, availableToWithdraw: 700_000 } } },
        nav: { account: 4_293_681.25, treasury: 700_000, book: 4_993_681.25 },
        balance: {
          account: { cash: 3_799_000, assets: 7_999_000, netAssets: 4_293_681.25, internal: 4_300_000 },
          treasury: { cash: 700_000, assets: 700_000, netAssets: 700_000, internal: -4_300_000 },
          book: { cash: 4_499_000, internal: 0 },
        },
      },
    },
    {
      // Terminated on demand: interest to today, 6,968.33 (+1,649.58 for 13 to 16 March), with the principal; shares released.
      id: 'terminate-on-demand', covers: ['close', 'termination', 'collateral released'], action: 'repay', lot: 'orepo',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repo_close', action: 'close_repo', purpose: 'financing', instrument: 'orepo', qty: 3_700_000, cash: -3_706_968.33, ccy: 'USD', financing: { amount: -3_706_968.33, principal: 3_700_000, interest: 6_968.33, full: true, rate: 0.0535, maturity: null } }],
          cash: { USD: { financingIn: 0, financingOut: 3_706_968.33, required: 3_706_968.33, available: 3_799_000, shortfall: 0, netCash: -3_706_968.33 } },
        },
        result: { status: 'closed', orders: [{ kind: 'repo_close', action: 'close_repo', status: 'filled', qty: 3_700_000, filledQty: 3_700_000 }] },
        events: [
          { type: 'strategy.legs_added', owner: 'account' },
          { type: 'accrual.interest', summary: 'Repo interest accrued on Wexford open repo: 1,649.58 USD', owner: 'account', date: '2026-03-16' },
          { type: 'interest.payment', summary: 'Repo interest paid on Wexford open repo: 6,968.33 USD', cash: { USD: -6_968.33 }, owner: 'account', date: '2026-03-16' },
          { type: 'repo.close', summary: 'Repo repurchase: paid 3,700,000.00 USD principal (interest 6,968.33 USD); collateral released', cash: { USD: -3_700_000 }, owner: 'account', date: '2026-03-16' },
        ],
        cash: { account: { USD: { settled: 92_031.67, availableToTrade: 92_031.67, availableToWithdraw: 92_031.67, borrowed: 0 } } }, // 3,799,000 - 3,706,968.33
        positions: [{ ...SHARES, pledged: 0 }],
        borrowings: [],
        pnl: { account: { borrowFunding: -6_968.33, unrealized: -1_000, total: -7_968.33 }, book: { total: -7_968.33 } },
        nav: { account: 4_292_031.67, book: 4_992_031.67 },
        balance: {
          account: { cash: 92_031.67, borrowed: null, accruedExpense: null, assets: 4_292_031.67, liabilities: 0, netAssets: 4_292_031.67 },
          book: { cash: 792_031.67, borrowed: null, accruedExpense: null, assets: 4_992_031.67, liabilities: 0, netAssets: 4_992_031.67 },
        },
        oversight: { accountBorrowings: [], accounts: { account: { cashBorrowed: 0 } } },
      },
    },
  ],
};

export default [repo, reverseRepo, overnightRepo, termRepo, openRepo];
