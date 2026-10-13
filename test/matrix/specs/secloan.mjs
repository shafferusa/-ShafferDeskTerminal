// Securities-loan family (engine family "secloan"): securities borrowing and lending, stock loans and bond loans. Four
// catalog products, one scenario each.
//
// None of these is a registry instrument. A borrow is the borrow leg of a short sale (the security ticket's Sell short,
// with availability and fee from the borrow fixture standing in for Shaffer MarketData) and registers itself when the sale
// is confirmed: a bond under a bond loan, a share under a stock loan, fund units (an ETF) under a securities borrowing.
// Securities are lent from the Treasury page's "Lend a security" ticket, from a position the Treasury or Account holds, and
// the contract registers itself when the ticket is confirmed.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The arithmetic is in the comment
// beside it. Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be followed):
//   - A borrow fee or lending fee accrues once a day at the end-of-day run on the market value (quantity x the day's price x
//     multiplier, the clean price for a bond), ACT/360, the running figure unrounded and the ledger trued up to its rounded
//     value. It is paid on the first business day of each month, and in full when the loan is fully returned.
//   - A borrower's cash collateral is the short sale's proceeds, held as restricted cash, topped up to the Book's collateral
//     share of the market value and marked each end of day; a further margin share is reserved from free cash. Neither is
//     buying power. A cover is paid from the restricted cash first.
//   - A lender receives cash collateral at the contract's share of the market value (the dirty value for a bond): restricted
//     cash, owed back to the borrower (a liability), marked each end of day. Securities on loan stay the lender's holding
//     (its coupon and dividends are its own: the borrower pays them over as manufactured payments) but cannot be sold.
//   - 2026: US clocks move to daylight time on 8 March (10:00 New York is 14:00 UTC from 9 March).

export const family = 'secloan';

const dst = (d) => d >= '2026-03-08' && d < '2026-11-01';
const AT_1000 = (d) => `${d}T${dst(d) ? '14' : '15'}:00:00.000Z`;
const AT_1730 = (d) => `${d}T${dst(d) ? '21' : '22'}:30:00.000Z`; // after the 17:00 end-of-day cutoff

const FILL = { halfSpreadBps: { equity: 2, bond: 3 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };

// ---------------------------------------------------------------------------------------------
// securities_borrowing
// ---------------------------------------------------------------------------------------------
// An Account sells 10,000 units of an exchange-traded fund short; the borrow leg registers a securities borrowing (fund
// units, not shares). The Book's short assumptions state cash collateral at 105% of market value and a 25% margin reserve.
// The fee accrues daily on market value, the collateral is re-marked as the price rises, 4,000 are covered and returned,
// and the lender recalls the other 6,000 with two business days' notice. They are not covered by the deadline, so the
// Terminal forces the buy-in and returns them: the borrow is closed and its fee paid.
//
// Inputs: CCLE, NYSE Arca, quoted 41.98 / 42.02, last 42.00, then 44.98 / 45.02 / 45.00 (fixtures); borrow available,
// 100,000 units, fee 0.40% a year (borrow fixture); no commission; T+1.
//   Fee: 10,000 x 42.00 x 0.004 / 360 = 4.666667 a day; at 45.00, 5.00 a day on 10,000 and 3.00 on 6,000.
//   Collateral: 1.05 x 10,000 x 42.00 = 441,000.00; at 45.00: 472,500.00; on 6,000: 283,500.00.
//   Reserve: 0.25 x 10,000 x 42.00 = 105,000.00; at 45.00: 112,500.00; on 6,000: 67,500.00.
const CCLE = { productId: 'etf', name: 'Corrigan Clean Energy ETF', symbol: 'CCLE', marketView: 'US_CASH', venue: 'NYSE Arca', venueType: 'exchange', venueCountry: 'US', issuer: 'Corrigan Fund Advisors', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} };
const BORROW_TICKET = {
  ticket: 'Instrument drawer, Trade tab: Sell short (adds the securities borrow leg; availability and fee from the borrow fixture), then Buy to cover (adds the return leg); the strategy instance\'s position Lifecycle menu for a lender recall',
  requiredFields: ['Account', 'Action (Sell short / Buy to cover)', 'Units', 'borrow assumption only when no borrow data is supplied'],
};

