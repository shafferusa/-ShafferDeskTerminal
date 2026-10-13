// FX family (engine family "fx"): spot currency pairs, traded on the pair's own ticket in the instrument drawer.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The arithmetic is in
// the comment beside it. Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be followed):
//   - A spot FX trade is a conversion between two currency balances of the trading owner; it creates no position.
//     The quantity is the base-currency amount; the quote-currency amount is quantity x rate. "Buy <base>" pays the
//     quote currency at the ask; "Sell <base>" receives it at the bid.
//   - Value date (server/quant/calendar.js fxValueDate): the pair's lag (2, or 1 for a pair whose convention is T+1)
//     in days that are business days for both currencies (US dollar holidays do not interrupt the count), and the
//     value date itself must be a business day for both currencies and for the US dollar.
//   - Both currency amounts stay pending (a receivable and a payable) until the value date. The currency bought is
//     buying power at once but cannot be withdrawn; the currency sold is committed. Available to withdraw is settled
//     cash less committed payables (so it can be negative when a payable will be met by a receivable of that date).
//   - The pair trades on the global FX market, Monday to Friday: a bank holiday of one currency moves value dates;
//     it does not stop the trade (Showa Day, a Tokyo holiday, below).
//   - Reporting figures: every entry carries its USD amount at the rate in force when posted. Rate fixtures EUR/USD
//     1.10, GBP/USD 1.27, USD/JPY 150, USD/CAD 1.25 throughout, so the FX effect is the dealing cost of each
//     conversion: the USD value at the fixture rate of what was sold, less that of what was bought.
//   - Holidays used: Wednesday 29 April 2026 (Showa Day, JP); Friday 1 May (TARGET2 closed); Monday 4 May (UK Early
//     May bank holiday; also JP); Tuesday 5 May (JP). No US dollar or Canadian holiday falls in 28 April to 6 May.

export const family = 'fx';

