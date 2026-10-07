// Loan family (engine family "loan"): cash loans and deposits. Nine catalog products, one scenario each.
//
// None of these is a registry instrument. Each contract is entered on a ticket of the Treasury page or of
// an Account's page ("Cash loan or deposit", "Borrow and convert") and registers itself when the ticket is
// confirmed; the same pages carry the tickets the scenarios use around it ("Convert currency", "Transfer
// cash") and the actions on an open arrangement (Repay or Withdraw, Set rate).
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The arithmetic
// is in the comment beside it. Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be
// followed):
//   - Borrowed cash is settled cash at once and a liability of the Treasury or Account that borrowed it.
//     Cash lent or placed on deposit leaves settled cash at once and is an asset. A loan or deposit has no
//     settlement lag, no fee and no commission.
//   - Interest is simple interest on the principal outstanding: principal x rate x days / 360 (ACT/360) or
//     / 365 (ACT/365), days being calendar days. It is recognised once a day, at the end-of-day run (after
//     17:00 New York on a US business day), up to that date; a Monday run therefore adds three days. The
//     running figure is kept unrounded and the ledger balance is trued up to its rounded value, so each
//     day's entry is the difference of two rounded totals.
//   - Interest on borrowed cash is a funding expense ("Borrowing and funding expenses"); interest on cash
//     lent is income ("Coupon and interest income").
//   - A repayment or a withdrawal first brings interest up to its own date on the principal outstanding
//     until then. In part, the interest stays on its schedule. In full, the accrued interest is settled
//     with the principal.
//   - Interest is paid at maturity, or monthly on the first business day of each month (always monthly for
//     an open-ended arrangement). Payment dates are adjusted to the next business day of the payment
//     calendar of the currency.
//   - 2026 calendar facts used below, checked by hand: US clocks move to daylight time on Sunday 8 March
//     (17:30 New York is 22:30 UTC up to 6 March and 21:30 UTC from 9 March; 10:00 New York is 15:00 UTC,
//     then 14:00 UTC). Good Friday is 3 April and Easter Monday 6 April.

export const family = 'loan';

/** 10:00 and 17:30 New York on a date, as UTC instants. Daylight time runs from 8 March to 1 November 2026. */
const dst = (d) => d >= '2026-03-08' && d < '2026-11-01';
const AT_1000 = (d) => `${d}T${dst(d) ? '14' : '15'}:00:00.000Z`;
const AT_1730 = (d) => `${d}T${dst(d) ? '21' : '22'}:30:00.000Z`; // after the 17:00 end-of-day cutoff

const FILL = { halfSpreadBps: { equity: 2 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };

/** The contract a loan ticket sends: what web/views/treasury.js builds from its form (draftToContract). */
const contract = (productId, name, ccy, terms) => ({ productId, name, marketView: ccy === 'USD' ? 'US_CASH' : 'FOREIGN_CASH', venueType: 'otc', tradingCcy: ccy, tags: [], externalIds: {}, terms });

/**
 * A step that opens a loan or a deposit from the "Cash loan or deposit" ticket.
 *   o: { owner, page: 'account' | 'treasury', side: 'borrow_cash' | 'lend_cash', productId, productLabel, ccy,
 *        principal, name, terms, as }
 * `ticket` is what the browser driver fills in; `input` is the request that ticket sends (engine and API levels).
 */
const loanTicket = (id, o, rest) => ({
  id, action: 'ticket', owner: o.owner, as: o.as, contractAs: o.as,
  ticket: { kind: 'loan', page: o.page, side: o.side, productId: o.productId, productLabel: o.productLabel, ccy: o.ccy, principal: o.principal, name: o.name, terms: o.terms, pledge: o.pledge || null },
  input: { template: 'custom', name: o.name, legs: [{ kind: 'loan', action: o.side, purpose: 'financing', qty: o.principal, contract: contract(o.productId, o.name, o.ccy, o.terms) }] },
  ...rest,
});

const LOAN_TICKET = {
  ticket: 'Treasury page, "New loan or deposit" (or an Account page, "Borrow cash"): the Cash loan or deposit ticket, then the trade preview; Repay or Withdraw and Set rate on the row of the open arrangement',
  requiredFields: ['Borrower or Lender (Treasury or an Account)', 'Side (borrow, or lend / deposit)', 'Product', 'Currency', 'Principal', 'Rate (fixed: the rate; floating: reference rate code and spread)', 'Day count', 'Maturity (empty for open-ended)', 'Interest paid (at maturity or monthly)'],
};

// ---------------------------------------------------------------------------------------------
// unsecured_loan
// ---------------------------------------------------------------------------------------------
// Borrowed by an Account, not by Treasury: one record, owned by the Account, shown in Treasury's oversight
// as Account-originated and counted once in the Book. The scenario asserts all three views at every step
// (balance.account, oversight + balance.treasury, balance.book), a rate change by hand, a part repayment,
// a repayment refused for want of cash, internal funding both ways, and an early repayment in full.
//
// Interest, by hand (ACT/360):
//   2 March to 10 March, 8 days on 250,000 at 6.00%:   250,000 x 0.06  x 8 / 360 = 333.3333
//   10 March to 12 March, 2 days on 250,000 at 6.50%:  250,000 x 0.065 x 2 / 360 =  90.2778
//   12 March to 16 March, 4 days on 150,000 at 6.50%:  150,000 x 0.065 x 4 / 360 = 108.3333
//   total                                                                           531.9444 -> 531.94
const UNSECURED = { owner: 'account', page: 'account', side: 'borrow_cash', productId: 'unsecured_loan', productLabel: 'Unsecured loan', ccy: 'USD', principal: 250_000, name: 'Harborline unsecured term loan', as: 'loan',
  terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.06, dayCount: 'ACT/360', maturity: '2026-04-01', interestPayment: 'maturity', counterparty: 'Harborline Bank' } };

