// Spot family, environmental products (engine family "spot", catalog support "full"): emissions allowances,
// carbon credits and renewable energy certificates. The physical commodities of the same family are in
// spot-commodities.mjs.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec. The arithmetic is in the
// comment beside it. Nothing here is copied from what the Terminal prints.
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be followed):
//   - A spot asset is security-like: a market buy fills at the ask, a market sell at the bid; average cost; a sale
//     removes cost at the average; the position books on trade date and cash moves on the settlement date; valued at
//     the last price. No short sale (there is no borrow for a spot asset).
//   - It is held and quoted in its own units (`terms.quantityUnit`, `terms.priceUnits`): here one allowance, credit or
//     certificate is one tonne of CO2e or one MWh, so the multiplier is 1. Lot size 1: a certificate is indivisible,
//     so a fractional quantity is refused.
//   - A surrender (allowances) or a retirement (credits, certificates) is not a market trade. The catalog records it by
//     hand as a sale at a stated fill price of 0.00: the units leave the position, their cost is realized as a loss,
//     no cash moves. The fee schedules below are in basis points, so a sale at zero carries no fee.
//   - Settlement lag: the instrument's own lag when set, else the Book's (settlement.spot = 2), counted on the
//     calendar of the venue's country; a lag stated on the ticket for one trade overrides both.

export const family = 'spot';