const FILL = { halfSpreadBps: { fx: 0.5 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
// Symbols are written without the slash (USDJPY): the demo feed seeds its own USD/JPY pair, and the scenario's pairs must
// not be confused with it on the Marketplace.
const pair = (base, quote, settleDays = 2) => ({ productId: 'fx_spot', name: `${base}/${quote} spot`, symbol: `${base}${quote}`, marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: quote, terms: { base, quote, settleDays } });
const AT = (date) => `${date}T14:00:00.000Z`; // 10:00 New York (daylight time)

// ---------------------------------------------------------------------------------------------
// fx_spot
// ---------------------------------------------------------------------------------------------
const fxSpot = {
  productId: 'fx_spot',
  title: 'Spot FX in three pairs: USD/CAD (T+1), EUR/GBP cross over TARGET2 and UK holidays, USD/JPY on a Tokyo holiday; both directions',
  matrix: {
    ticket: 'Instrument drawer of the pair, Trade tab: trading owner, "Buy <base>" or "Sell <base>", base-currency amount; then the trade preview (the same trade as Convert currency on the Treasury and Account pages)',
    requiredFields: ['Account (trading owner)', 'Action (Buy or Sell the base currency)', 'Base-currency amount'],
    automaticInputs: ['rate: bid or ask of the pair quote (fixture standing in for Shaffer MarketData)', 'value date from the pair lag and both currencies\' payment calendars plus the US dollar', 'USD amount of every entry at the rate in force (FX fixtures)'],
    manualInputs: ['none'],
    settlement: 'Both currencies on the value date: T+2 on the joint calendar (T+1 for USD/CAD); pending pay and receive legs until then',
    lifecycle: 'None beyond settlement; the pair trades Monday to Friday whatever the holidays of one currency',
    accounting: 'No position; the receivable and payable of each currency until value date; FX effect = dealing cost of each conversion (and translation, nil here as rates are fixed); unsettled currency not withdrawable',
    collateral: 'None',
  },
  start: AT('2026-04-28'), // Tuesday 28 April 2026, 10:00 New York
  settlementCheck: false, // value dates follow two currency calendars; each is worked out by hand below
  book: {
    name: 'Matrix spot FX', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'EUR', amount: 200_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }, { ccy: 'EUR', amount: 200_000 }] },
    settings: { fees: { fx: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { fx: 2 } },
  },
  fx: { 'EUR/USD': 1.10, 'GBP/USD': 1.27, 'USD/JPY': 150, 'USD/CAD': 1.25 },
  instruments: { usdcad: pair('USD', 'CAD', 1), eurgbp: pair('EUR', 'GBP'), usdjpy: pair('USD', 'JPY') },
  quotes: {
    usdcad: { bid: 1.2498, ask: 1.2502, last: 1.25, bidSize: 10_000_000, askSize: 10_000_000 },
    eurgbp: { bid: 0.8660, ask: 0.8663, last: 0.86615, bidSize: 10_000_000, askSize: 10_000_000 },
    usdjpy: { bid: 149.70, ask: 149.75, last: 149.725, bidSize: 10_000_000, askSize: 10_000_000 },
  },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 }, EUR: { settled: 200_000, unsettled: 0, availableToTrade: 200_000, availableToWithdraw: 200_000 } },
      treasury: { USD: { settled: 500_000 } },
    },
    positions: [], pending: [], openOrders: [], borrowings: [],
    nav: { account: 720_000, treasury: 500_000, book: 1_220_000 }, // 500,000 + 200,000 x 1.10
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    pnl: { account: { fx: 0, total: 0 }, book: { fx: 0, total: 0 } },
    balance: { account: { cash: 720_000, assets: 720_000, liabilities: 0, netAssets: 720_000 } },
  },
  steps: [
    {
      id: 'sell-usd-for-cad-t1', covers: ['open', 'sell base', 'settlement'], action: 'ticket', instrument: 'usdcad', side: 'sell', qty: 100_000, as: 'cad1',
      expect: {
        preview: {
          blocking: 0, errors: [],
          // USD/CAD settles T+1 by convention: Wednesday 29 April (CAD and USD open).
          legs: [{ kind: 'trade', action: 'sell', instrument: 'usdcad', qty: 100_000, estimate: 1.2498, model: 'quoted-bid-ask', settleDate: '2026-04-29', fees: 0,
            cash: 124_980, // 100,000 USD x 1.2498 (the bid) = 124,980 CAD received
            otherCash: { USD: -100_000 } }],
          cash: { CAD: { proceeds: 124_980 }, USD: { purchases: 100_000 } },
        },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 100_000, avgPrice: 1.2498 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'fx.conversion', summary: 'FX conversion: sold 100,000.00 USD against 124,980.00 CAD at 1.2498', owner: 'account', date: '2026-04-28' }],
        cash: { account: {
          USD: { settled: 500_000, unsettled: -100_000, availableToTrade: 400_000, availableToWithdraw: 400_000 },
          CAD: { settled: 0, unsettled: 124_980, availableToTrade: 124_980, availableToWithdraw: 0 },
        } },
        pending: [
          { instrument: 'usdcad', lot: 'cad1', owner: 'account', dueDate: '2026-04-29', amount: -100_000, ccy: 'USD', into: 'cash' },
          { instrument: 'usdcad', lot: 'cad1', owner: 'account', dueDate: '2026-04-29', amount: 124_980, ccy: 'CAD', into: 'cash' },
        ],
        pnl: { account: { fx: -16, total: -16 }, book: { fx: -16, total: -16 } }, // 124,980 CAD / 1.25 = 99,984; less 100,000 USD sold
        nav: { account: 719_984, book: 1_219_984 },
        balance: { account: { cash: 720_000, receivable: 99_984, payable: 100_000, assets: 819_984, liabilities: 100_000, netAssets: 719_984,
          local: { USD: { cash: 500_000, payable: 100_000 }, EUR: { cash: 200_000 }, CAD: { receivable: 124_980 } } } },
      },
    },
    {
      id: 'value-date-t1', covers: 'settlement', action: 'clock', to: AT('2026-04-29'), // Wednesday 29 April (Showa Day in Tokyo)
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 124,980.00 CAD into settled cash', cash: { CAD: 124_980 }, date: '2026-04-29' },
          { type: 'settlement.pay', summary: 'paid 100,000.00 USD from settled cash', cash: { USD: -100_000 }, date: '2026-04-29' },
        ],
        cash: { account: {
          USD: { settled: 400_000, unsettled: 0, availableToTrade: 400_000, availableToWithdraw: 400_000 },
          CAD: { settled: 124_980, unsettled: 0, availableToTrade: 124_980, availableToWithdraw: 124_980 },
        } },
        pending: [],
        balance: { account: { cash: 719_984, receivable: null, payable: null, assets: 719_984, liabilities: 0, netAssets: 719_984, // 400,000 + 220,000 + 99,984
          local: { USD: { cash: 400_000, payable: null }, CAD: { cash: 124_980, receivable: null } } } },
      },
    },
    {
      id: 'sell-eur-for-gbp-over-holidays', covers: ['open', 'sell base', 'cross'], action: 'ticket', instrument: 'eurgbp', side: 'sell', qty: 100_000, as: 'gbp1',
      expect: {
        preview: {
          blocking: 0, errors: [],
          // T+2 from Wednesday 29 April counts days open in TARGET2 and London: Thursday 30 April (1); Friday 1 May is a
          // TARGET2 closing day, Monday 4 May a UK bank holiday; Tuesday 5 May (2). The value date moves from 1 to 5 May.
          legs: [{ kind: 'trade', action: 'sell', instrument: 'eurgbp', qty: 100_000, estimate: 0.8660, model: 'quoted-bid-ask', settleDate: '2026-05-05', fees: 0,
            cash: 86_600, // 100,000 EUR x 0.8660 = 86,600 GBP
            otherCash: { EUR: -100_000 } }],
          cash: { GBP: { proceeds: 86_600 }, EUR: { purchases: 100_000 } },
        },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 100_000, avgPrice: 0.866 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'fx.conversion', summary: 'FX conversion: sold 100,000.00 EUR against 86,600.00 GBP at 0.866', owner: 'account', date: '2026-04-29' }],
        cash: { account: {
          EUR: { settled: 200_000, unsettled: -100_000, availableToTrade: 100_000, availableToWithdraw: 100_000 },
          GBP: { settled: 0, unsettled: 86_600, availableToTrade: 86_600, availableToWithdraw: 0 },
        } },
        pending: [
          { instrument: 'eurgbp', lot: 'gbp1', owner: 'account', dueDate: '2026-05-05', amount: -100_000, ccy: 'EUR', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp1', owner: 'account', dueDate: '2026-05-05', amount: 86_600, ccy: 'GBP', into: 'cash' },
        ],
        pnl: { account: { fx: -34, total: -34 }, book: { fx: -34, total: -34 } }, // 86,600 x 1.27 = 109,982 for 100,000 x 1.10 = 110,000: -18; -16 - 18
        nav: { account: 719_966, book: 1_219_966 },
        balance: { account: { cash: 719_984, receivable: 109_982, payable: 110_000, assets: 829_966, liabilities: 110_000, netAssets: 719_966,
          local: { EUR: { cash: 200_000, payable: 100_000 }, GBP: { receivable: 86_600 } } } },
      },
    },
    {
      id: 'sell-usd-for-jpy-on-tokyo-holiday', covers: ['open', 'sell base'], action: 'ticket', instrument: 'usdjpy', side: 'sell', qty: 50_000, as: 'jpy1',
      expect: {
        preview: {
          blocking: 0, errors: [], warnings: [], // no "market closed" warning: the pair trades on Showa Day
          // Counting yen days from 29 April: Thursday 30 April (1), Friday 1 May (2); also a dollar day: value 1 May.
          legs: [{ kind: 'trade', action: 'sell', instrument: 'usdjpy', qty: 50_000, estimate: 149.70, model: 'quoted-bid-ask', settleDate: '2026-05-01', fees: 0,
            cash: 7_485_000, // 50,000 USD x 149.70 = 7,485,000 JPY
            otherCash: { USD: -50_000 } }],
          cash: { JPY: { proceeds: 7_485_000 }, USD: { purchases: 50_000 } },
        },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 50_000, avgPrice: 149.70, fills: [{ qty: 50_000, price: 149.70, model: 'quoted-bid-ask', settleDate: '2026-05-01', source: 'Test fixture', status: 'simulated', date: '2026-04-29' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'fx.conversion', summary: 'FX conversion: sold 50,000.00 USD against 7,485,000 JPY at 149.70', owner: 'account', date: '2026-04-29' }],
        cash: { account: {
          USD: { settled: 400_000, unsettled: -50_000, availableToTrade: 350_000, availableToWithdraw: 350_000 },
          JPY: { settled: 0, unsettled: 7_485_000, availableToTrade: 7_485_000, availableToWithdraw: 0 },
        } },
        pending: [
          { instrument: 'usdjpy', lot: 'jpy1', owner: 'account', dueDate: '2026-05-01', amount: -50_000, ccy: 'USD', into: 'cash' },
          { instrument: 'usdjpy', lot: 'jpy1', owner: 'account', dueDate: '2026-05-01', amount: 7_485_000, ccy: 'JPY', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp1', owner: 'account', dueDate: '2026-05-05', amount: -100_000, ccy: 'EUR', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp1', owner: 'account', dueDate: '2026-05-05', amount: 86_600, ccy: 'GBP', into: 'cash' },
        ],
        pnl: { account: { fx: -134, total: -134 }, book: { fx: -134, total: -134 } }, // 7,485,000 / 150 = 49,900 for 50,000: -100
        nav: { account: 719_866, book: 1_219_866 },
        balance: { account: { cash: 719_984, receivable: 159_882, payable: 160_000, assets: 879_866, liabilities: 160_000, netAssets: 719_866, // 109,982 + 49,900; 110,000 + 50,000
          local: { USD: { cash: 400_000, payable: 50_000 }, JPY: { receivable: 7_485_000 } } } },
      },
    },
    {
      id: 'buy-eur-with-gbp', covers: ['open', 'buy base', 'cross'], action: 'ticket', instrument: 'eurgbp', side: 'buy', qty: 50_000, as: 'gbp2',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'eurgbp', qty: 50_000, estimate: 0.8663, model: 'quoted-bid-ask', settleDate: '2026-05-05', fees: 0,
            cash: -43_315, // 50,000 EUR x 0.8663 (the ask) = 43,315 GBP paid
            otherCash: { EUR: 50_000 } }],
          // Paid from sterling not yet settled: the 86,600 GBP receivable is buying power.
          cash: { GBP: { purchases: 43_315, required: 43_315, available: 86_600, shortfall: 0 }, EUR: { proceeds: 50_000 } },
        },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 50_000, avgPrice: 0.8663 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'fx.conversion', summary: 'FX conversion: bought 50,000.00 EUR against 43,315.00 GBP at 0.8663', owner: 'account', date: '2026-04-29' }],
        cash: { account: {
          EUR: { settled: 200_000, unsettled: -50_000, availableToTrade: 150_000, availableToWithdraw: 100_000 }, // receivable 50,000 less payable 100,000; settled less payable
          GBP: { settled: 0, unsettled: 43_285, availableToTrade: 43_285, availableToWithdraw: -43_315 }, // 86,600 - 43,315; settled 0 less payable 43,315
        } },
        pending: [
          { instrument: 'usdjpy', lot: 'jpy1', owner: 'account', dueDate: '2026-05-01', amount: -50_000, ccy: 'USD', into: 'cash' },
          { instrument: 'usdjpy', lot: 'jpy1', owner: 'account', dueDate: '2026-05-01', amount: 7_485_000, ccy: 'JPY', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp1', owner: 'account', dueDate: '2026-05-05', amount: -100_000, ccy: 'EUR', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp2', owner: 'account', dueDate: '2026-05-05', amount: -43_315, ccy: 'GBP', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp2', owner: 'account', dueDate: '2026-05-05', amount: 50_000, ccy: 'EUR', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp1', owner: 'account', dueDate: '2026-05-05', amount: 86_600, ccy: 'GBP', into: 'cash' },
        ],
        pnl: { account: { fx: -144.05, total: -144.05 }, book: { fx: -144.05, total: -144.05 } }, // 50,000 x 1.10 = 55,000 for 43,315 x 1.27 = 55,010.05: -10.05
        nav: { account: 719_855.95, book: 1_219_855.95 },
        balance: { account: { cash: 719_984, receivable: 214_882, payable: 215_010.05, assets: 934_866, liabilities: 215_010.05, netAssets: 719_855.95, // + 55,000; + 55,010.05
          local: { EUR: { cash: 200_000, receivable: 50_000, payable: 100_000 }, GBP: { receivable: 86_600, payable: 43_315 } } } },
      },
    },
    {
      id: 'buy-eur-gbp-short', covers: 'buy base', action: 'ticket', instrument: 'eurgbp', side: 'buy', qty: 60_000,
      status: 'blocked', reason: '60,000 EUR at 0.8663 needs 51,978 GBP; only 43,285 GBP is available to trade.',
      expect: { refused: 'Alpha is short 8,693.00 GBP: the package needs 51,978.00 GBP' }, // 60,000 x 0.8663 = 51,978; less 43,285
    },
    {
      id: 'yen-value-date', covers: 'settlement', action: 'clock', to: AT('2026-05-01'), // Friday 1 May
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 7,485,000 JPY into settled cash', cash: { JPY: 7_485_000 }, date: '2026-05-01' },
          { type: 'settlement.pay', summary: 'paid 50,000.00 USD from settled cash', cash: { USD: -50_000 }, date: '2026-05-01' },
        ],
        cash: { account: {
          USD: { settled: 350_000, unsettled: 0, availableToTrade: 350_000, availableToWithdraw: 350_000 },
          JPY: { settled: 7_485_000, unsettled: 0, availableToTrade: 7_485_000, availableToWithdraw: 7_485_000 },
        } },
        pending: [
          { instrument: 'eurgbp', lot: 'gbp1', owner: 'account', dueDate: '2026-05-05', amount: -100_000, ccy: 'EUR', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp2', owner: 'account', dueDate: '2026-05-05', amount: -43_315, ccy: 'GBP', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp2', owner: 'account', dueDate: '2026-05-05', amount: 50_000, ccy: 'EUR', into: 'cash' },
          { instrument: 'eurgbp', lot: 'gbp1', owner: 'account', dueDate: '2026-05-05', amount: 86_600, ccy: 'GBP', into: 'cash' },
        ],
        balance: { account: { cash: 719_884, receivable: 164_982, payable: 165_010.05, assets: 884_866, liabilities: 165_010.05, netAssets: 719_855.95, // 719,984 - 50,000 + 49,900
          local: { USD: { cash: 350_000, payable: null }, JPY: { cash: 7_485_000, receivable: null } } } },
      },
    },
    {
      id: 'uk-bank-holiday', action: 'clock', to: AT('2026-05-04'), // Monday 4 May: London closed, nothing settles
      expect: {},
    },
    {
      id: 'cross-value-date', covers: 'settlement', action: 'clock', to: AT('2026-05-05'), // Tuesday 5 May
      expect: {
        events: [ // receipts first, then payments
          { type: 'settlement.receive', summary: 'received 86,600.00 GBP into settled cash', cash: { GBP: 86_600 }, date: '2026-05-05' },
          { type: 'settlement.receive', summary: 'received 50,000.00 EUR into settled cash', cash: { EUR: 50_000 }, date: '2026-05-05' },
          { type: 'settlement.pay', summary: 'paid 100,000.00 EUR from settled cash', cash: { EUR: -100_000 }, date: '2026-05-05' },
          { type: 'settlement.pay', summary: 'paid 43,315.00 GBP from settled cash', cash: { GBP: -43_315 }, date: '2026-05-05' },
        ],
        cash: { account: {
          EUR: { settled: 150_000, unsettled: 0, availableToTrade: 150_000, availableToWithdraw: 150_000 },
          GBP: { settled: 43_285, unsettled: 0, availableToTrade: 43_285, availableToWithdraw: 43_285 },
        } },
        pending: [],
        // 350,000 + 150,000 x 1.10 + 43,285 x 1.27 + 7,485,000 / 150 + 124,980 / 1.25 = 350,000 + 165,000 + 54,971.95 + 49,900 + 99,984
        balance: { account: { cash: 719_855.95, receivable: null, payable: null, assets: 719_855.95, liabilities: 0, netAssets: 719_855.95,
          local: { EUR: { cash: 150_000, receivable: null, payable: null }, GBP: { cash: 43_285, receivable: null, payable: null } } } },
      },
    },
    {
      id: 'buy-usd-cad-short', covers: 'buy base', action: 'ticket', instrument: 'usdcad', side: 'buy', qty: 100_000,
      status: 'blocked', reason: '100,000 USD at 1.2502 needs 125,020 CAD; the Account holds 124,980 CAD.',
      expect: { refused: 'Alpha is short 40.00 CAD: the package needs 125,020.00 CAD' }, // 100,000 x 1.2502 = 125,020; less 124,980
    },
    {
      id: 'buy-usd-with-cad-t1', covers: ['close', 'buy base', 'settlement'], action: 'ticket', instrument: 'usdcad', side: 'buy', qty: 99_750, as: 'cad2',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'usdcad', qty: 99_750, estimate: 1.2502, model: 'quoted-bid-ask', settleDate: '2026-05-06', fees: 0, // T+1: Wednesday 6 May
            cash: -124_707.45, // 99,750 x 1.2502
            otherCash: { USD: 99_750 } }],
          cash: { CAD: { purchases: 124_707.45, required: 124_707.45, available: 124_980, shortfall: 0 }, USD: { proceeds: 99_750 } },
        },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 99_750, avgPrice: 1.2502 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'fx.conversion', summary: 'FX conversion: bought 99,750.00 USD against 124,707.45 CAD at 1.2502', owner: 'account', date: '2026-05-05' }],
        cash: { account: {
          CAD: { settled: 124_980, unsettled: -124_707.45, availableToTrade: 272.55, availableToWithdraw: 272.55 },
          USD: { settled: 350_000, unsettled: 99_750, availableToTrade: 449_750, availableToWithdraw: 350_000 },
        } },
        pending: [
          { instrument: 'usdcad', lot: 'cad2', owner: 'account', dueDate: '2026-05-06', amount: -124_707.45, ccy: 'CAD', into: 'cash' },
          { instrument: 'usdcad', lot: 'cad2', owner: 'account', dueDate: '2026-05-06', amount: 99_750, ccy: 'USD', into: 'cash' },
        ],
        pnl: { account: { fx: -160.01, total: -160.01 }, book: { fx: -160.01, total: -160.01 } }, // 99,750 USD for 124,707.45 / 1.25 = 99,765.96: -15.96
        nav: { account: 719_839.99, book: 1_219_839.99 },
        balance: { account: { cash: 719_855.95, receivable: 99_750, payable: 99_765.96, assets: 819_605.95, liabilities: 99_765.96, netAssets: 719_839.99,
          local: { CAD: { cash: 124_980, payable: 124_707.45 }, USD: { cash: 350_000, receivable: 99_750 } } } },
      },
    },
    {
      id: 'last-value-date', covers: 'settlement', action: 'clock', to: AT('2026-05-06'), // Wednesday 6 May
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 99,750.00 USD into settled cash', cash: { USD: 99_750 }, date: '2026-05-06' },
          { type: 'settlement.pay', summary: 'paid 124,707.45 CAD from settled cash', cash: { CAD: -124_707.45 }, date: '2026-05-06' },
        ],
        cash: { account: {
          CAD: { settled: 272.55, unsettled: 0, availableToTrade: 272.55, availableToWithdraw: 272.55 },
          USD: { settled: 449_750, unsettled: 0, availableToTrade: 449_750, availableToWithdraw: 449_750 },
        }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        // 449,750 + 165,000 + 54,971.95 + 49,900 + 272.55 / 1.25 (218.04)
        balance: { account: { cash: 719_839.99, receivable: null, payable: null, assets: 719_839.99, liabilities: 0, netAssets: 719_839.99,
          local: { CAD: { cash: 272.55, payable: null }, USD: { cash: 449_750, receivable: null } } } },
      },
    },
  ],
};

export default [fxSpot];
