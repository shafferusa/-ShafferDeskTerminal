// Cash family (engine family "cash"): currency balances held as ledger cash in Treasury and each Account.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The arithmetic is in
// the comment beside it. Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be followed):
//   - A currency balance is not a registry instrument. Capital in any currency enters and leaves the Book through
//     Treasury; a transfer moves one currency between Treasury and an Account and never converts it; a conversion is
//     a spot FX trade in a registered pair ("Convert currency"), through the trade preview.
//   - A spot conversion settles both currencies on its value date (T+2, good days for both currencies and a US
//     dollar banking day). Until then the currency bought counts as buying power but cannot be withdrawn or
//     transferred, and the currency sold is committed (it cannot be withdrawn or transferred either).
//   - Every ledger entry carries its reporting-currency amount at the rate in force when it was posted. Reporting
//     figures are converted at the current rate. The FX effect is the translation of foreign-currency assets and
//     liabilities (current rate less posting rate) plus the dealing cost of conversions (the reporting-currency
//     value of what was sold, at the rate in force, less that of what was bought).
//   - EUR/USD rate fixture 1.08, then 1.10; the pair's quote is 1.0798 / 1.0802, then 1.0998 / 1.1002.
//   - Calendar: Monday 2 to Friday 6 March 2026, no US or TARGET2 holiday.

export const family = 'cash';