const securitiesBorrowing = {
  productId: 'securities_borrowing',
  title: 'Securities borrowing of 10,000 ETF units by an Account for a short sale: 105% cash collateral marked daily, fee on market value, part return, lender recall and forced buy-in',
  matrix: {
    ...BORROW_TICKET,
    automaticInputs: ['borrow availability and fee (borrow fixture standing in for Shaffer MarketData)', 'the cash collateral at 105% of market value and the 25% margin reserve (Book short settings)', 'the daily fee accrual on market value', 'the daily re-mark of the collateral', 'the forced buy-in and return when a recall deadline passes', 'the fee paid when the borrow is fully returned'],
    manualInputs: ['the lender\'s recall (quantity and business days to return), recorded with Lender recall on the borrow position'],
    settlement: 'T+1 on the US equity calendar: the sale\'s proceeds settle into restricted cash; a cover is paid from restricted cash first; collateral left over is released',
    lifecycle: 'Daily fee accrual and collateral mark; part return with a part cover; a recall sets a deadline (alert); at the deadline the uncovered short is bought in and the securities returned; the fee is paid on full return (otherwise monthly)',
    accounting: 'The borrow is one record in the borrowing register (securities, their value, the fee); the short position carries the proceeds as negative cost; the fee is a borrowing expense; realized P&L on each cover',
    collateral: 'Restricted cash = 105% of market value, marked daily; 25% margin reserve; neither is buying power; released as the short is covered',
  },
  tradedOn: 'A securities borrowing is not a registry instrument: it is the borrow leg of the Sell short action on a registered security and registers itself when the sale is confirmed. Here the security is a registered ETF (fund units, so the borrow is a securities borrowing rather than a stock loan).',
  start: AT_1000('2026-03-02'), // Monday 2 March 2026, 10:00 New York
  settlementCheck: { lag: 1, holidays: [] },
  book: {
    name: 'Matrix securities borrowing', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] },
    settings: { fees: { equity: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { equity: 1 }, short: { collateralPct: 1.05, marginPct: 0.25 } },
  },
  instruments: { etf: CCLE },
  quotes: { etf: { bid: 41.98, ask: 42.02, last: 42.00, bidSize: 100_000, askSize: 100_000 } },
  borrow: { etf: { available: true, quantity: 100_000, feeRate: 0.004 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 500_000, unsettled: 0, receivable: 0, payable: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 500_000, availableToWithdraw: 500_000, borrowed: 0, lent: 0 } },
      treasury: { USD: { settled: 500_000, availableToTrade: 500_000 } },
    },
    positions: [], holdings: {}, pending: [], openOrders: [], lifecycle: [], borrowings: [],
    nav: { account: 500_000, treasury: 500_000, book: 1_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    alerts: [],
    pnl: { account: { realized: 0, borrowFunding: 0, unrealized: 0, total: 0 }, book: { total: 0 } },
    balance: { account: { cash: 500_000, netAssets: 500_000 }, book: { netAssets: 1_000_000 } }, // the short position's value counts against assets: net assets are stated
  },
  steps: [
    {
      id: 'borrow-and-sell-short', covers: ['open', 'borrow', 'short'], action: 'ticket', ticketOf: 'equity', instrument: 'etf', side: 'sell_short', qty: 10_000, as: 'short',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [
            { kind: 'borrow_sec', action: 'borrow_sec', instrument: 'etf', qty: 10_000, borrow: { available: true, feeRate: 0.004, dailyCost: 4.67, source: 'Test fixture' } }, // 10,000 x 42.00 x 0.004 / 360
            { kind: 'trade', action: 'sell_short', instrument: 'etf', qty: 10_000, estimate: 41.98, model: 'quoted-bid-ask', settleDate: '2026-03-03', cash: 419_800, fees: 0, dependsOn: [1], // 10,000 x 41.98 (the bid)
              shortCollateral: { topUp: 20_990, marginHold: 104_950 } }, // 5% and 25% of 419,800
          ],
          cash: { USD: { restrictedProceeds: 419_800, fees: 0, collateral: 20_990, margin: 104_950, required: 125_940, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'borrow_sec', status: 'filled', filledQty: 10_000 }, { kind: 'trade', action: 'sell_short', status: 'filled', filledQty: 10_000, avgPrice: 41.98 }] },
        events: [{ type: 'strategy.submitted', owner: 'account' }, { type: 'secloan.borrow', summary: 'Borrowed 10,000 CCLE at a fee of 0.400% p.a.', owner: 'account', date: '2026-03-02' }, { type: 'trade.fill', summary: 'Sold short 10,000 CCLE @ 41.98 USD', owner: 'account', date: '2026-03-02' }],
        // Proceeds owed to the Account, arriving as restricted cash. Reserve 0.25 x 10,000 x 42.00 = 105,000.
        cash: { account: { USD: { settled: 500_000, unsettled: 419_800, receivable: 419_800, restricted: 0, reserved: 105_000, availableToTrade: 395_000, availableToWithdraw: 395_000 } } },
        positions: [
          { instrument: 'borrow:etf', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 10_000, value: 420_000, accrued: 0 }, // 10,000 x 42.00
          { instrument: 'etf', lot: 'short', owner: 'account', direction: 'short', qty: -10_000, avgCost: 41.98, cost: -419_800, price: 42.00, value: -420_000, unrealized: -200, restrictedCash: 0 },
        ],
        holdings: { etf: { long: 0, short: 10_000, net: -10_000 } },
        pending: [{ instrument: 'etf', lot: 'short', owner: 'account', dueDate: '2026-03-03', amount: 419_800, ccy: 'USD', into: 'cash.restricted' }],
        lifecycle: [{ type: 'secloan.fee', instrument: 'borrow:etf', dueDate: '2026-04-01', status: 'pending', owner: 'account' }],
        borrowings: [{ owner: 'account', family: 'secloan', type: 'Securities borrowed', instrument: 'etf', lot: 'short', qty: 10_000, value: 420_000, rate: 0.004, accrued: 0, costToDate: 0, collateralCash: null, nextPayment: '2026-04-01', term: 'open, recallable' }],
        pnl: { account: { unrealized: -200, total: -200 }, book: { total: -200 } },
        nav: { account: 499_800, book: 999_800 },
        balance: { account: { cash: 500_000, receivable: 419_800, positions: -420_000, netAssets: 499_800 }, book: { netAssets: 999_800 } },
      },
    },
    {
      // The proceeds settle into restricted cash and the collateral is marked to 105%: 441,000 - 419,800 = 21,200 posted.
      id: 'sale-settles', covers: ['settlement', 'collateral'], action: 'clock', to: AT_1000('2026-03-03'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: /received 419,800\.00 USD into restricted cash/, owner: 'account', date: '2026-03-03' },
          { type: 'collateral.mark', summary: 'Short collateral on CCLE marked to market: posted 21,200.00 USD', cash: { USD: -21_200 }, owner: 'account', date: '2026-03-03' },
        ],
        cash: { account: { USD: { settled: 478_800, unsettled: 0, receivable: 0, restricted: 441_000, reserved: 105_000, availableToTrade: 373_800, availableToWithdraw: 373_800 } } },
        positions: [
          { instrument: 'borrow:etf', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 10_000, value: 420_000, accrued: 0 },
          { instrument: 'etf', lot: 'short', owner: 'account', direction: 'short', qty: -10_000, avgCost: 41.98, cost: -419_800, price: 42.00, value: -420_000, unrealized: -200, restrictedCash: 441_000 },
        ],
        pending: [],
        borrowings: [{ owner: 'account', family: 'secloan', type: 'Securities borrowed', instrument: 'etf', lot: 'short', qty: 10_000, value: 420_000, rate: 0.004, accrued: 0, costToDate: 0, collateralCash: 441_000, nextPayment: '2026-04-01', term: 'open, recallable' }],
        balance: { account: { cash: 478_800, restricted: 441_000, receivable: null, positions: -420_000, netAssets: 499_800 } },
      },
    },
    {
      id: 'fee-day-one', covers: 'borrow fee', action: 'clock', to: AT_1730('2026-03-03'),
      expect: {
        events: [{ type: 'accrual.fee', summary: 'Borrow fee accrued on 10,000 CCLE: 4.67 USD', owner: 'account', date: '2026-03-03' }], // 10,000 x 42.00 x 0.004 / 360
        positions: [
          { instrument: 'borrow:etf', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 10_000, value: 420_000, accrued: -4.67 },
          { instrument: 'etf', lot: 'short', owner: 'account', direction: 'short', qty: -10_000, avgCost: 41.98, cost: -419_800, price: 42.00, value: -420_000, unrealized: -200, restrictedCash: 441_000 },
        ],
        borrowings: [{ owner: 'account', family: 'secloan', type: 'Securities borrowed', instrument: 'etf', lot: 'short', qty: 10_000, value: 420_000, rate: 0.004, accrued: 4.67, costToDate: 4.67, collateralCash: 441_000, nextPayment: '2026-04-01', term: 'open, recallable' }],
        pnl: { account: { borrowFunding: -4.67, total: -204.67 }, book: { total: -204.67 } },
        nav: { account: 499_795.33, book: 999_795.33 },
        balance: { account: { accruedExpense: 4.67, netAssets: 499_795.33 }, book: { netAssets: 999_795.33 } },
      },
    },
    { id: 'wednesday-morning', action: 'clock', to: AT_1000('2026-03-04'), expect: { events: [] } },
    {
      id: 'price-rises', covers: 'market value changes', action: 'quote', instrument: 'etf', quote: { bid: 44.98, ask: 45.02, last: 45.00, bidSize: 100_000, askSize: 100_000 },
      expect: {
        events: [],
        positions: [
          { instrument: 'borrow:etf', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 10_000, value: 450_000, accrued: -4.67 },
          { instrument: 'etf', lot: 'short', owner: 'account', direction: 'short', qty: -10_000, avgCost: 41.98, cost: -419_800, price: 45.00, value: -450_000, unrealized: -30_200, restrictedCash: 441_000 }, // -450,000 + 419,800
        ],
        borrowings: [{ owner: 'account', family: 'secloan', type: 'Securities borrowed', instrument: 'etf', lot: 'short', qty: 10_000, value: 450_000, rate: 0.004, accrued: 4.67, costToDate: 4.67, collateralCash: 441_000, nextPayment: '2026-04-01', term: 'open, recallable' }],
        pnl: { account: { unrealized: -30_200, total: -30_204.67 }, book: { total: -30_204.67 } },
        nav: { account: 469_795.33, book: 969_795.33 },
        balance: { account: { positions: -450_000, netAssets: 469_795.33 }, book: { netAssets: 969_795.33 } },
      },
    },
    {
      // The run of 4 March: a day's fee at 45.00, 5.00 (4.666667 + 5.00 = 9.666667 -> 9.67); the collateral re-marked to
      // 1.05 x 450,000 = 472,500, 31,500 posted from settled cash; the reserve reset to 0.25 x 450,000 = 112,500.
      id: 'collateral-re-marked', covers: ['borrow fee', 'collateral mark'], action: 'clock', to: AT_1730('2026-03-04'),
      expect: {
        events: [
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 10,000 CCLE: 5.00 USD', owner: 'account', date: '2026-03-04' },
          { type: 'collateral.mark', summary: 'Short collateral on CCLE marked to market: posted 31,500.00 USD', cash: { USD: -31_500 }, owner: 'account', date: '2026-03-04' },
        ],
        cash: { account: { USD: { settled: 447_300, restricted: 472_500, reserved: 112_500, availableToTrade: 334_800, availableToWithdraw: 334_800 } } },
        positions: [
          { instrument: 'borrow:etf', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 10_000, value: 450_000, accrued: -9.67 },
          { instrument: 'etf', lot: 'short', owner: 'account', direction: 'short', qty: -10_000, avgCost: 41.98, cost: -419_800, price: 45.00, value: -450_000, unrealized: -30_200, restrictedCash: 472_500 },
        ],
        borrowings: [{ owner: 'account', family: 'secloan', type: 'Securities borrowed', instrument: 'etf', lot: 'short', qty: 10_000, value: 450_000, rate: 0.004, accrued: 9.67, costToDate: 9.67, collateralCash: 472_500, nextPayment: '2026-04-01', term: 'open, recallable' }],
        pnl: { account: { borrowFunding: -9.67, total: -30_209.67 }, book: { total: -30_209.67 } },
        nav: { account: 469_790.33, book: 969_790.33 },
        balance: { account: { cash: 447_300, restricted: 472_500, accruedExpense: 9.67, netAssets: 469_790.33 }, book: { netAssets: 969_790.33 } },
      },
    },
    { id: 'thursday-morning', action: 'clock', to: AT_1000('2026-03-05'), expect: { events: [] } },
    {
      // 4,000 covered at the ask, 45.02, and returned. The fee is brought to today on the 10,000 still out until now: one day
      // at 45.00, 5.00 (14.666667 -> 14.67). Realized: 4,000 x (41.98 - 45.02) = -12,160.00.
      id: 'cover-and-return-part', covers: ['reduce', 'cover', 'part return'], action: 'ticket', ticketOf: 'equity', instrument: 'etf', side: 'buy_to_cover', qty: 4_000, from: 'short',
      expect: {
        preview: { blocking: 0, errors: [], legs: [
          { kind: 'trade', action: 'buy_to_cover', instrument: 'etf', qty: 4_000, estimate: 45.02, settleDate: '2026-03-06', cash: -180_080, fees: 0 }, // 4,000 x 45.02
          { kind: 'return_sec', action: 'return_sec', qty: 4_000, dependsOn: [1] },
        ] },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy_to_cover', status: 'filled', filledQty: 4_000, avgPrice: 45.02 }, { kind: 'return_sec', status: 'filled', filledQty: 4_000 }] },
        events: [
          { type: 'strategy.legs_added', owner: 'account' },
          { type: 'trade.fill', summary: /^Bought to cover 4,000 CCLE @ 45\.02 USD/, owner: 'account', date: '2026-03-05' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 10,000 CCLE: 5.00 USD', owner: 'account', date: '2026-03-05' },
          { type: 'secloan.return', summary: 'Returned 4,000 borrowed CCLE', owner: 'account', date: '2026-03-05' },
        ],
        // Owed for the cover 180,080 (from restricted cash at settlement). Reserve 0.25 x 6,000 x 45.00 = 67,500.
        cash: { account: { USD: { settled: 447_300, unsettled: -180_080, payable: 180_080, restricted: 472_500, reserved: 67_500, availableToTrade: 199_720, availableToWithdraw: 199_720 } } }, // 447,300 - 180,080 - 67,500
        positions: [
          { instrument: 'borrow:etf', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 6_000, value: 270_000, accrued: -14.67 }, // 6,000 x 45.00
          { instrument: 'etf', lot: 'short', owner: 'account', direction: 'short', qty: -6_000, avgCost: 41.98, cost: -251_880, price: 45.00, value: -270_000, unrealized: -18_120, restrictedCash: 472_500 }, // -270,000 + 251,880
        ],
        holdings: { etf: { long: 0, short: 6_000, net: -6_000 } },
        pending: [{ instrument: 'etf', lot: 'short', owner: 'account', dueDate: '2026-03-06', amount: -180_080, ccy: 'USD', into: 'cash.restricted' }],
        borrowings: [{ owner: 'account', family: 'secloan', type: 'Securities borrowed', instrument: 'etf', lot: 'short', qty: 6_000, value: 270_000, rate: 0.004, accrued: 14.67, costToDate: 14.67, collateralCash: 472_500, nextPayment: '2026-04-01', term: 'open, recallable' }],
        pnl: { account: { realized: -12_160, borrowFunding: -14.67, unrealized: -18_120, total: -30_294.67 }, book: { total: -30_294.67 } },
        nav: { account: 469_705.33, book: 969_705.33 },
        balance: { account: { cash: 447_300, restricted: 472_500, positions: -270_000, payable: 180_080, accruedExpense: 14.67, netAssets: 469_705.33 }, book: { netAssets: 969_705.33 } },
      },
    },
    {
      // The lender recalls the 6,000 still borrowed, with two business days' notice: due back Monday 9 March.
      id: 'lender-recalls', covers: ['recall'], action: 'lifecycle', lot: 'short', instrument: 'borrow:etf', body: { action: 'recall', qty: 6_000, days: 2 },
      expect: {
        events: [{ type: 'secloan.recall_notice', summary: 'Lender recalled 6,000 CCLE; due back by 2026-03-09', owner: 'account', date: '2026-03-05' }],
        positions: [
          { instrument: 'borrow:etf', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 6_000, value: 270_000, accrued: -14.67, recall: { qty: 6_000, dueDate: '2026-03-09' } },
          { instrument: 'etf', lot: 'short', owner: 'account', direction: 'short', qty: -6_000, avgCost: 41.98, cost: -251_880, price: 45.00, value: -270_000, unrealized: -18_120, restrictedCash: 472_500 },
        ],
        lifecycle: [{ type: 'secloan.recall', instrument: 'borrow:etf', dueDate: '2026-03-09', status: 'pending', owner: 'account' }, { type: 'secloan.fee', instrument: 'borrow:etf', dueDate: '2026-04-01', status: 'pending', owner: 'account' }],
        // The recall deadline is now the next item on the record.
        borrowings: [{ owner: 'account', family: 'secloan', type: 'Securities borrowed', instrument: 'etf', lot: 'short', qty: 6_000, value: 270_000, rate: 0.004, accrued: 14.67, costToDate: 14.67, collateralCash: 472_500, nextPayment: '2026-03-09', term: 'open, recallable' }],
        alerts: ['secloan.recalled'],
      },
    },
    {
      // Friday: the cover is paid from restricted cash (472,500 - 180,080 = 292,420 left) and the run of 5 March marks the
      // collateral to 1.05 x 6,000 x 45.00 = 283,500: 8,920 released. The fee already stands at 5 March.
      id: 'cover-settles', covers: ['settlement', 'collateral mark'], action: 'clock', to: AT_1000('2026-03-06'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: /paid 180,080\.00 USD from restricted cash/, owner: 'account', date: '2026-03-06' },
          { type: 'collateral.mark', summary: 'Short collateral on CCLE marked to market: released 8,920.00 USD', cash: { USD: 8_920 }, owner: 'account', date: '2026-03-06' },
        ],
        cash: { account: { USD: { settled: 456_220, unsettled: 0, payable: 0, restricted: 283_500, reserved: 67_500, availableToTrade: 388_720, availableToWithdraw: 388_720 } } },
        positions: [
          { instrument: 'borrow:etf', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 6_000, value: 270_000, accrued: -14.67, recall: { qty: 6_000, dueDate: '2026-03-09' } },
          { instrument: 'etf', lot: 'short', owner: 'account', direction: 'short', qty: -6_000, avgCost: 41.98, cost: -251_880, price: 45.00, value: -270_000, unrealized: -18_120, restrictedCash: 283_500 },
        ],
        pending: [],
        borrowings: [{ owner: 'account', family: 'secloan', type: 'Securities borrowed', instrument: 'etf', lot: 'short', qty: 6_000, value: 270_000, rate: 0.004, accrued: 14.67, costToDate: 14.67, collateralCash: 283_500, nextPayment: '2026-03-09', term: 'open, recallable' }],
        balance: { account: { cash: 456_220, restricted: 283_500, payable: null, netAssets: 469_705.33 } },
      },
    },
    {
      // Monday 9 March, the deadline: the short is still open, so the Terminal places the buy-in (a market buy to cover of 6,000
      // and the return of 6,000). The run of Friday 6 March accrues a day's fee on 6,000 at 45.00: 3.00 (17.666667 -> 17.67).
      id: 'deadline-forces-the-buy-in', covers: ['recall deadline', 'forced buy-in'], action: 'clock', to: AT_1000('2026-03-09'),
      expect: {
        events: [
          { type: 'secloan.buy_in', summary: 'Recall deadline reached: forced buy-in of 6,000 CCLE and return of 6,000 borrowed securities', owner: 'account', date: '2026-03-09' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 6,000 CCLE: 3.00 USD', owner: 'account', date: '2026-03-09' },
        ],
        positions: [
          { instrument: 'borrow:etf', lot: 'short', owner: 'account', direction: 'securities borrowed', qty: 6_000, value: 270_000, accrued: -17.67, recall: { qty: 6_000, dueDate: '2026-03-09' } },
          { instrument: 'etf', lot: 'short', owner: 'account', direction: 'short', qty: -6_000, avgCost: 41.98, cost: -251_880, price: 45.00, value: -270_000, unrealized: -18_120, restrictedCash: 283_500 },
        ],
        lifecycle: [{ type: 'secloan.fee', instrument: 'borrow:etf', dueDate: '2026-04-01', status: 'pending', owner: 'account' }],
        borrowings: [{ owner: 'account', family: 'secloan', type: 'Securities borrowed', instrument: 'etf', lot: 'short', qty: 6_000, value: 270_000, rate: 0.004, accrued: 17.67, costToDate: 17.67, collateralCash: 283_500, nextPayment: '2026-04-01', term: 'open, recallable' }],
        pnl: { account: { borrowFunding: -17.67, total: -30_297.67 }, book: { total: -30_297.67 } },
        nav: { account: 469_702.33, book: 969_702.33 },
        balance: { account: { accruedExpense: 17.67, netAssets: 469_702.33 }, book: { netAssets: 969_702.33 } },
      },
    },
    {
      // The next cycle fills the buy-in at the ask, 45.02: 270,120; realized 6,000 x (41.98 - 45.02) = -18,240. The return
      // brings the fee to today (three days, 6 to 9 March, on 6,000 at 45.00: 9.00; 26.666667 -> 26.67) and, the borrow being
      // fully returned, pays it: 26.67.
      id: 'buy-in-fills-and-returns', covers: ['forced buy-in', 'full return', 'close', 'borrow fee'], action: 'cycle',
      expect: {
        events: [
          { type: 'trade.fill', summary: /^Bought to cover 6,000 CCLE @ 45\.02 USD/, owner: 'account', date: '2026-03-09' },
          { type: 'accrual.fee', summary: 'Borrow fee accrued on 6,000 CCLE: 9.00 USD', owner: 'account', date: '2026-03-09' },
          { type: 'secloan.return', summary: 'Returned 6,000 borrowed CCLE', owner: 'account', date: '2026-03-09' },
          { type: 'interest.payment', summary: /^Borrow fee paid on Borrow of CCLE.*: 26\.67 USD$/, cash: { USD: -26.67 }, owner: 'account', date: '2026-03-09' },
        ],
        cash: { account: { USD: { settled: 456_193.33, unsettled: -270_120, payable: 270_120, restricted: 283_500, reserved: 0, availableToTrade: 186_073.33, availableToWithdraw: 186_073.33 } } }, // 456,220 - 26.67; less 270,120 owed
        positions: [], holdings: { etf: null },
        pending: [{ instrument: 'etf', lot: 'short', owner: 'account', dueDate: '2026-03-10', amount: -270_120, ccy: 'USD', into: 'cash.restricted' }],
        lifecycle: [], borrowings: [], alerts: [],
        pnl: { account: { realized: -30_400, borrowFunding: -26.67, unrealized: 0, total: -30_426.67 }, book: { total: -30_426.67 } }, // -12,160 - 18,240
        nav: { account: 469_573.33, book: 969_573.33 },
        balance: { account: { cash: 456_193.33, restricted: 283_500, positions: null, payable: 270_120, accruedExpense: null, netAssets: 469_573.33 }, book: { netAssets: 969_573.33 } },
      },
    },
    {
      // The buy-in settles from restricted cash; the 13,380 left (283,500 - 270,120) is released: nothing restricted remains.
      id: 'buy-in-settles', covers: ['settlement', 'collateral release'], action: 'clock', to: AT_1000('2026-03-10'),
      expect: {
        events: [
          { type: 'settlement.pay', summary: /paid 270,120\.00 USD from restricted cash/, owner: 'account', date: '2026-03-10' },
          { type: 'collateral.mark', summary: 'Short collateral on CCLE marked to market: released 13,380.00 USD', cash: { USD: 13_380 }, owner: 'account', date: '2026-03-10' },
        ],
        cash: { account: { USD: { settled: 469_573.33, unsettled: 0, payable: 0, restricted: 0, reserved: 0, availableToTrade: 469_573.33, availableToWithdraw: 469_573.33, borrowed: 0 } } },
        pending: [],
        balance: { account: { cash: 469_573.33, restricted: null, payable: null, assets: 469_573.33, liabilities: 0, netAssets: 469_573.33 }, book: { netAssets: 969_573.33 } },
      },
    },
  ],
};

export default [securitiesBorrowing];