const FILL = { halfSpreadBps: { spot: 5 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const AT = (date) => `${date}T14:00:00.000Z`; // 10:00 New York (daylight time, from 8 March 2026)

const START_USD = {
  cash: {
    account: { USD: { settled: 500_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 500_000 } },
    treasury: { USD: { settled: 500_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 500_000 } },
  },
  positions: [], pending: [], openOrders: [], borrowings: [],
  nav: { account: 500_000, treasury: 500_000, book: 1_000_000 },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
};
const SPOT_TICKET = {
  ticket: 'Instrument drawer, Trade tab (security ticket: Buy, Sell; no Sell short; optional Settlement stated for the trade), then the trade preview',
  requiredFields: ['Account (trading owner)', 'Action', 'Quantity in the asset\'s own unit (whole units: lot size 1)'],
  automaticInputs: ['bid, ask, last and size (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model', 'settlement date on the venue country\'s calendar', 'commission from the Book spot fee schedule (basis points)'],
};

// ---------------------------------------------------------------------------------------------
// emissions_allowance
// ---------------------------------------------------------------------------------------------
// EU Allowances bought on the EEX spot market (Leipzig: TARGET2 days) in a USD-reporting Book; the purchase settles
// across Good Friday and Easter Monday; part sold, part surrendered for compliance (by hand), the rest sold.
const emissionsAllowance = {
  productId: 'emissions_allowance',
  title: 'EU Allowances (EUA, Phase 4) on the EEX spot market in EUR: settlement across Easter, compliance surrender by hand',
  matrix: {
    ...SPOT_TICKET,
    automaticInputs: [...SPOT_TICKET.automaticInputs, 'EUR/USD conversion of every reporting figure (FX fixture)'],
    manualInputs: ['compliance surrender, recorded by hand as a sale at a stated fill price of 0.00'],
    settlement: 'T+1 (the instrument\'s settlement lag) on the TARGET2 calendar of the Leipzig venue: a Thursday purchase settles the next Tuesday across Good Friday and Easter Monday',
    lifecycle: 'No automated event; surrender recorded by hand',
    accounting: 'Average cost in EUR; commission (2 bp) expensed; realized P&L on sale; a surrender realizes the cost of the allowances surrendered as a loss with no cash; reporting figures at EUR/USD 1.10',
    collateral: 'None; no short sale',
  },
  start: AT('2026-04-02'), // Thursday 2 April 2026, 10:00 New York
  settlementCheck: { lag: 1, holidays: ['2026-04-03', '2026-04-06'] }, // TARGET2: Good Friday and Easter Monday
  book: {
    name: 'Matrix emissions allowance', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }, { ccy: 'EUR', amount: 500_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }, { ccy: 'EUR', amount: 500_000 }] },
    settings: { fees: { spot: { perUnit: 0, minimum: 0, bps: 2 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } },
  },
  fx: { 'EUR/USD': 1.10 },
  instruments: {
    main: { productId: 'emissions_allowance', name: 'EU Allowance (EUA), Phase 4, spot', symbol: 'EUA-SPOT', marketView: 'FOREIGN_CASH', venue: 'European Energy Exchange (EEX), spot', venueType: 'exchange', venueCountry: 'DE', issuer: 'European Union (Union Registry)', underlyingGeo: 'European Union', tradingCcy: 'EUR',
      terms: { lotSize: 1, settleDays: 1, quantityUnit: 'allowances (1 t CO2e each)', priceUnits: 'EUR per allowance (t CO2e)' } },
  },
  quotes: { main: { bid: 68.35, ask: 68.40, last: 68.38, bidSize: 100_000, askSize: 100_000 } },
  expectAtStart: {
    cash: {
      account: { USD: { settled: 500_000, unsettled: 0 }, EUR: { settled: 500_000, unsettled: 0, availableToTrade: 500_000 } },
      treasury: { USD: { settled: 500_000 } },
    },
    positions: [], pending: [], openOrders: [], borrowings: [],
    nav: { account: 1_050_000, treasury: 500_000, book: 1_550_000 }, // 500,000 + 500,000 x 1.10
    provisional: { account: false, book: false },
    failed: { orders: 0, settlements: 0, lifecycle: 0 },
  },
  steps: [
    {
      id: 'buy', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 5000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5000, estimate: 68.40, model: 'quoted-bid-ask', settleDate: '2026-04-07', calendar: 'TARGET',
            cash: -342_000, // 5,000 x 68.40 EUR
            fees: 68.40 }], // 2 bp of 342,000
          cash: { EUR: { purchases: 342_000, fees: 68.40, required: 342_068.40, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 5000, avgPrice: 68.40 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 5,000 EUA-SPOT @ 68.40 EUR', owner: 'account', date: '2026-04-02' }],
        cash: { account: { EUR: { settled: 500_000, unsettled: -342_068.40, availableToTrade: 157_931.60 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 68.4, cost: 342_000, price: 68.38, value: 341_900, unrealized: -100, priceSource: 'Test fixture' }], // 5,000 x 68.38
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-07', amount: -342_068.40, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -75.24, unrealized: -110, fx: 0, total: -185.24 } }, // 68.40 x 1.10; -100 x 1.10
        nav: { account: 1_049_814.76, book: 1_549_814.76 },
        balance: { account: { cash: 1_050_000, positions: 376_090, payable: 376_275.24, assets: 1_426_090, liabilities: 376_275.24, netAssets: 1_049_814.76, // 341,900 x 1.10; 342,068.40 x 1.10
          local: { EUR: { cash: 500_000, positions: 341_900, payable: 342_068.40 } } } },
      },
    },
    {
      id: 'fractional-allowance', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 10.5,
      status: 'blocked', reason: 'An allowance is indivisible (lot size 1).',
      expect: { refused: 'quantity must be a multiple of 1' },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: 'There is no securities borrow for allowances in the Terminal; a short position is not offered.',
      expect: { refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' } },
    },
    { id: 'good-friday', action: 'clock', to: AT('2026-04-03'), expect: {} }, // TARGET2 closed: nothing settles
    { id: 'easter-monday', action: 'clock', to: AT('2026-04-06'), expect: {} },
    {
      id: 'settle-purchase', covers: 'settlement', action: 'clock', to: AT('2026-04-07'), // Tuesday 7 April
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 342,068.40 EUR from settled cash', cash: { EUR: -342_068.40 }, date: '2026-04-07' }],
        cash: { account: { EUR: { settled: 157_931.60, unsettled: 0, availableToTrade: 157_931.60 } } },
        pending: [],
        balance: { account: { cash: 673_724.76, payable: null, assets: 1_049_814.76, liabilities: 0, local: { EUR: { cash: 157_931.60, payable: null } } } }, // 500,000 + 157,931.60 x 1.10
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 70.00, ask: 70.05, last: 70.02, bidSize: 100_000, askSize: 100_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 5000, price: 70.02, value: 350_100, unrealized: 8_100 }], // 5,000 x 70.02 - 342,000
        pnl: { account: { unrealized: 8_910, total: 8_834.76 } }, // 8,100 x 1.10; less 75.24
        nav: { account: 1_058_834.76, book: 1_558_834.76 },
        balance: { account: { positions: 385_110, assets: 1_058_834.76, netAssets: 1_058_834.76, local: { EUR: { positions: 350_100 } } } },
      },
    },
    {
      id: 'reduce', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 1500, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 1500, estimate: 70.00, settleDate: '2026-04-08', cash: 105_000, fees: 21 }], // 1,500 x 70.00; 2 bp
          cash: { EUR: { proceeds: 105_000, fees: 21 } } },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 1500, avgPrice: 70.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1,500 EUA-SPOT @ 70.00 EUR (realized 2,400.00 EUR)', date: '2026-04-07' }], // cost out 342,000 x 1,500/5,000 = 102,600
        cash: { account: { EUR: { settled: 157_931.60, unsettled: 104_979, availableToTrade: 262_910.60 } } }, // 105,000 - 21
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 3500, avgCost: 68.4, cost: 239_400, price: 70.02, value: 245_070, unrealized: 5_670 }],
        holdings: { main: { long: 3500, short: 0, net: 3500 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-08', amount: 104_979, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: 2_640, commissions: -98.34, unrealized: 6_237, total: 8_778.66 } }, // 2,400 x 1.10; 75.24 + 21 x 1.10; 5,670 x 1.10
        nav: { account: 1_058_778.66, book: 1_558_778.66 },
        balance: { account: { cash: 673_724.76, receivable: 115_476.90, positions: 269_577, assets: 1_058_778.66, liabilities: 0, netAssets: 1_058_778.66,
          local: { EUR: { cash: 157_931.60, receivable: 104_979, positions: 245_070 } } } },
      },
    },
    {
      id: 'surrender-by-hand', covers: 'surrender', action: 'ticket', instrument: 'main', side: 'sell', qty: 2000, from: 'lot', order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 2000, estimate: 0, model: 'stated-price', cash: 0, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 2000, avgPrice: 0 }] },
        // Cost of the 2,000 surrendered: 2,000 x 68.40 = 136,800 EUR, realized as a loss; no cash.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 2,000 EUA-SPOT @ 0\.00 EUR \(realized -136,800\.00 EUR\)$/, date: '2026-04-07' }],
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1500, avgCost: 68.4, cost: 102_600, price: 70.02, value: 105_030, unrealized: 2_430 }],
        holdings: { main: { long: 1500, short: 0, net: 1500 } },
        pnl: { account: { realized: -147_840, unrealized: 2_673, total: -145_265.34 } }, // 2,640 - 136,800 x 1.10; 2,430 x 1.10
        nav: { account: 904_734.66, book: 1_404_734.66 },
        balance: { account: { positions: 115_533, assets: 904_734.66, netAssets: 904_734.66, local: { EUR: { positions: 105_030 } } } },
      },
    },
    {
      id: 'settle-reduce', covers: 'settlement', action: 'clock', to: AT('2026-04-08'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 104,979.00 EUR into settled cash', cash: { EUR: 104_979 }, date: '2026-04-08' }],
        cash: { account: { EUR: { settled: 262_910.60, unsettled: 0, availableToTrade: 262_910.60 } } },
        pending: [],
        balance: { account: { cash: 789_201.66, receivable: null, local: { EUR: { cash: 262_910.60, receivable: null } } } }, // 500,000 + 262,910.60 x 1.10
      },
    },
    {
      id: 'close', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 1500, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 1500, estimate: 70.00, settleDate: '2026-04-09', cash: 105_000, fees: 21 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 1500, avgPrice: 70.00 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 1,500 EUA-SPOT @ 70.00 EUR (realized 2,400.00 EUR)' }], // 105,000 - 102,600
        cash: { account: { EUR: { settled: 262_910.60, unsettled: 104_979, availableToTrade: 367_889.60 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-09', amount: 104_979, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: -145_200, commissions: -121.44, unrealized: 0, total: -145_321.44 } }, // -147,840 + 2,640; 98.34 + 23.10
        nav: { account: 904_678.56, book: 1_404_678.56 },
        balance: { account: { cash: 789_201.66, receivable: 115_476.90, positions: null, assets: 904_678.56, netAssets: 904_678.56, local: { EUR: { receivable: 104_979, positions: null } } } },
      },
    },
    {
      id: 'settle-close', covers: 'settlement', action: 'clock', to: AT('2026-04-09'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 104,979.00 EUR into settled cash' }],
        cash: { account: { EUR: { settled: 367_889.60, unsettled: 0, availableToTrade: 367_889.60 }, USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 904_678.56, receivable: null, assets: 904_678.56, liabilities: 0, netAssets: 904_678.56, local: { EUR: { cash: 367_889.60, receivable: null } } } }, // 500,000 + 367,889.60 x 1.10
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// carbon_credit
// ---------------------------------------------------------------------------------------------
// Voluntary carbon credits (Verra VCUs) bought by Treasury from an OTC platform, delivered through the registry three
// business days after the trade (a settlement stated on the ticket), part retired by hand to offset emissions, the
// rest sold.
const carbonCredit = {
  productId: 'carbon_credit',
  title: 'Verra VCUs, Rio Verde REDD+ vintage 2023, bought by Treasury over the counter: registry delivery T+3, retirement by hand',
  matrix: {
    ...SPOT_TICKET,
    requiredFields: [...SPOT_TICKET.requiredFields, 'Settlement stated for the trade (lag 3, registry delivery)'],
    manualInputs: ['retirement against the Book\'s emissions, recorded by hand as a sale at a stated fill price of 0.00', 'settlement lag of each OTC trade, stated on the ticket'],
    settlement: 'T+3 stated on each trade (registry transfer), on the US calendar; the Book default would be T+2',
    lifecycle: 'No automated event; retirement recorded by hand',
    accounting: 'Average cost; broker commission 50 bp expensed; a retirement realizes the cost retired as a loss with no cash; realized P&L on the sale; owned and reported by Treasury',
    collateral: 'None; no short sale',
  },
  start: AT('2026-03-09'), // Monday 9 March 2026, 10:00 New York
  settlementCheck: { lag: 3, holidays: [] },
  book: {
    name: 'Matrix carbon credit', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] },
    settings: { fees: { spot: { perUnit: 0, minimum: 0, bps: 50 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } },
  },
  instruments: {
    main: { productId: 'carbon_credit', name: 'Verra VCU, Rio Verde REDD+ (VCS 4127), vintage 2023', symbol: 'VCU-RV23', marketView: 'US_CASH', venue: 'Clearwater Carbon (OTC platform)', venueType: 'otc', venueCountry: 'US', issuer: 'Verra (Verified Carbon Standard registry)', domicile: 'US', underlyingGeo: 'Brazil', tradingCcy: 'USD',
      terms: { lotSize: 1, quantityUnit: 'credits (VCUs, 1 t CO2e each)', priceUnits: 'USD per credit (t CO2e)' } },
  },
  quotes: { main: { bid: 11.80, ask: 12.10, last: 11.95, bidSize: 50_000, askSize: 50_000 } },
  expectAtStart: START_USD,
  steps: [
    {
      id: 'buy-t3', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 20_000, owner: 'treasury', as: 'lot', order: { settle: { lag: 3 } },
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 20_000, estimate: 12.10, model: 'quoted-bid-ask', settleDate: '2026-03-12', calendar: 'US',
            cash: -242_000, // 20,000 x 12.10
            fees: 1_210 }], // 50 bp of 242,000
          cash: { USD: { purchases: 242_000, fees: 1_210, required: 243_210, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 20_000, avgPrice: 12.10, fills: [{ qty: 20_000, price: 12.10, model: 'quoted-bid-ask', settleDate: '2026-03-12', source: 'Test fixture', status: 'simulated', date: '2026-03-09' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 20,000 VCU-RV23 @ 12.10 USD', owner: 'treasury', date: '2026-03-09' }],
        cash: { treasury: { USD: { settled: 500_000, unsettled: -243_210, availableToTrade: 256_790 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 20_000, avgCost: 12.1, cost: 242_000, price: 11.95, value: 239_000, unrealized: -3_000, priceSource: 'Test fixture' }],
        holdings: { main: { long: 20_000, short: 0, net: 20_000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-03-12', amount: -243_210, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 0, commissions: -1_210, unrealized: -3_000, total: -4_210 }, account: { total: 0 } },
        nav: { treasury: 495_790, book: 995_790 },
        balance: { treasury: { cash: 500_000, positions: 239_000, payable: 243_210, assets: 739_000, liabilities: 243_210, netAssets: 495_790 } },
      },
    },
    {
      id: 'fractional-credit', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 0.5, owner: 'treasury',
      status: 'blocked', reason: 'A carbon credit is one tonne and indivisible (lot size 1).',
      expect: { refused: 'quantity must be a multiple of 1' },
    },
    {
      id: 'registry-delivery', covers: 'settlement', action: 'clock', to: AT('2026-03-12'), // Thursday 12 March
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 243,210.00 USD from settled cash', cash: { USD: -243_210 }, owner: 'treasury', date: '2026-03-12' }],
        cash: { treasury: { USD: { settled: 256_790, unsettled: 0, availableToTrade: 256_790 } } },
        pending: [],
        balance: { treasury: { cash: 256_790, payable: null, assets: 495_790, liabilities: 0 } },
      },
    },
    {
      id: 'retire-by-hand', covers: 'retirement', action: 'ticket', instrument: 'main', side: 'sell', qty: 5000, from: 'lot', owner: 'treasury', order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 5000, estimate: 0, model: 'stated-price', cash: 0, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 5000, avgPrice: 0 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 5,000 VCU-RV23 @ 0\.00 USD \(realized -60,500\.00 USD\)$/, owner: 'treasury' }], // 5,000 x 12.10 retired
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 15_000, avgCost: 12.1, cost: 181_500, price: 11.95, value: 179_250, unrealized: -2_250 }],
        holdings: { main: { long: 15_000, short: 0, net: 15_000 } },
        pnl: { treasury: { realized: -60_500, unrealized: -2_250, total: -63_960 } },
        nav: { treasury: 436_040, book: 936_040 },
        balance: { treasury: { positions: 179_250, assets: 436_040, netAssets: 436_040 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 12.40, ask: 12.70, last: 12.55, bidSize: 50_000, askSize: 50_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 15_000, price: 12.55, value: 188_250, unrealized: 6_750 }], // 15,000 x 12.55 - 181,500
        pnl: { treasury: { unrealized: 6_750, total: -54_960 } },
        nav: { treasury: 445_040, book: 945_040 },
        balance: { treasury: { positions: 188_250, assets: 445_040, netAssets: 445_040 } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, owner: 'treasury', borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: 'Carbon credits cannot be borrowed in the Terminal; a short position is not offered.',
      expect: { refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' } },
    },
    {
      id: 'sell-rest-t3', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 15_000, from: 'lot', owner: 'treasury', order: { settle: { lag: 3 } },
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 15_000, estimate: 12.40, settleDate: '2026-03-17', cash: 186_000, fees: 930 }] }, // T+3 from Thursday 12 March; 15,000 x 12.40; 50 bp
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 15_000, avgPrice: 12.40 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 15,000 VCU-RV23 @ 12.40 USD (realized 4,500.00 USD)', owner: 'treasury' }], // 186,000 - 181,500
        cash: { treasury: { USD: { settled: 256_790, unsettled: 185_070, availableToTrade: 441_860 } } }, // 186,000 - 930
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-03-17', amount: 185_070, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: -56_000, commissions: -2_140, unrealized: 0, total: -58_140 } },
        nav: { treasury: 441_860, book: 941_860 },
        balance: { treasury: { cash: 256_790, receivable: 185_070, positions: null, assets: 441_860, netAssets: 441_860 } },
      },
    },
    {
      id: 'settle-sale', covers: 'settlement', action: 'clock', to: AT('2026-03-17'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 185,070.00 USD into settled cash', owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 441_860, unsettled: 0, availableToTrade: 441_860 } }, account: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { treasury: { cash: 441_860, receivable: null, assets: 441_860, liabilities: 0, netAssets: 441_860 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// renewable_energy_certificate
// ---------------------------------------------------------------------------------------------
// Texas (ERCOT) renewable energy certificates, one per MWh generated, bought through a broker; the purchase settles T+2
// over Memorial Day; most retired by hand against the Book's electricity use, the rest sold.
const renewableEnergyCertificate = {
  productId: 'renewable_energy_certificate',
  title: 'Texas wind RECs, vintage 2025 (1 MWh each): T+2 over Memorial Day, retirement by hand',
  matrix: {
    ...SPOT_TICKET,
    manualInputs: ['retirement against electricity consumed, recorded by hand as a sale at a stated fill price of 0.00'],
    settlement: 'T+2 (Book setting settlement.spot) on the US calendar: a Thursday purchase settles the next Tuesday over Memorial Day',
    lifecycle: 'No automated event; retirement recorded by hand',
    accounting: 'Average cost per certificate (MWh); broker commission 50 bp expensed; a retirement realizes the cost retired as a loss with no cash; realized P&L on sale',
    collateral: 'None; no short sale',
  },
  start: AT('2026-05-21'), // Thursday 21 May 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: ['2026-05-25'] }, // Memorial Day
  book: {
    name: 'Matrix renewable energy certificate', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] },
    settings: { fees: { spot: { perUnit: 0, minimum: 0, bps: 50 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } },
  },
  instruments: {
    main: { productId: 'renewable_energy_certificate', name: 'ERCOT wind REC, vintage 2025', symbol: 'REC-TXW25', marketView: 'US_CASH', venue: 'Lone Star Environmental Brokers (OTC)', venueType: 'otc', venueCountry: 'US', issuer: 'ERCOT Renewable Energy Credit Program', domicile: 'US', underlyingGeo: 'Texas, US', tradingCcy: 'USD',
      terms: { lotSize: 1, quantityUnit: 'certificates (1 MWh each)', priceUnits: 'USD per MWh' } },
  },
  quotes: { main: { bid: 2.25, ask: 2.35, last: 2.30, bidSize: 100_000, askSize: 100_000 } },
  expectAtStart: START_USD,
  steps: [
    {
      id: 'buy', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 12_000, as: 'lot',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 12_000, estimate: 2.35, model: 'quoted-bid-ask', settleDate: '2026-05-26', calendar: 'US', // Friday 22 (1), Monday 25 Memorial Day, Tuesday 26 (2)
            cash: -28_200, // 12,000 MWh x 2.35
            fees: 141 }], // 50 bp
          cash: { USD: { purchases: 28_200, fees: 141, required: 28_341, available: 500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ action: 'buy', status: 'filled', filledQty: 12_000, avgPrice: 2.35 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 12,000 REC-TXW25 @ 2.35 USD', owner: 'account', date: '2026-05-21' }],
        cash: { account: { USD: { settled: 500_000, unsettled: -28_341, availableToTrade: 471_659 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 12_000, avgCost: 2.35, cost: 28_200, price: 2.30, value: 27_600, unrealized: -600, priceSource: 'Test fixture' }],
        holdings: { main: { long: 12_000, short: 0, net: 12_000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-05-26', amount: -28_341, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -141, unrealized: -600, total: -741 } },
        nav: { account: 499_259, book: 999_259 },
        balance: { account: { cash: 500_000, positions: 27_600, payable: 28_341, assets: 527_600, liabilities: 28_341, netAssets: 499_259 } },
      },
    },
    {
      id: 'fractional-certificate', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 100.25,
      status: 'blocked', reason: 'A certificate stands for one whole MWh (lot size 1).',
      expect: { refused: 'quantity must be a multiple of 1' },
    },
    { id: 'friday', action: 'clock', to: AT('2026-05-22'), expect: {} },
    { id: 'memorial-day', action: 'clock', to: AT('2026-05-25'), expect: {} }, // US markets closed: nothing settles
    {
      id: 'settle-purchase', covers: 'settlement', action: 'clock', to: AT('2026-05-26'),
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 28,341.00 USD from settled cash', cash: { USD: -28_341 }, date: '2026-05-26' }],
        cash: { account: { USD: { settled: 471_659, unsettled: 0, availableToTrade: 471_659 } } },
        pending: [],
        balance: { account: { cash: 471_659, payable: null, assets: 499_259, liabilities: 0 } },
      },
    },
    {
      id: 'retire-by-hand', covers: 'retirement', action: 'ticket', instrument: 'main', side: 'sell', qty: 8000, from: 'lot', order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, legs: [{ kind: 'trade', action: 'sell', qty: 8000, estimate: 0, model: 'stated-price', cash: 0, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 8000, avgPrice: 0 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: /^Sold 8,000 REC-TXW25 @ 0\.00 USD \(realized -18,800\.00 USD\)$/ }], // 8,000 x 2.35 retired
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 4000, avgCost: 2.35, cost: 9_400, price: 2.30, value: 9_200, unrealized: -200 }],
        holdings: { main: { long: 4000, short: 0, net: 4000 } },
        pnl: { account: { realized: -18_800, unrealized: -200, total: -19_141 } },
        nav: { account: 480_859, book: 980_859 },
        balance: { account: { positions: 9_200, assets: 480_859, netAssets: 480_859 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 2.40, ask: 2.50, last: 2.45, bidSize: 100_000, askSize: 100_000 },
      expect: {
        positions: [{ instrument: 'main', lot: 'lot', qty: 4000, price: 2.45, value: 9_800, unrealized: 400 }],
        pnl: { account: { unrealized: 400, total: -18_541 } },
        nav: { account: 481_459, book: 981_459 },
        balance: { account: { positions: 9_800, assets: 481_459, netAssets: 481_459 } },
      },
    },
    {
      id: 'sell-rest', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 4000, from: 'lot',
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 4000, estimate: 2.40, settleDate: '2026-05-28', cash: 9_600, fees: 48 }] }, // 4,000 x 2.40; 50 bp
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 4000, avgPrice: 2.40 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 4,000 REC-TXW25 @ 2.40 USD (realized 200.00 USD)' }], // 9,600 - 9,400
        cash: { account: { USD: { settled: 471_659, unsettled: 9_552, availableToTrade: 481_211 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-05-28', amount: 9_552, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -18_600, commissions: -189, unrealized: 0, total: -18_789 } },
        nav: { account: 481_211, book: 981_211 },
        balance: { account: { cash: 471_659, receivable: 9_552, positions: null, assets: 481_211, netAssets: 481_211 } },
      },
    },
    {
      id: 'settle-sale', covers: 'settlement', action: 'clock', to: AT('2026-05-28'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 9,552.00 USD into settled cash' }],
        cash: { account: { USD: { settled: 481_211, unsettled: 0, availableToTrade: 481_211 } }, treasury: { USD: { settled: 500_000 } } },
        pending: [],
        balance: { account: { cash: 481_211, receivable: null, assets: 481_211, liabilities: 0, netAssets: 481_211 } },
      },
    },
  ],
};

export default [emissionsAllowance, carbonCredit, renewableEnergyCertificate];