const FILL = { halfSpreadBps: { fx: 0.5 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const EURUSD = { productId: 'fx_spot', name: 'EUR/USD spot', symbol: 'EUR/USD', marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { base: 'EUR', quote: 'USD', settleDays: 2 } };

// ---------------------------------------------------------------------------------------------
// currency
// ---------------------------------------------------------------------------------------------
const currency = {
  productId: 'currency',
  title: 'Euro balances in a USD Book: deposit, Treasury funding, conversion both ways, transfers that never convert, FX effect, withdrawal',
  matrix: {
    ticket: 'Treasury page: "Deposit or withdraw" (capital), "Transfer cash" (between Treasury and an Account); Account page: "Convert currency" (a spot FX trade in a registered pair, through the trade preview)',
    requiredFields: ['Currency and amount (deposit, withdrawal, transfer)', 'Source and destination (transfer)', 'Currency pair, direction and base amount (conversion)'],
    automaticInputs: ['conversion price: bid or ask of the pair quote (fixture)', 'value date of a conversion (T+2 on both currencies\' payment calendars)', 'reporting-currency amount of every entry at the rate in force (FX fixture standing in for Shaffer MarketData)'],
    manualInputs: ['every amount, entered on the dialogs'],
    settlement: 'Deposits, withdrawals and transfers move settled cash at once; a conversion settles both currencies on its value date, with pending pay and receive legs until then',
    lifecycle: 'None: balances have no lifecycle; the reporting-currency value follows the FX rate',
    accounting: 'Capital is not P&L; a transfer creates no Book P&L and never converts; FX effect = translation of euro balances plus the dealing cost of each conversion; unsettled currency is not withdrawable or transferable',
    collateral: 'None',
  },
  tradedOn: 'A currency balance is ledger cash, not a registry instrument (the registry refuses product "currency", asserted in the first step). The scenario holds euro balances in Treasury and the Account and converts them through a registered EUR/USD spot pair.',
  start: '2026-03-02T15:00:00.000Z', // Monday 2 March 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix currency', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] },
    settings: { fees: { fx: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { fx: 2 } },
  },
  fx: { 'EUR/USD': 1.08 },
  instruments: { eurusd: EURUSD },
  quotes: { eurusd: { bid: 1.0798, ask: 1.0802, last: 1.08, bidSize: 5_000_000, askSize: 5_000_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 } },
      treasury: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 } },
    },
    positions: [], pending: [], openOrders: [], borrowings: [],
    nav: { account: 500_000, treasury: 500_000, book: 1_000_000 },
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
    pnl: { account: { fx: 0, total: 0 }, treasury: { fx: 0, total: 0 }, book: { fx: 0, total: 0 } },
    balance: { account: { cash: 500_000, assets: 500_000, liabilities: 0, netAssets: 500_000 }, treasury: { cash: 500_000, netAssets: 500_000 } },
  },
  steps: [
    {
      id: 'not-a-registry-instrument', covers: 'register', action: 'register_instrument',
      draft: { productId: 'currency', name: 'Euro balance', symbol: 'EUR', marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: 'EUR', terms: {} },
      status: 'unsupported', reason: 'A currency is held as ledger cash by currency in Treasury and each Account; it is not registered or traded as an instrument.',
      expect: { refused: 'held as ledger cash' },
    },
    {
      id: 'deposit-euros', covers: 'deposit', action: 'deposit', ccy: 'EUR', amount: 250_000,
      expect: {
        events: [{ type: 'capital.deposit', summary: 'Capital contribution of 250,000.00 EUR into Treasury', owner: 'treasury', cash: { EUR: 250_000 } }],
        cash: { treasury: { EUR: { settled: 250_000, unsettled: 0, availableToTrade: 250_000, availableToWithdraw: 250_000 } } },
        nav: { treasury: 770_000, book: 1_270_000 }, // 500,000 + 250,000 x 1.08
        balance: { treasury: { cash: 770_000, netAssets: 770_000, local: { EUR: { cash: 250_000 }, USD: { cash: 500_000 } } } },
      },
    },
    {
      id: 'fund-account-in-euros', covers: 'transfer', action: 'transfer', from: 'treasury', to: 'account', ccy: 'EUR', amount: 100_000,
      expect: {
        events: [{ type: 'transfer.funding', summary: 'Treasury funding: 100,000.00 EUR from Treasury to Alpha', owner: 'treasury' }],
        cash: { account: { EUR: { settled: 100_000, unsettled: 0, availableToTrade: 100_000, availableToWithdraw: 100_000 } }, treasury: { EUR: { settled: 150_000, availableToTrade: 150_000, availableToWithdraw: 150_000 } } },
        nav: { account: 608_000, treasury: 662_000, book: 1_270_000 }, // 500,000 + 100,000 x 1.08; 500,000 + 150,000 x 1.08: the Book is unchanged
        balance: { account: { cash: 608_000, assets: 608_000, netAssets: 608_000, local: { EUR: { cash: 100_000 }, USD: { cash: 500_000 } } }, treasury: { cash: 662_000, netAssets: 662_000, local: { EUR: { cash: 150_000 } } } },
      },
    },
    {
      id: 'convert-euros-to-dollars', covers: ['convert', 'open'], action: 'ticket', instrument: 'eurusd', as: 'conv1',
      ticket: { kind: 'convert', page: 'account', pair: 'eurusd', action: 'sell', qty: 40_000 },
      input: { template: 'custom', name: 'Convert EUR to USD', legs: [{ kind: 'trade', action: 'sell', instrumentId: '$inst:eurusd', qty: 40_000 }] },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'eurusd', qty: 40_000, estimate: 1.0798, model: 'quoted-bid-ask', settleDate: '2026-03-04', fees: 0,
            cash: 43_192, // 40,000 x 1.0798 (the bid), dollars received
            otherCash: { EUR: -40_000 } }], // euros delivered on the value date
          cash: { USD: { proceeds: 43_192 }, EUR: { purchases: 40_000 } },
        },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 40_000, avgPrice: 1.0798 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'fx.conversion', summary: 'FX conversion: sold 40,000.00 EUR against 43,192.00 USD at 1.0798', owner: 'account', date: '2026-03-02' }],
        cash: { account: {
          EUR: { settled: 100_000, unsettled: -40_000, availableToTrade: 60_000, availableToWithdraw: 60_000 }, // committed until the value date
          USD: { settled: 500_000, unsettled: 43_192, availableToTrade: 543_192, availableToWithdraw: 500_000 }, // buying power at once, not withdrawable
        } },
        pending: [
          { instrument: 'eurusd', lot: 'conv1', owner: 'account', dueDate: '2026-03-04', amount: -40_000, ccy: 'EUR', into: 'cash' },
          { instrument: 'eurusd', lot: 'conv1', owner: 'account', dueDate: '2026-03-04', amount: 43_192, ccy: 'USD', into: 'cash' },
        ],
        // Dealing cost: 40,000 EUR at the rate in force (1.08) is 43,200; 43,192 received. -8.00.
        pnl: { account: { fx: -8, total: -8 }, book: { fx: -8, total: -8 } },
        nav: { account: 607_992, book: 1_269_992 },
        balance: { account: { cash: 608_000, receivable: 43_192, payable: 43_200, assets: 651_192, liabilities: 43_200, netAssets: 607_992, // payable 40,000 x 1.08
          local: { EUR: { cash: 100_000, payable: 40_000 }, USD: { cash: 500_000, receivable: 43_192 } } } },
      },
    },
    {
      id: 'committed-euros-not-transferable', covers: 'transfer', action: 'transfer', from: 'account', to: 'treasury', ccy: 'EUR', amount: 70_000,
      status: 'blocked', reason: '40,000 of the Account\'s 100,000 EUR is committed to the conversion until its value date.',
      expect: { refused: 'Alpha has 60,000.00 EUR of settled EUR available; 70,000.00 EUR requested' },
    },
    {
      id: 'unsettled-dollars-not-transferable', covers: 'transfer', action: 'transfer', from: 'account', to: 'treasury', ccy: 'USD', amount: 520_000,
      status: 'blocked', reason: 'The 43,192 USD bought settles on 4 March; until then it is buying power, not cash that can leave the Account.',
      expect: { refused: 'Alpha has 500,000.00 USD of settled USD available; 520,000.00 USD requested' },
    },
    {
      id: 'euro-strengthens', covers: 'fx effect', action: 'fx_rate', pair: 'EUR/USD', rate: 1.10,
      expect: {
        // Account: euros held 100,000 cash less 40,000 committed = 60,000 x (1.10 - 1.08) = 1,200; with the dealing cost, 1,192.
        // Treasury: 150,000 x 0.02 = 3,000. Book 4,192.
        pnl: { account: { fx: 1_192, total: 1_192 }, treasury: { fx: 3_000, total: 3_000 }, book: { fx: 4_192, total: 4_192 } },
        nav: { account: 609_192, treasury: 665_000, book: 1_274_192 }, // 500,000 + 43,192 + 60,000 x 1.10; 500,000 + 150,000 x 1.10
        balance: { account: { cash: 610_000, payable: 44_000, assets: 653_192, liabilities: 44_000, netAssets: 609_192 }, treasury: { cash: 665_000, netAssets: 665_000 } }, // 500,000 + 100,000 x 1.10; 40,000 x 1.10
      },
    },
    {
      id: 'value-date', covers: 'settlement', action: 'clock', to: '2026-03-04T15:00:00.000Z', // Wednesday 4 March
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 43,192.00 USD into settled cash', cash: { USD: 43_192 }, owner: 'account', date: '2026-03-04' },
          { type: 'settlement.pay', summary: 'paid 40,000.00 EUR from settled cash', cash: { EUR: -40_000 }, owner: 'account', date: '2026-03-04' },
        ],
        cash: { account: {
          EUR: { settled: 60_000, unsettled: 0, availableToTrade: 60_000, availableToWithdraw: 60_000 },
          USD: { settled: 543_192, unsettled: 0, availableToTrade: 543_192, availableToWithdraw: 543_192 },
        } },
        pending: [],
        balance: { account: { cash: 609_192, receivable: null, payable: null, assets: 609_192, liabilities: 0, netAssets: 609_192, // 543,192 + 60,000 x 1.10
          local: { EUR: { cash: 60_000, payable: null }, USD: { cash: 543_192, receivable: null } } } },
      },
    },
    {
      id: 'quote-after-move', action: 'quote', instrument: 'eurusd', quote: { bid: 1.0998, ask: 1.1002, last: 1.10, bidSize: 5_000_000, askSize: 5_000_000 },
      expect: {},
    },
    {
      id: 'convert-dollars-to-euros', covers: ['convert', 'open'], action: 'ticket', instrument: 'eurusd', as: 'conv2',
      ticket: { kind: 'convert', page: 'account', pair: 'eurusd', action: 'buy', qty: 20_000 },
      input: { template: 'custom', name: 'Convert USD to EUR', legs: [{ kind: 'trade', action: 'buy', instrumentId: '$inst:eurusd', qty: 20_000 }] },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'eurusd', qty: 20_000, estimate: 1.1002, model: 'quoted-bid-ask', settleDate: '2026-03-06', fees: 0,
            cash: -22_004, // 20,000 x 1.1002 (the ask), dollars paid
            otherCash: { EUR: 20_000 } }],
          cash: { USD: { purchases: 22_004, required: 22_004, available: 543_192, shortfall: 0 }, EUR: { proceeds: 20_000 } },
        },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20_000, avgPrice: 1.1002 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'fx.conversion', summary: 'FX conversion: bought 20,000.00 EUR against 22,004.00 USD at 1.1002', owner: 'account', date: '2026-03-04' }],
        cash: { account: {
          EUR: { settled: 60_000, unsettled: 20_000, availableToTrade: 80_000, availableToWithdraw: 60_000 },
          USD: { settled: 543_192, unsettled: -22_004, availableToTrade: 521_188, availableToWithdraw: 521_188 },
        } },
        pending: [
          { instrument: 'eurusd', lot: 'conv2', owner: 'account', dueDate: '2026-03-06', amount: -22_004, ccy: 'USD', into: 'cash' },
          { instrument: 'eurusd', lot: 'conv2', owner: 'account', dueDate: '2026-03-06', amount: 20_000, ccy: 'EUR', into: 'cash' },
        ],
        // Dealing cost: 20,000 EUR bought is worth 22,000 at 1.10; 22,004 paid: -4.00. FX effect 1,192 - 4.
        pnl: { account: { fx: 1_188, total: 1_188 }, book: { fx: 4_188, total: 4_188 } },
        nav: { account: 609_188, book: 1_274_188 },
        balance: { account: { cash: 609_192, receivable: 22_000, payable: 22_004, assets: 631_192, liabilities: 22_004, netAssets: 609_188, // receivable 20,000 x 1.10
          local: { EUR: { cash: 60_000, receivable: 20_000 }, USD: { cash: 543_192, payable: 22_004 } } } },
      },
    },
    {
      id: 'withdraw-euros', covers: 'withdraw', action: 'deposit', withdraw: true, ccy: 'EUR', amount: 50_000,
      expect: {
        events: [{ type: 'capital.withdrawal', summary: 'Capital withdrawal of 50,000.00 EUR from Treasury', owner: 'treasury', cash: { EUR: -50_000 } }],
        cash: { treasury: { EUR: { settled: 100_000, availableToTrade: 100_000, availableToWithdraw: 100_000 } } },
        // Capital is not P&L: Treasury's FX effect stays 3,000 (100,000 EUR still held: entries 270,000 - 108,000 - 55,000 = 107,000 at posting rates; 110,000 now).
        pnl: { treasury: { fx: 3_000, total: 3_000 }, book: { fx: 4_188, total: 4_188 } },
        nav: { treasury: 610_000, book: 1_219_188 }, // 500,000 + 100,000 x 1.10; the Book loses the 55,000 withdrawn
        balance: { treasury: { cash: 610_000, netAssets: 610_000, local: { EUR: { cash: 100_000 } } } },
      },
    },
    {
      id: 'buy-back-value-date', covers: 'settlement', action: 'clock', to: '2026-03-06T15:00:00.000Z', // Friday 6 March
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 20,000.00 EUR into settled cash', cash: { EUR: 20_000 }, owner: 'account', date: '2026-03-06' },
          { type: 'settlement.pay', summary: 'paid 22,004.00 USD from settled cash', cash: { USD: -22_004 }, owner: 'account', date: '2026-03-06' },
        ],
        cash: { account: {
          EUR: { settled: 80_000, unsettled: 0, availableToTrade: 80_000, availableToWithdraw: 80_000 },
          USD: { settled: 521_188, unsettled: 0, availableToTrade: 521_188, availableToWithdraw: 521_188 },
        } },
        pending: [],
        balance: { account: { cash: 609_188, receivable: null, payable: null, assets: 609_188, liabilities: 0, netAssets: 609_188, // 521,188 + 80,000 x 1.10
          local: { EUR: { cash: 80_000, receivable: null }, USD: { cash: 521_188, payable: null } } } },
      },
    },
    {
      id: 'return-euros-to-treasury', covers: ['transfer', 'close'], action: 'transfer', from: 'account', to: 'treasury', ccy: 'EUR', amount: 80_000,
      expect: {
        events: [{ type: 'transfer.return', summary: 'Return to Treasury: 80,000.00 EUR from Alpha to Treasury', owner: 'account' }],
        cash: { account: { EUR: null, USD: { settled: 521_188 } }, treasury: { EUR: { settled: 180_000, availableToTrade: 180_000, availableToWithdraw: 180_000 } } },
        // No Book P&L from an internal transfer. The Account keeps the FX effect it earned while it held the euros (1,188);
        // Treasury's: 180,000 EUR held, entries 270,000 - 108,000 - 55,000 + 88,000 = 195,000 at posting rates, 198,000 now: 3,000.
        pnl: { account: { fx: 1_188, total: 1_188 }, treasury: { fx: 3_000, total: 3_000 }, book: { fx: 4_188, total: 4_188 } },
        nav: { account: 521_188, treasury: 698_000, book: 1_219_188 }, // 500,000 + 180,000 x 1.10
        balance: { account: { cash: 521_188, assets: 521_188, netAssets: 521_188, local: { EUR: null, USD: { cash: 521_188 } } }, treasury: { cash: 698_000, netAssets: 698_000, local: { EUR: { cash: 180_000 } } } },
      },
    },
  ],
};

export default [currency];