const unsecuredLoan = {
  productId: 'unsecured_loan',
  title: 'Harborline Bank unsecured term loan to an Account: 250,000 USD at 6.00% fixed, ACT/360, due 1 April 2026',
  matrix: {
    ...LOAN_TICKET,
    automaticInputs: ['interest start date (the day the ticket is confirmed)', 'daily interest accrual at the end-of-day run', 'repayment of principal and interest at maturity', 'the interest settled with a repayment in full'],
    manualInputs: ['every term of the contract (principal, rate, day count, maturity, lender), entered on the ticket', 'a rate change, entered by hand with Set rate', 'the amount of a part repayment, entered in the preview'],
    settlement: 'None: borrowed cash is settled cash on the day the ticket is confirmed; a repayment leaves settled cash at once',
    lifecycle: 'Interest accrues daily; principal and accrued interest are repaid at maturity (1 April 2026) unless repaid earlier, which is allowed in part or in full with interest to the repayment date',
    accounting: 'Cash borrowed is a liability of the Account that borrowed it; interest is a funding expense accrued daily; the borrowing is one record, on the Account balance sheet, in Treasury oversight as Account-originated, and once in the Book',
    collateral: 'None (unsecured)',
  },
  tradedOn: 'An unsecured loan is not a registry instrument: the contract is entered on the Cash loan or deposit ticket (here from the Account page, "Borrow cash") and registers itself when the ticket is confirmed.',
  start: AT_1000('2026-03-02'), // Monday 2 March 2026, 10:00 New York
  book: {
    name: 'Matrix unsecured loan', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 100_000 }] },
    settings: { fees: {}, fill: FILL, settlement: {} },
  },
  instruments: {},
  expectAtStart: {
    cash: {
      account: { USD: { settled: 100_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 100_000, availableToWithdraw: 100_000, borrowed: 0, lent: 0 } },
      treasury: { USD: { settled: 900_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 900_000, availableToWithdraw: 900_000, borrowed: 0, lent: 0 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 100_000, treasury: 900_000, book: 1_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
    oversight: { accountBorrowings: [], treasuryOwn: [], accounts: { account: { cashBorrowed: 0, fundingReceived: 100_000 } } },
  },
  steps: [
    loanTicket('borrow-without-a-rate', { ...UNSECURED, as: undefined, terms: { ...UNSECURED.terms, rate: null } }, {
      covers: 'open', status: 'blocked', reason: 'No rate was entered. The Terminal does not assume one.',
      expect: { refused: 'Enter the interest rate as a decimal (0.05 = 5%). The Terminal does not assume a rate.' },
    }),
    loanTicket('borrow', UNSECURED, {
      covers: ['open', 'borrow'],
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'loan', action: 'borrow_cash', purpose: 'financing', qty: 250_000, cash: 250_000, fees: 0, ccy: 'USD',
            dailyCost: 41.67, // 250,000 x 0.06 / 360 = 41.6667
            financing: { amount: 250_000, rateType: 'fixed', rate: 0.06, maturity: '2026-04-01', interestFrom: '2026-03-02' } }],
          cash: { USD: { purchases: 0, fees: 0, financingIn: 250_000, financingOut: 0, required: 0, available: 100_000, shortfall: 0, netCash: 250_000 } },
        },
        result: { status: 'open', orders: [{ kind: 'loan', action: 'borrow_cash', instrument: 'loan', status: 'filled', qty: 250_000, filledQty: 250_000 }] },
        events: [
          { type: 'strategy.submitted', owner: 'account' },
          { type: 'loan.drawdown', summary: 'Borrowed 250,000.00 USD (unsecured, 6.000% fixed, due 2026-04-01)', cash: { USD: 250_000 }, owner: 'account', date: '2026-03-02' },
        ],
        // The Account's own cash: 100,000 + 250,000 borrowed. Borrowed cash can be traded with and withdrawn at once.
        cash: { account: { USD: { settled: 350_000, unsettled: 0, availableToTrade: 350_000, availableToWithdraw: 350_000, borrowed: 250_000, lent: 0 } }, treasury: { USD: { settled: 900_000, borrowed: 0 } } },
        positions: [{ instrument: 'loan', lot: 'loan', owner: 'account', direction: 'borrowed', qty: -250_000, value: 250_000, carrying: -250_000, accrued: 0, provisional: false }],
        holdings: {},
        pending: [],
        lifecycle: [{ type: 'loan.maturity', instrument: 'loan', dueDate: '2026-04-01', status: 'pending' }],
        borrowings: [{ owner: 'account', origin: 'account', family: 'loan', type: 'Unsecured loan', lot: 'loan', principal: 250_000, principalRc: 250_000, ccy: 'USD', rate: 0.06, rateType: 'fixed', rateText: '6.000% fixed', dayCount: 'ACT/360',
          accrued: 0, costToDate: 0, feesToDate: 0, startDate: '2026-03-02', maturity: '2026-04-01', term: 'term', lender: 'Harborline Bank', collateral: 'None (unsecured)', schedule: 'Interest paid at maturity', nextPayment: '2026-04-01', nextPaymentType: 'loan.maturity', blocked: null }],
        pnl: { account: { realized: 0, dividends: 0, couponInterest: 0, borrowFunding: 0, commissions: 0, fees: 0, unrealized: 0, fx: 0, total: 0 }, book: { borrowFunding: 0, total: 0 }, treasury: { borrowFunding: 0, total: 0 } },
        // Borrowing changes no net asset value: cash and the liability rise together.
        nav: { account: 100_000, treasury: 900_000, book: 1_000_000 },
        balance: {
          // View 1, the Account: its own liability.
          account: { cash: 350_000, borrowed: 250_000, accruedExpense: null, assets: 350_000, liabilities: 250_000, netAssets: 100_000, internal: 100_000 },
          // View 2, Treasury alone: nothing borrowed. The Account's loan is in its oversight, not in its liabilities.
          treasury: { cash: 900_000, borrowed: null, assets: 900_000, liabilities: 0, netAssets: 900_000, internal: -100_000, capital: 1_000_000 },
          // View 3, the Book: 900,000 + 350,000 of cash, the loan once, internal funding eliminated.
          book: { cash: 1_250_000, borrowed: 250_000, assets: 1_250_000, liabilities: 250_000, netAssets: 1_000_000, internal: 0, capital: 1_000_000 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'loan', principal: 250_000, ccy: 'USD', accrued: 0 }], treasuryOwn: [], accounts: { account: { cashBorrowed: 250_000, fundingReceived: 100_000 } } },
      },
    }),
    {
      id: 'accrue-first-day', covers: 'interest accrual', action: 'clock', to: AT_1730('2026-03-03'),
      expect: {
        events: [{ type: 'accrual.interest', summary: 'Interest accrued on Harborline unsecured term loan: 41.67 USD', owner: 'account', date: '2026-03-03', cash: {} }], // 250,000 x 0.06 x 1 / 360 = 41.6667
        positions: [{ instrument: 'loan', lot: 'loan', qty: -250_000, value: 250_000, carrying: -250_000, accrued: -41.67 }],
        borrowings: [{ lot: 'loan', principal: 250_000, rate: 0.06, accrued: 41.67, costToDate: 41.67, nextPayment: '2026-04-01' }],
        pnl: { account: { borrowFunding: -41.67, couponInterest: 0, total: -41.67 }, book: { borrowFunding: -41.67, total: -41.67 }, treasury: { borrowFunding: 0, total: 0 } },
        nav: { account: 99_958.33, treasury: 900_000, book: 999_958.33 }, // 100,000 - 41.67
        balance: {
          account: { cash: 350_000, borrowed: 250_000, accruedExpense: 41.67, assets: 350_000, liabilities: 250_041.67, netAssets: 99_958.33 },
          treasury: { accruedExpense: null, liabilities: 0, netAssets: 900_000 },
          book: { borrowed: 250_000, accruedExpense: 41.67, liabilities: 250_041.67, netAssets: 999_958.33 },
        },
        oversight: { accountBorrowings: [{ lot: 'loan', principal: 250_000, accrued: 41.67 }], treasuryOwn: [] },
      },
    },
    {
      id: 'accrue-over-a-weekend', covers: 'interest accrual', action: 'clock', to: AT_1730('2026-03-09'), // Monday: 2 to 9 March is 7 days
      expect: {
        events: [{ type: 'accrual.interest', summary: 'Interest accrued on Harborline unsecured term loan: 250.00 USD', date: '2026-03-09' }], // 250,000 x 0.06 x 7 / 360 = 291.6667 -> 291.67, less 41.67 already booked
        positions: [{ instrument: 'loan', lot: 'loan', qty: -250_000, accrued: -291.67 }],
        borrowings: [{ lot: 'loan', principal: 250_000, accrued: 291.67, costToDate: 291.67 }],
        pnl: { account: { borrowFunding: -291.67, total: -291.67 }, book: { borrowFunding: -291.67, total: -291.67 } },
        nav: { account: 99_708.33, book: 999_708.33 },
        balance: { account: { accruedExpense: 291.67, liabilities: 250_291.67, netAssets: 99_708.33 }, book: { accruedExpense: 291.67, liabilities: 250_291.67, netAssets: 999_708.33 } },
        oversight: { accountBorrowings: [{ lot: 'loan', principal: 250_000, accrued: 291.67 }] },
      },
    },
    { id: 'next-morning', action: 'clock', to: AT_1000('2026-03-10'), expect: {} },
    {
      // The bank raises the rate to 6.50% from 10 March. Interest to that date is accrued at 6.00% first.
      id: 'set-rate', covers: 'rate change', action: 'instrument_lifecycle', instrument: 'loan', lot: 'loan', body: { action: 'set_rate', rate: 0.065 },
      expect: {
        events: [
          { type: 'accrual.interest', summary: 'Interest accrued on Harborline unsecured term loan: 41.66 USD' }, // 8 days: 333.3333 -> 333.33, less 291.67
          { type: 'rate.reset', summary: 'Rate on Harborline unsecured term loan reset to 6.500%', owner: 'account', date: '2026-03-10' },
        ],
        positions: [{ instrument: 'loan', lot: 'loan', qty: -250_000, accrued: -333.33 }],
        borrowings: [{ lot: 'loan', principal: 250_000, rate: 0.065, rateType: 'fixed', rateText: '6.500% fixed', accrued: 333.33, costToDate: 333.33, nextPayment: '2026-04-01' }],
        pnl: { account: { borrowFunding: -333.33, total: -333.33 }, book: { borrowFunding: -333.33, total: -333.33 } },
        nav: { account: 99_666.67, book: 999_666.67 },
        balance: { account: { accruedExpense: 333.33, liabilities: 250_333.33, netAssets: 99_666.67 }, book: { accruedExpense: 333.33, liabilities: 250_333.33, netAssets: 999_666.67 } },
        oversight: { accountBorrowings: [{ lot: 'loan', principal: 250_000, accrued: 333.33 }] },
      },
    },
    {
      id: 'accrue-at-the-new-rate', covers: 'interest accrual', action: 'clock', to: AT_1730('2026-03-11'),
      expect: {
        // One day at 6.50%: 250,000 x 0.065 / 360 = 45.1389. Running total 333.3333 + 45.1389 = 378.4722 -> 378.47.
        events: [{ type: 'accrual.interest', summary: 'Interest accrued on Harborline unsecured term loan: 45.14 USD' }],
        positions: [{ instrument: 'loan', lot: 'loan', qty: -250_000, accrued: -378.47 }],
        borrowings: [{ lot: 'loan', principal: 250_000, rate: 0.065, accrued: 378.47, costToDate: 378.47 }],
        pnl: { account: { borrowFunding: -378.47, total: -378.47 }, book: { borrowFunding: -378.47, total: -378.47 } },
        nav: { account: 99_621.53, book: 999_621.53 },
        balance: { account: { accruedExpense: 378.47, liabilities: 250_378.47, netAssets: 99_621.53 }, book: { accruedExpense: 378.47, liabilities: 250_378.47, netAssets: 999_621.53 } },
        oversight: { accountBorrowings: [{ lot: 'loan', principal: 250_000, accrued: 378.47 }] },
      },
    },
    { id: 'morning-of-the-part-repayment', action: 'clock', to: AT_1000('2026-03-12'), expect: {} },
    {
      id: 'repay-more-than-is-owed', covers: 'reduce', action: 'repay', lot: 'loan', amount: 300_000,
      status: 'blocked', reason: 'Only 250,000 is outstanding.',
      expect: { refused: 'Outstanding principal is 250,000.00 USD; cannot repay 300,000.00 USD.' },
    },
    {
      id: 'repay-part', covers: ['reduce', 'repayment'], action: 'repay', lot: 'loan', amount: 100_000,
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repay', action: 'repay_cash', purpose: 'financing', instrument: 'loan', qty: 100_000, cash: -100_000, ccy: 'USD', financing: { amount: -100_000, principal: 100_000, interest: 0, full: false, rate: 0.065, maturity: '2026-04-01' } }],
          cash: { USD: { financingIn: 0, financingOut: 100_000, required: 100_000, available: 350_000, shortfall: 0, netCash: -100_000 } },
        },
        result: { status: 'open', orders: [{ kind: 'repay', action: 'repay_cash', status: 'filled', qty: 100_000, filledQty: 100_000 }] },
        // Interest is first brought up to 12 March on the 250,000 outstanding until now: one more day at 6.50%,
        // 378.4722 + 45.1389 = 423.6111 -> 423.61, so 45.14 is added. The accrued interest is not paid by a part repayment.
        events: [
          { type: 'strategy.legs_added', owner: 'account' },
          { type: 'accrual.interest', summary: 'Interest accrued on Harborline unsecured term loan: 45.14 USD', date: '2026-03-12' },
          { type: 'loan.repayment', summary: 'Repaid 100,000.00 USD of principal on Harborline unsecured term loan', cash: { USD: -100_000 }, owner: 'account', date: '2026-03-12' },
        ],
        cash: { account: { USD: { settled: 250_000, availableToTrade: 250_000, availableToWithdraw: 250_000, borrowed: 150_000 } } },
        positions: [{ instrument: 'loan', lot: 'loan', owner: 'account', direction: 'borrowed', qty: -150_000, value: 150_000, carrying: -150_000, accrued: -423.61 }],
        lifecycle: [{ type: 'loan.maturity', instrument: 'loan', dueDate: '2026-04-01', status: 'pending' }],
        borrowings: [{ lot: 'loan', principal: 150_000, principalRc: 150_000, rate: 0.065, accrued: 423.61, costToDate: 423.61, nextPayment: '2026-04-01' }],
        pnl: { account: { borrowFunding: -423.61, total: -423.61 }, book: { borrowFunding: -423.61, total: -423.61 } },
        nav: { account: 99_576.39, book: 999_576.39 },
        balance: {
          account: { cash: 250_000, borrowed: 150_000, accruedExpense: 423.61, assets: 250_000, liabilities: 150_423.61, netAssets: 99_576.39 },
          treasury: { cash: 900_000, borrowed: null, liabilities: 0, netAssets: 900_000 },
          book: { cash: 1_150_000, borrowed: 150_000, accruedExpense: 423.61, assets: 1_150_000, liabilities: 150_423.61, netAssets: 999_576.39 },
        },
        oversight: { accountBorrowings: [{ owner: 'account', origin: 'account', lot: 'loan', principal: 150_000, accrued: 423.61 }], treasuryOwn: [], accounts: { account: { cashBorrowed: 150_000, fundingReceived: 100_000 } } },
      },
    },
    {
      id: 'accrue-on-the-reduced-principal', covers: 'interest accrual', action: 'clock', to: AT_1730('2026-03-13'),
      expect: {
        // 12 to 13 March on 150,000 at 6.50%: 150,000 x 0.065 / 360 = 27.0833. Running total 423.6111 + 27.0833 = 450.6944 -> 450.69.
        events: [{ type: 'accrual.interest', summary: 'Interest accrued on Harborline unsecured term loan: 27.08 USD' }],
        positions: [{ instrument: 'loan', lot: 'loan', qty: -150_000, accrued: -450.69 }],
        borrowings: [{ lot: 'loan', principal: 150_000, accrued: 450.69, costToDate: 450.69 }],
        pnl: { account: { borrowFunding: -450.69, total: -450.69 }, book: { borrowFunding: -450.69, total: -450.69 } },
        nav: { account: 99_549.31, book: 999_549.31 },
        balance: { account: { accruedExpense: 450.69, liabilities: 150_450.69, netAssets: 99_549.31 }, book: { accruedExpense: 450.69, liabilities: 150_450.69, netAssets: 999_549.31 } },
        oversight: { accountBorrowings: [{ lot: 'loan', principal: 150_000, accrued: 450.69 }] },
      },
    },
    { id: 'monday-16-march', action: 'clock', to: AT_1000('2026-03-16'), expect: {} },
    {
      // The Account sends 200,000 back to Treasury. Internal to the Book: no P&L, Book totals unchanged, and the
      // borrowing stays with the Account that owes it.
      id: 'return-cash-to-treasury', covers: 'return to Treasury', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 200_000,
      expect: {
        events: [{ type: 'transfer.return', summary: /200,000\.00 USD from Alpha to Treasury/, date: '2026-03-16' }],
        cash: { account: { USD: { settled: 50_000, availableToTrade: 50_000, availableToWithdraw: 50_000, borrowed: 150_000 } }, treasury: { USD: { settled: 1_100_000, availableToTrade: 1_100_000, availableToWithdraw: 1_100_000, borrowed: 0 } } },
        nav: { account: -100_450.69, treasury: 1_100_000, book: 999_549.31 }, // 50,000 - 150,000 - 450.69
        balance: {
          account: { cash: 50_000, borrowed: 150_000, assets: 50_000, liabilities: 150_450.69, netAssets: -100_450.69, internal: -100_000 }, // 100,000 received, 200,000 sent back
          treasury: { cash: 1_100_000, borrowed: null, assets: 1_100_000, netAssets: 1_100_000, internal: 100_000 },
          book: { cash: 1_150_000, borrowed: 150_000, netAssets: 999_549.31, internal: 0 },
        },
        pnl: { account: { borrowFunding: -450.69, total: -450.69 }, book: { borrowFunding: -450.69, total: -450.69 }, treasury: { total: 0 } },
        oversight: { accounts: { account: { cashBorrowed: 150_000, fundingReceived: -100_000 } } },
      },
    },
    {
      // Repaying in full needs 150,000 of principal and the interest to today: 450.6944 + 3 days x 27.0833 = 531.9444 -> 531.94.
      id: 'repay-without-the-cash', covers: 'repayment', action: 'repay', lot: 'loan',
      status: 'blocked', reason: 'The Account holds 50,000.00 USD; a repayment never overdraws.',
      expect: { refused: 'Alpha has 50,000.00 USD of settled USD available; 150,531.94 USD is needed (principal plus accrued interest).' },
    },
    {
      id: 'fund-from-treasury', covers: 'funding from Treasury', action: 'transfer', from: 'treasury', to: 'account', ccy: 'USD', amount: 150_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 150,000.00 USD from Treasury to Alpha', date: '2026-03-16' }],
        cash: { account: { USD: { settled: 200_000, availableToTrade: 200_000, availableToWithdraw: 200_000 } }, treasury: { USD: { settled: 950_000, availableToTrade: 950_000, availableToWithdraw: 950_000 } } },
        nav: { account: 49_549.31, treasury: 950_000, book: 999_549.31 },
        balance: {
          account: { cash: 200_000, assets: 200_000, liabilities: 150_450.69, netAssets: 49_549.31, internal: 50_000 },
          treasury: { cash: 950_000, assets: 950_000, netAssets: 950_000, internal: -50_000 },
          book: { cash: 1_150_000, netAssets: 999_549.31, internal: 0 },
        },
        oversight: { accounts: { account: { cashBorrowed: 150_000, fundingReceived: 50_000 } } },
      },
    },
    {
      id: 'repay-early-in-full', covers: ['close', 'repayment', 'early repayment'], action: 'repay', lot: 'loan',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repay', action: 'repay_cash', qty: 150_000, cash: -150_531.94, ccy: 'USD', financing: { amount: -150_531.94, principal: 150_000, interest: 531.94, full: true, interestThrough: '2026-03-16' } }],
          cash: { USD: { financingOut: 150_531.94, required: 150_531.94, available: 200_000, shortfall: 0 } },
        },
        result: { status: 'closed', orders: [{ kind: 'repay', action: 'repay_cash', status: 'filled', qty: 150_000, filledQty: 150_000 }] },
        events: [
          { type: 'strategy.legs_added' },
          { type: 'accrual.interest', summary: 'Interest accrued on Harborline unsecured term loan: 81.25 USD', date: '2026-03-16' }, // 531.94 - 450.69
          { type: 'loan.repayment', summary: 'Repaid 150,000.00 USD of principal on Harborline unsecured term loan (in full)', cash: { USD: -150_000 }, owner: 'account' },
          { type: 'interest.payment', summary: 'Interest paid on Harborline unsecured term loan: 531.94 USD', cash: { USD: -531.94 }, owner: 'account' },
        ],
        cash: { account: { USD: { settled: 49_468.06, availableToTrade: 49_468.06, availableToWithdraw: 49_468.06, borrowed: 0 } } }, // 200,000 - 150,000 - 531.94
        positions: [], lifecycle: [], borrowings: [],
        pnl: { account: { borrowFunding: -531.94, total: -531.94 }, book: { borrowFunding: -531.94, total: -531.94 }, treasury: { borrowFunding: 0, total: 0 } },
        nav: { account: 49_468.06, treasury: 950_000, book: 999_468.06 },
        balance: {
          account: { cash: 49_468.06, borrowed: null, accruedExpense: null, assets: 49_468.06, liabilities: 0, netAssets: 49_468.06, internal: 50_000 },
          treasury: { cash: 950_000, liabilities: 0, netAssets: 950_000 },
          book: { cash: 999_468.06, borrowed: null, accruedExpense: null, assets: 999_468.06, liabilities: 0, netAssets: 999_468.06, internal: 0, capital: 1_000_000 },
        },
        oversight: { accountBorrowings: [], treasuryOwn: [], accounts: { account: { cashBorrowed: 0, fundingReceived: 50_000 } } },
      },
    },
    {
      // 1 April, the original maturity: nothing is left to repay and nothing happens.
      id: 'original-maturity-passes', covers: 'maturity', action: 'clock', to: AT_1730('2026-04-01'),
      expect: { events: [], cash: { account: { USD: { settled: 49_468.06 } }, treasury: { USD: { settled: 950_000 } } }, nav: { account: 49_468.06, treasury: 950_000, book: 999_468.06 } },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// term_deposit
// ---------------------------------------------------------------------------------------------
// A sterling term deposit placed by Treasury, in a Book that reports in US dollars. Sterling money-market
// interest is ACT/365. The stated maturity, Friday 3 April 2026, is Good Friday and Monday 6 April is Easter
// Monday, both bank holidays in England: the deposit is paid on Tuesday 7 April, with interest to that date.
//
// Interest, by hand (ACT/365):
//   400,000 x 0.042 / 365 = 46.027397 a day; 300,000 x 0.042 / 365 = 34.520548 a day
//   2 to 18 March, 16 days on 400,000:   736.438356
//   18 March to 7 April, 20 days on 300,000: 690.410959
//   total                                  1,426.849315 -> 1,426.85 GBP
//
// Reporting currency. Every ledger entry keeps the US dollar amount at the rate in force when it was posted
// (GBP/USD 1.26 until 16 March, 1.285 after). Income is the sum of those amounts. Balances are converted at
// the current rate; the difference between the two is the FX effect:
//   interest posted: 46.03 and 460.27 at 1.26 (58.00, 579.94); 184.11, 46.03, 517.81 and 172.60 at 1.285
//   (236.58, 59.15, 665.39, 221.79). Total 1,820.85 USD.
//   From 16 March the 600,000 GBP held since the start is worth 0.025 more per pound: 15,000.00, plus the
//   same on the interest accrued by then (506.30 x 1.285 - 637.94 = 12.66).
const TERM_DEPOSIT = { owner: 'treasury', page: 'treasury', side: 'lend_cash', productId: 'term_deposit', productLabel: 'Term deposit', ccy: 'GBP', principal: 400_000, name: 'Kingsway sterling term deposit', as: 'deposit',
  terms: { loanType: 'deposit', rateType: 'fixed', rate: 0.042, dayCount: 'ACT/365', maturity: '2026-04-03', interestPayment: 'maturity', counterparty: 'Kingsway Bank' } };

const termDeposit = {
  productId: 'term_deposit',
  title: 'Sterling term deposit placed by Treasury with Kingsway Bank: 400,000 GBP at 4.20% fixed, ACT/365, to Good Friday 3 April 2026 (paid 7 April)',
  matrix: {
    ...LOAN_TICKET,
    automaticInputs: ['interest start date', 'daily interest accrual at the end-of-day run, ACT/365', 'the payment date: the stated maturity moved to the next business day of the sterling payment calendar', 'principal and interest returned at maturity', 'conversion of each entry to the reporting currency at the rate in force (GBP/USD from a labelled fixture)'],
    manualInputs: ['every term of the deposit, entered on the ticket', 'the amount of an early part withdrawal, entered in the preview'],
    settlement: 'None: the cash leaves settled sterling on the day the ticket is confirmed and returns on the payment date',
    lifecycle: 'Interest accrues daily; at maturity principal and interest are returned automatically. A maturity on a bank holiday is paid on the next business day with interest to that day. An early withdrawal, in part or in full, is allowed with interest to its date and no penalty (a break cost would be recorded by hand)',
    accounting: 'Cash lent is an asset of Treasury; interest is income, accrued daily in sterling and converted at the rate of each day; the change in the dollar value of the sterling balances is the FX effect',
    collateral: 'None',
  },
  tradedOn: 'A term deposit is not a registry instrument: it is entered on the Cash loan or deposit ticket of the Treasury page (side "Lend or deposit cash") and registers itself when the ticket is confirmed.',
  start: AT_1000('2026-03-02'),
  book: {
    name: 'Matrix term deposit', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'GBP', amount: 600_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 100_000 }] },
    settings: { fees: {}, fill: FILL, settlement: {} },
  },
  instruments: {},
  fx: { 'GBP/USD': 1.26 },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 100_000, availableToTrade: 100_000, availableToWithdraw: 100_000, borrowed: 0, lent: 0 } },
      treasury: { USD: { settled: 900_000, availableToTrade: 900_000, availableToWithdraw: 900_000, borrowed: 0, lent: 0 }, GBP: { settled: 600_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 600_000, availableToWithdraw: 600_000, borrowed: 0, lent: 0 } },
    },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 100_000, treasury: 1_656_000, book: 1_756_000 }, // 900,000 + 600,000 x 1.26; plus the Account's 100,000
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
    balance: { treasury: { cash: 1_656_000, assets: 1_656_000, liabilities: 0, netAssets: 1_656_000, local: { GBP: { cash: 600_000 } } } },
    oversight: { accountBorrowings: [], treasuryOwn: [] },
  },
  steps: [
    loanTicket('deposit-more-than-is-held', { ...TERM_DEPOSIT, as: undefined, principal: 700_000 }, {
      covers: 'open', status: 'blocked', reason: 'Treasury holds 600,000 GBP. A deposit is paid from settled cash of its own currency; nothing is converted or borrowed for it.',
      expect: { refused: 'Treasury has 600,000.00 GBP of settled GBP available to lend; 700,000.00 GBP requested.' },
    }),
    loanTicket('place', TERM_DEPOSIT, {
      covers: ['open', 'lend'],
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'loan', action: 'lend_cash', purpose: 'financing', qty: 400_000, cash: -400_000, fees: 0, ccy: 'GBP',
            dailyCost: 46.03, // 400,000 x 0.042 / 365 = 46.0274: the day's interest, on the contract's ACT/365 basis
            financing: { amount: -400_000, rateType: 'fixed', rate: 0.042, maturity: '2026-04-03', interestFrom: '2026-03-02' } }],
          cash: { GBP: { financingIn: 0, financingOut: 400_000, required: 400_000, available: 600_000, shortfall: 0, netCash: -400_000 } },
        },
        result: { status: 'open', orders: [{ kind: 'loan', action: 'lend_cash', instrument: 'deposit', status: 'filled', qty: 400_000, filledQty: 400_000 }] },
        events: [
          { type: 'strategy.submitted', owner: 'treasury' },
          { type: 'loan.placed', summary: 'Lent 400,000.00 GBP (deposit, 4.200% fixed, due 2026-04-03)', cash: { GBP: -400_000 }, owner: 'treasury', date: '2026-03-02' },
        ],
        cash: { treasury: { GBP: { settled: 200_000, availableToTrade: 200_000, availableToWithdraw: 200_000, lent: 400_000, borrowed: 0 }, USD: { settled: 900_000 } } },
        positions: [{ instrument: 'deposit', lot: 'deposit', owner: 'treasury', direction: 'lent', qty: 400_000, value: 400_000, carrying: 400_000, accrued: 0, provisional: false }],
        holdings: {},
        pending: [],
        // 3 April is Good Friday and 6 April Easter Monday: the sterling payment calendar moves the payment to Tuesday 7 April.
        lifecycle: [{ type: 'loan.maturity', instrument: 'deposit', dueDate: '2026-04-07', status: 'pending', owner: 'treasury' }],
        borrowings: [], // a deposit is lending: it is not in the borrowing register
        pnl: {
          account: { realized: 0, dividends: 0, couponInterest: 0, borrowFunding: 0, commissions: 0, fees: 0, unrealized: 0, fx: 0, total: 0 },
          treasury: { couponInterest: 0, borrowFunding: 0, fx: 0, total: 0 }, book: { couponInterest: 0, fx: 0, total: 0 },
        },
        nav: { account: 100_000, treasury: 1_656_000, book: 1_756_000 }, // placing a deposit changes no net asset value
        balance: {
          account: { cash: 100_000, assets: 100_000, liabilities: 0, netAssets: 100_000 },
          treasury: { cash: 1_152_000, lent: 504_000, accruedIncome: null, assets: 1_656_000, liabilities: 0, netAssets: 1_656_000, local: { GBP: { cash: 200_000, lent: 400_000 } } }, // 900,000 + 200,000 x 1.26; 400,000 x 1.26
          book: { cash: 1_252_000, lent: 504_000, borrowed: null, assets: 1_756_000, liabilities: 0, netAssets: 1_756_000 },
        },
        oversight: { accountBorrowings: [], treasuryOwn: [] },
      },
    }),
    {
      id: 'accrue-first-day', covers: 'interest accrual', action: 'clock', to: AT_1730('2026-03-03'),
      expect: {
        events: [{ type: 'accrual.interest', summary: 'Interest accrued on Kingsway sterling term deposit: 46.03 GBP', owner: 'treasury', date: '2026-03-03' }],
        positions: [{ instrument: 'deposit', lot: 'deposit', qty: 400_000, value: 400_000, carrying: 400_000, accrued: 46.03 }],
        pnl: { treasury: { couponInterest: 58, borrowFunding: 0, fx: 0, total: 58 }, book: { couponInterest: 58, total: 58 } }, // 46.03 x 1.26 = 57.9978
        nav: { treasury: 1_656_058, book: 1_756_058 }, // 900,000 + 600,046.03 x 1.26 = 900,000 + 756,058.00
        balance: {
          treasury: { accruedIncome: 58, assets: 1_656_058, netAssets: 1_656_058, local: { GBP: { cash: 200_000, lent: 400_000, accruedIncome: 46.03 } } },
          book: { accruedIncome: 58, assets: 1_756_058, netAssets: 1_756_058 },
        },
      },
    },
    {
      id: 'accrue-to-13-march', covers: 'interest accrual', action: 'clock', to: AT_1730('2026-03-13'), // 11 days from 2 March
      expect: {
        events: [{ type: 'accrual.interest', summary: 'Interest accrued on Kingsway sterling term deposit: 460.27 GBP' }], // 11 x 46.027397 = 506.3014 -> 506.30, less 46.03
        positions: [{ instrument: 'deposit', lot: 'deposit', qty: 400_000, accrued: 506.30 }],
        pnl: { treasury: { couponInterest: 637.94, fx: 0, total: 637.94 }, book: { couponInterest: 637.94, total: 637.94 } }, // 58.00 + 460.27 x 1.26 (579.9402)
        nav: { treasury: 1_656_637.94, book: 1_756_637.94 }, // 600,506.30 x 1.26 = 756,637.938
        balance: {
          treasury: { accruedIncome: 637.94, assets: 1_656_637.94, netAssets: 1_656_637.94, local: { GBP: { accruedIncome: 506.30 } } },
          book: { accruedIncome: 637.94, assets: 1_756_637.94, netAssets: 1_756_637.94 },
        },
      },
    },
    { id: 'monday-16-march', action: 'clock', to: AT_1000('2026-03-16'), expect: {} },
    {
      // Sterling rises from 1.26 to 1.285. Nothing is posted: the balances are worth more dollars, and that is the FX effect.
      id: 'sterling-rises', covers: 'FX effect', action: 'fx_rate', pair: 'GBP/USD', rate: 1.285,
      expect: {
        events: [],
        // Cash 200,000 and deposit 400,000, each 0.025 more per pound: 5,000 + 10,000. Accrued interest: 506.30 x 1.285 = 650.5955 against 637.94 booked: 12.6555.
        pnl: { treasury: { couponInterest: 637.94, fx: 15_012.66, total: 15_650.60 }, book: { couponInterest: 637.94, fx: 15_012.66, total: 15_650.60 }, account: { fx: 0, total: 0 } },
        nav: { account: 100_000, treasury: 1_671_650.60, book: 1_771_650.60 }, // 900,000 + 600,506.30 x 1.285 (771,650.5955)
        balance: {
          treasury: { cash: 1_157_000, lent: 514_000, accruedIncome: 650.60, assets: 1_671_650.60, netAssets: 1_671_650.60, local: { GBP: { cash: 200_000, lent: 400_000, accruedIncome: 506.30 } } }, // 900,000 + 257,000
          book: { cash: 1_257_000, lent: 514_000, accruedIncome: 650.60, assets: 1_771_650.60, netAssets: 1_771_650.60 },
        },
      },
    },
    {
      id: 'wednesday-18-march', covers: 'interest accrual', action: 'clock', to: AT_1000('2026-03-18'), // the end-of-day run of Tuesday 17 March: 15 days
      expect: {
        events: [{ type: 'accrual.interest', summary: 'Interest accrued on Kingsway sterling term deposit: 184.11 GBP' }], // 15 x 46.027397 = 690.4110 -> 690.41, less 506.30
        positions: [{ instrument: 'deposit', lot: 'deposit', qty: 400_000, accrued: 690.41 }],
        // Income 637.94 + 184.11 x 1.285 (236.58135 -> 236.58). FX effect: 15,000 + 690.41 x 1.285 (887.17685) - 874.52 = 15,012.65685.
        pnl: { treasury: { couponInterest: 874.52, fx: 15_012.66, total: 15_887.18 }, book: { couponInterest: 874.52, fx: 15_012.66, total: 15_887.18 } },
        nav: { treasury: 1_671_887.18, book: 1_771_887.18 }, // 900,000 + 600,690.41 x 1.285 (771,887.17685)
        balance: {
          treasury: { accruedIncome: 887.18, assets: 1_671_887.18, netAssets: 1_671_887.18, local: { GBP: { accruedIncome: 690.41 } } },
          book: { accruedIncome: 887.18, assets: 1_771_887.18, netAssets: 1_771_887.18 },
        },
      },
    },
    {
      // An early withdrawal of part of the deposit: allowed, with interest to today on the 400,000 held until now and no penalty.
      id: 'withdraw-part-early', covers: ['reduce', 'early withdrawal'], action: 'repay', lot: 'deposit', owner: 'treasury', amount: 100_000,
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'repay', action: 'repay_cash', purpose: 'financing', instrument: 'deposit', qty: 100_000, cash: 100_000, ccy: 'GBP', financing: { amount: 100_000, principal: 100_000, interest: 0, full: false, rate: 0.042, maturity: '2026-04-03' } }],
          cash: { GBP: { financingIn: 100_000, financingOut: 0, required: 0, available: 200_000, shortfall: 0, netCash: 100_000 } },
        },
        result: { status: 'open', orders: [{ kind: 'repay', action: 'repay_cash', status: 'filled', qty: 100_000, filledQty: 100_000 }] },
        events: [
          { type: 'strategy.legs_added', owner: 'treasury' },
          { type: 'accrual.interest', summary: 'Interest accrued on Kingsway sterling term deposit: 46.03 GBP', date: '2026-03-18' }, // 16 days: 736.4384 -> 736.44, less 690.41
          { type: 'loan.withdrawal', summary: 'Received back 100,000.00 GBP of principal on Kingsway sterling term deposit', cash: { GBP: 100_000 }, owner: 'treasury', date: '2026-03-18' },
        ],
        cash: { treasury: { GBP: { settled: 300_000, availableToTrade: 300_000, availableToWithdraw: 300_000, lent: 300_000 } } },
        positions: [{ instrument: 'deposit', lot: 'deposit', owner: 'treasury', direction: 'lent', qty: 300_000, value: 300_000, carrying: 300_000, accrued: 736.44 }],
        lifecycle: [{ type: 'loan.maturity', instrument: 'deposit', dueDate: '2026-04-07', status: 'pending', owner: 'treasury' }],
        // Income 874.52 + 46.03 x 1.285 (59.14855 -> 59.15). FX effect: 15,000 + 736.44 x 1.285 (946.3254) - 933.67 = 15,012.6554.
        pnl: { treasury: { couponInterest: 933.67, fx: 15_012.66, total: 15_946.33 }, book: { couponInterest: 933.67, fx: 15_012.66, total: 15_946.33 } },
        nav: { treasury: 1_671_946.33, book: 1_771_946.33 }, // 900,000 + 600,736.44 x 1.285 (771,946.3254)
        balance: {
          treasury: { cash: 1_285_500, lent: 385_500, accruedIncome: 946.33, assets: 1_671_946.33, netAssets: 1_671_946.33, local: { GBP: { cash: 300_000, lent: 300_000, accruedIncome: 736.44 } } }, // 900,000 + 300,000 x 1.285
          book: { cash: 1_385_500, lent: 385_500, accruedIncome: 946.33, assets: 1_771_946.33, netAssets: 1_771_946.33 },
        },
      },
    },
    {
      // Good Friday, the stated maturity. English banks are closed: nothing is paid. The end-of-day run of Thursday
      // 2 April has accrued 15 days on 300,000: 15 x 34.520548 = 517.8082; running total 1,254.2466 -> 1,254.25.
      id: 'good-friday-nothing-is-paid', covers: ['maturity', 'holiday'], action: 'clock', to: AT_1000('2026-04-03'),
      expect: {
        events: [{ type: 'accrual.interest', summary: 'Interest accrued on Kingsway sterling term deposit: 517.81 GBP', date: '2026-04-03' }],
        cash: { treasury: { GBP: { settled: 300_000, lent: 300_000 } } },
        positions: [{ instrument: 'deposit', lot: 'deposit', qty: 300_000, value: 300_000, carrying: 300_000, accrued: 1_254.25 }],
        lifecycle: [{ type: 'loan.maturity', instrument: 'deposit', dueDate: '2026-04-07', status: 'pending', owner: 'treasury' }],
        // Income 933.67 + 517.81 x 1.285 (665.38585 -> 665.39). FX effect: 15,000 + 1,254.25 x 1.285 (1,611.71125) - 1,599.06 = 15,012.65125.
        pnl: { treasury: { couponInterest: 1_599.06, fx: 15_012.65, total: 16_611.71 }, book: { couponInterest: 1_599.06, fx: 15_012.65, total: 16_611.71 } },
        nav: { treasury: 1_672_611.71, book: 1_772_611.71 }, // 900,000 + 601,254.25 x 1.285 (772,611.71125)
        balance: {
          treasury: { cash: 1_285_500, lent: 385_500, accruedIncome: 1_611.71, assets: 1_672_611.71, netAssets: 1_672_611.71, local: { GBP: { accruedIncome: 1_254.25 } } },
          book: { accruedIncome: 1_611.71, assets: 1_772_611.71, netAssets: 1_772_611.71 },
        },
      },
    },
    {
      // Easter Monday: still a bank holiday in England, and the New York stock exchange was closed on Friday, so no
      // end-of-day run has become due either. Nothing happens.
      id: 'easter-monday-nothing-is-paid', covers: 'holiday', action: 'clock', to: AT_1000('2026-04-06'),
      expect: { events: [], cash: { treasury: { GBP: { settled: 300_000, lent: 300_000 } } }, nav: { treasury: 1_672_611.71, book: 1_772_611.71 } },
    },
    {
      // Tuesday 7 April: the deposit is paid. Interest runs to the payment date: 20 days on 300,000 since 18 March,
      // 690.4110; total 736.4384 + 690.4110 = 1,426.8493 -> 1,426.85 GBP.
      id: 'paid-on-the-next-business-day', covers: ['maturity', 'close'], action: 'clock', to: AT_1000('2026-04-07'),
      expect: {
        events: [
          { type: 'accrual.interest', summary: 'Interest accrued on Kingsway sterling term deposit: 172.60 GBP', date: '2026-04-07' }, // 1,426.85 - 1,254.25
          { type: 'loan.withdrawal', summary: 'Received back 300,000.00 GBP of principal on Kingsway sterling term deposit (in full)', cash: { GBP: 300_000 }, owner: 'treasury', date: '2026-04-07' },
          { type: 'interest.payment', summary: 'Interest received on Kingsway sterling term deposit: 1,426.85 GBP', cash: { GBP: 1_426.85 }, owner: 'treasury', date: '2026-04-07' },
        ],
        cash: { treasury: { GBP: { settled: 601_426.85, availableToTrade: 601_426.85, availableToWithdraw: 601_426.85, lent: 0, borrowed: 0 }, USD: { settled: 900_000 } }, account: { USD: { settled: 100_000 } } },
        positions: [], lifecycle: [], borrowings: [],
        // Income 1,599.06 + 172.60 x 1.285 (221.791 -> 221.79) = 1,820.85.
        // FX effect: 601,426.85 x 1.285 = 772,833.50225, against the dollars booked for the same pounds:
        // 756,000 + 1,820.85 = 757,820.85. Difference 15,012.65.
        pnl: { treasury: { couponInterest: 1_820.85, borrowFunding: 0, fx: 15_012.65, total: 16_833.50 }, book: { couponInterest: 1_820.85, fx: 15_012.65, total: 16_833.50 }, account: { total: 0 } },
        nav: { account: 100_000, treasury: 1_672_833.50, book: 1_772_833.50 },
        balance: {
          treasury: { cash: 1_672_833.50, lent: null, accruedIncome: null, assets: 1_672_833.50, liabilities: 0, netAssets: 1_672_833.50, local: { GBP: { cash: 601_426.85, lent: null, accruedIncome: null } } },
          book: { cash: 1_772_833.50, lent: null, accruedIncome: null, assets: 1_772_833.50, liabilities: 0, netAssets: 1_772_833.50 },
        },
      },
    },
  ],
};

export default [unsecuredLoan, termDeposit];
